package handler

import (
	"bytes"
	"encoding/json"
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

// 规格 §8.D：请求体超 256KB → **413**（不是 400）。
// 现有 sync.go 把超限当 400，AI 这里必须区分出来。
func TestAIHandler_Chat_BodyTooLarge(t *testing.T) {
	h := newAIHandlerForTest(t, "http://127.0.0.1:1", "sk-test")
	mux := http.NewServeMux()
	mux.HandleFunc("POST /ai/chat", h.Chat)

	big := `{"messages":[{"role":"user","content":"` + strings.Repeat("x", 300<<10) + `"}]}`
	req := httptest.NewRequest("POST", "/ai/chat", bytes.NewBufferString(big))
	req = req.WithContext(setUserID(req.Context(), "u1"))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("expected 413, got %d", rec.Code)
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
