package model

import "time"

type SyncRequest struct {
	LastSyncedAt time.Time   `json:"last_synced_at"`
	LocalChanges SyncPayload `json:"local_changes"`
}

type SyncResponse struct {
	ServerTime    time.Time  `json:"server_time"`
	RemoteChanges SyncPayload `json:"remote_changes"`
}

type SyncPayload struct {
	Accounts     []Account     `json:"accounts"`
	Tags         []Tag         `json:"tags"`
	Categories   []Category    `json:"categories"`
	Transactions []Transaction `json:"transactions"`
}
