package handler

import (
	"context"

	"wee-count/backend/internal/middleware"
)

// setUserID injects userID into context for testing
func setUserID(ctx context.Context, userID string) context.Context {
	return context.WithValue(ctx, middleware.UserIDKey, userID)
}
