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
/**
 * 网关层明确拒绝的状态：请求未进入推理（503 system cpu overloaded / 429 限流即典型），
 * 通常不计费，故仅这类失败后的重试不判为计费污染。408/409/500/502/504/超时/网络错误
 * 可能服务端已执行并计费（POST 非幂等），保持污染口径。
 */
const GATEWAY_REJECTED_STATUS = new Set([429, 503]);
/** Retry-After 采纳上限：端点要求等待超过 5s 时不傻等（按本地退避节奏继续，宁可少样本不拖死审计）。 */
const RETRY_AFTER_CAP_MS = 5000;
/** httpRetries 缺省（未显式提供时）：与旧行为（=retries）不同，独立给 2 → 最多 3 次尝试。 */
const DEFAULT_HTTP_RETRIES = 2;
/** 运行级重试总预算缺省：防止端点整体过载时重试放大请求量、反而延长过载窗口。 */
const DEFAULT_RETRY_BUDGET = 24;

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
  // 运行级重试总预算（跨所有请求共享）：防止端点整体过载时重试放大请求量、反而延长过载窗口
  let retryBudgetLeft = Math.max(0, options.retryBudget ?? DEFAULT_RETRY_BUDGET);

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
    // 端点兼容：部分网关拒绝 temperature 参数（400 参数校验错）。校验失败不进入推理、不计费，
    // 故去参重发一次（不占 httpRetries/retries 预算、不构成计费污染）；成功后在结果上留披露标志。
    let effectiveReq: ChatRequest = req;
    let temperatureDropped = false;
    // 计费污染标记（请求级粘性，一旦置真不再复位）：200（哪怕空正文）或「可能已执行」的
    // 408/409/500/502/504/超时/网络错误之后才重试 → true；仅 429/503（网关层拒绝、未进入
    // 推理、通常不计费）后的重试保持 false。billing 据此区分「可能重复计费」与「上游抖动」。
    let contaminating = false;
    let httpRetriesLeft = Math.max(0, options.httpRetries ?? DEFAULT_HTTP_RETRIES);
    let emptyRetriesLeft = Math.max(0, options.retries);
    let retryAfterPendingMs: number | null = null;
    for (let attempt = 1; ; attempt += 1) {
      if (attempt > 1) {
        // Retry-After 优先（429/503 时端点给出的等待建议），超过 5s 上限按上限等待；
        // 其余按本地指数退避。两者都加抖动避免并发重试踩同一节拍。
        const waitMs = retryAfterPendingMs !== null
          ? Math.max(250, Math.min(RETRY_AFTER_CAP_MS, retryAfterPendingMs)) + Math.floor(Math.random() * 250)
          : backoffMs(attempt);
        retryAfterPendingMs = null;
        await sleep(waitMs);
      }
      emit({ seq: requestSeq, attempt, kind: 'start', promptTokensEstimate });
      lastResult = await attemptChat(chatUrl, options, effectiveReq);
      if (
        !temperatureDropped &&
        !lastResult.ok &&
        lastResult.status === 400 &&
        effectiveReq.temperature !== undefined &&
        /temperature/i.test(lastResult.error ?? '')
      ) {
        const { temperature: _dropped, ...rest } = effectiveReq;
        effectiveReq = rest as ChatRequest;
        temperatureDropped = true;
        lastResult = await attemptChat(chatUrl, options, effectiveReq);
      }
      // 记录实际尝试次数：计费探针用它识别「审计窗口内存在重试」的重复计费风险
      lastResult.attempts = attempt + (temperatureDropped ? 1 : 0);
      lastResult.temperatureDropped = temperatureDropped;
      lastResult.contaminatingRetry = contaminating;
      lastResult.retryAfterMs = lastResult.retryAfterMs ?? null;
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
      // 可重试分类（各自独立预算，运行级总预算兜底防放大）：
      // ① 非 ok 且状态码在白名单 → 扣 httpRetries 预算。429/503 为网关层拒绝（未进入推理），
      //    不污染计费口径并优先采纳 Retry-After；408/409/500/502/504 可能已执行 → 污染。
      // ② 200 空正文（空流/空 content）→ 扣 retries 预算，可能已按 prompt 计费 → 污染。
      //    finish_reason=length 的截断不在此重试（由探针升预算处理）。
      // ③ 其余错误绝不重试。attempts 如实递增。
      let retryable = false;
      if (!lastResult.ok && RETRYABLE_STATUS.has(lastResult.status)) {
        if (!GATEWAY_REJECTED_STATUS.has(lastResult.status)) {
          contaminating = true;
        } else if (lastResult.retryAfterMs !== null) {
          retryAfterPendingMs = lastResult.retryAfterMs;
        }
        retryable = httpRetriesLeft > 0;
      } else if (
        lastResult.ok &&
        req.retryEmpty !== false &&
        (lastResult.error === 'empty stream' || isRetryableEmpty(lastResult))
      ) {
        contaminating = true;
        retryable = emptyRetriesLeft > 0;
      }
      if (!retryable || retryBudgetLeft <= 0) {
        lastResult.contaminatingRetry = contaminating;
        return lastResult;
      }
      retryBudgetLeft -= 1;
      if (lastResult.ok) emptyRetriesLeft -= 1;
      else httpRetriesLeft -= 1;
    }
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
      return errorResult(
        `HTTP ${response.status}: ${truncate(errorText, 500)}`,
        response.status,
        Date.now() - started,
        '',
        parseRetryAfterMs(response.headers.get('retry-after')),
      );
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
 * 返回 null 仅表示「非法 JSON」（交给调用方走 SSE/错误体兜底）；
 * 解析成功但无 choices 时直接返回 errorResult，避免被误读成成功空正文。
 */
