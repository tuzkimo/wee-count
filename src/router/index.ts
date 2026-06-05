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
  ],
});

export default router;
