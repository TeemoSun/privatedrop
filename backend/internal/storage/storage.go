package storage

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

type StorageManager struct {
	storageRoot string
	jwtSecret   []byte
	ttlSeconds  int
	maxFileSize int64
}

type PhysicalFileInfo struct {
	SHA256   string
	Size     int64
	Path     string
	FullPath string
}

func NewStorageManager(storagePath string, jwtSecret string, ttlSeconds int, maxFileSize int64) *StorageManager {
	absPath, err := filepath.Abs(storagePath)
	if err != nil {
		absPath = storagePath
	}
	return &StorageManager{
		storageRoot: absPath,
		jwtSecret:   []byte(jwtSecret),
		ttlSeconds:  ttlSeconds,
		maxFileSize: maxFileSize,
	}
}

func (s *StorageManager) FilesDir() string {
	return filepath.Join(s.storageRoot, "files")
}

func (s *StorageManager) TempDir() string {
	return filepath.Join(s.storageRoot, "tmp")
}

func (s *StorageManager) EnsureStorageDirs() error {
	if err := os.MkdirAll(s.FilesDir(), 0755); err != nil {
		return err
	}
	return os.MkdirAll(s.TempDir(), 0755)
}

func (s *StorageManager) GetFilePath(sha string) string {
	sha = strings.ToLower(strings.TrimSpace(sha))
	if len(sha) < 4 {
		return filepath.Join(s.FilesDir(), sha)
	}
	return filepath.Join(s.FilesDir(), sha[:2], sha[2:4], sha)
}

func (s *StorageManager) GetTempPath(fileID uuid.UUID) string {
	return filepath.Join(s.TempDir(), fileID.String())
}

func (s *StorageManager) FileExists(sha string) bool {
	path := s.GetFilePath(sha)
	fi, err := os.Stat(path)
	return err == nil && !fi.IsDir()
}

func ChecksumSHA256(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func (s *StorageManager) CreateDownloadTicket(itemID, fileID uuid.UUID) (string, time.Time, error) {
	expiresAt := time.Now().UTC().Add(time.Duration(s.ttlSeconds) * time.Second)
	claims := jwt.MapClaims{
		"sub":     "download",
		"item_id": itemID.String(),
		"file_id": fileID.String(),
		"exp":     expiresAt.Unix(),
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tokenStr, err := token.SignedString(s.jwtSecret)
	if err != nil {
		return "", time.Time{}, err
	}
	return tokenStr, expiresAt, nil
}

func (s *StorageManager) VerifyDownloadTicket(ticket string, itemID, fileID uuid.UUID) bool {
	token, err := jwt.Parse(ticket, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return s.jwtSecret, nil
	})
	if err != nil || !token.Valid {
		return false
	}

	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return false
	}

	if claims["sub"] != "download" {
		return false
	}
	if claims["item_id"] != itemID.String() {
		return false
	}
	if claims["file_id"] != fileID.String() {
		return false
	}
	return true
}

