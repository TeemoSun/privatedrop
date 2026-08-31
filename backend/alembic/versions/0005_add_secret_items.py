"""add secret items
 
Revision ID: 0005
Revises: 0004
Create Date: 2026-08-31
 
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0005"
down_revision: Union[str, None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "drop_items",
        sa.Column("is_secret", sa.Boolean(), server_default=sa.text("false"), nullable=False),
    )
    op.create_index(
        "ix_drop_items_is_secret_created",
        "drop_items",
        ["is_secret", "created_at", "id"],
    )


def downgrade() -> None:
    op.drop_index("ix_drop_items_is_secret_created", table_name="drop_items")
    op.drop_column("drop_items", "is_secret")
