package worker

import (
	"context"
	"database/sql"
	"log"
	"time"

	"github.com/google/uuid"
	"privatedrop/internal/security"
	"privatedrop/internal/storage"
	"privatedrop/internal/ws"
)

type CleanupWorker struct {
	db          *sql.DB
	storage     *storage.StorageManager
	security    *security.SecurityManager
	wsManager   *ws.ConnectionManager
	ttlSeconds  int
	stopChan    chan struct{}
}

func NewCleanupWorker(
	db *sql.DB,
	storage *storage.StorageManager,
	security *security.SecurityManager,
	wsManager *ws.ConnectionManager,
	ttlSeconds int,
) *CleanupWorker {
	return &CleanupWorker{
		db:         db,
		storage:    storage,
		security:   security,
		wsManager:  wsManager,
		ttlSeconds: ttlSeconds,
		stopChan:   make(chan struct{}),
	}
}

func (w *CleanupWorker) Start(interval time.Duration) {
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		for {
			select {
			case <-ticker.C:
				w.RunCleanup(context.Background())
			case <-w.stopChan:
				return
			}
		}
	}()
}

func (w *CleanupWorker) Stop() {
	close(w.stopChan)
}

func (w *CleanupWorker) RunCleanup(ctx context.Context) {
	if removed, err := w.cleanupStaleDrafts(ctx); err == nil && removed > 0 {
		log.Printf("cleanup: removed %d stale draft items", removed)
	} else if err != nil {
		log.Printf("cleanup: stale drafts error: %v", err)
	}

	if removed, err := w.cleanupExpiredEphemeralItems(ctx); err == nil && removed > 0 {
		log.Printf("cleanup: removed %d expired ephemeral items", removed)
	} else if err != nil {
		log.Printf("cleanup: expired ephemeral items error: %v", err)
	}

	if removed, err := w.cleanupExpiredTrashItems(ctx); err == nil && removed > 0 {
		log.Printf("cleanup: removed %d expired trash items", removed)
	} else if err != nil {
		log.Printf("cleanup: expired trash items error: %v", err)
	}

	staleDraftDuration := time.Duration(w.ttlSeconds*4) * time.Second
	removedTemp := w.storage.CleanupTempFiles(staleDraftDuration)
	if removedTemp > 0 {
		log.Printf("cleanup: removed %d stale temp files", removedTemp)
	}

	removedJTIs := w.security.CleanupRevokedJTIs(900 * time.Second)
	if removedJTIs > 0 {
		log.Printf("cleanup: removed %d expired revoked jtis", removedJTIs)
	}
}

func (w *CleanupWorker) cleanupStaleDrafts(ctx context.Context) (int, error) {
	cutoff := time.Now().UTC().Add(-time.Duration(w.ttlSeconds*4) * time.Second)

	// Fetch candidates
	query := `SELECT id FROM drop_items WHERE kind = 'file' AND created_at < $1 AND deleted_at IS NULL ORDER BY created_at ASC, id ASC LIMIT 50`
	rows, err := w.db.QueryContext(ctx, query, cutoff)
	if err != nil {
		query = `SELECT id FROM drop_items WHERE kind = 'file' AND created_at < ? AND deleted_at IS NULL ORDER BY created_at ASC, id ASC LIMIT 50`
		rows, err = w.db.QueryContext(ctx, query, cutoff)
		if err != nil {
			return 0, err
		}
	}
	defer rows.Close()

	var itemIDs []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err == nil {
			itemIDs = append(itemIDs, id)
		}
	}
	rows.Close()

	removed := 0
	for _, idStr := range itemIDs {
		// Check files readiness
		fRows, err := w.db.QueryContext(ctx, `SELECT uploaded_at, sha256 FROM drop_files WHERE item_id = $1`, idStr)
		if err != nil {
			fRows, err = w.db.QueryContext(ctx, `SELECT uploaded_at, sha256 FROM drop_files WHERE item_id = ?`, idStr)
			if err != nil {
				continue
			}
		}

		allUploaded := true
		fileCount := 0
		var shas []string
		for fRows.Next() {
			fileCount++
			var uploadedAt sql.NullTime
			var sha string
			if err := fRows.Scan(&uploadedAt, &sha); err == nil {
				if !uploadedAt.Valid {
					allUploaded = false
				}
				shas = append(shas, sha)
			}
		}
		fRows.Close()

		if fileCount > 0 && allUploaded {
			continue // Item is ready, do not delete
		}

		// Delete item
		_, err = w.db.ExecContext(ctx, `DELETE FROM drop_items WHERE id = $1`, idStr)
		if err != nil {
			_, err = w.db.ExecContext(ctx, `DELETE FROM drop_items WHERE id = ?`, idStr)
		}
		if err == nil {
			removed++
			for _, sha := range shas {
				_, _ = w.storage.DeleteFileIfUnreferenced(ctx, w.db, sha)
			}
		}
	}
	return removed, nil
}

