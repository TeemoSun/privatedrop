import base64
import uuid
from datetime import datetime, timezone
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_session, require_auth
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
from app.storage import (
    checksum_sha256_b64,
    delete_object,
    generate_object_key,
    head_object,
    sign_download_url,
    sign_upload_url,
)
from app.ws import manager

router = APIRouter(prefix="/api/items", tags=["items"])

_PAGE_SIZE = 20


def _item_out(item: DropItem) -> ItemOut:
    return ItemOut(
        id=item.id,
        kind=item.kind,
        note=item.note,
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
    if created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=timezone.utc)
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


async def _get_ready_item(session: AsyncSession, item_id: uuid.UUID) -> DropItem:
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
    session: AsyncSession = Depends(get_session),
    _: uuid.UUID = Depends(require_auth),
) -> ItemList:
    stmt_base = (
        select(DropItem)
        .options(selectinload(DropItem.files))
        .order_by(DropItem.created_at.desc(), DropItem.id.desc())
    )
    if kind:
        stmt_base = stmt_base.where(DropItem.kind == kind)

    ready_items: list[DropItem] = []
    raw_cursor = cursor
    has_more_raw = True
    while len(ready_items) < limit and has_more_raw:
        stmt = stmt_base.limit(limit + 1)
        if raw_cursor:
            created_at, item_id = _decode_cursor(raw_cursor)
            stmt = stmt.where((DropItem.created_at, DropItem.id) < (created_at, item_id))
        result = await session.execute(stmt)
        rows = list(result.scalars().all())
        has_more_raw = len(rows) > limit
        rows = rows[:limit]
        if not rows:
            break
        raw_cursor = _encode_cursor(rows[-1].created_at, rows[-1].id)
        ready_items.extend(item for item in rows if _is_ready(item))

    ready_items = ready_items[:limit]
    next_cursor = raw_cursor if has_more_raw else None

    return ItemList(items=[_item_out(item) for item in ready_items], next_cursor=next_cursor)


@router.post("", response_model=ItemCreateResponse, status_code=201)
async def create_item(
    body: ItemCreate,
    session: AsyncSession = Depends(get_session),
    device_id: uuid.UUID = Depends(require_auth),
) -> ItemCreateResponse:
    if body.kind == "note":
        if body.note is None or not body.note.strip():
            raise HTTPException(status_code=422, detail="note content required")
        item = DropItem(kind="note", note=body.note, created_by_device=device_id)
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

    item = DropItem(kind="file", note=body.note, created_by_device=device_id)
    session.add(item)
    await session.flush()

    targets: list[FileUploadTarget] = []
    for spec in body.files:
        key = generate_object_key()
        disposition = "attachment; filename*=UTF-8''" + quote(spec.file_name)
        url, expires = sign_upload_url(key, disposition, spec.sha256, spec.mime_type)
        drop_file = DropFile(
            item_id=item.id,
            object_key=key,
            file_name=spec.file_name,
            mime_type=spec.mime_type,
            size=spec.size,
            sha256=spec.sha256,
        )
        session.add(drop_file)
        await session.flush()
        targets.append(
            FileUploadTarget(
                file_id=drop_file.id,
                upload_url=url,
                content_disposition=disposition,
                checksum_sha256=checksum_sha256_b64(spec.sha256),
                expires_at=expires,
            )
        )
    await session.commit()
    return ItemCreateResponse(item_id=item.id, files=targets)


@router.post("/{item_id}/upload-complete", response_model=ItemOut)
async def upload_complete(
    item_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    _: uuid.UUID = Depends(require_auth),
) -> ItemOut:
    item = await _get_ready_item(session, item_id)
    if item.kind != "file":
        raise HTTPException(status_code=400, detail="not a file item")

    for f in item.files:
        if f.uploaded_at is not None:
            continue
        head = head_object(f.object_key)
        if head is None:
            raise HTTPException(status_code=409, detail="object not uploaded yet")
        if head.get("ContentLength") != f.size:
            raise HTTPException(status_code=409, detail="size mismatch")
        checksum = (head.get("ChecksumSHA256") or "").lower()
        if checksum and checksum != f.sha256.lower():
            raise HTTPException(status_code=409, detail="sha256 mismatch")
        f.uploaded_at = utc_now()

    if not _is_ready(item):
        await session.commit()
        raise HTTPException(status_code=409, detail="not all files uploaded")

    await session.commit()
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
    _: uuid.UUID = Depends(require_auth),
) -> DownloadUrlResponse:
    item = await _get_ready_item(session, item_id)
    if not _is_ready(item):
        raise HTTPException(status_code=409, detail="item not ready")
    drop_file = next((f for f in item.files if f.id == file_id), None)
    if drop_file is None:
        raise HTTPException(status_code=404, detail="file not found")
    url, expires = sign_download_url(drop_file.object_key)
    return DownloadUrlResponse(url=url, expires_at=expires)


@router.delete("/{item_id}", status_code=204)
async def delete_item(
    item_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    _: uuid.UUID = Depends(require_auth),
) -> None:
    item = await _get_ready_item(session, item_id)
    for f in item.files:
        delete_object(f.object_key)
    await session.delete(item)
    await session.commit()
    await manager.broadcast({"type": "item_deleted", "id": str(item_id)})
