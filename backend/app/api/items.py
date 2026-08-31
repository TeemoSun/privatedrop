import base64
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import FileResponse
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app import storage
from app.api.deps import get_auth_optional, get_session, require_auth
from app.config import settings
from app.models import DropFile, DropItem
from app.schemas import (
    DownloadUrlResponse,
    FileOut,
    FileUploadTarget,
    ItemCreate,
    ItemCreateResponse,
    ItemList,
    ItemOut,
)
from app.security import utc_now
from app.ws import manager

router = APIRouter(prefix="/api/items", tags=["items"])

_PAGE_SIZE = 20


def _item_out(item: DropItem) -> ItemOut:
    return ItemOut(
        id=item.id,
        kind=item.kind,
        note=item.note,
        is_ephemeral=item.is_ephemeral,
        expires_at=item.expires_at,
        deleted_at=item.deleted_at,
        created_at=item.created_at,
        created_by_device=item.created_by_device,
        files=[FileOut.model_validate(f) for f in item.files],
    )


async def _fetch_item_out(session: AsyncSession, item_id: uuid.UUID) -> ItemOut:
    item = await session.get(
        DropItem, item_id, options=[selectinload(DropItem.files)], populate_existing=True
    )
    return _item_out(item)


def _encode_cursor(created_at: datetime, item_id: uuid.UUID) -> str:
    if created_at.tzinfo is not None:
        created_at = created_at.astimezone(timezone.utc)
    raw = f"{created_at.isoformat()},{item_id}"
    return base64.urlsafe_b64encode(raw.encode()).rstrip(b"=").decode()


def _decode_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
        ts_str, id_str = raw.rsplit(",", 1)
        created_at = datetime.fromisoformat(ts_str)
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=timezone.utc)
        return created_at, uuid.UUID(id_str)
    except (ValueError, UnicodeDecodeError, KeyError) as exc:
        raise HTTPException(status_code=400, detail="invalid cursor") from exc


async def _get_item_with_files(session: AsyncSession, item_id: uuid.UUID) -> DropItem:
    item = await session.get(DropItem, item_id, options=[selectinload(DropItem.files)])
    if item is None:
        raise HTTPException(status_code=404, detail="item not found")
    return item


def _is_ready(item: DropItem) -> bool:
    if item.kind == "note":
        return True
    return bool(item.files) and all(f.uploaded_at is not None for f in item.files)


@router.get("", response_model=ItemList)
async def list_items(
    cursor: str | None = Query(default=None),
    limit: int = Query(default=_PAGE_SIZE, ge=1, le=100),
    kind: str | None = Query(default=None, pattern="^(file|note)$"),
    is_ephemeral: bool | None = Query(default=None),
    session: AsyncSession = Depends(get_session),
    _: tuple = Depends(require_auth),
) -> ItemList:
    stmt_base = (
        select(DropItem)
        .options(selectinload(DropItem.files))
        .where(DropItem.deleted_at.is_(None))
        .order_by(DropItem.created_at.desc(), DropItem.id.desc())
    )
    if kind:
        stmt_base = stmt_base.where(DropItem.kind == kind)
    if is_ephemeral is not None:
        stmt_base = stmt_base.where(DropItem.is_ephemeral == is_ephemeral)

    ready_items: list[DropItem] = []
    raw_cursor = cursor
    has_more_raw = False
    while len(ready_items) < limit:
        stmt = stmt_base.limit(limit + 1)
        if raw_cursor:
            created_at, item_id = _decode_cursor(raw_cursor)
            stmt = stmt.where(
                or_(
                    DropItem.created_at < created_at,
                    and_(DropItem.created_at == created_at, DropItem.id < item_id),
                )
            )
        result = await session.execute(stmt)
        rows = list(result.scalars().all())
        if not rows:
            break
        has_more_raw = len(rows) > limit
        rows = rows[:limit]
        ready_items.extend(item for item in rows if _is_ready(item))
        if not has_more_raw:
            break
        raw_cursor = _encode_cursor(rows[-1].created_at, rows[-1].id)

    if len(ready_items) > limit:
        ready_items = ready_items[:limit]
        next_cursor = _encode_cursor(ready_items[-1].created_at, ready_items[-1].id)
    else:
        next_cursor = raw_cursor if has_more_raw else None

    return ItemList(items=[_item_out(item) for item in ready_items], next_cursor=next_cursor)


