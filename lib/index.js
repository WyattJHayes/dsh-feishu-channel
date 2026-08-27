/**
 * dsh-feishu-channel — Feishu channel plugin for DeepSeek Harness.
 *
 * Architecture (docs: desktop repo `docs/feishu-channel.md`):
 *   飞书 ⇄ (outbound WS long connection + Open API) ⇄ this plugin ⇄ ctx agents
 *
 * P1 scope: p2p text loop — dedupe → whitelist → command/prompt routing →
 * reply final assistant text. The agent-facing driver is isolated in
 * `createAgentDriver` so the exact ctx call signatures can be verified at
 * runtime without touching the pure pipeline.
 */
import { WSClient, Client as LarkClient, EventDispatcher, defaultHttpInstance } from '@larksuiteoapi/node-sdk';
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { normalizeConfig } from './config.js';
import { chunkText } from './commands.js';
import { assertSafeStatePath, createSessionMap } from './session-map.js';
import { createProjectPolicy } from './project-policy.js';
import { createApprovalBridge } from './approval-bridge.js';
import { createAgentDriver } from './agent-driver.js';
import { createProgressRelay } from './progress-relay.js';
import { createMessageRouter } from './message-router.js';

const DEFAULT_SEND_TIMEOUT_MS = 15000;
const DEFAULT_SEND_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 250;
const MAX_RETRY_DELAY_MS = 30000;

export {
  createAgentDriver,
  createAgentSessionId,
  getAgentSessionId,
  createAgentOptions,
  createAgentMeta,
  getLiveAgentSessionId,
  installAgentModelSelection,
  createAgentSetup,
  createAgentUserMessage,
  extractAssistantText,
  getAgentTurnResult,
} from './agent-driver.js';
export { createMessageRouter } from './message-router.js';

export const inject = ['credentials', 'agents', 'agentDefaultModel', 'agentPresets', 'permissionPresets'];
export const name = 'feishu-channel';

/** @param {{ event_id?: unknown, header?: { event_id?: unknown } } | undefined} event */
export function extractEventId(event) {
  if (typeof event?.event_id === 'string' && event.event_id.trim()) return event.event_id;
  if (typeof event?.header?.event_id === 'string' && event.header.event_id.trim()) return event.header.event_id;
  return undefined;
}

/**
 * @param {{ resolve?: (ref: string) => Promise<{ value?: unknown } | undefined> } | undefined} credentials
 * @param {string} ref
 */
export async function resolveCredential(credentials, ref) {
  if (!credentials?.resolve) {
    throw new Error('FEISHU_NO_CREDENTIALS_SERVICE: ctx.credentials is unavailable');
  }
  const hit = await credentials.resolve(ref);
  return String(hit?.value ?? '').trim();
}

/**
 * 创建带超时、串行发送和业务码校验的飞书文本发送器。
 * @param {{
 *   resolveCredential: (ref: string) => Promise<string> | string,
 *   appIdRef?: string,
 *   appSecretRef?: string,
 *   timeoutMs?: number,
 *   maxRetries?: number,
 *   retryBaseMs?: number,
 *   sleep?: (delayMs: number) => Promise<void> | void,
 *   logger?: { warn?: (message: string) => void },
 *   clientFactory?: (credentials: { appId: string, appSecret: string, timeoutMs: number }) => unknown,
 *   httpInstance?: { request: (options: Record<string, unknown>) => Promise<unknown> },
 *   resolveRecipient?: (chatId: string) => { receiveId: string, receiveIdType: 'chat_id' | 'open_id' } | null | undefined,
 * }} options
 */
