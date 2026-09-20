// backend/internal/config/config.go
package config

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	DatabaseURL        string
	RedisURL           string
	RedisPassword      string
	JWTSecret          string
	Port               string
	CORSAllowedOrigins []string
	TrustProxy         bool

	// AI 相关配置。全部可选：AIAPIKey 为空即整个 AI 功能禁用（唯一开关），
	// 因此这些字段绝不参与下面的 missing 必填校验——不配 AI 也必须能启动（规格 §6.2）。
	AIAPIKey     string
	AIBaseURL    string
	AIModel      string
	AIMaxTokens  int
	AITimeout    time.Duration
	AIRateLimit  int
	AIDailyLimit int
}

const (
	defaultAIBaseURL    = "https://api.deepseek.com/v1"
	defaultAIModel      = "deepseek-chat"
	defaultAIMaxTokens  = 1024
	defaultAITimeout    = 60 * time.Second
	defaultAIRateLimit  = 20
	defaultAIDailyLimit = 200
)

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

		// AI 可选配置：空值走默认（规格 §6.2）。末尾斜杠在此规范化，
		// 使 service 端可以安全地用 baseURL + "/chat/completions" 拼接。
		AIAPIKey:     getEnv("AI_API_KEY", ""),
		AIBaseURL:    strings.TrimRight(getEnv("AI_BASE_URL", defaultAIBaseURL), "/"),
		AIModel:      getEnv("AI_MODEL", defaultAIModel),
		AIMaxTokens:  getEnvInt("AI_MAX_TOKENS", defaultAIMaxTokens),
		AITimeout:    getEnvDuration("AI_TIMEOUT", defaultAITimeout),
		AIRateLimit:  getEnvInt("AI_RATE_LIMIT", defaultAIRateLimit),
		AIDailyLimit: getEnvInt("AI_DAILY_LIMIT", defaultAIDailyLimit),
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

// getEnvInt 解析整数环境变量。空值、非法值、非正数一律回落 fallback：
// 这些值是配额与上限，配成 0 或负数会让功能不可用或失去上限保护，
// 静默回落比启动失败更合适——AI 是可选功能，不该因为它起不来。
func getEnvInt(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil || n <= 0 {
		return fallback
	}
	return n
}

// getEnvDuration 同 getEnvInt：非法值与非正值回落 fallback。
// 超时配成 0 会让 http.Client 永不超时，半死上游会挂住 goroutine（规格 §6.4）。
func getEnvDuration(key string, fallback time.Duration) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	d, err := time.ParseDuration(strings.TrimSpace(v))
	if err != nil || d <= 0 {
		return fallback
	}
	return d
}

// AIEnabled 报告 AI 功能是否配置可用。AI_API_KEY 是唯一开关（规格 §6.2）。
func (c *Config) AIEnabled() bool { return c.AIAPIKey != "" }

// AIHost 从 AI_BASE_URL 解析出供应商域名，用于 /ai/status 回给客户端展示。
// 这是隐私说明卡里要告诉用户"数据发往哪里"的值（规格 §6.1/§7.3），只能由后端给。
// 解析失败返回空串——客户端此时不得展示隐私卡、也不得允许开启（§7.3）。
func (c *Config) AIHost() string {
	u, err := url.Parse(c.AIBaseURL)
	if err != nil || u.Host == "" {
		return ""
	}
	return u.Host
}
