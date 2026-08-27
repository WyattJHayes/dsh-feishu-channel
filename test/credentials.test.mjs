import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WSClient } from '@larksuiteoapi/node-sdk';
import { normalizeConfig } from '../lib/config.js';
import { apply, createIndexedBindings, resolveStatePath } from '../lib/index.js';

test('config: default credential refs use environment-compatible names', () => {
  const { config } = normalizeConfig();

  assert.equal(config.appIdRef, 'FEISHU_APP_ID');
  assert.equal(config.appSecretRef, 'FEISHU_APP_SECRET');
});

test('config: rejects credential refs that are not environment-compatible names', () => {
  const result = normalizeConfig({ appIdRef: 'feishu.app_id', appSecretRef: 'FEISHU_APP_SECRET' });

  assert.match(result.errors.join('; '), /appIdRef/);
});

test('config: normalizes allowed project roots and numeric limits', () => {
  const { config, errors } = normalizeConfig({
    allowedProjectRoots: ['/tmp/workspace'],
    approvalTimeoutMs: 600000,
    progressIntervalMs: 2000,
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(config.allowedProjectRoots, ['/tmp/workspace']);
  assert.equal(config.approvalTimeoutMs, 600000);
  assert.equal(config.progressIntervalMs, 2000);
  assert.equal(config.maxQueuedPrompts, 8);
  assert.equal(config.groupOutputMode, 'sender');
  assert.equal(config.maxOutboundQueue, 64);
});

test('config: rejects numeric limits that exceed remote-safe bounds', () => {
  const { errors } = normalizeConfig({
    approvalTimeoutMs: 3_600_001,
    maxPromptLength: 120_001,
    maxQueuedPrompts: 101,
  });

  assert.match(errors.join('; '), /approvalTimeoutMs must not exceed 3600000/);
  assert.match(errors.join('; '), /maxPromptLength must not exceed 120000/);
  assert.match(errors.join('; '), /maxQueuedPrompts must not exceed 100/);
});

test('config: rejects an unknown group output mode', () => {
  const { errors } = normalizeConfig({ groupOutputMode: 'everyone' });

  assert.match(errors.join('; '), /groupOutputMode must be either sender or group/);
});

test('plugin: declares the services used by apply', async () => {
  const { inject } = await import('../lib/index.js');

  assert.deepEqual(inject, ['credentials', 'agents', 'agentDefaultModel', 'agentPresets', 'permissionPresets']);
});

test('plugin: reads the top-level event id emitted by the Lark dispatcher', async () => {
  const { extractEventId } = await import('../lib/index.js');

  assert.equal(extractEventId({ event_id: 'event-top-level' }), 'event-top-level');
  assert.equal(extractEventId({ header: { event_id: 'event-legacy' } }), 'event-legacy');
});

test('agent: maps the selected default model to creation options', async () => {
  const { createAgentOptions } = await import('../lib/index.js');

  assert.deepEqual(
    createAgentOptions({ provider: 'wechat', model: 'Deepseek-v4-flash', reasoningEffort: 'medium' }),
    { provider: 'wechat', model: 'Deepseek-v4-flash' },
  );
});

test('agent: includes cwd in creation metadata', async () => {
  const { createAgentMeta } = await import('../lib/index.js');

  assert.deepEqual(createAgentMeta(undefined, '/tmp/feishu-channel'), { cwd: '/tmp/feishu-channel' });
  assert.deepEqual(createAgentMeta('minimal-win', '/tmp/feishu-channel'), {
    cwd: '/tmp/feishu-channel',
    agentPreset: 'minimal-win',
  });
});

test('agent: setup callback does not return the model selection disposer', async () => {
  const { createAgentSetup } = await import('../lib/index.js');
  const agentCtx = {
    agent: { session: { events: [], append() {} } },
    on: () => () => {},
  };
  const agentPresets = { mount: async () => {} };
  const permissionPresets = {
    apply(_session, _preset, setApproval) {
      setApproval('ask');
    },
    current() { return 'workspace-write'; },
  };

  assert.equal(await createAgentSetup(agentCtx, {
    current: { provider: 'wechat', model: 'Deepseek-v4-flash' },
    agentPresets,
    permissionPresets,
  }), undefined);
});

test('agent: refuses setup when the permission preset service is missing', async () => {
  const { createAgentSetup } = await import('../lib/index.js');
  const agentCtx = { agent: { session: { events: [] } }, on: () => () => {} };

  await assert.rejects(() => createAgentSetup(agentCtx, {
    current: { provider: 'deepseek', model: 'model-1' },
    agentPresets: { mount: async () => {} },
  }), /FEISHU_NO_PERMISSION_PRESETS_SERVICE/);
});

test('agent: refuses setup when permission cannot be reduced to workspace-write', async () => {
  const { createAgentSetup } = await import('../lib/index.js');
  const agentCtx = { agent: { session: { events: [] } }, on: () => () => {} };

  await assert.rejects(() => createAgentSetup(agentCtx, {
    current: { provider: 'deepseek', model: 'model-1' },
    agentPresets: { mount: async () => {} },
    permissionPresets: {
      apply() {},
      current() { return 'danger-full-access'; },
    },
  }), /FEISHU_REMOTE_PERMISSION_FAILED/);
});

test('agent: refuses setup when permission application does not confirm approval mode', async () => {
  const { createAgentSetup } = await import('../lib/index.js');
  const agentCtx = {
    agent: { session: { events: [], append() {} } },
    on: () => () => {},
  };

  await assert.rejects(() => createAgentSetup(agentCtx, {
    current: { provider: 'deepseek', model: 'model-1' },
    agentPresets: { mount: async () => {} },
    permissionPresets: {
      apply() {},
      current() { return 'workspace-write'; },
    },
  }), /FEISHU_REMOTE_PERMISSION_FAILED/);
});

test('agent: applies the workspace-write preset before registering remote listeners', async () => {
  const { createAgentSetup } = await import('../lib/index.js');
  const order = [];
  const session = {
    events: [],
    append(type, data) {
      this.events.push({ type, data });
    },
  };
  const agentCtx = {
    agent: { session },
    on(name) {
      order.push(`on:${name}`);
      return () => {};
    },
  };
  const permissionPresets = {
    apply(receivedSession, name, setApproval) {
      assert.equal(receivedSession, session);
      assert.equal(name, 'workspace-write');
      order.push('permission');
      setApproval('ask');
    },
    current() { return 'workspace-write'; },
  };

  await createAgentSetup(agentCtx, {
    current: { provider: 'deepseek', model: 'model-1' },
    chatId: 'chat-1',
    projectPath: '/work/project',
    agentPresets: { mount: async () => order.push('mount') },
    approvalBridge: {
      remember() {},
      createListener() {
        return async () => 'allowed-once';
      },
    },
    permissionPresets,
  });

  assert.deepEqual(order, [
    'mount',
    'permission',
    'on:system-prompt/assemble',
    'on:agent/request',
    'on:tools/pre-execute',
    'on:approval/request',
  ]);
  assert.deepEqual(session.events, [{ type: 'approval/policy', data: { policy: 'ask' } }]);
});

test('agent: reuses only a live session binding', async () => {
  const { getLiveAgentSessionId } = await import('../lib/index.js');

  assert.equal(getLiveAgentSessionId({ sessionId: 'session-1' }, (id) => (id === 'session-1' ? {} : undefined)), 'session-1');
  assert.equal(getLiveAgentSessionId({ sessionId: 'session-2' }, () => undefined), undefined);
});

test('agent: creates unique Feishu session ids', async () => {
  const { createAgentSessionId } = await import('../lib/index.js');
  const first = createAgentSessionId();
  const second = createAgentSessionId();

  assert.match(first, /^feishu-session-[0-9a-f-]{36}$/);
  assert.notEqual(first, second);
});

test('agent: reads the id from an AgentHandle', async () => {
  const { getAgentSessionId } = await import('../lib/index.js');

  assert.equal(getAgentSessionId({ agent: { id: 'session-1' } }), 'session-1');
});

test('agent: builds a user message for followup', async () => {
  const { createAgentUserMessage } = await import('../lib/index.js');
  const message = createAgentUserMessage('hello');

  assert.match(message.id, /^[0-9a-f-]{36}$/);
  assert.equal(message.role, 'user');
  assert.deepEqual(message.content, [{ type: 'text', text: 'hello' }]);
  assert.deepEqual(message.source, { kind: 'user' });
});

test('agent: reads final assistant text from the completed turn', async () => {
  const { getAgentTurnResult } = await import('../lib/index.js');
  const result = getAgentTurnResult(
    [
      { seq: 0, type: 'turn/start', data: { turn: 1 } },
      {
        seq: 1,
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 1,
          message: { content: [{ type: 'tool-call', toolCallId: 'call-1' }] },
        },
      },
      {
        seq: 2,
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 2,
          message: { content: [{ type: 'text', text: '旧回合结果' }] },
        },
      },
      { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      { seq: 4, type: 'turn/start', data: { turn: 2 } },
      {
        seq: 5,
        type: 'assistant/message',
        data: {
          turn: 2,
          step: 1,
          message: { content: [{ type: 'tool-call', toolCallId: 'call-2' }] },
        },
      },
      {
        seq: 6,
        type: 'assistant/message',
        data: {
          turn: 2,
          step: 2,
          message: { content: [{ type: 'text', text: '运行完成' }] },
        },
      },
      { seq: 7, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
    ],
    4,
    2,
  );

  assert.deepEqual(result, { kind: 'text', text: '运行完成' });
});

test('agent: does not select an unrelated latest turn without a claimed turn', async () => {
  const { getAgentTurnResult } = await import('../lib/index.js');
  const result = getAgentTurnResult([
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'desktop result' }] } } },
    { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ], 0);

  assert.deepEqual(result, { kind: 'pending' });
});

