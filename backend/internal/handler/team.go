// backend/internal/handler/team.go
package handler

import (
	"encoding/json"
	"errors"
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

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20) // 1MB 上限，防超大 body DoS
	var req createTeamRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Name == "" {
		writeError(w, http.StatusBadRequest, "team name is required")
		return
	}
	if len(req.Name) > 100 {
		writeError(w, http.StatusBadRequest, "team name too long")
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
		switch {
		case errors.Is(err, service.ErrTeamNotFound):
			writeError(w, http.StatusNotFound, "team not found")
		case errors.Is(err, service.ErrNotTeamOwner):
			writeError(w, http.StatusForbidden, "only team owner can create invite")
		default:
			writeError(w, http.StatusInternalServerError, "internal error")
		}
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

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
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
		switch {
		case errors.Is(err, service.ErrInviteInvalid):
			writeError(w, http.StatusBadRequest, "invalid or expired invite code")
		case errors.Is(err, service.ErrAlreadyMember):
			writeError(w, http.StatusConflict, "already a member of this team")
		default:
			writeError(w, http.StatusInternalServerError, "internal error")
		}
		return
	}

	writeJSON(w, http.StatusOK, resp)
}

func (h *TeamHandler) Members(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	teamID := chi.URLParam(r, "id")
	members, err := h.svc.ListMembers(r.Context(), userID, teamID)
	if err != nil {
		if errors.Is(err, service.ErrNotTeamMember) {
			writeError(w, http.StatusForbidden, "not a team member")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to list members")
		return
	}
	writeJSON(w, http.StatusOK, members)
}
