package api

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"privatedrop/internal/config"
	"privatedrop/internal/database"
	"privatedrop/internal/models"
	"privatedrop/internal/storage"
	"privatedrop/internal/ws"
)

var sha256Regex = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)

type ItemsHandler struct {
	cfg       *config.Config
	db        *database.DB
	storage   *storage.StorageManager
	wsManager *ws.ConnectionManager
}

func NewItemsHandler(
	cfg *config.Config,
	db *database.DB,
	storage *storage.StorageManager,
	wsManager *ws.ConnectionManager,
) *ItemsHandler {
	return &ItemsHandler{
		cfg:       cfg,
		db:        db,
		storage:   storage,
		wsManager: wsManager,
	}
}

func encodeCursor(createdAt time.Time, itemID uuid.UUID) string {
	raw := fmt.Sprintf("%s,%s", createdAt.UTC().Format(time.RFC3339Nano), itemID.String())
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func decodeCursor(cursor string) (time.Time, uuid.UUID, error) {
	bytes, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		bytes, err = base64.URLEncoding.DecodeString(cursor)
		if err != nil {
			return time.Time{}, uuid.Nil, err
		}
	}
	parts := strings.Split(string(bytes), ",")
	if len(parts) != 2 {
		return time.Time{}, uuid.Nil, fmt.Errorf("invalid cursor format")
	}

	t, err := time.Parse(time.RFC3339Nano, parts[0])
	if err != nil {
		t, err = time.Parse(time.RFC3339, parts[0])
		if err != nil {
			return time.Time{}, uuid.Nil, err
		}
	}

	id, err := uuid.Parse(parts[1])
	if err != nil {
		return time.Time{}, uuid.Nil, err
	}

	return t.UTC(), id, nil
}

func (h *ItemsHandler) isItemReady(item *models.DropItem) bool {
	if item.Kind == "note" {
		return true
	}
	if len(item.Files) == 0 {
		return false
	}
	for _, f := range item.Files {
		if f.UploadedAt == nil {
			return false
		}
	}
	return true
}

func (h *ItemsHandler) fetchItemOut(ctx context.Context, itemID uuid.UUID) (*models.ItemOut, error) {
	item, err := h.getItemWithFiles(ctx, itemID)
	if err != nil {
		return nil, err
	}
	out := h.toItemOut(item)
	return &out, nil
}

func (h *ItemsHandler) getItemWithFiles(ctx context.Context, itemID uuid.UUID) (*models.DropItem, error) {
	items, err := h.fetchBatchItemsWithFiles(ctx, []uuid.UUID{itemID})
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, sql.ErrNoRows
	}
	return items[0], nil
}