function parseChatCompletionJson(raw: string, status: number, durationMs: number): ChatResult | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const errorMessage = extractErrorMessage(parsed);
  // 200 + 无 choices：不可能是可用的 chat.completion。带 error 的网关信封按上游失败；
  // 既无 choices 也无 error 的畸形 JSON 同样归为请求失败，避免调用方把它误读成空正文。
  const choices = parsed['choices'];
  if (!Array.isArray(choices) || choices.length === 0) {
    const detail = Array.isArray(choices)
      ? 'response body has an empty choices array'
      : 'response body is not a chat.completion payload';
    return errorResult(`invalid chat completion payload（HTTP ${status}）：${errorMessage ?? detail}`, status, durationMs);
  }
  const choice = choices[0] as Record<string, unknown> | undefined;
  const message = choice && typeof choice['message'] === 'object' && choice['message'] !== null
    ? (choice['message'] as Record<string, unknown>)
    : {};
  const text = extractText(message['content']);
  const reasoning = extractText(message['reasoning_content']) + extractText(message['reasoning']);
  const finishReason = choice && typeof choice['finish_reason'] === 'string' ? (choice['finish_reason'] as string) : null;
  const { usage, reason } = validateUsage(parsed['usage']);
  const toolCalls = extractToolCalls(message['tool_calls']);
  // HTTP 200 + error 载荷 + 有 choices/残缺正文：按请求失败处理，
  // 否则「成功但空正文」会被探针读成「未发起工具调用」「内容不可读」= 诬告。
  // 有正文/推理/工具调用时保留有效证据（error 仅作附注，不推翻已产出的内容）。
  if (errorMessage !== null) {
    // 上游错误载荷 + 残缺正文：判为失败并把正文留作 partial 证据 —— 上层（质量题/检索）
    // 会把 !ok 的样本剔除分母，避免把「上游中断后的残句」当成模型答错（层 3 审查必修项）。
    const partial = [text, reasoning ?? ''].join(' ').trim();
    return errorResult(`upstream error payload（HTTP ${status}）：${errorMessage}`, status, durationMs, partial);
  }
  const logprobs = analyzeLogprobs(choice);
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
    contaminatingRetry: false,
    retryAfterMs: null,
    toolCalls,
    ttftMs: null,
    durationMs,
    error: null,
    raw,
    choiceCount: choices.length,
    choiceIndices: extractChoiceIndices(choices),
    choiceNonEmptyCount: countNonEmptyChoices(choices),
    logprobsTokenCount: logprobs.tokenCount,
    logprobsInvalidCount: logprobs.invalidCount,
    topLogprobsTokenCount: logprobs.topTokenCount,
    viaStream: false,
  };
}

/** 提取合法 choice index（非负整数）；缺失/非法 index 跳过，避免把畸形响应当成有效多 choice。 */
function extractChoiceIndices(choices: unknown[]): number[] {
  const indices: number[] = [];
  for (const raw of choices) {
    if (typeof raw !== 'object' || raw === null) continue;
    const index = (raw as Record<string, unknown>)['index'];
    if (typeof index === 'number' && Number.isInteger(index) && index >= 0) indices.push(index);
  }
  return indices;
}

