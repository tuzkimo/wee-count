import { createRouter, createWebHistory } from "vue-router";
import Home from "@/views/Home.vue";
import AccountList from "@/views/AccountList.vue";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/",
      name: "home",
      component: Home,
    },
    {
      path: "/accounts",
      name: "accounts",
      component: AccountList,
    },
    {
      path: "/accounts/:id/transactions",
      name: "account-transactions",
      component: () => import("@/views/TransactionList.vue"),
    },
    {
      path: "/accounts/:id/edit",
      name: "account-edit",
      component: () => import("@/views/AccountEdit.vue"),
    },
  ],
});

export default router;
