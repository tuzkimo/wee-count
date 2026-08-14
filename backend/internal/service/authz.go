// backend/internal/service/authz.go
package service

import (
	"context"
	"errors"
	"fmt"
)

// ErrNotLedgerMember 表示调用者对该账本无访问权（越权防护）。
var ErrNotLedgerMember = errors.New("not a ledger member")

// canReadLedger 校验 userID 是否可访问账本：owner 或所在团队成员。
// 这是「owner 或 team 成员」授权规则的唯一单点表达；集合版见 SyncService.getUserLedgerIDs。
func canReadLedger(ctx context.Context, q dbQuerier, userID, ledgerID string) error {
	var ok bool
	err := q.QueryRow(ctx,
		`SELECT EXISTS(
			SELECT 1 FROM ledgers l
			WHERE l.id = $1 AND l.is_deleted = FALSE
			  AND (l.owner_id = $2 OR EXISTS(
				SELECT 1 FROM team_members tm
				WHERE tm.team_id = l.team_id AND tm.user_id = $2
			  ))
		)`,
		ledgerID, userID).Scan(&ok)
	if err != nil {
		return fmt.Errorf("check ledger access: %w", err)
	}
	if !ok {
		return ErrNotLedgerMember
	}
	return nil
}
