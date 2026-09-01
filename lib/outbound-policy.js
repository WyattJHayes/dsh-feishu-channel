const REDACTED = '[REDACTED]';
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/giu;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/giu;
const API_TOKEN_PATTERN = /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/giu;
const GITHUB_TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
const AWS_ACCESS_KEY_PATTERN = /\bAKIA[0-9A-Z]{16}\b/g;
const SENSITIVE_ASSIGNMENT_PATTERN = /\b((?:app[_-]?secret|api[_-]?(?:key|token)|access[_-]?token|auth(?:orization)?|password|passwd|private[_-]?key|secret|token))\b\s*([:=])\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\])]+)/giu;

/**
 * Remove known credential values and conservative secret-shaped values before
 * any text reaches a remote chat provider.
 * @param {unknown} value
 * @param {unknown[] | unknown} [knownValues]
 */
export function sanitizeOutboundText(value, knownValues = []) {
  let text = typeof value === 'string' ? value : String(value ?? '');

  for (const secret of normalizeKnownValues(knownValues)) {
    text = text.split(secret).join(REDACTED);
  }

  text = text.replace(PRIVATE_KEY_PATTERN, REDACTED);
  text = text.replace(BEARER_TOKEN_PATTERN, REDACTED);
  text = text.replace(API_TOKEN_PATTERN, REDACTED);
  text = text.replace(GITHUB_TOKEN_PATTERN, REDACTED);
  text = text.replace(AWS_ACCESS_KEY_PATTERN, REDACTED);
  return text.replace(SENSITIVE_ASSIGNMENT_PATTERN, (_match, key, separator) => `${key}${separator}${REDACTED}`);
}

function normalizeKnownValues(values) {
  const candidates = Array.isArray(values) ? values : [values];
  return [...new Set(candidates
    .filter((value) => typeof value === 'string' && value.length >= 4 && value !== REDACTED))]
    .sort((left, right) => right.length - left.length);
}