test('credentials: returns the trimmed value from a credential lookup', async () => {
  const { resolveCredential } = await import('../lib/index.js');
  const calls = [];
  const value = await resolveCredential(
    {
      resolve(ref) {
        calls.push(ref);
        return Promise.resolve({ value: ' app-id ' });
      },
    },
    'FEISHU_APP_ID',
  );

  assert.equal(value, 'app-id');
  assert.deepEqual(calls, ['FEISHU_APP_ID']);
});

test('sender rejects a non-zero Feishu business response', async () => {
  const { createFeishuSender } = await import('../lib/index.js');
  const sender = createFeishuSender({
    resolveCredential: async (ref) => ref === 'FEISHU_APP_ID' ? 'test-app-id' : 'test-app-secret',
    clientFactory: () => ({
      im: {
        message: {
          create: async () => ({ code: 230020, msg: 'permission denied' }),
        },
      },
    }),
    timeoutMs: 100,
  });

  await assert.rejects(() => sender('chat-1', 'final text'), (error) => {
    assert.equal(error.message, 'FEISHU_SEND_API_FAILED: api_code=230020');
    return true;
  });
});

test('sender rejects a pending Feishu request with a bounded timeout', async () => {
  const { createFeishuSender } = await import('../lib/index.js');
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const sender = createFeishuSender({
    resolveCredential: async () => 'test-credential',
    clientFactory: () => ({
      im: {
        message: {
          create: () => pending,
        },
      },
    }),
    timeoutMs: 20,
  });

  await assert.rejects(() => sender('chat-1', 'final text'), (error) => {
    assert.equal(error.message, 'FEISHU_SEND_TIMEOUT');
    return true;
  });
  release({ code: 0 });
});