export function createFeishuSender(options) {
  const resolveValue = options?.resolveCredential;
  if (typeof resolveValue !== 'function') {
    throw new Error('FEISHU_NO_CREDENTIALS_SERVICE: credential resolver is unavailable');
  }
  const appIdRef = options.appIdRef ?? 'FEISHU_APP_ID';
  const appSecretRef = options.appSecretRef ?? 'FEISHU_APP_SECRET';
  const timeoutMs = normalizeSendTimeout(options.timeoutMs);
  const maxRetries = normalizeRetryCount(options.maxRetries);
  const retryBaseMs = normalizeRetryDelay(options.retryBaseMs);
  const sleep = typeof options.sleep === 'function' ? options.sleep : sleepFor;
  const httpInstance = options.httpInstance ?? defaultHttpInstance;
  const resolveRecipient = options.resolveRecipient;
  const sdkLogger = createSafeSdkLogger(options.logger);
  const clientFactory = options.clientFactory ?? ((credentials) => new LarkClient({
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      httpInstance: createTimeoutHttpInstance(httpInstance, credentials.timeoutMs),
      logger: sdkLogger,
      loggerLevel: 1,
    }));
  let sendQueue = Promise.resolve();

  function sendText(chatId, text) {
    const task = sendQueue.then(() => sendTextNow(chatId, text));
    sendQueue = task.catch(() => undefined);
    return task;
  }

  async function sendTextNow(chatId, text) {
    const recipient = resolveSendRecipient(chatId, resolveRecipient);
    if (!recipient) {
      options.logger?.warn?.('feishu-channel: outbound target unavailable; message skipped');
      return;
    }
    const appId = await withTimeout(
      Promise.resolve().then(() => resolveValue(appIdRef)),
      timeoutMs,
    );
    const appSecret = await withTimeout(
      Promise.resolve().then(() => resolveValue(appSecretRef)),
      timeoutMs,
    );
    if (!appId || !appSecret) {
      options.logger?.warn?.('feishu-channel: app credentials are not configured; outbound message skipped');
      return;
    }
    const client = await withTimeout(
      Promise.resolve().then(() => clientFactory({ appId, appSecret, timeoutMs })),
      timeoutMs,
    );
    const createMessage = client?.im?.message?.create;
    if (typeof createMessage !== 'function') {
      throw createFeishuError('FEISHU_SEND_API_FAILED', 'message.create is unavailable');
    }
    for (const chunk of chunkText(String(text))) {
      const uuid = randomUUID();
      await sendChunkWithRetry(() => withTimeout(
        createMessage.call(client.im.message, {
          params: { receive_id_type: recipient.receiveIdType },
          data: { receive_id: recipient.receiveId, msg_type: 'text', content: JSON.stringify({ text: chunk }), uuid },
        }),
        timeoutMs,
      ), { maxRetries, retryBaseMs, sleep });
    }
  }

  return sendText;
}

/** @param {{ request: (options: Record<string, unknown>) => Promise<unknown> }} httpInstance @param {number} timeoutMs */
export function createTimeoutHttpInstance(httpInstance, timeoutMs) {
  if (typeof httpInstance?.request !== 'function') {
    throw new Error('FEISHU_SEND_API_FAILED: HTTP client is unavailable');
  }
  const boundedTimeoutMs = normalizeSendTimeout(timeoutMs);
  return {
    request(requestOptions = {}) {
      return httpInstance.request(withHttpTimeout(requestOptions, boundedTimeoutMs));
    },
    get(url, requestOptions = {}) {
      return httpInstance.get(url, withHttpTimeout(requestOptions, boundedTimeoutMs));
    },
    delete(url, requestOptions = {}) {
      return httpInstance.delete(url, withHttpTimeout(requestOptions, boundedTimeoutMs));
    },
    head(url, requestOptions = {}) {
      return httpInstance.head(url, withHttpTimeout(requestOptions, boundedTimeoutMs));
    },
    options(url, requestOptions = {}) {
      return httpInstance.options(url, withHttpTimeout(requestOptions, boundedTimeoutMs));
    },
    post(url, data, requestOptions = {}) {
      return httpInstance.post(url, data, withHttpTimeout(requestOptions, boundedTimeoutMs));
    },
    put(url, data, requestOptions = {}) {
      return httpInstance.put(url, data, withHttpTimeout(requestOptions, boundedTimeoutMs));
    },
    patch(url, data, requestOptions = {}) {
      return httpInstance.patch(url, data, withHttpTimeout(requestOptions, boundedTimeoutMs));
    },
  };
}

/** @param {{ warn?: Function, error?: Function, info?: Function, debug?: Function, trace?: Function } | undefined} logger */
export function createSafeSdkLogger(logger) {
  return {
    error() {
      writeSafeLog(logger, 'error');
    },
    warn() {
      writeSafeLog(logger, 'warn');
    },
    info() {
      writeSafeLog(logger, 'info');
    },
    debug() {
      writeSafeLog(logger, 'debug');
    },
    trace() {
      writeSafeLog(logger, 'trace');
    },
  };
}