func (h *ItemsHandler) fetchBatchItemsWithFiles(ctx context.Context, itemIDs []uuid.UUID) ([]*models.DropItem, error) {
	if len(itemIDs) == 0 {
		return []*models.DropItem{}, nil
	}

	placeholders := make([]string, len(itemIDs))
	args := make([]interface{}, len(itemIDs))
	for i, id := range itemIDs {
		placeholders[i] = fmt.Sprintf("$%d", i+1)
		args[i] = id.String()
	}

	inClause := strings.Join(placeholders, ", ")
	itemQuery := fmt.Sprintf(`SELECT id, created_by_device, kind, note, is_ephemeral, is_secret, expires_at, deleted_at, created_at
							  FROM drop_items WHERE id IN (%s)`, inClause)
	rows, err := h.db.QueryContext(ctx, itemQuery, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	itemMap := make(map[uuid.UUID]*models.DropItem)
	for rows.Next() {
		var idStr, kind string
		var createdByDevStr, note sql.NullString
		var isEphemeral, isSecret bool
		var expiresAt, deletedAt sql.NullTime
		var createdAt time.Time

		if err := rows.Scan(&idStr, &createdByDevStr, &kind, &note, &isEphemeral, &isSecret, &expiresAt, &deletedAt, &createdAt); err == nil {
			id, _ := uuid.Parse(idStr)
			item := &models.DropItem{
				ID:          id,
				Kind:        kind,
				IsEphemeral: isEphemeral,
				IsSecret:    isSecret,
				CreatedAt:   createdAt,
				Files:       make([]*models.DropFile, 0),
			}
			if createdByDevStr.Valid && createdByDevStr.String != "" {
				devID, _ := uuid.Parse(createdByDevStr.String)
				item.CreatedByDevice = &devID
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
			itemMap[id] = item
		}
	}
	rows.Close()

	// Batch load all files for these items in one single query
	fileQuery := fmt.Sprintf(`SELECT id, item_id, file_name, mime_type, size, sha256, uploaded_at
							  FROM drop_files WHERE item_id IN (%s) ORDER BY uploaded_at ASC, id ASC`, inClause)
	fRows, err := h.db.QueryContext(ctx, fileQuery, args...)
	if err == nil {
		defer fRows.Close()
		for fRows.Next() {
			var fIDStr, itemIDStr, fName, mimeType, sha string
			var size int64
			var uploadedAt sql.NullTime

			if err := fRows.Scan(&fIDStr, &itemIDStr, &fName, &mimeType, &size, &sha, &uploadedAt); err == nil {
				fID, _ := uuid.Parse(fIDStr)
				itID, _ := uuid.Parse(itemIDStr)
				file := &models.DropFile{
					ID:       fID,
					ItemID:   itID,
					FileName: fName,
					MimeType: mimeType,
					Size:     size,
					SHA256:   sha,
				}
				if uploadedAt.Valid {
					t := uploadedAt.Time.UTC()
					file.UploadedAt = &t
				}
				if item, ok := itemMap[itID]; ok {
					item.Files = append(item.Files, file)
				}
			}
		}
	}

	// Preserve input ordering
	result := make([]*models.DropItem, 0, len(itemIDs))
	for _, id := range itemIDs {
		if item, ok := itemMap[id]; ok {
			result = append(result, item)
		}
	}
	return result, nil
}

func (h *ItemsHandler) toItemOut(item *models.DropItem) models.ItemOut {
	out := models.ItemOut{
		ID:              item.ID,
		Kind:            item.Kind,
		Note:            item.Note,
		IsEphemeral:     item.IsEphemeral,
		IsSecret:        item.IsSecret,
		ExpiresAt:       item.ExpiresAt,
		DeletedAt:       item.DeletedAt,
		CreatedAt:       item.CreatedAt,
		CreatedByDevice: item.CreatedByDevice,
		Files:           make([]models.FileOut, 0, len(item.Files)),
	}
	for _, f := range item.Files {
		out.Files = append(out.Files, models.FileOut{
			ID:         f.ID,
			FileName:   f.FileName,
			MimeType:   f.MimeType,
			Size:       f.Size,
			SHA256:     f.SHA256,
			UploadedAt: f.UploadedAt,
		})
	}
	return out
}

func (h *ItemsHandler) List(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	cursorStr := q.Get("cursor")
	limit := 20
	if l := q.Get("limit"); l != "" {
		if val, err := strconv.Atoi(l); err == nil && val >= 1 && val <= 100 {
			limit = val
		}
	}
	kind := q.Get("kind")
	isEphemeralStr := q.Get("is_ephemeral")
	isSecret := q.Get("is_secret") == "true"

	var readyItems []models.ItemOut
	rawCursor := cursorStr
	hasMoreRaw := false

	for len(readyItems) < limit {
		fetchLimit := limit + 1
		var conditions []string
		var args []interface{}
		argIdx := 1

		conditions = append(conditions, "deleted_at IS NULL")
		conditions = append(conditions, fmt.Sprintf("is_secret = $%d", argIdx))
		args = append(args, isSecret)
		argIdx++

		if kind == "note" || kind == "file" {
			conditions = append(conditions, fmt.Sprintf("kind = $%d", argIdx))
			args = append(args, kind)
			argIdx++
		}

		if isEphemeralStr != "" {
			isEph := isEphemeralStr == "true"
			conditions = append(conditions, fmt.Sprintf("is_ephemeral = $%d", argIdx))
			args = append(args, isEph)
			argIdx++
		}

		if rawCursor != "" {
			cTime, cID, err := decodeCursor(rawCursor)
			if err != nil {
				WriteError(w, http.StatusBadRequest, "invalid cursor")
				return
			}
			conditions = append(conditions, fmt.Sprintf("(created_at < $%d OR (created_at = $%d AND id < $%d))", argIdx, argIdx+1, argIdx+2))
			args = append(args, cTime, cTime, cID.String())
			argIdx += 3
		}

		whereClause := strings.Join(conditions, " AND ")
		query := fmt.Sprintf("SELECT id FROM drop_items WHERE %s ORDER BY created_at DESC, id DESC LIMIT %d", whereClause, fetchLimit)

		rows, err := h.db.QueryContext(r.Context(), query, args...)
		if err != nil {
			WriteError(w, http.StatusInternalServerError, "failed to query items")
			return
		}

		var itemIDs []uuid.UUID
		for rows.Next() {
			var idStr string
			if err := rows.Scan(&idStr); err == nil {
				id, _ := uuid.Parse(idStr)
				itemIDs = append(itemIDs, id)
			}
		}
		rows.Close()

		if len(itemIDs) == 0 {
			break
		}

		hasMoreRaw = len(itemIDs) > limit
		if hasMoreRaw {
			itemIDs = itemIDs[:limit]
		}

		items, err := h.fetchBatchItemsWithFiles(r.Context(), itemIDs)
		if err != nil {
			WriteError(w, http.StatusInternalServerError, "failed to load items")
			return
		}

		var lastItem *models.DropItem
		for _, item := range items {
			lastItem = item
			if h.isItemReady(item) {
				readyItems = append(readyItems, h.toItemOut(item))
			}
		}

		if !hasMoreRaw || lastItem == nil {
			break
		}
		rawCursor = encodeCursor(lastItem.CreatedAt, lastItem.ID)
	}

	var nextCursor *string
	if len(readyItems) > limit {
		readyItems = readyItems[:limit]
		last := readyItems[len(readyItems)-1]
		enc := encodeCursor(last.CreatedAt, last.ID)
		nextCursor = &enc
	} else if hasMoreRaw && rawCursor != "" {
		nextCursor = &rawCursor
	}

	if readyItems == nil {
		readyItems = []models.ItemOut{}
	}

	WriteJSON(w, http.StatusOK, models.ItemList{
		Items:      readyItems,
		NextCursor: nextCursor,
	})
}

func (h *ItemsHandler) Create(w http.ResponseWriter, r *http.Request) {
	deviceID, _, ok := GetAuth(r)
	if !ok || deviceID == uuid.Nil {
		WriteError(w, http.StatusUnauthorized, "missing token")
		return
	}

	// Verify device exists
	var devCount int
	err := h.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM devices WHERE id = $1", deviceID.String()).Scan(&devCount)
	if err != nil || devCount == 0 {
		WriteError(w, http.StatusUnauthorized, "device not found or unlinked")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)

	var req models.ItemCreate
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		WriteError(w, http.StatusUnprocessableEntity, "invalid request body")
		return
	}

	if req.Kind != "note" && req.Kind != "file" {
		WriteError(w, http.StatusUnprocessableEntity, "kind must be 'note' or 'file'")
		return
	}

	if req.Note != nil && len(*req.Note) > 100000 {
		WriteError(w, http.StatusUnprocessableEntity, "note exceeds maximum allowed length of 100000 characters")
		return
	}

	now := time.Now().UTC()
	var expiresAt *time.Time
	if req.IsEphemeral {
		t := now.Add(24 * time.Hour)
		expiresAt = &t
	}

	itemID := uuid.New()

	if req.Kind == "note" {
		if req.Note == nil || strings.TrimSpace(*req.Note) == "" {
			WriteError(w, http.StatusUnprocessableEntity, "note content required")
			return
		}
		trimmedNote := strings.TrimSpace(*req.Note)

		insQuery := `INSERT INTO drop_items (id, created_by_device, kind, note, is_ephemeral, is_secret, expires_at, created_at)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`
		_, err := h.db.ExecContext(r.Context(), insQuery, itemID.String(), deviceID.String(), "note", trimmedNote, req.IsEphemeral, req.IsSecret, expiresAt, now)
		if err != nil {
			WriteError(w, http.StatusInternalServerError, "failed to create note item")
			return
		}

		itemOut, err := h.fetchItemOut(r.Context(), itemID)
		if err == nil {
			h.wsManager.Broadcast(map[string]interface{}{
				"type": "item_created",
				"item": itemOut,
			})
		}

		WriteJSON(w, http.StatusCreated, models.ItemCreateResponse{
			ItemID: itemID,
			Files:  []models.FileUploadTarget{},
			Item:   itemOut,
		})
		return
	}

	// File item
	if len(req.Files) == 0 {
		WriteError(w, http.StatusUnprocessableEntity, "file items require at least one file")
		return
	}

	var totalSize int64
	for _, f := range req.Files {
		if f.Size <= 0 {
			WriteError(w, http.StatusUnprocessableEntity, "invalid file size")
			return
		}
		if !sha256Regex.MatchString(f.SHA256) {
			WriteError(w, http.StatusUnprocessableEntity, "invalid file sha256")
			return
		}
		if f.Size > h.cfg.MaxFileSize {
			WriteError(w, http.StatusRequestEntityTooLarge, "file exceeds MAX_FILE_SIZE")
			return
		}
		totalSize += f.Size
	}
	if totalSize > h.cfg.MaxFileSize {
		WriteError(w, http.StatusRequestEntityTooLarge, "total size exceeds MAX_FILE_SIZE")
		return
	}

	tx, err := h.db.BeginTx(r.Context(), nil)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "failed to begin transaction")
		return
	}
	defer tx.Rollback()

	insItemQuery := `INSERT INTO drop_items (id, created_by_device, kind, note, is_ephemeral, is_secret, expires_at, created_at)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`
	_, err = tx.ExecContext(r.Context(), insItemQuery, itemID.String(), deviceID.String(), "file", req.Note, req.IsEphemeral, req.IsSecret, expiresAt, now)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "failed to create item")
		return
	}

	var targets []models.FileUploadTarget
	allFilesExist := true

	for _, spec := range req.Files {
		fileID := uuid.New()
		shaLower := strings.ToLower(spec.SHA256)
		exists := h.storage.FileExists(shaLower)

		var uploadedAt *time.Time
		var uploadURL string
		if exists {
			uploadedAt = &now
			uploadURL = ""
		} else {
			allFilesExist = false
			uploadURL = fmt.Sprintf("/api/items/%s/files/%s/upload", itemID, fileID)
		}

		insFileQuery := `INSERT INTO drop_files (id, item_id, file_name, mime_type, size, sha256, uploaded_at)
						 VALUES ($1, $2, $3, $4, $5, $6, $7)`
		_, err := tx.ExecContext(r.Context(), insFileQuery, fileID.String(), itemID.String(), spec.FileName, spec.MimeType, spec.Size, shaLower, uploadedAt)
		if err != nil {
			WriteError(w, http.StatusInternalServerError, "failed to register file")
			return
		}

		targets = append(targets, models.FileUploadTarget{
			FileID:        fileID,
			UploadURL:     uploadURL,
			AlreadyExists: exists,
		})
	}

	// Double-check physical file existence right before commit to avoid TOCTOU race
	for idx, t := range targets {
		if t.AlreadyExists {
			sha := req.Files[idx].SHA256
			if !h.storage.FileExists(sha) {
				targets[idx].AlreadyExists = false
				targets[idx].UploadURL = fmt.Sprintf("/api/items/%s/files/%s/upload", itemID, t.FileID)
				allFilesExist = false
				// Reset uploaded_at in DB
				upd := `UPDATE drop_files SET uploaded_at = NULL WHERE id = $1`
				_, _ = tx.ExecContext(r.Context(), upd, t.FileID.String())
			}
		}
	}

	if err := tx.Commit(); err != nil {
		WriteError(w, http.StatusInternalServerError, "failed to commit transaction")
		return
	}

	if allFilesExist {
		itemOut, err := h.fetchItemOut(r.Context(), itemID)
		if err == nil {
			h.wsManager.Broadcast(map[string]interface{}{
				"type": "item_created",
				"item": itemOut,
			})
		}
	}

	WriteJSON(w, http.StatusCreated, models.ItemCreateResponse{
		ItemID: itemID,
		Files:  targets,
	})
}

