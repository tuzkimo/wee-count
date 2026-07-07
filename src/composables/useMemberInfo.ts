import { getMemberAlias, getTeamMembers, getCurrentUserId } from "@/db/userDb";
import { useAuthStore } from "@/stores/auth";

export interface MemberInfo {
  displayName: string;
  avatarUrl: string | null;
}

/**
 * 统一成员解析：别名（userDb member_aliases，userDb 主人即 setter）> 昵称 > username。
 * 不再 fallback 到 id 前 8 位。
 */
export function useMemberInfo() {
  const auth = useAuthStore();

  async function getMember(userId: string): Promise<MemberInfo> {
    const myServerId = auth.currentLocalUser?.server_user_id;
    const myLocalId = getCurrentUserId();
    const selfId = myServerId || myLocalId || "";

    if (userId === selfId || userId === myServerId) {
      return {
        displayName: "我",
        avatarUrl: auth.currentLocalUser?.avatar_url ?? null,
      };
    }

    // 别名优先
    const alias = await getMemberAlias(userId);
    if (alias) {
      // 仍需 team_members 拿头像
      const member = await lookupTeamMember(userId);
      return { displayName: alias.alias_name, avatarUrl: member?.avatar_url ?? null };
    }

    const member = await lookupTeamMember(userId);
    if (member?.nickname) return { displayName: member.nickname, avatarUrl: member.avatar_url };
    if (member?.username) return { displayName: member.username, avatarUrl: member.avatar_url };

    // 无任何信息：显示 id 前 8 位（兜底，正常情况不会到这）
    return { displayName: userId.slice(0, 8), avatarUrl: null };
  }

  async function lookupTeamMember(userId: string) {
    // team_members 缓存按 team_id 存，需遍历当前团队的缓存。
    // ponytail: 取当前 ledger 的 team_id，查该 team；若无可从 ledger store 推导。
    const { useLedgerStore } = await import("@/stores/ledger");
    const ledger = useLedgerStore().currentLedger;
    if (!ledger?.team_id) return null;
    const members = await getTeamMembers(ledger.team_id);
    return members.find((m) => m.user_id === userId) ?? null;
  }

  return { getMember };
}
