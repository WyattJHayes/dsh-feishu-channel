import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProgressRelay } from '../lib/progress-relay.js';

function flushAsyncSends() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('progress relay sends bounded summaries and never sends raw tool arguments', async () => {
  const sent = [];
  const relay = createProgressRelay({
    getChatId: () => 'chat-1',
    sendText: async (_chatId, text) => sent.push(text),
    minIntervalMs: 0,
    maxMessages: 3,
  });
  const session = { id: 'session-1' };

  relay.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } });
  relay.onSessionEvent(session, {
    type: 'tool/call',
    data: { turn: 1, step: 1, name: 'bash', arguments: { command: 'cat SECRET_VALUE' } },
  });
  relay.onSessionEvent(session, {
    type: 'tool/result',
    data: { turn: 1, step: 1, message: { isError: true, content: [{ type: 'text', text: 'raw output' }] } },
  });
  await flushAsyncSends();

  assert.ok(sent.some((text) => text.includes('bash')));
  assert.ok(sent.every((text) => !text.includes('SECRET_VALUE') && !text.includes('raw output')));
  assert.ok(sent.length <= 3);
});

test('progress relay projects session status without allowing outside mutation', async () => {
  let currentTime = 100;
  const relay = createProgressRelay({
    getChatId: () => 'chat-1',
    sendText: async () => {},
    minIntervalMs: 1000,
    maxMessages: 10,
    now: () => currentTime,
  });
  const session = { id: 'session-1' };

  relay.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } });
  relay.onSessionEvent(session, {
    type: 'tool/call',
    data: { turn: 1, step: 1, name: 'bash', arguments: { command: 'cat SECRET_VALUE' } },
  });
  relay.onSessionEvent(session, { type: 'approval/asked', data: { reason: 'show SECRET_VALUE' } });
  const status = relay.getStatus('session-1');
  status.phase = 'mutated';
  status.lastSummary = 'mutated SECRET_VALUE';
  currentTime = 2_000;
  relay.onSessionEvent(session, { type: 'turn/end', data: { turn: 1 } });

  assert.deepEqual(relay.getStatus('session-1'), {
    sessionId: 'session-1',
    phase: 'idle',
    turn: 1,
    toolName: 'bash',
    messageCount: 2,
    lastSummary: 'Agent turn ended.',
    lastSentAt: 2_000,
  });
});

test('progress relay rate limits messages while preserving in-memory status', async () => {
  let currentTime = 0;
  const sent = [];
  const timers = [];
  const scheduler = {
    setTimeout(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      timer.cancelled = true;
    },
  };
  const relay = createProgressRelay({
    getChatId: () => 'chat-1',
    sendText: async (_chatId, text) => sent.push(text),
    minIntervalMs: 10,
    maxMessages: 10,
    now: () => currentTime,
    scheduler,
  });
  const session = { id: 'session-1' };

  relay.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } });
  currentTime = 5;
  relay.onSessionEvent(session, { type: 'tool/call', data: { name: 'bash', arguments: { token: 'SECRET_VALUE' } } });
  await flushAsyncSends();

  assert.deepEqual(sent, ['Agent turn started.']);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 5);
  assert.equal(relay.getStatus('session-1').phase, 'running_tool');
  assert.equal(relay.getStatus('session-1').lastSummary, 'Calling tool: bash.');
  relay.close();
});

test('progress relay stops sending after maxMessages but keeps status current', async () => {
  let currentTime = 0;
  const sent = [];
  const relay = createProgressRelay({
    getChatId: () => 'chat-1',
    sendText: async (_chatId, text) => sent.push(text),
    minIntervalMs: 0,
    maxMessages: 1,
    now: () => currentTime,
  });
  const session = { id: 'session-1' };

  relay.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } });
  currentTime = 1;
  relay.onSessionEvent(session, { type: 'tool/call', data: { name: 'bash' } });
  await flushAsyncSends();

  assert.deepEqual(sent, ['Agent turn started.']);
  assert.equal(relay.getStatus('session-1').messageCount, 1);
  assert.equal(relay.getStatus('session-1').lastSummary, 'Calling tool: bash.');
});

test('progress relay catches async send failures and continues handling later events', async () => {
  let currentTime = 0;
  const sent = [];
  const warnings = [];
  const relay = createProgressRelay({
    getChatId: () => 'chat-1',
    sendText: async (_chatId, text) => {
      if (text.includes('started')) throw new Error('network failed');
      sent.push(text);
    },
    minIntervalMs: 0,
    maxMessages: 3,
    now: () => currentTime,
    logger: {
      warn(message) {
        warnings.push(message);
      },
    },
  });
  const session = { id: 'session-1' };

  assert.doesNotThrow(() => relay.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } }));
  currentTime = 1;
  assert.doesNotThrow(() => relay.onSessionEvent(session, { type: 'tool/call', data: { name: 'bash' } }));
  await flushAsyncSends();

  assert.deepEqual(sent, ['Calling tool: bash.']);
  assert.deepEqual(warnings, ['feishu-channel: progress send failed']);
  assert.equal(relay.getStatus('session-1').messageCount, 2);
});

