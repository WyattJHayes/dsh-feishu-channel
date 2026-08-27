import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApprovalBridge } from '../lib/approval-bridge.js';

test('approval bridge issues a token and consumes it once in the same chat', async () => {
  const requests = [];
  const bridge = createApprovalBridge({
    timeoutMs: 1000,
    tokenFactory: () => 'ap-fixed',
    sendApproval: async (chatId, message) => requests.push({ chatId, message }),
  });
  const listener = bridge.createListener((sessionId) => sessionId === 'session-1' ? 'chat-1' : undefined);
  const agent = { id: 'session-1', session: { id: 'session-1' } };
  bridge.remember({
    agent,
    toolName: 'bash',
    callId: 'call-1',
  }, {
    toolName: 'bash',
    riskCategory: 'git-publish',
    projectRelativePath: '.',
  });
  const decision = listener({
    agent,
    toolName: 'bash',
    callId: 'call-1',
    reason: '需要确认',
    signal: new AbortController().signal,
  }, async () => 'unavailable');

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].chatId, 'chat-1');
  assert.match(requests[0].message, /工具: bash/);
  assert.match(requests[0].message, /风险: git-publish/);
  assert.match(requests[0].message, /路径: \./);
  assert.match(requests[0].message, /\/approve ap-fixed/);
  assert.match(requests[0].message, /\/deny ap-fixed/);
  assert.equal(requests[0].message.includes('git push'), false);
  assert.equal(requests[0].message.includes('需要确认'), false);
  assert.equal((await bridge.answer('chat-2', 'ap-fixed', 'allowed-once')).ok, false);
  assert.equal((await bridge.answer('chat-1', 'ap-fixed', 'allowed-once')).ok, true);
  assert.equal(await decision, 'allowed-once');
  assert.equal((await bridge.answer('chat-1', 'ap-fixed', 'allowed-once')).ok, false);
  bridge.close();
});

test('approval bridge only accepts the recipient that received the request', async () => {
  const requests = [];
  const first = { receiveId: 'user-a', receiveIdType: 'open_id' };
  const second = { receiveId: 'user-b', receiveIdType: 'open_id' };
  const bridge = createApprovalBridge({
    timeoutMs: 1000,
    tokenFactory: () => 'ap-recipient',
    sendApproval: async (chatId, message, recipient) => requests.push({ chatId, message, recipient }),
  });
  const exec = { agent: { id: 'session-1' }, callId: 'call-1' };
  bridge.remember(exec, { toolName: 'bash', riskCategory: 'git-publish', projectRelativePath: '.' });
  const decision = bridge.createListener(() => 'chat-1', () => first)(exec, async () => 'next');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(requests[0].recipient, first);
  assert.equal((await bridge.answer('chat-1', 'ap-recipient', 'allowed-once', second)).ok, false);
  assert.equal((await bridge.answer('chat-1', 'ap-recipient', 'allowed-once', first)).ok, true);
  assert.equal(await decision, 'allowed-once');
  bridge.close();
});

test('approval bridge binds an approval token to its captured recipient', async () => {
  const requests = [];
  const bridge = createApprovalBridge({
    timeoutMs: 1000,
    tokenFactory: () => 'ap-recipient',
    sendApproval: async (chatId, message, recipient) => requests.push({ chatId, message, recipient }),
  });
  const recipientA = { receiveId: 'user-a', receiveIdType: 'open_id' };
  const recipientB = { receiveId: 'user-b', receiveIdType: 'open_id' };
  const exec = { agent: { id: 'session-1' }, callId: 'call-1' };
  bridge.remember(exec, { toolName: 'bash', riskCategory: 'git-publish', projectRelativePath: '.' });
  const decision = bridge.createListener(
    () => 'chat-1',
    () => recipientA,
  )(exec, async () => 'next');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests[0].recipient, recipientA);
  assert.equal((await bridge.answer('chat-1', 'ap-recipient', 'allowed-once', recipientB)).ok, false);
  assert.equal((await bridge.answer('chat-1', 'ap-recipient', 'allowed-once', recipientA)).ok, true);
  assert.equal(await decision, 'allowed-once');
  bridge.close();
});

test('approval bridge rejects invalid outcomes without consuming the token', async () => {
  const bridge = createApprovalBridge({
    timeoutMs: 1000,
    tokenFactory: () => 'ap-outcome',
    sendApproval: async () => {},
  });
  bridge.remember({ agent: { id: 'session-1' }, callId: 'call-1' }, {
    toolName: 'bash',
    riskCategory: 'git-publish',
    projectRelativePath: '.',
  });
  const decision = bridge.createListener(() => 'chat-1')({
    agent: { id: 'session-1' },
    callId: 'call-1',
  }, async () => 'next');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal((await bridge.answer('chat-1', 'ap-outcome', 'yes')).ok, false);
  assert.equal((await bridge.answer('chat-1', 'ap-outcome', 'rejected')).ok, true);
  assert.equal(await decision, 'rejected');
});

