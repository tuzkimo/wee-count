// backend/internal/config/config.go
package config

import (
	"fmt"
	"os"
	"strings"
)

type Config struct {
	DatabaseURL        string
	RedisURL           string
	RedisPassword      string
	JWTSecret          string
	Port               string
	CORSAllowedOrigins []string
	TrustProxy         bool
}

// defaultCORSOrigins 覆盖开发期与 Android 正式包的来源：
// - http://tauri.localhost：Tauri 2 Android（及 Windows 桌面）webview 的 Origin
// - http://localhost:1420：Vite dev server，浏览器/桌面调试用
var defaultCORSOrigins = []string{"http://tauri.localhost", "http://localhost:1420"}

func Load() (*Config, error) {
	cfg := &Config{
		DatabaseURL:        getEnv("DATABASE_URL", ""),
		RedisURL:           getEnv("REDIS_URL", ""),
		RedisPassword:      getEnv("REDIS_PASSWORD", ""),
		JWTSecret:          getEnv("JWT_SECRET", ""),
		Port:               getEnv("PORT", "8080"),
		CORSAllowedOrigins: parseCORSOrigins(os.Getenv("CORS_ALLOWED_ORIGINS")),
		TrustProxy:         getEnvBool("TRUST_PROXY", false),
	}

	missing := []string{}
	if cfg.DatabaseURL == "" {
		missing = append(missing, "DATABASE_URL")
	}
	if cfg.RedisURL == "" {
		missing = append(missing, "REDIS_URL")
	}
	if cfg.JWTSecret == "" {
		missing = append(missing, "JWT_SECRET")
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("missing required environment variables: %v", missing)
	}

	return cfg, nil
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// getEnvBool 解析布尔环境变量："1"/"true"/"yes"/"on"（大小写不敏感）为真，其余为假。
// 空值回落到 fallback。用于 TRUST_PROXY 这类「默认关闭、显式开启」的安全开关。
func getEnvBool(key string, fallback bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	switch strings.ToLower(v) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

// parseCORSOrigins 解析逗号分隔的 CORS_ALLOWED_ORIGINS；为空时回落到默认集合。
// Origin 必须含 scheme（如 http://tauri.localhost），go-chi/cors 按完整字符串精确匹配。
func parseCORSOrigins(raw string) []string {
	if raw == "" {
		return defaultCORSOrigins
	}
	parts := strings.Split(raw, ",")
	origins := make([]string, 0, len(parts))
	for _, p := range parts {
		if o := strings.TrimSpace(p); o != "" {
			origins = append(origins, o)
		}
	}
	if len(origins) == 0 {
		return defaultCORSOrigins
	}
	return origins
}
