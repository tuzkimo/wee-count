package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"wee-count/backend/internal/model"
)

// --- 手写 fake dbQuerier（避免引入 pgxmock 依赖；生产传 pgxpool.Pool / pgx.Tx） ---

type fakeRow struct {
	scanErr error
	vals    []any
}

func (r fakeRow) Scan(dest ...any) error {
	if r.scanErr != nil {
		return r.scanErr
	}
	for i, v := range r.vals {
		if i >= len(dest) {
			break
		}
		switch d := dest[i].(type) {
		case *time.Time:
			*d = v.(time.Time)
		case *string:
			*d = v.(string)
		case *bool:
			*d = v.(bool)
		}
	}
	return nil
}

type fakeRows struct {
	rows [][]any
	idx  int
}

func (r *fakeRows) Next() bool { r.idx++; return r.idx <= len(r.rows) }
func (r *fakeRows) Scan(dest ...any) error {
	row := r.rows[r.idx-1]
	for i, v := range row {
		if i >= len(dest) {
			break
		}
		switch d := dest[i].(type) {
		case *string:
			*d = v.(string)
		case *time.Time:
			*d = v.(time.Time)
		}
	}
	return nil
}
func (r *fakeRows) Values() ([]any, error)                      { return nil, nil }
func (r *fakeRows) RawValues() [][]byte                          { return nil }
func (r *fakeRows) Conn() *pgx.Conn                              { return nil }
func (r *fakeRows) CommandTag() pgconn.CommandTag                { return pgconn.CommandTag{} }
func (r *fakeRows) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (r *fakeRows) Err() error                                   { return nil }
func (r *fakeRows) Close()                                       {}

type execCall struct {
	sql  string
	args []any
}

type fakeQuerier struct {
	rows    []pgx.Row // QueryRow 队列
	query   *fakeRows // Query 返回的结果集
	execs   []execCall
	queries []execCall
}

func (f *fakeQuerier) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	f.queries = append(f.queries, execCall{sql: sql, args: args})
	if f.query != nil {
		return f.query, nil
	}
	return &fakeRows{}, nil
}

func (f *fakeQuerier) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if len(f.rows) > 0 {
		r := f.rows[0]
		f.rows = f.rows[1:]
		return r
	}
	return fakeRow{scanErr: pgx.ErrNoRows}
}

func (f *fakeQuerier) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	f.execs = append(f.execs, execCall{sql: sql, args: args})
	return pgconn.CommandTag{}, nil
}

func (f *fakeQuerier) execSQLContains(sub string) bool {
	for _, e := range f.execs {
		if strings.Contains(e.sql, sub) {
			return true
		}
	}
	return false
}

// --- 回归测试 ---

// S3：命中同名同类型重复分类且本地更旧时应跳过，不返回外层 pgx.ErrNoRows 导致 500。
func TestLwwMergeCategoryDuplicateOlderSkips(t *testing.T) {
	s := &SyncService{}
	older := time.Now().Add(-time.Hour)
	dupTime := time.Now()

	fq := &fakeQuerier{rows: []pgx.Row{
		fakeRow{scanErr: pgx.ErrNoRows},            // 按 id 查不存在
		fakeRow{vals: []any{"dup-cat", dupTime}},   // 同名同类命中（id, updated_at）
	}}

	c := model.Category{ID: "new-uuid", LedgerID: "L1", Name: "餐饮", Type: "expense", UpdatedAt: older}

	if err := s.lwwMergeCategory(context.Background(), fq, c); err != nil {
		t.Fatalf("本地更旧的重复分类应跳过且不报错，got err=%v", err)
	}
	if fq.execSQLContains("UPDATE categories") {
		t.Fatalf("不应 UPDATE 更旧的重复分类，execs=%v", fq.execs)
	}
}

// S8：Scan 返回非 ErrNoRows 的真实错误时应透传，而非误判为「不存在」去 INSERT。
func TestLwwMergeLedgerReturnsRealScanError(t *testing.T) {
	s := &SyncService{}
	realErr := errors.New("connection reset by peer")
	fq := &fakeQuerier{rows: []pgx.Row{
		fakeRow{vals: []any{true}}, // canReadLedger：有权限
		fakeRow{scanErr: realErr},  // mergeByKey：真实 DB 错误
	}}

	l := model.Ledger{ID: "L1", Name: "账本", Type: "personal", UpdatedAt: time.Now()}

	err := s.lwwMergeLedger(context.Background(), fq, "user-1", l)
	if !errors.Is(err, realErr) {
		t.Fatalf("应透传真实 DB 错误，got %v", err)
	}
	if len(fq.execs) != 0 {
		t.Fatalf("真实错误不应触发 INSERT，但执行了 %d 次 Exec", len(fq.execs))
	}
}

// 归属加固：UPDATE 不得含 owner_id/team_id。
func TestLwwMergeLedgerUpdateExcludesOwnership(t *testing.T) {
	s := &SyncService{}
	now := time.Now()
	fq := &fakeQuerier{rows: []pgx.Row{
		fakeRow{vals: []any{true}},                // canReadLedger：有权限
		fakeRow{vals: []any{now.Add(-time.Hour)}}, // mergeByKey：已存在且更旧 → UPDATE
	}}

	l := model.Ledger{ID: "L1", Name: "账本", Type: "personal", OwnerID: "attacker", UpdatedAt: now}

	if err := s.lwwMergeLedger(context.Background(), fq, "user-1", l); err != nil {
		t.Fatal(err)
	}
	if len(fq.execs) == 0 {
		t.Fatal("应执行 UPDATE")
	}
	upd := fq.execs[0]
	if !strings.Contains(upd.sql, "UPDATE ledgers") {
		t.Fatalf("首条应为 UPDATE，got %s", upd.sql)
	}
	if strings.Contains(upd.sql, "owner_id") || strings.Contains(upd.sql, "team_id") || strings.Contains(upd.sql, "is_deleted") {
		t.Fatalf("UPDATE 不得含归属/删除字段，got %s", upd.sql)
	}
}

