import type { Usage, UsageRejection } from './types.js';

export interface SseEvent {
  data: string;
  event: string | null;
}

/**
 * Incremental Server-Sent Events parser for OpenAI-compatible streams.
 * Handles CRLF, multi-line data fields, partial frames across chunks.
 */
export class SseParser {
  private buffer = '';
  private dataLines: string[] = [];
  private eventName: string | null = null;

  feed(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      const event = this.consumeLine(line);
      if (event) events.push(event);
      newlineIndex = this.buffer.indexOf('\n');
    }
    return events;
  }

  /** Flush trailing buffered line at end of stream. */
  end(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.buffer.length > 0) {
      let line = this.buffer;
      if (line.endsWith('\r')) line = line.slice(0, -1);
      const event = this.consumeLine(line);
      if (event) events.push(event);
      this.buffer = '';
    }
    const last = this.flushEvent();
    if (last) events.push(last);
    return events;
  }

  private consumeLine(line: string): SseEvent | null {
    if (line === '') return this.flushEvent();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      this.dataLines.push(value);
      return null;
    }
    if (field === 'event') {
      this.eventName = value;
      return null;
    }
    return null;
  }

  private flushEvent(): SseEvent | null {
    if (this.dataLines.length === 0) {
      this.eventName = null;
      return null;
    }
    const data = this.dataLines.join('\n');
    const event: SseEvent = { data, event: this.eventName };
    this.dataLines = [];
    this.eventName = null;
    return event;
  }
}

export interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

export interface StreamChunk {
  contentDelta: string;
  reasoningDelta: string;
  toolCallDeltas: ToolCallDelta[];
  usage: Usage | null;
  /** payload 带 usage 键但被 validateUsage 拒绝时的原因；未带 usage 键为 null */
  usageReason: UsageRejection | null;
  finishReason: string | null;
  /** 响应自述模型名（网关旁路观测用；payload 未带或非字符串时为 null） */
  model: string | null;
  /** 本帧 choices 的合法 index 列表（仅 OpenAI chat.completion chunk；缺失/非法 index 跳过，不归 0） */
  choiceIndices?: number[];
  /** 本帧带正文/推理/工具调用等内容信号的 choice index 列表（用于 n 检查防止空 choice 冒充候选） */
  choiceContentIndices?: number[];
  /**
   * 上游错误载荷（HTTP 200 却带 `{"error":{...}}` 的 SSE/JSON 事件，常见于中转站欠费、限流、
   * 上游渠道熔断）。此前这类事件零信号 → 被误当作「成功但空正文」，探针据此指控
   * 「未发起工具调用 / 上下文内容不可读」；识别后按请求失败处理（不诬告）。
   */
  errorMessage: string | null;
}

/**
 * usage 三字段统一校验（非流式与流式共用，杜绝两处规则漂移）：
 * - 任一字段缺失/非有限数字/非整数 → usage null + 'missing'（token 计数物理上必须是整数，小数计费不可信）；
 * - 任一字段为负 → usage null + 'negative'；
 * - total_tokens !== prompt_tokens + completion_tokens → usage null + 'inconsistent'（疑似计费字段篡改）。
 * 核心三字段通过后安全透传 details 明细（cached/reasoning）：形状错位或违反子集不变量时对应字段为 null，
 * 绝不抛错、绝不影响拒收判定（拒收判据仍仅：缺核心字段/负值/total≠分项和）。
 */
export function validateUsage(value: unknown): { usage: Usage | null; reason: UsageRejection | null } {
  if (typeof value !== 'object' || value === null) return { usage: null, reason: 'missing' };
  const u = value as Record<string, unknown>;
  const prompt = u['prompt_tokens'];
  const completion = u['completion_tokens'];
  const total = u['total_tokens'];
  const fields = [prompt, completion, total];
  if (fields.some((v) => typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v))) {
    return { usage: null, reason: 'missing' };
  }
  if (fields.some((v) => (v as number) < 0)) {
    return { usage: null, reason: 'negative' };
  }
  if ((total as number) !== (prompt as number) + (completion as number)) {
    return { usage: null, reason: 'inconsistent' };
  }
  return {
    usage: {
      prompt_tokens: prompt as number,
      completion_tokens: completion as number,
      total_tokens: total as number,
      cached_tokens: extractDetailTokens(u['prompt_tokens_details'], 'cached_tokens', prompt as number),
      reasoning_tokens: extractDetailTokens(u['completion_tokens_details'], 'reasoning_tokens', completion as number),
    },
    reason: null,
  };
}

