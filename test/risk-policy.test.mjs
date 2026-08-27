import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyToolExecution, createRiskListener } from '../lib/risk-policy.js';

test('risk policy allows safe project reads but asks before running project scripts', () => {
  assert.deepEqual(classifyToolExecution({ name: 'fs_read', arguments: { path: '/work/src/a.js' } }, {
    projectPath: '/work',
  }), { kind: 'allow' });
  assert.equal(classifyToolExecution({ name: 'bash', arguments: { command: 'pnpm test' } }, {
    projectPath: '/work',
  }).kind, 'ask');
});

test('risk policy allows only scoped str_replace_editor operations', () => {
  assert.deepEqual(classifyToolExecution({
    name: 'str_replace_editor',
    arguments: {
      command: 'str_replace',
      path: '/work/src/app.js',
      old_str: 'before',
      new_str: 'after',
    },
  }, {
    projectPath: '/work',
  }), { kind: 'allow' });

  assert.equal(classifyToolExecution({
    name: 'str_replace_editor',
    arguments: { command: 'shell', path: '/work/src/app.js' },
  }, {
    projectPath: '/work',
  }).kind, 'deny');

  assert.equal(classifyToolExecution({
    name: 'str_replace_editor',
    arguments: { command: 'str_replace', path: '/outside/app.js' },
  }, {
    projectPath: '/work',
  }).kind, 'deny');
});

test('risk policy inspects absolute paths assigned with command options', () => {
  assert.equal(classifyToolExecution({
    name: 'bash',
    arguments: { command: 'git diff --output=/outside/report.diff' },
  }, {
    projectPath: '/work',
  }).kind, 'deny');

  assert.equal(classifyToolExecution({
    name: 'bash',
    arguments: { command: 'git diff --output=/work/report.diff' },
  }, {
    projectPath: '/work',
  }).kind, 'ask');

  assert.equal(classifyToolExecution({
    name: 'bash',
    arguments: { command: 'git diff --output=../../outside/report.diff' },
  }, {
    projectPath: '/work/project',
  }).kind, 'deny');
});

test('risk policy asks for destructive or external commands', () => {
  assert.equal(classifyToolExecution({ name: 'bash', arguments: { command: 'git push origin main' } }, {
    projectPath: '/work',
  }).kind, 'ask');
  assert.equal(classifyToolExecution({ name: 'bash', arguments: { command: 'git branch -D old' } }, {
    projectPath: '/work',
  }).kind, 'ask');
  assert.equal(classifyToolExecution({ name: 'bash', arguments: { command: 'git branch --delete old' } }, {
    projectPath: '/work',
  }).kind, 'ask');
  assert.equal(classifyToolExecution({ name: 'bash', arguments: { command: 'git branch --force main' } }, {
    projectPath: '/work',
  }).kind, 'ask');
  assert.equal(classifyToolExecution({ name: 'bash', arguments: { command: 'git checkout -B release' } }, {
    projectPath: '/work',
  }).kind, 'ask');
  assert.equal(classifyToolExecution({ name: 'bash', arguments: { command: 'rm -rf /work/build' } }, {
    projectPath: '/work',
  }).kind, 'ask');
  assert.equal(classifyToolExecution({ name: 'bash', arguments: { command: 'node test' } }, {
    projectPath: '/work',
  }).kind, 'ask');
  assert.equal(classifyToolExecution({ name: 'bash', arguments: { command: 'git add src/index.js' } }, {
    projectPath: '/work',
  }).kind, 'ask');
});

test('risk policy requires approval for git commit amend', () => {
  assert.equal(classifyToolExecution({
    name: 'bash',
    arguments: { command: 'git commit -m update' },
  }, {
    projectPath: '/work',
  }).kind, 'ask');

  const result = classifyToolExecution({
    name: 'bash',
    arguments: { command: 'git commit --no-edit --amend' },
  }, {
    projectPath: '/work',
  });

  assert.equal(result.kind, 'ask');
  assert.equal(result.reason, 'RISK_POLICY_GIT_AMEND');
  assert.deepEqual(result.summary, {
    toolName: 'bash',
    riskCategory: 'git-amend',
    projectRelativePath: '.',
  });
  assert.equal(JSON.stringify(result).includes('--amend'), false);
});

