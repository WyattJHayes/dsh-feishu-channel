import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPromptQueue } from './prompt-queue.js';
import { createRiskListener } from './risk-policy.js';
import { truncateText } from './commands.js';

const REMOTE_PERMISSION_PRESET = 'workspace-write';
const REMOTE_APPROVAL_MODE = 'ask';
const DEFAULT_AGENT_OPERATION_TIMEOUT_MS = 30000;
const DEFAULT_APPROVAL_TIMEOUT_MS = 600000;
const DEFAULT_WHEN_IDLE_TIMEOUT_MS = 600000;
const MAX_AGENT_IDLE_TIMEOUT_MS = 3600000;
const DEFAULT_CANCEL_TIMEOUT_MS = 10000;
const IDLE_WAIT_CANCELLED = Symbol('idle-wait-cancelled');

/** Create a globally unique session id for a new Feishu chat binding. */
export function createAgentSessionId() {
  return `feishu-session-${randomUUID()}`;
}

/** @param {{ agent?: { id?: string }, sessionId?: string, id?: string } | undefined} handle */
export function getAgentSessionId(handle) {
  return handle?.agent?.id ?? handle?.sessionId ?? handle?.id;
}

/** @param {{ agent?: { session?: { id?: string }, id?: string }, session?: { id?: string }, sessionId?: string } | undefined} exec */
function getExecutionSessionId(exec) {
  return exec?.agent?.session?.id ?? exec?.agent?.id ?? exec?.session?.id ?? exec?.sessionId;
}

/** @param {{ provider: string, model: string }} selection */
export function createAgentOptions(selection) {
  return { provider: selection.provider, model: selection.model };
}

/** @param {string | undefined} agentPreset @param {string} cwd */
export function createAgentMeta(agentPreset, cwd) {
  return {
    cwd,
    ...(agentPreset ? { agentPreset } : {}),
  };
}

/** @param {{ sessionId?: string } | undefined} binding @param {(sessionId: string) => object | undefined} getAgent */
export function getLiveAgentSessionId(binding, getAgent) {
  if (!binding?.sessionId || typeof getAgent !== 'function') return undefined;
  return getAgent(binding.sessionId) ? binding.sessionId : undefined;
}

/**
 * Keep prompt assembly variables and request routing aligned with one Agent model.
 * @param {{ on: Function }} agentCtx
 * @param {{ current?: { provider: string, model: string, reasoningEffort?: string }, assembled?: object }} selection
 */
export function installAgentModelSelection(agentCtx, selection) {
  const disposeAssembly = agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const selected = selection.current;
    const assembled = await next();
    selection.assembled = selected;
    if (selected === undefined) return assembled;
    return {
      ...assembled,
      variables: {
        ...assembled.variables,
        provider: selected.provider,
        model: selected.model,
      },
    };
  });
  const disposeRequest = agentCtx.on('agent/request', async (_payload, next) => {
    const resolved = await next();
    const selected = selection.assembled;
    if (selected === undefined) return resolved;
    const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved;
    return {
      ...withoutInheritedEffort,
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
    };
  });
  return () => {
    disposeAssembly();
    disposeRequest();
  };
}

/** @param {{ on: Function, agent?: { session?: { events?: unknown[] } } }} agentCtx @param {{ selection?: object, approvalBridge?: object, projectPath?: string, chatId?: string, recipient?: object | null, getRecipient?: (sessionId: string) => object | null | undefined, agentPreset?: string | null, agentPresets?: { mount: Function }, permissionPresets?: { apply: Function, current: Function } } | object} options */
export async function createAgentSetup(agentCtx, options) {
  const selection = options?.selection ?? options;
  const isActive = (sessionId) => {
    if (typeof options?.isActive !== 'function') return true;
    try {
      return options.isActive(sessionId) === true;
    } catch {
      return false;
    }
  };
  if (typeof options?.agentPresets?.mount !== 'function') {
    throw new Error('FEISHU_NO_AGENT_PRESETS_SERVICE: ctx.agentPresets is unavailable');
  }
  await options.agentPresets.mount(agentCtx, options.agentPreset ?? undefined);
  await applyRemotePermission(agentCtx, options?.permissionPresets);
  installAgentModelSelection(agentCtx, selection);

  if (options?.approvalBridge && options?.projectPath) {
    agentCtx.on('tools/pre-execute', createRiskListener({
      projectPath: options.projectPath,
      remember: (exec, summary) => {
        if (isActive(getExecutionSessionId(exec))) options.approvalBridge.remember(exec, summary);
      },
    }));
    const approvalListener = options.approvalBridge.createListener(
      (sessionId) => isActive(sessionId) ? options.chatId : undefined,
      (sessionId) => isActive(sessionId) ? options.getRecipient?.(sessionId) ?? options.recipient : undefined,
    );
    agentCtx.on('approval/request', async (exec, next) => {
      if (!isActive(getExecutionSessionId(exec))) return 'unavailable';
      return approvalListener(exec, next);
    }, { prepend: true });
  }
}