@router.post("", response_model=ItemCreateResponse, status_code=201)
async def create_item(
    body: ItemCreate,
    session: AsyncSession = Depends(get_session),
    auth: tuple = Depends(require_auth),
) -> ItemCreateResponse:
    device_id = auth[0]
    now = utc_now()
    expires_at = now + timedelta(hours=24) if body.is_ephemeral else None

    if body.kind == "note":
        if body.note is None or not body.note.strip():
            raise HTTPException(status_code=422, detail="note content required")
        item = DropItem(
            kind="note",
            note=body.note,
            created_by_device=device_id,
            is_ephemeral=body.is_ephemeral,
            expires_at=expires_at,
        )
        session.add(item)
        await session.commit()
        item_out = await _fetch_item_out(session, item.id)
        await manager.broadcast({"type": "item_created", "item": item_out.model_dump(mode="json")})
        return ItemCreateResponse(item_id=item.id, files=[])

    if not body.files:
        raise HTTPException(status_code=422, detail="file items require at least one file")
    total = sum(f.size for f in body.files)
    if total > settings.max_file_size:
        raise HTTPException(status_code=413, detail="total size exceeds MAX_FILE_SIZE")
    for spec in body.files:
        if spec.size > settings.max_file_size:
            raise HTTPException(status_code=413, detail="file exceeds MAX_FILE_SIZE")

    item = DropItem(
        kind="file",
        note=body.note,
        created_by_device=device_id,
        is_ephemeral=body.is_ephemeral,
        expires_at=expires_at,
    )
    session.add(item)
    await session.flush()

    targets: list[FileUploadTarget] = []
    all_files_exist = True
    for spec in body.files:
        exists = storage.file_exists(spec.sha256)
        uploaded_at = utc_now() if exists else None
        if not exists:
            all_files_exist = False

        drop_file = DropFile(
            item_id=item.id,
            file_name=spec.file_name,
            mime_type=spec.mime_type,
            size=spec.size,
            sha256=spec.sha256.lower(),
            uploaded_at=uploaded_at,
        )
        session.add(drop_file)
        await session.flush()

        upload_url = (
            ""
            if exists
            else f"/api/items/{item.id}/files/{drop_file.id}/upload"
        )
        targets.append(
            FileUploadTarget(
                file_id=drop_file.id,
                upload_url=upload_url,
                already_exists=exists,
            )
        )

    await session.commit()

    if all_files_exist:
        item_out = await _fetch_item_out(session, item.id)
        await manager.broadcast({"type": "item_created", "item": item_out.model_dump(mode="json")})

    return ItemCreateResponse(item_id=item.id, files=targets)


@router.put("/{item_id}/files/{file_id}/upload")
async def upload_file(
    item_id: uuid.UUID,
    file_id: uuid.UUID,
    request: Request,
    session: AsyncSession = Depends(get_session),
    _: tuple = Depends(require_auth),
) -> dict[str, bool]:
    item = await _get_item_with_files(session, item_id)
    if item.kind != "file":
        raise HTTPException(status_code=400, detail="not a file item")

    drop_file = next((f for f in item.files if f.id == file_id), None)
    if drop_file is None:
        raise HTTPException(status_code=404, detail="file not found")

    if drop_file.uploaded_at is not None and storage.file_exists(drop_file.sha256):
        return {"ok": True}

    try:
        await storage.save_upload_stream(
            file_id=drop_file.id,
            expected_sha256=drop_file.sha256,
            expected_size=drop_file.size,
            stream=request.stream(),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail="failed to save upload") from exc

    drop_file.uploaded_at = utc_now()
    await session.commit()
    return {"ok": True}


@router.post("/{item_id}/upload-complete", response_model=ItemOut)
async def upload_complete(
    item_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    _: tuple = Depends(require_auth),
) -> ItemOut:
    item = await _get_item_with_files(session, item_id)
    if item.kind != "file":
        raise HTTPException(status_code=400, detail="not a file item")

    for f in item.files:
        if f.uploaded_at is None or not storage.file_exists(f.sha256):
            raise HTTPException(status_code=409, detail="not all files uploaded")

    if not _is_ready(item):
        raise HTTPException(status_code=409, detail="item not ready")

    item_out = await _fetch_item_out(session, item.id)
    await manager.broadcast(
        {"type": "item_created", "item": item_out.model_dump(mode="json")}
    )
    return item_out