test('sender bounds pending credential lookup and client construction', async () => {
  const { createFeishuSender } = await import('../lib/index.js');
  const never = new Promise(() => {});
  const credentialTimeoutSender = createFeishuSender({
    resolveCredential: () => never,
    timeoutMs: 20,
  });
  const clientTimeoutSender = createFeishuSender({
    resolveCredential: async () => 'test-credential',
    clientFactory: () => never,
    timeoutMs: 20,
  });

  await assert.rejects(() => credentialTimeoutSender('chat-1', 'final text'), /FEISHU_SEND_TIMEOUT/);
  await assert.rejects(() => clientTimeoutSender('chat-1', 'final text'), /FEISHU_SEND_TIMEOUT/);
});

test('timed HTTP adapter passes a finite timeout to SDK requests', async () => {
  const { createTimeoutHttpInstance } = await import('../lib/index.js');
  const requests = [];
  const http = createTimeoutHttpInstance({
    request(options) {
      requests.push(options);
      return Promise.resolve({ ok: true });
    },
    post(url, data, options) {
      requests.push({ url, data, ...options });
      return Promise.resolve({ ok: true });
    },
  }, 321);

  assert.deepEqual(await http.request({ url: 'https://example.test', timeout: 0 }), { ok: true });
  assert.deepEqual(await http.post('https://example.test/token', { app_id: 'test' }), { ok: true });
  assert.equal(requests[0].timeout, 321);
  assert.equal(requests[1].timeout, 321);
});

