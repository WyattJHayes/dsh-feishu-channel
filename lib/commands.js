/**
 * Chat command parsing — messages starting with `/` are commands, everything
 * else is an agent prompt. Unknown commands are treated as plain text so a
 * prompt that happens to contain a slash-leading line still goes through.
 */

/**
 * @param {string} text raw message text (already trimmed)
 * @returns {{ type: 'prompt', text: string } |
 *           { type: 'new' } | { type: 'status' } | { type: 'sessions' } |
 *           { type: 'cancel' } | { type: 'use', index: number } |
 *           { type: 'project', path: string } |
 *           { type: 'approve', token: string } |
 *           { type: 'deny', token: string } |
 *           { type: 'usage', command: string, hint: string } |
 *           { type: 'help' } | null} null for empty input
 */
export function parseCommand(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const match = /^\/([a-z]+)(?:[ \t]+([\s\S]*))?$/i.exec(trimmed);
  if (!match) return { type: 'prompt', text: trimmed };
  const [, name] = match;
  const arg = match[2]?.trim();
  switch (name.toLowerCase()) {
    case 'new':
      return { type: 'new' };
    case 'status':
      return { type: 'status' };
    case 'sessions':
      return { type: 'sessions' };
    case 'cancel':
      return { type: 'cancel' };
    case 'revoke':
      return { type: 'revoke' };
    case 'help':
      return { type: 'help' };
    case 'project':
      return arg
        ? { type: 'project', path: arg }
        : { type: 'usage', command: 'project', hint: '/project <绝对路径>' };
    case 'approve':
      return arg
        ? { type: 'approve', token: arg }
        : { type: 'usage', command: 'approve', hint: '/approve <id>' };
    case 'deny':
      return arg
        ? { type: 'deny', token: arg }
        : { type: 'usage', command: 'deny', hint: '/deny <id>' };
    case 'use': {
      const index = Number.parseInt(arg ?? '', 10);
      return Number.isInteger(index) && index >= 1
        ? { type: 'use', index }
        : { type: 'usage', command: 'use', hint: '/use <序号>，例如 /use 2' };
    }
    default:
      // Not one of ours — treat the whole message (with the slash) as a prompt.
      return { type: 'prompt', text: trimmed };
  }
}

/** Split long text into sendable chunks (word-safe at chunk borders). */
export function chunkText(text, limit = 3800) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}
