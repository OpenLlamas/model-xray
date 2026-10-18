import { SseParser, parseStreamPayload, extractText, extractErrorMessage, validateUsage, type ToolCallDelta } from './sse.js';
import { estimateMessageTokens } from './tokens.js';
import type {
  ChatRequest,
  ChatResult,
  ClientOptions,
  OpenAIClient,
  RequestProgressEvent,
  ToolCall,
  Usage,
  UsageRejection,
} from './types.js';

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

/** 额度耗尽（区别于普通限流）：命中后整个审计熔断，避免继续空发请求与输出碎片化证据。 */
const QUOTA_EXHAUSTED =
  /quota[_\s-]?(exceeded|exhausted)|key quota|insufficient[_\s-]?(quota|balance)|exceeded your current quota|余额不足|欠费|额度(不足|耗尽)/i;

export function isQuotaExhaustion(status: number, error: string | null): boolean {
  if (error === null || !QUOTA_EXHAUSTED.test(error)) return false;
  return status === 200 || status === 402 || status === 403 || status === 429;
}

/** 审计专用：配额已确认耗尽后继续调用时抛出，runner 据此立即中止当前维度（不再累积假失败证据）。 */
export class QuotaExhaustedError extends Error {
  constructor(readonly detail: string) {
    super(`quota exhausted: ${detail}`);
    this.name = 'QuotaExhaustedError';
  }
}

export function createClient(options: ClientOptions): OpenAIClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const chatUrl = `${baseUrl}/chat/completions`;
  let seq = 0;
  let quotaError: string | null = null;

  function emit(event: RequestProgressEvent): void {
    const callback = options.onRequest;
    if (callback === undefined) return;
    try {
      callback(event);
    } catch {
      // 进度展示失败不得影响审计
    }
  }

  async function chat(req: ChatRequest): Promise<ChatResult> {
    seq += 1;
    const requestSeq = seq;
    if (quotaError !== null) {
      // 配额已确认耗尽：审计路径立即中止当前维度；其余调用方（guard 等）仍收到可处理的 429 结果。
      if (options.abortOnQuota === true) throw new QuotaExhaustedError(quotaError);
      return errorResult(`quota exhausted（熔断：后续请求未发送）：${quotaError}`, 429, 0);
    }
    // 仅在启用进度回调时估算（guard 代理等无回调路径不做额外的全文扫描）；
    // 估算失败只丢进度里的约数，绝不影响审计本身。
    let promptTokensEstimate: number | undefined;
    if (options.onRequest !== undefined) {
      try {
        promptTokensEstimate = estimateMessageTokens(req.messages);
      } catch {
        promptTokensEstimate = undefined;
      }
    }
    let lastResult: ChatResult | null = null;
    for (let attempt = 1; attempt <= options.retries + 1; attempt += 1) {
      if (attempt > 1) await sleep(backoffMs(attempt));
      emit({ seq: requestSeq, attempt, kind: 'start', promptTokensEstimate });
      lastResult = await attemptChat(chatUrl, options, req);
      // 记录实际尝试次数：计费探针用它识别「审计窗口内存在重试」的重复计费风险
      lastResult.attempts = attempt;
      if (isQuotaExhaustion(lastResult.status, lastResult.error)) {
        quotaError = lastResult.error;
      }
      emit({
        seq: requestSeq,
        attempt,
        kind: 'end',
        status: lastResult.status,
        ok: lastResult.ok,
        durationMs: lastResult.durationMs,
        promptTokens: lastResult.usage?.prompt_tokens ?? null,
        error: lastResult.error,
      });
      // 配额耗尽不是抖动：立即返回，不消耗重试预算。
      if (quotaError !== null) return lastResult;
      // 可重试 = 明确的可重试状态码（408/409/429/5xx），或 200 空正文（空流/空 content；
      // 上游收下请求却零产出，与端点 cpu 过载同源的抖动；completion=0 无输出计费，
      // 重试只重复计 prompt 小额）。finish_reason=length 的截断不在此重试（由探针升预算处理）。
      // attempts 如实递增，计费探针的「窗口内存在重试」污染口径照常生效；其余错误绝不重试。
      const retryable =
        (!lastResult.ok && RETRYABLE_STATUS.has(lastResult.status)) ||
        (lastResult.ok &&
          req.retryEmpty !== false &&
          (lastResult.error === 'empty stream' || isRetryableEmpty(lastResult)));
      if (!retryable) return lastResult;
    }
    return lastResult ?? errorResult('no attempt executed');
  }

  return {
    baseUrl: options.baseUrl,
    chat,
    quotaExhausted: () => quotaError !== null,
    quotaMessage: () => quotaError,
  };
}

