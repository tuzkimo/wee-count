package service

import (
	"context"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"wee-count/backend/internal/config"
)

// fakeUpstreamRecorder 记录假上游收到的请求，供断言"到底发了什么过去"。
type fakeUpstreamRecorder struct {
	mu    sync.Mutex
	calls int
	path  string
	auth  string
	body  []byte
}

func (r *fakeUpstreamRecorder) snapshot() (int, string, string, string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.calls, r.path, r.auth, string(r.body)
}

// newFakeUpstream 起一个假上游：固定返回 status + body，并记录请求。
func newFakeUpstream(t *testing.T, status int, body string) (*httptest.Server, *fakeUpstreamRecorder) {
	t.Helper()
	rec := &fakeUpstreamRecorder{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		rec.mu.Lock()
		rec.calls++
		rec.path = r.URL.Path
		rec.auth = r.Header.Get("Authorization")
		rec.body = raw
		rec.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv, rec
}

func newTestAIService(t *testing.T, baseURL string, timeout time.Duration) *AIService {
	t.Helper()
	return NewAIService(&config.Config{
		AIAPIKey:    "sk-test",
		AIBaseURL:   baseURL,
		AIModel:     "test-model",
		AIMaxTokens: 256,
		AITimeout:   timeout,
	})
}

// 归一化：上游文字回复 → 客户端契约。tool_calls 必须是 [] 而不是 null。
func TestAIService_Chat_TextOnly(t *testing.T) {
	srv, _ := newFakeUpstream(t, 200, `{
		"choices":[{"message":{"role":"assistant","content":"你好"},"finish_reason":"stop"}],
		"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}
	}`)
	svc := newTestAIService(t, srv.URL, 5*time.Second)

	got, err := svc.Chat(context.Background(), AIChatRequest{
		Messages: []AIMessage{{Role: "user", Content: "hi"}},
	})
	if err != nil {
		t.Fatalf("Chat: %v", err)
	}
	if got.Text != "你好" {
		t.Errorf("Text = %q, want 你好", got.Text)
	}
	if got.FinishReason != "stop" {
		t.Errorf("FinishReason = %q, want stop", got.FinishReason)
	}
	if got.Usage.PromptTokens != 10 || got.Usage.CompletionTokens != 2 || got.Usage.TotalTokens != 12 {
		t.Errorf("Usage 解析错误: %+v", got.Usage)
	}
	// 这条是形状契约：客户端会直接 .map 它，null 会炸
	if got.ToolCalls == nil {
		t.Error("ToolCalls 必须是空数组而不是 nil——JSON 序列化成 null 会让客户端遍历时炸")
	}
	if len(got.ToolCalls) != 0 {
		t.Errorf("ToolCalls 应为空: %+v", got.ToolCalls)
	}
}

// 归一化：tool_calls 原样穿过，且落在客户端契约的字段名上。
func TestAIService_Chat_ToolCalls(t *testing.T) {
	srv, _ := newFakeUpstream(t, 200, `{
		"choices":[{"message":{"role":"assistant","content":"",
			"tool_calls":[{"id":"call_1","type":"function",
				"function":{"name":"query_transactions","arguments":"{\"aggregate\":\"sum\"}"}}]},
			"finish_reason":"tool_calls"}],
		"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}
	}`)
	svc := newTestAIService(t, srv.URL, 5*time.Second)

	got, err := svc.Chat(context.Background(), AIChatRequest{
		Messages: []AIMessage{{Role: "user", Content: "今年花了多少"}},
	})
	if err != nil {
		t.Fatalf("Chat: %v", err)
	}
	if len(got.ToolCalls) != 1 {
		t.Fatalf("ToolCalls 长度 = %d, want 1", len(got.ToolCalls))
	}
	tc := got.ToolCalls[0]
	if tc.ID != "call_1" || tc.Type != "function" ||
		tc.Function.Name != "query_transactions" ||
		tc.Function.Arguments != `{"aggregate":"sum"}` {
		t.Errorf("tool_call 归一化错误: %+v", tc)
	}
	if got.FinishReason != "tool_calls" {
		t.Errorf("FinishReason = %q, want tool_calls", got.FinishReason)
	}
}

// 请求侧：key 只以 Authorization 头发给上游，且 model / max_tokens 用的是配置值。
func TestAIService_Chat_SendsConfiguredPayload(t *testing.T) {
	srv, rec := newFakeUpstream(t, 200, `{"choices":[{"message":{"content":"x"},"finish_reason":"stop"}]}`)
	svc := newTestAIService(t, srv.URL, 5*time.Second)

	_, err := svc.Chat(context.Background(), AIChatRequest{
		Messages: []AIMessage{{Role: "user", Content: "hi"}},
		Tools:    []byte(`[{"type":"function","function":{"name":"t"}}]`),
	})
	if err != nil {
		t.Fatalf("Chat: %v", err)
	}
	calls, path, auth, body := rec.snapshot()
	if calls != 1 {
		t.Fatalf("上游应被调用 1 次，实际 %d", calls)
	}
	if path != "/chat/completions" {
		t.Errorf("上游路径 = %q, want /chat/completions（baseURL 拼接错误）", path)
	}
	if auth != "Bearer sk-test" {
		t.Errorf("Authorization = %q, want Bearer sk-test", auth)
	}
	for _, want := range []string{`"model":"test-model"`, `"max_tokens":256`, `"name":"t"`} {
		if !strings.Contains(body, want) {
			t.Errorf("上游请求体缺少 %s；实际: %s", want, body)
		}
	}
	// 请求体里绝不能出现 key 本身（它只该在 Authorization 头里）
	if strings.Contains(body, "sk-test") {
		t.Errorf("key 出现在请求体里: %s", body)
	}
}

// 错误映射（规格 §6.6）+ 上游原文一律不下发。
func TestAIService_Chat_UpstreamErrorMapping(t *testing.T) {
	cases := []struct {
		name     string
		upstream int
		wantCode string
	}{
		{"401 key 无效", 401, AICodeUpstreamAuth},
		{"403 无权限", 403, AICodeUpstreamAuth},
		{"429 上游限流", 429, AICodeRateLimited},
		{"500 上游故障", 500, AICodeUpstreamTimeout},
		{"503 上游故障", 503, AICodeUpstreamTimeout},
		{"400 参数错（规格未列，但必须有确定映射）", 400, AICodeUpstreamError},
		{"404 模型名写错", 404, AICodeUpstreamError},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			// 上游错误体里塞一个哨兵串，断言它不出现在我们返回的错误里
			srv, _ := newFakeUpstream(t, c.upstream,
				`{"error":{"message":"SENTINEL-UPSTREAM-ORIGINAL","type":"x"}}`)
			svc := newTestAIService(t, srv.URL, 5*time.Second)

			_, err := svc.Chat(context.Background(), AIChatRequest{
				Messages: []AIMessage{{Role: "user", Content: "hi"}},
			})
			if err == nil {
				t.Fatal("上游非 200 时应返回错误")
			}
			var aiErr *AIError
			if !errors.As(err, &aiErr) {
				t.Fatalf("错误类型应为 *AIError，实际 %T", err)
			}
			if aiErr.Code != c.wantCode {
				t.Errorf("Code = %q, want %q", aiErr.Code, c.wantCode)
			}
			if aiErr.Upstream != c.upstream {
				t.Errorf("Upstream = %d, want %d", aiErr.Upstream, c.upstream)
			}
			if strings.Contains(err.Error(), "SENTINEL-UPSTREAM-ORIGINAL") {
				t.Errorf("上游原文泄漏进了错误信息: %v", err)
			}
		})
	}
}