@router.get("/{item_id}/files/{file_id}/download-url", response_model=DownloadUrlResponse)
async def download_url(
    item_id: uuid.UUID,
    file_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    _: tuple = Depends(require_auth),
) -> DownloadUrlResponse:
    item = await _get_item_with_files(session, item_id)
    if not _is_ready(item):
        raise HTTPException(status_code=409, detail="item not ready")
    drop_file = next((f for f in item.files if f.id == file_id), None)
    if drop_file is None:
        raise HTTPException(status_code=404, detail="file not found")

    ticket, expires = storage.create_download_ticket(item_id, file_id)
    url = f"/api/items/{item_id}/files/{file_id}/download?ticket={ticket}"
    return DownloadUrlResponse(url=url, expires_at=expires)


@router.get("/{item_id}/files/{file_id}/download")
async def download_file(
    item_id: uuid.UUID,
    file_id: uuid.UUID,
    ticket: str | None = Query(default=None),
    auth: tuple | None = Depends(get_auth_optional),
    session: AsyncSession = Depends(get_session),
) -> FileResponse:
    if ticket is not None:
        if not storage.verify_download_ticket(ticket, item_id, file_id):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid or expired ticket")
    elif auth is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="authentication required")

    item = await _get_item_with_files(session, item_id)
    if not _is_ready(item):
        raise HTTPException(status_code=409, detail="item not ready")
    drop_file = next((f for f in item.files if f.id == file_id), None)
    if drop_file is None:
        raise HTTPException(status_code=404, detail="file not found")

    file_path = storage.get_file_path(drop_file.sha256)
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="file data not found on disk")

    return FileResponse(
        path=file_path,
        filename=drop_file.file_name,
        media_type=drop_file.mime_type or "application/octet-stream",
    )


@router.get("/trash", response_model=list[ItemOut])
async def list_trash_items(
    session: AsyncSession = Depends(get_session),
    _: tuple = Depends(require_auth),
) -> list[ItemOut]:
    stmt = (
        select(DropItem)
        .options(selectinload(DropItem.files))
        .where(DropItem.deleted_at.is_not(None))
        .order_by(DropItem.deleted_at.desc(), DropItem.id.desc())
    )
    result = await session.execute(stmt)
    rows = list(result.scalars().all())
    return [_item_out(item) for item in rows]


@router.delete("/trash/empty", status_code=204)
async def empty_trash(
    session: AsyncSession = Depends(get_session),
    _: tuple = Depends(require_auth),
) -> None:
    result = await session.execute(
        select(DropItem)
        .options(selectinload(DropItem.files))
        .where(DropItem.deleted_at.is_not(None))
    )
    items = list(result.scalars().all())
    all_sha256 = set()
    for item in items:
        for f in item.files:
            all_sha256.add(f.sha256)
        await session.delete(item)
    await session.commit()
    for sha in all_sha256:
        await storage.delete_file_if_unreferenced(sha, session)


@router.post("/{item_id}/restore", response_model=ItemOut)
async def restore_item(
    item_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    _: tuple = Depends(require_auth),
) -> ItemOut:
    item = await _get_item_with_files(session, item_id)
    if item.deleted_at is not None:
        item.deleted_at = None
        await session.commit()
        item_out = await _fetch_item_out(session, item.id)
        await manager.broadcast({"type": "item_created", "item": item_out.model_dump(mode="json")})
        return item_out
    return _item_out(item)


@router.delete("/{item_id}/purge", status_code=204)
async def purge_item(
    item_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    _: tuple = Depends(require_auth),
) -> None:
    item = await _get_item_with_files(session, item_id)
    sha256_list = list({f.sha256 for f in item.files})
    await session.delete(item)
    await session.commit()
    for sha in sha256_list:
        await storage.delete_file_if_unreferenced(sha, session)


@router.delete("/{item_id}", status_code=204)
async def delete_item(
    item_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    _: tuple = Depends(require_auth),
) -> None:
    item = await _get_item_with_files(session, item_id)
    item.deleted_at = utc_now()
    await session.commit()
    await manager.broadcast({"type": "item_deleted", "id": str(item_id)})

