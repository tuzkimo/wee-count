// backend/internal/handler/team.go
package handler

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"wee-count/backend/internal/middleware"
	"wee-count/backend/internal/service"
)

type TeamHandler struct {
	svc *service.TeamService
}

func NewTeamHandler(svc *service.TeamService) *TeamHandler {
	return &TeamHandler{svc: svc}
}

type createTeamRequest struct {
	Name string `json:"name"`
}

func (h *TeamHandler) Create(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())

	var req createTeamRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Name == "" {
		writeError(w, http.StatusBadRequest, "team name is required")
		return
	}

	resp, err := h.svc.CreateTeam(r.Context(), userID, req.Name)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create team")
		return
	}

	writeJSON(w, http.StatusCreated, resp)
}

type inviteResponse struct {
	InviteCode string `json:"invite_code"`
	ExpiresIn  int    `json:"expires_in"`
}

func (h *TeamHandler) Invite(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	teamID := chi.URLParam(r, "id")

	code, err := h.svc.CreateInvite(r.Context(), userID, teamID)
	if err != nil {
		writeError(w, http.StatusForbidden, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, inviteResponse{
		InviteCode: code,
		ExpiresIn:  86400,
	})
}

type joinRequest struct {
	InviteCode string `json:"invite_code"`
}

func (h *TeamHandler) Join(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())

	var req joinRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.InviteCode == "" {
		writeError(w, http.StatusBadRequest, "invite_code is required")
		return
	}

	resp, err := h.svc.JoinByInvite(r.Context(), userID, req.InviteCode)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, resp)
}

func (h *TeamHandler) Members(w http.ResponseWriter, r *http.Request) {
	teamID := chi.URLParam(r, "id")
	members, err := h.svc.ListMembers(r.Context(), teamID)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, members)
}
