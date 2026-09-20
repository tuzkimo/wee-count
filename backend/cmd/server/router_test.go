package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"wee-count/backend/internal/config"
	"wee-count/backend/internal/handler"
	"wee-count/backend/internal/service"
)

const testJWTSecret = "test-secret"

// mintAccessToken 造一个 access token（与 middleware.AuthMiddleware 的校验口径一致）。
func mintAccessToken(t *testing.T, userID string) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": userID,
		"typ": "access",
	})
	s, err := tok.SignedString([]byte(testJWTSecret))
	if err != nil {
		t.Fatalf("签名失败: %v", err)
	}
	return s
}

// mintRefreshToken 造一个 refresh token（typ=refresh）：AuthMiddleware 必须拒绝它访问受保护路由。
func mintRefreshToken(t *testing.T, userID string) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": userID,
		"typ": "refresh",
	})
	s, err := tok.SignedString([]byte(testJWTSecret))
	if err != nil {
		t.Fatalf("签名失败: %v", err)
	}
	return s
}

func newTestRouter(t *testing.T, rateLimit, dailyLimit int) http.Handler {
	t.Helper()
	cfg := &config.Config{
		JWTSecret: testJWTSecret,
		// AI 未配置 key：路由与限流都还在，只有 Chat 会返回 503。
		AIRateLimit:  rateLimit,
		AIDailyLimit: dailyLimit,
		AITimeout:    time.Second,
		AIBaseURL:    "https://api.deepseek.com/v1",
		AIModel:      "deepseek-chat",
		AIMaxTokens:  16,
	}
	return newRouter(cfg, handlers{
		ai: handler.NewAIHandler(service.NewAIService(cfg)),
	})
}

func postChat(h http.Handler, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", "/api/v1/ai/chat",
		bytes.NewBufferString(`{"messages":[{"role":"user","content":"hi"}]}`))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// ★ 规格 §8.D 的头号测试：限流 key 必须是 userID，不是空串。
// 若 httprate 注册在 AuthMiddleware **之前**，GetUserID 永远返回 ""，
// 所有用户共用一个桶——A 打满额度会把 B 一起挡住。这条用例就是钉这个。
func TestRouter_AIRateLimitIsPerUser(t *testing.T) {
	r := newTestRouter(t, 2, 100)
	tokenA := mintAccessToken(t, "user-a")
	tokenB := mintAccessToken(t, "user-b")

	// A 用满自己的额度（AI 未配置，返回 503，但限流计数照记）
	for i := 0; i < 2; i++ {
		if rec := postChat(r, tokenA); rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("A 第 %d 次请求: got %d, want 503", i+1, rec.Code)
		}
	}
	// A 第 3 次被限流
	if rec := postChat(r, tokenA); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("A 超限后: got %d, want 429", rec.Code)
	}
	if body := postChat(r, tokenA).Body.String(); !bytes.Contains([]byte(body), []byte("ai_rate_limited")) {
		t.Errorf("超限响应体应是 ai_rate_limited；实际: %s", body)
	}

	// ★ B 必须不受影响。若这条红了，说明限流跑在 auth 之前（共用空串桶）。
	rec := postChat(r, tokenB)
	if rec.Code == http.StatusTooManyRequests {
		t.Fatal("B 被 A 的额度挡住了：限流 key 不是 userID——" +
			"检查 newRouter 里 httprate 是否注册在 AuthMiddleware 之后")
	}
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("B 首次请求: got %d, want 503", rec.Code)
	}
}

// 日配额（规格 §6.3/§6.6）：`AIDailyLimit` 用尽时必须是 ai_quota_exceeded（429），
// 而不是 ai_rate_limited —— 两者客户端文案不同（"今日 AI 次数已用完" vs "请求太频繁"），
// 混了用户就不知道该等一会儿还是明天再来。
// 分钟级额度故意给到 100（远大于请求数），保证这条只由日配额说话。
func TestRouter_AIDailyQuotaIsPerUser(t *testing.T) {
	r := newTestRouter(t, 100, 1)
	tokenA := mintAccessToken(t, "user-a")

	// 第 1 次：日配额还没用完，AI 未配置 → 503
	if rec := postChat(r, tokenA); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("A 第 1 次请求: got %d, want 503", rec.Code)
	}
	// 第 2 次：日配额用尽
	rec := postChat(r, tokenA)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("A 超出日配额后: got %d, want 429", rec.Code)
	}
	body := rec.Body.String()
	if !bytes.Contains([]byte(body), []byte("ai_quota_exceeded")) {
		t.Errorf("响应体应是 ai_quota_exceeded；实际: %s", body)
	}
	// 明确排除分钟级错误码：两条限流的文案与行动建议不同，不能混。
	if bytes.Contains([]byte(body), []byte("ai_rate_limited")) {
		t.Errorf("日配额用尽被报成了 ai_rate_limited（分钟级限流抢答）；实际: %s", body)
	}

	// ★ 日配额的 key 同样必须是 userID：A 用完当天的额度不该影响 B。
	recB := postChat(r, mintAccessToken(t, "user-b"))
	if recB.Code == http.StatusTooManyRequests {
		t.Fatal("B 被 A 的日配额挡住了：日配额限流 key 不是 userID")
	}
	if recB.Code != http.StatusServiceUnavailable {
		t.Errorf("B 首次请求: got %d, want 503", recB.Code)
	}
}

// refresh token（typ=refresh）不得访问受保护路由。
// **这条断言响应体而不是仅状态码**：handler 自身的 userID 兜底也返回 401，
// 只有 "invalid token type" 才能唯一证明 AuthMiddleware 真的挂在链上
// （实测只删 AuthMiddleware 而保留路由时，仅断言 401 的用例仍然全绿）。
func TestRouter_AIChatRejectsRefreshToken(t *testing.T) {
	r := newTestRouter(t, 1, 100)
	rec := postChat(r, mintRefreshToken(t, "user-a"))

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("refresh token 访问 AI 路由: got %d, want 401", rec.Code)
	}
	if body := rec.Body.String(); !bytes.Contains([]byte(body), []byte("invalid token type")) {
		t.Errorf("响应体应含 invalid token type（证明 AuthMiddleware 在链上）；实际: %s", body)
	}
}

// /ai/status 在未配置 key 时也必须可访问（返回 enabled:false），
// 客户端靠它决定 tab 显隐——返回 503/404 会让前端无法区分"没开"和"坏了"。
func TestRouter_AIStatusAlwaysReachable(t *testing.T) {
	r := newTestRouter(t, 100, 100)
	req := httptest.NewRequest("GET", "/api/v1/ai/status", nil)
	req.Header.Set("Authorization", "Bearer "+mintAccessToken(t, "user-a"))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("got %d, want 200", rec.Code)
	}
	if body := rec.Body.String(); !bytes.Contains([]byte(body), []byte(`"enabled":false`)) {
		t.Errorf("未配置 key 时 enabled 应为 false；实际: %s", body)
	}
}
