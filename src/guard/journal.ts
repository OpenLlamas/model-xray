import { chmodSync, mkdirSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Usage, UsageRejection } from '../types.js';

/**
 * guard 审计日志条目（JSONL，每行一个 JSON 对象）。
 * 脱敏红线：仅元数据——不含对话内容、不含任何凭证（key/Authorization/token 值）、
 * errors 只允许 {code, status}，禁止落上游错误体；path 不含 query。
 */
export interface RequestEntry {
  type: 'request';
  ts: string;
  id: string;
  method: string;
  /** 请求目标 path（已去 query，已拒绝穿越路径） */
  path: string;
  /** 客户端收到的状态码；0 表示连接中断未产生响应 */
  status: number;
  stream: boolean;
  deepInspect: boolean;
  modelReq: string | null;
  modelResp: string | null;
  usage: Usage | null;
  usageRejected: UsageRejection | null;
  finishReason: string | null;
  ttftMs: number | null;
  durationMs: number;
  bytesUp: number;
  bytesDown: number;
  /** 客户端提前断连导致转发中止 */
  aborted: boolean;
  errors: Array<{ code: string; status: number }>;
}

export interface BalanceSnapshot {
  value: number;
  kind: 'spent_total' | 'balance';
  unit: string;
  endpoint: string;
}

export interface ReconcileEntry {
  type: 'reconcile';
  ts: string;
  windowStart: string;
  windowEnd: string;
  /** 窗口内完成的请求数 */
  requests: number;
  /** 窗口内 usage 缺失/无效的请求数（单列计数，不进 cost） */
  usageMissing: number;
  /** 窗口内按宣称价格与自报 usage 累加的应缴金额（与余额同单位假设） */
  cost: number;
  balanceBefore: BalanceSnapshot | null;
  balanceAfter: BalanceSnapshot | null;
  spendDelta: number | null;
  ratio: number | null;
  /** ok / warn / fail 为 ratio 分级；skipped（证据不足）/ skipped_recharge（Δ<0 充值混入）不出 ratio */
  verdict: 'ok' | 'warn' | 'fail' | 'skipped' | 'skipped_recharge';
  message: string;
}

export interface AnomalyEntry {
  type: 'anomaly';
  ts: string;
  /** 关联的请求条目 id */
  requestId: string;
  path: string;
  code: 'model_mismatch' | 'usage_invalid' | 'finish_length';
  /** warn/error 会即时 stderr 告警；info 仅落 journal 记录 */
  level: 'warn' | 'error' | 'info';
  message: string;
}

export interface FingerprintEntry {
  type: 'fingerprint';
  ts: string;
  /** 本轮主动指纹复核使用的模型名（取窗口内出现最多的请求模型） */
  model: string;
  /** 模型族指纹并集（复用 src/probes/identity.ts 的 families 语义）；空数组表示无有效自述 */
  families: string[];
  refusalRate: number | null;
  samples: number;
  /** 与上次指纹对比：none=一致或首次；warn=模型族集合完全漂移 */
  drift: 'none' | 'warn';
  message: string;
}

/** 评分卡单维度（id/score/level；观测值不进 dims，单列在 observed） */
export interface ScoreEntryDim {
  id: 'availability' | 'billing' | 'identity' | 'latency' | 'cost';
  score: number | null;
  level: 'ok' | 'warn' | 'fail' | 'na';
}

/** 评分卡快照（每 20 个已转发请求输出一次 + 退出终卡）；fromId/toId 为服务端本地 seq 生成，非客户端可控 */
export interface ScoreEntry {
  type: 'score';
  ts: string;
  fromId: string | null;
  toId: string | null;
  /** 窗口样本数（≤100） */
  requests: number;
  dims: ScoreEntryDim[];
  observed: { finishLengthRate: number | null; usageMissing: number; aborted: number };
  overall: { score: number | null; level: 'ok' | 'warn' | 'fail' | 'na' };
}

export type JournalEntry = RequestEntry | ReconcileEntry | AnomalyEntry | FingerprintEntry | ScoreEntry;