func (h *ItemsHandler) UploadFile(w http.ResponseWriter, r *http.Request) {
	itemIDStr := chi.URLParam(r, "item_id")
	fileIDStr := chi.URLParam(r, "file_id")
	itemID, err1 := uuid.Parse(itemIDStr)
	fileID, err2 := uuid.Parse(fileIDStr)
	if err1 != nil || err2 != nil {
		WriteError(w, http.StatusBadRequest, "invalid item or file id")
		return
	}

	item, err := h.getItemWithFiles(r.Context(), itemID)
	if err == sql.ErrNoRows {
		WriteError(w, http.StatusNotFound, "item not found")
		return
	}
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "failed to get item")
		return
	}
	if item.Kind != "file" {
		WriteError(w, http.StatusBadRequest, "not a file item")
		return
	}

	var dropFile *models.DropFile
	for _, f := range item.Files {
		if f.ID == fileID {
			dropFile = f
			break
		}
	}
	if dropFile == nil {
		WriteError(w, http.StatusNotFound, "file not found")
		return
	}

	if dropFile.UploadedAt != nil && h.storage.FileExists(dropFile.SHA256) {
		WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
		return
	}

	_, err = h.storage.SaveUploadStream(dropFile.ID, dropFile.SHA256, dropFile.Size, r.Body)
	if err != nil {
		WriteError(w, http.StatusBadRequest, err.Error())
		return
	}

	now := time.Now().UTC()
	updQuery := `UPDATE drop_files SET uploaded_at = $1 WHERE id = $2`
	_, updErr := h.db.ExecContext(r.Context(), updQuery, now, dropFile.ID.String())
	if updErr != nil {
		WriteError(w, http.StatusInternalServerError, "failed to update file record")
		return
	}

	WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *ItemsHandler) UploadComplete(w http.ResponseWriter, r *http.Request) {
	itemIDStr := chi.URLParam(r, "item_id")
	itemID, err := uuid.Parse(itemIDStr)
	if err != nil {
		WriteError(w, http.StatusBadRequest, "invalid item id")
		return
	}

	item, err := h.getItemWithFiles(r.Context(), itemID)
	if err == sql.ErrNoRows {
		WriteError(w, http.StatusNotFound, "item not found")
		return
	}
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "failed to get item")
		return
	}
	if item.Kind != "file" {
		WriteError(w, http.StatusBadRequest, "not a file item")
		return
	}

	for _, f := range item.Files {
		if f.UploadedAt == nil || !h.storage.FileExists(f.SHA256) {
			WriteError(w, http.StatusConflict, "not all files uploaded")
			return
		}
	}

	if !h.isItemReady(item) {
		WriteError(w, http.StatusConflict, "item not ready")
		return
	}

	itemOut, err := h.fetchItemOut(r.Context(), item.ID)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "failed to fetch item")
		return
	}

	h.wsManager.Broadcast(map[string]interface{}{
		"type": "item_created",
		"item": itemOut,
	})

	WriteJSON(w, http.StatusOK, itemOut)
}

