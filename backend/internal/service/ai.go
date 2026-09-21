// backend/internal/service/ai.go
package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"time"

	"wee-count/backend/internal/config"
)

// AI 错误码（规格 §6.6）。handler 按它映射 HTTP 状态码。
// AICodeQuotaExceeded 由限流中间件产出（见 cmd/server/router.go），不在本文件使用，
// 但错误码集中在这里定义，保证只有一处真相。
const (
	AICodeDisabled        = "ai_disabled"
	AICodeUnreachable     = "ai_unreachable"
	AICodeUpstreamAuth    = "ai_upstream_auth"
	AICodeUpstreamTimeout = "ai_upstream_timeout"
	AICodeUpstreamError   = "ai_upstream_error"
	AICodeRateLimited     = "ai_rate_limited"
	AICodeQuotaExceeded   = "ai_quota_exceeded"
)

// maxUpstreamBodyBytes 限制从上游读取的字节数：上游异常时可能返回巨大 body，
// 不设限就等于把内存交给对方。
const maxUpstreamBodyBytes = 1 << 20 // 1MB

// AIError 携带机器可读的错误码。上游原始错误体**绝不进 Error()**——
// 它会被写进日志，而日志不该出现供应商返回的原文（可能含请求片段）。
type AIError struct {
	Code     string
	Upstream int   // 上游 HTTP 状态码；0 表示没拿到响应（网络层失败）
	Err      error // 底层错误，仅供日志
}

func (e *AIError) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("ai: %s (upstream=%d): %v", e.Code, e.Upstream, e.Err)
	}
	return fmt.Sprintf("ai: %s (upstream=%d)", e.Code, e.Upstream)
}

func (e *AIError) Unwrap() error { return e.Err }

// ============================================================================
// 两侧形状必须分开：**线格式（客户端 ↔ 后端）扁平，上游格式（后端 → 上游）嵌套**。
//
// 为什么不能合并成一个类型（这是曾经的 bug，别再合回去）：
// 客户端契约是 spec §6.1:311-314 —— 两个方向的 tool_calls 都是**扁平**的
// `{id, name, arguments}`，客户端把上一轮收到的 tool_calls **原样回传**；
// 上游（OpenAI 兼容）要的是**嵌套**的 `{id, type:"function", function:{name, arguments}}`。
// 一个类型同时服务两侧时，"这里是哪一种形状"在类型系统里不可见 ——
// 形状就会顺着结构体的 json tag 静默漏给客户端（上游字段名泄漏到对外契约）。
// 所以这里是两个类型，转换只发生在两个地方：
//   出（上游 → 客户端）：normalizeUpstream()；
//   入（客户端 → 上游）：toUpstreamMessages()。
// ============================================================================

// AIMessage 是客户端 ↔ 后端的消息形状（规格 §6.1）。**只在线上用**，
// 既不出现在发给上游的请求体里（那边是 upstreamMessage），也不从上游响应反序列化
// （那边是 upstreamChatResponse.message）。因此它的 json tag 就是对外契约，改它即改契约。
// Content 是 json.RawMessage 而不是 string（M4 起）：客户端发字符串（M1–M3 的文字链路）
// 或发 OpenAI 兼容的多模态内容块数组（截图那一轮），后端都**不解析、不改结构、不重排键序**
// ——它仍是哑管道。
// 注意"透传"是**语义**层面，不是**字节**层面：json.Marshal 对 RawMessage 会就地 compact
// （块内空白被压掉）并做 HTML 转义（`<` `>` `&` → `\u003c` `\u0026` `\u003e`）。
// JSON 的空白与转义不影响解析出的值，所以上游拿到的 JSON 值与客户端发出的等价。
// 用 RawMessage 的代价是 `null` 会被原样收进字段（RawMessage 实现了 UnmarshalJSON，
// 不走 []byte 的"JSON null 保持零值"规则）⇒ 装配点必须归一（见 toUpstreamMessages）。
type AIMessage struct {
	Role       string          `json:"role"`
	Content    json.RawMessage `json:"content,omitempty"`
	ToolCallID string          `json:"tool_call_id,omitempty"`
	ToolCalls  []AIToolCall    `json:"tool_calls,omitempty"`
}

