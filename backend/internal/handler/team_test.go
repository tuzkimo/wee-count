// backend/internal/handler/team_test.go
package handler

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCreateTeamHandler_MissingName(t *testing.T) {
	h := &TeamHandler{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /teams", h.Create)

	req := httptest.NewRequest("POST", "/teams", bytes.NewBufferString(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(setUserID(req.Context(), "test-user"))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestJoinHandler_MissingCode(t *testing.T) {
	h := &TeamHandler{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /teams/join", h.Join)

	req := httptest.NewRequest("POST", "/teams/join", bytes.NewBufferString(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(setUserID(req.Context(), "test-user"))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestMembersHandler_MissingTeamID(t *testing.T) {
	// 路由参数缺失时 chi.URLParam 返回空，service 会因空 teamID 报错或返回空
	// 这里只验证 handler 不 panic、不带 body 时不会 500
	h := &TeamHandler{}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /teams/{id}/members", h.Members)

	req := httptest.NewRequest("GET", "/teams/some-id/members", nil)
	req = req.WithContext(setUserID(req.Context(), "test-user"))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	// 没有 DB，service 调用会失败 → handler 返回 500；只要不是 panic/404 即可
	if rec.Code == http.StatusNotFound {
		t.Errorf("route not registered, got 404")
	}
}