/** HTTP 200 但没有任何可用正文/工具调用：属于可重试的空产出；finish_reason=length 是截断，不在此列。 */
function isRetryableEmpty(result: ChatResult): boolean {
  if (!result.ok || result.finishReason === 'length') return false;
  if (result.reasoning !== null && result.reasoning.trim() !== '') return false;
  return result.text.trim() === '' && result.toolCalls.length === 0;
}

async function attemptChat(url: string, options: ClientOptions, req: ChatRequest): Promise<ChatResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  // retryEmpty 是本地重试开关，置 undefined 后 JSON.stringify 会省略，绝不发给上游。
  const body = JSON.stringify({ ...req, retryEmpty: undefined, stream: req.stream === true });
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.apiKey}`,
        accept: req.stream === true ? 'text/event-stream' : 'application/json',
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await safeReadBody(response);
      return errorResult(`HTTP ${response.status}: ${truncate(errorText, 500)}`, response.status, Date.now() - started);
    }

    // 端点兼容：部分中转站无视 stream:false 强制回 SSE（实测 new-api 网关即如此）。
    // 按响应实际 content-type 分派解析器，否则非流式探针 JSON.parse 整轮失败、审计全灭；
    // 「请求非流式却被强制流式」本身是端点 spec 违规，由调用方（guard/ttft 的观测）另行记录。
    const contentType = response.headers.get('content-type') ?? '';
    if (req.stream === true || contentType.includes('text/event-stream')) {
      return await readStream(response, started);
    }
    return await readJson(response, started);
  } catch (error) {
    const durationMs = Date.now() - started;
    // 错误四分类：timeout / network / HTTP <status> / invalid JSON，让 stderr 与 finding 一眼可分辨
    if (isAbortError(error, controller)) {
      return errorResult(`timeout：${options.timeoutMs}ms 超时（含流式总时长）`, 0, durationMs);
    }
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`network：${message}`, 0, durationMs);
  } finally {
    clearTimeout(timer);
  }
}

function isAbortError(error: unknown, controller: AbortController): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true;
  const reason: unknown = controller.signal.reason;
  return reason instanceof Error && reason.name === 'AbortError';
}

async function readJson(response: Response, started: number): Promise<ChatResult> {
  const raw = await response.text();
  const durationMs = Date.now() - started;
  const parsed = parseChatCompletionJson(raw, response.status, durationMs);
  if (parsed !== null) return parsed;
  // HTTP 200 却返回 `{"error":{...}}`（中转站欠费/限流/上游熔断的常见形态）：按请求失败处理，
  // 否则会被当成「成功但空正文」，探针据此指控「未发起工具调用 / 内容不可读」= 诬告。
  const upstreamError = upstreamErrorMessage(raw);
  if (response.ok && upstreamError !== null) {
    return errorResult(`upstream error payload（HTTP ${response.status}）：${upstreamError}`, response.status, durationMs);
  }
  // 端点兼容（与 readStream 的零信号回退对称）：部分中转站把 SSE 流标成 application/json，
  // JSON.parse 必然失败 → 整轮探针全废（实测「invalid JSON response: data: {...}」）。
  // 门槛收紧到「HTTP 2xx + 响应体确有 data: 行」：非 2xx 的网关错误体一律走原 errorResult
  // （否则会被伪装成 ok 响应、绕过探针的 reject/error 分级）；event:/id:/retry: 不作触发条件，
  // 因为它们在畸形 JSON 里也容易出现。正常 JSON 与真实畸形响应行为不变。
  if (response.ok && /^\s*data:/m.test(raw)) {
    const sse = parseSseBody(raw, response.status, durationMs);
    if (sse !== null) return sse;
  }
  return errorResult(`invalid JSON response: ${truncate(raw, 300)}`, response.status, durationMs);
}

/** 从「整份已读响应体」提取上游错误载荷（宽容：允许前后空白/多行文本包裹的 JSON）。 */
function upstreamErrorMessage(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return extractErrorMessage(parsed);
  } catch {
    return null;
  }
}

/** 解析「已被完整读取」的 SSE 响应体；零信号（无正文/推理/工具调用/finish_reason）返回 null。 */
function parseSseBody(raw: string, status: number, durationMs: number): ChatResult | null {
  const parser = new SseParser();
  const agg = createSseAggregate();
  applySseEvents(agg, parser.feed(raw));
  applySseEvents(agg, parser.end());
  const upstreamError = agg.errorMessage;
  if (upstreamError !== null && !hasSseSignal(agg)) {
    return errorResult(`upstream error payload（HTTP ${status}）：${upstreamError}`, status, durationMs);
  }
  if (!hasSseSignal(agg)) return null;
  // raw 与流式路径同口径（仅供人工复核的截断原文，16KB 上限），ttftMs=null 表示「整体读取、无 TTFT 观测」
  return buildStreamResult(agg, status, durationMs, null, raw.slice(0, 16384));
}

/**
 * 解析 chat.completion 形状的 JSON 响应体。
 * 返回 null 表示「不是可解析的 chat.completion JSON」（非法 JSON / 无 choices），
 * 调用方据此区分「解析失败」与「SSE 路径的 JSON 回退无信号」。
 */
function parseChatCompletionJson(raw: string, status: number, durationMs: number): ChatResult | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed['choices'])) return null;
  const choice = parsed['choices'][0] as Record<string, unknown> | undefined;
  const message = choice && typeof choice['message'] === 'object' && choice['message'] !== null
    ? (choice['message'] as Record<string, unknown>)
    : {};
  const text = extractText(message['content']);
  const reasoning = extractText(message['reasoning_content']) + extractText(message['reasoning']);
  const finishReason = choice && typeof choice['finish_reason'] === 'string' ? (choice['finish_reason'] as string) : null;
  const { usage, reason } = validateUsage(parsed['usage']);
  const toolCalls = extractToolCalls(message['tool_calls']);
  const errorMessage = extractErrorMessage(parsed);
  // HTTP 200 + error 载荷 + 空 choices（欠费/熔断的常见形态）：按请求失败处理，
  // 否则「成功但空正文」会被探针读成「未发起工具调用」「内容不可读」= 诬告。
  // 有正文/推理/工具调用时保留有效证据（error 仅作附注，不推翻已产出的内容）。
  if (errorMessage !== null) {
    // 上游错误载荷 + 残缺正文：判为失败并把正文留作 partial 证据 —— 上层（质量题/检索）
    // 会把 !ok 的样本剔除分母，避免把「上游中断后的残句」当成模型答错（层 3 审查必修项）。
    const partial = [text, reasoning ?? ''].join(' ').trim();
    return errorResult(`upstream error payload（HTTP ${status}）：${errorMessage}`, status, durationMs, partial);
  }
  return {
    ok: true,
    status,
    finishReason,
    model: typeof parsed['model'] === 'string' && parsed['model'] !== '' ? (parsed['model'] as string) : null,
    text,
    reasoning: reasoning.length > 0 ? reasoning : null,
    usage,
    usageRejected: reason,
    attempts: 1,
    toolCalls,
    ttftMs: null,
    durationMs,
    error: null,
    raw,
  };
}

interface SseAggregate {
  text: string;
  reasoning: string;
  usage: Usage | null;
  usageRejected: UsageRejection | null;
  finishReason: string | null;
  model: string | null;
  errorMessage: string | null;
  toolAcc: Map<number, { id: string; name: string; args: string }>;
}

function createSseAggregate(): SseAggregate {
  return { text: '', reasoning: '', usage: null, usageRejected: null, finishReason: null, model: null, errorMessage: null, toolAcc: new Map() };
}

/** 累积 SSE 事件；onFirstDelta 用于流式路径打 TTFT 时间戳（整体读取的 JSON 误标路径不传）。 */
function applySseEvents(agg: SseAggregate, events: Array<{ data: string }>, onFirstDelta?: () => void): void {
  for (const event of events) {
    if (event.data === '[DONE]') continue;
    const chunk = parseStreamPayload(event.data);
    if (!chunk) continue;
    const deltaText = chunk.contentDelta;
    const deltaReasoning = chunk.reasoningDelta;
    const hasToolDelta = chunk.toolCallDeltas.length > 0;
    if (onFirstDelta !== undefined && (deltaText.length > 0 || deltaReasoning.length > 0 || hasToolDelta)) onFirstDelta();
    agg.text += deltaText;
    agg.reasoning += deltaReasoning;
    if (chunk.model !== null) agg.model = chunk.model;
    if (chunk.errorMessage !== null) agg.errorMessage = chunk.errorMessage;
    if (chunk.usage) {
      agg.usage = chunk.usage;
      agg.usageRejected = null;
    } else if (chunk.usageReason !== null) {
      agg.usageRejected = chunk.usageReason;
    }
    if (chunk.finishReason) agg.finishReason = chunk.finishReason;
    for (const delta of chunk.toolCallDeltas) mergeToolDelta(agg.toolAcc, delta);
  }
}

function hasSseSignal(agg: SseAggregate): boolean {
  return agg.finishReason !== null || agg.text.length > 0 || agg.reasoning.length > 0 || agg.toolAcc.size > 0;
}

function buildStreamResult(agg: SseAggregate, status: number, durationMs: number, ttftMs: number | null, raw = ''): ChatResult {
  const toolCalls: ToolCall[] = [...agg.toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, acc]) => ({
      id: acc.id || `call_${index}`,
      type: 'function' as const,
      function: { name: acc.name, arguments: acc.args },
    }))
    .filter((call) => call.function.name.length > 0);
  return {
    ok: true,
    status,
    finishReason: agg.finishReason,
    model: agg.model,
    text: agg.text,
    reasoning: agg.reasoning.length > 0 ? agg.reasoning : null,
    usage: agg.usage,
    usageRejected: agg.usage !== null ? null : (agg.usageRejected ?? 'missing'),
    attempts: 1,
    toolCalls,
    ttftMs,
    durationMs,
    // 'empty stream' 仅在既无 finish_reason 也无任何内容/推理/工具调用时报——
    // thinking 模型推理占满预算（content 空 + finish_reason='length'）是合法响应，不是空流；
    // 纯 reasoning 增量（即使 finish_reason 缺失）说明端点有产出，同样不算空流。
    error: agg.finishReason === null && agg.text.length === 0 && agg.reasoning.length === 0 && toolCalls.length === 0 ? 'empty stream' : null,
    raw,
  };
}

async function readStream(response: Response, started: number): Promise<ChatResult> {
  const reader = response.body?.getReader();
  if (!reader) return errorResult('response has no body', response.status, Date.now() - started);
  const decoder = new TextDecoder();
  const parser = new SseParser();
  let ttftMs: number | null = null;
  const agg = createSseAggregate();
  const rawParts: string[] = [];
  let rawLen = 0;
  let sawDone = false;
  // 原始响应体（上限 64KB）：仅供「SSE 零信号时按 JSON 解析」的端点兼容回退使用
  const bodyParts: string[] = [];
  let bodyLen = 0;

  const handle = (events: Array<{ data: string }>): void => {
    for (const event of events) {
      if (event.data === '[DONE]') {
        sawDone = true;
        continue;
      }
      if (rawLen < 16384) {
        rawParts.push(event.data);
        rawLen += event.data.length;
      }
    }
    applySseEvents(agg, events, () => {
      if (ttftMs === null) ttftMs = Date.now() - started;
    });
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const decoded = decoder.decode(value, { stream: true });
    if (bodyLen < 65536) {
      bodyParts.push(decoded);
      bodyLen += decoded.length;
    }
    handle(parser.feed(decoded));
  }
  handle(parser.end());

  // HTTP 200 + 纯 error 事件流（欠费/限流/上游熔断）：按请求失败处理，避免「空正文」被当成
  // 「未发起工具调用」「内容不可读」等诬告。
  if (agg.errorMessage !== null) {
    // 同上：错误载荷优先于残缺 delta，正文留作 partial 证据但样本判失败。
    // 注意：agg 是累积对象，extractText(agg) 只会得到空串；必须显式拼接已收正文/推理增量。
    const partial = [agg.text, agg.reasoning].filter((part) => part.length > 0).join(' ');
    return errorResult(`upstream error payload（HTTP ${response.status}）：${agg.errorMessage}`, response.status, Date.now() - started, partial);
  }

  if (!hasSseSignal(agg)) {
    // 端点兼容：部分中转站对 stream:false 也回 text/event-stream，却把整份 chat.completion
    // JSON 当作「一个不带 data: 前缀的行」发过来——SSE 解析器识别不出任何事件，会误报
    // 'empty stream'，把可用证据全丢掉（identity/quality 退化为 N/A、billing 误判缺 usage）。
    // 仅在 SSE 零信号（无 finish_reason/正文/推理/工具调用）时回退解析原始体，
    // 正常 SSE 与正常 JSON 路径行为完全不变；回退也拿不到信号则维持原 'empty stream'。
    const fallback = parseChatCompletionJson(bodyParts.join(''), response.status, Date.now() - started);
    if (fallback !== null) return fallback;
  }

  // SSE 已有正文/推理/工具增量，却既无 finish_reason 也无 [DONE]：连接在完整终止帧前关闭，
  // 属于截断流而非成功响应。绝不能因为「有正文」就把半截回答当成功（会污染 ttft 等探针）。
  if (hasSseSignal(agg) && agg.finishReason === null && !sawDone) {
    const partial = [agg.text, agg.reasoning].filter((part) => part.length > 0).join(' ');
    return errorResult(
      'stream ended without finish_reason or [DONE]（连接可能被截断）',
      response.status,
      Date.now() - started,
      partial,
    );
  }

  return buildStreamResult(agg, response.status, Date.now() - started, ttftMs, rawParts.join('\n'));
}

function mergeToolDelta(acc: Map<number, { id: string; name: string; args: string }>, delta: ToolCallDelta): void {
  const existing = acc.get(delta.index) ?? { id: '', name: '', args: '' };
  if (delta.id) existing.id = delta.id;
  if (delta.name) existing.name = delta.name;
  if (delta.arguments) existing.args += delta.arguments;
  acc.set(delta.index, existing);
}

function extractToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: ToolCall[] = [];
  for (const tc of value as Array<Record<string, unknown>>) {
    const fn = typeof tc['function'] === 'object' && tc['function'] !== null
      ? (tc['function'] as Record<string, unknown>)
      : {};
    if (typeof fn['name'] !== 'string') continue;
    calls.push({
      id: typeof tc['id'] === 'string' ? tc['id'] : `call_${calls.length}`,
      type: 'function',
      function: {
        name: fn['name'],
        arguments: typeof fn['arguments'] === 'string' ? fn['arguments'] : JSON.stringify(fn['arguments'] ?? {}),
      },
    });
  }
  return calls;
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function errorResult(message: string, status = 0, durationMs = 0, partialText = ''): ChatResult {
  return {
    ok: false,
    status,
    finishReason: null,
    model: null,
    text: partialText,
    reasoning: null,
    usage: null,
    usageRejected: null,
    attempts: 1,
    toolCalls: [],
    ttftMs: null,
    durationMs,
    error: message,
    raw: '',
  };
}

function backoffMs(attempt: number): number {
  const base = Math.min(8000, 500 * Math.pow(2, attempt - 1));
  return base + Math.floor(Math.random() * 250);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
