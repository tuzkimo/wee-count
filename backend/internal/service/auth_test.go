// backend/internal/service/auth_test.go
package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/crypto/bcrypt"
)

// fakeExec 是只用于 insertUser 的 dbQuerier 手写 fake：Exec 返回可配置错误。
type fakeExec struct {
	err error
}

func (f fakeExec) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	return nil, nil
}

func (f fakeExec) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return nil
}

func (f fakeExec) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, f.err
}

func TestHashAndCheckPassword(t *testing.T) {
	password := "test-password-123"
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		t.Fatalf("GenerateFromPassword: %v", err)
	}

	if err := bcrypt.CompareHashAndPassword(hash, []byte(password)); err != nil {
		t.Errorf("password should match: %v", err)
	}
	if err := bcrypt.CompareHashAndPassword(hash, []byte("wrong-password")); err == nil {
		t.Error("wrong password should not match")
	}
}

// 并发同名注册撞 users_username_unique（23505）时，Register 的 INSERT 应映射为
// ErrUsernameTaken（409），而非把唯一冲突当作 500 返回。
func TestInsertUserUniqueViolationReturnsErrUsernameTaken(t *testing.T) {
	q := fakeExec{err: &pgconn.PgError{Code: "23505"}}
	err := insertUser(context.Background(), q, "id-1", "dup", "dup", "hash", time.Now())
	if !errors.Is(err, ErrUsernameTaken) {
		t.Fatalf("23505 应返回 ErrUsernameTaken，got %v", err)
	}
}

// 非 23505 的其它 DB 错误应透传（包一层 insert user），不得误映射为 ErrUsernameTaken。
func TestInsertUserNonUniqueErrorWraps(t *testing.T) {
	realErr := errors.New("connection reset by peer")
	q := fakeExec{err: realErr}
	err := insertUser(context.Background(), q, "id-1", "u", "u", "hash", time.Now())
	if !errors.Is(err, realErr) {
		t.Fatalf("非 23505 错误应透传，got %v", err)
	}
	if errors.Is(err, ErrUsernameTaken) {
		t.Fatalf("非 23505 错误不应映射为 ErrUsernameTaken，got %v", err)
	}
}

// 经邀请加入的成员（非 owner）重启后，GetMe 应能拿到共享团队账本：
// 账本查询口径须与 sync 的 getUserLedgerIDs 一致（owner UNION team_members）。
func TestGetMeIncludesTeamMemberSharedLedger(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Millisecond)

	fq := &fakeQuerier{
		rows: []pgx.Row{
			fakeRow{vals: []any{"member-1", "member", "成员", nil, now, now}}, // user
		},
		query: &fakeRows{rows: [][]any{
			{"L1", "共享账本", "team", "team-1", "owner-1", now, now, false},
		}},
	}

	resp, err := getMe(context.Background(), fq, "member-1")
	if err != nil {
		t.Fatalf("getMe: %v", err)
	}

	if len(resp.Ledgers) != 1 || resp.Ledgers[0].ID != "L1" || resp.Ledgers[0].Type != "team" {
		t.Fatalf("ledgers 应包含成员非 owner 的共享账本 L1，got %+v", resp.Ledgers)
	}
	if len(resp.Teams) != 1 || resp.Teams[0].ID != "L1" {
		t.Fatalf("teams 应从同一批里筛出 type='team' 的 L1，got %+v", resp.Teams)
	}

	// 账本查询须 JOIN team_members（owner UNION 成员），与 sync 的 getUserLedgerIDs 口径一致。
	if len(fq.queries) == 0 {
		t.Fatal("应执行账本 Query")
	}
	q := fq.queries[0]
	if !strings.Contains(q.sql, "JOIN team_members") {
		t.Fatalf("账本查询应 JOIN team_members，got %s", q.sql)
	}
	if len(q.args) < 1 || q.args[0] != "member-1" {
		t.Fatalf("应以当前 userID 过滤，got %v", q.args)
	}
}