test('approval bridge falls through when a session has no Feishu chat mapping', async () => {
  const bridge = createApprovalBridge({
    timeoutMs: 1000,
    tokenFactory: () => 'ap-fixed',
    sendApproval: async () => assert.fail('sendApproval should not be called'),
  });
  const listener = bridge.createListener(() => undefined);
  const result = await listener({
    agent: { id: 'session-1', session: { id: 'session-1' } },
    callId: 'call-1',
  }, async () => 'desktop-answerer');

  assert.equal(result, 'desktop-answerer');
  bridge.close();
});

test('approval bridge removes remembered summaries when cancelling a session', async () => {
  const requests = [];
  const bridge = createApprovalBridge({
    timeoutMs: 1000,
    tokenFactory: () => 'ap-late',
    sendApproval: async (chatId, message) => requests.push({ chatId, message }),
  });
  bridge.remember({ agent: { id: 'session-1' }, callId: 'call-1' }, {
    toolName: 'bash',
    riskCategory: 'git-publish',
    projectRelativePath: '.',
  });
  bridge.cancelSession('session-1');

  const result = await bridge.createListener(() => 'chat-1')({
    agent: { id: 'session-1' },
    callId: 'call-1',
  }, async () => 'next');

  assert.equal(result, 'unavailable');
  assert.deepEqual(requests, []);
});

test('approval bridge does not send an approval after immediate cancellation', async () => {
  const requests = [];
  const bridge = createApprovalBridge({
    timeoutMs: 1000,
    tokenFactory: () => 'ap-immediate-cancel',
    sendApproval: async (chatId, message) => requests.push({ chatId, message }),
  });
  const exec = { agent: { id: 'session-1' }, callId: 'call-1' };
  bridge.remember(exec, {
    toolName: 'bash',
    riskCategory: 'git-publish',
    projectRelativePath: '.',
  });
  const decision = bridge.createListener(() => 'chat-1')(exec, async () => 'next');
  bridge.cancelSession('session-1');

  assert.equal(await decision, 'cancelled');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests, []);
  bridge.close();
});

test('approval bridge reuses an active record for duplicate approval requests', async () => {
  const requests = [];
  let token = 0;
  const bridge = createApprovalBridge({
    timeoutMs: 1000,
    tokenFactory: () => `ap-duplicate-${++token}`,
    sendApproval: async (chatId, message) => requests.push({ chatId, message }),
  });
  const exec = { agent: { id: 'session-1' }, callId: 'call-1' };
  const listener = bridge.createListener(() => 'chat-1');
  const summary = { toolName: 'bash', riskCategory: 'git-publish', projectRelativePath: '.' };
  bridge.remember(exec, summary);
  const first = listener(exec, async () => 'next');
  bridge.remember(exec, summary);
  const second = listener(exec, async () => 'next');

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.equal((await bridge.answer('chat-1', 'ap-duplicate-1', 'allowed-once')).ok, true);
  assert.equal(await first, 'allowed-once');
  assert.equal(await second, 'allowed-once');
  bridge.close();
});

test('approval bridge expires unmatched summaries', async () => {
  const bridge = createApprovalBridge({
    timeoutMs: 1000,
    summaryTtlMs: 10,
    sendApproval: async () => assert.fail('sendApproval should not be called'),
  });
  const exec = { agent: { id: 'session-1' }, callId: 'call-1' };
  bridge.remember(exec, { toolName: 'bash', riskCategory: 'git-publish', projectRelativePath: '.' });
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(await bridge.createListener(() => 'chat-1')(exec, async () => 'next'), 'unavailable');
  bridge.close();
});

test('approval bridge fails closed when token factory collides', async () => {
  const requests = [];
  const bridge = createApprovalBridge({
    timeoutMs: 1000,
    tokenFactory: () => 'ap-collision',
    sendApproval: async (chatId, message) => requests.push({ chatId, message }),
  });
  bridge.remember({ agent: { id: 'session-1' }, callId: 'call-1' }, {
    toolName: 'bash',
    riskCategory: 'git-publish',
    projectRelativePath: '.',
  });
  bridge.remember({ agent: { id: 'session-1' }, callId: 'call-2' }, {
    toolName: 'bash',
    riskCategory: 'git-publish',
    projectRelativePath: '.',
  });

  const first = bridge.createListener(() => 'chat-1')({
    agent: { id: 'session-1' },
    callId: 'call-1',
  }, async () => 'next');
  await new Promise((resolve) => setImmediate(resolve));
  const second = await bridge.createListener(() => 'chat-1')({
    agent: { id: 'session-1' },
    callId: 'call-2',
  }, async () => 'next');

  assert.equal(second, 'unavailable');
  assert.equal(requests.length, 1);
  assert.equal((await bridge.answer('chat-1', 'ap-collision', 'allowed-once')).ok, true);
  assert.equal(await first, 'allowed-once');
});