test('risk policy denies an absolute path outside the project', () => {
  const result = classifyToolExecution({ name: 'fs_read', arguments: { path: '/Users/me/.ssh/id_rsa' } }, {
    projectPath: '/work',
  });

  assert.equal(result.kind, 'deny');
});

test('risk policy resolves relative file paths and ignores non-path content', () => {
  assert.equal(classifyToolExecution({
    name: 'write',
    arguments: { path: '../outside.txt', content: '/work/project' },
  }, {
    projectPath: '/work/project',
  }).kind, 'deny');

  assert.equal(classifyToolExecution({
    name: 'write',
    arguments: { path: '/work/project/inside.txt', content: '/outside/decoy' },
  }, {
    projectPath: '/work/project',
  }).kind, 'allow');
});

test('risk policy rejects relative paths in safe git reads', () => {
  assert.equal(classifyToolExecution({
    name: 'bash',
    arguments: { command: 'git diff --no-index ../outside.txt inside.txt' },
  }, {
    projectPath: '/work/project',
  }).kind, 'deny');
});

test('risk policy denies compound commands instead of prefix allowing them', () => {
  const compoundCommands = [
    'pnpm test && curl https://example.test',
    'git status; rm -rf build',
    'pnpm lint | tee out.txt',
    'pnpm build > artifact.log',
    'pnpm test\nrm -rf build',
    '(pnpm test)',
  ];

  for (const command of compoundCommands) {
    assert.equal(classifyToolExecution({ name: 'bash', arguments: { command } }, {
      projectPath: '/work',
    }).kind, 'deny');
  }
});

test('risk policy uses canonical paths to reject symlink escapes and allow safe new files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'risk-root-'));
  const project = join(root, 'project');
  const outside = await mkdtemp(join(tmpdir(), 'risk-outside-'));
  await mkdir(project);
  await symlink(outside, join(project, 'link-to-outside'), 'dir');

  assert.equal(classifyToolExecution({
    name: 'fs_read',
    arguments: { path: join(project, 'link-to-outside', 'secret.txt') },
  }, {
    projectPath: project,
  }).kind, 'deny');

  assert.equal(classifyToolExecution({
    name: 'write',
    arguments: { path: join(project, 'new-file.txt') },
  }, {
    projectPath: project,
  }).kind, 'allow');

  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test('risk policy rejects dangling symlink targets before allowing a write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'risk-root-'));
  const project = join(root, 'project');
  const outside = join(root, 'outside');
  await mkdir(project);
  await symlink(join(outside, 'missing.txt'), join(project, 'dangling-link.txt'));

  assert.equal(classifyToolExecution({
    name: 'write',
    arguments: { path: join(project, 'dangling-link.txt') },
  }, {
    projectPath: project,
  }).kind, 'deny');

  await rm(root, { recursive: true, force: true });
});

test('risk policy does not allow Git commands that mutate refs or write output', () => {
  assert.equal(classifyToolExecution({
    name: 'bash',
    arguments: { command: 'git branch new-feature' },
  }, {
    projectPath: '/work',
  }).kind, 'ask');

  assert.equal(classifyToolExecution({
    name: 'bash',
    arguments: { command: 'git diff --output=report.txt' },
  }, {
    projectPath: '/work',
  }).kind, 'ask');
});

test('risk policy requires approval for plain git diff because local Git config can execute helpers', () => {
  const result = classifyToolExecution({
    name: 'bash',
    arguments: { command: 'git diff' },
  }, {
    projectPath: '/work',
  });

  assert.equal(result.kind, 'ask');
  assert.equal(result.reason, 'RISK_POLICY_GIT_EXTERNAL_DIFF');
});

