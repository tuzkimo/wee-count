import { createRouter, createWebHistory } from "vue-router";
import { getLocalUsers } from "@/db/meta";
import { useAuthStore } from "@/stores/auth";

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
      path: "/settings",
      component: () => import("@/views/SettingsPage.vue"),
    },
  ],
});

router.beforeEach(async (to) => {
  // 公共页面 (不需要登录)
  const publicPages = ['/welcome', '/welcome/local', '/login', '/bind-sync']
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
    const onlineOnlyPages = ['/teams/create', '/teams/join']
    if (onlineOnlyPages.includes(to.path) && !auth.isOnline) {
      return { path: '/me', replace: true }
    }
    return true
  }

  // 有用户但未登录 → 跳转登录页
  return { path: '/login', replace: true }
})

export default router;
