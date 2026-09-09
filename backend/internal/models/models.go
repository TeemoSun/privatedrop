package models

import (
	"time"

	"github.com/google/uuid"
)

type Device struct {
	ID         uuid.UUID  `json:"id"`
	Name       string     `json:"name"`
	CreatedAt  time.Time  `json:"created_at"`
	LastSeenAt time.Time  `json:"last_seen_at"`
	RefreshJTI *uuid.UUID `json:"-"`
}

type DropItem struct {
	ID              uuid.UUID   `json:"id"`
	CreatedByDevice *uuid.UUID  `json:"created_by_device"`
	Kind            string      `json:"kind"` // "note" or "file"
	Note            *string     `json:"note"`
	IsEphemeral     bool        `json:"is_ephemeral"`
	IsSecret        bool        `json:"is_secret"`
	ExpiresAt       *time.Time  `json:"expires_at"`
	DeletedAt       *time.Time  `json:"deleted_at"`
	CreatedAt       time.Time   `json:"created_at"`
	Files           []*DropFile `json:"files"`
}

type DropFile struct {
	ID         uuid.UUID  `json:"id"`
	ItemID     uuid.UUID  `json:"item_id"`
	FileName   string     `json:"file_name"`
	MimeType   string     `json:"mime_type"`
	Size       int64      `json:"size"`
	SHA256     string     `json:"sha256"`
	UploadedAt *time.Time `json:"uploaded_at"`
}

type LoginRequest struct {
	Password   string    `json:"password"`
	DeviceID   uuid.UUID `json:"device_id"`
	DeviceName string    `json:"device_name"`
}

type TokenResponse struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token"`
	DeviceID     uuid.UUID `json:"device_id"`
}

type RefreshRequest struct {
	RefreshToken string `json:"refresh_token"`
}

type DeviceOut struct {
	ID         uuid.UUID `json:"id"`
	Name       string    `json:"name"`
	CreatedAt  time.Time `json:"created_at"`
	LastSeenAt time.Time `json:"last_seen_at"`
}

type DevicePatch struct {
	Name string `json:"name"`
}

type FileSpec struct {
	FileName string `json:"file_name"`
	MimeType string `json:"mime_type"`
	Size     int64  `json:"size"`
	SHA256   string `json:"sha256"`
}

type ItemCreate struct {
	Kind        string     `json:"kind"`
	Note        *string    `json:"note,omitempty"`
	IsEphemeral bool       `json:"is_ephemeral"`
	IsSecret    bool       `json:"is_secret"`
	Files       []FileSpec `json:"files"`
}

type FileUploadTarget struct {
	FileID        uuid.UUID `json:"file_id"`
	UploadURL     string    `json:"upload_url"`
	AlreadyExists bool      `json:"already_exists"`
}

type FileOut struct {
	ID         uuid.UUID  `json:"id"`
	FileName   string     `json:"file_name"`
	MimeType   string     `json:"mime_type"`
	Size       int64      `json:"size"`
	SHA256     string     `json:"sha256"`
	UploadedAt *time.Time `json:"uploaded_at"`
}

type ItemOut struct {
	ID              uuid.UUID  `json:"id"`
	Kind            string     `json:"kind"`
	Note            *string    `json:"note"`
	IsEphemeral     bool       `json:"is_ephemeral"`
	IsSecret        bool       `json:"is_secret"`
	ExpiresAt       *time.Time `json:"expires_at"`
	DeletedAt       *time.Time `json:"deleted_at"`
	CreatedAt       time.Time  `json:"created_at"`
	CreatedByDevice *uuid.UUID `json:"created_by_device"`
	Files           []FileOut  `json:"files"`
}

type ItemCreateResponse struct {
	ItemID uuid.UUID          `json:"item_id"`
	Files  []FileUploadTarget `json:"files"`
	Item   *ItemOut           `json:"item,omitempty"`
}

type ItemList struct {
	Items      []ItemOut `json:"items"`
	NextCursor *string   `json:"next_cursor"`
}

type DownloadUrlResponse struct {
	URL       string    `json:"url"`
	ExpiresAt time.Time `json:"expires_at"`
}

type MissingFileItem struct {
	ItemID          uuid.UUID  `json:"item_id"`
	ItemKind        string     `json:"item_kind"`
	ItemNote        *string    `json:"item_note"`
	ItemCreatedAt   time.Time  `json:"item_created_at"`
	ItemIsEphemeral bool       `json:"item_is_ephemeral"`
	ItemIsSecret    bool       `json:"item_is_secret"`
	ItemDeletedAt   *time.Time `json:"item_deleted_at"`
	FileID          uuid.UUID  `json:"file_id"`
	FileName        string     `json:"file_name"`
	FileSize        int64      `json:"file_size"`
	SHA256          string     `json:"sha256"`
}

type OrphanFileItem struct {
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
	Path   string `json:"path"`
}

type StorageCheckResponse struct {
	Status         string            `json:"status"` // "healthy" | "issues_found"
	TotalDBItems   int               `json:"total_db_items"`
	TotalDBFiles   int               `json:"total_db_files"`
	TotalDiskFiles int               `json:"total_disk_files"`
	TotalDiskSize  int64             `json:"total_disk_size"`
	MissingFiles   []MissingFileItem `json:"missing_files"`
	OrphanFiles    []OrphanFileItem  `json:"orphan_files"`
}

type StorageFixResponse struct {
	DeletedOrphanFilesCount int   `json:"deleted_orphan_files_count"`
	DeletedOrphanFilesSize  int64 `json:"deleted_orphan_files_size"`
	DeletedBrokenItemsCount int   `json:"deleted_broken_items_count"`
}

type HTTPError struct {
	Detail string `json:"detail"`
}

