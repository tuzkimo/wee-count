package service

import (
	"testing"

	"wee-count/backend/internal/model"
)

func TestCollectReferencedIDs(t *testing.T) {
	fromAcc := "acc-from"
	toAcc := "acc-to"
	cat := "cat-1"

	accounts := []model.Account{{ID: "a1", LedgerID: "ledger-a"}}
	categories := []model.Category{{ID: "c1", LedgerID: "ledger-c"}}
	tags := []model.Tag{{ID: "t1", LedgerID: "ledger-t"}}
	transactions := []model.Transaction{
		{
			ID:            "tx1",
			LedgerID:      "ledger-tx",
			FromAccountID: &fromAcc,
			ToAccountID:   &toAcc,
			CategoryID:    &cat,
			TagIDs:        []string{"tag-x", "tag-y"},
		},
		{
			ID:       "tx2",
			LedgerID: "ledger-tx",
			// 无 from/to/category/tag：nil 指针与空 tag 都应跳过
		},
	}

	ledgerIDs, accountIDs, categoryIDs, tagIDs := collectReferencedIDs(accounts, categories, tags, transactions)

	for _, id := range []string{"ledger-a", "ledger-c", "ledger-t", "ledger-tx"} {
		if !ledgerIDs[id] {
			t.Errorf("ledgerIDs 缺 %q: %v", id, ledgerIDs)
		}
	}
	for _, id := range []string{"acc-from", "acc-to"} {
		if !accountIDs[id] {
			t.Errorf("accountIDs 缺 %q: %v", id, accountIDs)
		}
	}
	if !categoryIDs["cat-1"] {
		t.Errorf("categoryIDs 缺 cat-1: %v", categoryIDs)
	}
	for _, id := range []string{"tag-x", "tag-y"} {
		if !tagIDs[id] {
			t.Errorf("tagIDs 缺 %q: %v", id, tagIDs)
		}
	}
	if accountIDs[""] || categoryIDs[""] {
		t.Errorf("nil 指针不应产生空 id")
	}
}