// 3xx 不是成功。这个分支在真实上游上是**可达的**：Go 的 http.Client 对
// 3xx 且**不带 Location** 的响应会原样交回调用方（golang/go#17773 记录过这种现象），
// 304 同样不会被跟随。所以"只有 200 算成功"必须由实现自己保证，不能指望 client 消化掉。
// 这里的 3xx body 故意写成一份**合法的 completion**：
// 若实现把 3xx 当成功放行，本用例会因为拿到正常响应而在第一句就红。
func TestAIService_Chat_RedirectIsNotSuccess(t *testing.T) {
	srv, _ := newFakeUpstream(t, http.StatusFound, `{
		"choices":[{"message":{"content":"不该被接受"},"finish_reason":"stop"}],
		"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}
	}`)
	svc := newTestAIService(t, srv.URL, 5*time.Second)

	got, err := svc.Chat(context.Background(), AIChatRequest{
		Messages: []AIMessage{{Role: "user", Content: "hi"}},
	})
	if err == nil {
		t.Fatalf("3xx 不得当作成功，实际返回: %+v", got)
	}
	var aiErr *AIError
	if !errors.As(err, &aiErr) {
		t.Fatalf("错误类型应为 *AIError，实际 %T", err)
	}
	if aiErr.Code != AICodeUpstreamError {
		t.Errorf("Code = %q, want %q", aiErr.Code, AICodeUpstreamError)
	}
	if aiErr.Upstream != http.StatusFound {
		t.Errorf("Upstream = %d, want %d", aiErr.Upstream, http.StatusFound)
	}
}

