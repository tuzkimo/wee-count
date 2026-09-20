// backend/cmd/server/router.go
package main

import (
	"net"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/go-chi/httprate"

	"wee-count/backend/internal/config"
	"wee-count/backend/internal/handler"
	mw "wee-count/backend/internal/middleware"
	"wee-count/backend/internal/service"
)

// handlers 汇总路由需要的 handler，避免 newRouter 的参数列表过长。
type handlers struct {
	auth *handler.AuthHandler
	sync *handler.SyncHandler
	team *handler.TeamHandler
	ai   *handler.AIHandler
}

// newRouter 构造完整路由。**从 main 抽出来是为了让测试能直接断言中间件顺序**
// （规格 §8.D）：测试若自己重建一个路由，验证的就是测试里的顺序而不是生产的顺序，
// 那种测试永远是绿的、等于没测。
func newRouter(cfg *config.Config, h handlers) http.Handler {
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
		r.Post("/auth/refresh", h.auth.Refresh)

		// 登录/注册按 IP 限流，防暴力破解。
		// key 取自 r.RemoteAddr：启用 TRUST_PROXY 时由 middleware.RealIP 从 X-Forwarded-For 解析，
		// 未启用时即 socket peer 地址（客户端无法伪造）。
		r.Group(func(r chi.Router) {
			r.Use(httprate.LimitBy(10, time.Minute, clientIPKey))
			r.Post("/auth/login", h.auth.Login)
			r.Post("/auth/register", h.auth.Register)
		})

		// protected
		r.Group(func(r chi.Router) {
			r.Use(mw.AuthMiddleware(cfg.JWTSecret))
			r.Get("/me", h.auth.Me)
			r.Put("/auth/profile", h.auth.UpdateProfile)
			r.Post("/sync", h.sync.Sync)
			r.Post("/teams", h.team.Create)
			r.Post("/teams/{id}/invite", h.team.Invite)
			r.Get("/teams/{id}/members", h.team.Members)

			// 邀请码 6 位（10^6 空间）可被登录用户离线爆破入组，故 join 也限流。
			// key 信任模型同上：取自 r.RemoteAddr，按 TRUST_PROXY 决定是否信任 X-Forwarded-For。
			r.Group(func(r chi.Router) {
				r.Use(httprate.LimitBy(10, time.Minute, clientIPKey))
				r.Post("/teams/join", h.team.Join)
			})

			// AI：**两条限流都必须在 AuthMiddleware 之后**（上面那行），
			// 否则 GetUserID 返回空串、所有用户共用一个桶（规格 §6.3）。
			//
			// 日配额注册在分钟级之前（更外层）：同时超两条时，用户该看到的是
			// "今日 AI 次数已用完"（有明确的下一步——明天再来），而不是
			// "请求太频繁，稍后再试"（会把人引向过一会儿再来、然后继续撞墙）。
			r.Group(func(r chi.Router) {
				r.Use(httprate.LimitBy(cfg.AIDailyLimit, 24*time.Hour, aiKeyFn,
					httprate.WithLimitHandler(aiLimitHandler(service.AICodeQuotaExceeded))))
				r.Use(httprate.LimitBy(cfg.AIRateLimit, time.Minute, aiKeyFn,
					httprate.WithLimitHandler(aiLimitHandler(service.AICodeRateLimited))))
				r.Post("/ai/chat", h.ai.Chat)
				r.Get("/ai/status", h.ai.Status)
			})
		})
	})

	return r
}

// aiKeyFn 是 AI 两条限流（分钟级 + 日配额）共用的 key：必须是 userID。
// 它读的是 AuthMiddleware 写进 ctx 的值，所以两条限流都必须在 AuthMiddleware
// 之后注册，否则这里返回空串、所有用户共用一个桶（规格 §6.3）。
func aiKeyFn(r *http.Request) (string, error) {
	return mw.GetUserID(r.Context()), nil
}

// aiLimitHandler 产出限流错误响应。httprate 默认的 429 响应体是纯文本
// （"Too Many Requests"），不是我们的 `{"error":"<code>"}` 形状，
// 而客户端是按 code 映射中文文案的，所以每条限流都必须显式换成这个。
func aiLimitHandler(code string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":"` + code + `"}`))
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
