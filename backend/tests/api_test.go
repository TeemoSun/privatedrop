package tests

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"privatedrop/internal/api"
	"privatedrop/internal/config"
	"privatedrop/internal/database"
	"privatedrop/internal/models"
	"privatedrop/internal/security"
	"privatedrop/internal/storage"
	"privatedrop/internal/worker"
	"privatedrop/internal/ws"
)

const testPassword = "test-password-123"
const testJWTSecret = "test-jwt-secret-456-abcdefghijklmnopqrstuvwxyz"
const testDBURL = "postgres://privatedrop:privatedrop@localhost:5432/privatedrop?sslmode=disable"

type testEnv struct {
	server        *httptest.Server
	db            *database.DB
	sec           *security.SecurityManager
	storage       *storage.StorageManager
	cleanupWorker *worker.CleanupWorker
	staticDir     string
}

func setupTest(t *testing.T) *testEnv {
	db, err := database.OpenFromURL(testDBURL)
	if err != nil {
		t.Fatalf("failed to connect to test db: %v", err)
	}

	ctx := context.Background()
	if err := db.Migrate(ctx); err != nil {
		t.Fatalf("failed to run migrations: %v", err)
	}

	// Truncate tables for clean test slate
	_, err = db.ExecContext(ctx, "TRUNCATE drop_files, drop_items, devices CASCADE")
	if err != nil {
		t.Fatalf("failed to truncate tables: %v", err)
	}

	storageDir := filepath.Join(t.TempDir(), "storage")
	staticDir := filepath.Join(t.TempDir(), "static")
	_ = os.MkdirAll(staticDir, 0755)
	_ = os.WriteFile(filepath.Join(staticDir, "index.html"), []byte("<html><body>index</body></html>"), 0644)

	cfg := &config.Config{
		AppPassword:         testPassword,
		JWTSecret:           testJWTSecret,
		DatabaseURL:         testDBURL,
		StoragePath:         storageDir,
		AccessTokenMinutes:  15,
		RefreshTokenDays:    30,
		MaxFileSize:         10 * 1024 * 1024,
		UploadURLTTLSeconds: 900,
		Port:                "8000",
		TrustedProxies:      "127.0.0.1,::1",
	}

	pwdHash, err := security.HashPassword(testPassword)
	if err != nil {
		t.Fatalf("failed to hash password: %v", err)
	}

	secMgr := security.NewSecurityManager(testJWTSecret, 15, 30, pwdHash)
	secMgr.ResetForTesting()

	storageMgr := storage.NewStorageManager(storageDir, testJWTSecret, 900, 10*1024*1024)
	_ = storageMgr.EnsureStorageDirs()

	wsMgr := ws.NewConnectionManager()

	cleanupWorker := worker.NewCleanupWorker(db.DB, storageMgr, secMgr, wsMgr, 900)

	apiServer := api.NewServer(cfg, db, secMgr, storageMgr, wsMgr, staticDir)
	ts := httptest.NewServer(apiServer.Router)

	t.Cleanup(func() {
		ts.Close()
		db.Close()
	})

	return &testEnv{
		server:        ts,
		db:            db,
		sec:           secMgr,
		storage:       storageMgr,
		cleanupWorker: cleanupWorker,
		staticDir:     staticDir,
	}
}

func loginHelper(t *testing.T, ts *httptest.Server) (uuid.UUID, string, string) {
	deviceID := uuid.New()
	reqBody := models.LoginRequest{
		Password:   testPassword,
		DeviceID:   deviceID,
		DeviceName: "pytest",
	}
	data, _ := json.Marshal(reqBody)

	resp, err := http.Post(ts.URL+"/api/auth/login", "application/json", bytes.NewReader(data))
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("login failed: %v, status: %d", err, resp.StatusCode)
	}
	defer resp.Body.Close()

	var tokenResp models.TokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&tokenResp); err != nil {
		t.Fatalf("failed to decode login token response: %v", err)
	}

	return deviceID, tokenResp.AccessToken, tokenResp.RefreshToken
}

func authReq(method, url string, body io.Reader, token string) *http.Request {
	req, _ := http.NewRequest(method, url, body)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return req
}

// 1. Test Login and Re-auth
func TestLoginAndReauth(t *testing.T) {
	env := setupTest(t)
	deviceID, accessToken, refreshToken := loginHelper(t, env.server)
	if accessToken == "" || refreshToken == "" {
		t.Fatal("empty tokens returned")
	}

	// Refresh token
	refBody := models.RefreshRequest{RefreshToken: refreshToken}
	refData, _ := json.Marshal(refBody)
	resp, err := http.Post(env.server.URL+"/api/auth/refresh", "application/json", bytes.NewReader(refData))
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("refresh failed: %v, status: %d", err, resp.StatusCode)
	}
	var newTokens models.TokenResponse
	_ = json.NewDecoder(resp.Body).Decode(&newTokens)
	resp.Body.Close()

	if newTokens.DeviceID != deviceID {
		t.Fatalf("device_id mismatch: expected %v, got %v", deviceID, newTokens.DeviceID)
	}

	// Try refreshing AGAIN with old refresh token -> must be 401
	resp2, _ := http.Post(env.server.URL+"/api/auth/refresh", "application/json", bytes.NewReader(refData))
	if resp2.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 for revoked refresh token, got %d", resp2.StatusCode)
	}
	resp2.Body.Close()
}

