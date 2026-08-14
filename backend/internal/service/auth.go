// backend/internal/service/auth.go
package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"

	"wee-count/backend/internal/model"
)

var (
	ErrUsernameTaken = errors.New("username already registered")
	ErrInvalidLogin  = errors.New("invalid username or password")
	ErrInvalidToken  = errors.New("invalid or expired refresh token")
	ErrUserNotFound  = errors.New("user not found")
)

type AuthService struct {
	pool      *pgxpool.Pool
	jwtSecret []byte
}

func NewAuthService(pool *pgxpool.Pool, jwtSecret string) *AuthService {
	return &AuthService{pool: pool, jwtSecret: []byte(jwtSecret)}
}

func (s *AuthService) Register(ctx context.Context, req model.RegisterRequest) (*model.AuthResponse, error) {
	// check duplicate username
	var exists bool
	err := s.pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM users WHERE username = $1)", req.Username).Scan(&exists)
	if err != nil {
		return nil, fmt.Errorf("check username: %w", err)
	}
	if exists {
		return nil, ErrUsernameTaken
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		return nil, fmt.Errorf("hash password: %w", err)
	}

	nickname := req.Nickname
	if nickname == "" {
		nickname = req.Username
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	userID := uuid.New().String()
	ledgerID := uuid.New().String()
	now := time.Now().UTC()

	_, err = tx.Exec(ctx,
		`INSERT INTO users (id, username, nickname, password_hash, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		userID, req.Username, nickname, string(hash), now, now,
	)
	if err != nil {
		return nil, fmt.Errorf("insert user: %w", err)
	}

	// 创建账本（含默认分类和账户）
	ledgerName := nickname + "的账本"
	if err := CreateLedger(ctx, tx, ledgerID, userID, ledgerName, "personal"); err != nil {
		return nil, fmt.Errorf("create ledger: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit tx: %w", err)
	}

	accessToken, refreshToken, err := s.generateTokens(userID)
	if err != nil {
		return nil, err
	}

	return &model.AuthResponse{
		User: model.User{
			ID:        userID,
			Username:  req.Username,
			Nickname:  nickname,
			CreatedAt: now,
			UpdatedAt: now,
		},
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		LedgerID:     ledgerID,
	}, nil
}

type MeResponse struct {
	User    model.User    `json:"user"`
	Ledgers []model.Ledger `json:"ledgers"`
	Teams   []model.Ledger `json:"teams"`
}

func (s *AuthService) GetMe(ctx context.Context, userID string) (*MeResponse, error) {
	var user model.User
	err := s.pool.QueryRow(ctx,
		`SELECT id, username, nickname, avatar_url, created_at, updated_at FROM users WHERE id = $1`,
		userID,
	).Scan(&user.ID, &user.Username, &user.Nickname, &user.AvatarURL, &user.CreatedAt, &user.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("query user: %w", err)
	}

	rows, err := s.pool.Query(ctx,
		`SELECT id, name, type, team_id, owner_id, created_at, updated_at, is_deleted
		 FROM ledgers WHERE owner_id = $1 AND is_deleted = FALSE`, userID,
	)
	if err != nil {
		return nil, fmt.Errorf("query ledgers: %w", err)
	}
	defer rows.Close()

	var ledgers []model.Ledger
	for rows.Next() {
		var l model.Ledger
		if err := rows.Scan(&l.ID, &l.Name, &l.Type, &l.TeamID, &l.OwnerID, &l.CreatedAt, &l.UpdatedAt, &l.IsDeleted); err != nil {
			return nil, err
		}
		ledgers = append(ledgers, l)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate ledgers: %w", err)
	}

	// teams are ledgers with type='team'
	var teams []model.Ledger
	for _, l := range ledgers {
		if l.Type == "team" {
			teams = append(teams, l)
		}
	}

	return &MeResponse{User: user, Ledgers: ledgers, Teams: teams}, nil
}

func (s *AuthService) Login(ctx context.Context, req model.LoginRequest) (*model.AuthResponse, error) {
	var user model.User
	err := s.pool.QueryRow(ctx,
		`SELECT id, username, nickname, password_hash, avatar_url, created_at, updated_at
		 FROM users WHERE username = $1`, req.Username,
	).Scan(&user.ID, &user.Username, &user.Nickname, &user.PasswordHash, &user.AvatarURL, &user.CreatedAt, &user.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrInvalidLogin
	}
	if err != nil {
		return nil, fmt.Errorf("query user: %w", err)
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.Password)); err != nil {
		return nil, ErrInvalidLogin
	}

	accessToken, refreshToken, err := s.generateTokens(user.ID)
	if err != nil {
		return nil, err
	}

	// 查询个人账本
	var ledgerID string
	err = s.pool.QueryRow(ctx,
		`SELECT id FROM ledgers WHERE owner_id = $1 AND type = 'personal' AND is_deleted = FALSE LIMIT 1`,
		user.ID,
	).Scan(&ledgerID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("query ledger: %w", err)
	}

	return &model.AuthResponse{
		User:         user,
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		LedgerID:     ledgerID,
	}, nil
}

func (s *AuthService) Refresh(ctx context.Context, req model.RefreshRequest) (*model.AuthResponse, error) {
	token, err := jwt.Parse(req.RefreshToken, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return s.jwtSecret, nil
	})
	if err != nil || !token.Valid {
		return nil, ErrInvalidToken
	}

	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return nil, ErrInvalidToken
	}

	// 只接受 refresh token：access token 的 typ=access，不能当 refresh 用换新 token
	// （否则拿到 15 分钟有效的 access 即可无限续期）。
	if typ, _ := claims["typ"].(string); typ != "refresh" {
		return nil, ErrInvalidToken
	}

	userID, ok := claims["sub"].(string)
	if !ok {
		return nil, ErrInvalidToken
	}

	var user model.User
	err = s.pool.QueryRow(ctx,
		`SELECT id, username, nickname, avatar_url, created_at, updated_at
		 FROM users WHERE id = $1`, userID,
	).Scan(&user.ID, &user.Username, &user.Nickname, &user.AvatarURL, &user.CreatedAt, &user.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrUserNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("query user: %w", err)
	}

	accessToken, refreshToken, err := s.generateTokens(userID)
	if err != nil {
		return nil, err
	}

	return &model.AuthResponse{
		User:         user,
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
	}, nil
}

func (s *AuthService) UpdateProfile(ctx context.Context, userID string, req model.UpdateProfileRequest) (*model.User, error) {
	if req.Nickname != nil {
		_, err := s.pool.Exec(ctx, "UPDATE users SET nickname = $1, updated_at = $2 WHERE id = $3",
			*req.Nickname, time.Now().UTC(), userID)
		if err != nil {
			return nil, fmt.Errorf("update nickname: %w", err)
		}
	}
	if req.AvatarURL != nil {
		_, err := s.pool.Exec(ctx, "UPDATE users SET avatar_url = $1, updated_at = $2 WHERE id = $3",
			*req.AvatarURL, time.Now().UTC(), userID)
		if err != nil {
			return nil, fmt.Errorf("update avatar_url: %w", err)
		}
	}

	var user model.User
	err := s.pool.QueryRow(ctx,
		`SELECT id, username, nickname, avatar_url, created_at, updated_at FROM users WHERE id = $1`,
		userID,
	).Scan(&user.ID, &user.Username, &user.Nickname, &user.AvatarURL, &user.CreatedAt, &user.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("query user: %w", err)
	}
	return &user, nil
}
func (s *AuthService) generateTokens(userID string) (string, string, error) {
	now := time.Now().UTC()

	accessClaims := jwt.MapClaims{
		"sub": userID,
		"typ": "access",
		"iat": now.Unix(),
		"exp": now.Add(15 * time.Minute).Unix(),
	}
	accessToken, err := jwt.NewWithClaims(jwt.SigningMethodHS256, accessClaims).SignedString(s.jwtSecret)
	if err != nil {
		return "", "", fmt.Errorf("sign access token: %w", err)
	}

	refreshClaims := jwt.MapClaims{
		"sub": userID,
		"typ": "refresh",
		"iat": now.Unix(),
		"exp": now.Add(30 * 24 * time.Hour).Unix(),
	}
	refreshToken, err := jwt.NewWithClaims(jwt.SigningMethodHS256, refreshClaims).SignedString(s.jwtSecret)
	if err != nil {
		return "", "", fmt.Errorf("sign refresh token: %w", err)
	}

	return accessToken, refreshToken, nil
}
