import base64
import hashlib
import logging
import uuid
from datetime import datetime, timedelta, timezone

import boto3
from botocore.client import Config
from botocore.exceptions import BotoCoreError, ClientError

from app.config import settings

logger = logging.getLogger(__name__)


def _client() -> boto3.client:
    scheme = "https" if settings.minio_secure else "http"
    return boto3.client(
        "s3",
        endpoint_url=f"{scheme}://{settings.minio_endpoint}",
        aws_access_key_id=settings.minio_root_user,
        aws_secret_access_key=settings.minio_root_password,
        region_name="us-east-1",
        config=Config(signature_version="s3v4"),
    )


def ensure_bucket() -> None:
    try:
        _client().head_bucket(Bucket=settings.minio_bucket)
    except (ClientError, BotoCoreError):
        _client().create_bucket(Bucket=settings.minio_bucket)


def generate_object_key() -> str:
    return str(uuid.uuid4())


def _expiry() -> int:
    return settings.upload_url_ttl_seconds


def sign_upload_url(
    key: str, content_disposition: str, checksum_sha256: str, content_type: str
) -> tuple[str, datetime]:
    expires = datetime.now(timezone.utc) + timedelta(seconds=_expiry())
    url = _client().generate_presigned_url(
        "put_object",
        Params={
            "Bucket": settings.minio_bucket,
            "Key": key,
            "ContentDisposition": content_disposition,
            "ContentType": content_type,
            "ChecksumSHA256": checksum_sha256_b64(checksum_sha256),
        },
        ExpiresIn=_expiry(),
    )
    return url, expires


def sign_download_url(key: str) -> tuple[str, datetime]:
    expires = datetime.now(timezone.utc) + timedelta(seconds=_expiry())
    url = _client().generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.minio_bucket, "Key": key},
        ExpiresIn=_expiry(),
    )
    return url, expires


def checksum_sha256(data: bytes) -> str:
    return hashlib.sha256(data).digest().hex()


def checksum_sha256_b64(hex_sha256: str) -> str:
    return base64.b64encode(bytes.fromhex(hex_sha256)).decode()


def head_object(key: str) -> dict | None:
    try:
        return _client().head_object(Bucket=settings.minio_bucket, Key=key)
    except (ClientError, BotoCoreError):
        return None


def delete_object(key: str) -> None:
    try:
        _client().delete_object(Bucket=settings.minio_bucket, Key=key)
    except (ClientError, BotoCoreError) as exc:
        logger.warning("delete_object failed for %s: %s", key, exc)