/**
 * 安全抽取 usage details 子字段（cached_tokens/reasoning_tokens）：
 * - details 嵌套形状错位（字符串/数组/null/缺省）→ null；
 * - 字段值不是非负整数、或超过对应核心字段总量（违反子集不变量）→ null；
 * - 任何异常形状都只降级为 null，绝不抛错。
 */
function extractDetailTokens(details: unknown, key: string, bound: number): number | null {
  if (typeof details !== 'object' || details === null || Array.isArray(details)) return null;
  const value = (details as Record<string, unknown>)[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > bound) {
    return null;
  }
  return value;
}

/** 判断单个 choice 是否带正文/推理/工具调用信号（delta 优先，兼容 message 与 legacy text）。 */
function choiceHasContentSignal(raw: Record<string, unknown>): boolean {
  const deltaValue = typeof raw['delta'] === 'object' && raw['delta'] !== null
    ? (raw['delta'] as Record<string, unknown>)
    : null;
  const messageValue = typeof raw['message'] === 'object' && raw['message'] !== null
    ? (raw['message'] as Record<string, unknown>)
    : null;
  const source = deltaValue !== null && Object.keys(deltaValue).length > 0 ? deltaValue : (messageValue ?? {});
  const text = extractText(source['content']) || extractText(raw['text']);
  const reasoning = extractText(source['reasoning_content']) + extractText(source['reasoning']);
  const toolCalls = source['tool_calls'];
  return text.trim() !== '' || reasoning.trim() !== '' || (Array.isArray(toolCalls) && toolCalls.length > 0);
}

/** Parse one SSE data payload into a normalized chunk. Returns null for non-JSON or [DONE]. */
export function parseStreamPayload(data: string): StreamChunk | null {
  if (data === '[DONE]') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const rawChoices = Array.isArray(obj['choices']) ? (obj['choices'] as unknown[]) : [];
  const choiceIndices: number[] = [];
  const choiceContentIndices: number[] = [];
  for (const raw of rawChoices) {
    if (typeof raw !== 'object' || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const index = record['index'];
    // 非法/缺失 index 不归 0：否则多个缺 index 的 choice 会被合并成同一个，
    // 让诚实流式端点在 n 检查里被误判为少返回 choice。
    if (typeof index === 'number' && Number.isInteger(index) && index >= 0) {
      choiceIndices.push(index);
      if (choiceHasContentSignal(record)) choiceContentIndices.push(index);
    }
  }
  const choice = Array.isArray(obj['choices']) ? (obj['choices'][0] as Record<string, unknown> | undefined) : undefined;
  // 端点兼容：部分中转站把完整的 chat.completion 对象塞进 SSE 的 data 帧（用 message 而非 delta），
  // 旧解析只读 delta 会漏掉正文/finish_reason，表现为「200 + usage 但 empty stream」。
  // delta 优先；delta 缺失/为空对象时才回退 message（标准流式行为完全不变）。
  const deltaValue = choice && typeof choice['delta'] === 'object' && choice['delta'] !== null
    ? (choice['delta'] as Record<string, unknown>)
    : null;
  const messageValue = choice && typeof choice['message'] === 'object' && choice['message'] !== null
    ? (choice['message'] as Record<string, unknown>)
    : null;
  const delta = deltaValue !== null && Object.keys(deltaValue).length > 0 ? deltaValue : (messageValue ?? {});

  // 兼容 legacy completions 的 choices[0].text 形态（同样可能被中转站用于 SSE 帧）。
  const content = extractText(delta['content']) || (choice !== undefined ? extractText(choice['text']) : '');
  const reasoning = extractText(delta['reasoning_content']) + extractText(delta['reasoning']);
  const toolCalls: ToolCallDelta[] = [];
  if (Array.isArray(delta['tool_calls'])) {
    for (const tc of delta['tool_calls'] as Array<Record<string, unknown>>) {
      const fn = typeof tc['function'] === 'object' && tc['function'] !== null
        ? (tc['function'] as Record<string, unknown>)
        : {};
      toolCalls.push({
        index: typeof tc['index'] === 'number' ? tc['index'] : 0,
        id: typeof tc['id'] === 'string' ? tc['id'] : undefined,
        name: typeof fn['name'] === 'string' ? fn['name'] : undefined,
        arguments: typeof fn['arguments'] === 'string' ? fn['arguments'] : undefined,
      });
    }
  }

  let usage: StreamChunk['usage'] = null;
  let usageReason: StreamChunk['usageReason'] = null;
  if ('usage' in obj) {
    const validated = validateUsage(obj['usage']);
    usage = validated.usage;
    usageReason = validated.reason;
  }

  const finishReason = choice && typeof choice['finish_reason'] === 'string' ? (choice['finish_reason'] as string) : null;
  const model = typeof obj['model'] === 'string' && obj['model'] !== '' ? (obj['model'] as string) : null;
  return { contentDelta: content, reasoningDelta: reasoning, toolCallDeltas: toolCalls, usage, usageReason, finishReason, model, errorMessage: extractErrorMessage(obj), choiceIndices, choiceContentIndices };
}

/** 提取 `error` 载荷（字符串 / {message,type,code} 对象均可）；无 error 或空消息返回 null。 */
export function extractErrorMessage(obj: Record<string, unknown>): string | null {
  const err = obj['error'];
  if (typeof err === 'string' && err.trim() !== '') return err.trim();
  if (typeof err !== 'object' || err === null) return null;
  const rec = err as Record<string, unknown>;
  const message = rec['message'];
  if (typeof message !== 'string' || message.trim() === '') return null;
  const parts = [message.trim()];
  for (const key of ['type', 'code'] as const) {
    const v = rec[key];
    if (typeof v === 'string' && v !== '') parts.push(v);
  }
  return parts.join(' | ');
}

export function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    let out = '';
    for (const part of value) {
      if (typeof part === 'object' && part !== null && typeof (part as Record<string, unknown>)['text'] === 'string') {
        out += (part as Record<string, unknown>)['text'] as string;
      }
    }
    return out;
  }
  return '';
}