// 超时：必须映射成 ai_upstream_timeout（客户端文案是"分析超时，请重试"）。
func TestAIService_Chat_Timeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
		w.WriteHeader(200)
	}))
	t.Cleanup(srv.Close)
	svc := newTestAIService(t, srv.URL, 50*time.Millisecond)

	_, err := svc.Chat(context.Background(), AIChatRequest{
		Messages: []AIMessage{{Role: "user", Content: "hi"}},
	})
	assertAICode(t, err, AICodeUpstreamTimeout)
}

// 超时判定有两条路径（计划全局约束）：errors.Is(err, context.DeadlineExceeded) 与 net.Error.Timeout()。
// 关键事实（实测，见下）：http.Client.Timeout 与 net.Dialer.Timeout 触发的超时**同时**满足两条 ——
// net/http 的 timeoutError 与 net 的 timeoutError 都显式实现了
// `Is(err) bool { return err == context.DeadlineExceeded }`（client.go:2642 / net.go:622），
// 而 *url.Error 又把 Timeout() 委托给内层。
// 所以 TestAIService_Chat_Timeout 只跑其中一种输入时，**删掉任意一条分支它都仍是绿的** ——
// 那条用例无法区分两条路径。真正只有 net.Error 这条路径能救的输入是 TLS 握手超时：
// 默认 http.Transport 的 TLSHandshakeTimeout=10s，过期时返回
// *url.Error{Err: http.tlsHandshakeTimeoutError}，它 Timeout()==true 但没有 Is 方法，
// 因此 errors.Is(err, context.DeadlineExceeded)==false。
// AIService 用的正是默认 Transport，且默认 AI_BASE_URL 是 https，所以这条路径生产上可达；
// 缺了它，一次卡住的 TLS 握手会从"分析超时"退化成"AI 服务不可达"——客户端文案不同。
//
// 这里不经过 AIService 的 client：TLSHandshakeTimeout 是 Transport 的固定字段（默认 10s），
// 没有注入口，真跑一次要 10 秒。因此用一个同类型、短超时的 client 造出**真实**的错误值，
// 再喂给映射函数（探针实测：1ms 与默认 10s 拿到的都是同一个 http.tlsHandshakeTimeoutError）。
func TestAIService_MapTransportError_TLSHandshakeTimeout(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	var mu sync.Mutex
	var conns []net.Conn
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			// 只接受连接、既不复读也不回 ServerHello，制造握手停滞
			mu.Lock()
			conns = append(conns, conn)
			mu.Unlock()
		}
	}()
	t.Cleanup(func() {
		_ = ln.Close()
		mu.Lock()
		defer mu.Unlock()
		for _, c := range conns {
			_ = c.Close()
		}
	})

	client := &http.Client{Transport: &http.Transport{TLSHandshakeTimeout: time.Millisecond}}
	_, reqErr := client.Post("https://"+ln.Addr().String()+"/v1/chat/completions", "application/json", nil)
	if reqErr == nil {
		t.Fatal("握手停滞时应报错")
	}
	// 先钉住这条输入的前提，否则本用例什么都证明不了：
	// 它必须满足 net.Error.Timeout()，且**不**满足 errors.Is(DeadlineExceeded)。
	var netErr net.Error
	if !errors.As(reqErr, &netErr) || !netErr.Timeout() {
		t.Fatalf("前提不成立：该错误不是 Timeout() 的 net.Error: %v", reqErr)
	}
	if errors.Is(reqErr, context.DeadlineExceeded) {
		t.Fatalf("前提不成立：该错误同时满足 errors.Is(DeadlineExceeded)，无法区分两条路径: %v", reqErr)
	}

	assertAICode(t, mapTransportError(reqErr), AICodeUpstreamTimeout)
}

// 网络不可达：必须映射成 ai_unreachable，不能和超时混为一谈
// （两者客户端文案不同，混了用户就不知道该重试还是找管理员）。
func TestAIService_Chat_Unreachable(t *testing.T) {
	srv, _ := newFakeUpstream(t, 200, `{}`)
	url := srv.URL
	srv.Close() // 立刻关掉，制造 connection refused
	svc := newTestAIService(t, url, 5*time.Second)

	_, err := svc.Chat(context.Background(), AIChatRequest{
		Messages: []AIMessage{{Role: "user", Content: "hi"}},
	})
	assertAICode(t, err, AICodeUnreachable)
}

