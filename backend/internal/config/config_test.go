// backend/internal/config/config_test.go
package config

import (
	"os"
	"testing"
)

func TestLoadDefaults(t *testing.T) {
	os.Unsetenv("DATABASE_URL")
	os.Unsetenv("REDIS_URL")
	os.Unsetenv("JWT_SECRET")
	os.Unsetenv("PORT")
	os.Unsetenv("CORS_ALLOWED_ORIGINS")

	_, err := Load()

	// 敏感配置不再提供默认值，缺少时必须返回错误
	if err == nil {
		t.Error("expected error when required env vars are missing")
	}
}

func TestLoadFromEnv(t *testing.T) {
	os.Setenv("DATABASE_URL", "postgres://test:test@localhost/test")
	os.Setenv("REDIS_URL", "localhost:6379")
	os.Setenv("JWT_SECRET", "test-secret")
	os.Setenv("PORT", "9090")
	os.Unsetenv("CORS_ALLOWED_ORIGINS")
	defer os.Unsetenv("DATABASE_URL")
	defer os.Unsetenv("REDIS_URL")
	defer os.Unsetenv("JWT_SECRET")
	defer os.Unsetenv("PORT")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if cfg.DatabaseURL != "postgres://test:test@localhost/test" {
		t.Errorf("unexpected DATABASE_URL: %s", cfg.DatabaseURL)
	}
	if cfg.Port != "9090" {
		t.Errorf("unexpected Port: %s", cfg.Port)
	}
	// 未设置 CORS_ALLOWED_ORIGINS 时回落到默认集合
	if len(cfg.CORSAllowedOrigins) != 2 ||
		cfg.CORSAllowedOrigins[0] != "http://tauri.localhost" ||
		cfg.CORSAllowedOrigins[1] != "http://localhost:1420" {
		t.Errorf("unexpected default CORS origins: %v", cfg.CORSAllowedOrigins)
	}
}

func TestLoadCORSFromEnv(t *testing.T) {
	os.Setenv("DATABASE_URL", "postgres://test:test@localhost/test")
	os.Setenv("REDIS_URL", "localhost:6379")
	os.Setenv("JWT_SECRET", "test-secret")
	os.Setenv("CORS_ALLOWED_ORIGINS", "http://tauri.localhost, https://app.example.com")
	defer os.Unsetenv("DATABASE_URL")
	defer os.Unsetenv("REDIS_URL")
	defer os.Unsetenv("JWT_SECRET")
	defer os.Unsetenv("CORS_ALLOWED_ORIGINS")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	want := []string{"http://tauri.localhost", "https://app.example.com"}
	if len(cfg.CORSAllowedOrigins) != len(want) {
		t.Fatalf("unexpected CORS origins length: got %v want %v", cfg.CORSAllowedOrigins, want)
	}
	for i, o := range want {
		if cfg.CORSAllowedOrigins[i] != o {
			t.Errorf("unexpected CORS origin[%d]: got %q want %q", i, cfg.CORSAllowedOrigins[i], o)
		}
	}
}
