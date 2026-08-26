import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WSClient } from '@larksuiteoapi/node-sdk';
import { normalizeConfig } from '../lib/config.js';
import { apply, resolveStatePath } from '../lib/index.js';

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
});

test('plugin: declares the services used by apply', async () => {
  const { inject } = await import('../lib/index.js');

  assert.deepEqual(inject, ['credentials', 'agents', 'agentDefaultModel', 'agentPresets']);
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
  const agentCtx = { on: () => () => {} };
  const agentPresets = { mount: async () => {} };

  assert.equal(await createAgentSetup(agentCtx, {
    current: { provider: 'wechat', model: 'Deepseek-v4-flash' },
    agentPresets,
  }), undefined);
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
  );

  assert.deepEqual(result, { kind: 'text', text: '运行完成' });
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
