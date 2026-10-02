export type ProbeId = 'identity' | 'context' | 'billing' | 'capability' | 'quality' | 'ttft' | 'decoy';

export type ProbeStatus = 'ok' | 'insufficient' | 'error';

export type Level = 'pass' | 'warn' | 'fail' | 'unknown';

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

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
  text: string;
  reasoning: string | null;
  usage: Usage | null;
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
  toolCallCount: number;
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
