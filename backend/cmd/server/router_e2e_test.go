// backend/cmd/server/router_e2e_test.go
//
// 这个文件补的是终审实测出来的**两个结构洞**（终审实验 A/B1）：
//
//  1. **全绿路径零覆盖**：`router_test.go` 的 `newTestRouter` 手写 Config 且 `AIAPIKey` 留空，
//     于是经过真实路由的 `/ai/chat` **永远**停在 `service/ai.go` 的 `Enabled()` 提前返回 503，
//     `router_test.go` 全文三处 `StatusOK` 全是 `/ai/status` —— `/ai/chat` 一次 200 都没有。
//     协议转发、归一化、超时那一段在**路由链上**从未被执行过。
//  2. **配置层 ↔ 路由层没有联合用例**：所有路由用例吃的都是手写 Config 字面量，从不经过
//     `config.Load()`。实测把 `config.go` 的 `AI_API_KEY` 默认值改坏 ⇒ `cmd/server` 的 7 条
//     路由用例**全绿**，只有 1 条 config 用例红。
//
// 所以本文件刻意用**生产的 `newRouter`**（`router.go:31`，`main.go` 调的是同一个函数）
// + **真实的 `service.NewAIService(cfg)`** + 指向 `httptest` 假上游的 `AIBaseURL`，
// 并且**把响应体当原始 JSON 解析**（不是反序列化回 Go 结构体）。
// 复用的是同包已有的 helper（`mintAccessToken` / `testJWTSecret`），不改 `newTestRouter`。
//
// 判别力来源（"改哪一行能让它红"）：
//
//	断言 200         ← router.go:104 的 `r.Post("/ai/chat", h.ai.Chat)` 整行
//	断言扁平 tool_calls ← service/ai.go 的 AIToolCall json tag（终审 Ruling 30 的契约哨兵）
//	断言 key 有效路径  ← config.go:59 `getEnv("AI_API_KEY", "")`（把默认值写成非空即红：
//	                     它会让"没配 key"的实例误以为自己配了 key，进而去外联真实上游）
package main

import (
	"bytes"
	"encoding/json"
	"io"
	"maps"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync"
	"testing"
	"time"

	"wee-count/backend/internal/config"
	"wee-count/backend/internal/handler"
	"wee-count/backend/internal/service"
)

// fakeAIUpstream 是一个 OpenAI 兼容的假上游：固定返回一份带 tool_calls 的 completion，
// 并记录收到的原始请求体（供断言"入向形状"）。
type fakeAIUpstream struct {
	*httptest.Server
	mu        sync.Mutex
	gotBodies []string
}

// bodies 返回已捕获的请求体快照。handler 跑在 httptest 自己的 goroutine 上，
// 直接读切片在 -race 下会被报成数据竞争，所以走锁（与 service/ai_test.go 的
// fakeUpstreamRecorder 同一套做法）。
func (f *fakeAIUpstream) bodies() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.gotBodies)
}