test('sender applies the finite timeout to default SDK token and message requests', async () => {
  const { createFeishuSender } = await import('../lib/index.js');
  const requests = [];
  const sender = createFeishuSender({
    resolveCredential: async (ref) => ref === 'FEISHU_APP_ID' ? 'test-default-client-app-id' : 'test-default-client-secret',
    httpInstance: {
      post(url, _data, options) {
        requests.push({ method: 'post', url, timeout: options?.timeout });
        return Promise.resolve({ code: 0, tenant_access_token: 'test-tenant-token', expire: 3600 });
      },
      request(options) {
        requests.push({ method: options.method, url: options.url, timeout: options.timeout });
        return Promise.resolve({ code: 0, data: { message_id: 'test-message-id' } });
      },
    },
    timeoutMs: 321,
  });

  await sender('chat-1', 'final text');

  assert.deepEqual(
    requests.map(({ method, timeout }) => ({ method, timeout })),
    [{ method: 'post', timeout: 321 }, { method: 'POST', timeout: 321 }],
  );
});

test('sender serializes concurrent messages and releases the queue after completion', async () => {
  const { createFeishuSender } = await import('../lib/index.js');
  const calls = [];
  let releaseFirst;
  const firstRequest = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let messageNumber = 0;
  const sender = createFeishuSender({
    resolveCredential: async () => 'test-queue-credential',
    clientFactory: () => ({
      im: {
        message: {
          create: () => {
            messageNumber += 1;
            calls.push(messageNumber);
            return messageNumber === 1 ? firstRequest : Promise.resolve({ code: 0 });
          },
        },
      },
    }),
    timeoutMs: 1000,
  });

  const first = sender('chat-1', 'first');
  await new Promise((resolve) => setImmediate(resolve));
  const second = sender('chat-1', 'second');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, [1]);
  releaseFirst({ code: 0 });
  await Promise.all([first, second]);
  assert.deepEqual(calls, [1, 2]);
});

test('sender bounds the number of active and queued outbound messages', async () => {
  const { createFeishuSender } = await import('../lib/index.js');
  let releaseFirst;
  const firstRequest = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const sender = createFeishuSender({
    resolveCredential: async () => 'test-queue-credential',
    clientFactory: () => ({
      im: {
        message: {
          create: () => firstRequest,
        },
      },
    }),
    timeoutMs: 1000,
    maxQueueSize: 1,
  });

  const first = sender('chat-1', 'first');
  await assert.rejects(() => sender('chat-1', 'second'), /FEISHU_SEND_QUEUE_FULL/);
  releaseFirst({ code: 0 });
  await first;
});

test('sender can target an authorized group sender instead of the shared chat', async () => {
  const { createFeishuSender } = await import('../lib/index.js');
  const requests = [];
  const sender = createFeishuSender({
    resolveCredential: async () => 'test-credential',
    resolveRecipient: () => ({ receiveId: 'user-1', receiveIdType: 'open_id' }),
    clientFactory: () => ({
      im: {
        message: {
          create: async (request) => {
            requests.push(request);
            return { code: 0 };
          },
        },
      },
    }),
    timeoutMs: 100,
  });

  await sender('chat-1', 'private result');

  assert.deepEqual(requests[0].params, { receive_id_type: 'open_id' });
  assert.equal(requests[0].data.receive_id, 'user-1');
});

