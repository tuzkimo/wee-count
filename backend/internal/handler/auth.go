// backend/internal/handler/auth.go
package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"wee-count/backend/internal/middleware"
	"wee-count/backend/internal/model"
	"wee-count/backend/internal/service"
)

type authService interface {
	Register(ctx context.Context, req model.RegisterRequest) (*model.AuthResponse, error)
	Login(ctx context.Context, req model.LoginRequest) (*model.AuthResponse, error)
	Refresh(ctx context.Context, req model.RefreshRequest) (*model.AuthResponse, error)
	GetMe(ctx context.Context, userID string) (*service.MeResponse, error)
}

type AuthHandler struct {
	svc authService
}

func NewAuthHandler(svc *service.AuthService) *AuthHandler {
	return &AuthHandler{svc: svc}
}

func (h *AuthHandler) Register(w http.ResponseWriter, r *http.Request) {
	var req model.RegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Email == "" || req.Password == "" || req.Nickname == "" {
		writeError(w, http.StatusBadRequest, "email, password, and nickname are required")
		return
	}

	resp, err := h.svc.Register(r.Context(), req)
	if errors.Is(err, service.ErrEmailTaken) {
		writeError(w, http.StatusConflict, "email already registered")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	writeJSON(w, http.StatusCreated, resp)
}

func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	var req model.LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Email == "" || req.Password == "" {
		writeError(w, http.StatusBadRequest, "email and password are required")
		return
	}

	resp, err := h.svc.Login(r.Context(), req)
	if errors.Is(err, service.ErrInvalidLogin) {
		writeError(w, http.StatusUnauthorized, "invalid email or password")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	writeJSON(w, http.StatusOK, resp)
}

func (h *AuthHandler) Refresh(w http.ResponseWriter, r *http.Request) {
	var req model.RefreshRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.RefreshToken == "" {
		writeError(w, http.StatusBadRequest, "refresh_token is required")
		return
	}

	resp, err := h.svc.Refresh(r.Context(), req)
	if errors.Is(err, service.ErrInvalidToken) || errors.Is(err, service.ErrUserNotFound) {
		writeError(w, http.StatusUnauthorized, "invalid or expired refresh token")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	writeJSON(w, http.StatusOK, resp)
}

func (h *AuthHandler) Me(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	resp, err := h.svc.GetMe(r.Context(), userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	writeJSON(w, http.StatusOK, resp)
}

// Mock for testing
type mockAuthService struct{}

func (m *mockAuthService) Register(ctx context.Context, req model.RegisterRequest) (*model.AuthResponse, error) {
	return &model.AuthResponse{
		User:         model.User{ID: "mock-id", Nickname: req.Nickname, Email: req.Email},
		AccessToken:  "mock-access", RefreshToken: "mock-refresh",
	}, nil
}
func (m *mockAuthService) Login(ctx context.Context, req model.LoginRequest) (*model.AuthResponse, error) {
	return &model.AuthResponse{
		User:         model.User{ID: "mock-id", Email: req.Email},
		AccessToken:  "mock-access", RefreshToken: "mock-refresh",
	}, nil
}
func (m *mockAuthService) Refresh(ctx context.Context, req model.RefreshRequest) (*model.AuthResponse, error) {
	return &model.AuthResponse{
		User:         model.User{ID: "mock-id"},
		AccessToken:  "mock-access", RefreshToken: "mock-refresh",
	}, nil
}
func (m *mockAuthService) GetMe(ctx context.Context, userID string) (*service.MeResponse, error) {
	return &service.MeResponse{
		User:    model.User{ID: userID, Nickname: "Mock", Email: "mock@test.com"},
		Ledgers: []model.Ledger{},
		Teams:   []model.Ledger{},
	}, nil
}

// setUserID injects userID into context for testing
func setUserID(ctx context.Context, userID string) context.Context {
	return context.WithValue(ctx, middleware.UserIDKey, userID)
}