async function applyRemotePermission(agentCtx, permissionPresets) {
  if (typeof permissionPresets?.apply !== 'function' || typeof permissionPresets?.current !== 'function') {
    throw new Error('FEISHU_NO_PERMISSION_PRESETS_SERVICE: ctx.permissionPresets is unavailable');
  }
  const session = agentCtx?.agent?.session;
  if (!session || !Array.isArray(session.events)) {
    throw new Error('FEISHU_REMOTE_PERMISSION_FAILED: Agent session events are unavailable');
  }
  if (typeof session.append !== 'function') {
    throw new Error('FEISHU_REMOTE_PERMISSION_FAILED: Agent session append is unavailable');
  }

  try {
    await permissionPresets.apply(session, REMOTE_PERMISSION_PRESET, (policy) => {
      if (policy !== REMOTE_APPROVAL_MODE) {
        throw new Error('remote approval policy is not ask');
      }
      session.append('approval/policy', { policy });
    });
    const current = await permissionPresets.current(session.events);
    if (!isRemotePermissionSafe(current)) {
      throw new Error('permission state is not restricted');
    }
    if (!hasLatestRemoteApprovalPolicy(session.events)) {
      session.append('approval/policy', { policy: REMOTE_APPROVAL_MODE });
    }
    if (!hasLatestRemoteApprovalPolicy(session.events)) {
      throw new Error('approval policy was not recorded');
    }
  } catch (error) {
    if (String(error?.message ?? '').startsWith('FEISHU_REMOTE_PERMISSION_FAILED')) throw error;
    throw new Error('FEISHU_REMOTE_PERMISSION_FAILED: unable to apply workspace-write with approval');
  }
}

async function verifyRemotePermission(session, permissionPresets) {
  if (typeof permissionPresets?.current !== 'function' || !session || !Array.isArray(session.events)) {
    throw new Error('FEISHU_REMOTE_PERMISSION_FAILED: unable to verify the live Agent permission');
  }
  try {
    const current = await permissionPresets.current(session.events);
    if (!isRemotePermissionSafe(current) || !hasLatestRemoteApprovalPolicy(session.events)) {
      throw new Error('permission state is not restricted');
    }
  } catch (error) {
    if (String(error?.message ?? '').startsWith('FEISHU_REMOTE_PERMISSION_FAILED')) throw error;
    throw new Error('FEISHU_REMOTE_PERMISSION_FAILED: live Agent permission is not workspace-write with approval');
  }
}

function isRemotePermissionSafe(state) {
  return state === REMOTE_PERMISSION_PRESET;
}

function hasLatestRemoteApprovalPolicy(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'approval/policy') return event.data?.policy === REMOTE_APPROVAL_MODE;
  }
  return false;
}

/** @param {string} text */
export function createAgentUserMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  };
}

/** @param {{ content?: Array<{ type?: string, text?: unknown }> } | undefined} message @param {number | undefined} maxLength */
export function extractAssistantText(message, maxLength = 12000) {
  if (!Array.isArray(message?.content)) return '';
  const limit = normalizeOutputLength(maxLength);
  const prefix = [];
  const trailingWhitespace = [];
  let started = false;

  for (const block of message.content) {
    if (block?.type !== 'text') continue;
    const blockText = block.text;
    if (typeof blockText !== 'string') continue;

    for (const codePoint of blockText) {
      if (isTrimWhitespace(codePoint)) {
        if (started && trailingWhitespace.length < limit) trailingWhitespace.push(codePoint);
        continue;
      }

      started = true;
      if (trailingWhitespace.length > 0) {
        for (const whitespace of trailingWhitespace) {
          if (prefix.length >= limit) return truncateText(`${prefix.join('')}x`, limit);
          prefix.push(whitespace);
        }
        trailingWhitespace.length = 0;
      }
      if (prefix.length >= limit) return truncateText(`${prefix.join('')}x`, limit);
      prefix.push(codePoint);
    }
  }

  return prefix.join('');
}

/**
 * @param {Array<{ seq?: number, type?: string, data?: any }>} events
 * @param {number} startSeq
 * @param {number | undefined} expectedTurn
 * @param {number | undefined} maxOutputLength
 */
