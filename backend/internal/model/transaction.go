// backend/internal/model/transaction.go
package model

import "time"

type Transaction struct {
	ID            string    `json:"id"`
	LedgerID      string    `json:"ledger_id"`
	UserID        string    `json:"user_id"`
	Amount        float64   `json:"amount"`
	Type          string    `json:"type"`
	FromAccountID *string   `json:"from_account_id"`
	ToAccountID   *string   `json:"to_account_id"`
	CategoryID    *string   `json:"category_id"`
	OccurredAt    time.Time `json:"occurred_at"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
	IsDeleted     bool      `json:"is_deleted"`
	TagIDs        []string  `json:"tag_ids,omitempty"`
}
