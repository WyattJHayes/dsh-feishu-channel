import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { createSessionMap } from '../lib/session-map.js';

test('session map writes versioned bindings and reloads them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-state-'));
  const file = join(dir, 'state.json');
  const first = createSessionMap(file, { now: () => '2026-08-26T00:00:00.000Z' });
  first.bind('oc_1', {
    projectPath: '/tmp/project',
    sessionId: 'feishu-session-1',
    model: { provider: 'deepseek', model: 'model-1' },
  });

  assert.deepEqual(createSessionMap(file).get('oc_1'), {
    projectPath: '/tmp/project',
    sessionId: 'feishu-session-1',
    model: { provider: 'deepseek', model: 'model-1' },
    updatedAt: '2026-08-26T00:00:00.000Z',
  });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 1);
  await rm(dir, { recursive: true, force: true });
});

test('session map clears only the agent session and preserves project binding', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-state-'));
  const file = join(dir, 'state.json');
  const state = createSessionMap(file);
  state.bind('oc_1', { projectPath: '/tmp/project', sessionId: 'session-1' });

  state.clearSession('oc_1');

  assert.equal(state.get('oc_1').projectPath, '/tmp/project');
  assert.equal('sessionId' in state.get('oc_1'), false);
  await rm(dir, { recursive: true, force: true });
});

test('session map leaves a corrupt primary file untouched and writes recovery state beside it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-state-'));
  const file = join(dir, 'state.json');
  writeFileSync(file, '{broken', 'utf8');
  const state = createSessionMap(file);

  state.bind('oc_1', { projectPath: '/tmp/project' });

  assert.equal(readFileSync(file, 'utf8'), '{broken');
  assert.equal(state.recoveredPath, file + '.recovered');
  assert.equal(JSON.parse(readFileSync(file + '.recovered', 'utf8')).version, 1);
  await rm(dir, { recursive: true, force: true });
});

test('session map reads a valid recovered file when the primary file is corrupt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-state-'));
  const file = join(dir, 'state.json');
  writeFileSync(file, '{broken', 'utf8');
  writeFileSync(
    file + '.recovered',
    JSON.stringify({
      version: 1,
      bindings: {
        oc_1: {
          projectPath: '/tmp/project',
          sessionId: 'session-1',
          updatedAt: '2026-08-26T00:00:00.000Z',
        },
      },
    }),
    'utf8',
  );

  const state = createSessionMap(file);

  assert.deepEqual(state.get('oc_1'), {
    projectPath: '/tmp/project',
    sessionId: 'session-1',
    updatedAt: '2026-08-26T00:00:00.000Z',
  });
  assert.equal(state.recoveredPath, file + '.recovered');
  await rm(dir, { recursive: true, force: true });
});

test('session map migrates legacy session-only bindings without inventing project paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-state-'));
  const file = join(dir, 'state.json');
  writeFileSync(file, JSON.stringify({ oc_1: { sessionId: 'session-1', boundAt: 'legacy' } }), 'utf8');

  const state = createSessionMap(file);

  assert.deepEqual(state.get('oc_1'), { sessionId: 'session-1' });
  await rm(dir, { recursive: true, force: true });
});

test('session map preserves a legacy session-only binding through a later save and reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-state-'));
  const file = join(dir, 'state.json');
  writeFileSync(
    file,
    JSON.stringify({
      oc_1: {
        sessionId: 'legacy-session-1',
        boundAt: 'legacy',
        message: 'full text',
        toolArgs: { token: 'test-only' },
        env: { TEST_SECRET: 'test-only' },
        model: { provider: 'deepseek', model: 'model-1', apiKey: 'test-only' },
      },
    }),
    'utf8',
  );

  const state = createSessionMap(file, { now: () => '2026-08-26T00:00:00.000Z' });
  state.bind('oc_2', { projectPath: '/tmp/project' });

  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    version: 1,
    bindings: {
      oc_1: { sessionId: 'legacy-session-1' },
      oc_2: { projectPath: '/tmp/project', updatedAt: '2026-08-26T00:00:00.000Z' },
    },
  });
  assert.deepEqual(createSessionMap(file).get('oc_1'), { sessionId: 'legacy-session-1' });
  await rm(dir, { recursive: true, force: true });
});

test('session map rejects empty chat ids and non-absolute project paths on writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-state-'));
  const file = join(dir, 'state.json');
  const state = createSessionMap(file);

  assert.throws(() => state.bind('', { projectPath: '/tmp/project' }), /SESSION_MAP_INVALID_CHAT_ID/);
  assert.throws(() => state.bind('oc_1', { projectPath: 'relative/project' }), /SESSION_MAP_INVALID_PROJECT_PATH/);
  assert.throws(() => state.clearSession(''), /SESSION_MAP_INVALID_CHAT_ID/);
  assert.throws(() => state.unbind(''), /SESSION_MAP_INVALID_CHAT_ID/);
  await rm(dir, { recursive: true, force: true });
});

test('session map unbinds one chat and clear removes every binding from disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-state-'));
  const file = join(dir, 'state.json');
  const state = createSessionMap(file);
  state.bind('oc_1', { projectPath: '/tmp/project-1', sessionId: 'session-1' });
  state.bind('oc_2', { projectPath: '/tmp/project-2', sessionId: 'session-2' });

  assert.equal(state.unbind('oc_1'), true);
  assert.equal(state.unbind('oc_missing'), false);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).bindings.oc_1, undefined);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).bindings.oc_2.sessionId, 'session-2');
  assert.equal(state.clear(), 1);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 1, bindings: {} });
  await rm(dir, { recursive: true, force: true });
});

