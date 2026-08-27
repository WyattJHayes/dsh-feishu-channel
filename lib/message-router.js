import { isAllowed } from './access.js';
import { parseCommand } from './commands.js';
import { createDedupe } from './dedupe.js';

const DEFAULT_MAX_PROMPT_LENGTH = 12000;
const ERROR_LIMIT = 140;

export function createMessageRouter(options) {
  const dedupe = options?.dedupe ?? createDedupe({
    capacity: options?.config?.dedupeCapacity,
    ttlMs: options?.config?.dedupeTtlMs,
    now: options?.now,
  });
  const pendingPrompts = new Map();
  let closed = false;
  const router = {
    dedupe,
    driver: options.driver,
    handleMessage,
    close() {
      closed = true;
      pendingPrompts.clear();
    },
  };
  return router;

  async function handleMessage(event) {
    if (closed) return;
    if (!dedupe.first(event?.eventId)) return;

    const chatType = event?.chatType;
    if (chatType !== 'p2p' && chatType !== 'group') return;

    const chatId = event?.chatId;
    const text = String(event?.text ?? '').trim();
    if (!chatId || !text) return;

    const allowed = isAllowed(options.config ?? {}, {
      openId: event?.openId,
      chatId,
      chatType,
    });
    // Do not enqueue a response for unauthorized events. Besides avoiding
    // identity feedback, this keeps rejected traffic from exhausting sends.
    if (!allowed) return;

    const recipient = createRecipient(event, options.config?.groupOutputMode ?? 'sender');

    const parsed = parseCommand(text);
    if (!parsed) return;

    try {
      switch (parsed.type) {
        case 'project':
          await bindProject(chatId, parsed.path, recipient);
          return;
        case 'new':
          await resetChat(chatId, recipient);
          return;
        case 'status':
          await send(chatId, formatStatus(options.driver.status(chatId)), recipient);
          return;
        case 'cancel':
          await cancelChat(chatId, recipient);
          return;
        case 'approve':
          await answerApproval(chatId, parsed.token, 'allowed-once', recipient);
          return;
        case 'deny':
          await answerApproval(chatId, parsed.token, 'rejected', recipient);
          return;
        case 'help':
          await send(chatId, helpText(), recipient);
          return;
        case 'usage':
          await send(chatId, parsed.hint, recipient);
          return;
        case 'prompt':
          await enqueuePrompt(chatId, parsed.text, recipient);
          return;
        default:
          await send(chatId, '该指令将在后续版本支持。', recipient);
      }
    } catch (error) {
      await sendError(chatId, error, recipient);
    }
  }

  async function bindProject(chatId, projectPath, recipient) {
    const resolved = options.projectPolicy.resolve(projectPath);
    if (!resolved.ok) {
      await send(chatId, resolved.message ?? '项目目录不可用。', recipient);
      return;
    }

    const existing = options.bindings.get(chatId);
    const existingIsValid = existing?.projectPath ? safeResolve(existing.projectPath).ok : false;
    if (existing?.sessionId && existing?.projectPath && existing.projectPath !== resolved.path && existingIsValid) {
      await send(chatId, '当前会话已绑定其他项目，请先使用 /new 开启新会话后再切换。', recipient);
      return;
    }

    if (existing?.projectPath === resolved.path) {
      await send(chatId, `已绑定项目：${resolved.path}`, recipient);
      return;
    }

    if (existing?.sessionId) await options.driver.reset(chatId);

    options.bindings.bind(chatId, {
      projectPath: resolved.path,
      ...(existing?.model ? { model: existing.model } : {}),
    });
    await send(chatId, `已绑定项目：${resolved.path}`, recipient);
  }

  async function resetChat(chatId, recipient) {
    const previous = options.bindings.get(chatId);
    await options.driver.reset(chatId);
    if (previous?.sessionId) options.progressRelay?.cancel?.(previous.sessionId);
    await send(chatId, '已开启新会话，项目路径保持不变。', recipient);
  }

  async function cancelChat(chatId, recipient) {
    const binding = options.bindings.get(chatId);
    const result = await options.driver.cancel(chatId);
    if (binding?.sessionId) options.progressRelay?.cancel?.(binding.sessionId);
    await send(chatId, result?.cancelled ? '已取消当前回合。' : '当前没有正在运行的回合。', recipient);
  }

  async function answerApproval(chatId, token, outcome, recipient) {
    const result = await options.approvalBridge.answer(chatId, token, outcome, recipient);
    await send(chatId, result?.ok
      ? (outcome === 'allowed-once' ? '已批准本次工具调用。' : '已拒绝本次工具调用。')
      : '审批请求不存在或已过期。', recipient);
  }

  async function enqueuePrompt(chatId, text, recipient) {
    const binding = options.bindings.get(chatId);
    if (options.config?.dshHomeAvailable === false) {
      await send(chatId, '飞书远程 Agent 配置不可用：缺少 DSH_HOME。', recipient);
      return;
    }
    if (!binding?.projectPath) {
      await send(chatId, '请先使用 /project <绝对路径> 绑定项目目录。', recipient);
      return;
    }
    if (text.length > (options.config?.maxPromptLength ?? DEFAULT_MAX_PROMPT_LENGTH)) {
      await send(chatId, '消息过长，未提交。', recipient);
      return;
    }

    let run;
    const fallbackPosition = (pendingPrompts.get(chatId) ?? 0) + 1;
    pendingPrompts.set(chatId, fallbackPosition);
    try {
      run = normalizeRun(options.driver.enqueuePrompt(chatId, text, recipient), fallbackPosition);
    } catch (error) {
      decrementPending(chatId);
      await sendError(chatId, error, recipient);
      return;
    }

    void run.promise
      .then((result) => sendResult(chatId, result, recipient))
      .catch((error) => sendError(chatId, error, recipient))
      .finally(() => decrementPending(chatId));

    await send(chatId, run.position === 1
      ? '已提交，运行结束后回发结果。'
      : `已排队，前面还有 ${run.position - 1} 个任务。`, recipient);
  }

  function normalizeRun(value, fallbackPosition) {
    if (value?.promise && typeof value.position === 'number') return value;
    return { position: fallbackPosition, promise: Promise.resolve(value).then((result) => result ?? { kind: 'cancelled' }) };
  }

  function decrementPending(chatId) {
    const current = pendingPrompts.get(chatId) ?? 0;
    if (current <= 1) {
      pendingPrompts.delete(chatId);
      return;
    }
    pendingPrompts.set(chatId, current - 1);
  }

  async function sendResult(chatId, result, recipient) {
    if (result?.kind === 'text' && result.text) {
      await send(chatId, String(result.text), recipient);
      return;
    }
    if (result?.kind === 'error') {
      await send(chatId, `出错了：${safeErrorCode(result.message, 'FEISHU_AGENT_TURN_FAILED')}`, recipient);
      return;
    }
    if (result?.kind === 'cancelled') return;
    await send(chatId, '运行结束，但 Agent 没有返回文本。', recipient);
  }

  async function sendError(chatId, error, recipient) {
    const code = safeErrorCode(error);
    options.logger?.warn?.(`feishu-channel: prompt failed: ${code}`);
    await send(chatId, `出错了：${code}`, recipient);
  }

  async function send(chatId, text, recipient) {
    if (closed) return;
    try {
      await options.sendText(chatId, text, recipient);
    } catch (error) {
      options.logger?.warn?.(`feishu-channel: send failed: ${formatSendError(error)}`);
    }
  }

  function safeResolve(path) {
    try {
      return options.projectPolicy.resolve(path);
    } catch {
      return { ok: false };
    }
  }
}

