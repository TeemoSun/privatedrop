package api

import (
	"context"
	"database/sql"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"privatedrop/internal/database"
	"privatedrop/internal/models"
	"privatedrop/internal/storage"
	"privatedrop/internal/ws"
)

type MaintenanceHandler struct {
	db        *database.DB
	storage   *storage.StorageManager
	wsManager *ws.ConnectionManager
}

func NewMaintenanceHandler(
	db *database.DB,
	storage *storage.StorageManager,
	wsManager *ws.ConnectionManager,
) *MaintenanceHandler {
	return &MaintenanceHandler{
		db:        db,
		storage:   storage,
		wsManager: wsManager,
	}
}

type dbItemData struct {
	ID          uuid.UUID
	Kind        string
	Note        *string
	IsEphemeral bool
	IsSecret    bool
	ExpiresAt   *time.Time
	DeletedAt   *time.Time
	CreatedAt   time.Time
	Files       []dbFileData
}

type dbFileData struct {
	ID         uuid.UUID
	FileName   string
	MimeType   string
	Size       int64
	SHA256     string
	UploadedAt *time.Time
}

func (h *MaintenanceHandler) fetchAllItems(ctx context.Context) ([]dbItemData, error) {
	query := `SELECT id, kind, note, is_ephemeral, is_secret, expires_at, deleted_at, created_at FROM drop_items`
	rows, err := h.db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []dbItemData
	itemMap := make(map[uuid.UUID]int)

	for rows.Next() {
		var idStr, kind string
		var note sql.NullString
		var isEphemeral, isSecret bool
		var expiresAt, deletedAt sql.NullTime
		var createdAt time.Time

		if err := rows.Scan(&idStr, &kind, &note, &isEphemeral, &isSecret, &expiresAt, &deletedAt, &createdAt); err == nil {
			id, _ := uuid.Parse(idStr)
			item := dbItemData{
				ID:          id,
				Kind:        kind,
				IsEphemeral: isEphemeral,
				IsSecret:    isSecret,
				CreatedAt:   createdAt,
			}
			if note.Valid {
				item.Note = &note.String
			}
			if expiresAt.Valid {
				t := expiresAt.Time.UTC()
				item.ExpiresAt = &t
			}
			if deletedAt.Valid {
				t := deletedAt.Time.UTC()
				item.DeletedAt = &t
			}
			itemMap[id] = len(items)
			items = append(items, item)
		}
	}
	rows.Close()

	// Load files
	fQuery := `SELECT id, item_id, file_name, mime_type, size, sha256, uploaded_at FROM drop_files`
	fRows, err := h.db.QueryContext(ctx, fQuery)
	if err == nil {
		defer fRows.Close()
		for fRows.Next() {
			var fIDStr, itemIDStr, fName, mimeType, sha string
			var size int64
			var uploadedAt sql.NullTime

			if err := fRows.Scan(&fIDStr, &itemIDStr, &fName, &mimeType, &size, &sha, &uploadedAt); err == nil {
				itemID, _ := uuid.Parse(itemIDStr)
				fID, _ := uuid.Parse(fIDStr)
				file := dbFileData{
					ID:       fID,
					FileName: fName,
					MimeType: mimeType,
					Size:     size,
					SHA256:   strings.ToLower(sha),
				}
				if uploadedAt.Valid {
					t := uploadedAt.Time.UTC()
					file.UploadedAt = &t
				}
				if idx, ok := itemMap[itemID]; ok {
					items[idx].Files = append(items[idx].Files, file)
				}
			}
		}
	}

	return items, nil
}