/** @param {string} home @param {unknown} stateFile */
export function resolveStatePath(home, stateFile) {
  if (typeof home !== 'string' || !isAbsolute(home) || typeof stateFile !== 'string' || stateFile.trim() === '' || isAbsolute(stateFile)) {
    throw new Error('FEISHU_CONFIG_INVALID: stateFile must be a relative path inside DSH_HOME/cache');
  }
  let trustedHome;
  try {
    const homeStats = statSync(home);
    if (!homeStats.isDirectory()) throw new Error('home is not a directory');
    trustedHome = realpathSync(home);
  } catch {
    throw new Error('FEISHU_CONFIG_INVALID: DSH_HOME is unavailable');
  }
  const cacheDir = resolve(trustedHome, 'cache');
  const statePath = resolve(cacheDir, stateFile);
  const relativePath = relative(cacheDir, statePath);
  if (relativePath === '..' || relativePath.startsWith('..' + sep) || isAbsolute(relativePath)) {
    throw new Error('FEISHU_CONFIG_INVALID: stateFile must stay inside DSH_HOME/cache');
  }
  try {
    assertSafeStatePath(cacheDir, statePath);
  } catch {
    throw new Error('FEISHU_CONFIG_INVALID: stateFile path contains an unsafe symbolic link or cache root');
  }
  return statePath;
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx cordis plugin context
 * @param {Record<string, unknown>} [userConfig] patch-layer config block
 */
export function apply(ctx, userConfig) {
  const { config, errors } = normalizeConfig(userConfig);
  if (errors.length > 0) {
    throw new Error(`FEISHU_CONFIG_INVALID: ${errors.join('; ')}`);
  }
  const home = process.env.DSH_HOME;
  const outputTargets = createOutputTargetRegistry(config.groupOutputMode);

  // --- credentials (kernel plane; resolved per operation, never printed) ---
  /** @param {string} ref */
  function credential(ref) {
    return resolveCredential(ctx.credentials, ref);
  }
  const sendText = createFeishuSender({
    resolveCredential: credential,
    appIdRef: config.appIdRef,
    appSecretRef: config.appSecretRef,
    maxQueueSize: config.maxOutboundQueue,
    resolveRecipient: (chatId) => outputTargets.get(chatId) ?? null,
    logger: ctx.logger,
  });
  const sdkLogger = createSafeSdkLogger(ctx.logger);

  if (!home) {
    // Never break profile composition over a missing environment — degrade.
    ctx.logger?.warn?.('feishu-channel: $DSH_HOME is not set; channel disabled');
    const bindings = createVolatileSessionMap();
    const driver = createDisabledDriver(bindings);
    const approvalBridge = createApprovalBridge({
      timeoutMs: config.approvalTimeoutMs,
      sendApproval: sendText,
    });
    const progressRelay = createProgressRelay({
      getChatId: () => undefined,
      sendText,
      minIntervalMs: config.progressIntervalMs,
      maxMessages: config.maxProgressMessages,
    });
    const router = createMessageRouter({
      config: { ...config, dshHomeAvailable: false },
      bindings,
      projectPolicy: createProjectPolicy(config.allowedProjectRoots),
      driver,
      approvalBridge,
      progressRelay,
      sendText,
      setOutputTarget: (chatId, target) => outputTargets.set(chatId, target),
      logger: ctx.logger,
    });
    ctx.effect(() => () => {
      router.close?.();
      driver.dispose?.();
      approvalBridge.close();
      progressRelay.close();
      outputTargets.clear();
    }, name);
    return { handleMessage: router.handleMessage, config, router };
  }

  const statePath = resolveStatePath(home, config.stateFile);
  const trustedHome = realpathSync(home);
  const bindings = createIndexedBindings(createSessionMap(statePath, { safeRoot: resolve(trustedHome, 'cache') }));
  const projectPolicy = createProjectPolicy(config.allowedProjectRoots);
  const approvalBridge = createApprovalBridge({
    timeoutMs: config.approvalTimeoutMs,
    sendApproval: sendText,
  });
  const progressRelay = createProgressRelay({
    getChatId: (sessionId) => bindings.chatIdForSession(sessionId),
    sendText,
    minIntervalMs: config.progressIntervalMs,
    maxMessages: config.maxProgressMessages,
  });
  const driver = createAgentDriver(ctx, { bindings, config, approvalBridge, projectPolicy, progressRelay });
  const router = createMessageRouter({
    config: { ...config, dshHomeAvailable: true },
    bindings,
    projectPolicy,
    driver,
    approvalBridge,
    progressRelay,
    sendText,
    setOutputTarget: (chatId, target) => outputTargets.set(chatId, target),
    logger: ctx.logger,
  });

  const disposeSessionEvent = ctx.on?.('session/event', progressRelay.onSessionEvent) ?? (() => {});

  // --- long connection bootstrap ---
  let wsClient;
  ctx.effect(() => {
    let stopped = false;
    (async () => {
      const appId = await credential(config.appIdRef);
      const appSecret = await credential(config.appSecretRef);
      if (!appId || !appSecret) {
        ctx.logger?.warn?.(
          `feishu-channel: credentials '${config.appIdRef}'/'${config.appSecretRef}' are not configured; channel idle`,
        );
        return;
      }
      if (stopped) return;
      const eventDispatcher = new EventDispatcher({ logger: sdkLogger, loggerLevel: 1 }).register({
          'im.message.receive_v1': async (data) => {
            try {
              const message = data?.message ?? {};
              await router.handleMessage(
                {
                  eventId: extractEventId(data),
                  chatId: message.chat_id,
                  openId: data?.sender?.sender_id?.open_id,
                  chatType: message.chat_type,
                  text: extractText(message.content),
                },
              );
            } catch (error) {
              const message = sanitizeTraceError(error);
              ctx.logger?.warn?.(`feishu-channel: event handling failed: ${message}`);
            }
          },
        });
      wsClient = new WSClient({
        appId,
        appSecret,
        logger: sdkLogger,
        loggerLevel: 1,
        onReady() {
          if (stopped) return;
          ctx.logger?.info?.('feishu-channel: long connection established');
        },
        onError(error) {
          if (stopped) return;
          ctx.logger?.warn?.(`feishu-channel: long connection failed: ${sanitizeTraceError(error)}`);
        },
      });
      await wsClient.start({ eventDispatcher });
      if (stopped) {
        wsClient.close({ force: true });
        wsClient = undefined;
      }
    })().catch((error) => {
      const message = sanitizeTraceError(error);
      ctx.logger?.warn?.(`feishu-channel: startup failed: ${message}`);
    });
    return () => {
      stopped = true;
      router.close?.();
      void driver.dispose?.();
      wsClient?.close({ force: true });
      wsClient = undefined;
      approvalBridge.close();
      progressRelay.close();
      outputTargets.clear();
      disposeSessionEvent();
    };
  }, name);

  return { handleMessage: router.handleMessage, config, router };
}

/** Extract plain text from im.message.content JSON. @param {string} content */
function extractText(content) {
  try {
    const parsed = JSON.parse(content ?? '{}');
    return typeof parsed.text === 'string' ? parsed.text.trim() : '';
  } catch {
    return '';
  }
}

export function createIndexedBindings(bindings) {
  const sessionToChat = new Map();
  for (const entry of bindings.entries?.() ?? []) {
    if (!Array.isArray(entry)) continue;
    const [chatId, binding] = entry;
    if (typeof chatId === 'string' && binding?.sessionId) {
      assertSessionIndexAvailable(sessionToChat, binding.sessionId, chatId);
      sessionToChat.set(binding.sessionId, chatId);
    }
  }
  return {
    get(chatId) {
      const binding = bindings.get(chatId);
      if (binding?.sessionId) sessionToChat.set(binding.sessionId, chatId);
      return binding;
    },
    entries() {
      return bindings.entries?.() ?? [];
    },
    bind(chatId, binding) {
      const previous = bindings.get(chatId);
      if (binding?.sessionId) {
        assertSessionIndexAvailable(sessionToChat, binding.sessionId, chatId);
      }
      bindings.bind(chatId, binding);
      if (previous?.sessionId && previous.sessionId !== binding?.sessionId) {
        sessionToChat.delete(previous.sessionId);
      }
      if (binding?.sessionId) sessionToChat.set(binding.sessionId, chatId);
    },
    clearSession(chatId) {
      const previous = bindings.get(chatId);
      const changed = bindings.clearSession(chatId);
      if (changed && previous?.sessionId) sessionToChat.delete(previous.sessionId);
      return changed;
    },
    unbind(chatId) {
      const previous = bindings.get(chatId);
      const changed = bindings.unbind(chatId);
      if (changed && previous?.sessionId) sessionToChat.delete(previous.sessionId);
      return changed;
    },
    clear() {
      const count = bindings.clear();
      sessionToChat.clear();
      return count;
    },
    chatIdForSession(sessionId) {
      return sessionToChat.get(sessionId);
    },
  };
}

function assertSessionIndexAvailable(sessionToChat, sessionId, chatId) {
  const existingChatId = sessionToChat.get(sessionId);
  if (existingChatId && existingChatId !== chatId) {
    throw new Error('FEISHU_SESSION_ALREADY_BOUND: session is already bound to another chat');
  }
}

function createVolatileSessionMap() {
  const map = new Map();
  return createIndexedBindings({
    get(chatId) {
      const binding = map.get(chatId);
      return binding ? { ...binding, model: binding.model ? { ...binding.model } : undefined } : undefined;
    },
    entries() {
      return [...map.entries()].map(([chatId, binding]) => [
        chatId,
        { ...binding, model: binding.model ? { ...binding.model } : undefined },
      ]);
    },
    bind(chatId, binding) {
      map.set(chatId, { ...binding, model: binding.model ? { ...binding.model } : undefined });
    },
    clearSession(chatId) {
      const binding = map.get(chatId);
      if (!binding) return false;
      map.set(chatId, {
        projectPath: binding.projectPath,
        ...(binding.model ? { model: { ...binding.model } } : {}),
      });
      return true;
    },
    unbind(chatId) {
      return map.delete(chatId);
    },
    clear() {
      const count = map.size;
      map.clear();
      return count;
    },
  });
}

function createDisabledDriver(bindings) {
  return {
    enqueuePrompt() {
      throw new Error('FEISHU_DSH_HOME_MISSING: DSH_HOME is not configured');
    },
    cancel() {
      return Promise.resolve({ cancelled: false });
    },
    reset(chatId) {
      bindings.clearSession(chatId);
      return Promise.resolve({ cancelled: false });
    },
    status(chatId) {
      const binding = bindings.get(chatId);
      return {
        state: binding?.projectPath ? 'ready' : 'unconfigured',
        projectPath: binding?.projectPath,
        queueSize: 0,
        model: binding?.model,
      };
    },
  };
}

function sanitizeTraceError(error) {
  const raw = String(error?.message ?? error ?? '');
  return /^FEISHU_[A-Z0-9_]+(?::|\b)/.exec(raw.trim())?.[0].replace(/:$/, '') ?? 'FEISHU_RUNTIME_ERROR';
}

function normalizeSendTimeout(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_SEND_TIMEOUT_MS;
}

function normalizeRetryCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 5) : DEFAULT_SEND_MAX_RETRIES;
}

