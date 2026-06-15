// backend/cmd/server/main.go
package main

import (
	"context"
	"log"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"wee-count/backend/internal/config"
	"wee-count/backend/internal/database"
	"wee-count/backend/internal/handler"
	mw "wee-count/backend/internal/middleware"
	"wee-count/backend/internal/service"
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

	// services
	authSvc := service.NewAuthService(pool, cfg.JWTSecret)

	// handlers
	authH := handler.NewAuthHandler(authSvc)

	// router
	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	r.Route("/api/v1", func(r chi.Router) {
		// public
		r.Post("/auth/register", authH.Register)
		r.Post("/auth/login", authH.Login)
		r.Post("/auth/refresh", authH.Refresh)

		// protected
		r.Group(func(r chi.Router) {
			r.Use(mw.AuthMiddleware(cfg.JWTSecret))
			r.Get("/me", authH.Me)
		})
	})

	log.Printf("server starting on :%s", cfg.Port)
	if err := http.ListenAndServe(":"+cfg.Port, r); err != nil {
		log.Fatalf("http.ListenAndServe: %v", err)
	}
}
