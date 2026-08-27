/**
 * Plugin configuration — defaults, normalization and validation.
 * Secrets never live here: app_id/app_secret resolve per operation through
 * the kernel credentials plane (`ctx.credentials`), file layer
 * `$DSH_HOME/.credentials.yaml`. This config only carries references.
 */

import { isAbsolute } from 'node:path';

const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const POSITIVE_INTEGER_KEYS = [
  'approvalTimeoutMs',
  'progressIntervalMs',
  'maxProgressMessages',
  'maxPromptLength',
  'dedupeCapacity',
  'dedupeTtlMs',
  'agentOperationTimeoutMs',
  'whenIdleTimeoutMs',
  'cancelTimeoutMs',
  'maxQueuedPrompts',
];

const MAX_INTEGER_VALUES = {
  approvalTimeoutMs: 3_600_000,
  progressIntervalMs: 300_000,
  maxProgressMessages: 100,
  maxPromptLength: 120_000,
  dedupeCapacity: 100_000,
  dedupeTtlMs: 7 * 24 * 60 * 60 * 1000,
  agentOperationTimeoutMs: 300_000,
  whenIdleTimeoutMs: 300_000,
  cancelTimeoutMs: 300_000,
  maxQueuedPrompts: 100,
};

const DEFAULTS = {
  /** Credentials-plane keys holding the Feishu app id / secret. */
  appIdRef: 'FEISHU_APP_ID',
  appSecretRef: 'FEISHU_APP_SECRET',
  /** Deny-by-default access control. Empty lists reject everything. */
  allowedOpenIds: [],
  allowedChatIds: [],
  /** Send group replies to the authorized sender unless group sharing is explicit. */
  groupOutputMode: 'sender',
  /** Absolute roots available for remote project binding. */
  allowedProjectRoots: [],
  /** Serialized JSON state file for chat↔session bindings. */
  stateFile: 'feishu-channel/state.json',
  /** Agent preset applied to sessions created from Feishu (null = default). */
  agentPreset: null,
  approvalTimeoutMs: 600000,
  progressIntervalMs: 2000,
  maxProgressMessages: 12,
  maxPromptLength: 12000,
  dedupeCapacity: 1024,
  dedupeTtlMs: 300000,
  agentOperationTimeoutMs: 30000,
  whenIdleTimeoutMs: 30000,
  cancelTimeoutMs: 10000,
  maxQueuedPrompts: 8,
};

/**
 * @param {Partial<typeof DEFAULTS> | undefined} userConfig patch-layer config
 * @returns {{ config: typeof DEFAULTS & Record<string, unknown>, errors: string[] }}
 */
export function normalizeConfig(userConfig) {
  const config = { ...DEFAULTS, ...(userConfig ?? {}) };
  config.allowedOpenIds = normalizeListValue(config.allowedOpenIds);
  config.allowedChatIds = normalizeListValue(config.allowedChatIds);
  config.allowedProjectRoots = normalizeListValue(config.allowedProjectRoots);
  const errors = [];
  if (config.groupOutputMode !== 'sender' && config.groupOutputMode !== 'group') {
    errors.push('groupOutputMode must be either sender or group');
  }
  if (typeof config.appIdRef !== 'string' || !CREDENTIAL_REF_PATTERN.test(config.appIdRef)) {
    errors.push('appIdRef must be an environment-compatible credentials key');
  }
  if (typeof config.appSecretRef !== 'string' || !CREDENTIAL_REF_PATTERN.test(config.appSecretRef)) {
    errors.push('appSecretRef must be an environment-compatible credentials key');
  }
  for (const root of config.allowedProjectRoots) {
    if (!isAbsolute(root)) {
      errors.push(`allowedProjectRoots entry must be an absolute path: ${root}`);
    }
  }
  for (const key of POSITIVE_INTEGER_KEYS) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) {
      errors.push(`${key} must be a positive integer`);
    } else if (config[key] > MAX_INTEGER_VALUES[key]) {
      errors.push(`${key} must not exceed ${MAX_INTEGER_VALUES[key]}`);
    }
  }
  return { config, errors };
}

function normalizeListValue(value) {
  if (Array.isArray(value)) {
    return value
      .filter((v) => typeof v === 'string' && v.trim())
      .map((v) => v.trim());
  }
  if (typeof value === 'string') return value.split(/[,\s]+/).map((v) => v.trim()).filter(Boolean);
  return [];
}