function normalizeRetryDelay(value) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, MAX_RETRY_DELAY_MS) : DEFAULT_RETRY_BASE_MS;
}

function normalizeQueueSize(value) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 2048) : 128;
}

function resolveSendRecipient(chatId, resolver) {
  const candidate = typeof resolver === 'function' ? resolver(chatId) : undefined;
  if (candidate === null) return undefined;
  if (candidate === undefined) {
    return { receiveId: chatId, receiveIdType: 'chat_id' };
  }
  if (candidate && typeof candidate.receiveId === 'string' && candidate.receiveId.trim()
    && (candidate.receiveIdType === 'chat_id' || candidate.receiveIdType === 'open_id')) {
    return { receiveId: candidate.receiveId, receiveIdType: candidate.receiveIdType };
  }
  throw createFeishuError('FEISHU_SEND_TARGET_INVALID');
}

function createOutputTargetRegistry(mode) {
  const targets = new Map();
  return {
    set(chatId, { chatType, openId } = {}) {
      if (typeof chatId !== 'string' || chatId.trim() === '') return;
      if (chatType === 'group' && mode === 'sender') {
        if (typeof openId === 'string' && openId.trim()) {
          targets.set(chatId, { receiveId: openId.trim(), receiveIdType: 'open_id' });
        }
        return;
      }
      targets.set(chatId, { receiveId: chatId, receiveIdType: 'chat_id' });
    },
    get(chatId) {
      return targets.get(chatId);
    },
    clear() {
      targets.clear();
    },
  };
}