test('sender retries a retryable 429 response and honors retry-after', async () => {
  const { createFeishuSender } = await import('../lib/index.js');
  const delays = [];
  const uuids = [];
  let attempts = 0;
  const sender = createFeishuSender({
    resolveCredential: async () => 'test-credential',
    clientFactory: () => ({
      im: {
        message: {
          create: async ({ data }) => {
            attempts += 1;
            uuids.push(data.uuid);
            if (attempts === 1) return { status: 429, headers: { 'retry-after': '2' }, code: 429 };
            return { code: 0 };
          },
        },
      },
    }),
    timeoutMs: 100,
    maxRetries: 2,
    retryBaseMs: 1,
    sleep: async (delay) => delays.push(delay),
  });

  await sender('chat-1', 'final text');

  assert.equal(attempts, 2);
  assert.deepEqual(delays, [2000]);
  assert.match(uuids[0], /^[0-9a-f-]{36}$/);
  assert.equal(uuids[0], uuids[1]);
});

test('sender retries network errors, then returns a bounded failure after exhaustion', async () => {
  const { createFeishuSender } = await import('../lib/index.js');
  let attempts = 0;
  const sender = createFeishuSender({
    resolveCredential: async () => 'test-credential',
    clientFactory: () => ({
      im: {
        message: {
          create: async () => {
            attempts += 1;
            const error = new Error('transport details');
            error.code = 'ECONNRESET';
            throw error;
          },
        },
      },
    }),
    timeoutMs: 100,
    maxRetries: 2,
    retryBaseMs: 0,
    sleep: async () => {},
  });

  await assert.rejects(() => sender('chat-1', 'final text'), /FEISHU_SEND_FAILED/);
  assert.equal(attempts, 3);
});

test('sender does not retry a non-retryable Feishu business error', async () => {
  const { createFeishuSender } = await import('../lib/index.js');
  let attempts = 0;
  const sender = createFeishuSender({
    resolveCredential: async () => 'test-credential',
    clientFactory: () => ({
      im: {
        message: {
          create: async () => {
            attempts += 1;
            return { code: 230020, msg: 'permission denied' };
          },
        },
      },
    }),
    timeoutMs: 100,
    maxRetries: 2,
    retryBaseMs: 0,
    sleep: async () => {},
  });

  await assert.rejects(() => sender('chat-1', 'final text'), /FEISHU_SEND_API_FAILED/);
  assert.equal(attempts, 1);
});

test('sender redacts SDK logger input that contains request credentials', async () => {
  const { createSafeSdkLogger } = await import('../lib/index.js');
  const secret = 'placeholder-secret-value';
  const messages = [];
  const logger = createSafeSdkLogger({ warn: (message) => messages.push(message) });

  logger.error(new Error(`request body app_secret=${secret}`));
  logger.error([{ config: { data: JSON.stringify({ app_secret: secret }) }, response: { data: { secret } } }]);

  assert.equal(messages.length, 2);
  assert.ok(messages.every((message) => !message.includes(secret)));
  assert.ok(messages.every((message) => message === 'feishu-channel: Feishu SDK error'));
});

