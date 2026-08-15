// backend/cmd/server/main.go
package main

import (
	"context"
	"log"
	"net"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/go-chi/httprate"

	"wee-count/backend/internal/config"
	"wee-count/backend/internal/database"
	"wee-count/backend/internal/handler"
	mw "wee-count/backend/internal/middleware"
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

	// handlers
	authH := handler.NewAuthHandler(authSvc)
	syncH := handler.NewSyncHandler(syncSvc)
	teamH := handler.NewTeamHandler(teamSvc)

	// router
	r := chi.NewRouter()
	// 从 X-Forwarded-For / X-Real-IP 还原真实客户端 IP（Caddy 反代后才有意义）
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   cfg.CORSAllowedOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type"},
		ExposedHeaders:   []string{"Link"},
		AllowCredentials: false,
		MaxAge:           300,
	}))

	r.Route("/api/v1", func(r chi.Router) {
		// refresh 不限流：客户端静默续期高频，不参与暴力破解面
		r.Post("/auth/refresh", authH.Refresh)

		// 登录/注册按 IP 限流，防暴力破解。
		// key 取自 r.RemoteAddr，由全局 middleware.RealIP 从 X-Forwarded-For 解析；
		// 若服务直连客户端会因 header 可伪造而绕过，后续可按部署改用 chi v5.3.0+ ClientIPFrom* 收紧。
		r.Group(func(r chi.Router) {
			r.Use(httprate.LimitBy(10, time.Minute, clientIPKey))
			r.Post("/auth/login", authH.Login)
			r.Post("/auth/register", authH.Register)
		})

		// protected
		r.Group(func(r chi.Router) {
			r.Use(mw.AuthMiddleware(cfg.JWTSecret))
			r.Get("/me", authH.Me)
			r.Put("/auth/profile", authH.UpdateProfile)
			r.Post("/sync", syncH.Sync)
			r.Post("/teams", teamH.Create)
			r.Post("/teams/{id}/invite", teamH.Invite)
			r.Get("/teams/{id}/members", teamH.Members)

			// 邀请码 6 位（10^6 空间）可被登录用户离线爆破入组，故 join 也限流。
			// key 信任模型同上：取自 r.RemoteAddr，由全局 middleware.RealIP 解析。
			r.Group(func(r chi.Router) {
				r.Use(httprate.LimitBy(10, time.Minute, clientIPKey))
				r.Post("/teams/join", teamH.Join)
			})
		})
	})

	log.Printf("server starting on :%s", cfg.Port)
	if err := http.ListenAndServe(":"+cfg.Port, r); err != nil {
		log.Fatalf("http.ListenAndServe: %v", err)
	}
}

// clientIPKey 从 r.RemoteAddr 提取限流 key。代码等价旧 httprate.KeyByIP，但
// 因全局 middleware.RealIP 已把 r.RemoteAddr 改写为 X-Forwarded-For 解析值，
// 实际等效于已弃用的 KeyByRealIP（header 可伪造，见 httprate deprecated.go 的 GHSA 告警）。
// 后续可按部署改用 chi v5.3.0+ ClientIPFrom* + LimitBy(GetClientIP) 收紧。
func clientIPKey(r *http.Request) (string, error) {
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		ip = r.RemoteAddr
	}
	return httprate.CanonicalizeIP(ip), nil
}
