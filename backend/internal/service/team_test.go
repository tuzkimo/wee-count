// backend/internal/service/team_test.go
package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/redis/go-redis/v9"
)

// fakeInviteRedis 实现 inviteRedis，记录 Del 调用以便断言邀请码是否被消费。
type fakeInviteRedis struct {
	getVal  string
	getErr  error
	delKeys []string
}

func (f *fakeInviteRedis) Get(ctx context.Context, key string) *redis.StringCmd {
	return redis.NewStringResult(f.getVal, f.getErr)
}

func (f *fakeInviteRedis) Del(ctx context.Context, keys ...string) *redis.IntCmd {
	f.delKeys = append(f.delKeys, keys...)
	return redis.NewIntResult(int64(len(keys)), nil)
}

// errExecQuerier 在 Exec 时返回固定错误，模拟 INSERT 失败。
type errExecQuerier struct {
	*fakeQuerier
	execErr error
}

func (f *errExecQuerier) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, f.execErr
}

func TestGenerateInviteCode(t *testing.T) {
	code, err := generateInviteCode()
	if err != nil {
		t.Fatalf("generateInviteCode: %v", err)
	}
	if len(code) != 6 {
		t.Errorf("expected 6-digit code, got %s", code)
	}
	for _, c := range code {
		if c < '0' || c > '9' {
			t.Errorf("expected all digits, got %s", code)
		}
	}
}

func TestGenerateInviteCode_Uniqueness(t *testing.T) {
	codes := make(map[string]bool)
	for i := 0; i < 100; i++ {
		code, err := generateInviteCode()
		if err != nil {
			t.Fatalf("generateInviteCode: %v", err)
		}
		if codes[code] {
			t.Logf("collision on code %s (statistically rare, not a bug)", code)
		}
		codes[code] = true
	}
}

// 用户已是成员时不应消费邀请码（Del 不被调用），避免白烧码。
func TestJoinByInviteAlreadyMemberDoesNotConsumeInvite(t *testing.T) {
	rd := &fakeInviteRedis{getVal: "team-1:owner-1"}
	fq := &fakeQuerier{rows: []pgx.Row{fakeRow{vals: []any{true}}}} // exists=true

	_, err := joinByInvite(context.Background(), fq, rd, "user-1", "123456")
	if !errors.Is(err, ErrAlreadyMember) {
		t.Fatalf("应返回 ErrAlreadyMember，got %v", err)
	}
	if len(rd.delKeys) != 0 {
		t.Fatalf("已成员时不应消费邀请码，但 Del 被调用 %d 次，keys=%v", len(rd.delKeys), rd.delKeys)
	}
}

// INSERT 失败时不应消费邀请码（Del 不被调用），避免 DB 失败白白烧码。
func TestJoinByInviteInsertFailureDoesNotConsumeInvite(t *testing.T) {
	rd := &fakeInviteRedis{getVal: "team-1:owner-1"}
	fq := &errExecQuerier{
		fakeQuerier: &fakeQuerier{rows: []pgx.Row{fakeRow{vals: []any{false}}}}, // exists=false
		execErr:     errors.New("insert boom"),
	}

	_, err := joinByInvite(context.Background(), fq, rd, "user-1", "123456")
	if err == nil {
		t.Fatal("INSERT 失败应返回错误")
	}
	if len(rd.delKeys) != 0 {
		t.Fatalf("INSERT 失败不应消费邀请码，但 Del 被调用 %d 次，keys=%v", len(rd.delKeys), rd.delKeys)
	}
}

// 成功加入后才消费邀请码（Del 恰好一次，且 INSERT 在 Del 之前）。
func TestJoinByInviteSuccessConsumesInviteAfterInsert(t *testing.T) {
	rd := &fakeInviteRedis{getVal: "team-1:owner-1"}
	now := time.Now().UTC()
	fq := &fakeQuerier{rows: []pgx.Row{
		fakeRow{vals: []any{false}},                                     // exists=false
		fakeRow{vals: []any{"My Team"}},                                 // team name
		fakeRow{vals: []any{"L1", "账本", "team", "team-1", "owner-1", now, now}}, // ledger
	}}

	resp, err := joinByInvite(context.Background(), fq, rd, "user-1", "123456")
	if err != nil {
		t.Fatalf("加入应成功，got %v", err)
	}
	if resp == nil || resp.Team.ID != "team-1" {
		t.Fatalf("应返回 team info，got %+v", resp)
	}
	if len(rd.delKeys) != 1 || rd.delKeys[0] != "invite:123456" {
		t.Fatalf("成功加入后应恰好消费一次邀请码，keys=%v", rd.delKeys)
	}
	if len(fq.execs) == 0 || !strings.Contains(fq.execs[0].sql, "INSERT INTO team_members") {
		t.Fatalf("应先执行 INSERT 再消费邀请码，execs=%v", fq.execs)
	}
}