test('progress relay suppresses pending sends after immediate cancel', async () => {
  const sent = [];
  const relay = createProgressRelay({
    getChatId: () => 'chat-1',
    sendText: async (_chatId, text) => sent.push(text),
    minIntervalMs: 0,
    maxMessages: 10,
  });

  relay.onSessionEvent({ id: 'session-1' }, { type: 'turn/start', data: { turn: 1 } });
  relay.cancel('session-1');
  await flushAsyncSends();

  assert.deepEqual(sent, []);
});

test('progress relay suppresses pending sends after immediate close', async () => {
  const sent = [];
  const relay = createProgressRelay({
    getChatId: () => 'chat-1',
    sendText: async (_chatId, text) => sent.push(text),
    minIntervalMs: 0,
    maxMessages: 10,
  });

  relay.onSessionEvent({ id: 'session-1' }, { type: 'turn/start', data: { turn: 1 } });
  relay.close();
  await flushAsyncSends();

  assert.deepEqual(sent, []);
});

test('progress relay ignores late events after close', async () => {
  const sent = [];
  const relay = createProgressRelay({
    getChatId: () => 'chat-1',
    sendText: async (_chatId, text) => sent.push(text),
    minIntervalMs: 0,
    maxMessages: 10,
  });

  relay.close();
  relay.onSessionEvent({ id: 'session-1' }, { type: 'turn/start', data: { turn: 1 } });
  await flushAsyncSends();

  assert.equal(relay.getStatus('session-1'), undefined);
  assert.deepEqual(sent, []);
});

test('progress relay does not let a cancelled send attach to a recreated session', async () => {
  const sent = [];
  const relay = createProgressRelay({
    getChatId: () => 'chat-1',
    sendText: async (_chatId, text) => sent.push(text),
    minIntervalMs: 0,
    maxMessages: 10,
  });

  relay.onSessionEvent({ id: 'session-1' }, { type: 'turn/start', data: { turn: 1 } });
  relay.cancel('session-1');
  relay.onSessionEvent({ id: 'session-1' }, { type: 'tool/call', data: { turn: 2, name: 'bash' } });
  await flushAsyncSends();

  assert.deepEqual(sent, ['Calling tool: bash.']);
  assert.equal(relay.getStatus('session-1').turn, 2);
});

test('progress relay ignores unknown events without creating status', () => {
  const relay = createProgressRelay({
    getChatId: () => 'chat-1',
    sendText: async () => {},
    minIntervalMs: 0,
    maxMessages: 10,
  });

  relay.onSessionEvent({ id: 'session-1' }, { type: 'assistant/chunk', data: { text: 'SECRET_VALUE' } });

  assert.equal(relay.getStatus('session-1'), undefined);
});

test('progress relay stores only safe integer turns', () => {
  const relay = createProgressRelay({
    getChatId: () => 'chat-1',
    sendText: async () => {},
    minIntervalMs: 0,
    maxMessages: 10,
  });
  const unsafeTurn = { value: 1, secret: 'SECRET_VALUE' };

  relay.onSessionEvent({ id: 'session-1' }, { type: 'turn/start', data: { turn: unsafeTurn } });
  relay.onSessionEvent({ id: 'session-1' }, { type: 'tool/call', data: { turn: 2.5, name: 'bash' } });

  assert.equal(relay.getStatus('session-1').turn, undefined);
});

test('progress relay cancel and close clear tracked session status', () => {
  const relay = createProgressRelay({
    getChatId: () => 'chat-1',
    sendText: async () => {},
    minIntervalMs: 0,
    maxMessages: 10,
  });

  relay.onSessionEvent({ id: 'session-1' }, { type: 'turn/start', data: { turn: 1 } });
  relay.onSessionEvent({ id: 'session-2' }, { type: 'turn/start', data: { turn: 1 } });
  relay.cancel('session-1');
  assert.equal(relay.getStatus('session-1'), undefined);
  assert.equal(relay.getStatus('session-2').phase, 'running');
  relay.close();
  assert.equal(relay.getStatus('session-2'), undefined);
});