// 2. Test Login Wrong Password
func TestLoginWrongPassword(t *testing.T) {
	env := setupTest(t)
	reqBody := models.LoginRequest{
		Password:   "wrong",
		DeviceID:   uuid.New(),
		DeviceName: "pytest",
	}
	data, _ := json.Marshal(reqBody)

	resp, err := http.Post(env.server.URL+"/api/auth/login", "application/json", bytes.NewReader(data))
	if err != nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", resp.StatusCode)
	}
	resp.Body.Close()
}

// 3. Test Notes Flow
func TestNotesFlow(t *testing.T) {
	env := setupTest(t)
	_, token, _ := loginHelper(t, env.server)

	// Create note
	noteText := "hello world"
	createBody := models.ItemCreate{
		Kind: "note",
		Note: &noteText,
	}
	createData, _ := json.Marshal(createBody)
	req := authReq("POST", env.server.URL+"/api/items", bytes.NewReader(createData), token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("create note failed: %v, code: %d", err, resp.StatusCode)
	}

	var createResp models.ItemCreateResponse
	_ = json.NewDecoder(resp.Body).Decode(&createResp)
	resp.Body.Close()

	if createResp.Item == nil || createResp.Item.ID != createResp.ItemID || *createResp.Item.Note != "hello world" {
		t.Fatalf("unexpected create response: %+v", createResp)
	}

	// List items
	listReq := authReq("GET", env.server.URL+"/api/items?limit=10", nil, token)
	listResp, _ := http.DefaultClient.Do(listReq)
	var itemList models.ItemList
	_ = json.NewDecoder(listResp.Body).Decode(&itemList)
	listResp.Body.Close()

	if len(itemList.Items) != 1 || *itemList.Items[0].Note != "hello world" {
		t.Fatalf("unexpected item list: %+v", itemList)
	}

	// Delete item
	delReq := authReq("DELETE", fmt.Sprintf("%s/api/items/%s", env.server.URL, createResp.ItemID), nil, token)
	delResp, _ := http.DefaultClient.Do(delReq)
	if delResp.StatusCode != http.StatusNoContent {
		t.Fatalf("expected 204 on delete, got %d", delResp.StatusCode)
	}
	delResp.Body.Close()

	// List again -> empty
	listResp2, _ := http.DefaultClient.Do(listReq)
	var itemList2 models.ItemList
	_ = json.NewDecoder(listResp2.Body).Decode(&itemList2)
	listResp2.Body.Close()

	if len(itemList2.Items) != 0 {
		t.Fatalf("expected 0 items after delete, got %d", len(itemList2.Items))
	}
}

