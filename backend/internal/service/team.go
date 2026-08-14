// backend/internal/service/team.go
package service

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"wee-count/backend/internal/model"
)

// ErrNotTeamMember 表示调用者不是该团队成员（越权防护）。
var ErrNotTeamMember = errors.New("not a team member")

type TeamService struct {
	pool  *pgxpool.Pool
	redis *redis.Client
}

func NewTeamService(pool *pgxpool.Pool, redis *redis.Client) *TeamService {
	return &TeamService{pool: pool, redis: redis}
}

type CreateTeamResponse struct {
	Team         model.Ledger `json:"team"`
	SharedLedger model.Ledger `json:"shared_ledger"`
}

func (s *TeamService) CreateTeam(ctx context.Context, userID string, name string) (*CreateTeamResponse, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	now := time.Now().UTC()
	teamID := uuid.New().String()
	ledgerID := uuid.New().String()

	// insert team
	_, err = tx.Exec(ctx,
		`INSERT INTO teams (id, name, created_by, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)`,
		teamID, name, userID, now, now,
	)
	if err != nil {
		return nil, fmt.Errorf("insert team: %w", err)
	}

	// add creator as owner
	_, err = tx.Exec(ctx,
		`INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'owner', $3)`,
		teamID, userID, now,
	)
	if err != nil {
		return nil, fmt.Errorf("insert team_member: %w", err)
	}

	// create shared ledger
	_, err = tx.Exec(ctx,
		`INSERT INTO ledgers (id, name, type, team_id, owner_id, created_at, updated_at) VALUES ($1, $2, 'team', $3, $4, $5, $6)`,
		ledgerID, name, teamID, userID, now, now,
	)
	if err != nil {
		return nil, fmt.Errorf("insert ledger: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit tx: %w", err)
	}

	return &CreateTeamResponse{
		Team: model.Ledger{
			ID: teamID, Name: name, Type: "team",
			TeamID: &teamID, OwnerID: userID, CreatedAt: now, UpdatedAt: now,
		},
		SharedLedger: model.Ledger{
			ID: ledgerID, Name: name, Type: "team",
			TeamID: &teamID, OwnerID: userID, CreatedAt: now, UpdatedAt: now,
		},
	}, nil
}

func (s *TeamService) CreateInvite(ctx context.Context, userID, teamID string) (string, error) {
	// verify team exists and user is owner
	var createdBy string
	err := s.pool.QueryRow(ctx, "SELECT created_by FROM teams WHERE id = $1", teamID).Scan(&createdBy)
	if err != nil {
		return "", fmt.Errorf("team not found: %w", err)
	}
	if createdBy != userID {
		return "", fmt.Errorf("only team owner can create invite")
	}

	code, err := generateInviteCode()
	if err != nil {
		return "", fmt.Errorf("generate code: %w", err)
	}

	key := fmt.Sprintf("invite:%s", code)
	err = s.redis.Set(ctx, key, fmt.Sprintf("%s:%s", teamID, userID), 24*time.Hour).Err()
	if err != nil {
		return "", fmt.Errorf("redis set: %w", err)
	}

	return code, nil
}

func (s *TeamService) JoinByInvite(ctx context.Context, userID, code string) (*CreateTeamResponse, error) {
	key := fmt.Sprintf("invite:%s", code)
	val, err := s.redis.Get(ctx, key).Result()
	if err == redis.Nil {
		return nil, fmt.Errorf("invalid or expired invite code")
	}
	if err != nil {
		return nil, fmt.Errorf("redis get: %w", err)
	}

	parts := strings.SplitN(val, ":", 2)
	if len(parts) != 2 {
		return nil, fmt.Errorf("invalid invite data")
	}
	teamID := parts[0]

	// delete invite code (one-time use)
	s.redis.Del(ctx, key)

	// check if already a member
	var exists bool
	err = s.pool.QueryRow(ctx,
		"SELECT EXISTS(SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2)", teamID, userID,
	).Scan(&exists)
	if err != nil {
		return nil, err
	}
	if exists {
		return nil, fmt.Errorf("already a member of this team")
	}

	now := time.Now().UTC()
	_, err = s.pool.Exec(ctx,
		`INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'member', $3)`,
		teamID, userID, now,
	)
	if err != nil {
		return nil, fmt.Errorf("insert team_member: %w", err)
	}

	// get team info
	var teamName string
	err = s.pool.QueryRow(ctx, "SELECT name FROM teams WHERE id = $1", teamID).Scan(&teamName)
	if err != nil {
		return nil, err
	}

	// get shared ledger
	var ledger model.Ledger
	err = s.pool.QueryRow(ctx,
		`SELECT id, name, type, team_id, owner_id, created_at, updated_at FROM ledgers WHERE team_id = $1 AND type = 'team'`,
		teamID,
	).Scan(&ledger.ID, &ledger.Name, &ledger.Type, &ledger.TeamID, &ledger.OwnerID, &ledger.CreatedAt, &ledger.UpdatedAt)
	if err != nil {
		return nil, err
	}

	return &CreateTeamResponse{
		Team:         model.Ledger{ID: teamID, Name: teamName, Type: "team"},
		SharedLedger: ledger,
	}, nil
}

func generateInviteCode() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1000000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%06d", n.Int64()), nil
}

type TeamMember struct {
	UserID    string    `json:"user_id"`
	Username  string    `json:"username"`
	Nickname  string    `json:"nickname"`
	AvatarURL *string   `json:"avatar_url"`
	Role      string    `json:"role"`
	JoinedAt  time.Time `json:"joined_at"`
}

// ensureTeamMember 校验 userID 是否属于 teamID，非成员返回 ErrNotTeamMember。
func (s *TeamService) ensureTeamMember(ctx context.Context, q dbQuerier, userID, teamID string) error {
	var isMember bool
	err := q.QueryRow(ctx,
		"SELECT EXISTS(SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2)", teamID, userID,
	).Scan(&isMember)
	if err != nil {
		return fmt.Errorf("check membership: %w", err)
	}
	if !isMember {
		return ErrNotTeamMember
	}
	return nil
}

func (s *TeamService) ListMembers(ctx context.Context, userID, teamID string) ([]TeamMember, error) {
	if teamID == "" {
		return nil, fmt.Errorf("team id is required")
	}
	// 越权防护：仅团队成员可查看成员列表
	if err := s.ensureTeamMember(ctx, s.pool, userID, teamID); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx,
		`SELECT u.id, u.username, u.nickname, u.avatar_url, tm.role, tm.joined_at
		 FROM team_members tm
		 JOIN users u ON tm.user_id = u.id
		 WHERE tm.team_id = $1
		 ORDER BY tm.joined_at ASC`,
		teamID,
	)
	if err != nil {
		return nil, fmt.Errorf("query team members: %w", err)
	}
	defer rows.Close()

	var members []TeamMember
	for rows.Next() {
		var m TeamMember
		if err := rows.Scan(&m.UserID, &m.Username, &m.Nickname, &m.AvatarURL, &m.Role, &m.JoinedAt); err != nil {
			return nil, err
		}
		members = append(members, m)
	}
	return members, rows.Err()
}
