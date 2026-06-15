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

	cfg := Load()

	if cfg.DatabaseURL != "postgres://wee:wee@localhost:5432/wee-count?sslmode=disable" {
		t.Errorf("unexpected DATABASE_URL: %s", cfg.DatabaseURL)
	}
	if cfg.Port != "8080" {
		t.Errorf("unexpected Port: %s", cfg.Port)
	}
}

func TestLoadFromEnv(t *testing.T) {
	os.Setenv("DATABASE_URL", "postgres://test:test@localhost/test")
	os.Setenv("PORT", "9090")
	defer os.Unsetenv("DATABASE_URL")
	defer os.Unsetenv("PORT")

	cfg := Load()

	if cfg.DatabaseURL != "postgres://test:test@localhost/test" {
		t.Errorf("unexpected DATABASE_URL: %s", cfg.DatabaseURL)
	}
	if cfg.Port != "9090" {
		t.Errorf("unexpected Port: %s", cfg.Port)
	}
}
