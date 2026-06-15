// backend/cmd/server/main.go
package main

import (
	"context"
	"log"
	"net/http"

	"wee-count/backend/internal/config"
	"wee-count/backend/internal/database"
)

func main() {
	cfg := config.Load()

	ctx := context.Background()
	pool, err := database.NewPool(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("database.NewPool: %v", err)
	}
	defer pool.Close()

	if err := database.RunMigrations(cfg.DatabaseURL); err != nil {
		log.Fatalf("database.RunMigrations: %v", err)
	}

	redisClient, err := database.NewRedisClient(cfg.RedisURL)
	if err != nil {
		log.Fatalf("database.NewRedisClient: %v", err)
	}
	defer redisClient.Close()

	log.Printf("server starting on :%s", cfg.Port)
	if err := http.ListenAndServe(":"+cfg.Port, nil); err != nil {
		log.Fatalf("http.ListenAndServe: %v", err)
	}
}
