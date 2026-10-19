import type { TokenReference } from './token-reference.js';

export type ProbeId = 'identity' | 'context' | 'billing' | 'capability' | 'quality' | 'ttft' | 'decoy';

export type ProbeStatus = 'ok' | 'insufficient' | 'error';

export type Level = 'pass' | 'warn' | 'fail' | 'unknown';

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /**
   * prompt_tokens_details.cached_tokens：缓存命中的输入 token，是 prompt_tokens 的子集；
   * null/缺省 = 上游未上报或未通过子集校验（见 sse.ts validateUsage）。
   */
  cached_tokens?: number | null;
  /**
   * completion_tokens_details.reasoning_tokens：推理 token，是 completion_tokens 的子集（已计入其中）；
   * null/缺省 = 上游未上报或未通过子集校验（见 sse.ts validateUsage）。
   */
  reasoning_tokens?: number | null;
}

/** usage 被校验拒绝的原因：missing=缺字段/非数字，negative=负值，inconsistent=total≠分项和 */
export type UsageRejection = 'missing' | 'negative' | 'inconsistent';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImagePart {
  type: 'image_url';
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' };
}

export type ContentPart = TextPart | ImagePart;

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: ToolDef[];
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  /**
   * 内部开关：本次请求是否允许 client 在 HTTP 200 空正文时重试（默认 true）。
   * billing 置 false：空响应已带 usage，重发只会重复计 prompt 并污染实测倍率。
   * 该字段仅用于本地重试决策，不会序列化进上游请求体。
   */
  retryEmpty?: boolean;
}

export interface ChatResult {
  ok: boolean;
  status: number;
  /** 首个 choice 的 finish_reason（缺失/传输失败为 null；'length' 提示输出被 max_tokens 截断） */
  finishReason: string | null;
  /** 上游回显的 model 字段（缺失为 null）：与请求模型不一致 = 换壳/换通道的直接线索 */
  model: string | null;
  text: string;
  reasoning: string | null;
  usage: Usage | null;
  /** usage 非 null 时为 null，否则为拒绝原因（missing/negative/inconsistent） */
  usageRejected: UsageRejection | null;
  /** 实际尝试次数（含首次；重试后成功则 >1），供计费污染闸判断重复计费风险 */
  attempts: number;
  /**
   * 本次调用的重试是否可能造成重复计费（请求级粘性：一旦置真不再复位；缺省/undefined 视为 false）。
   * 置真条件：①任一次尝试拿到 200 后才重试（哪怕正文为空，上游可能已按 prompt 计费）；
   * ②重试前的失败状态属于「可能已执行」的 408/409/500/502/504/超时/网络错误。
   * 保持 false：仅 429/503 这类网关层明确拒绝（未进入推理、通常不计费）后才重试。
   */
  contaminatingRetry?: boolean;
  /** 端点在响应头给出的 Retry-After（毫秒；缺失/无法解析为 null），用于重试退避对齐服务端节奏。 */
  retryAfterMs?: number | null;
  /**
   * 端点以 400 拒绝 temperature 参数后已去参重发并成功（部分网关不支持该参数）。
   * 参数校验失败不进入推理、通常不计费；该标志仅供证据/报告披露，不影响计费污染判定。
   */
  temperatureDropped?: boolean;
  toolCalls: ToolCall[];
  ttftMs: number | null;
  durationMs: number;
  error: string | null;
  raw: string;
}

export interface RequestProgressEvent {
  /** 本次 chat 调用的全局序号（从 1 开始；同一次调用的重试共用该序号） */
  seq: number;
  /** 第几次尝试（含首次；重试递增） */
  attempt: number;
  kind: 'start' | 'end';
  /** start 时为按消息内容估算的输入 token（约数）；end 时缺省 */
  promptTokensEstimate?: number | null;
  /** end 时：HTTP 状态（0 = 传输失败/超时） */
  status?: number;
  ok?: boolean;
  durationMs?: number;
  /** end 时：上游 usage.prompt_tokens（缺失/被拒为 null） */
  promptTokens?: number | null;
  error?: string | null;
}

export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  retries: number;
  /**
   * 408/409/429/5xx 的重试预算（默认 2 → 最多 3 次尝试）。与 retries（200 空正文重试）分开：
   * 网关层拒绝的 503/429 通常未进入推理且不计费，容忍更高的重试；200 空正文可能已按 prompt 计费，
   * 沿用较小预算。缺省等于 retries，保持旧调用方行为不变。
   */
  httpRetries?: number;
  /**
   * 运行级重试总预算（所有请求共享；默认 24）。防止端点整体过载时重试放大请求量、反而延长过载窗口。
   * 耗尽后不再重试，如实返回最后一次结果（由探针判未判定，而非静默跳过）。
   */
  retryBudget?: number;
  /** 每请求进度回调（CLI/WebUI 实时展示用）；回调抛错不影响审计 */
  onRequest?: (event: RequestProgressEvent) => void;
  /** 配额熔断后继续调用时抛 QuotaExhaustedError（审计用），默认为 false（返回 429 结果）。 */
  abortOnQuota?: boolean;
}

export interface OpenAIClient {
  readonly baseUrl: string;
  chat(req: ChatRequest): Promise<ChatResult>;
  /** 配额耗尽熔断状态（真实 client 提供；测试 mock 可缺省）。 */
  quotaExhausted?(): boolean;
  /** 首次触发熔断的原始错误（供报告披露；未触发为 null）。 */
  quotaMessage?(): string | null;
}