test('credentials: resolves refs by name and reads the returned value', async () => {
  const previousHome = process.env.DSH_HOME;
  const home = await mkdtemp(join(tmpdir(), 'dsh-feishu-channel-'));
  const calls = [];
  const pending = [];
  let cleanup;

  const ctx = {
    credentials: {
      resolve(ref) {
        calls.push(ref);
        return new Promise((resolve) => pending.push(resolve));
      },
    },
    effect(effect) {
      cleanup = effect();
    },
    logger: { warn() {}, info() {} },
  };

  process.env.DSH_HOME = home;
  try {
    apply(ctx, { appIdRef: 'FEISHU_APP_ID', appSecretRef: 'FEISHU_APP_SECRET' });
    assert.deepEqual(calls, ['FEISHU_APP_ID']);

    cleanup();
    pending.shift()({ value: 'app-id' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);

    pending.shift()({ value: 'app-secret' });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('state path: resolves only relative files inside DSH_HOME cache', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-feishu-channel-'));

  try {
    assert.equal(resolveStatePath(home, 'feishu-channel/state.json'), join(await realpath(home), 'cache', 'feishu-channel', 'state.json'));
    assert.throws(() => resolveStatePath(home, '../state.json'), /FEISHU_CONFIG_INVALID/);
    assert.throws(() => resolveStatePath(home, join(home, 'cache', 'state.json')), /FEISHU_CONFIG_INVALID/);
    assert.throws(() => resolveStatePath(home, '/tmp/feishu-channel-state.json'), /FEISHU_CONFIG_INVALID/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('state path: rejects a cache symlink that points outside DSH_HOME', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-feishu-channel-'));
  const outside = await mkdtemp(join(tmpdir(), 'dsh-feishu-channel-outside-'));

  try {
    await symlink(outside, join(home, 'cache'), 'dir');
    assert.throws(() => resolveStatePath(home, 'feishu-channel/state.json'), /FEISHU_CONFIG_INVALID/);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('plugin: rejects an invalid state path before creating state outside cache', async () => {
  const previousHome = process.env.DSH_HOME;
  const home = await mkdtemp(join(tmpdir(), 'dsh-feishu-channel-'));
  const ctx = {
    credentials: { resolve: async () => ({ value: '' }) },
    effect() {
      assert.fail('effect should not run for invalid state path');
    },
    logger: { warn() {}, info() {} },
  };

  process.env.DSH_HOME = home;
  try {
    assert.throws(() => apply(ctx, { stateFile: '../outside.json' }), /FEISHU_CONFIG_INVALID/);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('plugin: registers session event relay during apply assembly', async () => {
  const previousHome = process.env.DSH_HOME;
  const home = await mkdtemp(join(tmpdir(), 'dsh-feishu-channel-'));
  const registrations = [];
  const effects = [];
  const ctx = {
    credentials: {
      resolve(ref) {
        return new Promise(() => {
          registrations.push({ name: 'credential', ref });
        });
      },
    },
    agents: { get: () => undefined },
    agentDefaultModel: {
      currentSelection() {
        return { provider: 'deepseek', model: 'default-model' };
      },
    },
    on(name, listener) {
      registrations.push({ name, listener });
      return () => registrations.push({ name: `${name}:disposed` });
    },
    effect(effect) {
      effects.push(effect());
    },
    logger: { warn() {}, info() {} },
  };

  process.env.DSH_HOME = home;
  try {
    const plugin = apply(ctx, { stateFile: 'feishu-channel/state.json' });

    assert.equal(typeof plugin.handleMessage, 'function');
    assert.equal(registrations.some((entry) => entry.name === 'session/event'), true);
    assert.equal(effects.length, 1);
    effects.at(-1)?.();
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('plugin: registers bridge cleanup when DSH_HOME is unavailable', async () => {
  const previousHome = process.env.DSH_HOME;
  delete process.env.DSH_HOME;
  const effects = [];
  const ctx = {
    credentials: { resolve: async () => ({ value: '' }) },
    effect(effect) {
      effects.push(effect());
    },
    logger: { warn() {}, info() {} },
  };

  try {
    const plugin = apply(ctx);

    assert.equal(typeof plugin.handleMessage, 'function');
    assert.equal(effects.length, 1);
    effects.at(-1)?.();
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
});

test('plugin: closes the Feishu WS client without writing a trace file', async () => {
  const previousHome = process.env.DSH_HOME;
  const home = await mkdtemp(join(tmpdir(), 'dsh-feishu-channel-'));
  const effects = [];
  const originalStart = WSClient.prototype.start;
  const originalClose = WSClient.prototype.close;
  let started = false;
  let closed = false;

  WSClient.prototype.start = async function start() {
    started = true;
  };
  WSClient.prototype.close = function close() {
    closed = true;
  };

  const ctx = {
    credentials: {
      resolve(ref) {
        return Promise.resolve({ value: ref === 'FEISHU_APP_ID' ? 'app-id' : 'app-secret' });
      },
    },
    agents: { get: () => undefined },
    agentDefaultModel: {
      currentSelection() {
        return { provider: 'deepseek', model: 'default-model' };
      },
    },
    on() {
      return () => {};
    },
    effect(effect) {
      effects.push(effect());
    },
    logger: { warn() {}, info() {} },
  };

  process.env.DSH_HOME = home;
  try {
    apply(ctx);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(started, true);
    assert.equal(existsSync(join(home, 'cache', 'feishu-channel', 'trace.log')), false);
    effects.at(-1)?.();
    assert.equal(closed, true);
  } finally {
    WSClient.prototype.start = originalStart;
    WSClient.prototype.close = originalClose;
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('plugin: reports WS readiness only after a successful handshake callback', async () => {
  const previousHome = process.env.DSH_HOME;
  const home = await mkdtemp(join(tmpdir(), 'dsh-feishu-channel-'));
  const effects = [];
  const logs = [];
  const originalStart = WSClient.prototype.start;
  const originalClose = WSClient.prototype.close;
  let startParams;
  let readyCallback;
  let errorCallback;

  WSClient.prototype.start = async function start(params) {
    startParams = params;
    readyCallback = this.onReady;
    errorCallback = this.onError;
    assert.equal(this.logger.level, 1);
  };
  WSClient.prototype.close = function close() {};

  const ctx = {
    credentials: {
      resolve(ref) {
        return Promise.resolve({ value: ref === 'FEISHU_APP_ID' ? 'app-id' : 'app-secret' });
      },
    },
    agents: { get: () => undefined },
    agentDefaultModel: {
      currentSelection() {
        return { provider: 'deepseek', model: 'default-model' };
      },
    },
    on() {
      return () => {};
    },
    effect(effect) {
      effects.push(effect());
    },
    logger: {
      warn(message) { logs.push(`warn:${message}`); },
      info(message) { logs.push(`info:${message}`); },
    },
  };

  process.env.DSH_HOME = home;
  try {
    apply(ctx);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(typeof readyCallback, 'function');
    assert.equal(typeof errorCallback, 'function');
    assert.equal(startParams.eventDispatcher.logger.level, 1);
    assert.equal(logs.some((message) => message.includes('long connection established')), false);

    readyCallback();
    assert.equal(logs.filter((message) => message.includes('long connection established')).length, 1);

    errorCallback(new Error('FEISHU_WS_HANDSHAKE_FAILED: secret transport details'));
    assert.equal(logs.some((message) => message.includes('FEISHU_WS_HANDSHAKE_FAILED')), true);
    assert.equal(logs.some((message) => message.includes('secret transport details')), false);
    effects.at(-1)?.();
  } finally {
    WSClient.prototype.start = originalStart;
    WSClient.prototype.close = originalClose;
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('plugin: restores the session-to-chat index during startup', () => {
  const indexed = createIndexedBindings({
    entries() {
      return [['chat-1', { projectPath: '/work/project', sessionId: 'session-1' }]];
    },
    get() { return undefined; },
    bind() {},
    clearSession() {},
    unbind() {},
    clear() {},
  });

  assert.equal(indexed.chatIdForSession('session-1'), 'chat-1');
});

test('session-to-chat index updates only after the underlying write succeeds', () => {
  const stored = new Map([['chat-1', { projectPath: '/work/project', sessionId: 'session-1' }]]);
  const indexed = createIndexedBindings({
    get(chatId) { return stored.get(chatId); },
    entries() { return [...stored.entries()]; },
    bind(chatId, binding) {
      if (chatId === 'chat-2') throw new Error('disk unavailable');
      stored.set(chatId, binding);
    },
    clearSession() { return false; },
    unbind() { return false; },
    clear() { return 0; },
  });

  assert.throws(
    () => indexed.bind('chat-2', { projectPath: '/work/other', sessionId: 'session-2' }),
    /disk unavailable/,
  );
  assert.equal(indexed.chatIdForSession('session-1'), 'chat-1');
  assert.equal(indexed.chatIdForSession('session-2'), undefined);
});

test('session-to-chat index rejects assigning one session to different chats', () => {
  const stored = new Map([['chat-1', { projectPath: '/work/project', sessionId: 'session-1' }]]);
  const indexed = createIndexedBindings({
    get(chatId) { return stored.get(chatId); },
    entries() { return [...stored.entries()]; },
    bind(chatId, binding) { stored.set(chatId, binding); },
    clearSession() { return false; },
    unbind() { return false; },
    clear() { return 0; },
  });

  assert.throws(
    () => indexed.bind('chat-2', { projectPath: '/work/other', sessionId: 'session-1' }),
    /FEISHU_SESSION_ALREADY_BOUND/,
  );
  assert.equal(indexed.chatIdForSession('session-1'), 'chat-1');
});
