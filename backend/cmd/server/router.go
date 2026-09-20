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
			// 顺序是**分钟级在外层、日配额在内层**，因果链必须写清楚：
			// httprate 只给**放行**的请求计数（limiter.go:102-110：超限直接 return，
			// IncrementBy 只在放行路径上），而外层先判、外层先计数 ⇒ **外层会对每个
			// 它放行的请求记账，不管内层接下来会不会拒绝**。所以外层必须是分钟级：
			// 60 秒窗口打满，60 秒后就恢复，代价有界；反过来若日配额在外层，
			// 一个重试循环（连点 / 客户端重试 bug）会被分钟级全部拒掉、
			// 一次 AI 都没调用，却把当天额度耗尽 ⇒ 用户 24 小时用不了，什么都没得到。
			//
			// 分钟级限流器**只建一次、两个组共用**：/ai/* 共用同一个"每用户每分钟"桶，
			// 不给 status 单开一份，免得静默把整体额度放大一倍。
			aiMinuteLimit := httprate.LimitBy(cfg.AIRateLimit, time.Minute, aiKeyFn,
				httprate.WithLimitHandler(aiLimitHandler(service.AICodeRateLimited)))
			// 日配额只在"这次请求会被真正处理"时才计（见上面的因果链）。
			aiDailyLimit := httprate.LimitBy(cfg.AIDailyLimit, 24*time.Hour, aiKeyFn,
				httprate.WithLimitHandler(aiLimitHandler(service.AICodeQuotaExceeded)))

			r.Group(func(r chi.Router) {
				r.Use(aiMinuteLimit) // 外层：每用户每分钟（可恢复、代价有界）
				r.Group(func(r chi.Router) {
					r.Use(aiDailyLimit) // 内层：每用户每日（只给分钟级放行的请求计数）
					r.Post("/ai/chat", h.ai.Chat)
				})
				// /ai/status **不吃日配额**：它是廉价的本地响应、不发上游，
				// 而客户端要用它决定是否展示隐私卡（规格 §6.1/§7.3）。让它吃日配额的话，
				// 一次前台探测、或只是一个轮询 bug，就能在零 AI 调用的情况下把当天额度耗光。
				// 分钟级保留，防刷。
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
