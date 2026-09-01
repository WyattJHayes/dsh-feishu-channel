const DEFAULT_MIN_INTERVAL_MS = 2_000;
const DEFAULT_MAX_MESSAGES = 20;
const DEFAULT_STATUS_TTL_MS = 900_000;
const DEFAULT_MAX_SESSIONS = 1_024;

export function createProgressRelay(options = {}) {
  const getChatId = options.getChatId;
  const sendText = options.sendText;
  const minIntervalMs = boundedNumber(options.minIntervalMs, DEFAULT_MIN_INTERVAL_MS);
  const maxMessages = boundedNumber(options.maxMessages, DEFAULT_MAX_MESSAGES);
  const statusTtlMs = boundedPositive(options.statusTtlMs, DEFAULT_STATUS_TTL_MS);
  const maxSessions = boundedPositive(options.maxSessions, DEFAULT_MAX_SESSIONS);
  const now = options.now ?? (() => Date.now());
  const scheduler = options.scheduler ?? globalThis;
  const statuses = new Map();
  const statusExpiry = new Map();
  const pending = new Map();
  const recipients = new Map();
  const turnRecipients = new Map();
  let closed = false;

  function onSessionEvent(session, event) {
    if (closed) return;
    pruneExpired(now());
    const sessionId = getSessionId(session);
    if (!sessionId || !event?.type) return;

    if (!isTrackedEvent(event)) return;

    let target = resolveTarget(sessionId, session, event);
    if (!target) return;
    if (event.type === 'turn/start') {
      const turn = safeTurn(event.data?.turn);
      if (turn !== undefined) {
        let targets = turnRecipients.get(sessionId);
        if (!targets) {
          targets = new Map();
          turnRecipients.set(sessionId, targets);
        }
        targets.set(turn, target);
        while (targets.size > 32) targets.delete(targets.keys().next().value);
      }
    } else {
      target = resolveTarget(sessionId, session, event);
    }

    const status = getOrCreateStatus(sessionId);
    if (event.type === 'turn/start') {
      clearPending(sessionId);
      status.messageCount = 0;
      status.lastSentAt = undefined;
    }
    const summary = applyEvent(status, event);
    touchStatus(sessionId, status, now());
    if (!summary) return;

    status.lastSummary = summary;
    emit(sessionId, status, summary, target);
  }

  function getStatus(sessionId) {
    pruneExpired(now());
    const status = statuses.get(sessionId);
    if (!status) return undefined;
    touchStatus(sessionId, status, now());
    return { ...status };
  }

  function cancel(sessionId) {
    clearPending(sessionId);
    removeStatus(sessionId);
    recipients.delete(sessionId);
    turnRecipients.delete(sessionId);
  }

  function setRecipient(sessionId, chatId, recipient) {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') return;
    if (typeof chatId !== 'string' || chatId.trim() === '') return;
    pruneExpired(now());
    if (!recipients.has(sessionId) && recipients.size >= maxSessions) {
      const evictedSessionId = recipients.keys().next().value;
      recipients.delete(evictedSessionId);
      turnRecipients.delete(evictedSessionId);
    }
    recipients.set(sessionId, { chatId, recipient });
  }

  function clearRecipient(sessionId) {
    clearPending(sessionId);
    recipients.delete(sessionId);
    turnRecipients.delete(sessionId);
  }

  function close() {
    closed = true;
    statuses.clear();
    statusExpiry.clear();
    for (const sessionId of pending.keys()) clearPending(sessionId);
    recipients.clear();
    turnRecipients.clear();
  }

  function getOrCreateStatus(sessionId) {
    const existing = statuses.get(sessionId);
    if (existing) {
      touchStatus(sessionId, existing, now());
      return existing;
    }
    evictStatusIfNeeded();
    const status = {
      sessionId,
      phase: 'idle',
      turn: undefined,
      toolName: undefined,
      messageCount: 0,
      lastSummary: undefined,
      lastSentAt: undefined,
    };
    statuses.set(sessionId, status);
    touchStatus(sessionId, status, now());
    return status;
  }

  function touchStatus(sessionId, status, timestamp) {
    statuses.delete(sessionId);
    statuses.set(sessionId, status);
    statusExpiry.delete(sessionId);
    statusExpiry.set(sessionId, timestamp + statusTtlMs);
  }

  function pruneExpired(timestamp) {
    for (const [sessionId, expiresAt] of statusExpiry) {
      if (expiresAt <= timestamp) removeStatus(sessionId);
    }
  }

  function evictStatusIfNeeded() {
    if (statuses.size < maxSessions) return;
    const idle = [...statuses].find(([, status]) => status.phase === 'idle');
    const sessionId = idle?.[0] ?? statuses.keys().next().value;
    removeStatus(sessionId);
  }

  function removeStatus(sessionId) {
    clearPending(sessionId);
    statuses.delete(sessionId);
    statusExpiry.delete(sessionId);
    turnRecipients.delete(sessionId);
  }

  function applyEvent(status, event) {
    const data = event.data ?? {};
    if (event.type === 'turn/start') {
      status.phase = 'running';
      status.turn = safeTurn(data.turn);
      status.toolName = undefined;
      return 'Agent turn started.';
    }
    if (event.type === 'tool/call') {
      status.phase = 'running_tool';
      status.turn = safeTurn(data.turn, status.turn);
      status.toolName = safeToolName(data.name);
      return `Calling tool: ${status.toolName}.`;
    }
    if (event.type === 'approval/asked') {
      status.phase = 'waiting_approval';
      status.turn = safeTurn(data.turn, status.turn);
      return 'Waiting for approval.';
    }
    if (event.type === 'tool/result' && data.message?.isError) {
      status.phase = 'tool_failed';
      status.turn = safeTurn(data.turn, status.turn);
      status.toolName = safeToolName(data.name ?? status.toolName);
      return `Tool failed: ${status.toolName}.`;
    }
    if (event.type === 'turn/end') {
      status.phase = 'idle';
      status.turn = safeTurn(data.turn, status.turn);
      return 'Agent turn ended.';
    }
    return undefined;
  }

  function emit(sessionId, status, text, target, force = false) {
    if (closed) return;
    if (status.messageCount >= maxMessages) return;

    const timestamp = now();
    if (!force && status.lastSentAt !== undefined && timestamp - status.lastSentAt < minIntervalMs) {
      schedule(sessionId, status, text, target, Math.max(0, minIntervalMs - (timestamp - status.lastSentAt)));
      return;
    }

    if (!target || typeof sendText !== 'function') return;

    clearPending(sessionId);
    status.messageCount += 1;
    status.lastSentAt = timestamp;
    Promise.resolve()
      .then(() => {
        if (closed || statuses.get(sessionId) !== status) return undefined;
        return sendText(target.chatId, text, target.recipient);
      })
      .catch(() => {
        options.logger?.warn?.('feishu-channel: progress send failed');
      });
  }

  function schedule(sessionId, status, text, target, delayMs) {
    clearPending(sessionId);
    const timer = scheduler.setTimeout(() => {
      pending.delete(sessionId);
      if (closed || statuses.get(sessionId) !== status) return;
      emit(sessionId, status, text, target, true);
    }, delayMs);
    timer.unref?.();
    pending.set(sessionId, { timer, status });
  }

  function clearPending(sessionId) {
    const queued = pending.get(sessionId);
    if (!queued) return;
    scheduler.clearTimeout(queued.timer);
    pending.delete(sessionId);
  }

  function resolveTarget(sessionId, session, event) {
    const turn = safeTurn(event?.data?.turn);
    const turns = turnRecipients.get(sessionId);
    if (turn !== undefined && turns?.has(turn)) return turns.get(turn);
    const current = recipients.get(sessionId);
    if (current) return current;
    const chatId = resolveChatId(sessionId, session);
    return chatId ? { chatId, recipient: undefined } : undefined;
  }

  function resolveChatId(sessionId, session) {
    try {
      const chatId = getChatId?.(sessionId, session);
      return typeof chatId === 'string' && chatId.trim() ? chatId : undefined;
    } catch {
      return undefined;
    }
  }

  return { onSessionEvent, getStatus, setRecipient, clearRecipient, cancel, close };
}

function isTrackedEvent(event) {
  if (event.type === 'turn/start') return true;
  if (event.type === 'tool/call') return true;
  if (event.type === 'approval/asked') return true;
  if (event.type === 'turn/end') return true;
  return event.type === 'tool/result' && event.data?.message?.isError === true;
}

function boundedNumber(value, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function boundedPositive(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function safeTurn(value, fallback = undefined) {
  if (Number.isSafeInteger(value)) return value;
  return fallback;
}

function safeToolName(value) {
  if (typeof value !== 'string' || value.length === 0) return 'unknown';
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ');
  return normalized.match(/[A-Za-z0-9_.-]+/)?.[0]?.slice(0, 80) ?? 'unknown';
}

function getSessionId(session) {
  return session?.session?.id ?? session?.id ?? session?.sessionId;
}