// 归属加固：INSERT 强制 owner=userID、team_id=NULL（防御性，实际因 canReadLedger 拒绝不存在账本而不可达）。
func TestLwwMergeLedgerInsertForcesOwner(t *testing.T) {
	s := &SyncService{}
	fq := &fakeQuerier{rows: []pgx.Row{
		fakeRow{vals: []any{true}},      // canReadLedger：有权限
		fakeRow{scanErr: pgx.ErrNoRows}, // mergeByKey：不存在 → INSERT
	}}

	l := model.Ledger{ID: "L1", Name: "账本", Type: "personal", OwnerID: "attacker", UpdatedAt: time.Now()}

	if err := s.lwwMergeLedger(context.Background(), fq, "user-1", l); err != nil {
		t.Fatal(err)
	}
	if len(fq.execs) == 0 {
		t.Fatal("应执行 INSERT")
	}
	ins := fq.execs[0]
	if !strings.Contains(ins.sql, "INSERT INTO ledgers") {
		t.Fatalf("首条应为 INSERT，got %s", ins.sql)
	}
	if len(ins.args) < 4 || ins.args[3] != "user-1" {
		t.Fatalf("owner_id 应强制为 user-1，got %v", ins.args)
	}
	if !strings.Contains(ins.sql, "NULL") {
		t.Fatalf("team_id 应为 NULL，got %s", ins.sql)
	}
	if strings.Contains(ins.sql, "is_deleted") {
		t.Fatalf("INSERT 不得含 is_deleted 字段（应默认 false），got %s", ins.sql)
	}
}

// 无权限：canReadLedger 返回 ErrNotLedgerMember，merge 不执行。
func TestLwwMergeLedgerUnauthorized(t *testing.T) {
	s := &SyncService{}
	fq := &fakeQuerier{rows: []pgx.Row{fakeRow{vals: []any{false}}}} // canReadLedger：无权限

	l := model.Ledger{ID: "L1", Name: "账本", Type: "personal", UpdatedAt: time.Now()}

	err := s.lwwMergeLedger(context.Background(), fq, "user-1", l)
	if !errors.Is(err, ErrNotLedgerMember) {
		t.Fatalf("无权限应返回 ErrNotLedgerMember，got %v", err)
	}
	if len(fq.execs) != 0 {
		t.Fatalf("无权限不应执行任何写，execs=%v", fq.execs)
	}
}

// S1b：空标签也应清理旧 transaction_tags 关联，否则服务端旧标签会被回传「复活」。
func TestLwwMergeTransactionEmptyTagsStillClears(t *testing.T) {
	s := &SyncService{}
	older := time.Now().Add(-time.Hour)
	newer := time.Now()
	fq := &fakeQuerier{rows: []pgx.Row{fakeRow{vals: []any{older}}}} // 已存在且更旧

	tx := model.Transaction{
		ID: "tx1", LedgerID: "L1", UserID: "u1", Type: "expense",
		Amount: 10, UpdatedAt: newer, TagIDs: []string{},
	}

	if err := s.lwwMergeTransaction(context.Background(), fq, tx); err != nil {
		t.Fatal(err)
	}
	if !fq.execSQLContains("DELETE FROM transaction_tags") {
		t.Fatalf("空标签也应清理旧关联，但未执行 DELETE；execs=%v", fq.execs)
	}
	if fq.execSQLContains("INSERT INTO transaction_tags") {
		t.Fatalf("空标签不应执行 INSERT；execs=%v", fq.execs)
	}
}

// Sec5（写）：member_aliases 的 setter 应强制用服务端当前用户，忽略客户端值，防伪造。
func TestLwwMergeMemberAliasForcesSetter(t *testing.T) {
	s := &SyncService{}
	fq := &fakeQuerier{rows: []pgx.Row{fakeRow{scanErr: pgx.ErrNoRows}}} // 不存在 → INSERT

	ma := model.MemberAlias{SetterUserID: "attacker", TargetUserID: "victim", AliasName: "别名", UpdatedAt: time.Now()}

	if err := s.lwwMergeMemberAlias(context.Background(), fq, "real-user", ma); err != nil {
		t.Fatal(err)
	}
	if len(fq.execs) == 0 {
		t.Fatal("应执行 INSERT")
	}
	ins := fq.execs[0]
	if !strings.Contains(ins.sql, "INSERT INTO member_aliases") {
		t.Fatalf("首条应为 INSERT，got %s", ins.sql)
	}
	if len(ins.args) < 1 || ins.args[0] != "real-user" {
		t.Fatalf("setter 应为 real-user，got %v", ins.args)
	}
}

// Sec5（读）：queryMemberAliases 应按 setter 过滤，避免向任意用户返回全量别名。
func TestQueryMemberAliasesFiltersBySetter(t *testing.T) {
	s := &SyncService{}
	fq := &fakeQuerier{}
	since := time.Now().Add(-time.Hour)

	if _, err := s.queryMemberAliases(context.Background(), fq, "real-user", since); err != nil {
		t.Fatal(err)
	}
	if len(fq.queries) == 0 {
		t.Fatal("应执行 Query")
	}
	q := fq.queries[0]
	if !strings.Contains(q.sql, "setter_user_id = $1") {
		t.Fatalf("SQL 应按 setter 过滤，got %s", q.sql)
	}
	if len(q.args) < 1 || q.args[0] != "real-user" {
		t.Fatalf("应传 userID 作为 setter 过滤参数，got %v", q.args)
	}
}