test('progress relay flushes the latest suppressed summary after rate limiting', async () => {
  const sent = [];
  const relay = createProgressRelay({
    getChatId: () => 'chat-1',
    sendText: async (_chatId, text) => sent.push(text),
    minIntervalMs: 15,
    maxMessages: 10,
  });

  relay.onSessionEvent({ id: 'session-1' }, { type: 'turn/start', data: { turn: 1 } });
  await flushAsyncSends();
  relay.onSessionEvent({ id: 'session-1' }, { type: 'turn/end', data: { turn: 1 } });

  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.deepEqual(sent, ['Agent turn started.', 'Agent turn ended.']);
  relay.close();
});

test('progress relay flushes a scheduled summary even when the injected clock is fixed', async () => {
  const sent = [];
  const relay = createProgressRelay({
    getChatId: () => 'chat-1',
    sendText: async (_chatId, text) => sent.push(text),
    minIntervalMs: 15,
    maxMessages: 10,
    now: () => 100,
  });

  relay.onSessionEvent({ id: 'session-1' }, { type: 'turn/start', data: { turn: 1 } });
  await flushAsyncSends();
  relay.onSessionEvent({ id: 'session-1' }, { type: 'turn/end', data: { turn: 1 } });

  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.deepEqual(sent, ['Agent turn started.', 'Agent turn ended.']);
  relay.close();
});

test('progress relay resets the message budget and pending summary for every turn', async () => {
  const sent = [];
  const relay = createProgressRelay({
    getChatId: () => 'chat-1',
    sendText: async (_chatId, text) => sent.push(text),
    minIntervalMs: 1000,
    maxMessages: 1,
  });

  relay.onSessionEvent({ id: 'session-1' }, { type: 'turn/start', data: { turn: 1 } });
  relay.onSessionEvent({ id: 'session-1' }, { type: 'tool/call', data: { turn: 1, name: 'bash' } });
  relay.onSessionEvent({ id: 'session-1' }, { type: 'turn/start', data: { turn: 2 } });
  await flushAsyncSends();

  const status = relay.getStatus('session-1');
  assert.deepEqual(sent, ['Agent turn started.', 'Agent turn started.']);
  assert.equal(status.phase, 'running');
  assert.equal(status.turn, 2);
  assert.equal(status.messageCount, 1);
  assert.equal(status.lastSummary, 'Agent turn started.');
  relay.close();
});

test('progress relay ignores tracked events for sessions without a chat binding', async () => {
  const relay = createProgressRelay({
    getChatId: () => undefined,
    sendText: async () => assert.fail('unbound session must not send'),
    minIntervalMs: 0,
    maxMessages: 10,
  });

  relay.onSessionEvent({ id: 'desktop-session' }, { type: 'turn/start', data: { turn: 1 } });

  assert.equal(relay.getStatus('desktop-session'), undefined);
  relay.close();
});

test('progress relay expires idle status entries after the configured TTL', () => {
  let currentTime = 0;
  const relay = createProgressRelay({
    getChatId: () => 'chat-1',
    sendText: async () => {},
    minIntervalMs: 0,
    maxMessages: 10,
    statusTtlMs: 10,
    now: () => currentTime,
  });

  relay.onSessionEvent({ id: 'session-1' }, { type: 'turn/start', data: { turn: 1 } });
  assert.equal(relay.getStatus('session-1').phase, 'running');
  currentTime = 10;

  assert.equal(relay.getStatus('session-1'), undefined);
  relay.close();
});

test('progress relay evicts the least recently used status at session capacity', () => {
  const relay = createProgressRelay({
    getChatId: () => 'chat-1',
    sendText: async () => {},
    minIntervalMs: 0,
    maxMessages: 10,
    maxSessions: 2,
  });

  relay.onSessionEvent({ id: 'session-1' }, { type: 'turn/start', data: { turn: 1 } });
  relay.onSessionEvent({ id: 'session-2' }, { type: 'turn/start', data: { turn: 1 } });
  relay.getStatus('session-1');
  relay.onSessionEvent({ id: 'session-3' }, { type: 'turn/start', data: { turn: 1 } });

  assert.equal(relay.getStatus('session-1').phase, 'running');
  assert.equal(relay.getStatus('session-2'), undefined);
  assert.equal(relay.getStatus('session-3').phase, 'running');
  relay.close();
});