// AIToolCall 是客户端契约里的工具调用形状（规格 §6.1:311/322）：**扁平**。
// 字段名就是客户端看到的字段名——`name`/`arguments` 直接挂在 tool_call 上，
// **没有** `type`、**没有** `function` 包装层。客户端不认识上游形状（§6.1:314）。
type AIToolCall struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// upstreamMessage / upstreamToolCall 是**发给上游**的 OpenAI 兼容形状：嵌套。
// 它们与 AIMessage/AIToolCall 是刻意的两份定义（见上面的说明）：
// 上游协议里 tool_call 必须带 `"type":"function"` 且 name/arguments 嵌在 `function` 下，
// 少任何一层供应商都会 400。反过来，客户端契约里多任何一层同样是错的。
type upstreamMessage struct {
	Role       string             `json:"role"`
	Content    json.RawMessage    `json:"content,omitempty"`
	ToolCallID string             `json:"tool_call_id,omitempty"`
	ToolCalls  []upstreamToolCall `json:"tool_calls,omitempty"`
}

type upstreamToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

// AIChatRequest 是客户端 → 后端的请求体（规格 §6.1）。
// tools 原样转发：工具 schema 是本项目客户端的契约，后端不解释它，
// 因此工具演进时后端不必改动。
type AIChatRequest struct {
	Messages []AIMessage     `json:"messages"`
	Tools    json.RawMessage `json:"tools,omitempty"`
}

type AIUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

// AIChatResponse 是后端 → 客户端的归一化响应（规格 §6.1）。
// 客户端不认识任何上游字段名——换供应商时客户端一行都不用改。
type AIChatResponse struct {
	Text         string       `json:"text"`
	ToolCalls    []AIToolCall `json:"tool_calls"`
	Usage        AIUsage      `json:"usage"`
	FinishReason string       `json:"finish_reason"`
}

// AIStatus 是 /ai/status 的响应（规格 §6.1）。**不含 key**。
type AIStatus struct {
	Enabled bool   `json:"enabled"`
	Model   string `json:"model"`
	Host    string `json:"host"`
}

// upstreamChatRequest 是发给上游的 OpenAI 兼容请求体。只包含归一化后的字段，
// 客户端的多余字段不会被转发。Messages 是 upstreamMessage（嵌套 tool_calls）。
type upstreamChatRequest struct {
	Model     string            `json:"model"`
	Messages  []upstreamMessage `json:"messages"`
	Tools     json.RawMessage   `json:"tools,omitempty"`
	MaxTokens int               `json:"max_tokens"`
}

// upstreamChatResponse 只用上游响应的 choices[0].message 做归一化的原料，
// 所以这里的 message 是**上游形状**的结构体（与请求侧的 upstreamMessage 不同：
// 响应不需要回传 tool_call 的 `type`，normalizeUpstream 也不看它）。
type upstreamChatResponse struct {
	Choices []struct {
		Message      upstreamResponseMessage `json:"message"`
		FinishReason string                  `json:"finish_reason"`
	} `json:"choices"`
	Usage AIUsage `json:"usage"`
}

// upstreamResponseMessage 是上游响应里 message 的形状。tool_calls 是**嵌套**的，
// 与请求侧上游形状一致——所以这里复用 upstreamToolCall，转换在 normalizeUpstream。
type upstreamResponseMessage struct {
	Content   string             `json:"content"`
	ToolCalls []upstreamToolCall `json:"tool_calls"`
}

