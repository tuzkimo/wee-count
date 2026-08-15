// backend/internal/service/ledger.go
package service

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// CreateLedger 在事务中创建账本。默认分类由客户端通过 firstFullSync 上传。
func CreateLedger(ctx context.Context, tx pgx.Tx, ledgerID, ownerID, name, ledgerType string) error {
	// 与 sync.go/team.go 同一把 advisory xact lock：写 ledgers 走 DEFAULT nextval 取 server_seq，
	// 不拿锁时 commit-order 竞态会使低 seq 晚提交被游标跳过（漏同步）。
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(897753)"); err != nil {
		return fmt.Errorf("acquire sync write lock: %w", err)
	}

	now := time.Now().UTC()

	_, err := tx.Exec(ctx,
		`INSERT INTO ledgers (id, name, type, owner_id, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		ledgerID, name, ledgerType, ownerID, now, now,
	)
	if err != nil {
		return fmt.Errorf("insert ledger: %w", err)
	}

	return nil
}