// 4. Test File Item Upload, Download, and Deduplication
func TestFileItemUploadDownloadAndDeduplication(t *testing.T) {
	env := setupTest(t)
	_, token, _ := loginHelper(t, env.server)

	content := []byte("hello privatedrop content addressable storage test")
	contentSHA := storage.ChecksumSHA256(content)

	// Create file item
	note := "test file 1"
	createBody := models.ItemCreate{
		Kind: "file",
		Note: &note,
		Files: []models.FileSpec{
			{
				FileName: "test.txt",
				MimeType: "text/plain",
				Size:     int64(len(content)),
				SHA256:   contentSHA,
			},
		},
	}
	createData, _ := json.Marshal(createBody)
	req := authReq("POST", env.server.URL+"/api/items", bytes.NewReader(createData), token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201, got %d", resp.StatusCode)
	}

	var createResp models.ItemCreateResponse
	_ = json.NewDecoder(resp.Body).Decode(&createResp)
	resp.Body.Close()

	if len(createResp.Files) != 1 || createResp.Files[0].AlreadyExists {
		t.Fatalf("expected 1 file target with already_exists=false, got %+v", createResp.Files)
	}

	target := createResp.Files[0]

	// Upload content
	uploadReq, _ := http.NewRequest("PUT", env.server.URL+target.UploadURL, bytes.NewReader(content))
	uploadReq.Header.Set("Authorization", "Bearer "+token)
	uploadReq.Header.Set("Content-Type", "application/octet-stream")
	upResp, err := http.DefaultClient.Do(uploadReq)
	if err != nil || upResp.StatusCode != http.StatusOK {
		t.Fatalf("upload failed: %v, status: %d", err, upResp.StatusCode)
	}
	upResp.Body.Close()

	// Upload complete
	compReq := authReq("POST", fmt.Sprintf("%s/api/items/%s/upload-complete", env.server.URL, createResp.ItemID), nil, token)
	compResp, err := http.DefaultClient.Do(compReq)
	if err != nil || compResp.StatusCode != http.StatusOK {
		t.Fatalf("upload complete failed: %v, status: %d", err, compResp.StatusCode)
	}
	compResp.Body.Close()

	// Download URL
	dlURLReq := authReq("GET", fmt.Sprintf("%s/api/items/%s/files/%s/download-url", env.server.URL, createResp.ItemID, target.FileID), nil, token)
	dlURLResp, err := http.DefaultClient.Do(dlURLReq)
	if err != nil || dlURLResp.StatusCode != http.StatusOK {
		t.Fatalf("download-url failed: %v, status: %d", err, dlURLResp.StatusCode)
	}
	var dlResp models.DownloadUrlResponse
	_ = json.NewDecoder(dlURLResp.Body).Decode(&dlResp)
	dlURLResp.Body.Close()

	// Download file with ticket
	getDL, _ := http.Get(env.server.URL + dlResp.URL)
	if getDL.StatusCode != http.StatusOK {
		t.Fatalf("download with ticket failed: %d", getDL.StatusCode)
	}
	dlBytes, _ := io.ReadAll(getDL.Body)
	getDL.Body.Close()
	if !bytes.Equal(dlBytes, content) {
		t.Fatalf("downloaded content mismatch")
	}

	// Download file with Bearer token (no ticket)
	noTicketURL := fmt.Sprintf("%s/api/items/%s/files/%s/download", env.server.URL, createResp.ItemID, target.FileID)
	bearerDLReq := authReq("GET", noTicketURL, nil, token)
	bearerDLResp, _ := http.DefaultClient.Do(bearerDLReq)
	if bearerDLResp.StatusCode != http.StatusOK {
		t.Fatalf("bearer download failed: %d", bearerDLResp.StatusCode)
	}
	bearerBytes, _ := io.ReadAll(bearerDLResp.Body)
	bearerDLResp.Body.Close()
	if !bytes.Equal(bearerBytes, content) {
		t.Fatalf("bearer downloaded content mismatch")
	}

	// Deduplication test: create second item with identical SHA256
	note2 := "test file 2 (duplicate)"
	createBody2 := models.ItemCreate{
		Kind: "file",
		Note: &note2,
		Files: []models.FileSpec{
			{
				FileName: "test_copy.txt",
				MimeType: "text/plain",
				Size:     int64(len(content)),
				SHA256:   contentSHA,
			},
		},
	}
	createData2, _ := json.Marshal(createBody2)
	req2 := authReq("POST", env.server.URL+"/api/items", bytes.NewReader(createData2), token)
	resp2, _ := http.DefaultClient.Do(req2)
	var createResp2 models.ItemCreateResponse
	_ = json.NewDecoder(resp2.Body).Decode(&createResp2)
	resp2.Body.Close()

	if len(createResp2.Files) != 1 || !createResp2.Files[0].AlreadyExists || createResp2.Files[0].UploadURL != "" {
		t.Fatalf("expected already_exists=true and upload_url='' for deduplication, got %+v", createResp2.Files)
	}
}

// 5. Test File Item Draft Hidden Until Complete
func TestFileItemDraftHiddenUntilComplete(t *testing.T) {
	env := setupTest(t)
	_, token, _ := loginHelper(t, env.server)

	content := []byte("draft test content")
	contentSHA := storage.ChecksumSHA256(content)

	note := "draft item"
	createBody := models.ItemCreate{
		Kind: "file",
		Note: &note,
		Files: []models.FileSpec{
			{
				FileName: "draft.txt",
				MimeType: "text/plain",
				Size:     int64(len(content)),
				SHA256:   contentSHA,
			},
		},
	}
	createData, _ := json.Marshal(createBody)
	req := authReq("POST", env.server.URL+"/api/items", bytes.NewReader(createData), token)
	resp, _ := http.DefaultClient.Do(req)
	var createResp models.ItemCreateResponse
	_ = json.NewDecoder(resp.Body).Decode(&createResp)
	resp.Body.Close()

	// Should not be in GET /api/items yet
	listReq := authReq("GET", env.server.URL+"/api/items", nil, token)
	listResp, _ := http.DefaultClient.Do(listReq)
	var itemList models.ItemList
	_ = json.NewDecoder(listResp.Body).Decode(&itemList)
	listResp.Body.Close()
	if len(itemList.Items) != 0 {
		t.Fatalf("expected draft to be hidden from items list, got %d items", len(itemList.Items))
	}

	// Upload file
	target := createResp.Files[0]
	uploadReq, _ := http.NewRequest("PUT", env.server.URL+target.UploadURL, bytes.NewReader(content))
	uploadReq.Header.Set("Authorization", "Bearer "+token)
	upResp, _ := http.DefaultClient.Do(uploadReq)
	upResp.Body.Close()

	// Complete upload
	compReq := authReq("POST", fmt.Sprintf("%s/api/items/%s/upload-complete", env.server.URL, createResp.ItemID), nil, token)
	compResp, _ := http.DefaultClient.Do(compReq)
	compResp.Body.Close()

	// Now it must appear
	listResp2, _ := http.DefaultClient.Do(listReq)
	var itemList2 models.ItemList
	_ = json.NewDecoder(listResp2.Body).Decode(&itemList2)
	listResp2.Body.Close()
	if len(itemList2.Items) != 1 {
		t.Fatalf("expected ready item to appear, got %d", len(itemList2.Items))
	}
}