func newFakeAIUpstream(t *testing.T) *fakeAIUpstream {
	t.Helper()
	f := &fakeAIUpstream{}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.gotBodies = append(f.gotBodies, string(raw))
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{
			"choices":[{"message":{"role":"assistant","content":"","tool_calls":[
				{"id":"call_1","type":"function",
				 "function":{"name":"query_transactions","arguments":"{\"aggregate\":\"sum\"}"}}]},
				"finish_reason":"tool_calls"}],
			"usage":{"prompt_tokens":1234,"completion_tokens":56,"total_tokens":1290}
		}`))
	}))
	t.Cleanup(f.Close)
	return f
}

// TestRouterE2E_AIChatFullGreenPath 是"配置 → 装配 → 成功响应"这条链的第一条用例，
// 同时充当**规格 §6.1 的对外 JSON 契约哨兵**。
func TestRouterE2E_AIChatFullGreenPath(t *testing.T) {
	upstream := newFakeAIUpstream(t)

	// 生产配置的**真实形状**：这里刻意让它和 config.go 的取值路径一致
	// （key 非空 = 功能可用），而不是让字段留空靠 503 兜底。
	cfg := &config.Config{
		JWTSecret:    testJWTSecret,
		AIAPIKey:     "sk-e2e-test",
		AIBaseURL:    upstream.URL,
		AIModel:      "deepseek-chat",
		AIMaxTokens:  1024,
		AITimeout:    5 * time.Second,
		AIRateLimit:  20,
		AIDailyLimit: 200,
	}
	// ★ 必须走生产的 newRouter（router.go:31；main.go:53 调的是同一个函数）。
	// 自建一个 chi 路由就等于"验证测试里的顺序"，那条测试永远是绿的。
	// handlers 只填 ai：其余 handler 为 nil，但 newRouter 只做方法值绑定、不调用它们，
	// 与 router_test.go 的做法一致。
	r := newRouter(cfg, handlers{
		ai: handler.NewAIHandler(service.NewAIService(cfg)),
	})

	req := httptest.NewRequest("POST", "/api/v1/ai/chat", bytes.NewBufferString(
		`{"messages":[{"role":"user","content":"今年花了多少"}]}`))
	req.Header.Set("Authorization", "Bearer "+mintAccessToken(t, "user-a"))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("带合法 token + 已配置 key 的 /ai/chat: got %d, want 200；响应体: %s\n"+
			"（走的是生产 newRouter：若这条是 503，说明 key 没被传到 service，或路由未注册）",
			rec.Code, rec.Body.String())
	}

	// ★ 把响应体当**原始 JSON** 解析：断言的是客户端实际收到的字节，
	// 不是反序列化回同一个 Go 结构体（那样两边互相印证、看不见形状偏差）。
	var wire map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &wire); err != nil {
		t.Fatalf("响应不是合法 JSON: %v；响应体: %s", err, rec.Body.String())
	}

	if wire["text"] != "" {
		t.Errorf("text = %#v, want %q", wire["text"], "")
	}
	if wire["finish_reason"] != "tool_calls" {
		t.Errorf("finish_reason = %#v, want %q", wire["finish_reason"], "tool_calls")
	}
	// usage 三个字段逐一钉住（规格 §6.1:323）。
	usage, ok := wire["usage"].(map[string]any)
	if !ok {
		t.Fatalf("usage 不是对象: %#v；响应体: %s", wire["usage"], rec.Body.String())
	}
	for field, want := range map[string]float64{
		"prompt_tokens": 1234, "completion_tokens": 56, "total_tokens": 1290,
	} {
		if usage[field] != want {
			t.Errorf("usage.%s = %#v, want %v；响应体: %s", field, usage[field], want, rec.Body.String())
		}
	}

	// ★ 契约哨兵（规格 §6.1:322）：tool_calls 必须是**扁平**的 `{id,name,arguments}`。
	arr, ok := wire["tool_calls"].([]any)
	if !ok || len(arr) != 1 {
		t.Fatalf("tool_calls 不是长度为 1 的数组: %#v；响应体: %s", wire["tool_calls"], rec.Body.String())
	}
	tc, ok := arr[0].(map[string]any)
	if !ok {
		t.Fatalf("tool_calls[0] 不是对象: %#v", arr[0])
	}
	gotKeys := slices.Sorted(maps.Keys(tc))
	if wantKeys := []string{"arguments", "id", "name"}; !slices.Equal(gotKeys, wantKeys) {
		t.Errorf("下发给客户端的 tool_calls[0] JSON 键 = %v, want %v（规格 §6.1:322 是扁平形状："+
			"出现 function/type 说明上游形状漏给了客户端）；响应体: %s", gotKeys, wantKeys, rec.Body.String())
	}
	if tc["name"] != "query_transactions" {
		t.Errorf("tool_calls[0].name = %#v, want query_transactions；响应体: %s", tc["name"], rec.Body.String())
	}
	if tc["arguments"] != `{"aggregate":"sum"}` {
		t.Errorf("tool_calls[0].arguments = %#v, want {\"aggregate\":\"sum\"}；响应体: %s",
			tc["arguments"], rec.Body.String())
	}

	// 反向上游确实被调用了，且用的是配置里的 model / max_tokens（配置→装配透传）。
	sent := upstream.bodies()
	if len(sent) != 1 {
		t.Fatalf("假上游应被调用 1 次，实际 %d", len(sent))
	}
	for _, want := range []string{`"model":"deepseek-chat"`, `"max_tokens":1024`} {
		if !bytes.Contains([]byte(sent[0]), []byte(want)) {
			t.Errorf("上游请求体缺少 %s；实际: %s", want, sent[0])
		}
	}
}

// TestRouterE2E_AIChatDisabledWhenKeyMissing 是上一条的**对照臂**：同样的生产 newRouter，
// 只把 key 抽掉，必须返回 503 `ai_disabled`——证明上一条的 200 不是"路由恰好不检查 key"。
// 两条合起来把"禁用态"钉在**配置取值**这一层（终审实验 B1 正是这里失守）。
func TestRouterE2E_AIChatDisabledWhenKeyMissing(t *testing.T) {
	upstream := newFakeAIUpstream(t)
	cfg := &config.Config{
		JWTSecret:    testJWTSecret,
		AIAPIKey:     "", // ← 唯一差别
		AIBaseURL:    upstream.URL,
		AIModel:      "deepseek-chat",
		AIMaxTokens:  1024,
		AITimeout:    5 * time.Second,
		AIRateLimit:  20,
		AIDailyLimit: 200,
	}
	r := newRouter(cfg, handlers{ai: handler.NewAIHandler(service.NewAIService(cfg))})

	req := httptest.NewRequest("POST", "/api/v1/ai/chat", bytes.NewBufferString(
		`{"messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("Authorization", "Bearer "+mintAccessToken(t, "user-a"))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("未配置 key 的 /ai/chat: got %d, want 503；响应体: %s", rec.Code, rec.Body.String())
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte("ai_disabled")) {
		t.Errorf("响应体应含 ai_disabled；实际: %s", rec.Body.String())
	}
	if got := upstream.bodies(); len(got) != 0 {
		t.Errorf("禁用态不得发起上游请求，实际 %d 次", len(got))
	}
}

