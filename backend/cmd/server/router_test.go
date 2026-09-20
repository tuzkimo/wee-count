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

// 未带 token 的请求必须被 AuthMiddleware 拦在 401，且不占用任何人的额度。
func TestRouter_AIChatRequiresAuth(t *testing.T) {
	r := newTestRouter(t, 1, 100)
	if rec := postChat(r, ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("无 token: got %d, want 401", rec.Code)
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