// toUpstreamMessages 把客户端契约（扁平）转成上游请求体（嵌套）。
// 客户端会把上一轮收到的 tool_calls 原样回传（规格 §5.2 第 4b 步），
// 所以这条路径是工具循环的**必经之路**：不转换就等于把扁平形状发给上游
// （供应商解析不出 function.name ⇒ 400），而客户端契约又要求它保持扁平。
// 客户端没有 tool_calls 时 ToolCalls 保持 nil，`omitempty` 保证该键不出现——
// 给上游发一个空的 tool_calls 数组在部分供应商上会被当成非法请求。
//
// content 同理（规格 §5.2）：null 与空内容都必须归成 nil，让 `omitempty` 把键整个省掉。
// 为什么不能直接赋值：`json.RawMessage` 实现了 UnmarshalJSON，客户端发
// `"content": null` 时字段里存的是**字面量 `null`**（4 字节，非空），
// 直接透传就会给上游发出 `"content":null`；而工具回传那一轮的消息按契约只有
// role/tool_calls，多一个键在部分供应商上同样是 400。
// content 是合法的字符串或块数组时按**语义**原样传下去：不 TrimSpace、不解析、不改结构、
// 不重排键序（赋的是未经 trim 的原始字节，所以 `"content":""` 与 `"content":" "` 不会被误判成空）。
// 但这里的"原样"同样是语义层面：json.Marshal 会 compact RawMessage 的块内空白并做 HTML 转义
// （`<` `>` `&` → `\u003c` `\u0026` `\u003e`），解析出的 JSON 值不变。
func toUpstreamMessages(in []AIMessage) []upstreamMessage {
	out := make([]upstreamMessage, len(in))
	for i, m := range in {
		out[i] = upstreamMessage{
			Role:       m.Role,
			ToolCallID: m.ToolCallID,
		}
		if c := bytes.TrimSpace(m.Content); len(c) > 0 && !bytes.Equal(c, []byte("null")) {
			out[i].Content = m.Content
		}
		if len(m.ToolCalls) == 0 {
			continue
		}
		out[i].ToolCalls = make([]upstreamToolCall, len(m.ToolCalls))
		for j, tc := range m.ToolCalls {
			out[i].ToolCalls[j].ID = tc.ID
			// 上游协议里这个字段恒为 "function"；客户端契约里没有它，故在此补上。
			out[i].ToolCalls[j].Type = "function"
			out[i].ToolCalls[j].Function.Name = tc.Name
			out[i].ToolCalls[j].Function.Arguments = tc.Arguments
		}
	}
	return out
}

// AIService 是 OpenAI 兼容协议的适配层（规格 §6.1）。
// 它只做转发与归一化，**不读一行账目数据**。
type AIService struct {
	apiKey     string
	baseURL    string
	model      string
	host       string
	maxTokens  int
	httpClient *http.Client
}

func NewAIService(cfg *config.Config) *AIService {
	return &AIService{
		apiKey:    cfg.AIAPIKey,
		baseURL:   strings.TrimRight(cfg.AIBaseURL, "/"),
		model:     cfg.AIModel,
		host:      cfg.AIHost(),
		maxTokens: cfg.AIMaxTokens,
		// 超时必须设在 client 上：chi 无全局超时中间件，否则半死上游会挂住 goroutine（规格 §6.4）。
		httpClient: &http.Client{Timeout: cfg.AITimeout},
	}
}

// Enabled 报告 AI 功能是否可用（AI_API_KEY 非空）。
func (s *AIService) Enabled() bool { return s.apiKey != "" }

// Status 返回给客户端的启用状态与供应商域名（规格 §6.1）。不含 key。
func (s *AIService) Status() AIStatus {
	return AIStatus{Enabled: s.Enabled(), Model: s.model, Host: s.host}
}

