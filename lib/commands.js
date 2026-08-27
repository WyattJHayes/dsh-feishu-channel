/**
 * Chat command parsing — messages starting with `/` are commands, everything
 * else is an agent prompt. Unknown commands are treated as plain text so a
 * prompt that happens to contain a slash-leading line still goes through.
 */

/**
 * @param {string} text raw message text (already trimmed)
 * @returns {{ type: 'prompt', text: string } |
 *           { type: 'new' } | { type: 'status' } |
 *           { type: 'cancel' } |
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
    case 'cancel':
      return { type: 'cancel' };
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
    default:
      // Not one of ours — treat the whole message (with the slash) as a prompt.
      return { type: 'prompt', text: trimmed };
  }
}

/** Split long text into sendable chunks without breaking code points or newlines. */
export function chunkText(text, limit = 3800) {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('FEISHU_CHUNK_LIMIT_INVALID: limit must be a positive integer');
  }
  const codePoints = Array.from(text);
  if (codePoints.length <= limit) return [text];
  const chunks = [];
  let offset = 0;
  while (codePoints.length - offset > limit) {
    const end = offset + limit;
    const newline = codePoints.lastIndexOf('\n', end - 1);
    const cut = newline >= offset + limit / 2 ? newline + 1 : end;
    chunks.push(codePoints.slice(offset, cut).join(''));
    offset = cut;
  }
  if (offset < codePoints.length) chunks.push(codePoints.slice(offset).join(''));
  return chunks;
}

/** Limit text by Unicode code points while preserving an explicit truncation marker. */
export function truncateText(text, limit, marker = '\n[输出已截断]') {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('FEISHU_TEXT_LIMIT_INVALID: limit must be a positive integer');
  }
  const codePoints = Array.from(String(text));
  if (codePoints.length <= limit) return String(text);
  const markerCodePoints = Array.from(marker);
  if (limit < markerCodePoints.length) return '…';
  return `${codePoints.slice(0, limit - markerCodePoints.length).join('')}${marker}`;
}