test('progress relay accepts an injected scheduler for bounded rate limiting', async () => {
  const sent = [];
  const timers = [];
  const scheduler = {
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length - 1;
    },
    clearTimeout(timer) {
      timers[timer] = undefined;
    },
  };
  const relay = createProgressRelay({
    getChatId: () => 'chat-1',
    sendText: async (_chatId, text) => sent.push(text),
    minIntervalMs: 10,
    maxMessages: 10,
    now: () => 0,
    scheduler,
  });

  relay.onSessionEvent({ id: 'session-1' }, { type: 'turn/start', data: { turn: 1 } });
  relay.onSessionEvent({ id: 'session-1' }, { type: 'turn/end', data: { turn: 1 } });
  assert.equal(timers[0].delay, 10);
  timers[0].callback();
  await flushAsyncSends();

  assert.deepEqual(sent, ['Agent turn started.', 'Agent turn ended.']);
  relay.close();
});

test('progress relay freezes the recipient for each Agent turn', async () => {
  const sent = [];
  const relay = createProgressRelay({
    sendText: async (chatId, text, recipient) => sent.push({ chatId, text, recipient }),
    minIntervalMs: 0,
    maxMessages: 10,
  });
  const first = { receiveId: 'user-a', receiveIdType: 'open_id' };
  const second = { receiveId: 'user-b', receiveIdType: 'open_id' };

  relay.setRecipient('session-1', 'chat-1', first);
  relay.onSessionEvent({ id: 'session-1' }, { type: 'turn/start', data: { turn: 1 } });
  relay.setRecipient('session-1', 'chat-1', second);
  relay.onSessionEvent({ id: 'session-1' }, { type: 'tool/call', data: { turn: 1, name: 'bash' } });
  relay.onSessionEvent({ id: 'session-1' }, { type: 'turn/start', data: { turn: 2 } });
  await flushAsyncSends();

  assert.deepEqual(sent.map(({ text, recipient }) => ({ text, recipient })), [
    { text: 'Agent turn started.', recipient: first },
    { text: 'Calling tool: bash.', recipient: first },
    { text: 'Agent turn started.', recipient: second },
  ]);
  relay.close();
});

test('progress relay keeps the recipient captured for the active turn', async () => {
  const sent = [];
  const relay = createProgressRelay({
    sendText: async (chatId, text, recipient) => sent.push({ chatId, text, recipient }),
    minIntervalMs: 0,
    maxMessages: 10,
  });
  const firstRecipient = { receiveId: 'user-a', receiveIdType: 'open_id' };
  const secondRecipient = { receiveId: 'user-b', receiveIdType: 'open_id' };
  const session = { id: 'session-1' };

  relay.setRecipient('session-1', 'chat-1', firstRecipient);
  relay.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } });
  relay.setRecipient('session-1', 'chat-1', secondRecipient);
  relay.onSessionEvent(session, { type: 'turn/end', data: { turn: 1 } });
  await flushAsyncSends();

  assert.deepEqual(sent.map(({ recipient }) => recipient), [firstRecipient, firstRecipient]);
  relay.close();
});

test('progress relay drops frozen turn recipients when a session recipient is cleared', async () => {
  const sent = [];
  const relay = createProgressRelay({
    sendText: async (chatId, text, recipient) => sent.push({ chatId, text, recipient }),
    minIntervalMs: 0,
    maxMessages: 10,
  });
  const recipient = { receiveId: 'user-a', receiveIdType: 'open_id' };

  relay.setRecipient('session-1', 'chat-1', recipient);
  relay.onSessionEvent({ id: 'session-1' }, { type: 'turn/start', data: { turn: 1 } });
  relay.clearRecipient('session-1');
  relay.onSessionEvent({ id: 'session-1' }, { type: 'turn/end', data: { turn: 1 } });
  await flushAsyncSends();

  assert.deepEqual(sent.map(({ text }) => text), ['Agent turn started.']);
  relay.close();
});

test('progress relay drops frozen turn recipients when the recipient LRU evicts a session', async () => {
  const sent = [];
  const relay = createProgressRelay({
    sendText: async (chatId, text, recipient) => sent.push({ chatId, text, recipient }),
    minIntervalMs: 0,
    maxMessages: 10,
    maxSessions: 1,
  });
  const first = { receiveId: 'user-a', receiveIdType: 'open_id' };
  const second = { receiveId: 'user-b', receiveIdType: 'open_id' };

  relay.setRecipient('session-1', 'chat-1', first);
  relay.onSessionEvent({ id: 'session-1' }, { type: 'turn/start', data: { turn: 1 } });
  relay.setRecipient('session-2', 'chat-2', second);
  relay.onSessionEvent({ id: 'session-1' }, { type: 'tool/call', data: { turn: 1, name: 'bash' } });
  await flushAsyncSends();

  assert.deepEqual(sent.map(({ chatId, text, recipient }) => ({ chatId, text, recipient })), [
    { chatId: 'chat-1', text: 'Agent turn started.', recipient: first },
  ]);
  relay.close();
});
