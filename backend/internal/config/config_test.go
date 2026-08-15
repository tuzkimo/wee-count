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
	os.Setenv("REDIS_PASSWORD", "secret-pass")
	os.Setenv("JWT_SECRET", "test-secret")
	os.Setenv("PORT", "9090")
	os.Unsetenv("CORS_ALLOWED_ORIGINS")
	defer os.Unsetenv("DATABASE_URL")
	defer os.Unsetenv("REDIS_URL")
	defer os.Unsetenv("REDIS_PASSWORD")
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
	if cfg.RedisPassword != "secret-pass" {
		t.Errorf("unexpected RedisPassword: %s", cfg.RedisPassword)
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

func TestLoadRedisPasswordOptional(t *testing.T) {
	os.Setenv("DATABASE_URL", "postgres://test:test@localhost/test")
	os.Setenv("REDIS_URL", "localhost:6379")
	os.Setenv("JWT_SECRET", "test-secret")
	os.Unsetenv("REDIS_PASSWORD")
	defer os.Unsetenv("DATABASE_URL")
	defer os.Unsetenv("REDIS_URL")
	defer os.Unsetenv("JWT_SECRET")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.RedisPassword != "" {
		t.Errorf("expected empty RedisPassword, got %q", cfg.RedisPassword)
	}
}

// TrustProxy 是「默认关闭、显式开启」的安全开关：默认不信任反向代理（按 socket peer 限流），
// 仅在显式设置 TRUST_PROXY 时信任 X-Forwarded-For，否则直连场景可被 header 伪造绕过限流。
func TestLoadTrustProxyDefaultsToFalse(t *testing.T) {
	os.Setenv("DATABASE_URL", "postgres://test:test@localhost/test")
	os.Setenv("REDIS_URL", "localhost:6379")
	os.Setenv("JWT_SECRET", "test-secret")
	os.Unsetenv("TRUST_PROXY")
	defer os.Unsetenv("DATABASE_URL")
	defer os.Unsetenv("REDIS_URL")
	defer os.Unsetenv("JWT_SECRET")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.TrustProxy {
		t.Error("expected TrustProxy to default to false")
	}
}

func TestLoadTrustProxyFromEnv(t *testing.T) {
	os.Setenv("DATABASE_URL", "postgres://test:test@localhost/test")
	os.Setenv("REDIS_URL", "localhost:6379")
	os.Setenv("JWT_SECRET", "test-secret")
	os.Setenv("TRUST_PROXY", "true")
	defer os.Unsetenv("DATABASE_URL")
	defer os.Unsetenv("REDIS_URL")
	defer os.Unsetenv("JWT_SECRET")
	defer os.Unsetenv("TRUST_PROXY")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !cfg.TrustProxy {
		t.Error("expected TrustProxy to be true when TRUST_PROXY=true")
	}
}