func (h *ItemsHandler) DownloadURL(w http.ResponseWriter, r *http.Request) {
	itemIDStr := chi.URLParam(r, "item_id")
	fileIDStr := chi.URLParam(r, "file_id")
	itemID, err1 := uuid.Parse(itemIDStr)
	fileID, err2 := uuid.Parse(fileIDStr)
	if err1 != nil || err2 != nil {
		WriteError(w, http.StatusBadRequest, "invalid item or file id")
		return
	}

	item, err := h.getItemWithFiles(r.Context(), itemID)
	if err == sql.ErrNoRows {
		WriteError(w, http.StatusNotFound, "item not found")
		return
	}
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "failed to get item")
		return
	}
	if !h.isItemReady(item) {
		WriteError(w, http.StatusConflict, "item not ready")
		return
	}

	var dropFile *models.DropFile
	for _, f := range item.Files {
		if f.ID == fileID {
			dropFile = f
			break
		}
	}
	if dropFile == nil {
		WriteError(w, http.StatusNotFound, "file not found")
		return
	}

	ticket, expiresAt, err := h.storage.CreateDownloadTicket(itemID, fileID)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "failed to generate download ticket")
		return
	}

	url := fmt.Sprintf("/api/items/%s/files/%s/download?ticket=%s", itemID, fileID, ticket)
	WriteJSON(w, http.StatusOK, models.DownloadUrlResponse{
		URL:       url,
		ExpiresAt: expiresAt,
	})
}