// Chat 调上游并把响应归一化（规格 §6.1）。
func (s *AIService) Chat(ctx context.Context, req AIChatRequest) (*AIChatResponse, error) {
	if !s.Enabled() {
		return nil, &AIError{Code: AICodeDisabled}
	}

	payload, err := json.Marshal(upstreamChatRequest{
		Model: s.model,
		// 入向转换：客户端契约（扁平）→ 上游请求体（嵌套）。
		Messages:  toUpstreamMessages(req.Messages),
		Tools:     req.Tools,
		MaxTokens: s.maxTokens,
	})
	if err != nil {
		return nil, &AIError{Code: AICodeUpstreamError, Err: err}
	}

	start := time.Now()
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		s.baseURL+"/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return nil, &AIError{Code: AICodeUnreachable, Err: err}
	}
	httpReq.Header.Set("Content-Type", "application/json")
	// key 只出现在这里，永远不下发给客户端、不进日志、不进响应体。
	httpReq.Header.Set("Authorization", "Bearer "+s.apiKey)

	resp, err := s.httpClient.Do(httpReq)
	if err != nil {
		return nil, mapTransportError(err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxUpstreamBodyBytes))
	if err != nil {
		return nil, &AIError{Code: AICodeUnreachable, Err: err}
	}

	if resp.StatusCode != http.StatusOK {
		// 只有 200 算成功：上游错误体只用于判断，不转发、不记内容（规格 §6.5/§6.6）。
		// 3xx 也走这里——Go 的 http.Client 对不带 Location 的 3xx（golang/go#17773）
		// 与 304 会把响应原样交回，所以"非 200 即失败"必须由这里保证。
		return nil, &AIError{Code: codeForUpstreamStatus(resp.StatusCode), Upstream: resp.StatusCode}
	}

	out, err := normalizeUpstream(raw)
	if err != nil {
		return nil, err
	}
	// 规格 §6.5：记用量，不记内容。这条日志里没有任何用户数据。
	log.Printf("ai upstream ok elapsed=%s finish_reason=%s prompt_tokens=%d completion_tokens=%d upstream=%d",
		time.Since(start).Round(time.Millisecond), out.FinishReason,
		out.Usage.PromptTokens, out.Usage.CompletionTokens, resp.StatusCode)
	return out, nil
}

// normalizeUpstream 把上游 choices[0].message 映射成客户端契约（规格 §6.1）。
// **出向转换**就在这里：上游嵌套的 `function:{name,arguments}` 被摊平成
// `{id, name, arguments}`，上游的 `type:"function"` 被丢掉——客户端契约里没有它。
func normalizeUpstream(raw []byte) (*AIChatResponse, error) {
	var up upstreamChatResponse
	if err := json.Unmarshal(raw, &up); err != nil {
		return nil, &AIError{Code: AICodeUpstreamError, Err: err}
	}
	if len(up.Choices) == 0 {
		return nil, &AIError{Code: AICodeUpstreamError, Err: errors.New("upstream returned no choices")}
	}
	msg := up.Choices[0].Message
	// tool_calls 必须是 [] 而不是 null：客户端会直接遍历它，
	// null 与 [] 在 JS 里行为不同——"形状静默不同"是这类适配层最典型的坑。
	toolCalls := make([]AIToolCall, 0, len(msg.ToolCalls))
	for _, tc := range msg.ToolCalls {
		toolCalls = append(toolCalls, AIToolCall{
			ID:        tc.ID,
			Name:      tc.Function.Name,
			Arguments: tc.Function.Arguments,
		})
	}
	return &AIChatResponse{
		Text:         msg.Content,
		ToolCalls:    toolCalls,
		Usage:        up.Usage,
		FinishReason: up.Choices[0].FinishReason,
	}, nil
}

// mapTransportError 区分「超时」与「不可达」：两者客户端文案不同
// （超时→"分析超时，请重试"；不可达→"AI 服务不可达"），混在一起用户不知道该怎么办。
func mapTransportError(err error) error {
	// http.Client.Timeout 触发的超时被包成 *url.Error，errors.Is 能穿透。
	if errors.Is(err, context.DeadlineExceeded) {
		return &AIError{Code: AICodeUpstreamTimeout, Err: err}
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return &AIError{Code: AICodeUpstreamTimeout, Err: err}
	}
	return &AIError{Code: AICodeUnreachable, Err: err}
}

// codeForUpstreamStatus 把上游状态码映射成错误码（规格 §6.6）。
// 401/403 → 配置有误；429 → 上游限流；5xx → 与超时同类（规格这么定的）；
// 其余（3xx、未列出的 4xx）→ ai_upstream_error。
// 规格的表没列这一类，但**任何状态都必须有确定映射**，否则会出现未定义行为。
func codeForUpstreamStatus(status int) string {
	switch {
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return AICodeUpstreamAuth
	case status == http.StatusTooManyRequests:
		return AICodeRateLimited
	case status >= 500:
		return AICodeUpstreamTimeout
	default:
		return AICodeUpstreamError
	}
}
