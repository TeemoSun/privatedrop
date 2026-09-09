package database

import (
	"context"
	"fmt"
)

func (db *DB) Migrate(ctx context.Context) error {
	return db.migratePostgres(ctx)
}

func (db *DB) migratePostgres(ctx context.Context) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// 1. Create tables if not exist
	queries := []string{
		`CREATE TABLE IF NOT EXISTS devices (
			id UUID PRIMARY KEY,
			name VARCHAR(255) NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			refresh_jti UUID
		);`,
		`CREATE TABLE IF NOT EXISTS drop_items (
			id UUID PRIMARY KEY,
			created_by_device UUID REFERENCES devices(id) ON DELETE SET NULL,
			kind VARCHAR(16) NOT NULL,
			note TEXT,
			is_ephemeral BOOLEAN NOT NULL DEFAULT false,
			is_secret BOOLEAN NOT NULL DEFAULT false,
			expires_at TIMESTAMPTZ,
			deleted_at TIMESTAMPTZ,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now()
		);`,
		`CREATE TABLE IF NOT EXISTS drop_files (
			id UUID PRIMARY KEY,
			item_id UUID NOT NULL REFERENCES drop_items(id) ON DELETE CASCADE,
			file_name VARCHAR(1024) NOT NULL,
			mime_type VARCHAR(255) NOT NULL,
			size BIGINT NOT NULL,
			sha256 VARCHAR(64) NOT NULL,
			uploaded_at TIMESTAMPTZ
		);`,
	}

	for _, q := range queries {
		if _, err := tx.ExecContext(ctx, q); err != nil {
			return fmt.Errorf("migration query failed: %w (query: %s)", err, q)
		}
	}

	// 2. Incremental column upgrades (for databases migrating from older Alembic versions)
	alterQueries := []string{
		// 0002: drop object_key
		`ALTER TABLE drop_files DROP COLUMN IF EXISTS object_key;`,
		// 0003: add is_ephemeral & expires_at
		`ALTER TABLE drop_items ADD COLUMN IF NOT EXISTS is_ephemeral BOOLEAN NOT NULL DEFAULT false;`,
		`ALTER TABLE drop_items ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;`,
		// 0004: add deleted_at
		`ALTER TABLE drop_items ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;`,
		// 0005: add is_secret
		`ALTER TABLE drop_items ADD COLUMN IF NOT EXISTS is_secret BOOLEAN NOT NULL DEFAULT false;`,
	}

	for _, q := range alterQueries {
		if _, err := tx.ExecContext(ctx, q); err != nil {
			return fmt.Errorf("alter query failed: %w", err)
		}
	}

	// 3. Add constraint if missing
	_ = tx.QueryRowContext(ctx, `
		DO $$ BEGIN
			IF NOT EXISTS (
				SELECT 1 FROM pg_constraint WHERE conname = 'ck_drop_items_kind'
			) THEN
				ALTER TABLE drop_items ADD CONSTRAINT ck_drop_items_kind CHECK (kind IN ('file', 'note'));
			END IF;
		END $$;
	`).Scan()

	// 4. Indexes
	indexQueries := []string{
		`CREATE INDEX IF NOT EXISTS ix_drop_items_created_id ON drop_items (created_at, id);`,
		`CREATE INDEX IF NOT EXISTS ix_drop_items_is_ephemeral ON drop_items (is_ephemeral);`,
		`CREATE INDEX IF NOT EXISTS ix_drop_items_is_ephemeral_created ON drop_items (is_ephemeral, created_at, id);`,
		`CREATE INDEX IF NOT EXISTS ix_drop_items_is_secret_created ON drop_items (is_secret, created_at, id);`,
		`CREATE INDEX IF NOT EXISTS ix_drop_items_expires_at ON drop_items (expires_at);`,
		`CREATE INDEX IF NOT EXISTS ix_drop_items_deleted_at ON drop_items (deleted_at);`,
		`CREATE INDEX IF NOT EXISTS ix_drop_files_item_id ON drop_files (item_id);`,
		`CREATE INDEX IF NOT EXISTS ix_drop_files_sha256 ON drop_files (sha256);`,
	}

	for _, q := range indexQueries {
		if _, err := tx.ExecContext(ctx, q); err != nil {
			return fmt.Errorf("index query failed: %w", err)
		}
	}

	// 5. Sync alembic_version to 0005
	alembicQueries := []string{
		`CREATE TABLE IF NOT EXISTS alembic_version (version_num VARCHAR(32) NOT NULL PRIMARY KEY);`,
		`DELETE FROM alembic_version;`,
		`INSERT INTO alembic_version (version_num) VALUES ('0005');`,
	}
	for _, q := range alembicQueries {
		if _, err := tx.ExecContext(ctx, q); err != nil {
			return fmt.Errorf("alembic sync failed: %w", err)
		}
	}

	return tx.Commit()
}



