// backend/internal/handler/ai.go
package handler

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"

	"wee-count/backend/internal/middleware"
	"wee-count/backend/internal/service"
)

// maxAIBodyBytes 是 AI 请求体上限（规格 §6.4）：256KB。
// 消息历史 + 工具 schema 约几十 KB，这个上限防的是有人塞巨型 body。
// 用 var 而非 const，便于测试用小值触发超限分支（与 maxSyncBodyBytes 同理）。
var maxAIBodyBytes int64 = 256 << 10

type AIHandler struct {
	svc *service.AIService
}

func NewAIHandler(svc *service.AIService) *AIHandler {
	return &AIHandler{svc: svc}
}

func (h *AIHandler) Chat(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxAIBodyBytes)

	var req service.AIChatRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		// 超限与非法 JSON 必须区分：规格 §8.D 要求超限是 413，
		// 而 MaxBytesReader 触发的错误在 decode 里表现为 *http.MaxBytesError。
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeError(w, http.StatusRequestEntityTooLarge, "request body too large")
			return
		}
		log.Printf("ai bad request for user %s: %v", userID, err)
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(req.Messages) == 0 {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	start := time.Now()
	resp, err := h.svc.Chat(r.Context(), req)
	if err != nil {
		code, status := aiErrorStatus(err)
		// 规格 §6.5：只记 user_id / 耗时 / 错误码，不记内容。
		log.Printf("ai chat failed user=%s elapsed=%s code=%s",
			userID, time.Since(start).Round(time.Millisecond), code)
		writeError(w, status, code)
		return
	}

	log.Printf("ai chat user=%s elapsed=%s finish_reason=%s prompt_tokens=%d completion_tokens=%d",
		userID, time.Since(start).Round(time.Millisecond), resp.FinishReason,
		resp.Usage.PromptTokens, resp.Usage.CompletionTokens)
	writeJSON(w, http.StatusOK, resp)
}

func (h *AIHandler) Status(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, h.svc.Status())
}

// aiErrorStatus 把 service 的错误映射成 (错误码, HTTP 状态码)（规格 §6.6）。
// 未知错误一律当作"不可达"——宁可说不可达，也不要把内部错误细节说出去。
func aiErrorStatus(err error) (string, int) {
	var aiErr *service.AIError
	if !errors.As(err, &aiErr) {
		return service.AICodeUnreachable, http.StatusBadGateway
	}
	switch aiErr.Code {
	case service.AICodeDisabled:
		return aiErr.Code, http.StatusServiceUnavailable
	case service.AICodeUpstreamAuth, service.AICodeUpstreamError, service.AICodeUnreachable:
		return aiErr.Code, http.StatusBadGateway
	case service.AICodeRateLimited:
		return aiErr.Code, http.StatusTooManyRequests
	case service.AICodeUpstreamTimeout:
		return aiErr.Code, http.StatusGatewayTimeout
	default:
		return service.AICodeUnreachable, http.StatusBadGateway
	}
}
