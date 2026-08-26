import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

const FILE_TOOL_NAMES = new Set([
  'fs_read',
  'fs_search',
  'read',
  'glob',
  'grep',
  'edit',
  'write',
  'fs_write',
  'fs_edit',
]);

const SHELL_TOOL_NAMES = new Set(['bash', 'pwsh', 'shell', 'terminal']);

const SAFE_PACKAGE_COMMANDS = /^(?:(?:pnpm|npm|yarn|bun)(?:\s+run)?|node)\s+(?:test|build|lint|typecheck|check|dev)(?:\s+[\w@./:=,-]+)*$/i;
const SAFE_GIT_COMMANDS = /^git\s+(?:status|diff|log|show|branch|add|commit)(?:\s+[\w@./:=,-]+)*$/i;
const ASK_COMMANDS = [
  { pattern: /^git\s+commit(?:\s+.*)?\s--amend(?:[=\s]|$)/i, category: 'git-amend' },
  { pattern: /^git\s+push(?:\s|$)/i, category: 'git-publish' },
  { pattern: /^git\s+reset(?:\s|$)/i, category: 'git-history' },
  { pattern: /^git\s+clean(?:\s|$)/i, category: 'git-clean' },
  { pattern: /^git\s+rebase(?:\s|$)/i, category: 'git-history' },
  { pattern: /^git\s+(?:checkout|switch)\s+(?:-[^\s]*[fFbBcC][^\s]*|--force)(?:\s|$)/i, category: 'git-force' },
  { pattern: /^git\s+branch\s+(?:-[^\s]*[dD][^\s]*|--delete|--force)(?:\s|$)/i, category: 'git-branch-delete' },
  { pattern: /^(?:rm|rmdir|del)(?:\s|$)/i, category: 'destructive-command' },
  { pattern: /^(?:curl|wget|ssh|scp|osascript)(?:\s|$)/i, category: 'external-command' },
  { pattern: /^(?:sudo|su|chmod|chown|launchctl|systemctl)(?:\s|$)/i, category: 'system-permission' },
  { pattern: /^(?:npm|pnpm|yarn|bun)\s+(?:publish|deploy|release)(?:\s|$)/i, category: 'publish-command' },
];

export function classifyToolExecution(exec, { projectPath } = {}) {
  const toolName = String(exec?.name ?? exec?.toolName ?? '');
  if (!toolName || typeof projectPath !== 'string' || !isAbsolute(projectPath)) {
    return deny('RISK_POLICY_INVALID_CONTEXT');
  }

  if (FILE_TOOL_NAMES.has(toolName)) {
    const paths = extractAbsolutePaths(exec?.arguments);
    if (paths.length === 0) return deny('RISK_POLICY_PATH_UNKNOWN');
    if (paths.some((path) => !isWithinRoot(projectPath, path))) {
      return deny('RISK_POLICY_PATH_OUTSIDE_PROJECT');
    }
    return { kind: 'allow' };
  }

  if (SHELL_TOOL_NAMES.has(toolName)) {
    return classifyShell(toolName, exec?.arguments, projectPath);
  }

  return deny('RISK_POLICY_TOOL_UNKNOWN');
}

export function createRiskListener({ projectPath, remember } = {}) {
  return async function riskListener(exec, next) {
    const decision = classifyToolExecution(exec, { projectPath });
    if (decision.kind === 'ask' && typeof remember === 'function') remember(exec, decision.summary);
    if (decision.kind === 'allow') return next();
    return decision;
  };
}

function classifyShell(toolName, args, projectPath) {
  const command = getCommand(args);
  if (!command) return deny('RISK_POLICY_COMMAND_UNKNOWN');
  const trimmed = command.trim();
  if (hasShellControl(trimmed)) return deny('RISK_POLICY_SHELL_CONTROL');
  if (hasShellExpansion(trimmed)) return deny('RISK_POLICY_SHELL_EXPANSION');

  const paths = extractCommandAbsolutePaths(trimmed);
  if (paths.some((path) => !isWithinRoot(projectPath, path))) {
    return deny('RISK_POLICY_PATH_OUTSIDE_PROJECT');
  }

  const askMatch = ASK_COMMANDS.find((entry) => entry.pattern.test(trimmed));
  if (askMatch) {
    return {
      kind: 'ask',
      reason: `RISK_POLICY_${askMatch.category.toUpperCase().replaceAll('-', '_')}`,
      summary: createSummary(toolName, askMatch.category, projectPath, paths),
    };
  }

  if (SAFE_GIT_COMMANDS.test(trimmed) || SAFE_PACKAGE_COMMANDS.test(trimmed)) {
    return { kind: 'allow' };
  }

  return deny('RISK_POLICY_COMMAND_UNKNOWN');
}

function createSummary(toolName, riskCategory, projectPath, paths) {
  const scopedPath = paths.find((path) => isWithinRoot(projectPath, path));
  return {
    toolName,
    riskCategory,
    projectRelativePath: scopedPath ? toProjectRelativePath(projectPath, scopedPath) : '.',
  };
}

function deny(reason) {
  return { kind: 'deny', reason };
}

function getCommand(args) {
  if (typeof args?.command === 'string') return args.command;
  if (typeof args?.cmd === 'string') return args.cmd;
  if (typeof args?.script === 'string') return args.script;
  return undefined;
}

function extractAbsolutePaths(value, paths = []) {
  if (typeof value === 'string') {
    if (isAbsolute(value)) paths.push(value);
    return paths;
  }
  if (Array.isArray(value)) {
    for (const item of value) extractAbsolutePaths(item, paths);
    return paths;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) extractAbsolutePaths(item, paths);
  }
  return paths;
}

function extractCommandAbsolutePaths(command) {
  const paths = [];
  // 选项赋值（例如 --output=/outside/file）同样是路径边界，不能只看空格。
  const pattern = /(?:^|[\s"'(=])((?:\/|[A-Za-z]:[\\/]|\\\\)[^\s"'`$;&|<>)]*)/g;
  for (const match of command.matchAll(pattern)) {
    const path = match[1];
    if (isAbsolute(path)) paths.push(path);
  }
  return paths;
}

function hasShellExpansion(command) {
  return /[`$*?{}~]/.test(command);
}

function hasShellControl(command) {
  return /[;&|<>()\n\r]/.test(command);
}

function isWithinRoot(root, target) {
  const resolvedRoot = canonicalizePath(root);
  const resolvedTarget = canonicalizePath(target);
  if (!resolvedRoot || !resolvedTarget) return false;
  const relativePath = relative(resolvedRoot, resolvedTarget);
  return relativePath === '' ||
    (!relativePath.startsWith('..' + sep) && relativePath !== '..' && !isAbsolute(relativePath));
}

function canonicalizePath(target) {
  if (typeof target !== 'string' || !isAbsolute(target)) return undefined;
  if (existsSync(target)) {
    try {
      return realpathSync(target);
    } catch {
      return undefined;
    }
  }

  let existing = target;
  const missing = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return target;
    missing.unshift(relative(parent, existing));
    existing = parent;
  }

  try {
    return join(realpathSync(existing), ...missing);
  } catch {
    return undefined;
  }
}

function toProjectRelativePath(projectPath, target) {
  const relativePath = relative(projectPath, target);
  return relativePath === '' ? '.' : relativePath;
}
