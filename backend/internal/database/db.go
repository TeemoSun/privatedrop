package database

import (
	"database/sql"
	"fmt"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

type DB struct {
	*sql.DB
	DriverName string
}

func Connect(driverName, dataSourceName string) (*DB, error) {
	sqlDB, err := sql.Open(driverName, dataSourceName)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	if driverName == "pgx" || driverName == "postgres" {
		sqlDB.SetMaxOpenConns(25)
		sqlDB.SetMaxIdleConns(5)
		sqlDB.SetConnMaxLifetime(5 * time.Minute)
	} else if driverName == "sqlite" {
		sqlDB.SetMaxOpenConns(1)
	}

	if err := sqlDB.Ping(); err != nil {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	return &DB{DB: sqlDB, DriverName: driverName}, nil
}

func OpenFromURL(dbURL string) (*DB, error) {
	dbURL = strings.TrimSpace(dbURL)
	var driverName string
	var dsn string

	if strings.HasPrefix(dbURL, "sqlite://") || strings.HasPrefix(dbURL, "sqlite+aiosqlite://") {
		driverName = "sqlite"
		dsn = strings.TrimPrefix(dbURL, "sqlite+aiosqlite://")
		dsn = strings.TrimPrefix(dsn, "sqlite://")
		if dsn == "" {
			dsn = ":memory:"
		}
	} else {
		// Postgres
		driverName = "pgx"
		dsn = dbURL
		if strings.HasPrefix(dsn, "postgresql+asyncpg://") {
			dsn = "postgres://" + strings.TrimPrefix(dsn, "postgresql+asyncpg://")
		} else if strings.HasPrefix(dsn, "postgresql://") {
			dsn = "postgres://" + strings.TrimPrefix(dsn, "postgresql://")
		}
	}

	return Connect(driverName, dsn)
}