func (h *ItemsHandler) DownloadFile(w http.ResponseWriter, r *http.Request) {
	itemIDStr := chi.URLParam(r, "item_id")
	fileIDStr := chi.URLParam(r, "file_id")
	itemID, err1 := uuid.Parse(itemIDStr)
	fileID, err2 := uuid.Parse(fileIDStr)
	if err1 != nil || err2 != nil {
		WriteError(w, http.StatusBadRequest, "invalid item or file id")
		return
	}

	ticket := r.URL.Query().Get("ticket")
	if ticket != "" {
		if !h.storage.VerifyDownloadTicket(ticket, itemID, fileID) {
			WriteError(w, http.StatusUnauthorized, "invalid or expired ticket")
			return
		}
	} else {
		_, _, ok := GetAuth(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "authentication required")
			return
		}
	}

	item, err := h.getItemWithFiles(r.Context(), itemID)
	if err == sql.ErrNoRows {
		WriteError(w, http.StatusNotFound, "item not found")
		return
	}
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "failed to get item")
		return
	}
	if !h.isItemReady(item) {
		WriteError(w, http.StatusConflict, "item not ready")
		return
	}

	var dropFile *models.DropFile
	for _, f := range item.Files {
		if f.ID == fileID {
			dropFile = f
			break
		}
	}
	if dropFile == nil {
		WriteError(w, http.StatusNotFound, "file not found")
		return
	}

	filePath := h.storage.GetFilePath(dropFile.SHA256)
	f, err := os.Open(filePath)
	if err != nil {
		WriteError(w, http.StatusNotFound, "file data not found on disk")
		return
	}
	defer f.Close()

	fi, err := f.Stat()
	if err != nil || fi.IsDir() {
		WriteError(w, http.StatusNotFound, "file data not found on disk")
		return
	}

	mimeType := dropFile.MimeType
	mimeType = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, mimeType)
	if mimeType == "" {
		mimeType = mime.TypeByExtension(filepath.Ext(dropFile.FileName))
		if mimeType == "" {
			mimeType = "application/octet-stream"
		}
	}
	w.Header().Set("Content-Type", mimeType)

	w.Header().Set("Content-Disposition", contentDisposition(dropFile.FileName))

	http.ServeContent(w, r, dropFile.FileName, fi.ModTime(), f)
}

