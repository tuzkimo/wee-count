package service

import (
	"bytes"
	"context"
	"encoding/json"
	"maps"
	"slices"
	"testing"
	"time"
)

// marshalUpstreamMessages 拿到后端**真正发给供应商的原始字节**。
// 走的是 ai_test.go 里既有的转发装配方式（newFakeUpstream + newTestAIService + Chat），
// 刻意不新造第二条转发缝：换一条缝就变成"验证测试里的转发"，而不是验证 toUpstreamMessages。
func marshalUpstreamMessages(t *testing.T, msgs []AIMessage) []byte {
	t.Helper()
	srv, rec := newFakeUpstream(t, 200,
		`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}`)
	svc := newTestAIService(t, srv.URL, 5*time.Second)

	if _, err := svc.Chat(context.Background(), AIChatRequest{Messages: msgs}); err != nil {
		t.Fatalf("Chat: %v", err)
	}
	calls, _, _, body := rec.snapshot()
	if calls != 1 {
		t.Fatalf("前提不成立：上游应被调用 1 次，实际 %d（body=%s）", calls, body)
	}
	return []byte(body)
}

// upstreamWireMessages 把上游请求体里 messages 的键集解出来：键集哨兵比"含不含某个子串"
// 精确——它会同时抓住"多出一个键"和"值变成了 null"两种情况。
func upstreamWireMessages(t *testing.T, body []byte) []map[string]any {
	t.Helper()
	var wire struct {
		Messages []map[string]any `json:"messages"`
	}
	if err := json.Unmarshal(body, &wire); err != nil {
		t.Fatalf("上游请求体不是合法 JSON: %v；实际: %s", err, body)
	}
	return wire.Messages
}

// ★ 契约哨兵：role+tool_calls 的消息（工具回传那一轮）发到上游时，键集必须**恰好**
// 是 role/tool_calls，不得多出 content。规格 §5.2：`json.RawMessage` 的零值必须是 nil
// 而不是 `[]`/`null`——多出 `"content":null` 在部分供应商上会被判非法请求
// （同族教训见 ai.go 里 tool_calls 的 omitempty 注释）。
//
// 判别力来源：断言的是序列化后**实际发出的键集合**。给上游消息的 content 去掉 omitempty、
// 或把缺键补成字面量 null，本条第一句就红（实测见提交说明）。
// 第二条断言（tool 消息**必须有** content）是它的对偶：防的是"归一化过头"——
// 把非空 content 也一起抹成缺键，那样第一条照样绿，但工具结果就再也没发给上游了。
func TestUpstreamToolResultMessageHasNoContentKey(t *testing.T) {
	body := marshalUpstreamMessages(t, []AIMessage{
		{Role: "assistant", ToolCalls: []AIToolCall{{
			ID: "call_1", Name: "query_transactions", Arguments: `{}`,
		}}},
		{Role: "tool", ToolCallID: "call_1", Content: json.RawMessage(`"结果"`)},
	})
	msgs := upstreamWireMessages(t, body)
	if len(msgs) != 2 {
		t.Fatalf("上游应收到 2 条 messages，实际 %d；实际: %s", len(msgs), body)
	}

	gotAssistant := slices.Sorted(maps.Keys(msgs[0]))
	if want := []string{"role", "tool_calls"}; !slices.Equal(gotAssistant, want) {
		t.Errorf("上游 assistant 消息键集 = %v, want %v（多出 content 说明 omitempty 失效，"+
			"部分供应商会 400）；实际: %s", gotAssistant, want, body)
	}

	gotTool := slices.Sorted(maps.Keys(msgs[1]))
	if want := []string{"content", "role", "tool_call_id"}; !slices.Equal(gotTool, want) {
		t.Errorf("上游 tool 消息键集 = %v, want %v（工具结果的内容必须原样发给上游，"+
			"归一化不得把非空 content 一起抹掉）；实际: %s", gotTool, want, body)
	}
	if !bytes.Contains(body, []byte(`"结果"`)) {
		t.Errorf("上游请求体丢了工具结果文本；实际: %s", body)
	}
}

// 块数组必须原样透传：不解析、不重排、不丢字段（规格 §5.1 的哑管道）。
// 判别力来源：断言 image_url 块与 text 块的内容都在**上游收到的字节**里。
func TestUpstreamImageBlockContentPassesThrough(t *testing.T) {
	blocks := `[{"type":"text","text":"买菜"},` +
		`{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,AAAA"}}]`
	body := marshalUpstreamMessages(t, []AIMessage{{
		Role:    "user",
		Content: json.RawMessage(blocks),
	}})

	if !bytes.Contains(body, []byte(`"image_url"`)) ||
		!bytes.Contains(body, []byte(`data:image/jpeg;base64,AAAA`)) {
		t.Fatalf("上游 body 丢了 content 块；实际: %s", body)
	}
	if !bytes.Contains(body, []byte(`"text":"买菜"`)) {
		t.Fatalf("上游 body 丢了 text 块；实际: %s", body)
	}
	// 前提钉死：块数组确实是**数组**。若 content 被当成字符串二次编码，
	// 上面两条 Contains（需要未转义的引号）会一起红，所以这里再确认一次形状。
	msgs := upstreamWireMessages(t, body)
	if len(msgs) != 1 {
		t.Fatalf("上游应收到 1 条 message，实际 %d；实际: %s", len(msgs), body)
	}
	blocksWire, ok := msgs[0]["content"].([]any)
	if !ok || len(blocksWire) != 2 {
		t.Fatalf("上游 content 不是长度为 2 的块数组: %#v（image_url 块必须是数组元素，"+
			"不能被序列化成字符串）；实际: %s", msgs[0]["content"], body)
	}
}

// content: null 视同缺键（规格 §5.2）：客户端可能发 `"content": null`，
// 而 `json.RawMessage` 实现了 UnmarshalJSON，会把字面量 `null` **原样收进**字段
// （与 []byte/map/slice 的"null 保持零值"规则不同）⇒ 装配点必须显式归一，否则
// 这一轮会把 `"content":null` 透传给上游。
//
// 判别力来源：删掉装配点那一行归一化，本条必红（实测见提交说明）。
func TestUpstreamNullContentIsTreatedAsAbsent(t *testing.T) {
	body := marshalUpstreamMessages(t, []AIMessage{{
		Role:    "user",
		Content: json.RawMessage(`null`),
	}})
	msgs := upstreamWireMessages(t, body)
	if len(msgs) != 1 {
		t.Fatalf("上游应收到 1 条 message，实际 %d；实际: %s", len(msgs), body)
	}

	got := slices.Sorted(maps.Keys(msgs[0]))
	if want := []string{"role"}; !slices.Equal(got, want) {
		t.Errorf("null content 的消息键集 = %v, want %v（null 必须视同缺键，"+
			"不能透传给上游）；实际: %s", got, want, body)
	}
	// 冗余但便宜：直接看那个非法字节序列有没有出现。
	if bytes.Contains(body, []byte(`"content":null`)) {
		t.Errorf("null content 被原样透传给了上游；实际: %s", body)
	}
}

// 字符串 content 老路径不回归（规格 §5.1：M1–M3 的文字链路逐字不变）。
func TestUpstreamPlainStringContentStillWorks(t *testing.T) {
	body := marshalUpstreamMessages(t, []AIMessage{{
		Role:    "user",
		Content: json.RawMessage(`"上个月花了多少"`),
	}})
	if !bytes.Contains(body, []byte(`"content":"上个月花了多少"`)) {
		t.Fatalf("字符串 content 未按原样透传；实际: %s", body)
	}
}
