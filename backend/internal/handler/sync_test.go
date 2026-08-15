package handler

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSyncHandler_NoAuth(t *testing.T) {
	h := &SyncHandler{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /sync", h.Sync)

	req := httptest.NewRequest("POST", "/sync", bytes.NewBufferString("{}"))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestSyncHandler_InvalidBody(t *testing.T) {
	h := &SyncHandler{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /sync", h.Sync)

	req := httptest.NewRequest("POST", "/sync", bytes.NewBufferString("bad json"))
	req.Header.Set("Content-Type", "application/json")
	// Inject userID into context to bypass auth middleware
	req = req.WithContext(setUserID(req.Context(), "test-user"))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestSyncHandler_BodyTooLarge(t *testing.T) {
	orig := maxSyncBodyBytes
	maxSyncBodyBytes = 16
	defer func() { maxSyncBodyBytes = orig }()

	h := &SyncHandler{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /sync", h.Sync)

	// 合法 JSON，但超过 16 字节上限，触发 MaxBytesReader → decode 失败 → 400
	body := `{"local_changes":{"ledgers":[]}}`
	req := httptest.NewRequest("POST", "/sync", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(setUserID(req.Context(), "test-user"))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for oversized body, got %d", rec.Code)
	}
}