func (w *CleanupWorker) cleanupExpiredEphemeralItems(ctx context.Context) (int, error) {
	now := time.Now().UTC()

	query := `SELECT id FROM drop_items WHERE is_ephemeral = true AND expires_at <= $1 AND deleted_at IS NULL ORDER BY expires_at ASC, id ASC LIMIT 100`
	rows, err := w.db.QueryContext(ctx, query, now)
	if err != nil {
		query = `SELECT id FROM drop_items WHERE is_ephemeral = 1 AND expires_at <= ? AND deleted_at IS NULL ORDER BY expires_at ASC, id ASC LIMIT 100`
		rows, err = w.db.QueryContext(ctx, query, now)
		if err != nil {
			return 0, err
		}
	}
	defer rows.Close()

	var itemIDs []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err == nil {
			itemIDs = append(itemIDs, id)
		}
	}
	rows.Close()

	removed := 0
	for _, idStr := range itemIDs {
		// Collect shas
		fRows, err := w.db.QueryContext(ctx, `SELECT sha256 FROM drop_files WHERE item_id = $1`, idStr)
		if err != nil {
			fRows, _ = w.db.QueryContext(ctx, `SELECT sha256 FROM drop_files WHERE item_id = ?`, idStr)
		}
		var shas []string
		if fRows != nil {
			for fRows.Next() {
				var sha string
				if err := fRows.Scan(&sha); err == nil {
					shas = append(shas, sha)
				}
			}
			fRows.Close()
		}

		_, err = w.db.ExecContext(ctx, `DELETE FROM drop_items WHERE id = $1`, idStr)
		if err != nil {
			_, err = w.db.ExecContext(ctx, `DELETE FROM drop_items WHERE id = ?`, idStr)
		}
		if err == nil {
			removed++
			for _, sha := range shas {
				_, _ = w.storage.DeleteFileIfUnreferenced(ctx, w.db, sha)
			}
			w.wsManager.Broadcast(map[string]interface{}{
				"type": "item_deleted",
				"id":   idStr,
			})
		}
	}
	return removed, nil
}

func (w *CleanupWorker) cleanupExpiredTrashItems(ctx context.Context) (int, error) {
	now := time.Now().UTC()
	cutoffNormal := now.Add(-30 * 24 * time.Hour)
	cutoffEphemeral := now.Add(-24 * time.Hour)

	query := `SELECT id FROM drop_items WHERE deleted_at IS NOT NULL AND ((is_ephemeral = false AND deleted_at <= $1) OR (is_ephemeral = true AND deleted_at <= $2)) ORDER BY deleted_at ASC, id ASC LIMIT 100`
	rows, err := w.db.QueryContext(ctx, query, cutoffNormal, cutoffEphemeral)
	if err != nil {
		query = `SELECT id FROM drop_items WHERE deleted_at IS NOT NULL AND ((is_ephemeral = 0 AND deleted_at <= ?) OR (is_ephemeral = 1 AND deleted_at <= ?)) ORDER BY deleted_at ASC, id ASC LIMIT 100`
		rows, err = w.db.QueryContext(ctx, query, cutoffNormal, cutoffEphemeral)
		if err != nil {
			return 0, err
		}
	}
	defer rows.Close()

	var itemIDs []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err == nil {
			itemIDs = append(itemIDs, id)
		}
	}
	rows.Close()

	removed := 0
	for _, idStr := range itemIDs {
		fRows, err := w.db.QueryContext(ctx, `SELECT sha256 FROM drop_files WHERE item_id = $1`, idStr)
		if err != nil {
			fRows, _ = w.db.QueryContext(ctx, `SELECT sha256 FROM drop_files WHERE item_id = ?`, idStr)
		}
		var shas []string
		if fRows != nil {
			for fRows.Next() {
				var sha string
				if err := fRows.Scan(&sha); err == nil {
					shas = append(shas, sha)
				}
			}
			fRows.Close()
		}

		_, err = w.db.ExecContext(ctx, `DELETE FROM drop_items WHERE id = $1`, idStr)
		if err != nil {
			_, err = w.db.ExecContext(ctx, `DELETE FROM drop_items WHERE id = ?`, idStr)
		}
		if err == nil {
			removed++
			for _, sha := range shas {
				_, _ = w.storage.DeleteFileIfUnreferenced(ctx, w.db, sha)
			}
		}
	}
	return removed, nil
}

// TriggerCleanupNow can be called synchronously for testing.
func (w *CleanupWorker) TriggerCleanupNow(ctx context.Context) {
	w.RunCleanup(ctx)
}

// Ensure UUID helper
func parseUUID(s string) uuid.UUID {
	id, _ := uuid.Parse(s)
	return id
}

