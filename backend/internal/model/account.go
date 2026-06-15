// backend/internal/model/account.go
package model

import "time"

type Account struct {
	ID             string    `json:"id"`
	LedgerID       string    `json:"ledger_id"`
	OwnerID        string    `json:"owner_id"`
	Name           string    `json:"name"`
	Type           string    `json:"type"`
	Category       string    `json:"category"`
	InitialBalance float64   `json:"initial_balance"`
	CreditLimit    *float64  `json:"credit_limit"`
	RepaymentDay   *int      `json:"repayment_day"`
	Color          string    `json:"color"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
	IsDeleted      bool      `json:"is_deleted"`
}
