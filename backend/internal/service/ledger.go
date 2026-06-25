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
