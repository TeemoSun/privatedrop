import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app import storage
from app.config import settings
from app.db import SessionLocal
from app.models import DropFile, DropItem
from app.ws import manager

logger = logging.getLogger(__name__)

DRAFT_STALE_AFTER = timedelta(seconds=settings.upload_url_ttl_seconds * 4)


async def _cleanup_stale_drafts() -> int:
    cutoff = datetime.now(timezone.utc) - DRAFT_STALE_AFTER
    removed = 0
    async with SessionLocal() as session:
        result = await session.execute(
            select(DropItem.id).where(DropItem.created_at < cutoff)
        )
        item_ids = [row[0] for row in result.all()]
        if not item_ids:
            return 0
        for item_id in item_ids:
            item = await session.get(DropItem, item_id, options=[selectinload(DropItem.files)])
            if item is None or _is_ready(item):
                continue
            for f in item.files:
                storage.delete_object(f.object_key)
            await session.delete(item)
            await session.commit()
            removed += 1
    return removed


def _is_ready(item: DropItem) -> bool:
    return bool(item.files) and all(f.uploaded_at is not None for f in item.files)


async def cleanup_job() -> None:
    try:
        removed = await _cleanup_stale_drafts()
        if removed:
            logger.info("cleanup: removed %d stale draft items", removed)
    except Exception:
        logger.exception("cleanup job failed")