// 6. Test Devices Flow
func TestDevicesFlow(t *testing.T) {
	env := setupTest(t)
	deviceID, token, _ := loginHelper(t, env.server)

	// List devices
	listReq := authReq("GET", env.server.URL+"/api/devices", nil, token)
	resp, _ := http.DefaultClient.Do(listReq)
	var devices []models.DeviceOut
	_ = json.NewDecoder(resp.Body).Decode(&devices)
	resp.Body.Close()

	if len(devices) != 1 || devices[0].ID != deviceID || devices[0].Name != "pytest" {
		t.Fatalf("unexpected devices: %+v", devices)
	}

	// Rename device
	patchBody := models.DevicePatch{Name: "my-phone"}
	patchData, _ := json.Marshal(patchBody)
	patchReq := authReq("PATCH", fmt.Sprintf("%s/api/devices/%s", env.server.URL, deviceID), bytes.NewReader(patchData), token)
	patchResp, _ := http.DefaultClient.Do(patchReq)
	var patched models.DeviceOut
	_ = json.NewDecoder(patchResp.Body).Decode(&patched)
	patchResp.Body.Close()
	if patched.Name != "my-phone" {
		t.Fatalf("expected name to be my-phone, got %s", patched.Name)
	}

	// Delete device
	delReq := authReq("DELETE", fmt.Sprintf("%s/api/devices/%s", env.server.URL, deviceID), nil, token)
	delResp, _ := http.DefaultClient.Do(delReq)
	if delResp.StatusCode != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", delResp.StatusCode)
	}
	delResp.Body.Close()
}

// 7. Test Logout Requires Auth and Revokes
func TestLogoutRequiresAuthAndRevokes(t *testing.T) {
	env := setupTest(t)
	_, token, refreshToken := loginHelper(t, env.server)

	// Logout without auth header -> 401
	logoutReq1, _ := http.NewRequest("POST", env.server.URL+"/api/auth/logout", nil)
	logoutResp1, _ := http.DefaultClient.Do(logoutReq1)
	if logoutResp1.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 without auth, got %d", logoutResp1.StatusCode)
	}
	logoutResp1.Body.Close()

	// Logout with auth and refresh token
	logoutBody := models.RefreshRequest{RefreshToken: refreshToken}
	logoutData, _ := json.Marshal(logoutBody)
	logoutReq2 := authReq("POST", env.server.URL+"/api/auth/logout", bytes.NewReader(logoutData), token)
	logoutResp2, _ := http.DefaultClient.Do(logoutReq2)
	if logoutResp2.StatusCode != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", logoutResp2.StatusCode)
	}
	logoutResp2.Body.Close()

	// Using the revoked access token should fail
	listReq := authReq("GET", env.server.URL+"/api/items", nil, token)
	listResp, _ := http.DefaultClient.Do(listReq)
	if listResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 for revoked access token, got %d", listResp.StatusCode)
	}
	listResp.Body.Close()

	// Refresh with revoked refresh token should fail
	refBody := models.RefreshRequest{RefreshToken: refreshToken}
	refData, _ := json.Marshal(refBody)
	refResp, _ := http.Post(env.server.URL+"/api/auth/refresh", "application/json", bytes.NewReader(refData))
	if refResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 for revoked refresh token, got %d", refResp.StatusCode)
	}
	refResp.Body.Close()
}

