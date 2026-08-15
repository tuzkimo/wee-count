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
	// 仅在显式声明信任反向代理时启用 RealIP：它会用 X-Forwarded-For / X-Real-IP 改写
	// r.RemoteAddr。若服务被直接访问（未走 Caddy 等反代），客户端可伪造该 header 让每次
	// 请求换个 IP，从而绕过下面按 IP 的登录/注册/入组限流。默认不信任，按 socket peer 限流；
	// 处于可信反代之后时设 TRUST_PROXY=true 才恢复按真实客户端 IP 限流。
	if cfg.TrustProxy {
		r.Use(middleware.RealIP)
	}
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
		// key 取自 r.RemoteAddr：启用 TRUST_PROXY 时由 middleware.RealIP 从 X-Forwarded-For 解析，
		// 未启用时即 socket peer 地址（客户端无法伪造）。
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
			// key 信任模型同上：取自 r.RemoteAddr，按 TRUST_PROXY 决定是否信任 X-Forwarded-For。
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

// clientIPKey 从 r.RemoteAddr 提取限流 key。未启用 TRUST_PROXY 时，r.RemoteAddr 是
// socket peer 地址（不可被客户端伪造），限流可信；启用后由 middleware.RealIP 改写为
// X-Forwarded-For 解析值，仅应在服务确实位于可信反代之后时开启。
func clientIPKey(r *http.Request) (string, error) {
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		ip = r.RemoteAddr
	}
	return httprate.CanonicalizeIP(ip), nil
}