func (s *StorageManager) SaveUploadStream(fileID uuid.UUID, expectedSHA256 string, expectedSize int64, reader io.Reader) (string, error) {
	if err := s.EnsureStorageDirs(); err != nil {
		return "", err
	}

	tempPath := s.GetTempPath(fileID)
	tempFile, err := os.OpenFile(tempPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return "", fmt.Errorf("failed to create temp file: %w", err)
	}

	hasher := sha256.New()
	mw := io.MultiWriter(tempFile, hasher)

	// Stream with buffer and size check
	buf := make([]byte, 64*1024)
	var written int64
	var writeErr error

	for {
		nr, er := reader.Read(buf)
		if nr > 0 {
			written += int64(nr)
			if written > s.maxFileSize {
				writeErr = errors.New("File size exceeds MAX_FILE_SIZE")
				break
			}
			if written > expectedSize {
				writeErr = fmt.Errorf("Size mismatch: expected %d, got more", expectedSize)
				break
			}
			nw, ew := mw.Write(buf[0:nr])
			if ew != nil {
				writeErr = ew
				break
			}
			if nr != nw {
				writeErr = io.ErrShortWrite
				break
			}
		}
		if er != nil {
			if er != io.EOF {
				writeErr = er
			}
			break
		}
	}

	tempFile.Close()

	if writeErr != nil {
		_ = os.Remove(tempPath)
		return "", writeErr
	}

	if written != expectedSize {
		_ = os.Remove(tempPath)
		return "", fmt.Errorf("Size mismatch: expected %d, got %d", expectedSize, written)
	}

	computedSHA := hex.EncodeToString(hasher.Sum(nil))
	if !strings.EqualFold(computedSHA, expectedSHA256) {
		_ = os.Remove(tempPath)
		return "", fmt.Errorf("SHA-256 mismatch: expected %s, got %s", strings.ToLower(expectedSHA256), computedSHA)
	}

	targetPath := s.GetFilePath(computedSHA)
	if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
		_ = os.Remove(tempPath)
		return "", err
	}

	// Move file (atomic replace if on same volume; fallback to copy/delete if cross-volume)
	if err := os.Rename(tempPath, targetPath); err != nil {
		// Fallback copy
		if cpErr := copyFile(tempPath, targetPath); cpErr != nil {
			_ = os.Remove(tempPath)
			return "", cpErr
		}
		_ = os.Remove(tempPath)
	}

	return targetPath, nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()

	_, err = io.Copy(out, in)
	return err
}

func (s *StorageManager) CleanupEmptyParents(fullPath string) {
	parent := filepath.Dir(fullPath)
	root := s.FilesDir()

	for parent != root && strings.HasPrefix(parent, root) {
		entries, err := os.ReadDir(parent)
		if err != nil || len(entries) > 0 {
			break
		}
		if err := os.Remove(parent); err != nil {
			break
		}
		parent = filepath.Dir(parent)
	}
}

func (s *StorageManager) DeleteFileIfUnreferenced(ctx context.Context, db *sql.DB, sha256 string) (bool, error) {
	sha256 = strings.ToLower(strings.TrimSpace(sha256))
	var count int
	err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM drop_files WHERE LOWER(sha256) = LOWER($1)", sha256).Scan(&count)
	if err != nil {
		// Try SQLite ? parameter if $1 failed
		err = db.QueryRowContext(ctx, "SELECT COUNT(*) FROM drop_files WHERE LOWER(sha256) = LOWER(?)", sha256).Scan(&count)
	}
	if err != nil {
		return false, err
	}

	if count == 0 {
		path := s.GetFilePath(sha256)
		if fi, err := os.Stat(path); err == nil && !fi.IsDir() {
			_ = os.Remove(path)
			s.CleanupEmptyParents(path)
			return true, nil
		}
	}
	return false, nil
}

func (s *StorageManager) CleanupTempFiles(maxAge time.Duration) int {
	_ = s.EnsureStorageDirs()
	cutoff := time.Now().Add(-maxAge)
	removed := 0

	entries, err := os.ReadDir(s.TempDir())
	if err != nil {
		return 0
	}

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err == nil && info.ModTime().Before(cutoff) {
			path := filepath.Join(s.TempDir(), entry.Name())
			if err := os.Remove(path); err == nil {
				removed++
			}
		}
	}
	return removed
}

func (s *StorageManager) ScanPhysicalFiles() ([]PhysicalFileInfo, error) {
	_ = s.EnsureStorageDirs()
	var results []PhysicalFileInfo
	root := s.FilesDir()

	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil || info == nil || info.IsDir() {
			return nil
		}
		sha := strings.ToLower(filepath.Base(path))
		relPath, _ := filepath.Rel(root, path)
		results = append(results, PhysicalFileInfo{
			SHA256:   sha,
			Size:     info.Size(),
			Path:     relPath,
			FullPath: path,
		})
		return nil
	})

	return results, err
}

func (s *StorageManager) RemoveOrphanFile(fullPath string) bool {
	fi, err := os.Stat(fullPath)
	if err != nil || fi.IsDir() {
		return false
	}
	if err := os.Remove(fullPath); err == nil {
		s.CleanupEmptyParents(fullPath)
		return true
	}
	return false
}

