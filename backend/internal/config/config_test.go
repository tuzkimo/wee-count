// backend/internal/config/config_test.go
package config

import (
	"os"
	"strings"
	"testing"
	"time"
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

// setAIEnv 设置 AI 相关环境变量，测试结束自动还原。
// 用 t.Setenv（它自带还原），无需手工清理。
func setAIEnv(t *testing.T, kv map[string]string) {
	t.Helper()
	for k, v := range kv {
		t.Setenv(k, v)
	}
}

// 核心回归：不配 AI 的任何变量时，Load 必须成功且 AI 处于禁用态。
// 这条钉住规格 §6.2「AI_API_KEY 绝不能进 missing 必填校验」——
// 若有人把 AI_API_KEY 加进 missing，没配 AI 的自托管实例会起不来。
func TestLoad_AIKeyEmpty_DoesNotFail(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("REDIS_URL", "redis://x")
	t.Setenv("JWT_SECRET", "s")
	t.Setenv("AI_API_KEY", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("AI_API_KEY 为空时 Load 不应报错，实际: %v", err)
	}
	if cfg.AIEnabled() {
		t.Error("AI_API_KEY 为空时 AIEnabled() 应为 false")
	}
}

func TestLoad_AIDefaults(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("REDIS_URL", "redis://x")
	t.Setenv("JWT_SECRET", "s")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.AIBaseURL != "https://api.deepseek.com/v1" {
		t.Errorf("AIBaseURL 默认值错误: %q", cfg.AIBaseURL)
	}
	if cfg.AIModel != "deepseek-chat" {
		t.Errorf("AIModel 默认值错误: %q", cfg.AIModel)
	}
	if cfg.AIMaxTokens != 1024 {
		t.Errorf("AIMaxTokens 默认值错误: %d", cfg.AIMaxTokens)
	}
	if cfg.AITimeout != 60*time.Second {
		t.Errorf("AITimeout 默认值错误: %v", cfg.AITimeout)
	}
	if cfg.AIRateLimit != 20 {
		t.Errorf("AIRateLimit 默认值错误: %d", cfg.AIRateLimit)
	}
	if cfg.AIDailyLimit != 200 {
		t.Errorf("AIDailyLimit 默认值错误: %d", cfg.AIDailyLimit)
	}
}

func TestLoad_AIExplicit(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("REDIS_URL", "redis://x")
	t.Setenv("JWT_SECRET", "s")
	setAIEnv(t, map[string]string{
		"AI_API_KEY": "sk-test",
		// 双尾部斜杠：TrimRight 删全部、TrimSuffix 只删一个，只有两个斜杠才能区分这两者。
		"AI_BASE_URL": "https://api.moonshot.cn/v1//",
		"AI_MODEL":    "kimi-k2",
		// 前后空白：运维在 .env 里写 `AI_MAX_TOKENS= 2048` / `AI_TIMEOUT= 15s`
		// （等号后带空格）是真实场景，靠 getEnvInt/getEnvDuration 里的 TrimSpace 兜底。
		// 去掉 TrimSpace 后 Atoi(" 2048") / ParseDuration(" 15s") 都会报错并回落默认值。
		"AI_MAX_TOKENS":  " 2048",
		"AI_TIMEOUT":     " 15s",
		"AI_RATE_LIMIT":  "5",
		"AI_DAILY_LIMIT": "50",
	})

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !cfg.AIEnabled() {
		t.Error("配了 key 时 AIEnabled() 应为 true")
	}
	if cfg.AIBaseURL != "https://api.moonshot.cn/v1" {
		t.Errorf("AIBaseURL 末尾斜杠未被规范化: %q", cfg.AIBaseURL)
	}
	if cfg.AIModel != "kimi-k2" || cfg.AIMaxTokens != 2048 {
		t.Errorf("AI 显式值未生效: model=%q maxTokens=%d", cfg.AIModel, cfg.AIMaxTokens)
	}
	if cfg.AITimeout != 15*time.Second {
		t.Errorf("AITimeout 未生效: %v", cfg.AITimeout)
	}
	if cfg.AIRateLimit != 5 || cfg.AIDailyLimit != 50 {
		t.Errorf("配额未生效: rate=%d daily=%d", cfg.AIRateLimit, cfg.AIDailyLimit)
	}
}

// 配额与超时配错（非法、0、负数）时必须回落默认值，而不是变成 0：
// 超时配成 0 会让请求永不超时（goroutine 泄漏），配额配成 0 会让功能直接不可用。
func TestLoad_AIInvalidNumbersFallBack(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("REDIS_URL", "redis://x")
	t.Setenv("JWT_SECRET", "s")
	setAIEnv(t, map[string]string{
		"AI_MAX_TOKENS":  "abc",
		"AI_TIMEOUT":     "0s",
		"AI_RATE_LIMIT":  "-1",
		"AI_DAILY_LIMIT": "",
	})

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.AIMaxTokens != 1024 || cfg.AIRateLimit != 20 || cfg.AIDailyLimit != 200 {
		t.Errorf("非法值未回落默认: maxTokens=%d rate=%d daily=%d",
			cfg.AIMaxTokens, cfg.AIRateLimit, cfg.AIDailyLimit)
	}
	if cfg.AITimeout != 60*time.Second {
		t.Errorf("非法超时未回落默认: %v", cfg.AITimeout)
	}
}

// 【计划外补充】TestLoad_AIInvalidNumbersFallBack 的整数项取的是 "abc"（解析失败）、
// "-1"（负数）、""（空），三种都不等于 0——把 getEnvInt 的 `n <= 0` 放松成 `n < 0`
// 时那条用例仍然全绿，而计划「步骤 5」第 2 条变异要求它必须红。
// 这里补上缺失的 0：AI_MAX_TOKENS=0 会失去输出上限，AI_RATE_LIMIT=0 会让功能直接不可用。
func TestLoad_AIZeroIntsFallBack(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("REDIS_URL", "redis://x")
	t.Setenv("JWT_SECRET", "s")
	setAIEnv(t, map[string]string{
		"AI_MAX_TOKENS":  "0",
		"AI_RATE_LIMIT":  "0",
		"AI_DAILY_LIMIT": "0",
	})

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.AIMaxTokens != 1024 || cfg.AIRateLimit != 20 || cfg.AIDailyLimit != 200 {
		t.Errorf("整数 0 未回落默认: maxTokens=%d rate=%d daily=%d",
			cfg.AIMaxTokens, cfg.AIRateLimit, cfg.AIDailyLimit)
	}
}

// AIHost 是隐私说明卡要展示给用户的供应商域名（规格 §6.1/§7.3）：
// 用户有权知道自己的数据发往哪里，而这个值只能由后端给。
// 解析不出来时返回空串——客户端此时不得展示隐私卡、也不得允许开启（§7.3）。
func TestAIHost(t *testing.T) {
	cases := []struct {
		name     string
		baseURL  string
		wantHost string
	}{
		{"默认 DeepSeek", "https://api.deepseek.com/v1", "api.deepseek.com"},
		{"带端口", "http://127.0.0.1:8081/v1", "127.0.0.1:8081"},
		{"非 URL", "not a url", ""},
		{"空串", "", ""},
		// 「未闭合 IPv6」是这张表里唯一能让 url.Parse 真的返回 err != nil 的输入
		// （"not a url" 是合法的相对 URL 引用，err 为 nil、Host 为空）。
		// 关于 AIHost 里 `err != nil || u.Host == ""` 这个判断，事实是：
		// `u.Host == ""` 这半句在**输出**上不可观测——它触发时 u.Host 本来就是 ""，
		// 与走 err 分支的返回完全相同，所以删掉它任何用例都抓不住（不是覆盖不足）。
		// 真正承重的是 `err != nil`：它同时挡住 url.Parse 失败时返回的 nil *url.URL
		// 所造成的 nil 解引用；整段判断若被"简化"掉，下面的用例会 panic（唯一哨兵）。
		// 保留 `u.Host == ""` 只是表达意图：没有 host 就无法展示隐私说明卡（规格 §7.3）。
		{"url.Parse 真报错（未闭合 IPv6）", "http://[::1", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cfg := &Config{AIBaseURL: c.baseURL}
			if got := cfg.AIHost(); got != c.wantHost {
				t.Errorf("AIHost(%q) = %q, want %q", c.baseURL, got, c.wantHost)
			}
		})
	}
}