// ——— Anthropic Messages 协议解析（旁路观测用；纯函数，绝不抛错） ———

/**
 * Anthropic stop_reason → 内部统一 finish_reason 口径：
 * max_tokens→'length'、end_turn/stop_sequence→'stop'、tool_use→'tool_calls'，其余原样透传；
 * 非字符串/空串 → null。注意：'length' 只表示「上游自述被 max_tokens 截断」，
 * 与网关 truncated 告警（连接截断，clientStatus==='truncated'）是两回事，绝不互相串联。
 */
export function mapAnthropicStopReason(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  switch (raw) {
    case 'max_tokens':
      return 'length';
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'tool_use':
      return 'tool_calls';
    default:
      return raw;
  }
}

function nonNegativeIntOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) return null;
  return value;
}

/** 拒收原因归类（与 validateUsage 同口径）：负整数 → negative；缺失/非数字/非整数 → missing。 */
function tokenRejectReason(value: unknown): UsageRejection {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value < 0 ? 'negative' : 'missing';
}

/**
 * Anthropic usage → 内部统一 usage（三字段映射后仍走 validateUsage 语义，细节字段非法只降级为 null）：
 * - prompt_tokens = input_tokens；message_delta 帧的 usage 只带累计 output_tokens，input 缺省
 *   （undefined/null）时沿用 priorUsage 的输入值（先到 message_start 已知输入，后到帧覆盖终值，合并才能成账）；
 *   input 存在但非法（负数/非整数）一律拒收，绝不用 priorUsage 掩盖篡改帧；
 * - completion_tokens = output_tokens（Anthropic 语义为累计值）；
 * - total_tokens = input + output（协议无 total 字段，按内部口径求和）；
 * - cached_tokens = cache_read_input_tokens（缺省 → 沿用 priorUsage 缓存值，仍缺省则 0——
 *   Anthropic 语义：未上报视为无缓存命中；与 OpenAI 路径「缺省 null」的差异系协议语义不同）；
 * - reasoning_tokens = 0（thinking token 计入 output，协议无独立字段，0 = 已知无独立计数）。
 * 核心字段缺失/非整数/负值 → usage:null + UsageRejection；绝不抛错。
 */
