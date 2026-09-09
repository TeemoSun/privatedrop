package api

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"privatedrop/internal/config"
	"privatedrop/internal/database"
	"privatedrop/internal/models"
	"privatedrop/internal/security"
)

type AuthHandler struct {
	cfg *config.Config
	db  *database.DB
	sec *security.SecurityManager
}

func NewAuthHandler(cfg *config.Config, db *database.DB, sec *security.SecurityManager) *AuthHandler {
	return &AuthHandler{
		cfg: cfg,
		db:  db,
		sec: sec,
	}
}

func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	ip := ClientIP(r, h.cfg)
	if !h.sec.CheckLoginRate(ip) {
		WriteError(w, http.StatusTooManyRequests, "too many attempts, try again later")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20) // 1MB limit

	var req models.LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		WriteError(w, http.StatusUnprocessableEntity, "invalid request body")
		return
	}

	req.DeviceName = strings.TrimSpace(req.DeviceName)
	if req.DeviceID == uuid.Nil || req.DeviceName == "" || len(req.DeviceName) > 255 {
		WriteError(w, http.StatusUnprocessableEntity, "device_id and valid device_name (1-255 chars) are required")
		return
	}

	if !h.sec.VerifyPassword(req.Password) {
		WriteError(w, http.StatusUnauthorized, "invalid password")
		return
	}

	now := time.Now().UTC()
	newJTI := uuid.New()

	// Atomic PostgreSQL upsert
	upsertQuery := `
		INSERT INTO devices (id, name, created_at, last_seen_at, refresh_jti)
		VALUES ($1, $2, $3, $3, $4)
		ON CONFLICT (id) DO UPDATE SET
			name = EXCLUDED.name,
			last_seen_at = EXCLUDED.last_seen_at,
			refresh_jti = EXCLUDED.refresh_jti`
	_, err := h.db.ExecContext(r.Context(), upsertQuery, req.DeviceID.String(), req.DeviceName, now, newJTI.String())
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "failed to register device")
		return
	}

	accessToken, err := h.sec.CreateAccessToken(req.DeviceID)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "failed to create access token")
		return
	}

	refreshToken, err := h.sec.CreateRefreshToken(req.DeviceID, newJTI)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "failed to create refresh token")
		return
	}

	WriteJSON(w, http.StatusOK, models.TokenResponse{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		DeviceID:     req.DeviceID,
	})
}

func (h *AuthHandler) Refresh(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)

	var req models.RefreshRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		WriteError(w, http.StatusUnauthorized, "invalid refresh token")
		return
	}

	deviceID, jti, err := h.sec.DecodeRefreshToken(req.RefreshToken)
	if err != nil {
		WriteError(w, http.StatusUnauthorized, "invalid refresh token")
		return
	}

	var currentJTI sql.NullString
	query := "SELECT refresh_jti FROM devices WHERE id = $1"
	err = h.db.QueryRowContext(r.Context(), query, deviceID.String()).Scan(&currentJTI)
	if err != nil || !currentJTI.Valid || currentJTI.String != jti.String() {
		WriteError(w, http.StatusUnauthorized, "refresh token revoked")
		return
	}

	now := time.Now().UTC()
	newJTI := uuid.New()

	updQuery := "UPDATE devices SET last_seen_at = $1, refresh_jti = $2 WHERE id = $3"
	_, updErr := h.db.ExecContext(r.Context(), updQuery, now, newJTI.String(), deviceID.String())
	if updErr != nil {
		WriteError(w, http.StatusInternalServerError, "failed to update refresh token")
		return
	}

	accessToken, err := h.sec.CreateAccessToken(deviceID)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "failed to create access token")
		return
	}

	refreshToken, err := h.sec.CreateRefreshToken(deviceID, newJTI)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "failed to create refresh token")
		return
	}

	WriteJSON(w, http.StatusOK, models.TokenResponse{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		DeviceID:     deviceID,
	})
}

func (h *AuthHandler) Logout(w http.ResponseWriter, r *http.Request) {
	_, jti, ok := GetAuth(r)
	if ok && jti != "" {
		h.sec.RevokeAccessTokens(jti)
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)

	var req models.RefreshRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err == nil && req.RefreshToken != "" {
		deviceID, rjti, err := h.sec.DecodeRefreshToken(req.RefreshToken)
		if err == nil {
			delQuery := "UPDATE devices SET refresh_jti = NULL WHERE id = $1 AND refresh_jti = $2"
			_, _ = h.db.ExecContext(r.Context(), delQuery, deviceID.String(), rjti.String())
		}
	}

	w.WriteHeader(http.StatusNoContent)
}
