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
	// Retry-After 是**窗口长度本身**（httprate limiter.go:106 写的是
	// int(windowLength.Seconds())，不是"距重置的秒数"）⇒ 24h 窗口恒为 "86400"，
	// 不受窗口对齐影响、不抖动；分钟级那条是 "60"，区分力足够。
	// 没有这条断言，把日配额窗口误写成 time.Minute 不会有任何用例会响。
	if got := rec.Header().Get("Retry-After"); got != "86400" {
		t.Errorf("日配额超限的 Retry-After = %q, want %q（日配额窗口必须是 24h）", got, "86400")
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

// 两条限流**同时**超限时，用户看到的必须是分钟级那条（`ai_rate_limited`）。
// 这条钉的是「**外层是分钟级**」这个顺序决定本身，不是笼统的"限流优先级"：
// 两条都设 1 制造"同时超限"，第二次的响应体只由外层决定——
// 把 router.go 里那两条 r.Use 对调后，只有这条会红。
//
// 为什么外层必须是分钟级（而不是文案更"有行动指向"的日配额）：
// httprate 只给**放行的**请求计数（limiter.go:102-110 超限直接 return，
// IncrementBy 只在放行路径上），而外层先判、外层先计数 ⇒ 外层会对每个它放行的
// 请求记账，不管内层接下来会不会拒绝。若日配额在外层，一个重试循环会被分钟级
// 全部拒掉、一次 AI 都没调用，却把当天额度耗尽 ⇒ 用户 24 小时用不了，什么都没得到。
func TestRouter_AIRateLimitIsOuter(t *testing.T) {
	r := newTestRouter(t, 1, 1)
	tokenA := mintAccessToken(t, "user-a")

	if rec := postChat(r, tokenA); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("A 第 1 次请求: got %d, want 503", rec.Code)
	}
	// 第 2 次：两条都超了 ⇒ 必须由外层（分钟级）说话
	rec := postChat(r, tokenA)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("A 第 2 次请求: got %d, want 429", rec.Code)
	}
	if body := rec.Body.String(); !bytes.Contains([]byte(body), []byte("ai_rate_limited")) {
		t.Errorf("两条同时超限时应报外层（分钟级）ai_rate_limited；实际: %s", body)
	}
}

// /ai/status 是廉价的本地响应（不发上游），**不得消耗日配额**：
// M3 客户端要用它决定是否展示隐私卡。若它吃日配额，客户端一次前台探测、
// 或只是一个轮询 bug，就能在没有任何 AI 调用的情况下把当天额度耗光 ⇒ 功能直接不可用。
// 这里 daily=1 制造最紧的条件：status 连打两次都必须 200，且其后的第一次 chat
// 必须还能走到 handler（503），第二次才轮到日配额 429。
func TestRouter_AIStatusDoesNotConsumeDailyQuota(t *testing.T) {
	r := newTestRouter(t, 100, 1)
	tokenA := mintAccessToken(t, "user-a")

	getStatus := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "/api/v1/ai/status", nil)
		req.Header.Set("Authorization", "Bearer "+tokenA)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec
	}

	for i := 0; i < 2; i++ {
		if rec := getStatus(); rec.Code != http.StatusOK {
			t.Fatalf("第 %d 次 /ai/status: got %d, want 200（status 不该吃日配额）", i+1, rec.Code)
		}
	}

	// 日配额应当完好：第一次 chat 正常走到 handler（AI 未配置 ⇒ 503）
	if rec := postChat(r, tokenA); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status 之后的第 1 次 chat: got %d, want 503（日配额被 status 吃掉了？）", rec.Code)
	}
	// 第二次 chat 才是日配额用尽
	rec := postChat(r, tokenA)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("第 2 次 chat: got %d, want 429", rec.Code)
	}
	if body := rec.Body.String(); !bytes.Contains([]byte(body), []byte("ai_quota_exceeded")) {
		t.Errorf("第 2 次 chat 响应体应是 ai_quota_exceeded；实际: %s", body)
	}
}

// **分钟级限流器只有一份**：/ai/chat 与 /ai/status 共用同一个"每用户每分钟"桶。
// 因果：第 3 个请求必须落在**同一个**桶里才会被拒——两次 status 已把 limit=2 的桶用满，
// 紧接着的 chat 因此必须被分钟级拒掉（429 ai_rate_limited）。
//
// 本条拦的是"**放宽**"，措辞收窄到这一点：给某个端点**新增**中间件永远不可能放宽
// 已受约束的量——另加一个**不同实例**的桶只会更严（链里仍然有那个共享实例，实测全绿），
// 把**同一个实例**嵌套两次更是收紧到额度减半（每请求记 2 次，实测红）。
// 所以放宽只有一种实现方式：让某条 /ai/* 的链**失去共享实例**，即把两个端点改成
// **兄弟**组各持一份桶——那正是本用例要拦的情况（chat 会落进它自己的空桶、
// 被放行到 handler → 503，而不是 429）。
func TestRouter_AIMinuteLimitIsSharedAcrossEndpoints(t *testing.T) {
	r := newTestRouter(t, 2, 100) // 分钟级 2、日配额 100，让日配额不干扰
	tokenA := mintAccessToken(t, "user-a")

	getStatus := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "/api/v1/ai/status", nil)
		req.Header.Set("Authorization", "Bearer "+tokenA)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec
	}

	// 两次 status 把分钟桶用满（limit=2）
	for i := 0; i < 2; i++ {
		if rec := getStatus(); rec.Code != http.StatusOK {
			t.Fatalf("第 %d 次 /ai/status: got %d, want 200（分钟级额度应为 2，桶应被用满）", i+1, rec.Code)
		}
	}

	// 第 3 个请求换成另一个端点：必须撞在同一个桶上
	rec := postChat(r, tokenA)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("桶已满后的 chat: got %d, want 429——两个端点各有一个分钟桶？"+
			"分钟级限流器必须只有一份（否则 /ai/* 每分钟总量静默翻倍）", rec.Code)
	}
	if body := rec.Body.String(); !bytes.Contains([]byte(body), []byte("ai_rate_limited")) {
		t.Errorf("桶已满后的 chat 响应体应是分钟级 ai_rate_limited；实际: %s", body)
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