export function mapAnthropicUsage(raw: unknown, priorUsage?: Usage | null): { usage: Usage | null; reason: UsageRejection | null } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { usage: null, reason: 'missing' };
  const u = raw as Record<string, unknown>;
  const output = nonNegativeIntOrNull(u['output_tokens']);
  if (output === null) return { usage: null, reason: tokenRejectReason(u['output_tokens']) };
  const rawInput = u['input_tokens'];
  const inputProvided = rawInput !== undefined && rawInput !== null;
  const input = inputProvided ? nonNegativeIntOrNull(rawInput) : (priorUsage?.prompt_tokens ?? null);
  if (input === null) return { usage: null, reason: tokenRejectReason(rawInput) };
  const rawCached = u['cache_read_input_tokens'];
  const cached =
    rawCached === undefined || rawCached === null
      ? (priorUsage?.cached_tokens ?? 0)
      : nonNegativeIntOrNull(rawCached);
  return validateUsage({
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
    ...(cached === null ? {} : { prompt_tokens_details: { cached_tokens: cached } }),
    completion_tokens_details: { reasoning_tokens: 0 },
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function emptyStreamChunk(): StreamChunk {
  return {
    contentDelta: '',
    reasoningDelta: '',
    toolCallDeltas: [],
    usage: null,
    usageReason: null,
    finishReason: null,
    model: null,
    errorMessage: null,
  };
}

/** content_block_start/content_block_delta 的块序号（非负整数，缺失/非法归 0）。 */
function anthropicBlockIndex(obj: Record<string, unknown>): number {
  const index = obj['index'];
  return typeof index === 'number' && Number.isInteger(index) && index >= 0 ? index : 0;
}

/**
 * 解析一个 Anthropic Messages SSE data 帧 → 统一 StreamChunk（复用形状，下游不分叉）。
 * 覆盖帧型：
 * - message_start：取 message.model 与 message.usage（input/output/cache_read 映射，见 mapAnthropicUsage）；
 * - content_block_start：text（空 text 块开始不算内容信号——真正的正文走 text_delta）、thinking（非空才计入
 *   reasoningDelta）、tool_use（无 delta 流时也必须有内容信号：块开始即计数）；
 * - content_block_delta：text_delta→contentDelta、thinking_delta→reasoningDelta、input_json_delta→
 *   最小 toolCallDelta 条目；signature_delta 等无内容信号帧返回 null；
 * - message_delta：delta.stop_reason 映射 finishReason；usage 为累计终值，与 priorUsage（先到的
 *   message_start usage）合并成完整 usage（tee 侧「后到覆盖先到」）；
 * - error：errorMessage 非空时如实带出（上游错误载荷）。
 * ping / message_stop / content_block_stop / 未知 type / 非 JSON / [DONE] → null。
 * priorUsage：tee 侧已观测到的 usage（message_delta 帧合并输入与缓存值用）。
 * 任何畸形形状一律降级 null 或空 chunk，绝不抛错。
 */
export function parseAnthropicStreamPayload(data: string, priorUsage?: Usage | null): StreamChunk | null {
  if (data === '[DONE]') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const type = typeof obj['type'] === 'string' ? obj['type'] : '';

  if (type === 'message_start') {
    const message = asRecord(obj['message']);
    const chunk = emptyStreamChunk();
    const model = message === null ? undefined : message['model'];
    if (typeof model === 'string' && model !== '') chunk.model = model;
    if (message !== null && 'usage' in message) {
      const validated = mapAnthropicUsage(message['usage'], null);
      chunk.usage = validated.usage;
      chunk.usageReason = validated.reason;
    }
    return chunk;
  }

  if (type === 'content_block_start') {
    const block = asRecord(obj['content_block']);
    const blockType = block === null ? '' : block['type'];
    const chunk = emptyStreamChunk();
    if (blockType === 'text') {
      const text = block === null ? undefined : block['text'];
      // 空 text 块开始不算内容（真正的正文走 text_delta）；非空 text 直接作为 contentDelta 计入信号
      if (typeof text === 'string' && text !== '') chunk.contentDelta = text;
    } else if (blockType === 'thinking') {
      const thinking = block === null ? undefined : block['thinking'];
      if (typeof thinking === 'string' && thinking !== '') chunk.reasoningDelta = thinking;
    } else if (blockType === 'tool_use') {
      const id = block === null ? undefined : block['id'];
      const name = block === null ? undefined : block['name'];
      chunk.toolCallDeltas.push({
        index: anthropicBlockIndex(obj),
        id: typeof id === 'string' ? id : undefined,
        name: typeof name === 'string' ? name : undefined,
      });
    } else {
      return null; // 未知块型（如 image）：无观测信号
    }
    return chunk;
  }

  if (type === 'content_block_delta') {
    const delta = asRecord(obj['delta']);
    const deltaType = delta === null ? '' : delta['type'];
    const chunk = emptyStreamChunk();
    if (deltaType === 'text_delta') {
      const text = delta === null ? undefined : delta['text'];
      chunk.contentDelta = typeof text === 'string' ? text : '';
    } else if (deltaType === 'thinking_delta') {
      const thinking = delta === null ? undefined : delta['thinking'];
      chunk.reasoningDelta = typeof thinking === 'string' ? thinking : '';
    } else if (deltaType === 'input_json_delta') {
      const partial = delta === null ? undefined : delta['partial_json'];
      chunk.toolCallDeltas.push({
        index: anthropicBlockIndex(obj),
        arguments: typeof partial === 'string' ? partial : undefined,
      });
    } else {
      return null; // signature_delta 等：无内容信号
    }
    return chunk;
  }

  if (type === 'message_delta') {
    const delta = asRecord(obj['delta']);
    const chunk = emptyStreamChunk();
    chunk.finishReason = mapAnthropicStopReason(delta === null ? null : delta['stop_reason']);
    if ('usage' in obj) {
      const validated = mapAnthropicUsage(obj['usage'], priorUsage ?? null);
      chunk.usage = validated.usage;
      chunk.usageReason = validated.reason;
    }
    return chunk;
  }

  if (type === 'error') {
    const chunk = emptyStreamChunk();
    chunk.errorMessage = extractErrorMessage(obj);
    return chunk;
  }

  return null;
}

/**
 * 非流式 Anthropic message.content[] 是否含内容信号（与流式首内容口径对齐）：
 * 非空 text / 非空 thinking / 任一 tool_use 块（text 块拼接为空不算内容）。
 */
export function anthropicContentHasSignal(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  for (const block of content) {
    const record = asRecord(block);
    if (record === null) continue;
    if (record['type'] === 'text' && typeof record['text'] === 'string' && record['text'] !== '') return true;
    if (record['type'] === 'thinking' && typeof record['thinking'] === 'string' && record['thinking'] !== '') return true;
    if (record['type'] === 'tool_use') return true;
  }
  return false;
}

// ——— OpenAI Responses 协议解析（旁路观测用；纯函数，绝不抛错） ———

/**
 * Responses usage → 内部统一 usage（与 Anthropic 路径同口径走 validateUsage，细节字段非法只降级）：
 * - prompt_tokens = input_tokens；completion_tokens = output_tokens（Responses 语义均为累计终值）；
 * - total_tokens = 上游携带则原样交 validateUsage（total≠分项和 → 'inconsistent' 拒收）；缺失时按 input+output 补足；
 * - cached_tokens = input_tokens_details.cached_tokens、reasoning_tokens = output_tokens_details.reasoning_tokens
 *   （details 形状错位/越界只置 null，不拒整包）。
 * 核心字段缺失/非整数/负值 → usage:null + UsageRejection；绝不抛错。
 */
export function mapResponsesUsage(raw: unknown): { usage: Usage | null; reason: UsageRejection | null } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { usage: null, reason: 'missing' };
  const u = raw as Record<string, unknown>;
  const input = nonNegativeIntOrNull(u['input_tokens']);
  if (input === null) return { usage: null, reason: tokenRejectReason(u['input_tokens']) };
  const output = nonNegativeIntOrNull(u['output_tokens']);
  if (output === null) return { usage: null, reason: tokenRejectReason(u['output_tokens']) };
  const rawTotal = u['total_tokens'];
  const total = rawTotal === undefined || rawTotal === null ? input + output : rawTotal;
  return validateUsage({
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: total,
    prompt_tokens_details: u['input_tokens_details'],
    completion_tokens_details: u['output_tokens_details'],
  });
}

/** output_index 取非负整数（缺失/非法归 0），与 Anthropic 的块序号同口径。 */
function responsesOutputIndex(obj: Record<string, unknown>): number {
  const index = obj['output_index'];
  return typeof index === 'number' && Number.isInteger(index) && index >= 0 ? index : 0;
}

/**
 * 解析一个 OpenAI Responses SSE data 帧 → 统一 StreamChunk（复用形状，下游不分叉）。
 * 覆盖帧型（载荷多在 `response` 包装对象内）：
 * - response.created / in_progress / queued：取 response.model；
 * - response.output_text.delta：取 delta（仅字符串；非字符串记空串，绝不伪造内容信号）；
 * - response.reasoning_summary_text.delta / response.reasoning_text.delta：取 delta 为 reasoningDelta；
 * - response.output_item.added：item.type='function_call' 时记最小 toolCallDelta（块开始即计数），其余类型无信号；
 * - response.function_call_arguments.delta：取 delta 为工具参数增量；
 * - response.completed / response.incomplete：usage 经 mapResponsesUsage；completed → finish_reason='stop'；
 *   incomplete → incomplete_details.reason 映射（max_output_tokens→'length'，其余非空 string 原样）；
 * - response.failed：response.error.message 非空时如实带出（finish_reason 保持 null，失败语义不借 finish_reason 表达）；
 * - 顶层 type='error'：message（缺失时回退 error 载荷）如实带出；
 * - [DONE] / 坏 JSON / 未知 type → null。任何畸形形状一律降级 null 或空 chunk，绝不抛错。
 */
export function parseResponsesStreamPayload(data: string): StreamChunk | null {
  if (data === '[DONE]') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const type = typeof obj['type'] === 'string' ? obj['type'] : '';
  const response = asRecord(obj['response']);

  if (type === 'response.created' || type === 'response.in_progress' || type === 'response.queued') {
    const chunk = emptyStreamChunk();
    const model = response === null ? undefined : response['model'];
    if (typeof model === 'string' && model !== '') chunk.model = model;
    return chunk;
  }

  if (type === 'response.output_text.delta') {
    const chunk = emptyStreamChunk();
    chunk.contentDelta = typeof obj['delta'] === 'string' ? obj['delta'] : '';
    return chunk;
  }

  if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
    const chunk = emptyStreamChunk();
    chunk.reasoningDelta = typeof obj['delta'] === 'string' ? obj['delta'] : '';
    return chunk;
  }

  if (type === 'response.output_item.added') {
    const item = asRecord(obj['item']);
    if (item === null || item['type'] !== 'function_call') return null; // 其余 item 类型（message/reasoning/…）无观测信号
    const chunk = emptyStreamChunk();
    const callId = item['call_id'];
    const name = item['name'];
    chunk.toolCallDeltas.push({
      index: responsesOutputIndex(obj),
      id: typeof callId === 'string' ? callId : undefined,
      name: typeof name === 'string' ? name : undefined,
    });
    return chunk;
  }

  if (type === 'response.function_call_arguments.delta') {
    const chunk = emptyStreamChunk();
    const delta = obj['delta'];
    chunk.toolCallDeltas.push({
      index: responsesOutputIndex(obj),
      arguments: typeof delta === 'string' ? delta : undefined,
    });
    return chunk;
  }

  if (type === 'response.completed' || type === 'response.incomplete') {
    const chunk = emptyStreamChunk();
    if (response !== null) {
      const model = response['model'];
      if (typeof model === 'string' && model !== '') chunk.model = model;
      if ('usage' in response) {
        const mapped = mapResponsesUsage(response['usage']);
        chunk.usage = mapped.usage;
        chunk.usageReason = mapped.reason;
      }
    }
    if (type === 'response.completed') {
      chunk.finishReason = 'stop';
    } else {
      const details = response === null ? null : asRecord(response['incomplete_details']);
      const reason = details === null ? undefined : details['reason'];
      if (reason === 'max_output_tokens') chunk.finishReason = 'length';
      else if (typeof reason === 'string' && reason !== '') chunk.finishReason = reason;
    }
    return chunk;
  }

  if (type === 'response.failed') {
    const chunk = emptyStreamChunk();
    const error = response === null ? null : asRecord(response['error']);
    const message = error === null ? undefined : error['message'];
    if (typeof message === 'string' && message.trim() !== '') chunk.errorMessage = message.trim();
    return chunk;
  }

  if (type === 'error') {
    const chunk = emptyStreamChunk();
    const message = obj['message'];
    chunk.errorMessage = typeof message === 'string' && message.trim() !== '' ? message.trim() : extractErrorMessage(obj);
    return chunk;
  }

  return null;
}

/**
 * 非流式 Responses output[] 是否含内容信号（与流式首内容口径对齐）：
 * message 携带非空 output_text 文本，或任一 function_call 项（空 message/其他类型不算）。
 */
export function responsesContentHasSignal(output: unknown): boolean {
  if (!Array.isArray(output)) return false;
  for (const item of output) {
    const record = asRecord(item);
    if (record === null) continue;
    if (record['type'] === 'function_call') return true;
    if (record['type'] !== 'message') continue;
    const content = record['content'];
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const partRecord = asRecord(part);
      if (partRecord !== null && partRecord['type'] === 'output_text' && typeof partRecord['text'] === 'string' && partRecord['text'] !== '') return true;
    }
  }
  return false;
}
