import asyncio
import logging
import uuid
from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app import storage
from app.api.deps import get_session, require_auth
from app.models import DropFile, DropItem
from app.schemas import (
    MissingFileItem,
    OrphanFileItem,
    StorageCheckResponse,
    StorageFixResponse,
)
from app.ws import manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/maintenance", tags=["maintenance"])


@router.get("/storage-check", response_model=StorageCheckResponse)
async def check_storage(
    session: AsyncSession = Depends(get_session),
    _: tuple = Depends(require_auth),
) -> StorageCheckResponse:
    # 1. Fetch all items with files from database (including soft-deleted)
    result = await session.execute(
        select(DropItem).options(selectinload(DropItem.files))
    )
    items = list(result.scalars().all())

    db_item_count = len(items)
    db_file_count = 0
    all_db_shas: set[str] = set()
    missing_files: list[MissingFileItem] = []

    for item in items:
        for f in item.files:
            db_file_count += 1
            sha = f.sha256.lower()
            all_db_shas.add(sha)
            if f.uploaded_at is not None:
                if not storage.file_exists(sha):
                    missing_files.append(
                        MissingFileItem(
                            item_id=item.id,
                            item_kind=item.kind,
                            item_note=item.note,
                            item_created_at=item.created_at,
                            item_is_ephemeral=item.is_ephemeral,
                            item_is_secret=item.is_secret,
                            item_deleted_at=item.deleted_at,
                            file_id=f.id,
                            file_name=f.file_name,
                            file_size=f.size,
                            sha256=sha,
                        )
                    )

    # 2. Scan physical files on disk
    disk_files = await asyncio.to_thread(storage.scan_physical_files)
    total_disk_files = len(disk_files)
    total_disk_size = sum(f["size"] for f in disk_files)

    orphan_files: list[OrphanFileItem] = []
    for file_info in disk_files:
        sha = file_info["sha256"]
        if sha not in all_db_shas:
            orphan_files.append(
                OrphanFileItem(
                    sha256=sha,
                    size=file_info["size"],
                    path=file_info["path"],
                )
            )

    status = "healthy" if not missing_files and not orphan_files else "issues_found"

    return StorageCheckResponse(
        status=status,
        total_db_items=db_item_count,
        total_db_files=db_file_count,
        total_disk_files=total_disk_files,
        total_disk_size=total_disk_size,
        missing_files=missing_files,
        orphan_files=orphan_files,
    )


@router.post("/storage-fix", response_model=StorageFixResponse)
async def fix_storage(
    session: AsyncSession = Depends(get_session),
    _: tuple = Depends(require_auth),
) -> StorageFixResponse:
    # 1. Fetch all items from DB
    result = await session.execute(
        select(DropItem).options(selectinload(DropItem.files))
    )
    items = list(result.scalars().all())

    all_db_shas: set[str] = set()
    broken_items: list[DropItem] = []

    for item in items:
        item_is_broken = False
        for f in item.files:
            sha = f.sha256.lower()
            all_db_shas.add(sha)
            if f.uploaded_at is not None and not storage.file_exists(sha):
                item_is_broken = True

        if item_is_broken:
            broken_items.append(item)

    # 2. Clean orphan physical files on disk
    disk_files = await asyncio.to_thread(storage.scan_physical_files)
    deleted_orphan_count = 0
    deleted_orphan_size = 0

    for file_info in disk_files:
        sha = file_info["sha256"]
        if sha not in all_db_shas:
            if storage.remove_orphan_file(file_info["full_path"]):
                deleted_orphan_count += 1
                deleted_orphan_size += file_info["size"]

    # 3. Clean broken DB items
    deleted_broken_count = 0
    other_shas_to_check: set[str] = set()

    for item in broken_items:
        item_id = item.id
        for f in item.files:
            other_shas_to_check.add(f.sha256.lower())
        await session.delete(item)
        deleted_broken_count += 1
        await manager.broadcast({"type": "item_deleted", "id": str(item_id)})

    if deleted_broken_count > 0:
        await session.commit()
        # Clean up any physical files from the deleted broken items if unreferenced
        for sha in other_shas_to_check:
            await storage.delete_file_if_unreferenced(sha, session)

    logger.info(
        "storage fix completed: deleted %d orphan files (%d bytes), deleted %d broken items",
        deleted_orphan_count,
        deleted_orphan_size,
        deleted_broken_count,
    )

    return StorageFixResponse(
        deleted_orphan_files_count=deleted_orphan_count,
        deleted_orphan_files_size=deleted_orphan_size,
        deleted_broken_items_count=deleted_broken_count,
    )

