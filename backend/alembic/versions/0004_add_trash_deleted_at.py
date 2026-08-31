"""add trash deleted_at
 
Revision ID: 0004
Revises: 0003
Create Date: 2026-08-31
 
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0004"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "drop_items",
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_drop_items_deleted_at", "drop_items", ["deleted_at"])


def downgrade() -> None:
    op.drop_index("ix_drop_items_deleted_at", table_name="drop_items")
    op.drop_column("drop_items", "deleted_at")
