package service

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"wee-count/backend/internal/model"
)

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
	if err := s.applyLocalChanges(ctx, ledgerIDs, req.LocalChanges); err != nil {
		return nil, fmt.Errorf("applyLocalChanges: %w", err)
	}

	// 3. Fetch remote changes
	remoteChanges, err := s.getRemoteChanges(ctx, ledgerIDs, req.LastSyncedAt)
	if err != nil {
		return nil, fmt.Errorf("getRemoteChanges: %w", err)
	}

	return &model.SyncResponse{
		ServerTime:    time.Now().UTC(),
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
func (s *SyncService) applyLocalChanges(ctx context.Context, ledgerIDs []string, changes model.SyncPayload) error {
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

	// member_aliases (global, not ledger-scoped)
	for _, ma := range changes.MemberAliases {
		if err := s.lwwMergeMemberAlias(ctx, tx, ma); err != nil {
			return err
		}
	}

	return tx.Commit(ctx)
}

func (s *SyncService) lwwMergeLedger(ctx context.Context, tx pgx.Tx, l model.Ledger) error {
	var remoteUpdatedAt time.Time
	err := tx.QueryRow(ctx, "SELECT updated_at FROM ledgers WHERE id = $1", l.ID).Scan(&remoteUpdatedAt)
	if err != nil {
		_, err = tx.Exec(ctx,
			`INSERT INTO ledgers (id, name, type, owner_id, team_id, created_at, updated_at, is_deleted)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
			l.ID, l.Name, l.Type, l.OwnerID, l.TeamID, l.CreatedAt, l.UpdatedAt, l.IsDeleted,
		)
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

func (s *SyncService) lwwMergeAccount(ctx context.Context, tx pgx.Tx, a model.Account) error {
	var remoteUpdatedAt time.Time
	err := tx.QueryRow(ctx, "SELECT updated_at FROM accounts WHERE id = $1", a.ID).Scan(&remoteUpdatedAt)
	if err != nil {
		// Not exists → INSERT
		_, err = tx.Exec(ctx,
			`INSERT INTO accounts (id, ledger_id, owner_id, name, type, category, initial_balance, credit_limit, repayment_day, color, created_at, updated_at, is_deleted)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
			a.ID, a.LedgerID, a.OwnerID, a.Name, a.Type, a.Category, a.InitialBalance,
			a.CreditLimit, a.RepaymentDay, a.Color, a.CreatedAt, a.UpdatedAt, a.IsDeleted,
		)
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

func (s *SyncService) lwwMergeTag(ctx context.Context, tx pgx.Tx, t model.Tag) error {
	var remoteUpdatedAt time.Time
	err := tx.QueryRow(ctx, "SELECT updated_at FROM tags WHERE id = $1", t.ID).Scan(&remoteUpdatedAt)
	if err != nil {
		_, err = tx.Exec(ctx,
			`INSERT INTO tags (id, ledger_id, name, updated_at, is_deleted) VALUES ($1,$2,$3,$4,$5)`,
			t.ID, t.LedgerID, t.Name, t.UpdatedAt, t.IsDeleted,
		)
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

func (s *SyncService) lwwMergeCategory(ctx context.Context, tx pgx.Tx, c model.Category) error {
	var remoteUpdatedAt time.Time
	err := tx.QueryRow(ctx, "SELECT updated_at FROM categories WHERE id = $1", c.ID).Scan(&remoteUpdatedAt)
	if err != nil {
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
			}
			return err
		}
		// 无重复，正常插入
		_, err = tx.Exec(ctx,
			`INSERT INTO categories (id, ledger_id, owner_id, name, type, icon, sort_order, updated_at, is_deleted) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
			c.ID, c.LedgerID, c.OwnerID, c.Name, c.Type, c.Icon, c.SortOrder, c.UpdatedAt, c.IsDeleted,
		)
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

func (s *SyncService) lwwMergeTransaction(ctx context.Context, tx pgx.Tx, t model.Transaction) error {
	var remoteUpdatedAt time.Time
	err := tx.QueryRow(ctx, "SELECT updated_at FROM transactions WHERE id = $1", t.ID).Scan(&remoteUpdatedAt)
	if err != nil {
		_, err = tx.Exec(ctx,
			`INSERT INTO transactions (id, ledger_id, user_id, amount, type, from_account_id, to_account_id, category_id, occurred_at, created_at, updated_at, is_deleted)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
			t.ID, t.LedgerID, t.UserID, t.Amount, t.Type, t.FromAccountID, t.ToAccountID,
			t.CategoryID, t.OccurredAt, t.CreatedAt, t.UpdatedAt, t.IsDeleted,
		)
		if err != nil {
			return err
		}
	} else {
		if !t.UpdatedAt.After(remoteUpdatedAt) {
			return nil
		}
		_, err = tx.Exec(ctx,
			`UPDATE transactions SET amount=$1, type=$2, from_account_id=$3, to_account_id=$4, category_id=$5, occurred_at=$6, updated_at=$7, is_deleted=$8 WHERE id=$9`,
			t.Amount, t.Type, t.FromAccountID, t.ToAccountID, t.CategoryID, t.OccurredAt, t.UpdatedAt, t.IsDeleted, t.ID,
		)
		if err != nil {
			return err
		}
	}

	// sync tags: delete old associations, insert new ones
	if len(t.TagIDs) > 0 {
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
	}
	return nil
}

// getRemoteChanges returns changes in all user-accessible ledgers with updated_at > since
func (s *SyncService) getRemoteChanges(ctx context.Context, ledgerIDs []string, since time.Time) (model.SyncPayload, error) {
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

	// member_aliases (global, not ledger-scoped)
	aliases, err := s.queryMemberAliases(ctx, since)
	if err != nil {
		return payload, err
	}
	payload.MemberAliases = aliases

	return payload, nil
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
		`SELECT t.id, t.ledger_id, t.user_id, t.amount, t.type, t.from_account_id, t.to_account_id, t.category_id, t.occurred_at, t.created_at, t.updated_at, t.is_deleted,
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
		if err := rows.Scan(&t.ID, &t.LedgerID, &t.UserID, &t.Amount, &t.Type, &t.FromAccountID, &t.ToAccountID, &t.CategoryID, &t.OccurredAt, &t.CreatedAt, &t.UpdatedAt, &t.IsDeleted, &tagIDs); err != nil {
			return nil, err
		}
		t.TagIDs = tagIDs
		transactions = append(transactions, t)
	}
	return transactions, rows.Err()
}

func (s *SyncService) lwwMergeMemberAlias(ctx context.Context, tx pgx.Tx, ma model.MemberAlias) error {
	var remoteUpdatedAt time.Time
	err := tx.QueryRow(ctx,
		"SELECT updated_at FROM member_aliases WHERE setter_user_id = $1 AND target_user_id = $2",
		ma.SetterUserID, ma.TargetUserID,
	).Scan(&remoteUpdatedAt)
	if err != nil {
		_, err = tx.Exec(ctx,
			`INSERT INTO member_aliases (setter_user_id, target_user_id, alias_name, updated_at) VALUES ($1,$2,$3,$4)`,
			ma.SetterUserID, ma.TargetUserID, ma.AliasName, ma.UpdatedAt,
		)
		return err
	}
	if !ma.UpdatedAt.After(remoteUpdatedAt) {
		return nil
	}
	_, err = tx.Exec(ctx,
		`UPDATE member_aliases SET alias_name=$1, updated_at=$2 WHERE setter_user_id=$3 AND target_user_id=$4`,
		ma.AliasName, ma.UpdatedAt, ma.SetterUserID, ma.TargetUserID,
	)
	return err
}

func (s *SyncService) queryMemberAliases(ctx context.Context, since time.Time) ([]model.MemberAlias, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT setter_user_id, target_user_id, alias_name, updated_at FROM member_aliases WHERE updated_at > $1`,
		since,
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
