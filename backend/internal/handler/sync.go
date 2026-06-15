package handler

import (
	"encoding/json"
	"net/http"

	"wee-count/backend/internal/middleware"
	"wee-count/backend/internal/model"
	"wee-count/backend/internal/service"
)

type SyncHandler struct {
	svc *service.SyncService
}

func NewSyncHandler(svc *service.SyncService) *SyncHandler {
	return &SyncHandler{svc: svc}
}

func (h *SyncHandler) Sync(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var req model.SyncRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	resp, err := h.svc.Sync(r.Context(), userID, req)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "sync failed")
		return
	}

	writeJSON(w, http.StatusOK, resp)
}