func (h *MaintenanceHandler) StorageCheck(w http.ResponseWriter, r *http.Request) {
	items, err := h.fetchAllItems(r.Context())
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "failed to check storage")
		return
	}

	dbItemCount := len(items)
	dbFileCount := 0
	allDBSHAs := make(map[string]bool)
	var missingFiles []models.MissingFileItem

	for _, item := range items {
		for _, f := range item.Files {
			dbFileCount++
			allDBSHAs[f.SHA256] = true
			if f.UploadedAt != nil {
				if !h.storage.FileExists(f.SHA256) {
					missingFiles = append(missingFiles, models.MissingFileItem{
						ItemID:          item.ID,
						ItemKind:        item.Kind,
						ItemNote:        item.Note,
						ItemCreatedAt:   item.CreatedAt,
						ItemIsEphemeral: item.IsEphemeral,
						ItemIsSecret:    item.IsSecret,
						ItemDeletedAt:   item.DeletedAt,
						FileID:          f.ID,
						FileName:        f.FileName,
						FileSize:        f.Size,
						SHA256:          f.SHA256,
					})
				}
			}
		}
	}

	diskFiles, err := h.storage.ScanPhysicalFiles()
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "failed to scan physical files")
		return
	}

	totalDiskFiles := len(diskFiles)
	var totalDiskSize int64
	var orphanFiles []models.OrphanFileItem

	for _, df := range diskFiles {
		totalDiskSize += df.Size
		if !allDBSHAs[df.SHA256] {
			orphanFiles = append(orphanFiles, models.OrphanFileItem{
				SHA256: df.SHA256,
				Size:   df.Size,
				Path:   df.Path,
			})
		}
	}

	status := "healthy"
	if len(missingFiles) > 0 || len(orphanFiles) > 0 {
		status = "issues_found"
	}

	if missingFiles == nil {
		missingFiles = []models.MissingFileItem{}
	}
	if orphanFiles == nil {
		orphanFiles = []models.OrphanFileItem{}
	}

	WriteJSON(w, http.StatusOK, models.StorageCheckResponse{
		Status:         status,
		TotalDBItems:   dbItemCount,
		TotalDBFiles:   dbFileCount,
		TotalDiskFiles: totalDiskFiles,
		TotalDiskSize:  totalDiskSize,
		MissingFiles:   missingFiles,
		OrphanFiles:    orphanFiles,
	})
}

func (h *MaintenanceHandler) StorageFix(w http.ResponseWriter, r *http.Request) {
	items, err := h.fetchAllItems(r.Context())
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "failed to fetch items for fix")
		return
	}

	allDBSHAs := make(map[string]bool)
	var brokenItems []dbItemData

	for _, item := range items {
		itemIsBroken := false
		for _, f := range item.Files {
			allDBSHAs[f.SHA256] = true
			if f.UploadedAt != nil && !h.storage.FileExists(f.SHA256) {
				itemIsBroken = true
			}
		}
		if itemIsBroken {
			brokenItems = append(brokenItems, item)
		}
	}

	// 1. Delete orphan physical files on disk
	diskFiles, err := h.storage.ScanPhysicalFiles()
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "failed to scan physical files")
		return
	}

	deletedOrphanCount := 0
	var deletedOrphanSize int64

	for _, df := range diskFiles {
		if !allDBSHAs[df.SHA256] {
			if h.storage.RemoveOrphanFile(df.FullPath) {
				deletedOrphanCount++
				deletedOrphanSize += df.Size
			}
		}
	}

	// 2. Clean broken DB items
	deletedBrokenCount := 0
	otherSHAsToCheck := make(map[string]bool)

	for _, item := range brokenItems {
		for _, f := range item.Files {
			otherSHAsToCheck[f.SHA256] = true
		}

		delQuery := "DELETE FROM drop_items WHERE id = $1"
		_, err := h.db.ExecContext(r.Context(), delQuery, item.ID.String())
		if err != nil {
			continue
		}
		deletedBrokenCount++
		h.wsManager.Broadcast(map[string]interface{}{
			"type": "item_deleted",
			"id":   item.ID.String(),
		})
	}

	for sha := range otherSHAsToCheck {
		_, _ = h.storage.DeleteFileIfUnreferenced(r.Context(), h.db.DB, sha)
	}

	WriteJSON(w, http.StatusOK, models.StorageFixResponse{
		DeletedOrphanFilesCount: deletedOrphanCount,
		DeletedOrphanFilesSize:  deletedOrphanSize,
		DeletedBrokenItemsCount: deletedBrokenCount,
	})
}

