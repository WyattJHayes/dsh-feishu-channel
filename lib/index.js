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
import { WSClient, Client as LarkClient, defaultHttpInstance } from '@larksuiteoapi/node-sdk';
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

export const inject = ['credentials', 'agents', 'agentDefaultModel', 'agentPresets'];
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
 *   logger?: { warn?: (message: string) => void },
 *   clientFactory?: (credentials: { appId: string, appSecret: string, timeoutMs: number }) => unknown,
 *   httpInstance?: { request: (options: Record<string, unknown>) => Promise<unknown> },
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
  const httpInstance = options.httpInstance ?? defaultHttpInstance;
  const clientFactory = options.clientFactory ?? ((credentials) => new LarkClient({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    httpInstance: createTimeoutHttpInstance(httpInstance, credentials.timeoutMs),
  }));
  let sendQueue = Promise.resolve();

  function sendText(chatId, text) {
    const task = sendQueue.then(() => sendTextNow(chatId, text));
    sendQueue = task.catch(() => undefined);
    return task;
  }

  async function sendTextNow(chatId, text) {
    const appId = await resolveValue(appIdRef);
    const appSecret = await resolveValue(appSecretRef);
    if (!appId || !appSecret) {
      options.logger?.warn?.('feishu-channel: app credentials are not configured; outbound message skipped');
      return;
    }
    const client = await clientFactory({ appId, appSecret, timeoutMs });
    const createMessage = client?.im?.message?.create;
    if (typeof createMessage !== 'function') {
      throw createFeishuError('FEISHU_SEND_API_FAILED', 'message.create is unavailable');
    }
    for (const chunk of chunkText(String(text))) {
      const response = await withTimeout(
        createMessage.call(client.im.message, {
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: chunk }) },
        }),
        timeoutMs,
      );
      assertFeishuApiSuccess(response);
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

  // --- credentials (kernel plane; resolved per operation, never printed) ---
  /** @param {string} ref */
  function credential(ref) {
    return resolveCredential(ctx.credentials, ref);
  }
  const sendText = createFeishuSender({
    resolveCredential: credential,
    appIdRef: config.appIdRef,
    appSecretRef: config.appSecretRef,
    logger: ctx.logger,
  });

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
      logger: ctx.logger,
    });
    ctx.effect(() => () => {
      router.close?.();
      driver.dispose?.();
      approvalBridge.close();
      progressRelay.close();
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
      wsClient = new WSClient({ appId, appSecret, loggerLevel: 1 });
      await wsClient.start({
        eventDispatcher: new (await import('@larksuiteoapi/node-sdk')).EventDispatcher({}).register({
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
        }),
      });
      if (stopped) {
        wsClient.close({ force: true });
        wsClient = undefined;
        return;
      }
      ctx.logger?.info?.('feishu-channel: long connection established');
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

function createIndexedBindings(bindings) {
  const sessionToChat = new Map();
  return {
    get(chatId) {
      const binding = bindings.get(chatId);
      if (binding?.sessionId) sessionToChat.set(binding.sessionId, chatId);
      return binding;
    },
    bind(chatId, binding) {
      const previous = bindings.get(chatId);
      if (previous?.sessionId) sessionToChat.delete(previous.sessionId);
      bindings.bind(chatId, binding);
      if (binding?.sessionId) sessionToChat.set(binding.sessionId, chatId);
    },
    clearSession(chatId) {
      const previous = bindings.get(chatId);
      if (previous?.sessionId) sessionToChat.delete(previous.sessionId);
      return bindings.clearSession(chatId);
    },
    unbind(chatId) {
      const previous = bindings.get(chatId);
      if (previous?.sessionId) sessionToChat.delete(previous.sessionId);
      return bindings.unbind(chatId);
    },
    clear() {
      sessionToChat.clear();
      return bindings.clear();
    },
    chatIdForSession(sessionId) {
      return sessionToChat.get(sessionId);
    },
  };
}

function createVolatileSessionMap() {
  const map = new Map();
  return createIndexedBindings({
    get(chatId) {
      const binding = map.get(chatId);
      return binding ? { ...binding, model: binding.model ? { ...binding.model } : undefined } : undefined;
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
  throw createFeishuError('FEISHU_SEND_API_FAILED', `api_code=${apiCode}`, apiCode);
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
