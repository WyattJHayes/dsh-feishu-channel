import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectPolicy } from '../lib/project-policy.js';

test('project policy accepts a real directory inside an allowed root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-root-'));
  const project = join(root, 'project');
  await mkdir(project);
  const policy = createProjectPolicy([root]);

  assert.deepEqual(policy.resolve(project), { ok: true, path: realpathSync(project) });
  await rm(root, { recursive: true, force: true });
});

test('project policy rejects relative, missing, file, and outside paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'feishu-outside-'));
  const file = join(root, 'file.txt');
  await writeFile(file, 'x');
  const policy = createProjectPolicy([root]);

  assert.equal(policy.resolve('relative').ok, false);
  assert.equal(policy.resolve(join(root, 'missing')).ok, false);
  assert.equal(policy.resolve(file).ok, false);
  assert.equal(policy.resolve(outside).ok, false);

  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test('project policy rejects a symlink whose real target leaves the allowed root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'feishu-outside-'));
  const link = join(root, 'escape');
  await symlink(outside, link, 'dir');
  const policy = createProjectPolicy([root]);

  assert.equal(policy.resolve(link).ok, false);

  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test('project policy rejects Git metadata directories as project roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-root-'));
  const repo = join(root, 'repo');
  const gitRoot = join(repo, '.git');
  await mkdir(join(gitRoot, 'hooks'), { recursive: true });
  const policy = createProjectPolicy([root]);

  assert.deepEqual(policy.resolve(gitRoot), {
    ok: false,
    code: 'PROJECT_PATH_GIT_METADATA',
    message: '项目路径不能是 Git 元数据目录。',
  });
  assert.deepEqual(policy.resolve(join(gitRoot, 'hooks')), {
    ok: false,
    code: 'PROJECT_PATH_GIT_METADATA',
    message: '项目路径不能是 Git 元数据目录。',
  });

  await assert.rejects(
    async () => createProjectPolicy([gitRoot]),
    /FEISHU_ALLOWED_ROOT_GIT_METADATA/,
  );
  await rm(root, { recursive: true, force: true });
});
