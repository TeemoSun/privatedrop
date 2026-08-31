"""local storage migration

Revision ID: 0002
Revises: 0001
Create Date: 2026-08-31

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_column("drop_files", "object_key")
    op.create_index("ix_drop_files_sha256", "drop_files", ["sha256"])


def downgrade() -> None:
    op.drop_index("ix_drop_files_sha256", table_name="drop_files")
    op.add_column(
        "drop_files",
        sa.Column("object_key", sa.String(length=255), nullable=True),
    )

