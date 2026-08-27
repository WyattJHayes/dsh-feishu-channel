import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDedupe } from '../lib/dedupe.js';
import { isAllowed, normalizeList } from '../lib/access.js';
import { parseCommand, chunkText } from '../lib/commands.js';

test('dedupe: first delivery passes, redelivery blocked, capacity evicts oldest', () => {
  const d = createDedupe(3);
  assert.equal(d.first('a'), true);
  assert.equal(d.first('a'), false);
  assert.equal(d.first('b'), true);
  assert.equal(d.first('c'), true);
  assert.equal(d.first('d'), true); // evicts 'a'
  assert.equal(d.first('a'), true);
  assert.equal(d.size, 3);
});

test('dedupe: missing or invalid event ids are rejected', () => {
  const d = createDedupe();

  assert.equal(d.first(undefined), false);
  assert.equal(d.first(''), false);
  assert.equal(d.first(123), false);
});

test('access: deny by default; group requires both chat and sender allowed', () => {
  const acl = { openIds: ['ou_1'], chatIds: ['oc_g1'] };
  assert.equal(isAllowed(acl, { openId: 'ou_1', isGroup: false }), true);
  assert.equal(isAllowed(acl, { openId: 'ou_x', isGroup: false }), false);
  assert.equal(isAllowed({ openIds: ['ou_1'] }, { openId: 'ou_1', chatId: 'oc_g9', isGroup: true }), false);
  assert.equal(isAllowed(acl, { openId: 'ou_1', chatId: 'oc_g1', isGroup: true }), true);
  assert.equal(isAllowed({}, { openId: 'ou_1', isGroup: false }), false);
});

test('access: uses the plugin config allowlist field names', () => {
  const config = { allowedOpenIds: ['ou_1'], allowedChatIds: ['oc_g1'] };

  assert.equal(isAllowed(config, { openId: 'ou_1', isGroup: false }), true);
  assert.equal(isAllowed(config, { openId: 'ou_1', chatId: 'oc_g1', isGroup: true }), true);
});

test('access: unknown chat types are denied by default', () => {
  assert.equal(isAllowed({ allowedOpenIds: ['ou_1'] }, {
    openId: 'ou_1',
    chatId: 'oc_unknown',
    chatType: 'unknown',
  }), false);
});

test('access: normalizeList trims and splits', () => {
  assert.deepEqual(normalizeList('ou_1, ou_2\nou_3'), ['ou_1', 'ou_2', 'ou_3']);
  assert.deepEqual(normalizeList([' ou_a ', '', 'ou_b']), ['ou_a', 'ou_b']);
  assert.deepEqual(normalizeList(undefined), []);
});

test('commands: slash routing and unknown-slash fallback to prompt', () => {
  assert.deepEqual(parseCommand('/new'), { type: 'new' });
  assert.deepEqual(parseCommand('/USE 2'), { type: 'prompt', text: '/USE 2' });
  assert.deepEqual(parseCommand('/sessions'), { type: 'prompt', text: '/sessions' });
  assert.deepEqual(parseCommand('/revoke token-1'), { type: 'prompt', text: '/revoke token-1' });
  assert.deepEqual(parseCommand('/help'), { type: 'help' });
  assert.deepEqual(parseCommand('/nope keep going'), { type: 'prompt', text: '/nope keep going' });
  assert.deepEqual(parseCommand('帮我列出目录'), { type: 'prompt', text: '帮我列出目录' });
  assert.equal(parseCommand('   '), null);
});

test('commands: project and approval tokens preserve their argument', () => {
  assert.deepEqual(parseCommand('/project /Users/me/My Project'), {
    type: 'project',
    path: '/Users/me/My Project',
  });
  assert.deepEqual(parseCommand('/approve ap-123'), { type: 'approve', token: 'ap-123' });
  assert.deepEqual(parseCommand('/deny ap-123'), { type: 'deny', token: 'ap-123' });
  assert.deepEqual(parseCommand('/project'), {
    type: 'usage',
    command: 'project',
    hint: '/project <绝对路径>',
  });
});

test('chunking: short text untouched; long text splits at newlines when possible', () => {
  assert.deepEqual(chunkText('hello'), ['hello']);
  const long = `${'x'.repeat(3000)}\n${'y'.repeat(3000)}`;
  const chunks = chunkText(long, 3800);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, 3001);
  assert.equal(chunks.join(''), long);
  assert.ok(chunks.every((c) => c.length <= 3800));
});

test('chunking: preserves newlines and never splits a Unicode code point', () => {
  const newlineText = 'xxx\nyyy';
  const newlineChunks = chunkText(newlineText, 5);
  const emojiChunks = chunkText('😀😀😀', 2);

  assert.deepEqual(newlineChunks, ['xxx\n', 'yyy']);
  assert.equal(newlineChunks.join(''), newlineText);
  assert.deepEqual(emojiChunks, ['😀😀', '😀']);
  assert.ok(emojiChunks.every((chunk) => Array.from(chunk).length <= 2));
});