export function getAgentTurnResult(events, startSeq, expectedTurn, maxOutputLength) {
  if (!Array.isArray(events) || !Number.isSafeInteger(expectedTurn)) return { kind: 'pending' };
  let turnEnd;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (typeof event?.seq !== 'number' || !(event.seq >= startSeq)) continue;
    if (event.type === 'turn/end' && event.data?.turn === expectedTurn) {
      turnEnd = event;
      break;
    }
  }
  if (!turnEnd) return { kind: 'pending' };

  const turn = turnEnd.data?.turn;
  let assistant;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (typeof event?.seq !== 'number' || !(event.seq >= startSeq)) continue;
    if (event.type === 'assistant/message' && event.data?.turn === turn) {
      assistant = event;
      break;
    }
  }
  const text = extractAssistantText(assistant?.data?.message, maxOutputLength);
  if (text) return { kind: 'text', text };

  const reason = turnEnd.data?.reason;
  if (reason?.kind === 'error') {
    return { kind: 'error', message: String(reason.error?.message ?? 'Agent 回合失败') };
  }
  if (reason?.kind === 'aborted') return { kind: 'error', message: 'Agent 回合已中止' };
  if (reason?.kind === 'blocked') return { kind: 'error', message: 'Agent 回合被阻止' };
  return { kind: 'empty' };
}

