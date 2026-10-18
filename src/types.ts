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
  /** billing 目标长度档位（内部/测试用；缺省标准 5 档、--deep 6 档）。 */
  billingLevels?: number[];
  seed: number;
  timeoutMs: number;
  retries: number;
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
