export type ProbeId = 'identity' | 'context' | 'billing' | 'capability' | 'quality' | 'ttft' | 'decoy';

export type ProbeStatus = 'ok' | 'insufficient' | 'error';

export type Level = 'pass' | 'warn' | 'fail' | 'unknown';

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
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
}

export interface ChatResult {
  ok: boolean;
  status: number;
  /** 首个 choice 的 finish_reason（缺失/传输失败为 null；'length' 提示输出被 max_tokens 截断） */
  finishReason: string | null;
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

export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  retries: number;
}

export interface OpenAIClient {
  readonly baseUrl: string;
  chat(req: ChatRequest): Promise<ChatResult>;
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
  lastUserChars: number;
  totalChars: number;
}

export interface EvidenceResponse {
  status: number;
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
  seed: number;
  timeoutMs: number;
  retries: number;
  outDir: string;
  html: boolean;
  yes: boolean;
  quiet: boolean;
  /** 宣称价格（每百万 tokens，单位需与端点余额显示单位一致）；启用实测倍率探针 */
  priceInput?: number | null;
  priceOutput?: number | null;
  /** 指纹基线对比：输入基线文件 / 本轮基线输出路径 */
  baselineIn?: string | null;
  baselineOut?: string | null;
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
