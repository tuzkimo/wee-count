// backend/internal/handler/auth_test.go
package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"wee-count/backend/internal/model"
	"wee-count/backend/internal/service"
)

// fakeAuthService implements the handler's authService interface for tests
// that need to exercise the service-error mapping paths (e.g. enumeration).
type fakeAuthService struct {
	registerErr error
}

func (f fakeAuthService) Register(_ context.Context, _ model.RegisterRequest) (*model.AuthResponse, error) {
	return nil, f.registerErr
}

func (f fakeAuthService) Login(_ context.Context, _ model.LoginRequest) (*model.AuthResponse, error) {
	return nil, nil
}

func (f fakeAuthService) Refresh(_ context.Context, _ model.RefreshRequest) (*model.AuthResponse, error) {
	return nil, nil
}

func (f fakeAuthService) GetMe(_ context.Context, _ string) (*service.MeResponse, error) {
	return nil, nil
}

func (f fakeAuthService) UpdateProfile(_ context.Context, _ string, _ model.UpdateProfileRequest) (*model.User, error) {
	return nil, nil
}

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

func TestRegister_EnumerationResistant(t *testing.T) {
	h := &AuthHandler{svc: fakeAuthService{registerErr: service.ErrUsernameTaken}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /auth/register", h.Register)

	body, _ := json.Marshal(map[string]string{"username": "taken", "password": "secret"})
	req := httptest.NewRequest("POST", "/auth/register", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Errorf("expected 409, got %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "already") {
		t.Errorf("response leaks account existence: %s", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "username unavailable") {
		t.Errorf("expected generic message, got %s", rec.Body.String())
	}
}

func TestRegisterHandler_UsernameTooLong(t *testing.T) {
	h := &AuthHandler{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /auth/register", h.Register)

	body, _ := json.Marshal(map[string]string{
		"username": strings.Repeat("a", 101),
		"password": "secret",
	})
	req := httptest.NewRequest("POST", "/auth/register", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestRegisterHandler_NicknameTooLong(t *testing.T) {
	h := &AuthHandler{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /auth/register", h.Register)

	body, _ := json.Marshal(map[string]string{
		"username": "ok",
		"password": "secret",
		"nickname": strings.Repeat("n", 101),
	})
	req := httptest.NewRequest("POST", "/auth/register", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}