/** @param {import('@deepseek-ai/cordis').Context} ctx @param {{ bindings: object, config?: object, approvalBridge?: object, projectPolicy?: object, progressRelay?: object }} options */
export function createAgentDriver(ctx, options) {
  const bindings = options.bindings;
  const config = options.config ?? {};
  const approvalBridge = options.approvalBridge;
  const projectPolicy = options.projectPolicy;
  const progressRelay = options.progressRelay;
  const agentOperationTimeoutMs = boundedTimeout(
    config.agentOperationTimeoutMs ?? config.agentTimeoutMs,
    DEFAULT_AGENT_OPERATION_TIMEOUT_MS,
  );
  const approvalTimeoutMs = boundedTimeout(
    config.approvalTimeoutMs,
    DEFAULT_APPROVAL_TIMEOUT_MS,
    MAX_AGENT_IDLE_TIMEOUT_MS,
  );
  const whenIdleTimeoutMs = Math.max(
    boundedTimeout(config.whenIdleTimeoutMs, DEFAULT_WHEN_IDLE_TIMEOUT_MS, MAX_AGENT_IDLE_TIMEOUT_MS),
    approvalTimeoutMs,
  );
  const cancelTimeoutMs = boundedTimeout(config.cancelTimeoutMs, DEFAULT_CANCEL_TIMEOUT_MS);
  const maxQueuedPrompts = Number.isSafeInteger(config.maxQueuedPrompts) && config.maxQueuedPrompts > 0
    ? Math.min(config.maxQueuedPrompts, 100)
    : undefined;
  const queues = new Map();
  const activeRuns = new Map();
  const lastStates = new Map();
  const ownedHandles = new Map();
  const managedSessions = new Set();
  const generations = new Map();
  const resetBarriers = new Map();
  const taintedSessions = new Set();
  const sessionRecipients = new Map();
  let disposed = false;

  function agents() {
    if (!ctx.agents) throw new Error('FEISHU_NO_AGENTS_SERVICE: ctx.agents is unavailable');
    return ctx.agents;
  }

  function queueFor(chatId) {
    let queue = queues.get(chatId);
    if (!queue) {
      queue = createPromptQueue({ maxQueued: maxQueuedPrompts });
      queues.set(chatId, queue);
    }
    return queue;
  }

  function generationFor(chatId) {
    return generations.get(chatId) ?? 0;
  }

  function bumpGeneration(chatId) {
    const next = generationFor(chatId) + 1;
    generations.set(chatId, next);
    return next;
  }

  function isCurrentGeneration(chatId, generation) {
    return generationFor(chatId) === generation;
  }

  function isSessionActive(sessionId) {
    if (typeof sessionId !== 'string' || disposed || !sessionRecipients.has(sessionId)) return false;
    for (const run of activeRuns.values()) {
      if (run.sessionId === sessionId && !run.cancelRequested && isCurrentGeneration(run.chatId, run.generation)) {
        return true;
      }
    }
    return false;
  }

  function isRunCancelled(run) {
    return run.cancelRequested || disposed || !isCurrentGeneration(run.chatId, run.generation);
  }

  function validateBinding(chatId) {
    const binding = bindings.get(chatId);
    if (!binding?.projectPath) {
      lastStates.set(chatId, 'unconfigured');
      throw new Error('FEISHU_PROJECT_UNCONFIGURED: bind a project before creating an Agent');
    }
    if (typeof projectPolicy?.resolve !== 'function') return binding;

    let resolved;
    try {
      resolved = projectPolicy.resolve(binding.projectPath);
    } catch {
      resolved = { ok: false };
    }
    if (!resolved?.ok || typeof resolved.path !== 'string') {
      lastStates.set(chatId, 'failed');
      throw new Error('FEISHU_PROJECT_BINDING_INVALID: persisted project is no longer allowed');
    }
    if (resolved.path === binding.projectPath) return binding;

    const next = { ...binding, projectPath: resolved.path };
    bindings.bind(chatId, next);
    return next;
  }

  function currentSelection() {
    const agentDefaultModel = ctx.agentDefaultModel;
    if (!agentDefaultModel?.currentSelection) {
      throw new Error('FEISHU_NO_DEFAULT_MODEL_SERVICE: ctx.agentDefaultModel is unavailable');
    }
    const selection = agentDefaultModel.currentSelection();
    return assertSelection(selection);
  }

  function assertSelection(selection) {
    if (!selection?.provider || !selection?.model) {
      throw new Error('FEISHU_DEFAULT_MODEL_INVALID: provider and model are required');
    }
    return selection;
  }

  function selectionFor(binding) {
    return binding.model ? assertSelection(binding.model) : currentSelection();
  }

  function createSetup(chatId, binding, selection, recipient) {
    const modelSelection = { current: selection, assembled: undefined };
    return async (agentCtx) => {
      await createAgentSetup(agentCtx, {
        chatId,
        recipient,
        getRecipient: (sessionId) => sessionRecipients.get(sessionId)?.recipient,
        isActive: isSessionActive,
        projectPath: binding.projectPath,
        selection: modelSelection,
        approvalBridge,
        agentPreset: config.agentPreset,
        agentPresets: ctx.agentPresets,
        permissionPresets: ctx.permissionPresets,
      });
    };
  }

  async function ensureSession(chatId, expectedGeneration = generationFor(chatId), ownerRun, recipient) {
    if (!isCurrentGeneration(chatId, expectedGeneration) || disposed) {
      throw createCancellationError();
    }
    const binding = validateBinding(chatId);
    const expectedProjectPath = binding.projectPath;

    const service = agents();
    if (binding.sessionId && taintedSessions.has(binding.sessionId)) {
      lastStates.set(chatId, 'failed');
      throw new Error('FEISHU_AGENT_UNAVAILABLE: the bound Agent requires /new before reuse');
    }
    const liveSessionId = getLiveAgentSessionId(binding, (sessionId) => service.get?.(sessionId));
    if (liveSessionId) {
      if (!managedSessions.has(liveSessionId)) {
        lastStates.set(chatId, 'failed');
        throw new Error('FEISHU_AGENT_UNAVAILABLE: live Agent is not managed by Feishu; use /new');
      }
      const liveAgent = service.get?.(liveSessionId);
      assertAgentSessionCwd(liveAgent, expectedProjectPath, projectPolicy);
      await verifyRemotePermission(liveAgent?.session, ctx.permissionPresets);
      return liveSessionId;
    }

    const selection = selectionFor(binding);
    if (binding.sessionId) {
      if (typeof service.resume !== 'function') {
        throw new Error('FEISHU_NO_AGENTS_SERVICE: ctx.agents.resume is unavailable');
      }
      let handle;
      const operation = Promise.resolve().then(() => service.resume({
          resumeSessionId: binding.sessionId,
          agentOptions: selection,
          setup: createSetup(chatId, binding, selection, recipient),
        }));
      try {
        handle = await awaitWithTimeout(
          operation,
          agentOperationTimeoutMs,
          createDriverError('FEISHU_SESSION_RESUME_TIMEOUT'),
          (lateHandle) => disposeHandle(lateHandle),
        );
      } catch (error) {
        if (isCancellationError(error)) throw error;
        clearTaintIfSessionNotLive(binding.sessionId, service);
        lastStates.set(chatId, 'failed');
        throw new Error('FEISHU_SESSION_RESUME_FAILED: unable to resume the bound session');
      }
      const sessionId = getAgentSessionId(handle);
      if (!sessionId) {
        await disposeHandle(handle);
        throw new Error('FEISHU_SESSION_RESUME_FAILED: no session id returned');
      }
      if (sessionId !== binding.sessionId) {
        await disposeHandle(handle);
        throw new Error('FEISHU_SESSION_RESUME_FAILED: resumed session id mismatch');
      }
      try {
        assertAgentSessionCwd(handle?.agent, expectedProjectPath, projectPolicy);
      } catch (error) {
        await disposeHandle(handle);
        throw error;
      }
      if (!isCurrentGeneration(chatId, expectedGeneration) || disposed) {
        await discardStaleSession(sessionId, handle, ownerRun);
        throw createCancellationError();
      }
      managedSessions.add(sessionId);
      rememberOwnedHandle(sessionId, handle);
      lastStates.set(chatId, 'idle');
      return sessionId;
    }

    if (typeof service.create !== 'function') {
      throw new Error('FEISHU_NO_AGENTS_SERVICE: ctx.agents.create is unavailable');
    }
    let handle;
    const operation = Promise.resolve().then(() => service.create({
        sessionId: createAgentSessionId(),
        agentOptions: createAgentOptions(selection),
        meta: createAgentMeta(config.agentPreset, binding.projectPath),
        setup: createSetup(chatId, binding, selection, recipient),
      }));
    try {
      handle = await awaitWithTimeout(
        operation,
        agentOperationTimeoutMs,
        createDriverError('FEISHU_SESSION_CREATE_TIMEOUT'),
        (lateHandle) => disposeHandle(lateHandle),
      );
    } catch (error) {
      if (isCancellationError(error)) throw error;
      lastStates.set(chatId, 'failed');
      throw new Error('FEISHU_SESSION_CREATE_FAILED: unable to create an Agent session');
    }
    const sessionId = getAgentSessionId(handle);
    if (!sessionId) {
      await disposeHandle(handle);
      throw new Error('FEISHU_SESSION_CREATE_FAILED: no session id returned');
    }
    try {
      assertAgentSessionCwd(handle?.agent, expectedProjectPath, projectPolicy);
    } catch (error) {
      await disposeHandle(handle);
      throw error;
    }
    if (!isCurrentGeneration(chatId, expectedGeneration) || disposed) {
      await discardStaleSession(sessionId, handle, ownerRun);
      throw createCancellationError();
    }
    managedSessions.add(sessionId);
    rememberOwnedHandle(sessionId, handle);
    try {
      bindings.bind(chatId, {
        projectPath: binding.projectPath,
        sessionId,
        model: selection,
      });
    } catch {
      await disposeOwnedSession(sessionId);
      throw new Error('FEISHU_SESSION_CREATE_FAILED: unable to persist the Agent session');
    }
    lastStates.set(chatId, 'idle');
    return sessionId;
  }

  async function runPrompt(chatId, text, generation, recipient) {
    let finishRun;
    const run = {
      chatId,
      generation,
      agent: undefined,
      sessionId: undefined,
      startSeq: 0,
      cancelRequested: false,
      cancelIssued: false,
      cancelPromise: undefined,
      followupSettled: false,
      idleConfirmed: false,
      claimedTurns: new Map(),
      disposeAgentListener: undefined,
      whenCancelled: undefined,
      notifyCancelled: undefined,
      done: new Promise((resolve) => {
        finishRun = resolve;
      }),
    };
    run.whenCancelled = new Promise((resolve) => {
      run.notifyCancelled = resolve;
    });
    activeRuns.set(chatId, run);
    lastStates.set(chatId, 'running');
    try {
      if (isRunCancelled(run)) return { kind: 'cancelled' };
      const sessionId = await ensureSession(chatId, generation, run, recipient);
      run.sessionId = sessionId;
      setSessionRecipient(sessionId, chatId, recipient);
      const service = agents();
      const agent = service.get?.(sessionId);
      if (!agent) {
        await disposeOwnedSession(sessionId);
        throw new Error('FEISHU_AGENT_NOT_LIVE: session is not live after create/resume');
      }
      if (typeof agent.whenIdle !== 'function') {
        throw new Error('FEISHU_AGENT_IDLE_UNAVAILABLE: agent.whenIdle is unavailable');
      }
      if (typeof agent.followup !== 'function') {
        throw new Error('FEISHU_AGENT_FOLLOWUP_UNAVAILABLE: agent.followup is unavailable');
      }

      run.agent = agent;
      run.disposeAgentListener = attachClaimListener(agent, run);
      if (isRunCancelled(run)) {
        await cancelRunBestEffort(run);
        await disposeUnboundSession(chatId, sessionId);
        return { kind: 'cancelled' };
      }

      run.startSeq = getNextEventSeq(agent.session?.events);
      const userMessage = createAgentUserMessage(text);
      try {
        await awaitWithTimeout(
          Promise.resolve().then(() => agent.followup(userMessage)),
          agentOperationTimeoutMs,
          createDriverError('FEISHU_AGENT_FOLLOWUP_TIMEOUT'),
        );
      } catch (error) {
        run.followupSettled = true;
        if (isRunCancelled(run)) {
          await cancelRunBestEffort(run);
          const idleState = await waitForRunIdle(run);
          if (idleState.kind === 'idle') run.idleConfirmed = true;
          if (idleState.kind !== 'idle' && !idleState.idleConfirmed) {
            taintedSessions.add(sessionId);
          }
          await disposeUnboundSession(chatId, sessionId);
          return { kind: 'cancelled' };
        }
        taintedSessions.add(sessionId);
        await cancelRunBestEffort(run);
        throw toAgentLifecycleError(error, 'FEISHU_AGENT_FOLLOWUP_FAILED');
      } finally {
        run.followupSettled = true;
      }
      const idleState = await waitForRunIdle(run);
      if (idleState.kind === 'cancelled') {
        if (!idleState.idleConfirmed) taintedSessions.add(sessionId);
        await disposeUnboundSession(chatId, sessionId);
        return { kind: 'cancelled' };
      }
      if (idleState.kind === 'error') {
        taintedSessions.add(sessionId);
        await cancelRunBestEffort(run);
        throw idleState.error;
      }
      run.idleConfirmed = true;
      if (isRunCancelled(run)) {
        await disposeUnboundSession(chatId, sessionId);
        return { kind: 'cancelled' };
      }
      return getAgentTurnResult(
        agent.session?.events ?? [],
        run.startSeq,
        run.claimedTurns.get(userMessage.id),
        config.maxOutboundTextLength,
      );
    } catch (error) {
      if (isRunCancelled(run) || isCancellationError(error)) {
        await disposeUnboundSession(chatId, run.sessionId);
        return { kind: 'cancelled' };
      }
      lastStates.set(chatId, 'failed');
      throw error;
    } finally {
      run.disposeAgentListener?.();
      clearSessionRecipient(run.sessionId);
      const isCurrentRun = activeRuns.get(chatId) === run;
      if (isCurrentRun) activeRuns.delete(chatId);
      if (isCurrentRun && lastStates.get(chatId) === 'running') lastStates.set(chatId, 'idle');
      finishRun();
    }
  }

  function enqueuePrompt(chatId, text, recipient) {
    if (disposed) throw new Error('FEISHU_DRIVER_CLOSED: Agent driver is unavailable');
    const queue = queueFor(chatId);
    const generation = generationFor(chatId);
    const queued = queue.push(async () => {
      await waitForReset(chatId);
      return runPrompt(chatId, text, generation, recipient);
    });
    return queued.promise.then((result) => result ?? { kind: 'cancelled' });
  }

  async function cancel(chatId, { invalidate = true } = {}) {
    if (invalidate) bumpGeneration(chatId);
    const queue = queues.get(chatId);
    const active = activeRuns.get(chatId);
    queue?.cancelPending();
    if (!active) return { cancelled: false };
    if (!active.sessionId) {
      const boundSessionId = bindings.get(chatId)?.sessionId;
      if (boundSessionId) taintedSessions.add(boundSessionId);
    }
    active.cancelRequested = true;
    active.notifyCancelled?.();
    lastStates.set(chatId, 'cancelled');
    try {
      await cancelRun(active);
      await awaitWithTimeout(
        active.done,
        cancelTimeoutMs,
        createDriverError('FEISHU_CANCEL_TIMEOUT'),
      );
    } catch (error) {
      if (active.sessionId) taintedSessions.add(active.sessionId);
      if (error?.feishuCode === 'FEISHU_CANCEL_TIMEOUT' && active.followupSettled) {
        return { cancelled: true };
      }
      lastStates.set(chatId, 'failed');
      throw toAgentLifecycleError(error, 'FEISHU_CANCEL_FAILED');
    }
    return { cancelled: true };
  }

  function reset(chatId) {
    bumpGeneration(chatId);
    const previous = resetBarriers.get(chatId);
    const barrier = Promise.resolve(previous)
      .catch(() => undefined)
      .then(() => resetNow(chatId));
    resetBarriers.set(chatId, barrier);
    void barrier.then(
      () => clearResetBarrier(chatId, barrier),
      () => clearResetBarrier(chatId, barrier),
    );
    return barrier;
  }

  async function resetNow(chatId) {
    const result = await cancel(chatId, { invalidate: false });
    const binding = bindings.get(chatId);
    if (binding?.sessionId) {
      progressRelay?.cancel?.(binding.sessionId);
      approvalBridge?.cancelSession?.(binding.sessionId);
      clearSessionRecipient(binding.sessionId);
      const disposedSession = await disposeOwnedSession(binding.sessionId);
      if (!disposedSession) {
        lastStates.set(chatId, 'failed');
        throw createDriverError('FEISHU_AGENT_DISPOSE_FAILED');
      }
    }
    bindings.clearSession(chatId);
    if (bindings.get(chatId)?.projectPath) lastStates.set(chatId, 'ready');
    else lastStates.set(chatId, 'unconfigured');
    return result;
  }

  async function waitForReset(chatId) {
    const barrier = resetBarriers.get(chatId);
    if (barrier) await barrier;
  }

  function clearResetBarrier(chatId, barrier) {
    if (resetBarriers.get(chatId) === barrier) resetBarriers.delete(chatId);
  }

  function status(chatId) {
    const binding = bindings.get(chatId);
    const queue = queues.get(chatId);
    const active = activeRuns.get(chatId);
    const progress = binding?.sessionId ? progressRelay?.getStatus?.(binding.sessionId) : undefined;
    let state;
    if (!binding?.projectPath) state = 'unconfigured';
    else if (progress?.phase === 'waiting_approval') state = 'waiting_approval';
    else if (active || queue?.running || (queue?.size ?? 0) > 0) state = 'running';
    else if (!binding.sessionId) state = 'ready';
    else state = lastStates.get(chatId) ?? 'idle';

    return {
      state,
      projectPath: binding?.projectPath,
      queueSize: queue?.size ?? 0,
      model: binding?.model,
    };
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    for (const queue of queues.values()) queue.cancelPending();
    const runs = [...activeRuns.values()];
    for (const run of runs) {
      run.cancelRequested = true;
      run.notifyCancelled?.();
      lastStates.set(run.chatId, 'cancelled');
      void cancelRun(run).catch(() => undefined);
    }
    await Promise.all(runs.map((run) => awaitWithTimeout(
      run.done,
      cancelTimeoutMs,
      createDriverError('FEISHU_CANCEL_TIMEOUT'),
    ).catch(() => undefined)));
    for (const sessionId of ownedHandles.keys()) await disposeOwnedSession(sessionId);
    queues.clear();
    activeRuns.clear();
    lastStates.clear();
    generations.clear();
    resetBarriers.clear();
    taintedSessions.clear();
    sessionRecipients.clear();
  }

  return { ensureSession, enqueuePrompt, cancel, reset, status, dispose };

  function cancelRun(run) {
    if (run.cancelPromise) return run.cancelPromise;
    if (!run.agent) return Promise.resolve();
    run.cancelIssued = true;
    if (run.sessionId) approvalBridge?.cancelSession?.(run.sessionId);
    run.cancelPromise = awaitWithTimeout(
      Promise.resolve().then(() => run.agent.cancel?.({ kind: 'user' }, { keepInbox: false })),
      cancelTimeoutMs,
      createDriverError('FEISHU_CANCEL_TIMEOUT'),
    )
      .catch((error) => {
        throw toAgentLifecycleError(error, 'FEISHU_CANCEL_FAILED');
      })
      .finally(() => {
        if (run.sessionId) approvalBridge?.cancelSession?.(run.sessionId);
      });
    return run.cancelPromise;
  }

  async function cancelRunBestEffort(run) {
    try {
      await cancelRun(run);
    } catch {
      // Preserve the original Agent lifecycle error; explicit cancel callers
      // still receive the cancellation failure from cancelRun directly.
    }
  }

  function setSessionRecipient(sessionId, chatId, recipient) {
    if (!sessionId) return;
    sessionRecipients.set(sessionId, { chatId, recipient });
    progressRelay?.setRecipient?.(sessionId, chatId, recipient);
  }

  function clearSessionRecipient(sessionId) {
    if (!sessionId) return;
    sessionRecipients.delete(sessionId);
    progressRelay?.clearRecipient?.(sessionId);
  }

  function attachClaimListener(agent, run) {
    if (typeof agent?.ctx?.on !== 'function') return undefined;
    try {
      return agent.ctx.on('agent/inbox/claimed', ({ message, turn }) => {
        if (typeof message?.id === 'string' && Number.isSafeInteger(turn)) {
          run.claimedTurns.set(message.id, turn);
        }
      });
    } catch {
      return undefined;
    }
  }

  function rememberOwnedHandle(sessionId, handle) {
    if (typeof handle?.dispose !== 'function') return;
    if (disposed) {
      void disposeHandle(handle);
      return;
    }
    ownedHandles.set(sessionId, handle);
  }

  async function disposeOwnedSession(sessionId) {
    managedSessions.delete(sessionId);
    const handle = ownedHandles.get(sessionId);
    if (!handle) return true;
    try {
      await awaitWithTimeout(
        Promise.resolve().then(() => handle.dispose()),
        cancelTimeoutMs,
        createDriverError('FEISHU_AGENT_DISPOSE_TIMEOUT'),
      );
      ownedHandles.delete(sessionId);
      taintedSessions.delete(sessionId);
      return true;
    } catch {
      taintedSessions.add(sessionId);
      return false;
    }
  }

  async function disposeUnboundSession(chatId, sessionId) {
    if (!sessionId || bindings.get(chatId)?.sessionId === sessionId) return;
    await disposeOwnedSession(sessionId);
  }

  async function disposeHandle(handle) {
    try {
      await awaitWithTimeout(
        Promise.resolve().then(() => handle?.dispose?.()),
        cancelTimeoutMs,
        createDriverError('FEISHU_AGENT_DISPOSE_TIMEOUT'),
      );
    } catch {
      // Rollback errors must not replace the stable driver error code.
    }
  }

  async function discardStaleSession(sessionId, handle, ownerRun) {
    taintedSessions.add(sessionId);
    if (ownerRun) {
      ownerRun.sessionId = sessionId;
      ownerRun.agent = handle?.agent;
      if (!ownerRun.agent) {
        try {
          ownerRun.agent = agents().get?.(sessionId);
        } catch {
          ownerRun.agent = undefined;
        }
      }
      await cancelRunBestEffort(ownerRun);
    }
    await disposeHandle(handle);
  }

  function clearTaintIfSessionNotLive(sessionId, service) {
    if (!taintedSessions.has(sessionId)) return;
    try {
      if (!service.get?.(sessionId)) taintedSessions.delete(sessionId);
    } catch {
      // Keep the taint when liveness cannot be confirmed.
    }
  }

  async function waitForIdle(agent, cancellation) {
    try {
      const idleOperation = Promise.resolve().then(() => agent.whenIdle());
      const cancellableOperation = Promise.race([
        idleOperation,
        Promise.resolve(cancellation).then(() => IDLE_WAIT_CANCELLED),
      ]);
      const result = await awaitWithTimeout(
        cancellableOperation,
        whenIdleTimeoutMs,
        createDriverError('FEISHU_AGENT_IDLE_TIMEOUT'),
      );
      return result === IDLE_WAIT_CANCELLED ? IDLE_WAIT_CANCELLED : undefined;
    } catch (error) {
      throw toAgentLifecycleError(error, 'FEISHU_AGENT_IDLE_FAILED');
    }
  }

  async function waitForRunIdle(run) {
    const idlePromise = Promise.resolve()
      .then(() => waitForIdle(run.agent, run.whenCancelled))
      .then(
        (result) => result === IDLE_WAIT_CANCELLED ? { kind: 'cancelled' } : { kind: 'idle' },
        (error) => ({ kind: 'error', error }),
      );
    const outcome = await Promise.race([
      idlePromise,
      Promise.resolve(run.whenCancelled).then(() => ({ kind: 'cancel-requested' })),
    ]);
    if (outcome.kind !== 'cancel-requested') return outcome;

    const cancelIdleTimeout = createDriverError('FEISHU_CANCEL_TIMEOUT');
    try {
      const settled = await awaitWithTimeout(idlePromise, cancelTimeoutMs, cancelIdleTimeout);
      if (settled.kind === 'idle') run.idleConfirmed = true;
      return settled.kind === 'idle'
        ? { kind: 'cancelled', idleConfirmed: true }
        : { kind: 'cancelled', idleConfirmed: false };
    } catch (error) {
      if (error?.feishuCode === 'FEISHU_CANCEL_TIMEOUT') {
        return { kind: 'cancelled', idleConfirmed: false };
      }
      return { kind: 'cancelled', idleConfirmed: false };
    }
  }

}