export interface Finding {
  level: 'info' | 'warn' | 'fail';
  message: string;
  evidenceIds: string[];
}

export interface ProbeOutcome {
  id: ProbeId;
  status: ProbeStatus;
  score: number | null;
  level: Level;
  headline: string;
  findings: Finding[];
  metrics: Record<string, number | string | null>;
}

export interface EvidenceRequest {
  model: string;
  stream: boolean;
  temperature: number | null;
  maxTokens: number | null;
  messageCount: number;
  lastUserPreview: string;
  /** 长请求的结尾摘要（短请求为空字符串），用于核对 needle/问题是否位于请求末尾 */
  lastUserTailPreview: string;
  lastUserChars: number;
  totalChars: number;
}

export interface EvidenceResponse {
  status: number;
  /** 上游回显的 model 字段（缺失为 null），identity 维度据此核对请求/回显是否一致 */
  model: string | null;
  textPreview: string;
  textChars: number;
  usage: Usage | null;
  /** usage 非 null 时为 null，否则为拒绝原因 */
  usageRejected: UsageRejection | null;
  /** 实际尝试次数（≥1，重试后成功则 >1） */
  attempts: number;
  /** 端点 400 拒绝 temperature 后已去参重发（披露用） */
  temperatureDropped: boolean;
  toolCallCount: number;
  /** 首个 choice 的 finish_reason；报告 JSON 序列化为 snake_case finish_reason（见 report/json.ts） */
  finishReason: string | null;
  error: string | null;
  /** 原始响应体预览（最多 8KB，按 code point 截断）；rawChars 为客户端收到的完整字符数 */
  raw: string;
  rawChars: number;
}

export interface EvidenceRecord {
  id: string;
  probe: ProbeId;
  label: string;
  request: EvidenceRequest;
  response: EvidenceResponse;
  ttftMs: number | null;
  durationMs: number;
  ts: string;
}

export interface EvidenceRecorder {
  record(entry: Omit<EvidenceRecord, 'id' | 'ts'>): EvidenceRecord;
  all(): EvidenceRecord[];
  byId(id: string): EvidenceRecord | undefined;
  size(): number;
}

export interface RunConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  claimedContext: number | null;
  expect: string[];
  deep: boolean;
  /** context 每档 needle 样本数：缺省标准 1（低成本筛查）、--deep 5；3 = 统计定论档（自动复采）。 */
  contextSamples?: number;
  /** context 确认性复采每档样本数（仅 contextSamples>=3 的标准档使用；缺省 2，--deep 3）。 */
  contextConfirmSamples?: number;
  /** context 软预算上限（与 --price-input/--price-output 同单位，按「估算输入×输入价+输出预算×输出价」逐请求预扣）；超限停发，须与价格成对提供。 */
  contextBudgetUsd?: number;
  /** billing 目标长度档位（内部/测试用；缺省标准 5 档、--deep 6 档）。 */
  billingLevels?: number[];
  seed: number;
  timeoutMs: number;
  retries: number;
  /** 408/409/429/5xx 的重试预算（缺省 2 → 最多 3 次尝试）；与 retries（200 空正文重试）分开。 */
  httpRetries?: number;
  /** 空响应（HTTP 200 无正文）时是否自动改用流式重发一次；缺省 true（可用 false 关闭，测试/特殊端点用）。 */
  streamFallback?: boolean;
  outDir: string;
  html: boolean;
  yes: boolean;
  quiet: boolean;
  /** 宣称价格（每百万 tokens，单位需与端点余额显示单位一致）；启用实测倍率探针 */
  priceInput?: number | null;
  priceOutput?: number | null;
  /** 缓存读命中价（缺省 = 按输入价）；二档阶梯：prompt > priceThreshold 时整单按二档价 */
  priceCachedRead?: number | null;
  priceThreshold?: number | null;
  priceInput2?: number | null;
  priceOutput2?: number | null;
  priceCachedRead2?: number | null;
  /** 指纹基线对比：输入基线文件 / 本轮基线输出路径 */
  baselineIn?: string | null;
  baselineOut?: string | null;
  /** 计费参考计数（历史报告对比，识别全量等比虚增；经 --token-reference 加载） */
  tokenReference?: TokenReference | null;
}

export interface Rng {
  readonly seed: number;
  next(): number;
  int(minInclusive: number, maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: readonly T[]): T[];
  bool(pTrue?: number): boolean;
  nonce(length?: number): string;
}

export interface ProbeCtx {
  client: OpenAIClient;
  cfg: RunConfig;
  rng: Rng;
  evidence: EvidenceRecorder;
}

export interface ScoreEntry {
  id: ProbeId;
  weight: number;
  score: number | null;
  level: Level;
  headline: string;
  status: ProbeStatus;
}

export interface AuditReport {
  meta: {
    tool: string;
    version: string;
    probesetVersion: string;
    assetsVersion: string;
    model: string;
    baseUrl: string;
    seed: number;
    startedAt: string;
    durationMs: number;
    nodeVersion: string;
    claimedContext: number | null;
  };
  total: number | null;
  overall: Level;
  scores: ScoreEntry[];
  outcomes: ProbeOutcome[];
  evidence: EvidenceRecord[];
  notes: string[];
}
