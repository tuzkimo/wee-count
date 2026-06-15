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
