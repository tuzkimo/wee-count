// backend/internal/handler/team_test.go
package handler

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCreateTeamHandler_MissingName(t *testing.T) {
	h := &TeamHandler{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /teams", h.Create)

	req := httptest.NewRequest("POST", "/teams", bytes.NewBufferString(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(setUserID(req.Context(), "test-user"))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestJoinHandler_MissingCode(t *testing.T) {
	h := &TeamHandler{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /teams/join", h.Join)

	req := httptest.NewRequest("POST", "/teams/join", bytes.NewBufferString(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(setUserID(req.Context(), "test-user"))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}