// 8. Test Pagination No Lost Items
func TestPaginationNoLostItems(t *testing.T) {
	env := setupTest(t)
	_, token, _ := loginHelper(t, env.server)

	// Create 5 items
	for i := 1; i <= 5; i++ {
		text := fmt.Sprintf("note %d", i)
		createBody := models.ItemCreate{Kind: "note", Note: &text}
		data, _ := json.Marshal(createBody)
		req := authReq("POST", env.server.URL+"/api/items", bytes.NewReader(data), token)
		resp, _ := http.DefaultClient.Do(req)
		resp.Body.Close()
		time.Sleep(10 * time.Millisecond) // Ensure distinct timestamps
	}

	// Paginate with limit=2
	var gatheredNotes []string
	var cursor string

	for {
		url := fmt.Sprintf("%s/api/items?limit=2", env.server.URL)
		if cursor != "" {
			url += "&cursor=" + cursor
		}
		req := authReq("GET", url, nil, token)
		resp, _ := http.DefaultClient.Do(req)
		var list models.ItemList
		_ = json.NewDecoder(resp.Body).Decode(&list)
		resp.Body.Close()

		for _, item := range list.Items {
			gatheredNotes = append(gatheredNotes, *item.Note)
		}

		if list.NextCursor == nil || *list.NextCursor == "" {
			break
		}
		cursor = *list.NextCursor
	}

	if len(gatheredNotes) != 5 {
		t.Fatalf("expected 5 items gathered via pagination, got %d: %v", len(gatheredNotes), gatheredNotes)
	}
}

// 9. Test SPA Fallback Serves Index for Deep Links
func TestSPAFallbackServesIndexForDeepLinks(t *testing.T) {
	env := setupTest(t)

	// /timeline
	resp1, _ := http.Get(env.server.URL + "/timeline")
	body1, _ := io.ReadAll(resp1.Body)
	resp1.Body.Close()
	if !strings.Contains(string(body1), "index") {
		t.Fatalf("expected index.html for /timeline, got %s", string(body1))
	}

	// /api/unknown -> 404 (NOT fallback)
	resp2, _ := http.Get(env.server.URL + "/api/unknown")
	if resp2.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 for unhandled /api/unknown, got %d", resp2.StatusCode)
	}
	resp2.Body.Close()
}

// 10. Test Ephemeral Items Flow
func TestEphemeralItemsFlow(t *testing.T) {
	env := setupTest(t)
	_, token, _ := loginHelper(t, env.server)

	textEph := "ephemeral note"
	createBody := models.ItemCreate{Kind: "note", Note: &textEph, IsEphemeral: true}
	data, _ := json.Marshal(createBody)
	req := authReq("POST", env.server.URL+"/api/items", bytes.NewReader(data), token)
	resp, _ := http.DefaultClient.Do(req)
	resp.Body.Close()

	textPerm := "permanent note"
	createBody2 := models.ItemCreate{Kind: "note", Note: &textPerm, IsEphemeral: false}
	data2, _ := json.Marshal(createBody2)
	req2 := authReq("POST", env.server.URL+"/api/items", bytes.NewReader(data2), token)
	resp2, _ := http.DefaultClient.Do(req2)
	resp2.Body.Close()

	// Query with is_ephemeral=true
	reqEph := authReq("GET", env.server.URL+"/api/items?is_ephemeral=true", nil, token)
	respEph, _ := http.DefaultClient.Do(reqEph)
	var listEph models.ItemList
	_ = json.NewDecoder(respEph.Body).Decode(&listEph)
	respEph.Body.Close()
	if len(listEph.Items) != 1 || !listEph.Items[0].IsEphemeral {
		t.Fatalf("expected 1 ephemeral item, got %d", len(listEph.Items))
	}

	// Query with is_ephemeral=false
	reqPerm := authReq("GET", env.server.URL+"/api/items?is_ephemeral=false", nil, token)
	respPerm, _ := http.DefaultClient.Do(reqPerm)
	var listPerm models.ItemList
	_ = json.NewDecoder(respPerm.Body).Decode(&listPerm)
	respPerm.Body.Close()
	if len(listPerm.Items) != 1 || listPerm.Items[0].IsEphemeral {
		t.Fatalf("expected 1 permanent item, got %d", len(listPerm.Items))
	}
}

// 11. Test Cleanup Removes Expired Ephemeral Items
func TestCleanupRemovesExpiredEphemeralItems(t *testing.T) {
	env := setupTest(t)
	_, token, _ := loginHelper(t, env.server)

	textEph := "ephemeral expired note"
	createBody := models.ItemCreate{Kind: "note", Note: &textEph, IsEphemeral: true}
	data, _ := json.Marshal(createBody)
	req := authReq("POST", env.server.URL+"/api/items", bytes.NewReader(data), token)
	resp, _ := http.DefaultClient.Do(req)
	var cResp models.ItemCreateResponse
	_ = json.NewDecoder(resp.Body).Decode(&cResp)
	resp.Body.Close()

	// Manually set expires_at in the past
	past := time.Now().UTC().Add(-1 * time.Hour)
	_, err := env.db.ExecContext(context.Background(), "UPDATE drop_items SET expires_at = $1 WHERE id = $2", past, cResp.ItemID.String())
	if err != nil {
		t.Fatalf("failed to update expires_at: %v", err)
	}

	// Trigger cleanup
	env.cleanupWorker.TriggerCleanupNow(context.Background())

	// Check item is deleted from DB
	var count int
	_ = env.db.QueryRowContext(context.Background(), "SELECT COUNT(*) FROM drop_items WHERE id = $1", cResp.ItemID.String()).Scan(&count)
	if count != 0 {
		t.Fatalf("expected item to be removed by cleanup, count: %d", count)
	}
}

