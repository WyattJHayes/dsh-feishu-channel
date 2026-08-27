import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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
const STR_REPLACE_EDITOR_COMMANDS = new Set([
  'view',
  'create',
  'str_replace',
  'insert',
  'undo_edit',
]);
const FILE_WRITE_TOOL_NAMES = new Set(['edit', 'write', 'fs_write', 'fs_edit']);

const SHELL_TOOL_NAMES = new Set(['bash', 'pwsh', 'shell', 'terminal']);

const SAFE_GIT_COMMANDS = /^git\s+(?:status|diff|log|show|branch)(?:\s+[\w@./:=,-]+)*$/i;
const READ_ONLY_GIT_COMMANDS = new Set(['status', 'diff', 'log', 'show', 'branch']);
const GIT_MUTATION_CATEGORIES = new Map([
  ['add', 'git-mutation'],
  ['apply', 'git-mutation'],
  ['checkout', 'git-mutation'],
  ['cherry-pick', 'git-mutation'],
  ['clone', 'git-mutation'],
  ['config', 'git-mutation'],
  ['clean', 'git-clean'],
  ['fetch', 'git-mutation'],
  ['init', 'git-mutation'],
  ['merge', 'git-mutation'],
  ['mv', 'git-mutation'],
  ['pull', 'git-mutation'],
  ['push', 'git-publish'],
  ['rebase', 'git-history'],
  ['reflog', 'git-mutation'],
  ['reset', 'git-history'],
  ['restore', 'git-mutation'],
  ['revert', 'git-mutation'],
  ['rm', 'git-mutation'],
  ['switch', 'git-mutation'],
  ['tag', 'git-mutation'],
  ['worktree', 'git-mutation'],
]);
const ASK_COMMANDS = [
  { pattern: /^git\s+commit(?:\s+.*)?\s--amend(?:[=\s]|$)/i, category: 'git-amend' },
  { pattern: /^git\s+(?:add|commit)(?:\s|$)/i, category: 'git-mutation' },
  { pattern: /^(?:pnpm|npm|yarn|bun|node)\s+/i, category: 'script-command' },
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
    const { paths, invalid } = extractToolPaths(toolName, exec?.arguments);
    if (invalid) return deny('RISK_POLICY_PATH_UNKNOWN');
    if (paths.length === 0 && requiresFilePath(toolName)) return deny('RISK_POLICY_PATH_UNKNOWN');
    if (paths.some((path) => !isWithinRoot(projectPath, path))) {
      return deny('RISK_POLICY_PATH_OUTSIDE_PROJECT');
    }
    if (FILE_WRITE_TOOL_NAMES.has(toolName) && paths.some((path) => isGitControlPath(projectPath, path))) {
      return deny('RISK_POLICY_GIT_METADATA_WRITE');
    }
    return { kind: 'allow' };
  }

  if (toolName === 'str_replace_editor') {
    return classifyStrReplaceEditor(exec?.arguments, projectPath);
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
  const tokens = tokenizeCommand(trimmed);
  if (!tokens) return deny('RISK_POLICY_COMMAND_PARSE_FAILED');

  const paths = extractCommandPaths(trimmed);
  if (paths.some((path) => !isWithinRoot(projectPath, path))) {
    return deny('RISK_POLICY_PATH_OUTSIDE_PROJECT');
  }

  const gitDecision = classifyGitCommand(tokens, toolName, projectPath, trimmed);
  if (gitDecision) return gitDecision;

  const askMatch = ASK_COMMANDS.find((entry) => entry.pattern.test(trimmed));
  if (askMatch) {
    return {
      kind: 'ask',
      reason: `RISK_POLICY_${askMatch.category.toUpperCase().replaceAll('-', '_')}`,
      summary: createSummary(toolName, askMatch.category, projectPath, paths),
    };
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

function classifyGitCommand(tokens, toolName, projectPath, command) {
  if (tokens[0]?.toLowerCase() !== 'git') return undefined;
  const subcommand = tokens[1]?.toLowerCase();
  if (!subcommand) return deny('RISK_POLICY_COMMAND_UNKNOWN');

  // Git's normal diff mode may invoke configured external diff or textconv
  // helpers. Treat every diff as an approval boundary rather than relying on
  // the local Git configuration to stay inert.
  if (subcommand === 'diff') return askGit(toolName, 'git-external-diff', projectPath);

  if (READ_ONLY_GIT_COMMANDS.has(subcommand)) {
    if (!SAFE_GIT_COMMANDS.test(command)) return deny('RISK_POLICY_COMMAND_UNKNOWN');
    if (subcommand === 'branch' && tokens.length > 2) {
      const category = tokens.some((token) => /^(?:-[^-]*[dD]|--delete|--force)(?:=|$)/i.test(token))
        ? 'git-branch-delete'
        : 'git-config-read';
      return askGit(toolName, category, projectPath);
    }
    return askGit(toolName, 'git-config-read', projectPath);
  }

  if (subcommand === 'commit') {
    return askGit(toolName, tokens.some((token) => /^--amend(?:=|$)/i.test(token)) ? 'git-amend' : 'git-mutation', projectPath);
  }
  if (subcommand === 'branch') {
    const category = tokens.some((token) => /^(?:-[^-]*[dD]|--delete|--force)(?:=|$)/i.test(token))
      ? 'git-branch-delete'
      : 'git-mutation';
    return askGit(toolName, category, projectPath);
  }

  const category = GIT_MUTATION_CATEGORIES.get(subcommand);
  if (!category) return undefined;
  if ((subcommand === 'checkout' || subcommand === 'switch') && tokens.some((token) => /^(?:-[^-]*[fFbBcC]|--force)(?:=|$)/i.test(token))) {
    return askGit(toolName, 'git-force', projectPath);
  }
  if (subcommand === 'clean') return askGit(toolName, 'git-clean', projectPath);
  return askGit(toolName, category, projectPath);
}

function classifyStrReplaceEditor(args, projectPath) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return deny('RISK_POLICY_PATH_UNKNOWN');
  }
  if (!STR_REPLACE_EDITOR_COMMANDS.has(args.command)) {
    return deny('RISK_POLICY_EDITOR_COMMAND_UNKNOWN');
  }
  if (typeof args.path !== 'string' || args.path.trim() === '') {
    return deny('RISK_POLICY_PATH_UNKNOWN');
  }
  if (!isWithinRoot(projectPath, args.path)) {
    return deny('RISK_POLICY_PATH_OUTSIDE_PROJECT');
  }
  if (isGitControlPath(projectPath, args.path) && ['create', 'str_replace', 'insert', 'undo_edit'].includes(args.command)) {
    return deny('RISK_POLICY_GIT_METADATA_WRITE');
  }
  return { kind: 'allow' };
}

