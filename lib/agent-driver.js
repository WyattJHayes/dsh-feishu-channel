import { randomUUID } from 'node:crypto';
import { createPromptQueue } from './prompt-queue.js';
import { createRiskListener } from './risk-policy.js';

/** Create a globally unique session id for a new Feishu chat binding. */
export function createAgentSessionId() {
  return `feishu-session-${randomUUID()}`;
}

/** @param {{ agent?: { id?: string }, sessionId?: string, id?: string } | undefined} handle */
export function getAgentSessionId(handle) {
  return handle?.agent?.id ?? handle?.sessionId ?? handle?.id;
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

/** @param {{ on: Function }} agentCtx @param {{ selection?: object, approvalBridge?: object, projectPath?: string, chatId?: string, agentPreset?: string | null, agentPresets?: { mount: Function } } | object} options */
export async function createAgentSetup(agentCtx, options) {
  const selection = options?.selection ?? options;
  if (typeof options?.agentPresets?.mount !== 'function') {
    throw new Error('FEISHU_NO_AGENT_PRESETS_SERVICE: ctx.agentPresets is unavailable');
  }
  await options.agentPresets.mount(agentCtx, options.agentPreset ?? undefined);
  installAgentModelSelection(agentCtx, selection);

  if (options?.approvalBridge && options?.projectPath) {
    agentCtx.on('tools/pre-execute', createRiskListener({
      projectPath: options.projectPath,
      remember: (exec, summary) => options.approvalBridge.remember(exec, summary),
    }));
    agentCtx.on('approval/request', options.approvalBridge.createListener(() => options.chatId));
  }
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

/** @param {{ content?: Array<{ type?: string, text?: unknown }> } | undefined} message */
export function extractAssistantText(message) {
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim();
}

/**
 * @param {Array<{ seq?: number, type?: string, data?: any }>} events
 * @param {number} startSeq
 * @param {number | undefined} expectedTurn
 */
export function getAgentTurnResult(events, startSeq, expectedTurn) {
  const suffix = events.filter((event) => typeof event?.seq === 'number' && event.seq >= startSeq);
  const turnEnd = [...suffix].reverse().find((event) => event.type === 'turn/end' && (
    expectedTurn === undefined || event.data?.turn === expectedTurn
  ));
  if (!turnEnd) return { kind: 'pending' };

  const turn = turnEnd.data?.turn;
  const assistant = [...suffix]
    .reverse()
    .find((event) => event.type === 'assistant/message' && event.data?.turn === turn);
  const text = extractAssistantText(assistant?.data?.message);
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
  const queues = new Map();
  const activeRuns = new Map();
  const lastStates = new Map();
  const ownedHandles = new Map();
  let disposed = false;

  function agents() {
    if (!ctx.agents) throw new Error('FEISHU_NO_AGENTS_SERVICE: ctx.agents is unavailable');
    return ctx.agents;
  }

  function queueFor(chatId) {
    let queue = queues.get(chatId);
    if (!queue) {
      queue = createPromptQueue();
      queues.set(chatId, queue);
    }
    return queue;
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

  function createSetup(chatId, binding, selection) {
    const modelSelection = { current: selection, assembled: undefined };
    return async (agentCtx) => {
      await createAgentSetup(agentCtx, {
        chatId,
        projectPath: binding.projectPath,
        selection: modelSelection,
        approvalBridge,
        agentPreset: config.agentPreset,
        agentPresets: ctx.agentPresets,
      });
    };
  }

  async function ensureSession(chatId) {
    const binding = validateBinding(chatId);

    const service = agents();
    const liveSessionId = getLiveAgentSessionId(binding, (sessionId) => service.get?.(sessionId));
    if (liveSessionId) return liveSessionId;

    const selection = selectionFor(binding);
    if (binding.sessionId) {
      if (typeof service.resume !== 'function') {
        throw new Error('FEISHU_NO_AGENTS_SERVICE: ctx.agents.resume is unavailable');
      }
      let handle;
      try {
        handle = await service.resume({
          resumeSessionId: binding.sessionId,
          agentOptions: selection,
          setup: createSetup(chatId, binding, selection),
        });
      } catch {
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
      rememberOwnedHandle(sessionId, handle);
      lastStates.set(chatId, 'idle');
      return sessionId;
    }

    if (typeof service.create !== 'function') {
      throw new Error('FEISHU_NO_AGENTS_SERVICE: ctx.agents.create is unavailable');
    }
    let handle;
    try {
      handle = await service.create({
        sessionId: createAgentSessionId(),
        agentOptions: createAgentOptions(selection),
        meta: createAgentMeta(config.agentPreset, binding.projectPath),
        setup: createSetup(chatId, binding, selection),
      });
    } catch {
      lastStates.set(chatId, 'failed');
      throw new Error('FEISHU_SESSION_CREATE_FAILED: unable to create an Agent session');
    }
    const sessionId = getAgentSessionId(handle);
    if (!sessionId) {
      await disposeHandle(handle);
      throw new Error('FEISHU_SESSION_CREATE_FAILED: no session id returned');
    }
    try {
      bindings.bind(chatId, {
        projectPath: binding.projectPath,
        sessionId,
        model: selection,
      });
    } catch {
      await disposeHandle(handle);
      throw new Error('FEISHU_SESSION_CREATE_FAILED: unable to persist the Agent session');
    }
    rememberOwnedHandle(sessionId, handle);
    lastStates.set(chatId, 'idle');
    return sessionId;
  }

  async function runPrompt(chatId, text) {
    let finishRun;
    const run = {
      chatId,
      agent: undefined,
      sessionId: undefined,
      startSeq: 0,
      cancelRequested: false,
      cancelIssued: false,
      cancelPromise: undefined,
      claimedTurns: new Map(),
      disposeAgentListener: undefined,
      done: new Promise((resolve) => {
        finishRun = resolve;
      }),
    };
    activeRuns.set(chatId, run);
    lastStates.set(chatId, 'running');
    try {
      const sessionId = await ensureSession(chatId);
      const service = agents();
      const agent = service.get?.(sessionId);
      if (!agent) throw new Error('FEISHU_AGENT_NOT_LIVE: session is not live after create/resume');
      if (typeof agent.whenIdle !== 'function') {
        throw new Error('FEISHU_AGENT_IDLE_UNAVAILABLE: agent.whenIdle is unavailable');
      }
      if (typeof agent.followup !== 'function') {
        throw new Error('FEISHU_AGENT_FOLLOWUP_UNAVAILABLE: agent.followup is unavailable');
      }

      run.sessionId = sessionId;
      run.agent = agent;
      run.disposeAgentListener = attachClaimListener(agent, run);
      if (run.cancelRequested || disposed) {
        await cancelRun(run);
        await agent.whenIdle();
        return { kind: 'cancelled' };
      }

      run.startSeq = Array.isArray(agent.session?.events) ? agent.session.events.length : 0;
      const userMessage = createAgentUserMessage(text);
      await agent.followup(userMessage);
      if (run.cancelRequested) {
        await cancelRun(run);
        await agent.whenIdle();
        return { kind: 'cancelled' };
      }
      await agent.whenIdle();
      if (run.cancelRequested) return { kind: 'cancelled' };
      return getAgentTurnResult(agent.session?.events ?? [], run.startSeq, run.claimedTurns.get(userMessage.id));
    } catch (error) {
      if (run.cancelRequested) return { kind: 'cancelled' };
      lastStates.set(chatId, 'failed');
      throw error;
    } finally {
      run.disposeAgentListener?.();
      if (activeRuns.get(chatId) === run) activeRuns.delete(chatId);
      if (lastStates.get(chatId) === 'running') lastStates.set(chatId, 'idle');
      finishRun();
    }
  }

  function enqueuePrompt(chatId, text) {
    if (disposed) throw new Error('FEISHU_DRIVER_CLOSED: Agent driver is unavailable');
    const queue = queueFor(chatId);
    const queued = queue.push(() => runPrompt(chatId, text));
    return queued.promise.then((result) => result ?? { kind: 'cancelled' });
  }

  async function cancel(chatId) {
    const queue = queues.get(chatId);
    const active = activeRuns.get(chatId);
    queue?.cancelPending();
    if (!active) return { cancelled: false };
    active.cancelRequested = true;
    lastStates.set(chatId, 'cancelled');
    await cancelRun(active);
    await active.done;
    return { cancelled: true };
  }

  async function reset(chatId) {
    const result = await cancel(chatId);
    const binding = bindings.get(chatId);
    if (binding?.sessionId) {
      progressRelay?.cancel?.(binding.sessionId);
      await disposeOwnedSession(binding.sessionId);
    }
    bindings.clearSession(chatId);
    if (bindings.get(chatId)?.projectPath) lastStates.set(chatId, 'ready');
    else lastStates.set(chatId, 'unconfigured');
    return result;
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
      lastStates.set(run.chatId, 'cancelled');
      void cancelRun(run);
    }
    await Promise.all(runs.map((run) => run.done));
    for (const sessionId of ownedHandles.keys()) await disposeOwnedSession(sessionId);
    queues.clear();
    activeRuns.clear();
    lastStates.clear();
  }

  return { ensureSession, enqueuePrompt, cancel, reset, status, dispose };

  function cancelRun(run) {
    if (run.cancelPromise) return run.cancelPromise;
    if (!run.agent) return Promise.resolve();
    run.cancelIssued = true;
    if (run.sessionId) approvalBridge?.cancelSession?.(run.sessionId);
    run.cancelPromise = Promise.resolve()
      .then(() => run.agent.cancel({ kind: 'user' }, { keepInbox: true }))
      .catch(() => undefined)
      .finally(() => {
        if (run.sessionId) approvalBridge?.cancelSession?.(run.sessionId);
      });
    return run.cancelPromise;
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
    if (typeof handle?.dispose === 'function') ownedHandles.set(sessionId, handle);
  }

  async function disposeOwnedSession(sessionId) {
    const handle = ownedHandles.get(sessionId);
    if (!handle) return;
    ownedHandles.delete(sessionId);
    try {
      await handle.dispose();
    } catch {
      // Agent lifecycle cleanup is best effort; the registry owns final teardown.
    }
  }

  async function disposeHandle(handle) {
    try {
      await handle?.dispose?.();
    } catch {
      // Rollback errors must not replace the stable driver error code.
    }
  }
}