async function sendChunkWithRetry(operation, { maxRetries, retryBaseMs, sleep }) {
  for (let retry = 0; ; retry += 1) {
    try {
      const response = await operation();
      assertFeishuApiSuccess(response);
      return;
    } catch (error) {
      if (!isRetryableSendError(error) || retry >= maxRetries) throw normalizeSendFailure(error);
      const retryAfterMs = getRetryAfterMs(error);
      const exponentialDelay = Math.min(MAX_RETRY_DELAY_MS, retryBaseMs * (2 ** retry));
      await sleep(retryAfterMs ?? exponentialDelay);
    }
  }
}

function isRetryableSendError(error) {
  if (error?.feishuCode === 'FEISHU_SEND_TIMEOUT') return true;
  const status = error?.status ?? error?.response?.status;
  if (status === 429 || (Number.isInteger(status) && status >= 500)) return true;
  return new Set([
    'ECONNABORTED',
    'ECONNRESET',
    'ECONNREFUSED',
    'EAI_AGAIN',
    'ENETDOWN',
    'ENETUNREACH',
    'EPIPE',
    'ETIMEDOUT',
    'ERR_NETWORK',
  ]).has(error?.code);
}

function getRetryAfterMs(error) {
  const headers = error?.headers ?? error?.response?.headers;
  if (!headers) return undefined;
  let value;
  if (typeof headers.get === 'function') value = headers.get('retry-after');
  if (value === undefined && typeof headers === 'object') {
    value = headers['retry-after'] ?? headers['Retry-After'];
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.min(MAX_RETRY_DELAY_MS, Math.round(value * 1000));
  }
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_RETRY_DELAY_MS, Math.round(seconds * 1000));
  }
  const timestamp = Date.parse(value);
  if (!Number.isNaN(timestamp)) return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, timestamp - Date.now()));
  return undefined;
}