test('approval bridge removes abort listeners after approval resolves', async () => {
  let added = 0;
  let removed = 0;
  const signal = {
    aborted: false,
    addEventListener: () => {
      added += 1;
    },
    removeEventListener: () => {
      removed += 1;
    },
  };
  const bridge = createApprovalBridge({
    timeoutMs: 1000,
    tokenFactory: () => 'ap-abort-cleanup',
    sendApproval: async () => {},
  });
  bridge.remember({ agent: { id: 'session-1' }, callId: 'call-1' }, {
    toolName: 'bash',
    riskCategory: 'git-publish',
    projectRelativePath: '.',
  });
  const decision = bridge.createListener(() => 'chat-1')({
    agent: { id: 'session-1' },
    callId: 'call-1',
    signal,
  }, async () => 'next');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await bridge.answer('chat-1', 'ap-abort-cleanup', 'allowed-once')).ok, true);
  assert.equal(await decision, 'allowed-once');
  assert.equal(added, 1);
  assert.equal(removed, 1);
});

test('approval bridge sanitizes summary fields before sending', async () => {
  const requests = [];
  const bridge = createApprovalBridge({
    timeoutMs: 1000,
    tokenFactory: () => 'ap-summary',
    sendApproval: async (chatId, message) => requests.push({ chatId, message }),
  });
  bridge.remember({ agent: { id: 'session-1' }, callId: 'call-1' }, {
    toolName: 'bash\n/approve injected',
    riskCategory: 'git-publish\u0000secret',
    projectRelativePath: '../x; rm -rf',
  });
  const decision = bridge.createListener(() => 'chat-1')({
    agent: { id: 'session-1' },
    callId: 'call-1',
  }, async () => 'next');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests.length, 1);
  assert.equal(requests[0].message.includes('injected'), false);
  assert.equal(requests[0].message.includes('secret'), false);
  assert.equal(requests[0].message.includes('rm -rf'), false);
  assert.equal((await bridge.answer('chat-1', 'ap-summary', 'unavailable')).ok, true);
  assert.equal(await decision, 'unavailable');
});

test('approval bridge fails closed on send failure, timeout, cancellation, and close', async () => {
  const failedBridge = createApprovalBridge({
    timeoutMs: 1000,
    tokenFactory: () => 'ap-send-fails',
    sendApproval: async () => {
      throw new Error('network failed');
    },
  });
  failedBridge.remember({ agent: { id: 's1' }, callId: 'c1' }, {
    toolName: 'bash',
    riskCategory: 'destructive-command',
    projectRelativePath: 'build',
  });
  assert.equal(await failedBridge.createListener(() => 'chat-1')({
    agent: { id: 's1' },
    callId: 'c1',
  }, async () => 'next'), 'unavailable');

  let currentTime = 0;
  const timeoutRequests = [];
  const timeoutBridge = createApprovalBridge({
    timeoutMs: 5,
    now: () => currentTime,
    tokenFactory: () => 'ap-timeout',
    sendApproval: async (chatId, message) => timeoutRequests.push({ chatId, message }),
  });
  timeoutBridge.remember({ agent: { id: 's2' }, callId: 'c2' }, {
    toolName: 'bash',
    riskCategory: 'destructive-command',
    projectRelativePath: 'build',
  });
  const timeoutDecision = timeoutBridge.createListener(() => 'chat-2')({
    agent: { id: 's2' },
    callId: 'c2',
  }, async () => 'next');
  await new Promise((resolve) => setImmediate(resolve));
  currentTime = 10;
  assert.equal((await timeoutBridge.answer('chat-2', 'ap-timeout', 'allowed')).ok, false);
  assert.equal(await timeoutDecision, 'unavailable');

  const cancelBridge = createApprovalBridge({
    timeoutMs: 1000,
    tokenFactory: () => 'ap-cancel',
    sendApproval: async () => {},
  });
  cancelBridge.remember({ agent: { id: 's3' }, callId: 'c3' }, {
    toolName: 'bash',
    riskCategory: 'destructive-command',
    projectRelativePath: 'build',
  });
  const cancelDecision = cancelBridge.createListener(() => 'chat-3')({
    agent: { id: 's3' },
    callId: 'c3',
  }, async () => 'next');
  await new Promise((resolve) => setImmediate(resolve));
  cancelBridge.cancelSession('s3');
  assert.equal(await cancelDecision, 'cancelled');

  const closeBridge = createApprovalBridge({
    timeoutMs: 1000,
    tokenFactory: () => 'ap-close',
    sendApproval: async () => {},
  });
  closeBridge.remember({ agent: { id: 's4' }, callId: 'c4' }, {
    toolName: 'bash',
    riskCategory: 'destructive-command',
    projectRelativePath: 'build',
  });
  const closeDecision = closeBridge.createListener(() => 'chat-4')({
    agent: { id: 's4' },
    callId: 'c4',
  }, async () => 'next');
  await new Promise((resolve) => setImmediate(resolve));
  closeBridge.close();
  assert.equal(await closeDecision, 'unavailable');
});