// ============================================================================
// 下面两条把链路再往前接一环：**环境变量 → config.Load() → newRouter → /ai/chat**。
// 这补的是终审实验 B1 实测出来的那个洞：把 config.go:59 的 AI_API_KEY 默认值改坏，
// 上面那两条用例（以及新文件里前两条）**全绿**——因为它们吃的都是手写的 Config 字面量，
// 从不经过 Load()。*必须两条臂*：只补"有 key → 200"那一臂，默认值被改坏照样观测不到，
// 因为改坏的是**默认值**，而只有"显式把环境变量设成空"的臂才会让非空默认值生效。
// ============================================================================

// e2eCfgFromEnv 是"从环境变量到路由"的公共前半段：t.Setenv 注入环境变量后走
// **生产的 config.Load()** 拿 cfg，再走**生产的 newRouter** 装配。
//
// 为什么必须显式设满（而不是依赖开发者本机/进程环境）：测试不能依赖任何未跟踪的本地
// 状态。AI_API_KEY 的显式取值由调用方给——**空的也必须显式写成空**，否则本机
// backend/.env 或 shell 里残留的 key 会漏进来，让"禁用态"那条假绿。
func e2eCfgFromEnv(t *testing.T, upstreamURL string, aiEnv map[string]string) (*config.Config, http.Handler) {
	t.Helper()
	env := map[string]string{
		"DATABASE_URL": "postgres://e2e",
		"REDIS_URL":    "redis://e2e",
		"JWT_SECRET":   testJWTSecret,
		"AI_BASE_URL":  upstreamURL,
	}
	for k, v := range aiEnv {
		env[k] = v
	}
	for k, v := range env {
		t.Setenv(k, v)
	}

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	return cfg, newRouter(cfg, handlers{ai: handler.NewAIHandler(service.NewAIService(cfg))})
}

func postChatViaRouter(t *testing.T, h http.Handler) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("POST", "/api/v1/ai/chat", bytes.NewBufferString(
		`{"messages":[{"role":"user","content":"今年花了多少"}]}`))
	req.Header.Set("Authorization", "Bearer "+mintAccessToken(t, "user-a"))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// TestRouterE2E_LoadThenChatEnabled 臂 1：环境变量里 key **非空** → Load() → newRouter
