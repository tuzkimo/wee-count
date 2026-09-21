package service

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"maps"
	"net"
	"net/http"
	"net/http/httptest"
	"slices"
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
		Messages: []AIMessage{{Role: "user", Content: json.RawMessage(`"hi"`)}},
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

// 响应侧 content 容错（任务 1 审查 Minor-5 / E12.2）：上游回的 content **不一定是字符串**。
//
// 旧形状 `Content string` 遇到内容块数组时 json.Unmarshal 整份失败 ⇒ 归一化报
// ai_upstream_error ⇒ 用户看到"AI 服务暂时不可用"，而那个响应本身是好的（只是形状我们读不懂）。
// 容错方向只多不少：字符串与块数组都读得出文本（**含合法的空串**）。
//
// ⚠️ 口径变更（任务 4 审查 Minor-1）：**读不懂的形状显式失败**（ai_upstream_error），
// 不再退化成空文本。旧口径把"我们读不懂这个响应"伪装成"模型什么都没说"：空文本在下游是
// 合法语义（落一条空 assistant 行、store 的 error 保持 null）⇒ 用户看到 AI 装死而不是出错。
// 而**合法的空**（`"content":""`、`[{"type":"text","text":""}]`、null/缺键）必须仍然成功 ——
// 那是真实存在的正常形态，把它们一起判成失败是另一种错（§4.2 的教训）。
// 注：**body 本身语法就不合法**（`{oops`）在上层 json.Unmarshal 就被拦下，同样报
// ai_upstream_error（用户可见结果一致），所以这张表不必再造一个走不到的形状。
func TestAIService_Chat_ResponseContentShapes(t *testing.T) {
	cases := []struct {
		name    string
		body    string
		want    string
		wantErr bool
	}{
		{
			name: "老形状：字符串原样",
			body: `{"choices":[{"message":{"content":"你好"},"finish_reason":"stop"}]}`,
			want: "你好",
		},
		{
			name: "块数组：只取 text 块按序拼接（image_url 块忽略）",
			body: `{"choices":[{"message":{"content":[
				{"type":"text","text":"这个月"},
				{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,AAAA"}},
				{"type":"text","text":"花了 128 元"}
			]},"finish_reason":"stop"}]}`,
			want: "这个月花了 128 元",
		},
		{
			name: "content 显式为 null（工具回包那一轮的常见形态）",
			body: `{"choices":[{"message":{"content":null,"tool_calls":[
				{"id":"call_1","type":"function","function":{"name":"query_transactions","arguments":"{}"}}]},
				"finish_reason":"tool_calls"}]}`,
			want: "",
		},
		{
			name: "message 里**缺 content 键** ⇒ 同 null，不失败",
			body: `{"choices":[{"message":{"tool_calls":[
				{"id":"call_1","type":"function","function":{"name":"query_transactions","arguments":"{}"}}]},
				"finish_reason":"tool_calls"}]}`,
			want: "",
		},
		{
			// 🔴 这条钉住"这次修复没误伤合法空答"：
			// 杀手：把 `len(c) == 0 || null` 之外的**空串**也判成失败 ⇒ 这条红。
			name: "**合法的空字符串**照旧成功（「模型这一轮没说话」≠「我们读不懂」）",
			body: `{"choices":[{"message":{"content":""},"finish_reason":"stop"}]}`,
			want: "",
		},
		{
			// 🔴 同上：判据是"**存在** text 块"，不是"结果非空"。
			// 杀手：把判据改成 `b.Len() == 0` ⇒ 这条红。
			name: "text 块本身是空串 ⇒ 仍是成功（存在 text 块就算读得懂）",
			body: `{"choices":[{"message":{"content":[{"type":"text","text":""}]},"finish_reason":"stop"}]}`,
			want: "",
		},
		{
			name:    "坏形状：数字（既非字符串也非数组）⇒ 显式失败",
			body:    `{"choices":[{"message":{"content":123},"finish_reason":"stop"}]}`,
			wantErr: true,
		},
		{
			name:    "坏形状：布尔 ⇒ 显式失败",
			body:    `{"choices":[{"message":{"content":true},"finish_reason":"stop"}]}`,
			wantErr: true,
		},
		{
			name:    "坏形状：对象 ⇒ 显式失败",
			body:    `{"choices":[{"message":{"content":{"text":"你好"}},"finish_reason":"stop"}]}`,
			wantErr: true,
		},
		{
			name:    "坏形状：空数组（一个 text 块都没有）⇒ 显式失败",
			body:    `{"choices":[{"message":{"content":[]},"finish_reason":"stop"}]}`,
			wantErr: true,
		},
		{
			name: "坏形状：数组里只有非文本块（image_url）⇒ 显式失败",
			body: `{"choices":[{"message":{"content":[
				{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,AAAA"}}]},"finish_reason":"stop"}]}`,
			wantErr: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv, _ := newFakeUpstream(t, 200, tc.body)
			svc := newTestAIService(t, srv.URL, 5*time.Second)

			got, err := svc.Chat(context.Background(), AIChatRequest{
				Messages: []AIMessage{{Role: "user", Content: json.RawMessage(`"hi"`)}},
			})
			if tc.wantErr {
				if err == nil {
					t.Fatalf("这个形状读不懂，必须**显式失败**（退化成空串会让用户看到 AI 装死）: got Text=%q", got.Text)
				}
				// 复用 M2 既有的映射：不新造错误码
				var aiErr *AIError
				if !errors.As(err, &aiErr) {
					t.Fatalf("失败必须带上错误码（客户端按码选文案）: %v", err)
				}
				if aiErr.Code != AICodeUpstreamError {
					t.Errorf("Code = %q, want %q", aiErr.Code, AICodeUpstreamError)
				}
				return
			}
			if err != nil {
				t.Fatalf("这个形状必须成功（含合法的空串/null）: %v", err)
			}
			if got.Text != tc.want {
				t.Errorf("Text = %q, want %q", got.Text, tc.want)
			}
		})
	}
}

