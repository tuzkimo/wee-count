// src/db/index.ts
// DEPRECATED: 使用 src/db/meta.ts 和 src/db/userDb.ts 替代
// 该文件保留用于向后兼容，新代码应从 userDb.ts 和 meta.ts 导入

// Re-export for backward compatibility
export { getUserDb, getCurrentUserId, openUserDb, closeUserDb } from './userDb'
export { getMetaDb, getLocalUsers, getLocalUser, getLocalUserByNickname, createLocalUser, updateLocalUserBinding, closeMetaDb } from './meta'
export type { LocalUser } from './meta'
