import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    Uuid,
    func,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Device(Base):
    __tablename__ = "devices"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    refresh_jti: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)


class DropItem(Base):
    __tablename__ = "drop_items"
    __table_args__ = (
        CheckConstraint("kind IN ('file', 'note')", name="ck_drop_items_kind"),
        Index("ix_drop_items_created_id", "created_at", "id"),
        Index("ix_drop_items_is_ephemeral_created", "is_ephemeral", "created_at", "id"),
        Index("ix_drop_items_expires_at", "expires_at"),
        Index("ix_drop_items_deleted_at", "deleted_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    created_by_device: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("devices.id", ondelete="SET NULL"), nullable=True
    )
    kind: Mapped[str] = mapped_column(String(16))
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_ephemeral: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false")
    )
    expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=_utc_now,
        server_default=func.now(),
        index=False,
    )

    files: Mapped[list["DropFile"]] = relationship(
        back_populates="item", cascade="all, delete-orphan", order_by="DropFile.uploaded_at"
    )

class DropFile(Base):
    __tablename__ = "drop_files"
    __table_args__ = (
        Index("ix_drop_files_item_id", "item_id"),
        Index("ix_drop_files_sha256", "sha256"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    item_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("drop_items.id", ondelete="CASCADE"), nullable=False
    )
    file_name: Mapped[str] = mapped_column(String(1024))
    mime_type: Mapped[str] = mapped_column(String(255))
    size: Mapped[int] = mapped_column(BigInteger)
    sha256: Mapped[str] = mapped_column(String(64))
    uploaded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    item: Mapped[DropItem] = relationship(back_populates="files")
