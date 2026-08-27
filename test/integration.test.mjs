import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAgentDriver } from '../lib/agent-driver.js';
import { createApprovalBridge } from '../lib/approval-bridge.js';
import { createMessageRouter } from '../lib/message-router.js';
import { createProgressRelay } from '../lib/progress-relay.js';
import { createProjectPolicy } from '../lib/project-policy.js';
import { createSessionMap } from '../lib/session-map.js';

function createAgentContext(agent) {
  const createCalls = [];
  const liveAgents = new Map();
  return {
    createCalls,
    agents: {
      get(sessionId) {
        return liveAgents.get(sessionId);
      },
      async create(options) {
        createCalls.push(options);
        agent.id = options.sessionId;
        agent.session.id = options.sessionId;
        agent.session.events.push({ type: 'approval/policy', data: { policy: 'ask' } });
        liveAgents.set(options.sessionId, agent);
        return { agent };
      },
    },
    agentDefaultModel: {
      currentSelection() {
        return { provider: 'deepseek', model: 'default-model' };
      },
    },
    permissionPresets: {
      apply() {},
      current() {
        return 'workspace-write';
      },
    },
  };
}

function createAgent() {
  let releaseFirst;
  let seq = 0;
  const followups = [];
  const listeners = new Map();
  const eventContext = {
    on(name, listener) {
      const handlers = listeners.get(name) ?? new Set();
      handlers.add(listener);
      listeners.set(name, handlers);
      return () => handlers.delete(listener);
    },
    emit(name, payload) {
      for (const listener of listeners.get(name) ?? []) listener(payload);
    },
  };
  const agent = {
    id: 'uncreated',
    session: { id: 'uncreated', events: [] },
    ctx: eventContext,
    cancel() {},
    async whenIdle() {},
    async followup(message) {
      const text = message.content[0].text;
      followups.push(text);
      if (text === 'first') {
        await new Promise((resolve) => {
          releaseFirst = resolve;
        });
      }
      const turn = followups.length;
      this.session.events.push(
        { seq: seq++, type: 'turn/start', data: { turn } },
        {
          seq: seq++,
          type: 'assistant/message',
          data: { turn, message: { content: [{ type: 'text', text: `done:${text}` }] } },
        },
        { seq: seq++, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
      );
      this.ctx.emit('agent/inbox/claimed', { message, turn });
    },
  };
  return {
    agent,
    followups,
    releaseFirst() {
      releaseFirst();
    },
  };
}

test('integration routes project-bound prompts through the Agent driver FIFO and safe relays', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-feishu-integration-'));
  const project = join(tempRoot, 'project');
  await mkdir(project);
  const resolvedProject = await realpath(project);
  const stateFile = join(tempRoot, 'state.json');
  const bindings = createSessionMap(stateFile);
  const sent = [];
  const agentFixture = createAgent();
  const ctx = createAgentContext(agentFixture.agent);
  const approvalBridge = createApprovalBridge({
    timeoutMs: 1000,
    tokenFactory: () => 'ap-fixed',
    sendApproval: async (chatId, message) => sent.push({ chatId, text: message }),
  });
  const progressRelay = createProgressRelay({
    getChatId(sessionId) {
      return bindings.get('chat-1')?.sessionId === sessionId ? 'chat-1' : undefined;
    },
    sendText: async (chatId, text) => sent.push({ chatId, text }),
    minIntervalMs: 0,
    maxMessages: 5,
  });
  const driver = createAgentDriver(ctx, {
    bindings,
    config: {},
    approvalBridge,
    progressRelay,
  });
  const router = createMessageRouter({
    config: {
      allowedOpenIds: ['user-1'],
      allowedChatIds: [],
      maxPromptLength: 1000,
      dshHomeAvailable: true,
    },
    bindings,
    projectPolicy: createProjectPolicy([tempRoot]),
    driver,
    approvalBridge,
    progressRelay,
    sendText: async (chatId, text) => sent.push({ chatId, text }),
    logger: { warn() {}, info() {} },
  });

  try {
    await router.handleMessage({ eventId: 'e-project', chatId: 'chat-1', openId: 'user-1', chatType: 'p2p', text: `/project ${project}` });
    await router.handleMessage({ eventId: 'e-first', chatId: 'chat-1', openId: 'user-1', chatType: 'p2p', text: 'first' });
    await new Promise((resolve) => setImmediate(resolve));
    await router.handleMessage({ eventId: 'e-status', chatId: 'chat-1', openId: 'user-1', chatType: 'p2p', text: '/status' });
    await router.handleMessage({ eventId: 'e-second', chatId: 'chat-1', openId: 'user-1', chatType: 'p2p', text: 'second' });

    assert.deepEqual(agentFixture.followups, ['first']);
    assert.match(sent.at(-2).text, /状态：running/);
    agentFixture.releaseFirst();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(ctx.createCalls[0].meta.cwd, resolvedProject);
    assert.deepEqual(agentFixture.followups, ['first', 'second']);
    assert.ok(sent.some((entry) => entry.text === 'done:first'));
    assert.ok(sent.some((entry) => entry.text === 'done:second'));

    progressRelay.onSessionEvent({ id: bindings.get('chat-1').sessionId }, {
      type: 'tool/call',
      data: { name: 'bash', arguments: { command: 'cat SECRET_VALUE' } },
    });
    progressRelay.onSessionEvent({ id: 'desktop-session' }, {
      type: 'tool/call',
      data: { name: 'bash', arguments: { command: 'cat SECRET_VALUE' } },
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(sent.filter((entry) => entry.text === 'Calling tool: bash.').length, 1);
    assert.ok(sent.every((entry) => !entry.text.includes('SECRET_VALUE')));
  } finally {
    approvalBridge.close();
    progressRelay.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
