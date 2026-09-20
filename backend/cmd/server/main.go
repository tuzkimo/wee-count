// backend/cmd/server/main.go
package main

import (
	"context"
	"log"
	"net/http"

	"wee-count/backend/internal/config"
	"wee-count/backend/internal/database"
	"wee-count/backend/internal/handler"
	"wee-count/backend/internal/service"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config.Load: %v", err)
	}

	ctx := context.Background()
	pool, err := database.NewPool(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("database.NewPool: %v", err)
	}
	defer pool.Close()

	if err := database.RunMigrations(cfg.DatabaseURL); err != nil {
		log.Fatalf("database.RunMigrations: %v", err)
	}

	redisClient, err := database.NewRedisClient(cfg.RedisURL, cfg.RedisPassword)
	if err != nil {
		log.Fatalf("database.NewRedisClient: %v", err)
	}
	defer redisClient.Close()

	// services
	authSvc := service.NewAuthService(pool, cfg.JWTSecret)
	syncSvc := service.NewSyncService(pool)
	teamSvc := service.NewTeamService(pool, redisClient)
	aiSvc := service.NewAIService(cfg)

	// handlers
	h := handlers{
		auth: handler.NewAuthHandler(authSvc),
		sync: handler.NewSyncHandler(syncSvc),
		team: handler.NewTeamHandler(teamSvc),
		ai:   handler.NewAIHandler(aiSvc),
	}

	log.Printf("server starting on :%s (ai enabled=%t)", cfg.Port, aiSvc.Enabled())
	if err := http.ListenAndServe(":"+cfg.Port, newRouter(cfg, h)); err != nil {
		log.Fatalf("http.ListenAndServe: %v", err)
	}
}