/**
 * 凭证类字段名（不区分大小写、按精确名或明确复合词匹配）。
 * 刻意不匹配 prompt_tokens/total_tokens/completion_tokens（token 后带 s 的计数计费字段必须保留）。
 */
const REDACT_EXACT = new Set([
  'authorization',
  'proxy-authorization',
  'proxy_authorization',
  'www-authenticate',
  'authentication',
  'auth',
  'apikey',
  'api-key',
  'api_key',
  'x-api-key',
  'key',
  'keys',
  'token',
  'access-token',
  'access_token',
  'refresh-token',
  'refresh_token',
  'id-token',
  'id_token',
  'secret',
  'secrets',
  'password',
  'passwd',
  'cookie',
  'set-cookie',
  'credential',
  'credentials',
  'session',
  'sessionid',
  'query',
  'querystring',
  'search',
]);

const REDACT_SUBSTRING = /(authorization|api[-_]?key|password|passwd|secret|credential|set[-_]cookie)/i;

export function isSensitiveFieldName(name: string): boolean {
  const lower = name.toLowerCase();
  if (REDACT_EXACT.has(lower)) return true;
  return REDACT_SUBSTRING.test(lower);
}

/** 深拷贝并剔除凭证类字段：键名命中即整键丢弃（值不参与判断，避免误放行）。 */
export function redactEntry<T>(value: T): T {
  return redactValue(value) as T;
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveFieldName(key)) continue;
      out[key] = redactValue(item);
    }
    return out;
  }
  return value;
}

export interface JournalWriterOptions {
  /** 可注入时钟，供轮转测试使用 */
  now?: () => Date;
  /** 可注入错误出口（默认 console.error），供单测捕获每行写入失败 */
  onError?: (message: string) => void;
}

/**
 * append-only JSONL 审计日志：
 * - appendFile 串行 promise 链，保持写入顺序；每行独立 catch（失败仅 stderr，不断链）；
 * - 按日轮转 guard-YYYYMMDD.jsonl（本地日期）；
 * - 文件创建即 0600（Windows 上 best-effort，失败静默）；
 * - 落盘前统一过 redactEntry（纵深防御：即使上游误传凭证字段也会被剔除）。
 */
export class JournalWriter {
  private readonly outDir: string;
  private readonly now: () => Date;
  private readonly onError: (message: string) => void;
  private chain: Promise<void> = Promise.resolve();
  private currentDay = '';
  private currentFile: string | null = null;
  private chmodDoneFor: string | null = null;

  constructor(outDir: string, options: JournalWriterOptions = {}) {
    this.outDir = outDir;
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError ?? ((message: string) => console.error(message));
    mkdirSync(this.outDir, { recursive: true });
  }

  get dir(): string {
    return this.outDir;
  }

  /** 当前写入目标文件（含日期），供测试断言轮转命名。 */
  get path(): string | null {
    return this.currentFile;
  }

  /** 入队一行（异步串行写，不抛出）；调用方无需 await。 */
  append(entry: JournalEntry): void {
    const line = `${JSON.stringify(redactEntry(entry))}\n`;
    const day = dayString(this.now());
    if (day !== this.currentDay || this.currentFile === null) {
      this.currentDay = day;
      this.currentFile = join(this.outDir, `guard-${day}.jsonl`);
    }
    const file = this.currentFile;
    // 链保持「永不拒绝」：catch 归入链本身，单行失败只报错，后续行照常写入（flush 也不会被毒化）
    this.chain = this.chain
      .then(async () => {
        await appendFile(file, line, { mode: 0o600 });
        if (this.chmodDoneFor !== file) {
          this.chmodDoneFor = file;
          try {
            chmodSync(file, 0o600);
          } catch {
            // Windows 等平台 chmod 语义受限：best-effort，失败不打扰用户
          }
        }
      })
      .catch((error: unknown) => {
        this.onError(`guard 审计日志写入失败（${file}）：${error instanceof Error ? error.message : String(error)}`);
      });
  }

  /** 等待全部已入队行落盘（优雅退出前调用）。 */
  async flush(): Promise<void> {
    await this.chain;
  }
}

function dayString(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}
