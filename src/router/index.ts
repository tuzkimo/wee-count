import { createRouter, createWebHistory } from "vue-router";

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
      path: "/register",
      name: "register",
      component: () => import("@/views/RegisterPage.vue"),
      meta: { hideTab: true },
    },
    // 旧路由重定向
    {
      path: "/transactions",
      redirect: "/",
    },
    {
      path: "/settings",
      component: () => import("@/views/SettingsPage.vue"),
    },
  ],
});

export default router;
