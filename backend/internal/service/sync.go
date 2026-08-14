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

	// 3. 游标必须在读取远程变更之前取样，而非之后：否则「读完成」与「取游标」之间
	//    提交的变更会因 updated_at < 游标 被下次增量永久跳过。
	//    注：LWW 用客户端 updated_at，彻底根治客户端时钟偏移需服务端权威游标（另立任务）。
	serverTime := time.Now().UTC()

	// 4. Fetch remote changes
	remoteChanges, err := s.getRemoteChanges(ctx, userID, ledgerIDs, req.LastSyncedAt)
	if err != nil {
		return nil, fmt.Errorf("getRemoteChanges: %w", err)
	}

	return &model.SyncResponse{
		ServerTime:    serverTime,
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

	// ledgers
	for _, l := range changes.Ledgers {
		if !ledgerSet[l.ID] {
			continue
		}
		if err := s.lwwMergeLedger(ctx, tx, l); err != nil {
			return err
		}
	}

	// accounts
	for _, a := range changes.Accounts {
		if !ledgerSet[a.LedgerID] {
			continue
		}
		if err := s.lwwMergeAccount(ctx, tx, a); err != nil {
			return err
		}
	}

	// tags
	for _, t := range changes.Tags {
		if !ledgerSet[t.LedgerID] {
			continue
		}
		if err := s.lwwMergeTag(ctx, tx, t); err != nil {
			return err
		}
	}

	// categories
	for _, c := range changes.Categories {
		if !ledgerSet[c.LedgerID] {
			continue
		}
		if err := s.lwwMergeCategory(ctx, tx, c); err != nil {
			return err
		}
	}

	// transactions
	for _, t := range changes.Transactions {
		if !ledgerSet[t.LedgerID] {
			continue
		}
		if err := s.lwwMergeTransaction(ctx, tx, t); err != nil {
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

func (s *SyncService) lwwMergeLedger(ctx context.Context, tx dbQuerier, l model.Ledger) error {
	var remoteUpdatedAt time.Time
	err := tx.QueryRow(ctx, "SELECT updated_at FROM ledgers WHERE id = $1", l.ID).Scan(&remoteUpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		_, err = tx.Exec(ctx,
			`INSERT INTO ledgers (id, name, type, owner_id, team_id, created_at, updated_at, is_deleted)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
			l.ID, l.Name, l.Type, l.OwnerID, l.TeamID, l.CreatedAt, l.UpdatedAt, l.IsDeleted,
		)
		return err
	}
	if err != nil {
		return err
	}
	if !l.UpdatedAt.After(remoteUpdatedAt) {
		return nil
	}
	_, err = tx.Exec(ctx,
		`UPDATE ledgers SET name=$1, type=$2, owner_id=$3, team_id=$4, updated_at=$5, is_deleted=$6 WHERE id=$7`,
		l.Name, l.Type, l.OwnerID, l.TeamID, l.UpdatedAt, l.IsDeleted, l.ID,
	)
	return err
}

func (s *SyncService) lwwMergeAccount(ctx context.Context, tx dbQuerier, a model.Account) error {
	var remoteUpdatedAt time.Time
	err := tx.QueryRow(ctx, "SELECT updated_at FROM accounts WHERE id = $1", a.ID).Scan(&remoteUpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		// Not exists → INSERT
		_, err = tx.Exec(ctx,
			`INSERT INTO accounts (id, ledger_id, owner_id, name, type, category, initial_balance, credit_limit, repayment_day, color, created_at, updated_at, is_deleted)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
			a.ID, a.LedgerID, a.OwnerID, a.Name, a.Type, a.Category, a.InitialBalance,
			a.CreditLimit, a.RepaymentDay, a.Color, a.CreatedAt, a.UpdatedAt, a.IsDeleted,
		)
		return err
	}
	if err != nil {
		return err
	}
	// Exists → LWW comparison
	if !a.UpdatedAt.After(remoteUpdatedAt) {
		return nil // server version is newer or same, skip
	}
	_, err = tx.Exec(ctx,
		`UPDATE accounts SET name=$1, type=$2, category=$3, initial_balance=$4, credit_limit=$5, repayment_day=$6, color=$7, updated_at=$8, is_deleted=$9 WHERE id=$10`,
		a.Name, a.Type, a.Category, a.InitialBalance, a.CreditLimit, a.RepaymentDay, a.Color, a.UpdatedAt, a.IsDeleted, a.ID,
	)
	return err
}

func (s *SyncService) lwwMergeTag(ctx context.Context, tx dbQuerier, t model.Tag) error {
	var remoteUpdatedAt time.Time
	err := tx.QueryRow(ctx, "SELECT updated_at FROM tags WHERE id = $1", t.ID).Scan(&remoteUpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		_, err = tx.Exec(ctx,
			`INSERT INTO tags (id, ledger_id, name, updated_at, is_deleted) VALUES ($1,$2,$3,$4,$5)`,
			t.ID, t.LedgerID, t.Name, t.UpdatedAt, t.IsDeleted,
		)
		return err
	}
	if err != nil {
		return err
	}
	if !t.UpdatedAt.After(remoteUpdatedAt) {
		return nil
	}
	_, err = tx.Exec(ctx,
		`UPDATE tags SET name=$1, updated_at=$2, is_deleted=$3 WHERE id=$4`,
		t.Name, t.UpdatedAt, t.IsDeleted, t.ID,
	)
	return err
}

func (s *SyncService) lwwMergeCategory(ctx context.Context, tx dbQuerier, c model.Category) error {
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
			// 已有同名同类型分类，更新而非插入
			if c.UpdatedAt.After(dupUpdatedAt) {
				_, err = tx.Exec(ctx,
					`UPDATE categories SET name=$1, type=$2, icon=$3, sort_order=$4, updated_at=$5, is_deleted=$6 WHERE id=$7`,
					c.Name, c.Type, c.Icon, c.SortOrder, c.UpdatedAt, c.IsDeleted, dupID,
				)
				return err
			}
			// 本地更旧：跳过，不报错（此前误把外层 pgx.ErrNoRows 当错误返回，导致同步 500）
			return nil
		}
		// 无重复，正常插入
		_, err = tx.Exec(ctx,
			`INSERT INTO categories (id, ledger_id, owner_id, name, type, icon, sort_order, updated_at, is_deleted) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
			c.ID, c.LedgerID, c.OwnerID, c.Name, c.Type, c.Icon, c.SortOrder, c.UpdatedAt, c.IsDeleted,
		)
		return err
	}
	if err != nil {
		return err
	}
	if !c.UpdatedAt.After(remoteUpdatedAt) {
		return nil
	}
	_, err = tx.Exec(ctx,
		`UPDATE categories SET name=$1, type=$2, icon=$3, sort_order=$4, updated_at=$5, is_deleted=$6 WHERE id=$7`,
		c.Name, c.Type, c.Icon, c.SortOrder, c.UpdatedAt, c.IsDeleted, c.ID,
	)
	return err
}

func (s *SyncService) lwwMergeTransaction(ctx context.Context, tx dbQuerier, t model.Transaction) error {
	var remoteUpdatedAt time.Time
	err := tx.QueryRow(ctx, "SELECT updated_at FROM transactions WHERE id = $1", t.ID).Scan(&remoteUpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		_, err = tx.Exec(ctx,
			`INSERT INTO transactions (id, ledger_id, user_id, amount, type, from_account_id, to_account_id, category_id, note, occurred_at, created_at, updated_at, is_deleted)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
			t.ID, t.LedgerID, t.UserID, t.Amount, t.Type, t.FromAccountID, t.ToAccountID,
			t.CategoryID, t.Note, t.OccurredAt, t.CreatedAt, t.UpdatedAt, t.IsDeleted,
		)
		if err != nil {
			return err
		}
	} else if err != nil {
		return err
	} else {
		if !t.UpdatedAt.After(remoteUpdatedAt) {
			return nil
		}
		_, err = tx.Exec(ctx,
			`UPDATE transactions SET amount=$1, type=$2, from_account_id=$3, to_account_id=$4, category_id=$5, note=$6, occurred_at=$7, updated_at=$8, is_deleted=$9 WHERE id=$10`,
			t.Amount, t.Type, t.FromAccountID, t.ToAccountID, t.CategoryID, t.Note, t.OccurredAt, t.UpdatedAt, t.IsDeleted, t.ID,
		)
		if err != nil {
			return err
		}
	}

	// sync tags: 无条件先删旧关联再插新（空标签也要清空，否则旧标签会被回传「复活」）
	_, err = tx.Exec(ctx, "DELETE FROM transaction_tags WHERE transaction_id = $1", t.ID)
	if err != nil {
		return err
	}
	for _, tagID := range t.TagIDs {
		_, err = tx.Exec(ctx,
			"INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
			t.ID, tagID,
		)
		if err != nil {
			return err
		}
	}
	return nil
}

// getRemoteChanges returns changes in all user-accessible ledgers with updated_at > since
func (s *SyncService) getRemoteChanges(ctx context.Context, userID string, ledgerIDs []string, since time.Time) (model.SyncPayload, error) {
	if len(ledgerIDs) == 0 {
		return model.SyncPayload{}, nil
	}

	payload := model.SyncPayload{}

	// ledgers
	ledgers, err := s.queryLedgers(ctx, ledgerIDs, since)
	if err != nil {
		return payload, err
	}
	payload.Ledgers = ledgers

	// accounts
	accounts, err := s.queryAccounts(ctx, ledgerIDs, since)
	if err != nil {
		return payload, err
	}
	payload.Accounts = accounts

	// tags
	tags, err := s.queryTags(ctx, ledgerIDs, since)
	if err != nil {
		return payload, err
	}
	payload.Tags = tags

	// categories
	categories, err := s.queryCategories(ctx, since, ledgerIDs)
	if err != nil {
		return payload, err
	}
	payload.Categories = categories

	// transactions
	transactions, err := s.queryTransactions(ctx, ledgerIDs, since)
	if err != nil {
		return payload, err
	}
	payload.Transactions = transactions

	// member_aliases (global, not ledger-scoped)：仅返回当前用户设的别名，防越权读他人数据
	aliases, err := s.queryMemberAliases(ctx, s.pool, userID, since)
	if err != nil {
		return payload, err
	}
	payload.MemberAliases = aliases

	// 引用闭包：增量返回的子表记录引用的父行（ledger/account/category/tag）
	// 可能 updated_at 早于 since 而未被增量返回，导致客户端外键缺失卡死。按 id 反查补齐。
	if err := s.backfillReferenced(ctx, &payload); err != nil {
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
func (s *SyncService) backfillReferenced(ctx context.Context, payload *model.SyncPayload) error {
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
		extra, err := s.queryLedgersByIDs(ctx, ids)
		if err != nil {
			return err
		}
		payload.Ledgers = append(payload.Ledgers, extra...)
	}
	if ids := unseenKeys(refAccounts, seenAccounts); len(ids) > 0 {
		extra, err := s.queryAccountsByIDs(ctx, ids)
		if err != nil {
			return err
		}
		payload.Accounts = append(payload.Accounts, extra...)
	}
	if ids := unseenKeys(refCategories, seenCategories); len(ids) > 0 {
		extra, err := s.queryCategoriesByIDs(ctx, ids)
		if err != nil {
			return err
		}
		payload.Categories = append(payload.Categories, extra...)
	}
	if ids := unseenKeys(refTags, seenTags); len(ids) > 0 {
		extra, err := s.queryTagsByIDs(ctx, ids)
		if err != nil {
			return err
		}
		payload.Tags = append(payload.Tags, extra...)
	}
	return nil
}

func (s *SyncService) queryLedgers(ctx context.Context, ledgerIDs []string, since time.Time) ([]model.Ledger, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, name, type, owner_id, team_id, created_at, updated_at, is_deleted
		 FROM ledgers WHERE id = ANY($1) AND updated_at > $2`,
		ledgerIDs, since,
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

func (s *SyncService) queryAccounts(ctx context.Context, ledgerIDs []string, since time.Time) ([]model.Account, error) {
	query := `SELECT id, ledger_id, owner_id, name, type, category, initial_balance, credit_limit, repayment_day, color, created_at, updated_at, is_deleted
		FROM accounts WHERE ledger_id = ANY($1) AND updated_at > $2`
	rows, err := s.pool.Query(ctx, query, ledgerIDs, since)
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

func (s *SyncService) queryTags(ctx context.Context, ledgerIDs []string, since time.Time) ([]model.Tag, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, ledger_id, name, updated_at, is_deleted FROM tags WHERE ledger_id = ANY($1) AND updated_at > $2`,
		ledgerIDs, since,
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

func (s *SyncService) queryCategories(ctx context.Context, since time.Time, ledgerIDs []string) ([]model.Category, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, ledger_id, owner_id, name, type, icon, sort_order, updated_at, is_deleted FROM categories WHERE updated_at > $1 AND ledger_id = ANY($2)`,
		since, ledgerIDs,
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

func (s *SyncService) queryTransactions(ctx context.Context, ledgerIDs []string, since time.Time) ([]model.Transaction, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT t.id, t.ledger_id, t.user_id, t.amount, t.type, t.from_account_id, t.to_account_id, t.category_id, t.note, t.occurred_at, t.created_at, t.updated_at, t.is_deleted,
		 COALESCE(array_agg(tg.tag_id) FILTER (WHERE tg.tag_id IS NOT NULL), '{}') AS tag_ids
		 FROM transactions t
		 LEFT JOIN transaction_tags tg ON t.id = tg.transaction_id
		 WHERE t.ledger_id = ANY($1) AND t.updated_at > $2
		 GROUP BY t.id`,
		ledgerIDs, since,
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

func (s *SyncService) queryLedgersByIDs(ctx context.Context, ids []string) ([]model.Ledger, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, name, type, owner_id, team_id, created_at, updated_at, is_deleted
		 FROM ledgers WHERE id = ANY($1)`,
		ids,
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

func (s *SyncService) queryAccountsByIDs(ctx context.Context, ids []string) ([]model.Account, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, ledger_id, owner_id, name, type, category, initial_balance, credit_limit, repayment_day, color, created_at, updated_at, is_deleted
		 FROM accounts WHERE id = ANY($1)`,
		ids,
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

func (s *SyncService) queryCategoriesByIDs(ctx context.Context, ids []string) ([]model.Category, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, ledger_id, owner_id, name, type, icon, sort_order, updated_at, is_deleted FROM categories WHERE id = ANY($1)`,
		ids,
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

func (s *SyncService) queryTagsByIDs(ctx context.Context, ids []string) ([]model.Tag, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, ledger_id, name, updated_at, is_deleted FROM tags WHERE id = ANY($1)`,
		ids,
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
	var remoteUpdatedAt time.Time
	err := tx.QueryRow(ctx,
		"SELECT updated_at FROM member_aliases WHERE setter_user_id = $1 AND target_user_id = $2",
		setterUserID, ma.TargetUserID,
	).Scan(&remoteUpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		_, err = tx.Exec(ctx,
			`INSERT INTO member_aliases (setter_user_id, target_user_id, alias_name, updated_at) VALUES ($1,$2,$3,$4)`,
			setterUserID, ma.TargetUserID, ma.AliasName, ma.UpdatedAt,
		)
		return err
	}
	if err != nil {
		return err
	}
	if !ma.UpdatedAt.After(remoteUpdatedAt) {
		return nil
	}
	_, err = tx.Exec(ctx,
		`UPDATE member_aliases SET alias_name=$1, updated_at=$2 WHERE setter_user_id=$3 AND target_user_id=$4`,
		ma.AliasName, ma.UpdatedAt, setterUserID, ma.TargetUserID,
	)
	return err
}

func (s *SyncService) queryMemberAliases(ctx context.Context, q dbQuerier, userID string, since time.Time) ([]model.MemberAlias, error) {
	rows, err := q.Query(ctx,
		`SELECT setter_user_id, target_user_id, alias_name, updated_at FROM member_aliases WHERE setter_user_id = $1 AND updated_at > $2`,
		userID, since,
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
// 增量按 updated_at > since 分表过滤会漏掉「子表记录引用的父行」，
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