function createRecipient(event, groupOutputMode) {
  if (event?.chatType === 'group' && groupOutputMode === 'sender') {
    if (typeof event.openId !== 'string' || event.openId.trim() === '') return null;
    return Object.freeze({ receiveId: event.openId.trim(), receiveIdType: 'open_id' });
  }
  if (typeof event?.chatId !== 'string' || event.chatId.trim() === '') return null;
  return Object.freeze({ receiveId: event.chatId, receiveIdType: 'chat_id' });
}

function formatStatus(status) {
  const lines = [`状态：${status?.state ?? 'unknown'}`];
  if (status?.projectPath) lines.push(`项目：${status.projectPath}`);
  if (status?.model?.provider && status?.model?.model) lines.push(`模型：${status.model.provider}/${status.model.model}`);
  lines.push(`队列：${status?.queueSize ?? 0}`);
  return lines.join('\n');
}

function helpText() {
  return [
    '/project <绝对路径> 绑定项目',
    '/new 新会话',
    '/status 当前状态',
    '/cancel 取消当前回合',
    '/approve <id> 批准一次工具调用',
    '/deny <id> 拒绝一次工具调用',
    '/help 帮助',
  ].join('\n');
}

function safeErrorCode(error, fallback = 'FEISHU_PROMPT_FAILED') {
  const raw = typeof error === 'string' ? error : String(error?.message ?? error ?? 'FEISHU_PROMPT_FAILED');
  return /^FEISHU_[A-Z0-9_]{2,80}(?::|\b)/.exec(raw.trim())?.[0].replace(/:$/, '') ?? fallback;
}

function formatSendError(error) {
  const code = safeErrorCode(error, 'FEISHU_SEND_FAILED');
  const apiCode = error?.apiCode;
  return typeof apiCode === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(apiCode)
    ? `${code} (api_code=${apiCode})`
    : code;
}
