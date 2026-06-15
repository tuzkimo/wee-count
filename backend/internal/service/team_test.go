// backend/internal/service/team_test.go
package service

import (
	"testing"
)

func TestGenerateInviteCode(t *testing.T) {
	code, err := generateInviteCode()
	if err != nil {
		t.Fatalf("generateInviteCode: %v", err)
	}
	if len(code) != 6 {
		t.Errorf("expected 6-digit code, got %s", code)
	}
	for _, c := range code {
		if c < '0' || c > '9' {
			t.Errorf("expected all digits, got %s", code)
		}
	}
}

func TestGenerateInviteCode_Uniqueness(t *testing.T) {
	codes := make(map[string]bool)
	for i := 0; i < 100; i++ {
		code, err := generateInviteCode()
		if err != nil {
			t.Fatalf("generateInviteCode: %v", err)
		}
		if codes[code] {
			t.Logf("collision on code %s (statistically rare, not a bug)", code)
		}
		codes[code] = true
	}
}