// 12. Test Trash Flow Soft Delete Restore Purge
func TestTrashFlowSoftDeleteRestorePurge(t *testing.T) {
	env := setupTest(t)
	_, token, _ := loginHelper(t, env.server)

	text := "trash test note"
	createBody := models.ItemCreate{Kind: "note", Note: &text}
	data, _ := json.Marshal(createBody)
	req := authReq("POST", env.server.URL+"/api/items", bytes.NewReader(data), token)
	resp, _ := http.DefaultClient.Do(req)
	var cResp models.ItemCreateResponse
	_ = json.NewDecoder(resp.Body).Decode(&cResp)
	resp.Body.Close()

	// Delete item -> soft delete
	delReq := authReq("DELETE", fmt.Sprintf("%s/api/items/%s", env.server.URL, cResp.ItemID), nil, token)
	delResp, _ := http.DefaultClient.Do(delReq)
	delResp.Body.Close()

	// Check trash
	trashReq := authReq("GET", env.server.URL+"/api/items/trash", nil, token)
	trashResp, _ := http.DefaultClient.Do(trashReq)
	var trashList []models.ItemOut
	_ = json.NewDecoder(trashResp.Body).Decode(&trashList)
	trashResp.Body.Close()
	if len(trashList) != 1 || trashList[0].ID != cResp.ItemID {
		t.Fatalf("expected item in trash, got %d items", len(trashList))
	}

	// Restore item
	restoreReq := authReq("POST", fmt.Sprintf("%s/api/items/%s/restore", env.server.URL, cResp.ItemID), nil, token)
	restResp, _ := http.DefaultClient.Do(restoreReq)
	if restResp.StatusCode != http.StatusOK {
		t.Fatalf("restore failed: %d", restResp.StatusCode)
	}
	restResp.Body.Close()

	// Should be back in items list
	listReq := authReq("GET", env.server.URL+"/api/items", nil, token)
	listResp, _ := http.DefaultClient.Do(listReq)
	var itemList models.ItemList
	_ = json.NewDecoder(listResp.Body).Decode(&itemList)
	listResp.Body.Close()
	if len(itemList.Items) != 1 {
		t.Fatalf("expected item back in main list, got %d", len(itemList.Items))
	}

	// Purge item permanently
	purgeReq := authReq("DELETE", fmt.Sprintf("%s/api/items/%s/purge", env.server.URL, cResp.ItemID), nil, token)
	purgeResp, _ := http.DefaultClient.Do(purgeReq)
	if purgeResp.StatusCode != http.StatusNoContent {
		t.Fatalf("purge failed: %d", purgeResp.StatusCode)
	}
	purgeResp.Body.Close()

	var count int
	_ = env.db.QueryRowContext(context.Background(), "SELECT COUNT(*) FROM drop_items WHERE id = $1", cResp.ItemID.String()).Scan(&count)
	if count != 0 {
		t.Fatalf("expected purged item to be completely deleted, got count %d", count)
	}
}

// 13. Test Empty Trash
func TestEmptyTrash(t *testing.T) {
	env := setupTest(t)
	_, token, _ := loginHelper(t, env.server)

	// Create 2 notes and delete them
	for i := 1; i <= 2; i++ {
		text := fmt.Sprintf("trash note %d", i)
		cBody := models.ItemCreate{Kind: "note", Note: &text}
		data, _ := json.Marshal(cBody)
		req := authReq("POST", env.server.URL+"/api/items", bytes.NewReader(data), token)
		resp, _ := http.DefaultClient.Do(req)
		var cResp models.ItemCreateResponse
		_ = json.NewDecoder(resp.Body).Decode(&cResp)
		resp.Body.Close()

		delReq := authReq("DELETE", fmt.Sprintf("%s/api/items/%s", env.server.URL, cResp.ItemID), nil, token)
		delResp, _ := http.DefaultClient.Do(delReq)
		delResp.Body.Close()
	}

	// Empty trash
	emptyReq := authReq("DELETE", env.server.URL+"/api/items/trash/empty", nil, token)
	emptyResp, _ := http.DefaultClient.Do(emptyReq)
	if emptyResp.StatusCode != http.StatusNoContent {
		t.Fatalf("empty trash failed: %d", emptyResp.StatusCode)
	}
	emptyResp.Body.Close()

	// Verify trash is empty
	trashReq := authReq("GET", env.server.URL+"/api/items/trash", nil, token)
	trashResp, _ := http.DefaultClient.Do(trashReq)
	var trashList []models.ItemOut
	_ = json.NewDecoder(trashResp.Body).Decode(&trashList)
	trashResp.Body.Close()
	if len(trashList) != 0 {
		t.Fatalf("expected empty trash, got %d items", len(trashList))
	}
}

