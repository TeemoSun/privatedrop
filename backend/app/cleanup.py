import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app import storage
from app.config import settings
from app.db import SessionLocal
from app.models import DropItem
from app.ws import manager

logger = logging.getLogger(__name__)

DRAFT_STALE_AFTER = timedelta(seconds=settings.upload_url_ttl_seconds * 4)


def _is_ready(item: DropItem) -> bool:
    if item.kind == "note":
        return True
    return bool(item.files) and all(f.uploaded_at is not None for f in item.files)


async def _cleanup_stale_drafts() -> int:
    cutoff = datetime.now(timezone.utc) - DRAFT_STALE_AFTER
    removed = 0
    async with SessionLocal() as session:
        result = await session.execute(
            select(DropItem.id)
            .where(DropItem.kind == "file", DropItem.created_at < cutoff)
            .order_by(DropItem.created_at.asc(), DropItem.id.asc())
            .limit(50)
        )
        item_ids = [row[0] for row in result.all()]
        if not item_ids:
            return 0
        for item_id in item_ids:
            item = await session.get(DropItem, item_id, options=[selectinload(DropItem.files)])
            if item is None or _is_ready(item):
                continue
            sha256_list = list({f.sha256 for f in item.files})
            await session.delete(item)
            await session.commit()
            for sha in sha256_list:
                await storage.delete_file_if_unreferenced(sha, session)
            removed += 1
    return removed


async def _cleanup_expired_ephemeral_items() -> int:
    now = datetime.now(timezone.utc)
    removed = 0
    async with SessionLocal() as session:
        result = await session.execute(
            select(DropItem.id)
            .where(DropItem.is_ephemeral == True, DropItem.expires_at <= now)  # noqa: E712
            .order_by(DropItem.expires_at.asc(), DropItem.id.asc())
            .limit(100)
        )
        item_ids = [row[0] for row in result.all()]
        if not item_ids:
            return 0
        for item_id in item_ids:
            item = await session.get(DropItem, item_id, options=[selectinload(DropItem.files)])
            if item is None:
                continue
            sha256_list = list({f.sha256 for f in item.files})
            await session.delete(item)
            await session.commit()
            for sha in sha256_list:
                await storage.delete_file_if_unreferenced(sha, session)
            await manager.broadcast({"type": "item_deleted", "id": str(item_id)})
            removed += 1
    return removed


async def cleanup_job() -> None:
    try:
        removed_drafts = await _cleanup_stale_drafts()
        if removed_drafts:
            logger.info("cleanup: removed %d stale draft items", removed_drafts)
        removed_ephemeral = await _cleanup_expired_ephemeral_items()
        if removed_ephemeral:
            logger.info("cleanup: removed %d expired ephemeral items", removed_ephemeral)
        removed_temp = storage.cleanup_temp_files(max_age_seconds=int(DRAFT_STALE_AFTER.total_seconds()))
        if removed_temp:
            logger.info("cleanup: removed %d stale temp files", removed_temp)
    except Exception:
        logger.exception("cleanup job failed")