// 归一化：tool_calls 从**上游嵌套形状**映射到**客户端扁平契约**（规格 §6.1:311-314）。
// 断言口径与本轮之前完全一致（id/名称/arguments 三项都要对），只是字段路径变了：
// 上游的 `function.name` → 契约的 `name`。`type` 在契约里不存在，故不再断言它，
// 取而代之的是下面的 TestAIService_Chat_ResponseJSONIsFlat（那条看真实 JSON 键名，
// 才是"上游形状有没有漏给客户端"的哨兵）。
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
		Messages: []AIMessage{{Role: "user", Content: json.RawMessage(`"今年花了多少"`)}},
	})
	if err != nil {
		t.Fatalf("Chat: %v", err)
	}
	if len(got.ToolCalls) != 1 {
		t.Fatalf("ToolCalls 长度 = %d, want 1", len(got.ToolCalls))
	}
	tc := got.ToolCalls[0]
	if tc.ID != "call_1" ||
		tc.Name != "query_transactions" ||
		tc.Arguments != `{"aggregate":"sum"}` {
		t.Errorf("tool_call 归一化错误: %+v", tc)
	}
	if got.FinishReason != "tool_calls" {
		t.Errorf("FinishReason = %q, want tool_calls", got.FinishReason)
	}
}

// ★ 契约哨兵（出向）：断言**真实 JSON 的键名**，不是 Go 结构体字段。
//
// 为什么必须有这一条：`AIChatResponse`/`AIToolCall` 曾同时被用在两侧，而当时它的
// json tag 是上游的嵌套形状 `{id,type,function:{name,arguments}}` ——
// service 用例断言 `tc.Function.Name`、handler 用例再反序列化回同一个结构体，
// **两边互相印证、却都与规格 §6.1:322 的扁平契约不符**。没有一条用例看对外 JSON 时，
// "上游字段名漏给客户端"是不可见的。这条把口径钉在**序列化后的字节**上：
//   - `name` / `arguments` 必须是 tool_call 的**直接**字段（扁平）；
//   - **不得出现** `function` 包装层、不得出现上游的 `type`。
//
// 判别力来源：断言的是 `maps.Keys` 得到的键集合本身。把 AIToolCall 改回嵌套形状
// ⇒ 键集合变成 {function,id,type} ⇒ 本条第一句就红（实测见提交说明）。
func TestAIService_Chat_ResponseJSONIsFlat(t *testing.T) {
	srv, _ := newFakeUpstream(t, 200, `{
		"choices":[{"message":{"role":"assistant","content":"","tool_calls":[
			{"id":"call_1","type":"function",
			 "function":{"name":"query_transactions","arguments":"{\"aggregate\":\"sum\"}"}}]},
			"finish_reason":"tool_calls"}],
		"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}
	}`)
	svc := newTestAIService(t, srv.URL, 5*time.Second)

	got, err := svc.Chat(context.Background(), AIChatRequest{
		Messages: []AIMessage{{Role: "user", Content: json.RawMessage(`"今年花了多少"`)}},
	})
	if err != nil {
		t.Fatalf("Chat: %v", err)
	}

	raw, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	// 先钉住前提：确实有一个 tool_call 被下发了，否则下面的键名断言会空转。
	if len(got.ToolCalls) != 1 {
		t.Fatalf("前提不成立：ToolCalls 长度 = %d, want 1；实际 JSON: %s", len(got.ToolCalls), raw)
	}

	var wire map[string]any
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatalf("响应不是合法 JSON: %v", err)
	}
	arr, ok := wire["tool_calls"].([]any)
	if !ok || len(arr) != 1 {
		t.Fatalf("tool_calls 不是长度为 1 的数组: %#v（实际 JSON: %s）", wire["tool_calls"], raw)
	}
	item, ok := arr[0].(map[string]any)
	if !ok {
		t.Fatalf("tool_calls[0] 不是对象: %#v", arr[0])
	}

	// ★ 核心断言：JSON 的键集合**恰好**是这三个。多一个 `function` 就是上游形状泄漏。
	want := []string{"arguments", "id", "name"}
	gotKeys := slices.Sorted(maps.Keys(item))
	if !slices.Equal(gotKeys, want) {
		t.Errorf("tool_calls[0] 的 JSON 键 = %v, want %v（规格 §6.1:322 是扁平形状："+
			"多出 function/type 说明下发的是上游形状）；实际 JSON: %s", gotKeys, want, raw)
	}
	if item["name"] != "query_transactions" {
		t.Errorf("tool_calls[0].name = %#v, want %q（实际 JSON: %s）", item["name"], "query_transactions", raw)
	}
	if item["arguments"] != `{"aggregate":"sum"}` {
		t.Errorf("tool_calls[0].arguments = %#v, want %q（实际 JSON: %s）",
			item["arguments"], `{"aggregate":"sum"}`, raw)
	}
	// 冗余但便宜：`type` 只存在于上游协议里，契约里没有它。
	if _, exists := item["function"]; exists {
		t.Errorf("tool_calls[0] 里出现了上游的 function 包装层；实际 JSON: %s", raw)
	}
	if _, exists := item["type"]; exists {
		t.Errorf("tool_calls[0] 里出现了上游的 type 字段；实际 JSON: %s", raw)
	}
}

