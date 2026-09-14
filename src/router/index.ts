import { createRouter, createWebHistory } from "vue-router";
import { getLocalUsers } from "@/db/meta";
import { useAuthStore } from "@/stores/auth";
import { useLockStore } from "@/stores/lock";
import { LOCK_ALLOWED_PAGES, resolveLockRedirect } from "@/router/lockGuard";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/",
      name: "home",
      component: () => import("@/views/TransactionList.vue"),
    },
    {
      path: "/accounts/:id",
      name: "account-detail",
      component: () => import("@/views/TransactionList.vue"),
    },
    {
      path: "/record",
      name: "record",
      component: () => import("@/views/RecordPage.vue"),
      meta: { hideTab: true },
    },
    {
      path: "/record/:id",
      name: "record-edit",
      component: () => import("@/views/RecordPage.vue"),
      meta: { hideTab: true },
    },
    {
      path: "/filter",
      name: "filter",
      component: () => import("@/views/FilterPage.vue"),
      meta: { hideTab: true },
    },
    {
      path: "/accounts",
      name: "accounts",
      component: () => import("@/views/AccountList.vue"),
    },
    {
      path: "/accounts/:id/edit",
      name: "account-edit",
      component: () => import("@/views/AccountEdit.vue"),
    },
    {
      path: "/reports",
      name: "reports",
      component: () => import("@/views/ReportsPage.vue"),
    },
    {
      path: "/me",
      name: "me",
      component: () => import("@/views/MePage.vue"),
    },
    {
      path: "/login",
      name: "login",
      component: () => import("@/views/LoginPage.vue"),
      meta: { hideTab: true },
    },
    {
      path: "/welcome",
      name: "welcome",
      component: () => import("@/views/WelcomePage.vue"),
      meta: { hideTab: true },
    },
    {
      path: "/welcome/local",
      name: "welcome-local",
      component: () => import("@/views/LocalSetupPage.vue"),
      meta: { hideTab: true },
    },
    {
      path: "/bind-sync",
      name: "bind-sync",
      component: () => import("@/views/BindSyncPage.vue"),
      meta: { hideTab: true },
    },
    {
      path: "/teams/create",
      name: "create-team",
      component: () => import("@/views/CreateTeamPage.vue"),
      meta: { hideTab: true },
    },
    {
      path: "/teams/join",
      name: "join-team",
      component: () => import("@/views/JoinTeamPage.vue"),
      meta: { hideTab: true },
    },
    {
      path: "/teams/members",
      name: "team-members",
      component: () => import("@/views/TeamMembersPage.vue"),
      meta: { hideTab: true },
    },
    // 旧路由重定向
    {
      path: "/transactions",
      redirect: "/",
    },
    {
      path: "/profile",
      name: "profile",
      component: () => import("@/views/ProfilePage.vue"),
      meta: { hideTab: true },
    },
    {
      path: "/backup",
      name: "backup",
      component: () => import("@/views/BackupPage.vue"),
      meta: { hideTab: true },
    },
    // 锁定态的唯一放行页（见 `LOCK_ALLOWED_PAGES`）。这条路由必须有，
    // 否则守卫重定向过来会命中 `No match found`，锁直接不可用（空白视图）。
    // `hideTab`：锁定态下任何 tab 点了都会被守卫弹回这里，不如不显示。
    {
      path: "/unlock",
      name: "unlock",
      component: () => import("@/views/UnlockPage.vue"),
      meta: { hideTab: true },
    },
  ],
});

router.beforeEach(async (to) => {
  // 应用锁：锁定时业务页面根本不渲染，而不是盖遮罩。
  //
  // 两点是刻意的，别顺手「优化」掉：
  // 1. 锁判定必须在下面 `publicPages` 早返回**之前**，且用**锁专用窄名单**
  //    （`LOCK_ALLOWED_PAGES`，只有 `/unlock`）。`publicPages` 是给「未登录」用的；
  //    锁定态复用它等于放行两条真实数据出口——`/backup` 能经
  //    `localStorage.current_user_id` 无口令恢复会话后全量导出账目，
  //    `/bind-sync` 会把本地全量账本 POST 到页面输入框里填的任意地址。
  //    忘记 PIN 的出路是解锁页上的账户密码路径，不是这两页。
  // 2. 回跳带 `to.fullPath` 而不是 `to.path`，否则深链的 query 解锁后丢失。
  //    窄名单仍然按 `to.path` 匹配（见 LockGuardTarget 的说明）。
  //
  // 也放在 getLocalUsers() 之前，避免被锁时还去查库。
  const lockRedirect = resolveLockRedirect(
    { path: to.path, fullPath: to.fullPath },
    { isLocked: useLockStore().isLocked },
    LOCK_ALLOWED_PAGES,
  )
  if (lockRedirect !== true) return lockRedirect

  // 公共页面 (不需要登录)
  // `/unlock` 必须在列：否则锁定时跳转到解锁页会被守卫再次拦截，形成无限重定向。
  const publicPages = ['/welcome', '/welcome/local', '/login', '/bind-sync', '/backup', '/unlock']
  if (publicPages.includes(to.path)) return true

  // 检查是否有本地用户
  const users = await getLocalUsers()

  if (users.length === 0) {
    // 无用户 → 跳转欢迎页
    return { path: '/welcome', replace: true }
  }

  const auth = useAuthStore()

  // 尝试自动恢复会话
  await auth.init()

  // 如果 init 已自动恢复会话，直接放行
  if (auth.isAuthenticated) {
    // 团队功能需要在线模式
    const onlineOnlyPages = ['/teams/create', '/teams/join', '/teams/members']
    if (onlineOnlyPages.includes(to.path) && !auth.isOnline) {
      return { path: '/me', replace: true }
    }
    return true
  }

  // 有用户但未登录 → 跳转登录页
  return { path: '/login', replace: true }
})

export default router;
