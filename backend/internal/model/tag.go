// backend/internal/model/tag.go
package model

import "time"

type Tag struct {
	ID        string    `json:"id"`
	LedgerID  string    `json:"ledger_id"`
	Name      string    `json:"name"`
	UpdatedAt time.Time `json:"updated_at"`
	IsDeleted bool      `json:"is_deleted"`
}