// 14. Test Cleanup Removes 30 Day Expired Trash Items
func TestCleanupRemoves30DayExpiredTrashItems(t *testing.T) {
	env := setupTest(t)
	_, token, _ := loginHelper(t, env.server)

	text := "old trash note"
	createBody := models.ItemCreate{Kind: "note", Note: &text}
	data, _ := json.Marshal(createBody)
	req := authReq("POST", env.server.URL+"/api/items", bytes.NewReader(data), token)
	resp, _ := http.DefaultClient.Do(req)
	var cResp models.ItemCreateResponse
	_ = json.NewDecoder(resp.Body).Decode(&cResp)
	resp.Body.Close()

	// Set deleted_at 31 days ago
	oldDeletedAt := time.Now().UTC().Add(-31 * 24 * time.Hour)
	_, _ = env.db.ExecContext(context.Background(), "UPDATE drop_items SET deleted_at = $1 WHERE id = $2", oldDeletedAt, cResp.ItemID.String())

	// Run cleanup
	env.cleanupWorker.TriggerCleanupNow(context.Background())

	var count int
	_ = env.db.QueryRowContext(context.Background(), "SELECT COUNT(*) FROM drop_items WHERE id = $1", cResp.ItemID.String()).Scan(&count)
	if count != 0 {
		t.Fatalf("expected 31-day trash item to be purged by cleanup, got count %d", count)
	}
}

// 15. Test Secret Timeline Flow
func TestSecretTimelineFlow(t *testing.T) {
	env := setupTest(t)
	_, token, _ := loginHelper(t, env.server)

	secretText := "secret confidential note"
	createBody := models.ItemCreate{Kind: "note", Note: &secretText, IsSecret: true}
	data, _ := json.Marshal(createBody)
	req := authReq("POST", env.server.URL+"/api/items", bytes.NewReader(data), token)
	resp, _ := http.DefaultClient.Do(req)
	resp.Body.Close()

	// Normal list (is_secret=false)
	normReq := authReq("GET", env.server.URL+"/api/items?is_secret=false", nil, token)
	normResp, _ := http.DefaultClient.Do(normReq)
	var normList models.ItemList
	_ = json.NewDecoder(normResp.Body).Decode(&normList)
	normResp.Body.Close()
	if len(normList.Items) != 0 {
		t.Fatalf("secret item should not appear in regular list")
	}

	// Secret list (is_secret=true)
	secReq := authReq("GET", env.server.URL+"/api/items?is_secret=true", nil, token)
	secResp, _ := http.DefaultClient.Do(secReq)
	var secList models.ItemList
	_ = json.NewDecoder(secResp.Body).Decode(&secList)
	secResp.Body.Close()
	if len(secList.Items) != 1 || !secList.Items[0].IsSecret {
		t.Fatalf("expected 1 secret item, got %d", len(secList.Items))
	}
}

// 16. Test Storage Check and Fix
func TestStorageCheckAndFix(t *testing.T) {
	env := setupTest(t)
	_, token, _ := loginHelper(t, env.server)

	// Create physical orphan file on disk
	orphanSHA := "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
	orphanPath := env.storage.GetFilePath(orphanSHA)
	_ = os.MkdirAll(filepath.Dir(orphanPath), 0755)
	_ = os.WriteFile(orphanPath, []byte("orphan content"), 0644)

	// Storage check
	checkReq := authReq("GET", env.server.URL+"/api/maintenance/storage-check", nil, token)
	checkResp, _ := http.DefaultClient.Do(checkReq)
	var checkResult models.StorageCheckResponse
	_ = json.NewDecoder(checkResp.Body).Decode(&checkResult)
	checkResp.Body.Close()

	if checkResult.Status != "issues_found" || len(checkResult.OrphanFiles) != 1 {
		t.Fatalf("expected 1 orphan file found, got status: %s, orphans: %d", checkResult.Status, len(checkResult.OrphanFiles))
	}

	// Storage fix
	fixReq := authReq("POST", env.server.URL+"/api/maintenance/storage-fix", nil, token)
	fixResp, _ := http.DefaultClient.Do(fixReq)
	var fixResult models.StorageFixResponse
	_ = json.NewDecoder(fixResp.Body).Decode(&fixResult)
	fixResp.Body.Close()

	if fixResult.DeletedOrphanFilesCount != 1 {
		t.Fatalf("expected 1 deleted orphan file, got %d", fixResult.DeletedOrphanFilesCount)
	}

	// Verify orphan file physically deleted
	if _, err := os.Stat(orphanPath); !os.IsNotExist(err) {
		t.Fatalf("expected orphan file to be deleted from disk")
	}
}

