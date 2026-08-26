/**
 * Access control — deny-by-default. Only explicitly allow-listed Feishu
 * identities may drive the agent (it can run bash on this machine).
 *
 * Identity of a message:
 * - p2p chat: sender open_id
 * - group chat: BOTH the chat id AND the sender open_id must be allowed,
 *   so adding a chat to the whitelist never leaks access to its members.
 */

/**
 * @param {{ allowedOpenIds?: string[], allowedChatIds?: string[], openIds?: string[], chatIds?: string[] }} acl
 * @param {{ openId?: string, chatId?: string, chatType?: string, isGroup?: boolean }}
 * @returns {boolean}
 */
export function isAllowed(acl, { openId, chatId, chatType, isGroup } = {}) {
  const openIds = acl.allowedOpenIds ?? acl.openIds ?? [];
  const chatIds = acl.allowedChatIds ?? acl.chatIds ?? [];
  const resolvedChatType = chatType ?? (typeof isGroup === 'boolean' ? (isGroup ? 'group' : 'p2p') : undefined);
  if (resolvedChatType !== 'p2p' && resolvedChatType !== 'group') return false;
  if (!openId || !openIds.includes(openId)) return false;
  if (resolvedChatType === 'group' && !(chatId && chatIds.includes(chatId))) return false;
  return true;
}

/** Normalize user input list: trim + drop empties. @param {unknown} value */
export function normalizeList(value) {
  if (Array.isArray(value)) {
    return value.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split(/[,\s]+/).filter(Boolean);
  }
  return [];
}