function normalizeSendFailure(error) {
  if (error?.feishuCode === 'FEISHU_SEND_TIMEOUT' || error?.feishuCode === 'FEISHU_SEND_API_FAILED') {
    return error;
  }
  const normalized = createFeishuError('FEISHU_SEND_FAILED');
  if (typeof error?.apiCode === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(error.apiCode)) {
    normalized.apiCode = error.apiCode;
  }
  return normalized;
}

function sleepFor(delayMs) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, delayMs);
  });
}

function writeSafeLog(logger, level) {
  const messages = {
    error: 'feishu-channel: Feishu SDK error',
    warn: 'feishu-channel: Feishu SDK warning',
    info: 'feishu-channel: Feishu SDK info',
    debug: 'feishu-channel: Feishu SDK debug',
    trace: 'feishu-channel: Feishu SDK trace',
  };
  const targetLevel = level === 'error' && typeof logger?.warn === 'function' ? 'warn' : level;
  const target = typeof logger?.[targetLevel] === 'function'
    ? logger[targetLevel]
    : logger?.warn;
  target?.call(logger, messages[level]);
}

function withHttpTimeout(requestOptions, timeoutMs) {
  return { ...(requestOptions ?? {}), timeout: timeoutMs };
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(createFeishuError('FEISHU_SEND_TIMEOUT')), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function assertFeishuApiSuccess(response) {
  if (response && (response.code === 0 || response.code === '0')) return;
  const apiCode = safeApiCode(response?.code);
  const error = createFeishuError('FEISHU_SEND_API_FAILED', `api_code=${apiCode}`, apiCode);
  error.status = response?.status;
  error.headers = response?.headers;
  throw error;
}

function createFeishuError(code, detail, apiCode) {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.feishuCode = code;
  if (apiCode !== undefined) error.apiCode = apiCode;
  return error;
}

function safeApiCode(value) {
  if (Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value)) return value;
  return 'unknown';
}
