import { createClient } from '../client.js';
import { createEvidenceRecorder } from '../evidence.js';
import { probeIdentity } from '../probes/identity.js';
import { createRng } from '../random.js';
import type { RunConfig } from '../types.js';
import type { JournalWriter } from './journal.js';
import type { FingerprintObserver } from './server.js';

export interface FingerprintOptions {
  baseUrl: string;
  apiKey: string;
  /** 复核周期毫秒数（>0） */
  intervalMs: number;
  journal: JournalWriter;
  timeoutMs?: number;
  onSummary?: (line: string) => void;
  onAlert?: (level: 'warn' | 'error', message: string) => void;
}

/**
 * 主动指纹复核（--fingerprint-minutes>0 时启用）：
 * - 每周期从已观测的请求模型中取出现最多者，复用 src/probes/identity.ts 的身份探针直连上游；
 * - 注意：探针每轮会真实发起 3 次自述 + 1 次格式合规对话请求（会真实计费），README 已注明；
 * - 模型族指纹与上次复核完全不相交时出 warn（journal + stderr）。
 */
export class FingerprintMonitor implements FingerprintObserver {
  private readonly modelCounts = new Map<string, number>();
  private lastFamilies: Set<string> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly options: FingerprintOptions) {}

  /** 服务端在每个深检请求 finalize 时登记请求模型。 */
  noteModel(model: string): void {
    this.modelCounts.set(model, (this.modelCounts.get(model) ?? 0) + 1);
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // 若有进行中的复核，等它结束，避免进程退出撕掉未落盘的 journal 行
    while (this.running) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const model = mostSeenModel(this.modelCounts);
      if (model === null) return; // 尚无观测到任何模型：跳过本轮
      const timeoutMs = this.options.timeoutMs ?? 60000;
      const seed = (Date.now() % 2147483646) + 1;
      const cfg: RunConfig = {
        baseUrl: this.options.baseUrl,
        apiKey: this.options.apiKey,
        model,
        claimedContext: null,
        expect: [],
        deep: false,
        seed,
        timeoutMs,
        retries: 0,
        outDir: '',
        html: false,
        yes: true,
        quiet: true,
        priceInput: null,
        priceOutput: null,
        baselineIn: null,
        baselineOut: null,
      };
      const client = createClient({ baseUrl: this.options.baseUrl, apiKey: this.options.apiKey, timeoutMs, retries: 0 });
      const outcome = await probeIdentity({ client, cfg, rng: createRng(seed), evidence: createEvidenceRecorder() });

      const familiesRaw = outcome.metrics['families'];
      const families =
        typeof familiesRaw === 'string' && familiesRaw.length > 0 && familiesRaw !== 'none'
          ? familiesRaw.split(',').map((s) => s.trim()).filter(Boolean)
          : [];
      const samples = outcome.metrics['samples'];
      const refusals = outcome.metrics['refusals'];
      const sampleCount = typeof samples === 'number' ? samples : 0;
      const refusalCount = typeof refusals === 'number' ? refusals : 0;
      const refusalRate = sampleCount > 0 ? Math.round((refusalCount / sampleCount) * 1000) / 1000 : null;

      const previous = this.lastFamilies;
      this.lastFamilies = new Set(families);
      const disjoint = previous !== null && previous.size > 0 && families.length > 0 && !families.some((f) => previous.has(f));
      const drift: 'none' | 'warn' = disjoint ? 'warn' : 'none';
      const prevList = previous !== null ? [...previous].sort().join('/') : '';
      const message =
        drift === 'warn'
          ? `模型族指纹漂移：上次 [${prevList}]，本次 [${families.sort().join('/')}]，疑似模型被更换。`
          : families.length === 0
            ? '本轮指纹复核无有效自述（全部空响应/失败），不产生漂移结论。'
            : `模型族指纹一致：[${families.join('/')}]。`;
      this.options.journal.append({
        type: 'fingerprint',
        ts: new Date().toISOString(),
        model,
        families,
        refusalRate,
        samples: sampleCount,
        drift,
        message,
      });
      if (drift === 'warn') this.options.onAlert?.('warn', `指纹复核：${message}`);
      else this.options.onSummary?.(`[guard] 指纹复核：${message}`);
    } finally {
      this.running = false;
    }
  }
}

function mostSeenModel(counts: ReadonlyMap<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [model, count] of counts) {
    if (count > bestCount) {
      best = model;
      bestCount = count;
    }
  }
  return best;
}
