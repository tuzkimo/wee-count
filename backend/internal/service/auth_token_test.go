package service

import (
	"context"
	"testing"

	"github.com/golang-jwt/jwt/v5"

	"wee-count/backend/internal/model"
)

func TestGenerateTokensSetsTypClaim(t *testing.T) {
	s := &AuthService{jwtSecret: []byte("test-secret")}
	access, refresh, err := s.generateTokens("user-1")
	if err != nil {
		t.Fatalf("generateTokens: %v", err)
	}

	if typ := parseTokenClaims(t, s, access)["typ"]; typ != "access" {
		t.Errorf("access token typ 应为 access，got %v", typ)
	}
	if typ := parseTokenClaims(t, s, refresh)["typ"]; typ != "refresh" {
		t.Errorf("refresh token typ 应为 refresh，got %v", typ)
	}
}

func TestRefreshRejectsAccessToken(t *testing.T) {
	s := &AuthService{jwtSecret: []byte("test-secret")}
	access, _, err := s.generateTokens("user-1")
	if err != nil {
		t.Fatalf("generateTokens: %v", err)
	}

	// access token 不能当 refresh token 用：应在查询用户前就被拒绝（pool 为 nil 也不会 panic）
	if _, err := s.Refresh(context.Background(), model.RefreshRequest{RefreshToken: access}); err != ErrInvalidToken {
		t.Fatalf("access token 应被拒绝，got err=%v", err)
	}
}

func parseTokenClaims(t *testing.T, s *AuthService, tokenStr string) jwt.MapClaims {
	t.Helper()
	token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (any, error) {
		return s.jwtSecret, nil
	})
	if err != nil || !token.Valid {
		t.Fatalf("parse token: %v", err)
	}
	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		t.Fatalf("claims type mismatch")
	}
	return claims
}
