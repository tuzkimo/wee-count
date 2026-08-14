package service

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
)

func TestCanReadLedgerAllowsOwner(t *testing.T) {
	fq := &fakeQuerier{rows: []pgx.Row{fakeRow{vals: []any{true}}}}
	if err := canReadLedger(context.Background(), fq, "user-1", "ledger-1"); err != nil {
		t.Fatalf("owner 应通过，got %v", err)
	}
}

func TestCanReadLedgerRejectsNonMember(t *testing.T) {
	fq := &fakeQuerier{rows: []pgx.Row{fakeRow{vals: []any{false}}}}
	err := canReadLedger(context.Background(), fq, "user-1", "ledger-1")
	if !errors.Is(err, ErrNotLedgerMember) {
		t.Fatalf("非成员应返回 ErrNotLedgerMember，got %v", err)
	}
}

func TestCanReadLedgerPropagatesRealError(t *testing.T) {
	realErr := errors.New("connection reset by peer")
	fq := &fakeQuerier{rows: []pgx.Row{fakeRow{scanErr: realErr}}}
	err := canReadLedger(context.Background(), fq, "user-1", "ledger-1")
	if !errors.Is(err, realErr) {
		t.Fatalf("真实 DB 错误应透传，got %v", err)
	}
}
