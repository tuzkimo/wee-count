// backend/internal/service/ledger.go
package service

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// DefaultCategories 创建新账本时拷贝的默认分类模板
var DefaultCategories = []struct {
	Name, Type, Icon string
	SortOrder        int
}{
	{"餐饮", "expense", "🍜", 1},
	{"交通", "expense", "🚌", 2},
	{"购物", "expense", "🛒", 3},
	{"娱乐", "expense", "🎮", 4},
	{"居家", "expense", "🏠", 5},
	{"通讯", "expense", "📱", 6},
	{"医疗", "expense", "💊", 7},
	{"其他支出", "expense", "💸", 99},
	{"工资", "income", "💰", 1},
	{"奖金", "income", "🎁", 2},
	{"理财", "income", "📈", 3},
	{"退款", "income", "↩️", 4},
	{"报销", "income", "🧾", 5},
	{"其他收入", "income", "📥", 99},
}

// CreateLedger 在事务中创建账本并拷贝默认分类
func CreateLedger(ctx context.Context, tx pgx.Tx, ledgerID, ownerID, name, ledgerType string) error {
	now := time.Now().UTC()

	// 创建账本
	_, err := tx.Exec(ctx,
		`INSERT INTO ledgers (id, name, type, owner_id, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		ledgerID, name, ledgerType, ownerID, now, now,
	)
	if err != nil {
		return fmt.Errorf("insert ledger: %w", err)
	}

	// 拷贝默认分类
	for _, c := range DefaultCategories {
		_, err = tx.Exec(ctx,
			`INSERT INTO categories (id, ledger_id, name, type, icon, sort_order, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			uuid.New().String(), ledgerID, c.Name, c.Type, c.Icon, c.SortOrder, now,
		)
		if err != nil {
			return fmt.Errorf("insert default category: %w", err)
		}
	}

	return nil
}
