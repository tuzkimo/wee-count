package service

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
)

func TestEnsureTeamMemberRejectsNonMember(t *testing.T) {
	s := &TeamService{}
	fq := &fakeQuerier{rows: []pgx.Row{fakeRow{vals: []any{false}}}} // isMember=false

	err := s.ensureTeamMember(context.Background(), fq, "user-1", "team-1")
	if !errors.Is(err, ErrNotTeamMember) {
		t.Fatalf("非成员应返回 ErrNotTeamMember，got %v", err)
	}
}

func TestEnsureTeamMemberAcceptsMember(t *testing.T) {
	s := &TeamService{}
	fq := &fakeQuerier{rows: []pgx.Row{fakeRow{vals: []any{true}}}} // isMember=true

	if err := s.ensureTeamMember(context.Background(), fq, "user-1", "team-1"); err != nil {
		t.Fatalf("成员应通过校验，got %v", err)
	}
}