function askGit(toolName, category, projectPath) {
  return {
    kind: 'ask',
    reason: `RISK_POLICY_${category.toUpperCase().replaceAll('-', '_')}`,
    summary: createSummary(toolName, category, projectPath, []),
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

function extractToolPaths(toolName, args) {
  const fields = {
    read: ['file_path', 'path'],
    write: ['file_path', 'path'],
    edit: ['file_path', 'path'],
    read_image: ['file_path', 'path'],
    glob: ['path'],
    grep: ['path'],
    fs_read: ['file_path', 'path'],
    fs_write: ['file_path', 'path'],
    fs_edit: ['file_path', 'path'],
    fs_search: ['path'],
  }[toolName];
  if (!fields || !args || typeof args !== 'object' || Array.isArray(args)) {
    return { paths: [], invalid: true };
  }

  const paths = [];
  let invalid = false;
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(args, field)) continue;
    const value = args[field];
    if (typeof value !== 'string' || value.trim() === '') {
      invalid = true;
      continue;
    }
    paths.push(value);
  }
  return { paths, invalid };
}

function requiresFilePath(toolName) {
  return !new Set(['glob', 'grep', 'fs_search']).has(toolName);
}

function extractCommandPaths(command) {
  const paths = [];
  const tokens = tokenizeCommand(command);
  if (!tokens) return paths;
  const isGitDiff = tokens[0]?.toLowerCase() === 'git' && tokens[1]?.toLowerCase() === 'diff';
  const hasNoIndex = tokens.includes('--no-index');

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const assignment = /^--[^=]+=([\s\S]+)$/.exec(token);
    const candidate = assignment?.[1] ?? token;
    const looksLikeUri = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(candidate);
    const looksLikePath = !looksLikeUri && (assignment || isAbsolute(candidate) || candidate.includes('/') || candidate.includes('\\') || candidate.startsWith('.'));
    if (looksLikePath) {
      paths.push(candidate);
      continue;
    }
    if (isGitDiff && hasNoIndex && index > 1 && !token.startsWith('-')) paths.push(candidate);
  }
  return paths;
}

function tokenizeCommand(command) {
  const tokens = [];
  let token = '';
  let quote;
  let escaped = false;
  for (const character of command) {
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && !quote) {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (token) tokens.push(token);
      token = '';
      continue;
    }
    token += character;
  }
  if (escaped || quote) return undefined;
  if (token) tokens.push(token);
  return tokens;
}

function hasShellExpansion(command) {
  return /[`$*?{}~]/.test(command);
}

function hasShellControl(command) {
  return /[;&|<>()\n\r]/.test(command);
}

function isWithinRoot(root, target) {
  const resolvedRoot = canonicalizePath(root);
  const resolvedTarget = canonicalizePath(isAbsolute(target) ? target : resolve(root, target));
  if (!resolvedRoot || !resolvedTarget) return false;
  const relativePath = relative(resolvedRoot, resolvedTarget);
  return relativePath === '' ||
    (!relativePath.startsWith('..' + sep) && relativePath !== '..' && !isAbsolute(relativePath));
}

function canonicalizePath(target) {
  if (typeof target !== 'string' || !isAbsolute(target)) return undefined;
  let existing = target;
  const missing = [];
  while (true) {
    try {
      lstatSync(existing);
    } catch (error) {
      if (error?.code !== 'ENOENT') return undefined;
      const parent = dirname(existing);
      if (parent === existing) return undefined;
      missing.unshift(relative(parent, existing));
      existing = parent;
      continue;
    }

    try {
      return join(realpathSync(existing), ...missing);
    } catch {
      return undefined;
    }
  }
}

function toProjectRelativePath(projectPath, target) {
  const relativePath = relative(projectPath, isAbsolute(target) ? target : resolve(projectPath, target));
  return relativePath === '' ? '.' : relativePath;
}

function isGitControlPath(projectPath, target) {
  const resolvedRoot = canonicalizePath(resolve(projectPath));
  const resolvedTarget = canonicalizePath(isAbsolute(target) ? target : resolve(projectPath, target));
  if (!resolvedRoot || !resolvedTarget) return false;
  const relativePath = relative(resolvedRoot, resolvedTarget);
  return relativePath === '.git' || relativePath.startsWith('.git' + sep);
}
