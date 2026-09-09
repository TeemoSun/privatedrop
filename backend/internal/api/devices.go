package api

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"privatedrop/internal/database"
	"privatedrop/internal/models"
)

type DevicesHandler struct {
	db *database.DB
}

func NewDevicesHandler(db *database.DB) *DevicesHandler {
	return &DevicesHandler{db: db}
}

func (h *DevicesHandler) List(w http.ResponseWriter, r *http.Request) {
	query := "SELECT id, name, created_at, last_seen_at FROM devices ORDER BY created_at ASC"
	rows, err := h.db.QueryContext(r.Context(), query)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "failed to query devices")
		return
	}
	defer rows.Close()

	var devices []models.DeviceOut
	for rows.Next() {
		var idStr, name string
		var createdAt, lastSeenAt time.Time
		if err := rows.Scan(&idStr, &name, &createdAt, &lastSeenAt); err == nil {
			devID, _ := uuid.Parse(idStr)
			devices = append(devices, models.DeviceOut{
				ID:         devID,
				Name:       name,
				CreatedAt:  createdAt,
				LastSeenAt: lastSeenAt,
			})
		}
	}

	if devices == nil {
		devices = []models.DeviceOut{}
	}
	WriteJSON(w, http.StatusOK, devices)
}

func (h *DevicesHandler) Rename(w http.ResponseWriter, r *http.Request) {
	idParam := chi.URLParam(r, "device_id")
	deviceID, err := uuid.Parse(idParam)
	if err != nil {
		WriteError(w, http.StatusBadRequest, "invalid device id")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)

	var patch models.DevicePatch
	if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
		WriteError(w, http.StatusUnprocessableEntity, "invalid request body")
		return
	}

	patch.Name = strings.TrimSpace(patch.Name)
	if patch.Name == "" || len(patch.Name) > 255 {
		WriteError(w, http.StatusUnprocessableEntity, "name must be between 1 and 255 characters")
		return
	}

	var createdAt, lastSeenAt time.Time
	query := "SELECT created_at, last_seen_at FROM devices WHERE id = $1"
	err = h.db.QueryRowContext(r.Context(), query, deviceID.String()).Scan(&createdAt, &lastSeenAt)
	if err == sql.ErrNoRows {
		WriteError(w, http.StatusNotFound, "device not found")
		return
	}
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "failed to fetch device")
		return
	}

	updQuery := "UPDATE devices SET name = $1 WHERE id = $2"
	_, updErr := h.db.ExecContext(r.Context(), updQuery, patch.Name, deviceID.String())
	if updErr != nil {
		WriteError(w, http.StatusInternalServerError, "failed to update device")
		return
	}

	WriteJSON(w, http.StatusOK, models.DeviceOut{
		ID:         deviceID,
		Name:       patch.Name,
		CreatedAt:  createdAt,
		LastSeenAt: lastSeenAt,
	})
}

func (h *DevicesHandler) Delete(w http.ResponseWriter, r *http.Request) {
	idParam := chi.URLParam(r, "device_id")
	deviceID, err := uuid.Parse(idParam)
	if err != nil {
		WriteError(w, http.StatusBadRequest, "invalid device id")
		return
	}

	delQuery := "DELETE FROM devices WHERE id = $1"
	res, delErr := h.db.ExecContext(r.Context(), delQuery, deviceID.String())
	if delErr != nil {
		WriteError(w, http.StatusInternalServerError, "failed to delete device")
		return
	}

	rows, _ := res.RowsAffected()
	if rows == 0 {
		WriteError(w, http.StatusNotFound, "device not found")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
