package model

import "time"

type SyncRequest struct {
	LastServerSeq int64       `json:"last_server_seq"`
	LocalChanges  SyncPayload `json:"local_changes"`
}

type SyncResponse struct {
	ServerSeq     int64       `json:"server_seq"`
	RemoteChanges SyncPayload `json:"remote_changes"`
}

type MemberAlias struct {
	SetterUserID string    `json:"setter_user_id"`
	TargetUserID string    `json:"target_user_id"`
	AliasName    string    `json:"alias_name"`
	UpdatedAt    time.Time `json:"updated_at"`
}

type SyncPayload struct {
	Ledgers       []Ledger       `json:"ledgers"`
	Accounts      []Account      `json:"accounts"`
	Tags          []Tag          `json:"tags"`
	Categories    []Category     `json:"categories"`
	Transactions  []Transaction  `json:"transactions"`
	MemberAliases []MemberAlias  `json:"member_aliases"`
}
