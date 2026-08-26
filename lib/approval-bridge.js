import { randomUUID } from 'node:crypto';

const VALID_OUTCOMES = new Set(['allowed-once', 'rejected', 'cancelled', 'unavailable']);

export function createApprovalBridge(options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const summaryTtlMs = options.summaryTtlMs ?? timeoutMs;
  const sendApproval = options.sendApproval;
  const now = options.now ?? (() => Date.now());
  const tokenFactory = options.tokenFactory ?? (() => `ap-${randomUUID()}`);
  const summaries = new Map();
  const summaryTimers = new Map();
  const approvals = new Map();
  const tokens = new Map();
  let closed = false;

  function remember(exec, summary) {
    if (closed) return;
    const key = approvalKey(exec);
    if (!key) return;
    clearSummary(key);
    const record = {
      summary: sanitizeSummary(summary),
      expiresAt: now() + summaryTtlMs,
    };
    summaries.set(key, record);
    const timer = setTimeout(() => {
      if (summaries.get(key) === record) summaries.delete(key);
      summaryTimers.delete(key);
    }, summaryTtlMs);
    timer.unref?.();
    summaryTimers.set(key, timer);
  }

  async function answer(chatId, token, outcome) {
    if (closed) return { ok: false };
    if (!VALID_OUTCOMES.has(outcome)) return { ok: false };
    const key = tokens.get(token);
    if (!key) return { ok: false };
    const record = approvals.get(key);
    if (!record) return { ok: false };
    if (record.expiresAt <= now()) {
      finish(key, 'unavailable');
      return { ok: false };
    }
    if (record.chatId !== chatId) return { ok: false };
    finish(key, outcome);
    return { ok: true };
  }

  function cancelSession(sessionId) {
    for (const [key, record] of approvals) {
      if (record.sessionId === sessionId) finish(key, 'cancelled');
    }
    for (const key of summaries.keys()) {
      if (key.startsWith(`${sessionId}:`)) clearSummary(key);
    }
  }

  function close() {
    closed = true;
    for (const key of [...approvals.keys()]) finish(key, 'unavailable');
    summaries.clear();
    for (const timer of summaryTimers.values()) clearTimeout(timer);
    summaryTimers.clear();
  }

  function createListener(getChatId) {
    return async function approvalListener(exec, next) {
      if (closed) return 'unavailable';
      const sessionId = getSessionId(exec);
      const callId = getCallId(exec);
      if (!sessionId || !callId) return 'unavailable';

      const key = keyFromParts(sessionId, callId);
      const existing = approvals.get(key);
      if (existing) {
        if (existing.expiresAt <= now()) {
          finish(key, 'unavailable');
        } else {
          return existing.promise;
        }
      }

      const chatId = getChatId(sessionId);
      if (!chatId) return next();

      const summaryRecord = summaries.get(key);
      clearSummary(key);
      if (!summaryRecord || summaryRecord.expiresAt <= now()) return 'unavailable';

      let resolveApproval;
      const promise = new Promise((resolve) => {
        resolveApproval = resolve;
      });
      const record = {
        promise,
        token: undefined,
        chatId,
        sessionId,
        resolve: resolveApproval,
        expiresAt: now() + timeoutMs,
        timer: undefined,
      };
      const token = tokenFactory();
      if (tokens.has(token)) {
        record.resolve('unavailable');
        return promise;
      }
      record.token = token;
      record.timer = setTimeout(() => finish(key, 'unavailable'), timeoutMs);
      record.timer.unref?.();
      approvals.set(key, record);
      tokens.set(token, key);

      const signal = exec?.signal;
      if (signal?.aborted) {
        finish(key, 'cancelled');
        return promise;
      }
      if (signal?.addEventListener) {
        record.signal = signal;
        record.abortHandler = () => finish(key, 'cancelled');
        signal.addEventListener('abort', record.abortHandler, { once: true });
      }

      Promise.resolve()
        .then(() => {
          if (approvals.get(key) !== record || closed) return undefined;
          return sendApproval(chatId, formatApprovalMessage(summaryRecord.summary, token));
        })
        .catch(() => finish(key, 'unavailable'));
      return promise;
    };
  }

  function finish(key, outcome) {
    const record = approvals.get(key);
    if (!record) return;
    approvals.delete(key);
    if (record.token) tokens.delete(record.token);
    clearTimeout(record.timer);
    if (record.abortHandler) {
      const signal = record.signal;
      signal?.removeEventListener?.('abort', record.abortHandler);
    }
    record.resolve(outcome);
  }

  function clearSummary(key) {
    summaries.delete(key);
    const timer = summaryTimers.get(key);
    if (timer) clearTimeout(timer);
    summaryTimers.delete(key);
  }

  return { remember, answer, cancelSession, close, createListener };
}

function formatApprovalMessage(summary, token) {
  return [
    '需要审批高风险工具调用',
    `工具: ${summary.toolName}`,
    `风险: ${summary.riskCategory}`,
    `路径: ${summary.projectRelativePath}`,
    `/approve ${token}`,
    `/deny ${token}`,
  ].join('\n');
}

function sanitizeSummary(summary) {
  return {
    toolName: safeField(summary?.toolName, 'unknown', /[A-Za-z0-9_.-]+/),
    riskCategory: safeField(summary?.riskCategory, 'unknown', /[A-Za-z0-9_.-]+/),
    projectRelativePath: safeField(summary?.projectRelativePath, '.', /[A-Za-z0-9_./-]+/),
  };
}

function safeField(value, fallback, pattern) {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ');
  return normalized.match(pattern)?.[0]?.slice(0, 80) ?? fallback;
}

function approvalKey(exec) {
  const sessionId = getSessionId(exec);
  const callId = getCallId(exec);
  if (!sessionId || !callId) return undefined;
  return keyFromParts(sessionId, callId);
}

function keyFromParts(sessionId, callId) {
  return `${sessionId}:${callId}`;
}

function getSessionId(exec) {
  return exec?.agent?.session?.id ?? exec?.agent?.id ?? exec?.session?.id ?? exec?.sessionId;
}

function getCallId(exec) {
  return exec?.callId ?? exec?.toolCallId ?? exec?.id;
}