// 17. Test WS Invalid Token Closes With 4401
func TestWSInvalidTokenClosesWith4401(t *testing.T) {
	env := setupTest(t)

	wsURL := "ws" + strings.TrimPrefix(env.server.URL, "http") + "/api/ws?token=invalid-token"
	u, _ := url.Parse(wsURL)

	conn, resp, err := websocket.DefaultDialer.Dial(u.String(), nil)
	if err == nil {
		defer conn.Close()
		_, _, readErr := conn.ReadMessage()
		if closeErr, ok := readErr.(*websocket.CloseError); ok {
			if closeErr.Code != 4401 {
				t.Fatalf("expected close code 4401, got %d", closeErr.Code)
			}
		} else {
			t.Fatalf("expected websocket close error with 4401, got %v", readErr)
		}
	} else if resp != nil && resp.StatusCode != 101 {
		t.Fatalf("unexpected ws response: %v, status: %d", err, resp.StatusCode)
	}
}

// 18. Test Login Rate Limiting
func TestLoginRateLimiting(t *testing.T) {
	env := setupTest(t)

	for i := 1; i <= 5; i++ {
		body := models.LoginRequest{
			Password:   "wrong",
			DeviceID:   uuid.New(),
			DeviceName: "ratelimit",
		}
		data, _ := json.Marshal(body)
		resp, _ := http.Post(env.server.URL+"/api/auth/login", "application/json", bytes.NewReader(data))
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("expected 401 on attempt %d, got %d", i, resp.StatusCode)
		}
		resp.Body.Close()
	}

	// 6th attempt must be 429
	body := models.LoginRequest{
		Password:   "wrong",
		DeviceID:   uuid.New(),
		DeviceName: "ratelimit",
	}
	data, _ := json.Marshal(body)
	resp, _ := http.Post(env.server.URL+"/api/auth/login", "application/json", bytes.NewReader(data))
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("expected 429 on 6th attempt, got %d", resp.StatusCode)
	}
	resp.Body.Close()
}

// 19. Test Oversized Upload Stream Aborts Early
func TestOversizedUploadStreamAbortsEarly(t *testing.T) {
	env := setupTest(t)
	_, token, _ := loginHelper(t, env.server)

	// Create file spec with 10 bytes expected
	content := []byte("0123456789")
	contentSHA := storage.ChecksumSHA256(content)
	createBody := models.ItemCreate{
		Kind: "file",
		Files: []models.FileSpec{
			{
				FileName: "tiny.txt",
				MimeType: "text/plain",
				Size:     int64(len(content)),
				SHA256:   contentSHA,
			},
		},
	}
	createData, _ := json.Marshal(createBody)
	req := authReq("POST", env.server.URL+"/api/items", bytes.NewReader(createData), token)
	resp, _ := http.DefaultClient.Do(req)
	var cResp models.ItemCreateResponse
	_ = json.NewDecoder(resp.Body).Decode(&cResp)
	resp.Body.Close()

	// Stream 100 bytes (exceeding the 10 byte expectedSize)
	oversized := bytes.Repeat([]byte("A"), 100)
	uploadReq, _ := http.NewRequest("PUT", env.server.URL+cResp.Files[0].UploadURL, bytes.NewReader(oversized))
	uploadReq.Header.Set("Authorization", "Bearer "+token)
	upResp, err := http.DefaultClient.Do(uploadReq)
	if err != nil {
		t.Fatalf("upload request failed: %v", err)
	}
	if upResp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 Bad Request for oversized stream, got %d", upResp.StatusCode)
	}
	upResp.Body.Close()
}

// 20. Test Field Validation Limits
func TestFieldValidationLimits(t *testing.T) {
	env := setupTest(t)
	_, token, _ := loginHelper(t, env.server)

	// Note exceeding 100,000 chars
	giantNote := strings.Repeat("A", 100001)
	cBody := models.ItemCreate{
		Kind: "note",
		Note: &giantNote,
	}
	data, _ := json.Marshal(cBody)
	req := authReq("POST", env.server.URL+"/api/items", bytes.NewReader(data), token)
	resp, _ := http.DefaultClient.Do(req)
	if resp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 for note > 100,000 chars, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	// Device rename exceeding 255 chars
	giantName := strings.Repeat("B", 256)
	patchBody := models.DevicePatch{Name: giantName}
	pData, _ := json.Marshal(patchBody)
	pReq := authReq("PATCH", fmt.Sprintf("%s/api/devices/%s", env.server.URL, uuid.New()), bytes.NewReader(pData), token)
	pResp, _ := http.DefaultClient.Do(pReq)
	if pResp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 for device name > 255 chars, got %d", pResp.StatusCode)
	}
	pResp.Body.Close()
}

