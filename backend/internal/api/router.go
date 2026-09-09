package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"privatedrop/internal/config"
	"privatedrop/internal/database"
	"privatedrop/internal/security"
	"privatedrop/internal/storage"
	"privatedrop/internal/ws"
)

type Server struct {
	cfg         *config.Config
	db          *database.DB
	sec         *security.SecurityManager
	storage     *storage.StorageManager
	wsManager   *ws.ConnectionManager
	staticDir   string
	Router      chi.Router
}

func NewServer(
	cfg *config.Config,
	db *database.DB,
	sec *security.SecurityManager,
	storageManager *storage.StorageManager,
	wsManager *ws.ConnectionManager,
	staticDir string,
) *Server {
	s := &Server{
		cfg:       cfg,
		db:        db,
		sec:       sec,
		storage:   storageManager,
		wsManager: wsManager,
		staticDir: staticDir,
		Router:    chi.NewRouter(),
	}

	s.setupRoutes()
	return s
}

func (s *Server) setupRoutes() {
	r := s.Router

	r.Use(middleware.RequestID)
	r.Use(middleware.Recoverer)

	// CORS
	corsOrigins := s.cfg.CORSOriginList()
	if len(corsOrigins) > 0 {
		r.Use(cors.Handler(cors.Options{
			AllowedOrigins:   corsOrigins,
			AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
			AllowedHeaders:   []string{"*"},
			AllowCredentials: true,
			MaxAge:           300,
		}))
	}

	// Health check
	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	authHandler := NewAuthHandler(s.cfg, s.db, s.sec)
	devicesHandler := NewDevicesHandler(s.db)
	itemsHandler := NewItemsHandler(s.cfg, s.db, s.storage, s.wsManager)
	maintHandler := NewMaintenanceHandler(s.db, s.storage, s.wsManager)

	// API Routes
	r.Route("/api", func(r chi.Router) {
		// WS
		r.Get("/ws", func(w http.ResponseWriter, r *http.Request) {
			token := r.URL.Query().Get("token")
			deviceID, _, err := s.sec.DecodeAccessToken(token)
			if err != nil {
				_ = ws.CloseUnauthorized(w, r)
				return
			}
			_ = s.wsManager.HandleConnection(w, r, deviceID)
		})

		// Auth
		r.Route("/auth", func(r chi.Router) {
			r.Post("/login", authHandler.Login)
			r.Post("/refresh", authHandler.Refresh)
			r.With(RequireAuth(s.sec)).Post("/logout", authHandler.Logout)
		})

		// Devices
		r.Route("/devices", func(r chi.Router) {
			r.Use(RequireAuth(s.sec))
			r.Get("/", devicesHandler.List)
			r.Patch("/{device_id}", devicesHandler.Rename)
			r.Delete("/{device_id}", devicesHandler.Delete)
		})

		// Items
		r.Route("/items", func(r chi.Router) {
			// Download file: can be accessed via ?ticket=... or Bearer token
			r.With(OptionalAuth(s.sec)).Get("/{item_id}/files/{file_id}/download", itemsHandler.DownloadFile)

			// Authenticated items endpoints
			r.Group(func(r chi.Router) {
				r.Use(RequireAuth(s.sec))
				r.Get("/", itemsHandler.List)
				r.Post("/", itemsHandler.Create)
				r.Put("/{item_id}/files/{file_id}/upload", itemsHandler.UploadFile)
				r.Post("/{item_id}/upload-complete", itemsHandler.UploadComplete)
				r.Get("/{item_id}/files/{file_id}/download-url", itemsHandler.DownloadURL)
				r.Get("/trash", itemsHandler.ListTrash)
				r.Delete("/trash/empty", itemsHandler.EmptyTrash)
				r.Post("/{item_id}/restore", itemsHandler.Restore)
				r.Delete("/{item_id}/purge", itemsHandler.Purge)
				r.Delete("/{item_id}", itemsHandler.Delete)
			})
		})

		// Maintenance
		r.Route("/maintenance", func(r chi.Router) {
			r.Use(RequireAuth(s.sec))
			r.Get("/storage-check", maintHandler.StorageCheck)
			r.Post("/storage-fix", maintHandler.StorageFix)
		})
	})

	// Static SPA fallback
	if s.staticDir != "" {
		if fi, err := os.Stat(s.staticDir); err == nil && fi.IsDir() {
			r.NotFound(func(w http.ResponseWriter, r *http.Request) {
				// Don't fallback for unhandled /api/*
				if strings.HasPrefix(r.URL.Path, "/api/") {
					WriteError(w, http.StatusNotFound, "Not Found")
					return
				}

				cleanPath := filepath.Clean(strings.TrimPrefix(r.URL.Path, "/"))
				targetFile := filepath.Join(s.staticDir, cleanPath)

				rel, err := filepath.Rel(s.staticDir, targetFile)
				if err == nil && !strings.HasPrefix(rel, "..") && rel != "." {
					if fi, err := os.Stat(targetFile); err == nil && !fi.IsDir() {
						http.ServeFile(w, r, targetFile)
						return
					}
				}

				// Fallback to index.html
				indexPath := filepath.Join(s.staticDir, "index.html")
				http.ServeFile(w, r, indexPath)
			})
		}
	}
}