// ★ 契约哨兵（入向）：假上游**捕获原始请求体**，断言发出去的是**上游嵌套形状**。
//
// 场景就是工具循环本身：客户端把上一轮收到的 tool_calls **原样回传**（规格 §5.2 第 4b 步），
// 即线格式里的扁平 `{id, name, arguments}`。后端必须把它转成上游要的
// `{id, type:"function", function:{name, arguments}}` —— 不转换就等于把扁平形状发给供应商，
// 供应商解析不出 function.name ⇒ 400（M3 一开工就会撞上）。
//
// 判别力来源：断言的是**上游收到的原始字节**解析出来的结构。
// 把入向转换去掉（`Messages: req.Messages` 原样透传）⇒ `type` 与 `function` 双双缺失 ⇒ 红。
func TestAIService_Chat_RequestToolCallsAreNested(t *testing.T) {
	srv, rec := newFakeUpstream(t, 200,
		`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}`)
	svc := newTestAIService(t, srv.URL, 5*time.Second)

	// 客户端回传的 assistant 消息 + 工具结果：这就是第二轮的输入形状。
	_, err := svc.Chat(context.Background(), AIChatRequest{
		Messages: []AIMessage{
			{Role: "user", Content: json.RawMessage(`"今年花了多少"`)},
			{Role: "assistant", ToolCalls: []AIToolCall{{
				ID:        "call_1",
				Name:      "query_transactions",
				Arguments: `{"aggregate":"sum"}`,
			}}},
			// tool 消息的 content 在 OpenAI 兼容协议里是**字符串**（工具结果就是一段文本），
			// 不是对象也不是块数组——裸对象会被真实供应商判非法。这里逐字保留改动前的语义。
			{Role: "tool", ToolCallID: "call_1", Content: json.RawMessage(`"{\"sum\":1234}"`)},
		},
	})
	if err != nil {
		t.Fatalf("Chat: %v", err)
	}

	calls, _, _, body := rec.snapshot()
	if calls != 1 {
		t.Fatalf("前提不成立：上游应被调用 1 次，实际 %d（body=%s）", calls, body)
	}

	var sent struct {
		Messages []struct {
			Role       string `json:"role"`
			ToolCallID string `json:"tool_call_id"`
			ToolCalls  []struct {
				ID       string          `json:"id"`
				Type     string          `json:"type"`
				Function json.RawMessage `json:"function"`
			} `json:"tool_calls"`
		} `json:"messages"`
	}
	if err := json.Unmarshal([]byte(body), &sent); err != nil {
		t.Fatalf("上游请求体不是合法 JSON: %v；实际: %s", err, body)
	}
	if len(sent.Messages) != 3 {
		t.Fatalf("上游应收到 3 条 messages，实际 %d；实际: %s", len(sent.Messages), body)
	}
	assistant := sent.Messages[1]
	if len(assistant.ToolCalls) != 1 {
		t.Fatalf("上游收到的 assistant.tool_calls 长度 = %d, want 1；实际: %s",
			len(assistant.ToolCalls), body)
	}
	tc := assistant.ToolCalls[0]

	// ★ 核心断言：上游形状是嵌套的，且带 `type:"function"`。
	if tc.Type != "function" {
		t.Errorf("上游 tool_calls[0].type = %q, want %q（上游协议要求这个字段）；实际: %s",
			tc.Type, "function", body)
	}
	if len(tc.Function) == 0 {
		t.Fatalf("上游 tool_calls[0] 缺少 function 包装层（function.name 会解析不出来 ⇒ 上游 400）；实际: %s", body)
	}
	var fn struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	}
	if err := json.Unmarshal(tc.Function, &fn); err != nil {
		t.Fatalf("function 不是合法 JSON: %v；实际: %s", err, tc.Function)
	}
	if fn.Name != "query_transactions" {
		t.Errorf("上游 function.name = %q, want %q；实际: %s", fn.Name, "query_transactions", body)
	}
	if fn.Arguments != `{"aggregate":"sum"}` {
		t.Errorf("上游 function.arguments = %q, want %q；实际: %s",
			fn.Arguments, `{"aggregate":"sum"}`, body)
	}
	if tc.ID != "call_1" {
		t.Errorf("上游 tool_calls[0].id = %q, want call_1；实际: %s", tc.ID, body)
	}
	// 第三条消息是工具结果：tool_call_id 也必须在两个方向都保持同一字段名。
	if sent.Messages[2].Role != "tool" || sent.Messages[2].ToolCallID != "call_1" {
		t.Errorf("上游收到的工具结果消息错误: %+v", sent.Messages[2])
	}
	// 反向冗余断言：**扁平形状绝不能出现在上游请求体里**。直接扒出那条 assistant 消息的
	// 键集合来比——若入向转换被去掉，这里会看到 {arguments,id,name} 而没有 function/type。
	var wireSent struct {
		Messages []map[string]any `json:"messages"`
	}
	if err := json.Unmarshal([]byte(body), &wireSent); err != nil {
		t.Fatalf("上游请求体不是合法 JSON: %v；实际: %s", err, body)
	}
	gotMsgKeys := slices.Sorted(maps.Keys(wireSent.Messages[1]))
	if wantMsgKeys := []string{"role", "tool_calls"}; !slices.Equal(gotMsgKeys, wantMsgKeys) {
		t.Errorf("上游 assistant 消息的 JSON 键 = %v, want %v；实际: %s", gotMsgKeys, wantMsgKeys, body)
	}
	tcObj, ok := wireSent.Messages[1]["tool_calls"].([]any)
	if !ok || len(tcObj) != 1 {
		t.Fatalf("上游 tool_calls 不是长度为 1 的数组: %#v；实际: %s", wireSent.Messages[1]["tool_calls"], body)
	}
	tcMap, ok := tcObj[0].(map[string]any)
	if !ok {
		t.Fatalf("上游 tool_calls[0] 不是对象: %#v", tcObj[0])
	}
	gotTCKeys := slices.Sorted(maps.Keys(tcMap))
	if wantTCKeys := []string{"function", "id", "type"}; !slices.Equal(gotTCKeys, wantTCKeys) {
		t.Errorf("上游 tool_calls[0] 的 JSON 键 = %v, want %v（出现 name/arguments 说明扁平形状被原样透传）；实际: %s",
			gotTCKeys, wantTCKeys, body)
	}
}