// contentDisposition builds an attachment header with a sanitized ASCII
// fallback plus an RFC 5987 encoded name for non-ASCII filenames.
func contentDisposition(fileName string) string {
	base := filepath.Base(fileName)
	var ascii strings.Builder
	for _, r := range base {
		switch {
		case r < 0x20 || r == 0x7f, r == '"', r == '\\':
			ascii.WriteByte('_')
		case r > 0x7e:
			ascii.WriteByte('_')
		default:
			ascii.WriteRune(r)
		}
	}
	safe := ascii.String()
	disp := fmt.Sprintf(`attachment; filename="%s"`, safe)
	if safe != base {
		disp += "; filename*=UTF-8''" + rfc5987Encode(base)
	}
	return disp
}

func rfc5987Encode(s string) string {
	const attrChar = "!#$&+-.^_`|~"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
			strings.IndexByte(attrChar, c) >= 0 {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func (h *ItemsHandler) Delete(w http.ResponseWriter, r *http.Request) {
	itemIDStr := chi.URLParam(r, "item_id")
	itemID, err := uuid.Parse(itemIDStr)
	if err != nil {
		WriteError(w, http.StatusBadRequest, "invalid item id")
		return
	}

	var existingID string
	err = h.db.QueryRowContext(r.Context(), "SELECT id FROM drop_items WHERE id = $1", itemID.String()).Scan(&existingID)
	if err == sql.ErrNoRows {
		WriteError(w, http.StatusNotFound, "item not found")
		return
	}

	now := time.Now().UTC()
	updQuery := "UPDATE drop_items SET deleted_at = $1 WHERE id = $2"
	_, _ = h.db.ExecContext(r.Context(), updQuery, now, itemID.String())

	h.wsManager.Broadcast(map[string]interface{}{
		"type": "item_deleted",
		"id":   itemID.String(),
	})

	w.WriteHeader(http.StatusNoContent)
}

func (h *ItemsHandler) ListTrash(w http.ResponseWriter, r *http.Request) {
	query := `SELECT id FROM drop_items WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC`
	rows, err := h.db.QueryContext(r.Context(), query)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "failed to query trash")
		return
	}
	defer rows.Close()

	var itemIDs []uuid.UUID
	for rows.Next() {
		var idStr string
		if err := rows.Scan(&idStr); err == nil {
			id, _ := uuid.Parse(idStr)
			itemIDs = append(itemIDs, id)
		}
	}
	rows.Close()

	items, err := h.fetchBatchItemsWithFiles(r.Context(), itemIDs)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "failed to load trash items")
		return
	}

	trashItems := make([]models.ItemOut, 0, len(items))
	for _, item := range items {
		trashItems = append(trashItems, h.toItemOut(item))
	}

	WriteJSON(w, http.StatusOK, trashItems)
}