function assertAgentSessionCwd(agent, projectPath, projectPolicy) {
  const actualCwd = agent?.session?.header?.cwd;
  if (typeof actualCwd !== 'string' || actualCwd.trim() === '') {
    throw createDriverError('FEISHU_AGENT_CWD_MISMATCH');
  }
  if (typeof projectPolicy?.resolve === 'function') {
    const resolved = projectPolicy.resolve(actualCwd);
    if (!resolved?.ok || resolved.path !== projectPath) throw createDriverError('FEISHU_AGENT_CWD_MISMATCH');
    return;
  }
  if (!samePath(actualCwd, projectPath)) throw createDriverError('FEISHU_AGENT_CWD_MISMATCH');
}

function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  try {
    return realpathSync(normalizedLeft) === realpathSync(normalizedRight);
  } catch {
    // Unit callers can use virtual paths; production bindings are realpath-checked
    // by projectPolicy before reaching this boundary.
    return normalizedLeft === normalizedRight;
  }
}

function boundedTimeout(value, fallback, max = 300000) {
  return Number.isSafeInteger(value) && value > 0
    ? Math.min(value, max)
    : fallback;
}

function normalizeOutputLength(value) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 120000) : 12000;
}

function createDriverError(code) {
  const error = new Error(code);
  error.feishuCode = code;
  return error;
}