test('session map persists only safe binding fields', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-state-'));
  const file = join(dir, 'state.json');
  const state = createSessionMap(file, { now: () => '2026-08-26T00:00:00.000Z' });

  state.bind('oc_1', {
    projectPath: '/tmp/project',
    sessionId: 'session-1',
    model: { provider: 'deepseek', model: 'model-1', reasoningEffort: 'high', apiKey: 'secret' },
    message: 'full text',
    toolArgs: { token: 'secret' },
    env: { FEISHU_APP_SECRET: 'secret' },
  });

  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).bindings.oc_1, {
    projectPath: '/tmp/project',
    sessionId: 'session-1',
    model: { provider: 'deepseek', model: 'model-1', reasoningEffort: 'high' },
    updatedAt: '2026-08-26T00:00:00.000Z',
  });
  await rm(dir, { recursive: true, force: true });
});

test('session map get result cannot mutate stored bindings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-state-'));
  const file = join(dir, 'state.json');
  const state = createSessionMap(file, { now: () => '2026-08-26T00:00:00.000Z' });
  state.bind('oc_1', {
    projectPath: '/tmp/project',
    sessionId: 'session-1',
    model: { provider: 'deepseek', model: 'model-1' },
  });

  const leaked = state.get('oc_1');
  leaked.message = 'full text';
  leaked.toolArgs = { token: 'secret' };
  leaked.env = { FEISHU_APP_SECRET: 'secret' };
  leaked.model.apiKey = 'secret';
  leaked.model.model = 'mutated-model';

  assert.deepEqual(state.get('oc_1'), {
    projectPath: '/tmp/project',
    sessionId: 'session-1',
    model: { provider: 'deepseek', model: 'model-1' },
    updatedAt: '2026-08-26T00:00:00.000Z',
  });
  await rm(dir, { recursive: true, force: true });
});

test('session map does not persist fields injected through get after a later save', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-state-'));
  const file = join(dir, 'state.json');
  const state = createSessionMap(file, { now: () => '2026-08-26T00:00:00.000Z' });
  state.bind('oc_1', {
    projectPath: '/tmp/project',
    sessionId: 'session-1',
    model: { provider: 'deepseek', model: 'model-1' },
  });

  const leaked = state.get('oc_1');
  leaked.message = 'full text';
  leaked.toolArgs = { token: 'secret' };
  leaked.env = { FEISHU_APP_SECRET: 'secret' };
  leaked.model.apiKey = 'secret';
  state.bind('oc_2', { projectPath: '/tmp/other-project' });

  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).bindings.oc_1, {
    projectPath: '/tmp/project',
    sessionId: 'session-1',
    model: { provider: 'deepseek', model: 'model-1' },
    updatedAt: '2026-08-26T00:00:00.000Z',
  });
  await rm(dir, { recursive: true, force: true });
});

test('session map preserves an unsupported primary version and writes recovery state instead', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-state-'));
  const file = join(dir, 'state.json');
  const original = JSON.stringify({ version: 99, bindings: { oc_1: { projectPath: '/tmp/project' } } });
  writeFileSync(file, original, 'utf8');

  const state = createSessionMap(file, { now: () => '2026-08-26T00:00:00.000Z' });
  state.bind('oc_2', { projectPath: '/tmp/other-project' });

  assert.equal(readFileSync(file, 'utf8'), original);
  assert.equal(state.recoveredPath, file + '.recovered');
  assert.deepEqual(JSON.parse(readFileSync(file + '.recovered', 'utf8')), {
    version: 1,
    bindings: {
      oc_2: {
        projectPath: '/tmp/other-project',
        updatedAt: '2026-08-26T00:00:00.000Z',
      },
    },
  });
  await rm(dir, { recursive: true, force: true });
});

test('session map preserves a malformed versioned primary instead of silently dropping bindings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-state-'));
  const file = join(dir, 'state.json');
  const original = JSON.stringify({ version: 1, bindings: { oc_1: { projectPath: 42 } } });
  writeFileSync(file, original, 'utf8');

  const state = createSessionMap(file);
  state.bind('oc_2', { projectPath: '/tmp/other-project' });

  assert.equal(readFileSync(file, 'utf8'), original);
  assert.equal(state.recoveredPath, file + '.recovered');
  assert.equal(JSON.parse(readFileSync(file + '.recovered', 'utf8')).bindings.oc_1, undefined);
  assert.equal(JSON.parse(readFileSync(file + '.recovered', 'utf8')).bindings.oc_2.projectPath, '/tmp/other-project');
  await rm(dir, { recursive: true, force: true });
});

test('session map keeps its in-memory binding unchanged when persistence fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-state-'));
  const stateDir = join(dir, 'state');
  const file = join(stateDir, 'bindings.json');
  const state = createSessionMap(file, { now: () => '2026-08-27T00:00:00.000Z' });
  state.bind('oc_1', { projectPath: '/tmp/project-1' });

  const displacedStateDir = join(dir, 'state-backup');
  await rename(stateDir, displacedStateDir);
  await mkdir(stateDir);
  await rm(stateDir, { recursive: true });
  writeFileSync(stateDir, 'not a directory', 'utf8');

  assert.throws(() => state.bind('oc_2', { projectPath: '/tmp/project-2' }));
  assert.deepEqual(state.get('oc_1'), {
    projectPath: '/tmp/project-1',
    updatedAt: '2026-08-27T00:00:00.000Z',
  });
  assert.equal(state.get('oc_2'), undefined);
  await rm(dir, { recursive: true, force: true });
});
