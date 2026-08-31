import hashlib
import logging
import os
import shutil
import uuid
from collections.abc import AsyncIterator
from datetime import datetime, timedelta, timezone
from pathlib import Path

import aiofiles
import jwt
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings

logger = logging.getLogger(__name__)


def storage_root() -> Path:
    return Path(settings.storage_path).resolve()


def files_dir() -> Path:
    return storage_root() / "files"


def temp_dir() -> Path:
    return storage_root() / "tmp"


def ensure_storage_dirs() -> None:
    files_dir().mkdir(parents=True, exist_ok=True)
    temp_dir().mkdir(parents=True, exist_ok=True)


def get_file_path(sha256: str) -> Path:
    sha = sha256.lower()
    return files_dir() / sha[:2] / sha[2:4] / sha


def get_temp_path(file_id: uuid.UUID | str) -> Path:
    return temp_dir() / str(file_id)


def file_exists(sha256: str) -> bool:
    return get_file_path(sha256).is_file()


def checksum_sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest().lower()


def create_download_ticket(item_id: uuid.UUID, file_id: uuid.UUID) -> tuple[str, datetime]:
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=settings.upload_url_ttl_seconds)
    payload = {
        "sub": "download",
        "item_id": str(item_id),
        "file_id": str(file_id),
        "exp": int(expires_at.timestamp()),
    }
    ticket = jwt.encode(payload, settings.jwt_secret, algorithm="HS256")
    return ticket, expires_at


def verify_download_ticket(ticket: str, item_id: uuid.UUID, file_id: uuid.UUID) -> bool:
    try:
        payload = jwt.decode(ticket, settings.jwt_secret, algorithms=["HS256"])
        return (
            payload.get("sub") == "download"
            and payload.get("item_id") == str(item_id)
            and payload.get("file_id") == str(file_id)
        )
    except jwt.PyJWTError:
        return False


async def save_upload_stream(
    file_id: uuid.UUID | str,
    expected_sha256: str,
    expected_size: int,
    stream: AsyncIterator[bytes],
) -> Path:
    ensure_storage_dirs()
    temp_path = get_temp_path(file_id)
    hasher = hashlib.sha256()
    bytes_written = 0

    try:
        async with aiofiles.open(temp_path, "wb") as f:
            async for chunk in stream:
                if not chunk:
                    continue
                bytes_written += len(chunk)
                if bytes_written > settings.max_file_size:
                    raise ValueError("File size exceeds MAX_FILE_SIZE")
                hasher.update(chunk)
                await f.write(chunk)

        if bytes_written != expected_size:
            raise ValueError(f"Size mismatch: expected {expected_size}, got {bytes_written}")

        computed_sha = hasher.hexdigest().lower()
        if computed_sha != expected_sha256.lower():
            raise ValueError(f"SHA-256 mismatch: expected {expected_sha256.lower()}, got {computed_sha}")

        target_path = get_file_path(computed_sha)
        target_path.parent.mkdir(parents=True, exist_ok=True)
        # Atomic replace or shutil.move if across filesystems
        if temp_path.exists():
            shutil.move(str(temp_path), str(target_path))
        return target_path
    except Exception:
        if temp_path.exists():
            temp_path.unlink(missing_ok=True)
        raise


async def delete_file_if_unreferenced(sha256: str, session: AsyncSession) -> bool:
    from app.models import DropFile

    stmt = select(func.count()).select_from(DropFile).where(DropFile.sha256 == sha256)
    result = await session.execute(stmt)
    count = result.scalar_one()

    if count == 0:
        path = get_file_path(sha256)
        if path.is_file():
            path.unlink(missing_ok=True)
            logger.info("Deleted physical file %s", path)
            return True
    return False


def cleanup_temp_files(max_age_seconds: int = 3600) -> int:
    ensure_storage_dirs()
    cutoff = datetime.now(timezone.utc).timestamp() - max_age_seconds
    removed = 0
    for entry in temp_dir().iterdir():
        if entry.is_file():
            try:
                if entry.stat().st_mtime < cutoff:
                    entry.unlink(missing_ok=True)
                    removed += 1
            except Exception as e:
                logger.warning("Failed to remove temp file %s: %s", entry, e)
    return removed