// ---- 部署配置守卫（规格 §6.2 / §6.7）----
//
// 这几条用例是**可执行的部署契约**。AI 不在 config.Load 的必填校验里（任务 1 已钉住），
// 但 compose 与 .env.example 写错，后果和把它写进必填校验一样难查：
// 没配 AI 的自托管实例起不来，或者 AI 静默失效而没人知道为什么。

// aiEnvVars 是 AI 的全部环境变量，与 config.go 的 Load() 逐一对应。
// 顺序与 .env.example / docker-compose.yml 的书写顺序一致，便于对照。
var aiEnvVars = []string{
	"AI_API_KEY", "AI_BASE_URL", "AI_MODEL",
	"AI_MAX_TOKENS", "AI_TIMEOUT", "AI_RATE_LIMIT", "AI_DAILY_LIMIT",
}

// apiServiceBlock 截出 docker-compose.yml 里 `api:` 服务的定义段。
// 守卫必须落在**这个服务的 environment 上**：文件里"某处出现过 ${AI_API_KEY:-}"
// 并不等于它被透传进了 api 容器——把行贴进 postgres 段，按整份文件做 Contains
// 照样是绿的，而容器里根本没有这个变量。
func apiServiceBlock(t *testing.T, text string) string {
	t.Helper()
	lines := strings.Split(text, "\n")
	start := -1
	for i, line := range lines {
		if line == "  api:" {
			start = i
			break
		}
	}
	if start < 0 {
		t.Fatal("docker-compose.yml 里找不到 `  api:` 服务定义（改了缩进就要同步改本测试）")
	}
	indent := func(s string) int { return len(s) - len(strings.TrimLeft(s, " ")) }
	for j := start + 1; j < len(lines); j++ {
		// api 服务的键缩进 4 空格（environment 的项 6 空格）。出现缩进 < 4 的非空行，
		// 说明已经进入下一个服务或顶层键，api 段到此为止。
		if strings.TrimSpace(lines[j]) != "" && indent(lines[j]) < 4 {
			return strings.Join(lines[start:j], "\n")
		}
	}
	return strings.Join(lines[start:], "\n")
}