// → /ai/chat 必须 **200**。证明"环境变量 → Load → 装配 → 成功响应"整条链是通的。
func TestRouterE2E_LoadThenChatEnabled(t *testing.T) {
	upstream := newFakeAIUpstream(t)
	cfg, r := e2eCfgFromEnv(t, upstream.URL, map[string]string{
		"AI_API_KEY": "sk-from-env",
		"AI_MODEL":   "deepseek-chat",
	})
	// 先钉住前提：cfg 确实是 Load() 的产物、key 确实透传下来了。
	// 没有这一句，200 也可能来自别处，本用例就不再是"环境变量→配置"的哨兵。
	if cfg.AIAPIKey != "sk-from-env" {
		t.Fatalf("前提不成立：Load() 出来的 key = %q, want sk-from-env", cfg.AIAPIKey)
	}

	rec := postChatViaRouter(t, r)
	if rec.Code != http.StatusOK {
		t.Fatalf("环境变量配了 key 时 /ai/chat: got %d, want 200；响应体: %s", rec.Code, rec.Body.String())
	}

	var wire map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &wire); err != nil {
		t.Fatalf("响应不是合法 JSON: %v；响应体: %s", err, rec.Body.String())
	}
	if wire["finish_reason"] != "tool_calls" {
		t.Errorf("finish_reason = %#v, want tool_calls", wire["finish_reason"])
	}
	arr, ok := wire["tool_calls"].([]any)
	if !ok || len(arr) != 1 {
		t.Fatalf("tool_calls 不是长度为 1 的数组: %#v；响应体: %s", wire["tool_calls"], rec.Body.String())
	}
	tc, ok := arr[0].(map[string]any)
	if !ok {
		t.Fatalf("tool_calls[0] 不是对象: %#v", arr[0])
	}
	gotKeys := slices.Sorted(maps.Keys(tc))
	if wantKeys := []string{"arguments", "id", "name"}; !slices.Equal(gotKeys, wantKeys) {
		t.Errorf("下发给客户端的 tool_calls[0] JSON 键 = %v, want %v（规格 §6.1:322 扁平形状）；响应体: %s",
			gotKeys, wantKeys, rec.Body.String())
	}
	// 上游确实被调用，且 baseURL 来自环境变量（不是 cfg 结构体里另手写的）。
	if got := upstream.bodies(); len(got) != 1 {
		t.Errorf("假上游应被调用 1 次，实际 %d", len(got))
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", got)
	}
}

// TestRouterE2E_LoadThenChatDisabled 臂 2：**显式** `AI_API_KEY=""` → Load() → newRouter
// → /ai/chat 必须 **503 `ai_disabled`**。
//
// ★ 这一条才是终审 B1 变异（把 config.go:59 的默认值硬编码成非空 key）的**杀手**：
// 环境变量被显式设成空 ⇒ `getEnv("AI_API_KEY", default)` 走到 default 分支，
// default 一旦不再是空串，一个"没配 key"的部署就会以为自己配了 key、去外联真实上游。
// 臂 1 对这个变异无反应（env 优先，非空值把默认值完全挡住），所以必须两条臂都在。
func TestRouterE2E_LoadThenChatDisabled(t *testing.T) {
	upstream := newFakeAIUpstream(t)
	cfg, r := e2eCfgFromEnv(t, upstream.URL, map[string]string{
		"AI_API_KEY": "", // ← 显式设空（见 e2eCfgFromEnv 的说明）
	})
	// 前提：默认值必须是空 —— 这句就是"没配 key ⇒ 禁用"这一层的断言。
	if cfg.AIAPIKey != "" {
		t.Fatalf("前提不成立：未配 AI_API_KEY 时 Load() 出来的 key = %q，want 空串"+
			"（config.go:59 的默认值被改成了非空？）", cfg.AIAPIKey)
	}

	rec := postChatViaRouter(t, r)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("未配 key 时 /ai/chat: got %d, want 503；响应体: %s", rec.Code, rec.Body.String())
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte("ai_disabled")) {
		t.Errorf("响应体应含 ai_disabled；实际: %s", rec.Body.String())
	}
	if got := upstream.bodies(); len(got) != 0 {
		t.Errorf("禁用态不得发起上游请求，实际 %d 次", len(got))
	}
}
