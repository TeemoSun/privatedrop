import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class LoginRequest(BaseModel):
    password: str
    device_id: uuid.UUID
    device_name: str = Field(min_length=1, max_length=255)


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    device_id: uuid.UUID


class RefreshRequest(BaseModel):
    refresh_token: str


class DeviceOut(BaseModel):
    id: uuid.UUID
    name: str
    created_at: datetime
    last_seen_at: datetime

    model_config = {"from_attributes": True}


class DevicePatch(BaseModel):
    name: str = Field(min_length=1, max_length=255)


class FileSpec(BaseModel):
    file_name: str = Field(min_length=1, max_length=1024)
    mime_type: str = Field(min_length=1, max_length=255)
    size: int = Field(gt=0)
    sha256: str = Field(pattern=r"^[0-9a-fA-F]{64}$")


class ItemCreate(BaseModel):
    kind: str = Field(pattern="^(file|note)$")
    note: str | None = Field(default=None, max_length=100_000)
    is_ephemeral: bool = False
    is_secret: bool = False
    files: list[FileSpec] = Field(default_factory=list)


class FileUploadTarget(BaseModel):
    file_id: uuid.UUID
    upload_url: str
    already_exists: bool = False


class ItemCreateResponse(BaseModel):
    item_id: uuid.UUID
    files: list[FileUploadTarget]


class FileOut(BaseModel):
    id: uuid.UUID
    file_name: str
    mime_type: str
    size: int
    sha256: str
    uploaded_at: datetime | None

    model_config = {"from_attributes": True}


class ItemOut(BaseModel):
    id: uuid.UUID
    kind: str
    note: str | None
    is_ephemeral: bool = False
    is_secret: bool = False
    expires_at: datetime | None = None
    deleted_at: datetime | None = None
    created_at: datetime
    created_by_device: uuid.UUID | None
    files: list[FileOut]

    model_config = {"from_attributes": True}


class ItemList(BaseModel):
    items: list[ItemOut]
    next_cursor: str | None


class DownloadUrlResponse(BaseModel):
    url: str
    expires_at: datetime


class MissingFileItem(BaseModel):
    item_id: uuid.UUID
    item_kind: str
    item_note: str | None = None
    item_created_at: datetime
    item_is_ephemeral: bool = False
    item_is_secret: bool = False
    item_deleted_at: datetime | None = None
    file_id: uuid.UUID
    file_name: str
    file_size: int
    sha256: str


class OrphanFileItem(BaseModel):
    sha256: str
    size: int
    path: str


class StorageCheckResponse(BaseModel):
    status: str  # "healthy" | "issues_found"
    total_db_items: int
    total_db_files: int
    total_disk_files: int
    total_disk_size: int
    missing_files: list[MissingFileItem]
    orphan_files: list[OrphanFileItem]


class StorageFixResponse(BaseModel):
    deleted_orphan_files_count: int
    deleted_orphan_files_size: int
    deleted_broken_items_count: int