// 规格 §6.2 的硬要求：docker-compose.yml 里 AI 变量必须用 ${VAR:-} 空默认。
// 写成 ${VAR:?}（未设置即报错）会让**所有没配 AI 的实例起不来**；
// 写死一个值则让部署时改不动该变量，AI_API_KEY 写死更是把密钥写进部署配置。
// 所以这条不能只写在文档里。
func TestCompose_AIVarsUseEmptyDefault(t *testing.T) {
	raw, err := os.ReadFile("../../docker-compose.yml")
	if err != nil {
		t.Fatalf("读取 docker-compose.yml 失败: %v", err)
	}
	text := strings.ReplaceAll(string(raw), "\r\n", "\n")
	api := apiServiceBlock(t, text)

	for _, v := range aiEnvVars {
		prefix := v + ":"
		found := false
		for _, line := range strings.Split(api, "\n") {
			line = strings.TrimSpace(line)
			// 注释行不算透传：只在注释里提变量名，容器里拿不到值。
			if strings.HasPrefix(line, "#") || !strings.HasPrefix(line, prefix) {
				continue
			}
			found = true
			value := strings.TrimSpace(strings.TrimPrefix(line, prefix))
			if strings.Contains(value, "${"+v+":?") {
				t.Errorf("%s 用了 ${%s:?}——未配置即启动失败，必须用 ${%s:-}；实际: %s",
					v, v, v, line)
				continue
			}
			if !strings.Contains(value, "${"+v+":-") {
				t.Errorf("api 服务的 %s 未使用 ${%s:-} 形式；实际: %s", v, v, line)
			}
		}
		if !found {
			t.Errorf("docker-compose.yml 的 api 服务 environment 里没有 %s 这一行（未透传）", v)
		}
	}
}

// .env.example 的 AI 段必须齐全，否则运维不知道有这些开关可配。
// 只在注释里提到变量名不算数——所以这里逐行找 `VAR=` 赋值行，而不是对整份文件做 Contains。
func TestEnvExample_AISectionPresent(t *testing.T) {
	raw, err := os.ReadFile("../../.env.example")
	if err != nil {
		t.Fatalf("读取 .env.example 失败: %v", err)
	}
	text := strings.ReplaceAll(string(raw), "\r\n", "\n")

	for _, v := range aiEnvVars {
		if !envExampleHasAssignment(text, v) {
			t.Errorf(".env.example 缺少 %s= 赋值行（只在注释里提到不算）", v)
		}
	}
}

// AI_API_KEY 必须留空：它是唯一开关，填了样例值会让人以为"必须填"，
// 更糟的是模板里出现形似密钥的串，会被误当成真 key 提交。
func TestEnvExample_AIKeyIsEmpty(t *testing.T) {
	raw, err := os.ReadFile("../../.env.example")
	if err != nil {
		t.Fatalf("读取 .env.example 失败: %v", err)
	}
	text := strings.ReplaceAll(string(raw), "\r\n", "\n")

	found := false
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "#") || !strings.HasPrefix(line, "AI_API_KEY=") {
			continue
		}
		found = true
		if got := strings.TrimSpace(strings.TrimPrefix(line, "AI_API_KEY=")); got != "" {
			t.Errorf("AI_API_KEY 在 .env.example 里必须留空，实际: %q", got)
		}
	}
	// 没有赋值行时上面循环一次都不执行。不钉住这一点，把整段 AI 配置删掉后这条用例
	// 依然"绿"——只要注释里还留着 AI_API_KEY 这几个字。
	if !found {
		t.Error(".env.example 里没有 AI_API_KEY= 赋值行（只在注释里提到不算）")
	}
}

// envExampleHasAssignment 报告 .env.example 里是否存在生效的 `VAR=` 赋值行（注释行不算）。
func envExampleHasAssignment(text, name string) bool {
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, name+"=") {
			return true
		}
	}
	return false
}