func (h *ItemsHandler) EmptyTrash(w http.ResponseWriter, r *http.Request) {
	tx, err := h.db.BeginTx(r.Context(), nil)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "failed to begin transaction")
		return
	}
	defer tx.Rollback()

	query := `SELECT id FROM drop_items WHERE deleted_at IS NOT NULL`
	rows, err := tx.QueryContext(r.Context(), query)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "failed to query trash")
		return
	}
	defer rows.Close()

	var itemIDs []string
	for rows.Next() {
		var idStr string
		if err := rows.Scan(&idStr); err == nil {
			itemIDs = append(itemIDs, idStr)
		}
	}
	rows.Close()

	var allSHAs []string
	for _, idStr := range itemIDs {
		fRows, err := tx.QueryContext(r.Context(), `SELECT sha256 FROM drop_files WHERE item_id = $1`, idStr)
		if err == nil {
			for fRows.Next() {
				var sha string
				if err := fRows.Scan(&sha); err == nil {
					allSHAs = append(allSHAs, sha)
				}
			}
			fRows.Close()
		}

		_, _ = tx.ExecContext(r.Context(), `DELETE FROM drop_items WHERE id = $1`, idStr)
	}

	if err := tx.Commit(); err != nil {
		WriteError(w, http.StatusInternalServerError, "failed to commit empty trash")
		return
	}

	for _, sha := range allSHAs {
		_, _ = h.storage.DeleteFileIfUnreferenced(r.Context(), h.db.DB, sha)
	}

	w.WriteHeader(http.StatusNoContent)
}

func (h *ItemsHandler) Restore(w http.ResponseWriter, r *http.Request) {
	itemIDStr := chi.URLParam(r, "item_id")
	itemID, err := uuid.Parse(itemIDStr)
	if err != nil {
		WriteError(w, http.StatusBadRequest, "invalid item id")
		return
	}

	item, err := h.getItemWithFiles(r.Context(), itemID)
	if err == sql.ErrNoRows {
		WriteError(w, http.StatusNotFound, "item not found")
		return
	}
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "failed to get item")
		return
	}

	if item.DeletedAt != nil {
		now := time.Now().UTC()
		var newExpires *time.Time
		if item.IsEphemeral && (item.ExpiresAt == nil || item.ExpiresAt.Before(now)) {
			t := now.Add(24 * time.Hour)
			newExpires = &t
		}

		updQuery := "UPDATE drop_items SET deleted_at = NULL, expires_at = COALESCE($1, expires_at) WHERE id = $2"
		_, updErr := h.db.ExecContext(r.Context(), updQuery, newExpires, itemID.String())
		if updErr != nil {
			WriteError(w, http.StatusInternalServerError, "failed to restore item")
			return
		}

		itemOut, err := h.fetchItemOut(r.Context(), itemID)
		if err == nil {
			h.wsManager.Broadcast(map[string]interface{}{
				"type": "item_created",
				"item": itemOut,
			})
			WriteJSON(w, http.StatusOK, itemOut)
			return
		}
	}

	out := h.toItemOut(item)
	WriteJSON(w, http.StatusOK, out)
}

func (h *ItemsHandler) Purge(w http.ResponseWriter, r *http.Request) {
	itemIDStr := chi.URLParam(r, "item_id")
	itemID, err := uuid.Parse(itemIDStr)
	if err != nil {
		WriteError(w, http.StatusBadRequest, "invalid item id")
		return
	}

	item, err := h.getItemWithFiles(r.Context(), itemID)
	if err == sql.ErrNoRows {
		WriteError(w, http.StatusNotFound, "item not found")
		return
	}
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "failed to get item")
		return
	}

	var shas []string
	for _, f := range item.Files {
		shas = append(shas, f.SHA256)
	}

	delQuery := "DELETE FROM drop_items WHERE id = $1"
	_, delErr := h.db.ExecContext(r.Context(), delQuery, itemID.String())
	if delErr != nil {
		WriteError(w, http.StatusInternalServerError, "failed to purge item")
		return
	}

	for _, sha := range shas {
		_, _ = h.storage.DeleteFileIfUnreferenced(r.Context(), h.db.DB, sha)
	}

	w.WriteHeader(http.StatusNoContent)
}
