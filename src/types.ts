import type { TokenReference } from './token-reference.js';
import type { DeclaredPricing, PricingSource, QuotaPerUnitSource } from './pricing.js';
import type { PricingLedgerEntry, PricingLedgerWriteResult } from './pricing-ledger.js';

export type ProbeId = 'identity' | 'context' | 'billing' | 'capability' | 'quality' | 'ttft' | 'decoy';

export type ProbeStatus = 'ok' | 'insufficient' | 'error';

export type Level = 'pass' | 'warn' | 'fail' | 'unknown';

/** 基线中保存的公示价条目（只保留漂移检测需要的倍率字段，控制基线体积）。 */
export interface DeclaredPricingSnapshotModel {
  modelRatio: number;
  completionRatio: number;
  /** 缓存读取倍率（旧基线/旧账本条目没有该列 → undefined 或 null，对比时按缺字段处理）。 */
  cacheRatio?: number | null;
  /** 按次计费单价（原始字段，不做单位假设）。 */
  modelPrice?: number | null;
  /** new-api quota_type（0/缺省 = 按 token；1 = 按次）。 */
  quotaType?: number | null;
}

/**
 * 基线中的公示倍率快照：下一轮审计据此检测「站点把倍率调高」。
 * 只存可复核的最小事实（来源 origin、抓取时间、换算率、模型与分组倍率）；不存 API key。
 */
export interface DeclaredPricingSnapshot {
  origin: string;
  capturedAt: string;
  /** 快照来源；旧基线/旧账本缺省表示来源未知（legacy，不冒充 api）。 */
  source?: PricingSource;
  quotaPerUnit: number | null;
  /** quotaPerUnit 的来源；旧基线/旧账本缺省表示来源未知（无法区分站点改价与用户换口径）。 */
  quotaPerUnitSource?: QuotaPerUnitSource;
  group: string | null;
  models: Record<string, DeclaredPricingSnapshotModel>;
  groupRatio: Record<string, number>;
}

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
   * billing 置 false：空响应已带 usage，重发只会重复计 prompt 并污染实扣倍率。
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
  /** 宣称价格（每百万 tokens）；启用价格核验与公示价倍率，不读取账户余额 */
  priceInput?: number | null;
  priceOutput?: number | null;
  /** 余额前后对账（实扣倍率 = 实际扣费 ÷ 应缴金额）显式 opt-in；缺省 false：只按公示价折算，不读余额 */
  readBalance?: boolean;
  /** 缓存读命中价（缺省 = 按输入价）；二档阶梯：prompt > priceThreshold 时整单按二档价 */
  priceCachedRead?: number | null;
  priceThreshold?: number | null;
  priceInput2?: number | null;
  priceOutput2?: number | null;
  priceCachedRead2?: number | null;
  /** 站点分组（new-api group 参数；仅用于挑选展示的 group_ratio，不改变换算口径） */
  group?: string | null;
  /** 用户声明的 model_ratio / completion_ratio（与站点公示值相对差 >5% → fail） */
  expectModelRatio?: number | null;
  expectCompletionRatio?: number | null;
  /** $1 = N quota（new-api status.quota_per_unit）；用于 quota 单位余额与应缴 quota 的换算 */
  quotaPerUsd?: number | null;
  /** 公示价抓取失败时的网页兜底：价格页路径或同源绝对 URL（仅当 /api/pricing 不可用时使用） */
  declaredPricePage?: string | null;
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
  /**
   * 历史公示倍率快照（主对照源；优先级：--baseline 显式基线快照 > 本地价格账本最新条目；都没有为 null）。
   * runner 在探针执行前注入。
   */
  previousPricing?: DeclaredPricingSnapshot | PricingLedgerEntry | null;
  /** previousPricing 的来源：baseline=显式基线快照，ledger=本地价格账本。 */
  previousPricingSource?: 'baseline' | 'ledger' | null;
  /**
   * 次对照源：--baseline 与本地账本同时存在时，未作为主源的那个快照（否则 null）。
   * 两个来源都参与 billing 漂移对比——显式基线不得遮蔽账本中更近的跳变。
   */
  previousPricingAlt?: DeclaredPricingSnapshot | PricingLedgerEntry | null;
  /** previousPricingAlt 的来源：baseline=显式基线快照，ledger=本地价格账本。 */
  previousPricingAltSource?: 'baseline' | 'ledger' | null;
  /** 价格账本读取失败原因（账本读取出错时非 null）：如实披露，不阻止审计。 */
  pricingLedgerError?: string | null;
  /** 账本尾部扫描跳过的损坏行数（仅 kind=ok 时透出；>0 时 billing 披露 warn，不封顶分数）。 */
  pricingLedgerCorruptLines?: number | null;
  /** 尾部损坏（更新的位置有坏行/未终止半行）：对照基线可能不是最新快照，billing 披露须明示。 */
  pricingLedgerTailCorrupt?: boolean | null;
  /** 账本文件路径（损坏行披露文案引用）。 */
  pricingLedgerPath?: string | null;
  /** 账本条目 origin 与当前 origin 路径不一致时的披露文案（同一主机不同路径前缀）。 */
  pricingLedgerOriginNote?: string | null;
  /** runner 注入的账本写入回调：抓到公示快照后由 billing 落盘（失败绝不影响审计结论）。 */
  onPricingSnapshot?: (declared: DeclaredPricing) => PricingLedgerWriteResult;
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
