package api

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"privatedrop/internal/config"
	"privatedrop/internal/models"
	"privatedrop/internal/security"
)

type contextKey string

const (
	authDeviceIDKey contextKey = "authDeviceID"
	authJTIKey      contextKey = "authJTI"
)

func WriteJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if data != nil {
		_ = json.NewEncoder(w).Encode(data)
	}
}

func WriteError(w http.ResponseWriter, status int, detail string) {
	WriteJSON(w, status, models.HTTPError{Detail: detail})
}

func RequireAuth(sec *security.SecurityManager) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authHeader := r.Header.Get("Authorization")
			if authHeader == "" {
				WriteError(w, http.StatusUnauthorized, "missing token")
				return
			}

			parts := strings.SplitN(authHeader, " ", 2)
			if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
				WriteError(w, http.StatusUnauthorized, "invalid token")
				return
			}

			tokenStr := strings.TrimSpace(parts[1])
			deviceID, jti, err := sec.DecodeAccessToken(tokenStr)
			if err != nil {
				WriteError(w, http.StatusUnauthorized, "invalid token")
				return
			}

			ctx := context.WithValue(r.Context(), authDeviceIDKey, deviceID)
			ctx = context.WithValue(ctx, authJTIKey, jti)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func OptionalAuth(sec *security.SecurityManager) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authHeader := r.Header.Get("Authorization")
			if authHeader != "" {
				parts := strings.SplitN(authHeader, " ", 2)
				if len(parts) == 2 && strings.EqualFold(parts[0], "Bearer") {
					tokenStr := strings.TrimSpace(parts[1])
					deviceID, jti, err := sec.DecodeAccessToken(tokenStr)
					if err == nil {
						ctx := context.WithValue(r.Context(), authDeviceIDKey, deviceID)
						ctx = context.WithValue(ctx, authJTIKey, jti)
						next.ServeHTTP(w, r.WithContext(ctx))
						return
					}
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}

func GetAuth(r *http.Request) (uuid.UUID, string, bool) {
	deviceID, ok1 := r.Context().Value(authDeviceIDKey).(uuid.UUID)
	jti, ok2 := r.Context().Value(authJTIKey).(string)
	if ok1 && ok2 && deviceID != uuid.Nil {
		return deviceID, jti, true
	}
	return uuid.Nil, "", false
}

func ClientIP(r *http.Request, cfg *config.Config) string {
	remoteHost, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		remoteHost = r.RemoteAddr
	}
	remoteHost = strings.TrimSpace(remoteHost)
	if remoteHost == "" {
		remoteHost = "unknown"
	}

	if cfg.IsTrustedProxy(remoteHost) {
		forwarded := r.Header.Get("X-Forwarded-For")
		if forwarded != "" {
			parts := strings.Split(forwarded, ",")
			candidate := strings.TrimSpace(parts[0])
			if candidate != "" {
				return candidate
			}
		}
		realIP := strings.TrimSpace(r.Header.Get("X-Real-IP"))
		if realIP != "" {
			return realIP
		}
	}

	return remoteHost
}

