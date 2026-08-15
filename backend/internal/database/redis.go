// backend/internal/database/redis.go
package database

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"
)

func NewRedisClient(redisURL, redisPassword string) (*redis.Client, error) {
	opts, err := redis.ParseURL(fmt.Sprintf("redis://%s", redisURL))
	if err != nil {
		return nil, fmt.Errorf("redis.ParseURL: %w", err)
	}
	if redisPassword != "" {
		opts.Password = redisPassword
	}
	client := redis.NewClient(opts)
	if err := client.Ping(context.Background()).Err(); err != nil {
		return nil, fmt.Errorf("redis.Ping: %w", err)
	}
	return client, nil
}
