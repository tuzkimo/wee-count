package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"wee-count/backend/internal/config"
	"wee-count/backend/internal/service"
)

// newAIHandlerForTest 造一个指向假上游的 AIHandler。
func newAIHandlerForTest(t *testing.T, upstreamURL, apiKey string) *AIHandler {
	t.Helper()
	return NewAIHandler(service.NewAIService(&config.Config{
		AIAPIKey: apiKey, AIBaseURL: upstreamURL, AIModel: "m", AIMaxTokens: 8, AITimeout: 2 * time.Second,
	}))
}

func newFakeUpstreamForHandler(t *testing.T, status int, body string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv
}

// 正常转发：归一化后的响应落到客户端契约上。
func TestAIHandler_Chat_OK(t *testing.T) {
	up := newFakeUpstreamForHandler(t, 200,
		`{"choices":[{"message":{"content":"好的"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
	h := newAIHandlerForTest(t, up.URL, "sk-test")

	mux := http.NewServeMux()
	mux.HandleFunc("POST /ai/chat", h.Chat)
	req := httptest.NewRequest("POST", "/ai/chat",
		bytes.NewBufferString(`{"messages":[{"role":"user","content":"hi"}]}`))
	req = req.WithContext(setUserID(req.Context(), "u1"))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	var got service.AIChatResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("响应不是合法 JSON: %v", err)
	}
	if got.Text != "好的" {
		t.Errorf("text = %q", got.Text)
	}
}

// 未认证（ctx 里没有 userID）→ 401。
func TestAIHandler_Chat_NoAuth(t *testing.T) {
	h := newAIHandlerForTest(t, "http://127.0.0.1:1", "sk-test")
	mux := http.NewServeMux()
	mux.HandleFunc("POST /ai/chat", h.Chat)

	req := httptest.NewRequest("POST", "/ai/chat", bytes.NewBufferString(`{"messages":[]}`))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

// 规格 §8.D：请求体超上限 → **413**（不是 400）。
// 现有 sync.go 把超限当 400，AI 这里必须区分出来。
// M4 §5.3 把上限从 256KB 放宽到 4 MiB，所以这里的 body 也必须跟着长到 4 MiB 以上
// ——否则它变成一条"超限"的假断言（300KB 在新上限下是合法请求，会拿到 502）。
func TestAIHandler_Chat_BodyTooLarge(t *testing.T) {
	h := newAIHandlerForTest(t, "http://127.0.0.1:1", "sk-test")
	mux := http.NewServeMux()
	mux.HandleFunc("POST /ai/chat", h.Chat)

	big := `{"messages":[{"role":"user","content":"` + strings.Repeat("x", 4<<20) + `"}]}`
	req := httptest.NewRequest("POST", "/ai/chat", bytes.NewBufferString(big))
	req = req.WithContext(setUserID(req.Context(), "u1"))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("expected 413, got %d", rec.Code)
	}
}

// 规格 §5.3：M4 把上限放宽到 4 MiB。这条把**数值本身**钉住——改回 256KB（或任何
// 放不下 1.37 MiB base64 单图的值）都会红。没有它，"1.5 MiB 的带图请求不被拒"
// 还可以靠"上限恰好是别的更大值"侥幸通过。
func TestAIHandler_Chat_BodyLimitIsFourMiB(t *testing.T) {
	if want := int64(4 << 20); maxAIBodyBytes != want {
		t.Errorf("maxAIBodyBytes = %d, want %d（规格 §5.3：单图压缩后 ≤ 1 MiB ⇒ base64 ≈ 1.37 MiB，"+
			"上限必须放宽到 4 MiB，否则每一条带图请求都会被打成 413）", maxAIBodyBytes, want)
	}
}

// 规格 §5.3 的**理由**：一张 1.5 MiB 的 base64 图（≈1.1 MiB 原图，正好在 1 MiB 上限附近）
// 必须能过 body 闸门。断言落到 502 而不是"非 413"：502 = 请求已经穿过 handler 走到
// service 的外联那一步（假上游地址不可达），证明它**没有**在上限这一层被拒。
// 上限还是 256KB 时这条必红（413）。
func TestAIHandler_Chat_ImageSizedBodyIsNotRejected(t *testing.T) {
	h := newAIHandlerForTest(t, "http://127.0.0.1:1", "sk-test")
	mux := http.NewServeMux()
	mux.HandleFunc("POST /ai/chat", h.Chat)

	img := strings.Repeat("A", 1500<<10) // 1.5 MiB base64（块数组形态，M4 的真实形状）
	body := `{"messages":[{"role":"user","content":[{"type":"text","text":"算餐饮"},` +
		`{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,` + img + `"}}]}]}`
	req := httptest.NewRequest("POST", "/ai/chat", bytes.NewBufferString(body))
	req = req.WithContext(setUserID(req.Context(), "u1"))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code == http.StatusRequestEntityTooLarge {
		t.Fatalf("1.5 MiB 的带图请求被 body 上限拒了（413）——上限没有按规格 §5.3 放宽到 4 MiB")
	}
	if rec.Code != http.StatusBadGateway {
		t.Errorf("带图请求应穿过 body 闸门走到外联那一步（502 ai_unreachable），实际 %d；响应体: %s",
			rec.Code, rec.Body.String())
	}
}

// 非法 JSON → 400。
func TestAIHandler_Chat_InvalidJSON(t *testing.T) {
	h := newAIHandlerForTest(t, "http://127.0.0.1:1", "sk-test")
	mux := http.NewServeMux()
	mux.HandleFunc("POST /ai/chat", h.Chat)

	req := httptest.NewRequest("POST", "/ai/chat", bytes.NewBufferString("not json"))
	req = req.WithContext(setUserID(req.Context(), "u1"))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

// messages 为空 → 400（没有消息的对话没有意义，不该转发给上游）。
func TestAIHandler_Chat_EmptyMessages(t *testing.T) {
	h := newAIHandlerForTest(t, "http://127.0.0.1:1", "sk-test")
	mux := http.NewServeMux()
	mux.HandleFunc("POST /ai/chat", h.Chat)

	req := httptest.NewRequest("POST", "/ai/chat", bytes.NewBufferString(`{"messages":[]}`))
	req = req.WithContext(setUserID(req.Context(), "u1"))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

// 错误码 → HTTP 状态码的映射（规格 §6.6），并且响应体里只有 code、没有上游原文。
func TestAIHandler_Chat_ErrorStatusMapping(t *testing.T) {
	cases := []struct {
		name       string
		upstream   int
		wantStatus int
		wantCode   string
	}{
		{"key 无效", 401, http.StatusBadGateway, "ai_upstream_auth"},
		{"上游限流", 429, http.StatusTooManyRequests, "ai_rate_limited"},
		{"上游故障", 500, http.StatusGatewayTimeout, "ai_upstream_timeout"},
		{"未列出的 4xx", 400, http.StatusBadGateway, "ai_upstream_error"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			up := newFakeUpstreamForHandler(t, c.upstream, `{"error":{"message":"SENTINEL-UPSTREAM"}}`)
			h := newAIHandlerForTest(t, up.URL, "sk-test")
			mux := http.NewServeMux()
			mux.HandleFunc("POST /ai/chat", h.Chat)

			req := httptest.NewRequest("POST", "/ai/chat",
				bytes.NewBufferString(`{"messages":[{"role":"user","content":"hi"}]}`))
			req = req.WithContext(setUserID(req.Context(), "u1"))
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)

			if rec.Code != c.wantStatus {
				t.Errorf("status = %d, want %d", rec.Code, c.wantStatus)
			}
			if !strings.Contains(rec.Body.String(), c.wantCode) {
				t.Errorf("响应体应含错误码 %s；实际: %s", c.wantCode, rec.Body.String())
			}
			if strings.Contains(rec.Body.String(), "SENTINEL-UPSTREAM") {
				t.Errorf("上游原文泄漏进响应体: %s", rec.Body.String())
			}
		})
	}
}

// key 未配置 → 503（规格 §6.6：不是 404，404 会让客户端以为是路由错误）。
func TestAIHandler_Chat_Disabled(t *testing.T) {
	h := newAIHandlerForTest(t, "http://127.0.0.1:1", "")
	mux := http.NewServeMux()
	mux.HandleFunc("POST /ai/chat", h.Chat)

	req := httptest.NewRequest("POST", "/ai/chat",
		bytes.NewBufferString(`{"messages":[{"role":"user","content":"hi"}]}`))
	req = req.WithContext(setUserID(req.Context(), "u1"))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "ai_disabled") {
		t.Errorf("响应体应含 ai_disabled；实际: %s", rec.Body.String())
	}
}

// /ai/status：不含 key，host 来自 AI_BASE_URL（规格 §6.1）。
func TestAIHandler_Status(t *testing.T) {
	h := NewAIHandler(service.NewAIService(&config.Config{
		AIAPIKey: "sk-secret", AIBaseURL: "https://api.deepseek.com/v1",
		AIModel: "deepseek-chat", AIMaxTokens: 1024, AITimeout: time.Second,
	}))
	mux := http.NewServeMux()
	mux.HandleFunc("GET /ai/status", h.Status)

	req := httptest.NewRequest("GET", "/ai/status", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var got service.AIStatus
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("响应不是合法 JSON: %v", err)
	}
	if !got.Enabled || got.Model != "deepseek-chat" || got.Host != "api.deepseek.com" {
		t.Errorf("status 内容错误: %+v", got)
	}
	if strings.Contains(rec.Body.String(), "sk-secret") {
		t.Error("**key 泄漏进了 /ai/status 响应**")
	}
}

// aiErrorStatus 的错误码 → HTTP 状态映射（规格 §6.6），7 个码全部过一遍。
// 直接对包级函数做表驱动、不走 HTTP：这样每个分支都有覆盖，尤其是 ai_quota_exceeded
// —— 它由限流中间件产出、正常路径到不了 handler，若没有专门分支就会掉进 default
// 被映成 502 ai_unreachable（"服务不可用"是错的文案，用户该看到"今日次数已用完"）。
func TestAIErrorStatus(t *testing.T) {
	cases := []struct {
		name       string
		err        error
		wantCode   string
		wantStatus int
	}{
		{"未配置 key", &service.AIError{Code: service.AICodeDisabled}, service.AICodeDisabled, http.StatusServiceUnavailable},
		{"不可达", &service.AIError{Code: service.AICodeUnreachable}, service.AICodeUnreachable, http.StatusBadGateway},
		{"上游鉴权失败", &service.AIError{Code: service.AICodeUpstreamAuth, Upstream: 401}, service.AICodeUpstreamAuth, http.StatusBadGateway},
		{"上游超时", &service.AIError{Code: service.AICodeUpstreamTimeout}, service.AICodeUpstreamTimeout, http.StatusGatewayTimeout},
		{"上游其它错误", &service.AIError{Code: service.AICodeUpstreamError, Upstream: 400}, service.AICodeUpstreamError, http.StatusBadGateway},
		{"分钟级限流", &service.AIError{Code: service.AICodeRateLimited}, service.AICodeRateLimited, http.StatusTooManyRequests},
		{"日配额用尽", &service.AIError{Code: service.AICodeQuotaExceeded}, service.AICodeQuotaExceeded, http.StatusTooManyRequests},
		{"未知错误码", &service.AIError{Code: "ai_bogus"}, service.AICodeUnreachable, http.StatusBadGateway},
		{"非 AIError", errors.New("boom"), service.AICodeUnreachable, http.StatusBadGateway},
		// 被包装的 *AIError 也必须认出来（errors.As 而非类型断言）：
		// service 侧一旦改成 fmt.Errorf("...: %w") 包装，这条就会响。
		{"被包装的 AIError", fmt.Errorf("wrap: %w", &service.AIError{Code: service.AICodeQuotaExceeded}),
			service.AICodeQuotaExceeded, http.StatusTooManyRequests},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			code, status := aiErrorStatus(c.err)
			if code != c.wantCode || status != c.wantStatus {
				t.Errorf("aiErrorStatus(%v) = (%q, %d), want (%q, %d)",
					c.err, code, status, c.wantCode, c.wantStatus)
			}
		})
	}
}