// 200 但 body 里没有 choices：不能 panic，也不能返回空响应当成功。
func TestAIService_Chat_NoChoices(t *testing.T) {
	srv, _ := newFakeUpstream(t, 200, `{"choices":[]}`)
	svc := newTestAIService(t, srv.URL, 5*time.Second)

	_, err := svc.Chat(context.Background(), AIChatRequest{
		Messages: []AIMessage{{Role: "user", Content: "hi"}},
	})
	assertAICode(t, err, AICodeUpstreamError)
}

// 规格 §6.4：从上游最多读 1MB（maxUpstreamBodyBytes）。上游异常时完全可能返回巨型 body，
// 不设限就等于把内存交给对方。这条用例的判别力来自**截断**，不是"大小"本身：
// 假上游返回一份**合法但 2MB** 的 completion，两种实现的落点分别是——
// 有 LimitReader：读到 1MB 就断，JSON 中途截断 ⇒ json 解析失败 ⇒ ai_upstream_error（现在绿）；
// 删掉 LimitReader：整份 2MB 都能解出来 ⇒ 我们返回成功（本条红）。
// 两条路径的差别是"报错 vs 成功"，不是错误码不同，所以第一断言必须落在 err == nil 上。
func TestAIService_Chat_UpstreamBodyTooLarge(t *testing.T) {
	// 2MB 的合法 completion：text 本身就超过 1MB 上限。
	body := `{"choices":[{"message":{"content":"` + strings.Repeat("x", 2<<20) +
		`"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`
	// 先钉住前提：这份响应**确实**超过上限，否则本用例什么都证明不了。
	if int64(len(body)) <= maxUpstreamBodyBytes {
		t.Fatalf("前提不成立：假上游响应只有 %d 字节，未超过上限 %d", len(body), maxUpstreamBodyBytes)
	}
	srv, _ := newFakeUpstream(t, 200, body)
	svc := newTestAIService(t, srv.URL, 5*time.Second)

	got, err := svc.Chat(context.Background(), AIChatRequest{
		Messages: []AIMessage{{Role: "user", Content: "hi"}},
	})
	if err == nil {
		t.Fatalf("上游响应 %d 字节（超过上限 %d）时必须报错，实际成功解出 %d 字节文本",
			len(body), maxUpstreamBodyBytes, len(got.Text))
	}
	assertAICode(t, err, AICodeUpstreamError)
}

// key 为空 = 功能禁用（规格 §6.2）：连一个字节都不该发出去。
func TestAIService_Chat_DisabledSendsNothing(t *testing.T) {
	srv, rec := newFakeUpstream(t, 200, `{}`)
	svc := NewAIService(&config.Config{
		AIAPIKey: "", AIBaseURL: srv.URL, AIModel: "m", AIMaxTokens: 1, AITimeout: time.Second,
	})

	_, err := svc.Chat(context.Background(), AIChatRequest{
		Messages: []AIMessage{{Role: "user", Content: "hi"}},
	})
	assertAICode(t, err, AICodeDisabled)
	if calls, _, _, _ := rec.snapshot(); calls != 0 {
		t.Errorf("禁用时不应发起任何上游请求，实际 %d 次", calls)
	}
}

// 规格 §6.5：记用量，**不记内容**。
// 聊天内容里有"盒马""工资""还房贷"，工具结果里有金额——进日志就等于账目脱离了用户手里那份数据库。
func TestAIService_Chat_LogsUsageNotContent(t *testing.T) {
	srv, _ := newFakeUpstream(t, 200, `{
		"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],
		"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}
	}`)
	svc := newTestAIService(t, srv.URL, 5*time.Second)

	var buf strings.Builder
	orig := log.Writer()
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(orig) })

	const sentinel = "SENTINEL-账目-盒马-12345"
	if _, err := svc.Chat(context.Background(), AIChatRequest{
		Messages: []AIMessage{{Role: "user", Content: sentinel}},
	}); err != nil {
		t.Fatalf("Chat: %v", err)
	}

	out := buf.String()
	if strings.Contains(out, sentinel) {
		t.Errorf("日志里出现了聊天内容: %s", out)
	}
	for _, want := range []string{"prompt_tokens=7", "completion_tokens=3", "finish_reason=stop"} {
		if !strings.Contains(out, want) {
			t.Errorf("日志缺少用量字段 %s；实际: %s", want, out)
		}
	}
}

// ---- 测试辅助 ----

func assertAICode(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil {
		t.Fatalf("应返回错误（期望 code=%s），实际 nil", want)
	}
	var aiErr *AIError
	if !errors.As(err, &aiErr) {
		t.Fatalf("错误类型应为 *AIError，实际 %T", err)
	}
	if aiErr.Code != want {
		t.Errorf("Code = %q, want %q", aiErr.Code, want)
	}
}
