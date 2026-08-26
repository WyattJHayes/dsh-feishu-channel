/**
 * Chat ↔ DSH session binding map, persisted as one JSON file under the
 * profile data directory. One Feishu chat binds at most one live session;
 * /new unbinds (the old session stays visible in the desktop UI).
 */
import { lstatSync, readFileSync, writeFileSync, mkdirSync, renameSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * @typedef {{ provider: string, model: string, reasoningEffort?: string }} ModelBinding
 * @typedef {{ projectPath?: string, sessionId?: string, model?: ModelBinding, updatedAt?: string }} SessionBinding
 */

/** @param {unknown} chatId */
function assertChatId(chatId) {
  if (typeof chatId !== 'string' || chatId.trim() === '') {
    throw new Error('SESSION_MAP_INVALID_CHAT_ID: chatId must be a non-empty string');
  }
}

/** @param {unknown} projectPath */
function assertProjectPath(projectPath) {
  if (typeof projectPath !== 'string' || !isAbsolute(projectPath)) {
    throw new Error('SESSION_MAP_INVALID_PROJECT_PATH: projectPath must be an absolute path');
  }
}

/** @param {unknown} model */
function normalizeModel(model) {
  if (!model || typeof model !== 'object') return undefined;
  const source = /** @type {{ provider?: unknown, model?: unknown, reasoningEffort?: unknown }} */ (model);
  if (typeof source.provider !== 'string' || typeof source.model !== 'string') return undefined;
  const normalized = { provider: source.provider, model: source.model };
  if (typeof source.reasoningEffort === 'string') normalized.reasoningEffort = source.reasoningEffort;
  return normalized;
}

/** @param {unknown} binding */
function normalizeVersionedBinding(binding) {
  if (!binding || typeof binding !== 'object') return undefined;
  const source = /** @type {SessionBinding} */ (binding);
  if (typeof source.projectPath !== 'string') return undefined;
  const normalized = { projectPath: source.projectPath };
  if (typeof source.sessionId === 'string') normalized.sessionId = source.sessionId;
  const model = normalizeModel(source.model);
  if (model) normalized.model = model;
  if (typeof source.updatedAt === 'string') normalized.updatedAt = source.updatedAt;
  return normalized;
}

/** @param {unknown} binding */
function normalizeLegacyBinding(binding) {
  if (!binding || typeof binding !== 'object') return undefined;
  const source = /** @type {{ sessionId?: unknown }} */ (binding);
  if (typeof source.sessionId !== 'string') return undefined;
  return { sessionId: source.sessionId };
}

/** @param {unknown} binding */
function normalizePersistedBinding(binding) {
  return normalizeVersionedBinding(binding) ?? normalizeLegacyBinding(binding);
}

/** @param {unknown} raw */
function loadVersioned(raw) {
  if (!raw || typeof raw !== 'object') return new Map();
  const source = /** @type {{ version?: unknown, bindings?: unknown }} */ (raw);
  if (source.version !== 1 || !source.bindings || typeof source.bindings !== 'object') return new Map();
  const loaded = new Map();
  for (const [chatId, binding] of Object.entries(source.bindings)) {
    if (chatId.trim() === '') continue;
    const normalized = normalizePersistedBinding(binding);
    if (normalized) loaded.set(chatId, normalized);
  }
  return loaded;
}

/** @param {unknown} raw */
function loadLegacy(raw) {
  if (!raw || typeof raw !== 'object') return new Map();
  const loaded = new Map();
  for (const [chatId, binding] of Object.entries(raw)) {
    if (chatId === 'version' || chatId === 'bindings' || chatId.trim() === '') continue;
    const normalized = normalizeLegacyBinding(binding);
    if (normalized) loaded.set(chatId, normalized);
  }
  return loaded;
}

/** @param {string} path */
function readState(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (raw && typeof raw === 'object' && 'version' in raw) return loadVersioned(raw);
  return loadLegacy(raw);
}

/** @param {SessionBinding} binding */
function normalizeWritableBinding(binding) {
  assertProjectPath(binding?.projectPath);
  const normalized = { projectPath: binding.projectPath };
  if (typeof binding.sessionId === 'string') normalized.sessionId = binding.sessionId;
  const model = normalizeModel(binding.model);
  if (model) normalized.model = model;
  return normalized;
}

/** @param {SessionBinding | undefined} binding */
function copyBinding(binding) {
  if (!binding) return undefined;
  const copy = { ...binding };
  if (binding.model) copy.model = { ...binding.model };
  return copy;
}

/** @param {Map<string, SessionBinding>} bindings */
function toSafeBindings(bindings) {
  const safe = {};
  for (const [chatId, binding] of bindings) {
    const normalized = normalizePersistedBinding(binding);
    if (normalized) safe[chatId] = normalized;
  }
  return safe;
}

/**
 * 校验状态文件从受信根目录到目标路径的所有已存在组件都不是符号链接。
 * 这样递归创建父目录时不会跟随预先放置的目录链接写到缓存目录外。
 * @param {string} rootPath
 * @param {string} targetPath
 */
export function assertSafeStatePath(rootPath, targetPath) {
  if (typeof rootPath !== 'string' || typeof targetPath !== 'string' || !isAbsolute(rootPath) || !isAbsolute(targetPath)) {
    throw new Error('FEISHU_STATE_PATH_INVALID: state path must be absolute');
  }
  const root = resolve(rootPath);
  const target = resolve(targetPath);
  const relativeTarget = relative(root, target);
  if (relativeTarget === '..' || relativeTarget.startsWith('..' + sep) || isAbsolute(relativeTarget)) {
    throw new Error('FEISHU_STATE_PATH_OUTSIDE_CACHE: state path must stay inside cache');
  }

  let existing = root;
  while (true) {
    try {
      const stats = lstatSync(existing);
      if (stats.isSymbolicLink()) throw new Error('FEISHU_STATE_PATH_SYMLINK: state path cannot contain symbolic links');
      if (existing === root && !stats.isDirectory()) {
        throw new Error('FEISHU_STATE_PATH_INVALID: state root must be a directory');
      }
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
  }

  const remainder = relative(existing, target);
  let current = existing;
  for (const part of remainder.split(sep).filter(Boolean)) {
    current = resolve(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error('FEISHU_STATE_PATH_SYMLINK: state path cannot contain symbolic links');
      }
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
  }

  // realpathSync verifies the existing ancestor remains resolvable after lstat.
  realpathSync(existing);
}

/** @param {string} filePath @param {{ now?: () => string, safeRoot?: string }} [options] */
export function createSessionMap(filePath, options = {}) {
  /** @type {Map<string, SessionBinding>} */
  let map = new Map();
  let writePath = filePath;
  let recoveredPath;

  function assertSafe(path) {
    if (options.safeRoot) assertSafeStatePath(options.safeRoot, path);
  }

  try {
    assertSafe(filePath);
    map = readState(filePath);
  } catch (error) {
    if (String(error?.message ?? '').startsWith('FEISHU_STATE_PATH_')) throw error;
    if (error?.code !== 'ENOENT') {
      recoveredPath = filePath + '.recovered';
      writePath = recoveredPath;
      try {
        assertSafe(recoveredPath);
        map = readState(recoveredPath);
      } catch {
        map = new Map();
      }
    }
  }

  function save() {
    assertSafe(writePath);
    mkdirSync(dirname(writePath), { recursive: true });
    assertSafe(writePath);
    const tempPath = writePath + '.' + randomUUID() + '.tmp';
    assertSafe(tempPath);
    writeFileSync(tempPath, JSON.stringify({ version: 1, bindings: toSafeBindings(map) }, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    assertSafe(writePath);
    renameSync(tempPath, writePath);
  }

  return {
    recoveredPath,
    /** @returns {SessionBinding | undefined} */
    get(chatId) {
      return copyBinding(map.get(chatId));
    },
    /** @param {string} chatId @param {SessionBinding} binding */
    bind(chatId, binding) {
      assertChatId(chatId);
      const normalized = normalizeWritableBinding(binding);
      normalized.updatedAt = options.now ? options.now() : new Date().toISOString();
      map.set(chatId, normalized);
      save();
    },
    /** @param {string} chatId */
    clearSession(chatId) {
      assertChatId(chatId);
      const binding = map.get(chatId);
      if (!binding) return false;
      if (!binding.projectPath) {
        map.delete(chatId);
        save();
        return true;
      }
      const next = { projectPath: binding.projectPath };
      if (binding.model) next.model = binding.model;
      next.updatedAt = options.now ? options.now() : new Date().toISOString();
      map.set(chatId, next);
      save();
      return true;
    },
    /** @param {string} chatId */
    unbind(chatId) {
      assertChatId(chatId);
      const had = map.delete(chatId);
      if (had) save();
      return had;
    },
    clear() {
      const count = map.size;
      map = new Map();
      save();
      return count;
    },
  };
}