test('risk policy requires approval before Git reads that consult repository configuration', () => {
  for (const command of ['git status', 'git log --oneline', 'git show HEAD', 'git branch']) {
    const result = classifyToolExecution({ name: 'bash', arguments: { command } }, {
      projectPath: '/work',
    });

    assert.equal(result.kind, 'ask', command);
    assert.equal(result.reason, 'RISK_POLICY_GIT_CONFIG_READ', command);
  }
});

test('risk policy denies writes to Git control metadata', () => {
  assert.equal(classifyToolExecution({
    name: 'write',
    arguments: { path: '/work/.git/config' },
  }, {
    projectPath: '/work',
  }).kind, 'deny');

  assert.equal(classifyToolExecution({
    name: 'str_replace_editor',
    arguments: { command: 'create', path: '/work/.git/hooks/pre-commit' },
  }, {
    projectPath: '/work',
  }).kind, 'deny');
});

test('risk policy denies Git metadata writes through an in-project symlink alias', async () => {
  const root = await mkdtemp(join(tmpdir(), 'risk-root-'));
  const project = join(root, 'project');
  await mkdir(join(project, '.git'), { recursive: true });
  await symlink(join(project, '.git'), join(project, 'metadata-alias'));

  assert.equal(classifyToolExecution({
    name: 'write',
    arguments: { path: join(project, 'metadata-alias', 'config') },
  }, {
    projectPath: project,
  }).kind, 'deny');

  await rm(root, { recursive: true, force: true });
});

test('risk policy asks before all known Git mutation commands', () => {
  for (const command of ['git checkout feature', 'git switch feature', 'git merge feature', 'git cherry-pick abc123', 'git revert abc123', 'git apply patch.diff']) {
    assert.equal(classifyToolExecution({ name: 'bash', arguments: { command } }, {
      projectPath: '/work',
    }).kind, 'ask', command);
  }
});

test('risk policy denies unknown tools and ambiguous shell expansion', () => {
  assert.equal(classifyToolExecution({ name: 'unknown_tool', arguments: { path: '/work/a.js' } }, {
    projectPath: '/work',
  }).kind, 'deny');
  assert.equal(classifyToolExecution({ name: 'bash', arguments: { command: 'cat $TOKEN' } }, {
    projectPath: '/work',
  }).kind, 'deny');
});

test('risk policy asks with a sanitized summary only', () => {
  const result = classifyToolExecution({
    name: 'bash',
    arguments: { command: 'curl -H "Authorization: Bearer secret" https://example.test' },
  }, {
    projectPath: '/work',
  });

  assert.equal(result.kind, 'ask');
  assert.deepEqual(result.summary, {
    toolName: 'bash',
    riskCategory: 'external-command',
    projectRelativePath: '.',
  });
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(JSON.stringify(result).includes('TOKEN'), false);
  assert.equal(JSON.stringify(result).includes('curl'), false);
});

test('risk listener only calls next for allow decisions and remembers asks', async () => {
  const remembered = [];
  const listener = createRiskListener({
    projectPath: '/work',
    remember: (exec, summary) => remembered.push({ exec, summary }),
  });
  let nextCalls = 0;

  const script = await listener({ name: 'bash', arguments: { command: 'pnpm test' } }, async () => {
    nextCalls += 1;
    return 'unexpected';
  });

  const ask = await listener({
    name: 'bash',
    callId: 'call-1',
    arguments: { command: 'git push origin main' },
  }, async () => {
    nextCalls += 1;
    return 'unexpected';
  });
  const deny = await listener({ name: 'missing_tool', arguments: {} }, async () => {
    nextCalls += 1;
    return 'unexpected';
  });

  assert.equal(ask.kind, 'ask');
  assert.equal(deny.kind, 'deny');
  assert.equal(nextCalls, 0);
  assert.equal(script.kind, 'ask');
  assert.equal(remembered.length, 2);
  assert.deepEqual(remembered[0].summary, {
    toolName: 'bash',
    riskCategory: 'script-command',
    projectRelativePath: '.',
  });
});
