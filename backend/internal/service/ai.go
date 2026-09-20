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

// AIMessage 是客户端 ↔ 后端的消息形状（规格 §6.1）。
// Content 是字符串而非多模态数组：v1 是文字进文字出（规格 §9 M2/M3）。
// M4 做截图时这里要改成 json.RawMessage——届时只改这一个类型。
type AIMessage struct {
	Role       string       `json:"role"`
	Content    string       `json:"content,omitempty"`
	ToolCallID string       `json:"tool_call_id,omitempty"`
	ToolCalls  []AIToolCall `json:"tool_calls,omitempty"`
}

type AIFunctionCall struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type AIToolCall struct {
	ID       string         `json:"id"`
	Type     string         `json:"type"`
	Function AIFunctionCall `json:"function"`
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
// 客户端的多余字段不会被转发。
type upstreamChatRequest struct {
	Model     string          `json:"model"`
	Messages  []AIMessage     `json:"messages"`
	Tools     json.RawMessage `json:"tools,omitempty"`
	MaxTokens int             `json:"max_tokens"`
}

type upstreamChatResponse struct {
	Choices []struct {
		Message      AIMessage `json:"message"`
		FinishReason string    `json:"finish_reason"`
	} `json:"choices"`
	Usage AIUsage `json:"usage"`
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
		Model:     s.model,
		Messages:  req.Messages,
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
	toolCalls := msg.ToolCalls
	if toolCalls == nil {
		toolCalls = []AIToolCall{}
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
