package handler

import (
	"encoding/json"
	"log"
	"net/http"

	"wee-count/backend/internal/middleware"
	"wee-count/backend/internal/model"
	"wee-count/backend/internal/service"
)

type SyncHandler struct {
	svc *service.SyncService
}

// 同步请求体上限。全量首同步会上传本地全部数据，故上限比 auth/team 的 1MB 宽松得多；
// 但仍必须设限，否则任意注册用户可用超大 body 打满服务端内存，并在写事务内长时间独占
// 全局 advisory 写锁，串行化所有用户的同步（横向 DoS）。
// 用 var 而非 const，便于测试用小值触发超限分支。
var maxSyncBodyBytes int64 = 32 << 20 // 32MB

func NewSyncHandler(svc *service.SyncService) *SyncHandler {
	return &SyncHandler{svc: svc}
}

func (h *SyncHandler) Sync(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxSyncBodyBytes)

	var req model.SyncRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		log.Printf("sync bad request for user %s: %v", userID, err)
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	resp, err := h.svc.Sync(r.Context(), userID, req)
	if err != nil {
		log.Printf("sync error for user %s: %v", userID, err)
		writeError(w, http.StatusInternalServerError, "sync failed")
		return
	}

	writeJSON(w, http.StatusOK, resp)
}
