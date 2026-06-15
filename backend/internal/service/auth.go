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
	ErrEmailTaken   = errors.New("email already registered")
	ErrInvalidLogin = errors.New("invalid email or password")
	ErrInvalidToken = errors.New("invalid or expired refresh token")
	ErrUserNotFound = errors.New("user not found")
)

type AuthService struct {
	pool      *pgxpool.Pool
	jwtSecret []byte
}

func NewAuthService(pool *pgxpool.Pool, jwtSecret string) *AuthService {
	return &AuthService{pool: pool, jwtSecret: []byte(jwtSecret)}
}

func (s *AuthService) Register(ctx context.Context, req model.RegisterRequest) (*model.AuthResponse, error) {
	// check duplicate email
	var exists bool
	err := s.pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM users WHERE email = $1)", req.Email).Scan(&exists)
	if err != nil {
		return nil, fmt.Errorf("check email: %w", err)
	}
	if exists {
		return nil, ErrEmailTaken
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		return nil, fmt.Errorf("hash password: %w", err)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	userID := uuid.New().String()
	now := time.Now().UTC()

	_, err = tx.Exec(ctx,
		`INSERT INTO users (id, nickname, email, password_hash, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		userID, req.Nickname, req.Email, string(hash), now, now,
	)
	if err != nil {
		return nil, fmt.Errorf("insert user: %w", err)
	}

	// create personal ledger
	ledgerID := uuid.New().String()
	_, err = tx.Exec(ctx,
		`INSERT INTO ledgers (id, name, type, owner_id, created_at, updated_at)
		 VALUES ($1, $2, 'personal', $3, $4, $5)`,
		ledgerID, req.Nickname+"的账本", userID, now, now,
	)
	if err != nil {
		return nil, fmt.Errorf("insert ledger: %w", err)
	}

	// create default accounts
	defaultAccounts := []struct {
		id, name, atype string
	}{
		{uuid.New().String(), "现金", "cash"},
		{uuid.New().String(), "银行卡", "bank"},
		{uuid.New().String(), "电子钱包", "digital"},
	}
	for _, a := range defaultAccounts {
		_, err = tx.Exec(ctx,
			`INSERT INTO accounts (id, ledger_id, owner_id, name, type, category, initial_balance, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, 'asset', 0, $6, $7)`,
			a.id, ledgerID, userID, a.name, a.atype, now, now,
		)
		if err != nil {
			return nil, fmt.Errorf("insert default account: %w", err)
		}
	}

	// create default categories (same as frontend ensureDefaultData)
	defaultCategories := []struct {
		name, ctype, icon string
		sortOrder         int
	}{
		{"餐饮", "expense", "🍜", 1},
		{"交通", "expense", "🚌", 2},
		{"购物", "expense", "🛒", 3},
		{"娱乐", "expense", "🎮", 4},
		{"居家", "expense", "🏠", 5},
		{"通讯", "expense", "📱", 6},
		{"医疗", "expense", "💊", 7},
		{"其他支出", "expense", "💸", 99},
		{"工资", "income", "💰", 1},
		{"奖金", "income", "🎁", 2},
		{"理财", "income", "📈", 3},
		{"退款", "income", "↩️", 4},
		{"报销", "income", "🧾", 5},
		{"其他收入", "income", "📥", 99},
	}
	for _, c := range defaultCategories {
		_, err = tx.Exec(ctx,
			`INSERT INTO categories (id, ledger_id, name, type, icon, sort_order, updated_at)
			 VALUES ($1, NULL, $2, $3, $4, $5, $6)`,
			uuid.New().String(), c.name, c.ctype, c.icon, c.sortOrder, now,
		)
		if err != nil {
			return nil, fmt.Errorf("insert default category: %w", err)
		}
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
			Nickname:  req.Nickname,
			Email:     req.Email,
			CreatedAt: now,
			UpdatedAt: now,
		},
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
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
		`SELECT id, nickname, email, avatar_url, created_at, updated_at FROM users WHERE id = $1`,
		userID,
	).Scan(&user.ID, &user.Nickname, &user.Email, &user.AvatarURL, &user.CreatedAt, &user.UpdatedAt)
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
		`SELECT id, nickname, email, password_hash, avatar_url, created_at, updated_at
		 FROM users WHERE email = $1`, req.Email,
	).Scan(&user.ID, &user.Nickname, &user.Email, &user.PasswordHash, &user.AvatarURL, &user.CreatedAt, &user.UpdatedAt)
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

	return &model.AuthResponse{
		User:         user,
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
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

	userID, ok := claims["sub"].(string)
	if !ok {
		return nil, ErrInvalidToken
	}

	var user model.User
	err = s.pool.QueryRow(ctx,
		`SELECT id, nickname, email, avatar_url, created_at, updated_at
		 FROM users WHERE id = $1`, userID,
	).Scan(&user.ID, &user.Nickname, &user.Email, &user.AvatarURL, &user.CreatedAt, &user.UpdatedAt)
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

func (s *AuthService) generateTokens(userID string) (string, string, error) {
	now := time.Now().UTC()

	accessClaims := jwt.MapClaims{
		"sub": userID,
		"iat": now.Unix(),
		"exp": now.Add(15 * time.Minute).Unix(),
	}
	accessToken, err := jwt.NewWithClaims(jwt.SigningMethodHS256, accessClaims).SignedString(s.jwtSecret)
	if err != nil {
		return "", "", fmt.Errorf("sign access token: %w", err)
	}

	refreshClaims := jwt.MapClaims{
		"sub": userID,
		"iat": now.Unix(),
		"exp": now.Add(30 * 24 * time.Hour).Unix(),
	}
	refreshToken, err := jwt.NewWithClaims(jwt.SigningMethodHS256, refreshClaims).SignedString(s.jwtSecret)
	if err != nil {
		return "", "", fmt.Errorf("sign refresh token: %w", err)
	}

	return accessToken, refreshToken, nil
}