// 请求侧：key 只以 Authorization 头发给上游，且 model / max_tokens 用的是配置值。
func TestAIService_Chat_SendsConfiguredPayload(t *testing.T) {
	srv, rec := newFakeUpstream(t, 200, `{"choices":[{"message":{"content":"x"},"finish_reason":"stop"}]}`)
	svc := newTestAIService(t, srv.URL, 5*time.Second)

	_, err := svc.Chat(context.Background(), AIChatRequest{
		Messages: []AIMessage{{Role: "user", Content: json.RawMessage(`"hi"`)}},
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
				Messages: []AIMessage{{Role: "user", Content: json.RawMessage(`"hi"`)}},
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
		Messages: []AIMessage{{Role: "user", Content: json.RawMessage(`"hi"`)}},
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
		Messages: []AIMessage{{Role: "user", Content: json.RawMessage(`"hi"`)}},
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
		Messages: []AIMessage{{Role: "user", Content: json.RawMessage(`"hi"`)}},
	})
	assertAICode(t, err, AICodeUnreachable)
}

// 200 但 body 里没有 choices：不能 panic，也不能返回空响应当成功。
func TestAIService_Chat_NoChoices(t *testing.T) {
	srv, _ := newFakeUpstream(t, 200, `{"choices":[]}`)
	svc := newTestAIService(t, srv.URL, 5*time.Second)

	_, err := svc.Chat(context.Background(), AIChatRequest{
		Messages: []AIMessage{{Role: "user", Content: json.RawMessage(`"hi"`)}},
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
		Messages: []AIMessage{{Role: "user", Content: json.RawMessage(`"hi"`)}},
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
		Messages: []AIMessage{{Role: "user", Content: json.RawMessage(`"hi"`)}},
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
		Messages: []AIMessage{{Role: "user", Content: json.RawMessage(`"` + sentinel + `"`)}},
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
