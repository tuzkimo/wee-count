// backend/internal/model/category.go
package model

import "time"

type Category struct {
	ID        string    `json:"id"`
	LedgerID  string    `json:"ledger_id"`
	OwnerID   string    `json:"owner_id"`
	Name      string    `json:"name"`
	Type      string    `json:"type"`
	Icon      *string   `json:"icon"`
	SortOrder int       `json:"sort_order"`
	UpdatedAt time.Time `json:"updated_at"`
	IsDeleted bool      `json:"is_deleted"`
}
