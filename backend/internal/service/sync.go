package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"wee-count/backend/internal/model"
)

// dbQuerier 是同步服务所需的最小数据库接口：生产传 pgxpool.Pool / pgx.Tx，
// 测试注入 fake，避免引入重型 DB mock 依赖。
type dbQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// mergeByKey 是各实体 LWW merge 的公共骨架：
//   1) 按主键查 updated_at
//   2) 不存在(ErrNoRows) → insert()
//   3) 真实错误 → 直接透传（不误判为「不存在」）
//   4) 存在但 incoming 更旧/相同 → 跳过
//   5) incoming 更新 → update()
func mergeByKey(ctx context.Context, tx dbQuerier, incoming time.Time,
	keySQL string, keyArgs []any, insert, update func() error) error {
	var remote time.Time
	// FOR UPDATE：锁定已存在行，避免两个事务并发 SELECT 到旧 updated_at 后双双 UPDATE，
	// 较旧写入覆盖较新写入（破坏 LWW）。仅在 applyLocalChanges 的读写事务内使用，不涉及只读事务。
	err := tx.QueryRow(ctx, keySQL+" FOR UPDATE", keyArgs...).Scan(&remote)
	if errors.Is(err, pgx.ErrNoRows) {
		// 不存在 → INSERT；若并发已插入（主键/唯一冲突 23505），回退为 UPDATE
		err := insert()
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return update()
		}
		return err
	}
	if err != nil {
		return err
	}
	if !incoming.After(remote) {
		return nil
	}
	return update()
}

type SyncService struct {
	pool *pgxpool.Pool
}

func NewSyncService(pool *pgxpool.Pool) *SyncService {
	return &SyncService{pool: pool}
}

