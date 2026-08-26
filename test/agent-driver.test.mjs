import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAgentDriver, createAgentSetup } from '../lib/agent-driver.js';

function createMemoryBindings(initial = {}) {
  const map = new Map();
  if (Object.keys(initial).length > 0) {
    map.set('chat-1', { ...initial, model: initial.model ? { ...initial.model } : undefined });
  }

  return {
    get(chatId) {
      const binding = map.get(chatId);
      return binding ? { ...binding, model: binding.model ? { ...binding.model } : undefined } : undefined;
    },
    bind(chatId, binding) {
      map.set(chatId, { ...binding, model: binding.model ? { ...binding.model } : undefined });
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

function fakeAgent(id, overrides = {}) {
  return {
    id,
    session: { id, events: [] },
    followup: async () => {},
    whenIdle: async () => {},
    cancel: () => {},
    ...overrides,
  };
}

function fakeAgentContext(overrides = {}) {
  const liveAgents = new Map();
  return {
    agents: {
      get(id) {
        return liveAgents.get(id);
      },
      async create(options) {
        const handle = await overrides.create?.(options);
        if (handle?.agent?.id) liveAgents.set(handle.agent.id, handle.agent);
        return handle;
      },
      async resume(options) {
        const handle = await overrides.resume?.(options);
        if (handle?.agent?.id) liveAgents.set(handle.agent.id, handle.agent);
        return handle;
      },
      ...overrides,
    },
    agentDefaultModel: {
      currentSelection() {
        return { provider: 'deepseek', model: 'default-model' };
      },
    },
  };
}

test('driver creates an Agent with the bound project cwd and persists the session', async () => {
  const calls = [];
  const bindings = createMemoryBindings({ projectPath: '/work/project' });
  const agent = fakeAgent('session-1');
  const ctx = fakeAgentContext({
    create: async (options) => {
      calls.push(options);
      return { agent };
    },
  });
  const driver = createAgentDriver(ctx, { bindings, config: { agentPreset: 'restricted' } });

  assert.equal(await driver.ensureSession('chat-1'), 'session-1');
  assert.equal(calls[0].meta.cwd, '/work/project');
  assert.equal(calls[0].meta.agentPreset, 'restricted');
  assert.equal(calls[0].sessionId.startsWith('feishu-session-'), true);
  assert.deepEqual(bindings.get('chat-1'), {
    projectPath: '/work/project',
    sessionId: 'session-1',
    model: { provider: 'deepseek', model: 'default-model' },
  });
});

test('driver refuses to create an Agent when the chat has no project binding', async () => {
  let createCalled = false;
  const driver = createAgentDriver(fakeAgentContext({
    create: async () => {
      createCalled = true;
      return { agent: fakeAgent('session-1') };
    },
  }), {
    bindings: createMemoryBindings(),
    config: {},
  });

  await assert.rejects(() => driver.ensureSession('chat-1'), /FEISHU_PROJECT_UNCONFIGURED/);
  assert.equal(createCalled, false);
});

test('driver reports an unconfigured project before reading ctx.agents', async () => {
  const driver = createAgentDriver({
    agentDefaultModel: {
      currentSelection() {
        return { provider: 'deepseek', model: 'default-model' };
      },
    },
  }, {
    bindings: createMemoryBindings(),
    config: {},
  });

  await assert.rejects(() => driver.ensureSession('chat-1'), /FEISHU_PROJECT_UNCONFIGURED/);
});

test('driver resumes persisted session and does not silently create a replacement', async () => {
  const calls = [];
  const bindings = createMemoryBindings({
    projectPath: '/work/project',
    sessionId: 'session-1',
    model: { provider: 'deepseek', model: 'model-1' },
  });
  const agent = fakeAgent('session-1');
  const ctx = fakeAgentContext({
    get: () => undefined,
    resume: async (options) => {
      calls.push(options);
      return { agent };
    },
    create: async () => assert.fail('create must not replace a failed resume path'),
  });
  const driver = createAgentDriver(ctx, { bindings, config: {} });

  assert.equal(await driver.ensureSession('chat-1'), 'session-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].resumeSessionId, 'session-1');
  assert.deepEqual(calls[0].agentOptions, { provider: 'deepseek', model: 'model-1' });
  assert.equal(bindings.get('chat-1').sessionId, 'session-1');
});

test('driver preserves the binding when resume fails', async () => {
  const bindings = createMemoryBindings({
    projectPath: '/work/project',
    sessionId: 'session-1',
    model: { provider: 'deepseek', model: 'model-1' },
  });
  const driver = createAgentDriver(fakeAgentContext({
    get: () => undefined,
    resume: async () => {
      throw new Error('resume exploded');
    },
    create: async () => assert.fail('create must not be used as a resume fallback'),
  }), {
    bindings,
    config: {},
  });

  await assert.rejects(() => driver.ensureSession('chat-1'), /FEISHU_SESSION_RESUME_FAILED/);
  assert.equal(bindings.get('chat-1').sessionId, 'session-1');
});

test('driver revalidates a persisted project binding before resuming or creating', async () => {
  let createCalled = false;
  let resumeCalled = false;
  const driver = createAgentDriver(fakeAgentContext({
    create: async () => {
      createCalled = true;
      return { agent: fakeAgent('session-1') };
    },
    resume: async () => {
      resumeCalled = true;
      return { agent: fakeAgent('session-1') };
    },
  }), {
    bindings: createMemoryBindings({ projectPath: '/work/project', sessionId: 'session-1' }),
    projectPolicy: {
      resolve: () => ({ ok: false, code: 'PROJECT_PATH_OUTSIDE_ROOT', message: 'outside' }),
    },
  });

  await assert.rejects(() => driver.ensureSession('chat-1'), /FEISHU_PROJECT_BINDING_INVALID/);
  assert.equal(createCalled, false);
  assert.equal(resumeCalled, false);
});

test('driver setup mounts the Agent preset before registering scoped listeners', async () => {
  const registrations = [];
  const setupCalls = [];
  const agentCtx = {
    on(name, listener) {
      setupCalls.push(`on:${name}`);
      registrations.push({ name, listener });
      return () => {};
    },
  };
  const agentPresets = {
    async mount(context, preset) {
      assert.equal(context, agentCtx);
      assert.equal(preset, undefined);
      setupCalls.push('mount');
    },
  };
  const approvalBridge = {
    remember() {},
    createListener() {
      return async () => 'allowed-once';
    },
  };

  assert.equal(await createAgentSetup(agentCtx, {
    chatId: 'chat-1',
    projectPath: '/work/project',
    selection: { current: { provider: 'deepseek', model: 'model-1' } },
    approvalBridge,
    agentPresets,
  }), undefined);
  assert.equal(setupCalls[0], 'mount');
  assert.deepEqual(registrations.map((entry) => entry.name), [
    'system-prompt/assemble',
    'agent/request',
    'tools/pre-execute',
    'approval/request',
  ]);
});

test('driver runs prompts FIFO and returns the result for each turn', async () => {
  const order = [];
  let releaseFirst;
  let nextSeq = 0;
  const agent = fakeAgent('session-1', {
    async followup(message) {
      const text = message.content[0].text;
      order.push(`start:${text}`);
      if (text === 'first') {
        await new Promise((resolve) => {
          releaseFirst = resolve;
        });
      }
      const turn = text === 'first' ? 1 : 2;
      this.session.events.push(
        { seq: nextSeq++, type: 'turn/start', data: { turn } },
        {
          seq: nextSeq++,
          type: 'assistant/message',
          data: { turn, message: { content: [{ type: 'text', text: `done:${text}` }] } },
        },
        { seq: nextSeq++, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
      );
      order.push(`end:${text}`);
    },
  });
  const ctx = fakeAgentContext({ get: () => agent });
  const driver = createAgentDriver(ctx, {
    bindings: createMemoryBindings({ projectPath: '/work/project', sessionId: 'session-1' }),
    config: {},
  });

  const first = driver.enqueuePrompt('chat-1', 'first');
  const second = driver.enqueuePrompt('chat-1', 'second');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['start:first']);
  releaseFirst();

  assert.deepEqual(await first, { kind: 'text', text: 'done:first' });
  assert.deepEqual(await second, { kind: 'text', text: 'done:second' });
  assert.deepEqual(order, ['start:first', 'end:first', 'start:second', 'end:second']);
});

test('driver cancel aborts active Agent and clears pending approvals', async () => {
  const calls = [];
  let releaseFollowup;
  const agent = fakeAgent('session-1', {
    cancel: (...args) => calls.push(args),
    followup: async () => new Promise((resolve) => {
      releaseFollowup = resolve;
    }),
  });
  const driver = createAgentDriver(fakeAgentContext({ get: () => agent }), {
    bindings: createMemoryBindings({ projectPath: '/work/project', sessionId: 'session-1' }),
    approvalBridge: { cancelSession: (id) => calls.push(id) },
  });

  const prompt = driver.enqueuePrompt('chat-1', 'run');
  await new Promise((resolve) => setImmediate(resolve));
  const cancel = driver.cancel('chat-1');
  releaseFollowup();
  assert.deepEqual(await cancel, { cancelled: true });
  assert.deepEqual(await prompt, { kind: 'cancelled' });

  assert.deepEqual(calls.find((call) => Array.isArray(call)), [{ kind: 'user' }, { keepInbox: true }]);
  assert.equal(calls.filter((call) => call === 'session-1').length, 2);
});

test('driver cancel skips queued prompts without invoking the Agent', async () => {
  const followups = [];
  let releaseFirst;
  const agent = fakeAgent('session-1', {
    followup: async (message) => {
      followups.push(message.content[0].text);
      if (message.content[0].text === 'first') {
        await new Promise((resolve) => {
          releaseFirst = resolve;
        });
      }
    },
  });
  const driver = createAgentDriver(fakeAgentContext({ get: () => agent }), {
    bindings: createMemoryBindings({ projectPath: '/work/project', sessionId: 'session-1' }),
    approvalBridge: { cancelSession() {} },
  });

  const first = driver.enqueuePrompt('chat-1', 'first');
  const second = driver.enqueuePrompt('chat-1', 'second');
  await new Promise((resolve) => setImmediate(resolve));
  const cancel = driver.cancel('chat-1');
  releaseFirst();
  assert.deepEqual(await cancel, { cancelled: true });

  assert.deepEqual(await second, { kind: 'cancelled' });
  assert.deepEqual(await first, { kind: 'cancelled' });
  assert.deepEqual(followups, ['first']);
});

test('driver cancel during create cancels the new Agent before followup', async () => {
  const calls = [];
  let releaseCreate;
  const agent = fakeAgent('session-1', {
    followup: async () => calls.push('followup'),
    cancel: (...args) => calls.push(args),
  });
  let liveAgent;
  const driver = createAgentDriver({
    agents: {
      get: () => liveAgent,
      create: async () => {
        await new Promise((resolve) => {
          releaseCreate = resolve;
        });
        liveAgent = agent;
        return { agent };
      },
    },
    agentDefaultModel: {
      currentSelection() {
        return { provider: 'deepseek', model: 'default-model' };
      },
    },
  }, {
    bindings: createMemoryBindings({ projectPath: '/work/project' }),
    approvalBridge: { cancelSession: (id) => calls.push(`approval:${id}`) },
  });

  const prompt = driver.enqueuePrompt('chat-1', 'run');
  await new Promise((resolve) => setImmediate(resolve));
  const cancel = driver.cancel('chat-1');
  await new Promise((resolve) => setImmediate(resolve));
  releaseCreate();

  assert.deepEqual(await cancel, { cancelled: true });
  assert.deepEqual(await prompt, { kind: 'cancelled' });
  assert.deepEqual(calls, [
    'approval:session-1',
    [{ kind: 'user' }, { keepInbox: true }],
    'approval:session-1',
  ]);
});

test('driver cancel during resume cancels the resumed Agent before followup', async () => {
  const calls = [];
  let releaseResume;
  const agent = fakeAgent('session-1', {
    followup: async () => calls.push('followup'),
    cancel: (...args) => calls.push(args),
  });
  let liveAgent;
  const driver = createAgentDriver({
    agents: {
      get: () => liveAgent,
      resume: async () => {
        await new Promise((resolve) => {
          releaseResume = resolve;
        });
        liveAgent = agent;
        return { agent };
      },
    },
    agentDefaultModel: {
      currentSelection() {
        return { provider: 'deepseek', model: 'default-model' };
      },
    },
  }, {
    bindings: createMemoryBindings({
      projectPath: '/work/project',
      sessionId: 'session-1',
      model: { provider: 'deepseek', model: 'model-1' },
    }),
    approvalBridge: { cancelSession: (id) => calls.push(`approval:${id}`) },
  });

  const prompt = driver.enqueuePrompt('chat-1', 'run');
  await new Promise((resolve) => setImmediate(resolve));
  const cancel = driver.cancel('chat-1');
  await new Promise((resolve) => setImmediate(resolve));
  releaseResume();

  assert.deepEqual(await cancel, { cancelled: true });
  assert.deepEqual(await prompt, { kind: 'cancelled' });
  assert.deepEqual(calls, [
    'approval:session-1',
    [{ kind: 'user' }, { keepInbox: true }],
    'approval:session-1',
  ]);
});

test('driver reset cancels the current Agent and preserves project binding', async () => {
  const bindings = createMemoryBindings({
    projectPath: '/work/project',
    sessionId: 'session-1',
    model: { provider: 'deepseek', model: 'model-1' },
  });
  const driver = createAgentDriver(fakeAgentContext({ get: () => fakeAgent('session-1') }), {
    bindings,
    config: {},
  });

  assert.deepEqual(await driver.reset('chat-1'), { cancelled: false });
  assert.deepEqual(bindings.get('chat-1'), {
    projectPath: '/work/project',
    model: { provider: 'deepseek', model: 'model-1' },
  });
});
