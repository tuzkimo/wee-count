// backend/internal/handler/auth_test.go
package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRegisterHandler_InvalidJSON(t *testing.T) {
	h := &AuthHandler{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /auth/register", h.Register)

	req := httptest.NewRequest("POST", "/auth/register", bytes.NewBufferString("not json"))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestRegisterHandler_MissingFields(t *testing.T) {
	h := &AuthHandler{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /auth/register", h.Register)

	body, _ := json.Marshal(map[string]string{"username": "testuser"})
	req := httptest.NewRequest("POST", "/auth/register", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestLoginHandler_MissingFields(t *testing.T) {
	h := &AuthHandler{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /auth/login", h.Login)

	body, _ := json.Marshal(map[string]string{"username": "testuser"})
	req := httptest.NewRequest("POST", "/auth/login", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestRefreshHandler_MissingToken(t *testing.T) {
	h := &AuthHandler{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /auth/refresh", h.Refresh)

	body, _ := json.Marshal(map[string]string{})
	req := httptest.NewRequest("POST", "/auth/refresh", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}