/** 统计实际带正文/推理/工具调用的 choices 数量（空 choice 不能冒充独立候选）。 */
function countNonEmptyChoices(choices: unknown[]): number {
  let count = 0;
  for (const raw of choices) {
    if (typeof raw !== 'object' || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const message = typeof record['message'] === 'object' && record['message'] !== null
      ? (record['message'] as Record<string, unknown>)
      : {};
    const text = extractText(message['content']) || extractText(record['text']);
    const reasoning = extractText(message['reasoning_content']) + extractText(message['reasoning']);
    if (text.trim() !== '' || reasoning.trim() !== '' || extractToolCalls(message['tool_calls']).length > 0) count += 1;
  }
  return count;
}

interface LogprobsAnalysis {
  tokenCount: number | null;
  invalidCount: number | null;
  topTokenCount: number | null;
}

function isFiniteLogprob(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value <= 0;
}

function isValidTopLogprob(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry['token'] === 'string' && entry['token'] !== '' && isFiniteLogprob(entry['logprob']);
}

/**
 * 校验 choices[0].logprobs.content：token 必须非空，logprob 必须有限且 ≤0；
 * top_logprobs 每个 token 至少有一条合法条目。未携带 logprobs 返回 null。
 */
function analyzeLogprobs(choice: Record<string, unknown> | undefined): LogprobsAnalysis {
  if (choice === undefined) return { tokenCount: null, invalidCount: null, topTokenCount: null };
  const logprobs = choice['logprobs'];
  if (logprobs === null || logprobs === undefined || typeof logprobs !== 'object') {
    return { tokenCount: null, invalidCount: null, topTokenCount: null };
  }
  const content = (logprobs as Record<string, unknown>)['content'];
  if (!Array.isArray(content)) return { tokenCount: 0, invalidCount: 0, topTokenCount: 0 };
  let tokenCount = 0;
  let invalidCount = 0;
  let topTokenCount = 0;
  for (const entry of content) {
    if (typeof entry !== 'object' || entry === null) {
      invalidCount += 1;
      continue;
    }
    const record = entry as Record<string, unknown>;
    const token = record['token'];
    if (typeof token === 'string' && token !== '' && isFiniteLogprob(record['logprob'])) {
      tokenCount += 1;
    } else {
      invalidCount += 1;
    }
    const top = record['top_logprobs'];
    if (Array.isArray(top) && top.some(isValidTopLogprob)) topTokenCount += 1;
  }
  return { tokenCount, invalidCount, topTokenCount };
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
  choiceIndices: Set<number>;
  choiceContentIndices: Set<number>;
}

function createSseAggregate(): SseAggregate {
  return {
    text: '',
    reasoning: '',
    usage: null,
    usageRejected: null,
    finishReason: null,
    model: null,
    errorMessage: null,
    toolAcc: new Map(),
    choiceIndices: new Set(),
    choiceContentIndices: new Set(),
  };
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
    for (const index of chunk.choiceIndices ?? []) agg.choiceIndices.add(index);
    for (const index of chunk.choiceContentIndices ?? []) agg.choiceContentIndices.add(index);
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
    contaminatingRetry: false,
    retryAfterMs: null,
    toolCalls,
    ttftMs,
    durationMs,
    // 'empty stream' 仅在既无 finish_reason 也无任何内容/推理/工具调用时报——
    // thinking 模型推理占满预算（content 空 + finish_reason='length'）是合法响应，不是空流；
    // 纯 reasoning 增量（即使 finish_reason 缺失）说明端点有产出，同样不算空流。
    error: agg.finishReason === null && agg.text.length === 0 && agg.reasoning.length === 0 && toolCalls.length === 0 ? 'empty stream' : null,
    raw,
    // SSE 正文只聚合首个 choice；choiceIndices 用于 params 的 n 检查（端点强制流式时仍可计数），
    // 未捕获到任何合法 choice index 时保持 undefined，由探针降级为 na。
    choiceCount: agg.choiceIndices.size > 0 ? agg.choiceIndices.size : undefined,
    choiceIndices: agg.choiceIndices.size > 0 ? [...agg.choiceIndices].sort((a, b) => a - b) : undefined,
    choiceNonEmptyCount: agg.choiceIndices.size > 0 ? agg.choiceContentIndices.size : undefined,
    viaStream: true,
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

/** 错误文本落盘前脱敏：常见 API key 形态与 URL 查询参数中的凭证。 */
function redactSecrets(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, 'sk-***')
    .replace(/([?&](?:api[_-]?key|key|token|access_token)=)[^&\s]+/gi, '$1***');
}

function errorResult(message: string, status = 0, durationMs = 0, partialText = '', retryAfterMs: number | null = null): ChatResult {
  return {
    ok: false,
    status,
    finishReason: null,
    model: null,
    text: redactSecrets(partialText),
    reasoning: null,
    usage: null,
    usageRejected: null,
    attempts: 1,
    contaminatingRetry: false,
    retryAfterMs,
    toolCalls: [],
    ttftMs: null,
    durationMs,
    error: redactSecrets(message),
    raw: '',
  };
}

/** 解析 Retry-After 响应头（仅秒数形式；HTTP-date 含字母、非法值、负值一律返回 null 不采纳）。 */
function parseRetryAfterMs(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '' || /[a-zA-Z]/.test(trimmed)) return null;
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * 1000);
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