// Sync executes bidirectional incremental sync
func (s *SyncService) Sync(ctx context.Context, userID string, req model.SyncRequest) (*model.SyncResponse, error) {
	// 1. Get all ledger IDs the user has access to
	ledgerIDs, err := s.getUserLedgerIDs(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("getUserLedgerIDs: %w", err)
	}

	// 2. Apply local changes (LWW merge)
	if err := s.applyLocalChanges(ctx, userID, ledgerIDs, req.LocalChanges); err != nil {
		return nil, fmt.Errorf("applyLocalChanges: %w", err)
	}

	// 3. 读 + 游标推进放入单个 REPEATABLE READ 只读事务，游标取快照内的全局 MAX(server_seq)。
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, fmt.Errorf("begin read tx: %w", err)
	}
	defer tx.Rollback(ctx)

	remoteChanges, err := s.getRemoteChanges(ctx, tx, userID, ledgerIDs, req.LastServerSeq)
	if err != nil {
		return nil, fmt.Errorf("getRemoteChanges: %w", err)
	}

	var cursor int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(s), 0) FROM (
		SELECT MAX(server_seq) AS s FROM ledgers
		UNION ALL SELECT MAX(server_seq) FROM accounts
		UNION ALL SELECT MAX(server_seq) FROM categories
		UNION ALL SELECT MAX(server_seq) FROM tags
		UNION ALL SELECT MAX(server_seq) FROM transactions
		UNION ALL SELECT MAX(server_seq) FROM member_aliases
	) m`).Scan(&cursor); err != nil {
		return nil, fmt.Errorf("read cursor: %w", err)
	}

	return &model.SyncResponse{
		ServerSeq:     cursor,
		RemoteChanges: remoteChanges,
	}, nil
}

// getUserLedgerIDs returns all ledger IDs the user has access to
func (s *SyncService) getUserLedgerIDs(ctx context.Context, userID string) ([]string, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id FROM ledgers WHERE owner_id = $1 AND is_deleted = FALSE
		 UNION
		 SELECT l.id FROM ledgers l
		 JOIN team_members tm ON l.team_id = tm.team_id
		 WHERE tm.user_id = $1 AND l.is_deleted = FALSE`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	ledgerSet := make(map[string]bool)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ledgerSet[id] = true
	}

	ids := make([]string, 0, len(ledgerSet))
	for id := range ledgerSet {
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// applyLocalChanges applies local changes with LWW merge per entity type
func (s *SyncService) applyLocalChanges(ctx context.Context, userID string, ledgerIDs []string, changes model.SyncPayload) error {
	ledgerSet := make(map[string]bool, len(ledgerIDs))
	for _, id := range ledgerIDs {
		ledgerSet[id] = true
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// ledgers：lwwMergeLedger 内部 canReadLedger 自鉴权，无权限返回 ErrNotLedgerMember 跳过。
	for _, l := range changes.Ledgers {
		if err := s.lwwMergeLedger(ctx, tx, userID, l); err != nil {
			if errors.Is(err, ErrNotLedgerMember) {
				continue
			}
			return err
		}
	}

	// accounts
	for _, a := range changes.Accounts {
		if !ledgerSet[a.LedgerID] {
			continue
		}
		if err := s.lwwMergeAccount(ctx, tx, userID, a); err != nil {
			return err
		}
	}

	// tags：同名去重时新 id 会被合并进旧 id，记录映射供交易 tag_ids 重映射
	tagRemap := make(map[string]string)
	for _, t := range changes.Tags {
		if !ledgerSet[t.LedgerID] {
			continue
		}
		effectiveID, err := s.lwwMergeTag(ctx, tx, t)
		if err != nil {
			return err
		}
		if effectiveID != t.ID {
			tagRemap[t.ID] = effectiveID
		}
	}

	// categories：同名同类去重时新 id 会被合并进旧 id，记录映射供交易 category_id 重映射
	categoryRemap := make(map[string]string)
	for _, c := range changes.Categories {
		if !ledgerSet[c.LedgerID] {
			continue
		}
		effectiveID, err := s.lwwMergeCategory(ctx, tx, userID, c)
		if err != nil {
			return err
		}
		if effectiveID != c.ID {
			categoryRemap[c.ID] = effectiveID
		}
	}

	// transactions：合并前先把外键重映射到去重后的有效 id，避免同批次交易引用被丢弃的新 id
	// 而撞 transaction_tags/categories 外键（23503）导致整次同步回滚。
	for i := range changes.Transactions {
		t := &changes.Transactions[i]
		for j := range t.TagIDs {
			if newID, ok := tagRemap[t.TagIDs[j]]; ok {
				t.TagIDs[j] = newID
			}
		}
		if t.CategoryID != nil {
			if newID, ok := categoryRemap[*t.CategoryID]; ok {
				t.CategoryID = &newID
			}
		}
	}

	// transactions
	for _, t := range changes.Transactions {
		if !ledgerSet[t.LedgerID] {
			continue
		}
		if err := s.lwwMergeTransaction(ctx, tx, userID, t); err != nil {
			return err
		}
	}

	// member_aliases (global, not ledger-scoped)：setter 以服务端当前用户为准，忽略客户端值，
	// 防止伪造 setter 写他人别名。
	for _, ma := range changes.MemberAliases {
		if err := s.lwwMergeMemberAlias(ctx, tx, userID, ma); err != nil {
			return err
		}
	}

	return tx.Commit(ctx)
}

func (s *SyncService) lwwMergeLedger(ctx context.Context, tx dbQuerier, userID string, l model.Ledger) error {
	if err := canReadLedger(ctx, tx, userID, l.ID); err != nil {
		return err // ErrNotLedgerMember 由调用方决定跳过还是失败
	}
	var remoteUpdatedAt time.Time
	var ownerID, ledgerType string
	err := tx.QueryRow(ctx,
		"SELECT updated_at, owner_id, type FROM ledgers WHERE id = $1", l.ID,
	).Scan(&remoteUpdatedAt, &ownerID, &ledgerType)
	if err != nil {
		return err
	}
	if !l.UpdatedAt.After(remoteUpdatedAt) {
		return nil
	}
	// 团队账本仅 owner 可改名/type；成员跳过（is_deleted 已冻结，不在此列）。
	if ledgerType == "team" && ownerID != userID {
		return nil
	}
	_, err = tx.Exec(ctx,
		`UPDATE ledgers SET name=$1, type=$2, updated_at=$3, server_seq = nextval('global_server_seq') WHERE id=$4`,
		l.Name, l.Type, l.UpdatedAt, l.ID,
	)
	return err
}

func (s *SyncService) lwwMergeAccount(ctx context.Context, tx dbQuerier, userID string, a model.Account) error {
	return mergeByKey(ctx, tx, a.UpdatedAt,
		"SELECT updated_at FROM accounts WHERE id = $1", []any{a.ID},
		func() error {
			_, err := tx.Exec(ctx,
				`INSERT INTO accounts (id, ledger_id, owner_id, name, type, category, initial_balance, credit_limit, repayment_day, color, created_at, updated_at, is_deleted)
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
				a.ID, a.LedgerID, userID, a.Name, a.Type, a.Category, a.InitialBalance,
				a.CreditLimit, a.RepaymentDay, a.Color, a.CreatedAt, a.UpdatedAt, a.IsDeleted,
			)
			return err
		},
		func() error {
			_, err := tx.Exec(ctx,
				`UPDATE accounts SET name=$1, type=$2, category=$3, initial_balance=$4, credit_limit=$5, repayment_day=$6, color=$7, updated_at=$8, is_deleted=$9, server_seq = nextval('global_server_seq') WHERE id=$10`,
				a.Name, a.Type, a.Category, a.InitialBalance, a.CreditLimit, a.RepaymentDay, a.Color, a.UpdatedAt, a.IsDeleted, a.ID,
			)
			return err
		},
	)
}

func (s *SyncService) lwwMergeTag(ctx context.Context, tx dbQuerier, t model.Tag) (string, error) {
	var remoteUpdatedAt time.Time
	err := tx.QueryRow(ctx, "SELECT updated_at FROM tags WHERE id = $1", t.ID).Scan(&remoteUpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		// 同名同账本未删除标签（清数据重绑会重新生成 UUID）：改 UPDATE 旧行而非 INSERT
		var dupID string
		var dupUpdatedAt time.Time
		dupErr := tx.QueryRow(ctx,
			`SELECT id, updated_at FROM tags WHERE ledger_id = $1 AND name = $2 AND is_deleted = FALSE LIMIT 1`,
			t.LedgerID, t.Name,
		).Scan(&dupID, &dupUpdatedAt)
		if dupErr == nil {
			// 去重合并到旧标签 dupID、丢弃新 id；调用方据此把交易 tag_ids 重映射到 dupID
			if t.UpdatedAt.After(dupUpdatedAt) {
				_, err = tx.Exec(ctx,
					`UPDATE tags SET name=$1, updated_at=$2, is_deleted=$3, server_seq = nextval('global_server_seq') WHERE id=$4`,
					t.Name, t.UpdatedAt, t.IsDeleted, dupID)
				return dupID, err
			}
			return dupID, nil // 本地更旧：跳过，但新 id 仍映射到 dupID
		}
		if !errors.Is(dupErr, pgx.ErrNoRows) {
			return "", dupErr // 真实 DB 错误，透传
		}
		_, err = tx.Exec(ctx,
			`INSERT INTO tags (id, ledger_id, name, updated_at, is_deleted) VALUES ($1,$2,$3,$4,$5)`,
			t.ID, t.LedgerID, t.Name, t.UpdatedAt, t.IsDeleted)
		return t.ID, err
	}
	if err != nil {
		return "", err
	}
	if !t.UpdatedAt.After(remoteUpdatedAt) {
		return t.ID, nil
	}
	_, err = tx.Exec(ctx,
		`UPDATE tags SET name=$1, updated_at=$2, is_deleted=$3, server_seq = nextval('global_server_seq') WHERE id=$4`,
		t.Name, t.UpdatedAt, t.IsDeleted, t.ID)
	return t.ID, err
}

func (s *SyncService) lwwMergeCategory(ctx context.Context, tx dbQuerier, userID string, c model.Category) (string, error) {
	var remoteUpdatedAt time.Time
	err := tx.QueryRow(ctx, "SELECT updated_at FROM categories WHERE id = $1", c.ID).Scan(&remoteUpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		// 检查同账本下是否已有同名同类型分类（客户端清数据重绑会重新生成 UUID）
		var dupID string
		var dupUpdatedAt time.Time
		dupErr := tx.QueryRow(ctx,
			`SELECT id, updated_at FROM categories WHERE ledger_id = $1 AND name = $2 AND type = $3 AND is_deleted = FALSE LIMIT 1`,
			c.LedgerID, c.Name, c.Type,
		).Scan(&dupID, &dupUpdatedAt)
		if dupErr == nil {
			// 去重合并到旧分类 dupID、丢弃新 id；调用方据此把交易 category_id 重映射到 dupID
			if c.UpdatedAt.After(dupUpdatedAt) {
				_, err = tx.Exec(ctx,
					`UPDATE categories SET name=$1, type=$2, icon=$3, sort_order=$4, updated_at=$5, is_deleted=$6, server_seq = nextval('global_server_seq') WHERE id=$7`,
					c.Name, c.Type, c.Icon, c.SortOrder, c.UpdatedAt, c.IsDeleted, dupID,
				)
				return dupID, err
			}
			// 本地更旧：跳过，不报错（此前误把外层 pgx.ErrNoRows 当错误返回，导致同步 500）
			return dupID, nil
		}
		// 无重复，正常插入
		_, err = tx.Exec(ctx,
			`INSERT INTO categories (id, ledger_id, owner_id, name, type, icon, sort_order, updated_at, is_deleted) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
			c.ID, c.LedgerID, userID, c.Name, c.Type, c.Icon, c.SortOrder, c.UpdatedAt, c.IsDeleted,
		)
		return c.ID, err
	}
	if err != nil {
		return "", err
	}
	if !c.UpdatedAt.After(remoteUpdatedAt) {
		return c.ID, nil
	}
	_, err = tx.Exec(ctx,
		`UPDATE categories SET name=$1, type=$2, icon=$3, sort_order=$4, updated_at=$5, is_deleted=$6, server_seq = nextval('global_server_seq') WHERE id=$7`,
		c.Name, c.Type, c.Icon, c.SortOrder, c.UpdatedAt, c.IsDeleted, c.ID,
	)
	return c.ID, err
}

func (s *SyncService) lwwMergeTransaction(ctx context.Context, tx dbQuerier, userID string, t model.Transaction) error {
	insert := func() error {
		_, err := tx.Exec(ctx,
			`INSERT INTO transactions (id, ledger_id, user_id, amount, type, from_account_id, to_account_id, category_id, note, occurred_at, created_at, updated_at, is_deleted)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
			t.ID, t.LedgerID, userID, t.Amount, t.Type, t.FromAccountID, t.ToAccountID,
			t.CategoryID, t.Note, t.OccurredAt, t.CreatedAt, t.UpdatedAt, t.IsDeleted,
		)
		if err != nil {
			return err
		}
		return syncTransactionTags(ctx, tx, t.ID, t.TagIDs)
	}
	update := func() error {
		_, err := tx.Exec(ctx,
			`UPDATE transactions SET amount=$1, type=$2, from_account_id=$3, to_account_id=$4, category_id=$5, note=$6, occurred_at=$7, updated_at=$8, is_deleted=$9, server_seq = nextval('global_server_seq') WHERE id=$10`,
			t.Amount, t.Type, t.FromAccountID, t.ToAccountID, t.CategoryID, t.Note, t.OccurredAt, t.UpdatedAt, t.IsDeleted, t.ID,
		)
		if err != nil {
			return err
		}
		return syncTransactionTags(ctx, tx, t.ID, t.TagIDs)
	}
	return mergeByKey(ctx, tx, t.UpdatedAt,
		"SELECT updated_at FROM transactions WHERE id = $1", []any{t.ID},
		insert, update,
	)
}

// syncTransactionTags 无条件先删旧关联再插新（空标签也要清空，否则旧标签会被回传「复活」）。
func syncTransactionTags(ctx context.Context, tx dbQuerier, txID string, tagIDs []string) error {
	if _, err := tx.Exec(ctx, "DELETE FROM transaction_tags WHERE transaction_id = $1", txID); err != nil {
		return err
	}
	for _, tagID := range tagIDs {
		if _, err := tx.Exec(ctx,
			"INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
			txID, tagID); err != nil {
			return err
		}
	}
	return nil
}

// getRemoteChanges returns changes in all user-accessible ledgers with server_seq > sinceSeq
func (s *SyncService) getRemoteChanges(ctx context.Context, q dbQuerier, userID string, ledgerIDs []string, sinceSeq int64) (model.SyncPayload, error) {
	if len(ledgerIDs) == 0 {
		return model.SyncPayload{}, nil
	}

	payload := model.SyncPayload{}

	// ledgers
	ledgers, err := s.queryLedgers(ctx, q, ledgerIDs, sinceSeq)
	if err != nil {
		return payload, err
	}
	payload.Ledgers = ledgers

	// accounts
	accounts, err := s.queryAccounts(ctx, q, ledgerIDs, sinceSeq)
	if err != nil {
		return payload, err
	}
	payload.Accounts = accounts

	// tags
	tags, err := s.queryTags(ctx, q, ledgerIDs, sinceSeq)
	if err != nil {
		return payload, err
	}
	payload.Tags = tags

	// categories
	categories, err := s.queryCategories(ctx, q, sinceSeq, ledgerIDs)
	if err != nil {
		return payload, err
	}
	payload.Categories = categories

	// transactions
	transactions, err := s.queryTransactions(ctx, q, ledgerIDs, sinceSeq)
	if err != nil {
		return payload, err
	}
	payload.Transactions = transactions

	// member_aliases (global, not ledger-scoped)：仅返回当前用户设的别名，防越权读他人数据
	aliases, err := s.queryMemberAliases(ctx, q, userID, sinceSeq)
	if err != nil {
		return payload, err
	}
	payload.MemberAliases = aliases

	// 引用闭包：增量返回的子表记录引用的父行（ledger/account/category/tag）
	// 可能 server_seq 早于 sinceSeq 而未被增量返回，导致客户端外键缺失卡死。按 id 反查补齐。
	if err := s.backfillReferenced(ctx, q, ledgerIDs, &payload); err != nil {
		return payload, err
	}

	return payload, nil
}

// unseenKeys 返回 m 中不在 seen 里的 key 组成的 slice（用于补拉去重）。
func unseenKeys(m, seen map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		if !seen[k] {
			out = append(out, k)
		}
	}
	return out
}

// backfillReferenced 补齐增量结果里子表记录引用的父行。
// 只反查「增量结果里还没有」的 id，避免重复返回（前端 LWW 也能幂等兜底）。
func (s *SyncService) backfillReferenced(ctx context.Context, q dbQuerier, ledgerIDs []string, payload *model.SyncPayload) error {
	refLedgers, refAccounts, refCategories, refTags := collectReferencedIDs(
		payload.Accounts, payload.Categories, payload.Tags, payload.Transactions,
	)

	seenLedgers := map[string]bool{}
	for _, l := range payload.Ledgers {
		seenLedgers[l.ID] = true
	}
	seenAccounts := map[string]bool{}
	for _, a := range payload.Accounts {
		seenAccounts[a.ID] = true
	}
	seenCategories := map[string]bool{}
	for _, c := range payload.Categories {
		seenCategories[c.ID] = true
	}
	seenTags := map[string]bool{}
	for _, t := range payload.Tags {
		seenTags[t.ID] = true
	}

	if ids := unseenKeys(refLedgers, seenLedgers); len(ids) > 0 {
		extra, err := s.queryLedgersByIDs(ctx, q, ids, ledgerIDs)
		if err != nil {
			return err
		}
		payload.Ledgers = append(payload.Ledgers, extra...)
	}
	if ids := unseenKeys(refAccounts, seenAccounts); len(ids) > 0 {
		extra, err := s.queryAccountsByIDs(ctx, q, ids, ledgerIDs)
		if err != nil {
			return err
		}
		payload.Accounts = append(payload.Accounts, extra...)
	}
	if ids := unseenKeys(refCategories, seenCategories); len(ids) > 0 {
		extra, err := s.queryCategoriesByIDs(ctx, q, ids, ledgerIDs)
		if err != nil {
			return err
		}
		payload.Categories = append(payload.Categories, extra...)
	}
	if ids := unseenKeys(refTags, seenTags); len(ids) > 0 {
		extra, err := s.queryTagsByIDs(ctx, q, ids, ledgerIDs)
		if err != nil {
			return err
		}
		payload.Tags = append(payload.Tags, extra...)
	}
	return nil
}

func (s *SyncService) queryLedgers(ctx context.Context, q dbQuerier, ledgerIDs []string, sinceSeq int64) ([]model.Ledger, error) {
	rows, err := q.Query(ctx,
		`SELECT id, name, type, owner_id, team_id, created_at, updated_at, is_deleted
		 FROM ledgers WHERE id = ANY($1) AND server_seq > $2`,
		ledgerIDs, sinceSeq,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ledgers []model.Ledger
	for rows.Next() {
		var l model.Ledger
		if err := rows.Scan(&l.ID, &l.Name, &l.Type, &l.OwnerID, &l.TeamID, &l.CreatedAt, &l.UpdatedAt, &l.IsDeleted); err != nil {
			return nil, err
		}
		ledgers = append(ledgers, l)
	}
	return ledgers, rows.Err()
}

func (s *SyncService) queryAccounts(ctx context.Context, q dbQuerier, ledgerIDs []string, sinceSeq int64) ([]model.Account, error) {
	query := `SELECT id, ledger_id, owner_id, name, type, category, initial_balance, credit_limit, repayment_day, color, created_at, updated_at, is_deleted
		FROM accounts WHERE ledger_id = ANY($1) AND server_seq > $2`
	rows, err := q.Query(ctx, query, ledgerIDs, sinceSeq)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var accounts []model.Account
	for rows.Next() {
		var a model.Account
		if err := rows.Scan(&a.ID, &a.LedgerID, &a.OwnerID, &a.Name, &a.Type, &a.Category, &a.InitialBalance, &a.CreditLimit, &a.RepaymentDay, &a.Color, &a.CreatedAt, &a.UpdatedAt, &a.IsDeleted); err != nil {
			return nil, err
		}
		accounts = append(accounts, a)
	}
	return accounts, rows.Err()
}

func (s *SyncService) queryTags(ctx context.Context, q dbQuerier, ledgerIDs []string, sinceSeq int64) ([]model.Tag, error) {
	rows, err := q.Query(ctx,
		`SELECT id, ledger_id, name, updated_at, is_deleted FROM tags WHERE ledger_id = ANY($1) AND server_seq > $2`,
		ledgerIDs, sinceSeq,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tags []model.Tag
	for rows.Next() {
		var t model.Tag
		if err := rows.Scan(&t.ID, &t.LedgerID, &t.Name, &t.UpdatedAt, &t.IsDeleted); err != nil {
			return nil, err
		}
		tags = append(tags, t)
	}
	return tags, rows.Err()
}

func (s *SyncService) queryCategories(ctx context.Context, q dbQuerier, sinceSeq int64, ledgerIDs []string) ([]model.Category, error) {
	rows, err := q.Query(ctx,
		`SELECT id, ledger_id, owner_id, name, type, icon, sort_order, updated_at, is_deleted FROM categories WHERE server_seq > $1 AND ledger_id = ANY($2)`,
		sinceSeq, ledgerIDs,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var categories []model.Category
	for rows.Next() {
		var c model.Category
		if err := rows.Scan(&c.ID, &c.LedgerID, &c.OwnerID, &c.Name, &c.Type, &c.Icon, &c.SortOrder, &c.UpdatedAt, &c.IsDeleted); err != nil {
			return nil, err
		}
		categories = append(categories, c)
	}
	return categories, rows.Err()
}

func (s *SyncService) queryTransactions(ctx context.Context, q dbQuerier, ledgerIDs []string, sinceSeq int64) ([]model.Transaction, error) {
	rows, err := q.Query(ctx,
		`SELECT t.id, t.ledger_id, t.user_id, t.amount, t.type, t.from_account_id, t.to_account_id, t.category_id, t.note, t.occurred_at, t.created_at, t.updated_at, t.is_deleted,
		 COALESCE(array_agg(tg.tag_id) FILTER (WHERE tg.tag_id IS NOT NULL), '{}') AS tag_ids
		 FROM transactions t
		 LEFT JOIN transaction_tags tg ON t.id = tg.transaction_id
		 WHERE t.ledger_id = ANY($1) AND t.server_seq > $2
		 GROUP BY t.id`,
		ledgerIDs, sinceSeq,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var transactions []model.Transaction
	for rows.Next() {
		var t model.Transaction
		var tagIDs []string
		if err := rows.Scan(&t.ID, &t.LedgerID, &t.UserID, &t.Amount, &t.Type, &t.FromAccountID, &t.ToAccountID, &t.CategoryID, &t.Note, &t.OccurredAt, &t.CreatedAt, &t.UpdatedAt, &t.IsDeleted, &tagIDs); err != nil {
			return nil, err
		}
		t.TagIDs = tagIDs
		transactions = append(transactions, t)
	}
	return transactions, rows.Err()
}

func (s *SyncService) queryLedgersByIDs(ctx context.Context, q dbQuerier, ids, ledgerIDs []string) ([]model.Ledger, error) {
	rows, err := q.Query(ctx,
		`SELECT id, name, type, owner_id, team_id, created_at, updated_at, is_deleted
		 FROM ledgers WHERE id = ANY($1) AND id = ANY($2)`,
		ids, ledgerIDs,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ledgers []model.Ledger
	for rows.Next() {
		var l model.Ledger
		if err := rows.Scan(&l.ID, &l.Name, &l.Type, &l.OwnerID, &l.TeamID, &l.CreatedAt, &l.UpdatedAt, &l.IsDeleted); err != nil {
			return nil, err
		}
		ledgers = append(ledgers, l)
	}
	return ledgers, rows.Err()
}

func (s *SyncService) queryAccountsByIDs(ctx context.Context, q dbQuerier, ids, ledgerIDs []string) ([]model.Account, error) {
	rows, err := q.Query(ctx,
		`SELECT id, ledger_id, owner_id, name, type, category, initial_balance, credit_limit, repayment_day, color, created_at, updated_at, is_deleted
		 FROM accounts WHERE id = ANY($1) AND ledger_id = ANY($2)`,
		ids, ledgerIDs,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var accounts []model.Account
	for rows.Next() {
		var a model.Account
		if err := rows.Scan(&a.ID, &a.LedgerID, &a.OwnerID, &a.Name, &a.Type, &a.Category, &a.InitialBalance, &a.CreditLimit, &a.RepaymentDay, &a.Color, &a.CreatedAt, &a.UpdatedAt, &a.IsDeleted); err != nil {
			return nil, err
		}
		accounts = append(accounts, a)
	}
	return accounts, rows.Err()
}

func (s *SyncService) queryCategoriesByIDs(ctx context.Context, q dbQuerier, ids, ledgerIDs []string) ([]model.Category, error) {
	rows, err := q.Query(ctx,
		`SELECT id, ledger_id, owner_id, name, type, icon, sort_order, updated_at, is_deleted FROM categories WHERE id = ANY($1) AND ledger_id = ANY($2)`,
		ids, ledgerIDs,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var categories []model.Category
	for rows.Next() {
		var c model.Category
		if err := rows.Scan(&c.ID, &c.LedgerID, &c.OwnerID, &c.Name, &c.Type, &c.Icon, &c.SortOrder, &c.UpdatedAt, &c.IsDeleted); err != nil {
			return nil, err
		}
		categories = append(categories, c)
	}
	return categories, rows.Err()
}

func (s *SyncService) queryTagsByIDs(ctx context.Context, q dbQuerier, ids, ledgerIDs []string) ([]model.Tag, error) {
	rows, err := q.Query(ctx,
		`SELECT id, ledger_id, name, updated_at, is_deleted FROM tags WHERE id = ANY($1) AND ledger_id = ANY($2)`,
		ids, ledgerIDs,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tags []model.Tag
	for rows.Next() {
		var t model.Tag
		if err := rows.Scan(&t.ID, &t.LedgerID, &t.Name, &t.UpdatedAt, &t.IsDeleted); err != nil {
			return nil, err
		}
		tags = append(tags, t)
	}
	return tags, rows.Err()
}

func (s *SyncService) lwwMergeMemberAlias(ctx context.Context, tx dbQuerier, setterUserID string, ma model.MemberAlias) error {
	return mergeByKey(ctx, tx, ma.UpdatedAt,
		"SELECT updated_at FROM member_aliases WHERE setter_user_id = $1 AND target_user_id = $2",
		[]any{setterUserID, ma.TargetUserID},
		func() error {
			_, err := tx.Exec(ctx,
				`INSERT INTO member_aliases (setter_user_id, target_user_id, alias_name, updated_at) VALUES ($1,$2,$3,$4)`,
				setterUserID, ma.TargetUserID, ma.AliasName, ma.UpdatedAt,
			)
			return err
		},
		func() error {
			_, err := tx.Exec(ctx,
				`UPDATE member_aliases SET alias_name=$1, updated_at=$2, server_seq = nextval('global_server_seq') WHERE setter_user_id=$3 AND target_user_id=$4`,
				ma.AliasName, ma.UpdatedAt, setterUserID, ma.TargetUserID,
			)
			return err
		},
	)
}

func (s *SyncService) queryMemberAliases(ctx context.Context, q dbQuerier, userID string, sinceSeq int64) ([]model.MemberAlias, error) {
	rows, err := q.Query(ctx,
		`SELECT setter_user_id, target_user_id, alias_name, updated_at FROM member_aliases WHERE setter_user_id = $1 AND server_seq > $2`,
		userID, sinceSeq,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var aliases []model.MemberAlias
	for rows.Next() {
		var ma model.MemberAlias
		if err := rows.Scan(&ma.SetterUserID, &ma.TargetUserID, &ma.AliasName, &ma.UpdatedAt); err != nil {
			return nil, err
		}
		aliases = append(aliases, ma)
	}
	return aliases, rows.Err()
}

// collectReferencedIDs 收集增量结果集里所有外键目标的 id。
// 增量按 server_seq > sinceSeq 分表过滤会漏掉「子表记录引用的父行」，
// 这些父行需按 id 反查补齐，避免客户端外键缺失卡死。
func collectReferencedIDs(
	accounts []model.Account,
	categories []model.Category,
	tags []model.Tag,
	transactions []model.Transaction,
) (ledgerIDs, accountIDs, categoryIDs, tagIDs map[string]bool) {
	ledgerIDs = map[string]bool{}
	accountIDs = map[string]bool{}
	categoryIDs = map[string]bool{}
	tagIDs = map[string]bool{}

	for _, a := range accounts {
		ledgerIDs[a.LedgerID] = true
	}
	for _, c := range categories {
		ledgerIDs[c.LedgerID] = true
	}
	for _, t := range tags {
		ledgerIDs[t.LedgerID] = true
	}
	for _, tx := range transactions {
		ledgerIDs[tx.LedgerID] = true
		if tx.FromAccountID != nil {
			accountIDs[*tx.FromAccountID] = true
		}
		if tx.ToAccountID != nil {
			accountIDs[*tx.ToAccountID] = true
		}
		if tx.CategoryID != nil {
			categoryIDs[*tx.CategoryID] = true
		}
		for _, tagID := range tx.TagIDs {
			tagIDs[tagID] = true
		}
	}
	return
}
