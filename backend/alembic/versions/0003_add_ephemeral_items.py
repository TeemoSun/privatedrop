"""add ephemeral items and expiration
 
Revision ID: 0003
Revises: 0002
Create Date: 2026-08-31
 
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0003"
down_revision: Union[str, None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "drop_items",
        sa.Column("is_ephemeral", sa.Boolean(), server_default=sa.text("false"), nullable=False),
    )
    op.add_column(
        "drop_items",
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_drop_items_is_ephemeral", "drop_items", ["is_ephemeral"])
    op.create_index(
        "ix_drop_items_is_ephemeral_created",
        "drop_items",
        ["is_ephemeral", "created_at", "id"],
    )
    op.create_index("ix_drop_items_expires_at", "drop_items", ["expires_at"])


def downgrade() -> None:
    op.drop_index("ix_drop_items_expires_at", table_name="drop_items")
    op.drop_index("ix_drop_items_is_ephemeral_created", table_name="drop_items")
    op.drop_index("ix_drop_items_is_ephemeral", table_name="drop_items")
    op.drop_column("drop_items", "expires_at")
    op.drop_column("drop_items", "is_ephemeral")