function toAgentLifecycleError(error, fallback) {
  if (error?.feishuCode) return error;
  return createDriverError(fallback);
}

function createCancellationError() {
  const error = createDriverError('FEISHU_OPERATION_CANCELLED');
  error.cancelled = true;
  return error;
}

function isCancellationError(error) {
  return error?.cancelled === true || error?.feishuCode === 'FEISHU_OPERATION_CANCELLED';
}

function getNextEventSeq(events) {
  if (!Array.isArray(events)) return 0;
  let maxSeq = -1;
  for (const event of events) {
    if (Number.isSafeInteger(event?.seq) && event.seq > maxSeq) maxSeq = event.seq;
  }
  return maxSeq >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : maxSeq + 1;
}

function isTrimWhitespace(value) {
  return /^\s$/u.test(value);
}

function awaitWithTimeout(operation, timeoutMs, timeoutError, onLateResolve) {
  let timedOut = false;
  let timer;
  const task = Promise.resolve(operation);
  const observed = task.then(
    (value) => {
      if (timedOut && typeof onLateResolve === 'function') {
        void Promise.resolve(onLateResolve(value)).catch(() => {});
      }
      return value;
    },
    (error) => {
      if (timedOut) return undefined;
      throw error;
    },
  );
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(timeoutError);
    }, timeoutMs);
  });
  return Promise.race([observed, timeout]).finally(() => clearTimeout(timer));
}
