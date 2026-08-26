const DEFAULT_MIN_INTERVAL_MS = 2_000;
const DEFAULT_MAX_MESSAGES = 20;

export function createProgressRelay(options = {}) {
  const getChatId = options.getChatId;
  const sendText = options.sendText;
  const minIntervalMs = boundedNumber(options.minIntervalMs, DEFAULT_MIN_INTERVAL_MS);
  const maxMessages = boundedNumber(options.maxMessages, DEFAULT_MAX_MESSAGES);
  const now = options.now ?? (() => Date.now());
  const statuses = new Map();
  const pending = new Map();

  function onSessionEvent(session, event) {
    const sessionId = getSessionId(session);
    if (!sessionId || !event?.type) return;

    if (!isTrackedEvent(event)) return;

    const status = getOrCreateStatus(sessionId);
    const summary = applyEvent(status, event);
    if (!summary) return;

    status.lastSummary = summary;
    emit(sessionId, session, status, summary);
  }

  function getStatus(sessionId) {
    const status = statuses.get(sessionId);
    if (!status) return undefined;
    return { ...status };
  }

  function cancel(sessionId) {
    clearPending(sessionId);
    statuses.delete(sessionId);
  }

  function close() {
    statuses.clear();
    for (const sessionId of pending.keys()) clearPending(sessionId);
  }

  function getOrCreateStatus(sessionId) {
    const existing = statuses.get(sessionId);
    if (existing) return existing;
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
    return status;
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

  function emit(sessionId, session, status, text, force = false) {
    if (status.messageCount >= maxMessages) return;

    const timestamp = now();
    if (!force && status.lastSentAt !== undefined && timestamp - status.lastSentAt < minIntervalMs) {
      schedule(sessionId, session, status, text, Math.max(0, minIntervalMs - (timestamp - status.lastSentAt)));
      return;
    }

    const chatId = getChatId?.(sessionId, session);
    if (!chatId || typeof sendText !== 'function') return;

    clearPending(sessionId);
    status.messageCount += 1;
    status.lastSentAt = timestamp;
    Promise.resolve()
      .then(() => {
        if (statuses.get(sessionId) !== status) return undefined;
        return sendText(chatId, text);
      })
      .catch(() => {});
  }

  function schedule(sessionId, session, status, text, delayMs) {
    clearPending(sessionId);
    const timer = setTimeout(() => {
      pending.delete(sessionId);
      if (statuses.get(sessionId) !== status) return;
      emit(sessionId, session, status, text, true);
    }, delayMs);
    timer.unref?.();
    pending.set(sessionId, { timer, status });
  }

  function clearPending(sessionId) {
    const queued = pending.get(sessionId);
    if (!queued) return;
    clearTimeout(queued.timer);
    pending.delete(sessionId);
  }

  return { onSessionEvent, getStatus, cancel, close };
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
