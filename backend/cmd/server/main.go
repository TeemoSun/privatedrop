package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"privatedrop/internal/api"
	"privatedrop/internal/config"
	"privatedrop/internal/database"
	"privatedrop/internal/security"
	"privatedrop/internal/storage"
	"privatedrop/internal/worker"
	"privatedrop/internal/ws"
)

func main() {
	healthCheckFlag := flag.Bool("healthcheck", false, "Run healthcheck against local server")
	flag.Parse()

	// Check if "healthcheck" was passed as command or flag
	if *healthCheckFlag || (len(flag.Args()) > 0 && flag.Args()[0] == "healthcheck") {
		runHealthcheck()
		return
	}

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("failed to load configuration: %v", err)
	}

	if err := cfg.ValidateSecrets(); err != nil {
		log.Fatalf("%v", err)
	}

	storageMgr := storage.NewStorageManager(
		cfg.StoragePath,
		cfg.JWTSecret,
		cfg.UploadURLTTLSeconds,
		cfg.MaxFileSize,
	)
	if err := storageMgr.EnsureStorageDirs(); err != nil {
		log.Fatalf("failed to ensure storage directories: %v", err)
	}

	db, err := database.OpenFromURL(cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("failed to connect to database: %v", err)
	}
	defer db.Close()

	if err := db.Migrate(context.Background()); err != nil {
		log.Fatalf("failed to run migrations: %v", err)
	}

	pwdHash, err := security.HashPassword(cfg.AppPassword)
	if err != nil {
		log.Fatalf("failed to hash app password: %v", err)
	}

	secMgr := security.NewSecurityManager(
		cfg.JWTSecret,
		cfg.AccessTokenMinutes,
		cfg.RefreshTokenDays,
		pwdHash,
	)

	wsMgr := ws.NewConnectionManager()

	cleanupWorker := worker.NewCleanupWorker(
		db.DB,
		storageMgr,
		secMgr,
		wsMgr,
		cfg.UploadURLTTLSeconds,
	)
	cleanupWorker.Start(10 * time.Minute)
	defer cleanupWorker.Stop()

	staticDir := findStaticDir()
	server := api.NewServer(cfg, db, secMgr, storageMgr, wsMgr, staticDir)

	httpServer := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           server.Router,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Minute, // Large for multi-GB streaming uploads
		WriteTimeout:      30 * time.Minute,
		IdleTimeout:       2 * time.Minute,
	}

	go func() {
		log.Printf("privatedrop started on port %s", cfg.Port)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server listen error: %v", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Println("shutting down privatedrop...")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := httpServer.Shutdown(ctx); err != nil {
		log.Printf("server forced to shutdown: %v", err)
	}

	log.Println("privatedrop stopped cleanly")
}

func runHealthcheck() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8000"
	}
	url := fmt.Sprintf("http://127.0.0.1:%s/healthz", port)

	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(url)
	if err != nil || resp.StatusCode != http.StatusOK {
		os.Exit(1)
	}
	os.Exit(0)
}

func findStaticDir() string {
	candidates := []string{
		"app/static",
		"static",
		"../frontend/dist",
		"./dist",
	}
	for _, c := range candidates {
		if fi, err := os.Stat(c); err == nil && fi.IsDir() {
			abs, _ := filepath.Abs(c)
			return abs
		}
	}
	return ""
}

