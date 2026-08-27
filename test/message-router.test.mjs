import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMessageRouter } from '../lib/message-router.js';

function createMemoryBindings(initial = {}) {
  const map = new Map(Object.entries(initial).map(([chatId, binding]) => [chatId, copyBinding(binding)]));
  return {
    get(chatId) {
      return copyBinding(map.get(chatId));
    },
    bind(chatId, binding) {
      map.set(chatId, copyBinding(binding));
    },
    clearSession(chatId) {
      const binding = map.get(chatId);
      if (!binding) return false;
      map.set(chatId, {
        projectPath: binding.projectPath,
        ...(binding.model ? { model: { ...binding.model } } : {}),
      });
      return true;
    },
  };
}

function copyBinding(binding) {
  if (!binding) return undefined;
  return {
    projectPath: binding.projectPath,
    ...(binding.sessionId ? { sessionId: binding.sessionId } : {}),
    ...(binding.model ? { model: { ...binding.model } } : {}),
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((entryResolve, entryReject) => {
    resolve = entryResolve;
    reject = entryReject;
  });
  return { promise, resolve, reject };
}

function makeRouterOptions(overrides = {}) {
  const bindings = overrides.bindings ?? createMemoryBindings();
  const sent = [];
  const options = {
    config: {
      allowedOpenIds: ['user-1'],
      allowedChatIds: ['chat-1'],
      maxPromptLength: 100,
      dshHomeAvailable: true,
      ...overrides.config,
    },
    bindings,
    projectPolicy: {
      calls: [],
      resolve(path) {
        this.calls.push(path);
        return { ok: true, path };
      },
      ...overrides.projectPolicy,
    },
    driver: {
      promptCalls: 0,
      promptTexts: [],
      cancelCalls: [],
      resetCalls: [],
      statusCalls: [],
      enqueuePrompt(chatId, text) {
        this.promptCalls += 1;
        this.promptTexts.push(text);
        return { position: 1, promise: Promise.resolve({ kind: 'text', text: `done:${text}` }) };
      },
      cancel(chatId) {
        this.cancelCalls.push(chatId);
        return Promise.resolve({ cancelled: true });
      },
      reset(chatId) {
        this.resetCalls.push(chatId);
        bindings.clearSession(chatId);
        return Promise.resolve({ cancelled: false });
      },
      status(chatId) {
        this.statusCalls.push(chatId);
        return { state: 'ready', projectPath: bindings.get(chatId)?.projectPath, queueSize: 0 };
      },
      ...overrides.driver,
    },
    approvalBridge: {
      answerCalls: [],
      answer(chatId, token, outcome) {
        this.answerCalls.push({ chatId, token, outcome });
        return Promise.resolve({ ok: true });
      },
      ...overrides.approvalBridge,
    },
    progressRelay: {
      cancelCalls: [],
      cancel(sessionId) {
        this.cancelCalls.push(sessionId);
      },
      ...overrides.progressRelay,
    },
    logger: { warn() {}, info() {}, ...overrides.logger },
    sendCalls: 0,
    sent,
    sendText: async (chatId, text) => {
      options.sendCalls += 1;
      sent.push({ chatId, text });
    },
  };
  if (overrides.sendText) options.sendText = overrides.sendText;
  return options;
}

function lastText(options) {
  return options.sent.at(-1)?.text ?? '';
}

test('router refuses prompts until a project is bound', async () => {
  const sent = [];
  const router = createMessageRouter(makeRouterOptions({ sendText: async (_id, text) => sent.push(text) }));

  await router.handleMessage({ eventId: 'e-1', chatId: 'chat-1', openId: 'user-1', chatType: 'p2p', text: '列出文件' });

  assert.match(sent.at(-1), /project/);
  assert.equal(router.driver.promptCalls, 0);
});

test('router binds a validated project and routes approve without queueing it', async () => {
  const sent = [];
  const options = makeRouterOptions({ sendText: async (_id, text) => sent.push(text) });
  options.projectPolicy.resolve = () => ({ ok: true, path: '/work/project' });
  const router = createMessageRouter(options);

  await router.handleMessage({ eventId: 'e-1', chatId: 'chat-1', openId: 'user-1', chatType: 'p2p', text: '/project /work/project' });
  await router.handleMessage({ eventId: 'e-2', chatId: 'chat-1', openId: 'user-1', chatType: 'p2p', text: '/approve ap-1' });

  assert.equal(options.bindings.get('chat-1').projectPath, '/work/project');
  assert.equal(options.approvalBridge.answerCalls.length, 1);
  assert.equal(options.driver.promptCalls, 0);
});

test('router ignores duplicated event ids', async () => {
  const options = makeRouterOptions();
  const router = createMessageRouter(options);
  const event = { eventId: 'e-1', chatId: 'chat-1', openId: 'user-1', chatType: 'p2p', text: '/status' };

  await router.handleMessage(event);
  await router.handleMessage(event);

  assert.equal(options.sendCalls, 1);
});

test('router drops messages without event ids or with unknown chat types', async () => {
  const options = makeRouterOptions();
  const router = createMessageRouter(options);

  await router.handleMessage({ chatId: 'chat-1', openId: 'user-1', chatType: 'p2p', text: '/status' });
  await router.handleMessage({ eventId: 'unknown-type', chatId: 'chat-1', openId: 'user-1', chatType: 'channel', text: '/status' });

  assert.equal(options.sendCalls, 0);
});

test('router denies empty allowlists before policy, bridge, or driver can run', async () => {
  const options = makeRouterOptions({
    config: { allowedOpenIds: [], allowedChatIds: [] },
  });
  const router = createMessageRouter(options);

  await router.handleMessage({ eventId: 'e-1', chatId: 'chat-1', openId: 'user-1', chatType: 'p2p', text: '/project /work/project' });
  await router.handleMessage({ eventId: 'e-2', chatId: 'chat-1', openId: 'user-1', chatType: 'p2p', text: '/approve ap-1' });
  await router.handleMessage({ eventId: 'e-3', chatId: 'chat-1', openId: 'user-1', chatType: 'p2p', text: '列出文件' });

  assert.equal(options.projectPolicy.calls.length, 0);
  assert.equal(options.approvalBridge.answerCalls.length, 0);
  assert.equal(options.driver.promptCalls, 0);
});

test('router refuses project rebinding across projects until new clears the session', async () => {
  const bindings = createMemoryBindings({
    'chat-1': { projectPath: '/work/project-a', sessionId: 'session-1' },
  });
  const options = makeRouterOptions({ bindings });
  options.projectPolicy.resolve = (path) => ({ ok: true, path });
  const router = createMessageRouter(options);

  await router.handleMessage({ eventId: 'e-1', chatId: 'chat-1', openId: 'user-1', chatType: 'p2p', text: '/project /work/project-b' });

  assert.equal(bindings.get('chat-1').projectPath, '/work/project-a');
  assert.equal(bindings.get('chat-1').sessionId, 'session-1');
  assert.match(lastText(options), /new/);
});

test('router keeps the project and clears the session for new conversations', async () => {
  const bindings = createMemoryBindings({
    'chat-1': { projectPath: '/work/project', sessionId: 'session-1' },
  });
  const options = makeRouterOptions({ bindings });
  const router = createMessageRouter(options);

  await router.handleMessage({ eventId: 'e-1', chatId: 'chat-1', openId: 'user-1', chatType: 'p2p', text: '/new' });

  assert.deepEqual(bindings.get('chat-1'), { projectPath: '/work/project' });
  assert.deepEqual(options.driver.resetCalls, ['chat-1']);
});

test('router allows a project switch when no Agent session is bound', async () => {
  const bindings = createMemoryBindings({
    'chat-1': { projectPath: '/work/project-a' },
  });
  const options = makeRouterOptions({ bindings });
  options.projectPolicy.resolve = (path) => ({ ok: true, path });
  const router = createMessageRouter(options);

  await router.handleMessage({ eventId: 'e-project-switch', chatId: 'chat-1', openId: 'user-1', chatType: 'p2p', text: '/project /work/project-b' });

  assert.deepEqual(bindings.get('chat-1'), { projectPath: '/work/project-b' });
  assert.deepEqual(options.driver.resetCalls, []);
});

test('router resets a stale session before replacing an invalid project binding', async () => {
  const bindings = createMemoryBindings({
    'chat-1': { projectPath: '/work/project-a', sessionId: 'session-1' },
  });
  const options = makeRouterOptions({ bindings });
  options.projectPolicy.resolve = (path) => path === '/work/project-a'
    ? { ok: false, message: 'old project unavailable' }
    : { ok: true, path };
  const router = createMessageRouter(options);

  await router.handleMessage({ eventId: 'e-stale-project', chatId: 'chat-1', openId: 'user-1', chatType: 'p2p', text: '/project /work/project-b' });

  assert.deepEqual(options.driver.resetCalls, ['chat-1']);
  assert.deepEqual(bindings.get('chat-1'), { projectPath: '/work/project-b' });
});

test('router rejects overlong prompts before they reach the Agent', async () => {
  const options = makeRouterOptions({
    bindings: createMemoryBindings({ 'chat-1': { projectPath: '/work/project' } }),
    config: { maxPromptLength: 3 },
  });
  const router = createMessageRouter(options);

  await router.handleMessage({ eventId: 'e-1', chatId: 'chat-1', openId: 'user-1', chatType: 'p2p', text: 'abcd' });

  assert.equal(options.driver.promptCalls, 0);
  assert.match(lastText(options), /过长/);
});

test('router returns a bounded error when the prompt queue is full', async () => {
  const options = makeRouterOptions({
    bindings: createMemoryBindings({ 'chat-1': { projectPath: '/work/project' } }),
    driver: {
      enqueuePrompt() {
        throw new Error('FEISHU_PROMPT_QUEUE_FULL: waiting capacity reached');
      },
    },
  });
  const router = createMessageRouter(options);

  await router.handleMessage({ eventId: 'e-full', chatId: 'chat-1', openId: 'user-1', chatType: 'p2p', text: 'run' });

  assert.equal(lastText(options), '出错了：FEISHU_PROMPT_QUEUE_FULL');
});

test('router treats unknown slash commands as ordinary prompts after project binding', async () => {
  const options = makeRouterOptions({
    bindings: createMemoryBindings({ 'chat-1': { projectPath: '/work/project' } }),
  });
  const router = createMessageRouter(options);

  await router.handleMessage({ eventId: 'e-1', chatId: 'chat-1', openId: 'user-1', chatType: 'p2p', text: '/unknown keep it' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(options.driver.promptTexts, ['/unknown keep it']);
  assert.equal(lastText(options), 'done:/unknown keep it');
});

test('router sends only sanitized bounded error text when a prompt fails', async () => {
  const failure = createDeferred();
  const options = makeRouterOptions({
    bindings: createMemoryBindings({ 'chat-1': { projectPath: '/work/project' } }),
    driver: {
      promptCalls: 0,
      promptTexts: [],
      enqueuePrompt(chatId, text) {
        this.promptCalls += 1;
        this.promptTexts.push(text);
        return { position: 1, promise: failure.promise };
      },
    },
  });
  const router = createMessageRouter(options);

  await router.handleMessage({ eventId: 'e-1', chatId: 'chat-1', openId: 'user-1', chatType: 'p2p', text: 'run' });
  failure.reject(new Error('FEISHU_SESSION_CREATE_FAILED: bad\nSECRET_VALUE='.padEnd(400, 'x')));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(lastText(options), '出错了：FEISHU_SESSION_CREATE_FAILED');
  assert.equal(lastText(options).includes('\n'), false);
  assert.equal(lastText(options).includes('SECRET_VALUE'), false);
  assert.ok(lastText(options).length < 180);
});

test('router does not expose unstructured Agent error text', async () => {
  const failure = createDeferred();
  const options = makeRouterOptions({
    bindings: createMemoryBindings({ 'chat-1': { projectPath: '/work/project' } }),
    driver: {
      enqueuePrompt() {
        return { position: 1, promise: failure.promise };
      },
    },
  });
  const router = createMessageRouter(options);

  await router.handleMessage({ eventId: 'e-unstructured-error', chatId: 'chat-1', openId: 'user-1', chatType: 'p2p', text: 'run' });
  failure.reject(new Error('provider response included SECRET_VALUE and full prompt'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(lastText(options), '出错了：FEISHU_PROMPT_FAILED');
  assert.equal(lastText(options).includes('SECRET_VALUE'), false);
});

test('router help includes approval commands', async () => {
  const options = makeRouterOptions();
  const router = createMessageRouter(options);

  await router.handleMessage({ eventId: 'e-help', chatId: 'chat-1', openId: 'user-1', chatType: 'p2p', text: '/help' });

  assert.match(lastText(options), /\/approve/);
  assert.match(lastText(options), /\/deny/);
});

test('router replies with a sanitized error when a control command fails', async () => {
  const options = makeRouterOptions({
    driver: {
      status() {
        throw new Error('FEISHU_STATUS_FAILED: backend SECRET_VALUE');
      },
    },
  });
  const router = createMessageRouter(options);

  await assert.doesNotReject(() => router.handleMessage({
    eventId: 'e-1',
    chatId: 'chat-1',
    openId: 'user-1',
    chatType: 'p2p',
    text: '/status',
  }));

  assert.equal(lastText(options), '出错了：FEISHU_STATUS_FAILED');
  assert.equal(lastText(options).includes('SECRET_VALUE'), false);
});

test('router logs a bounded Feishu API code when outbound sending fails', async () => {
  const warnings = [];
  const options = makeRouterOptions({
    logger: {
      warn(message) {
        warnings.push(message);
      },
    },
    sendText: async () => {
      const error = new Error('FEISHU_SEND_API_FAILED: api_code=99992402');
      error.apiCode = '99992402';
      throw error;
    },
  });
  const router = createMessageRouter(options);

  await router.handleMessage({
    eventId: 'e-send-error',
    chatId: 'chat-1',
    openId: 'user-1',
    chatType: 'p2p',
    text: '/status',
  });

  assert.deepEqual(warnings, ['feishu-channel: send failed: FEISHU_SEND_API_FAILED (api_code=99992402)']);
});
