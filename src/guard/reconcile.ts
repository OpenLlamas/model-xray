import { DRIFT_BILLING_ABS, DRIFT_BILLING_REL } from '../baseline.js';
import { probeBalance, spendBetween, type BalanceReading } from '../balance.js';
import type { Usage } from '../types.js';
import { JournalWriter, type BalanceSnapshot, type ReconcileEntry } from './journal.js';

export type RatioVerdict = 'ok' | 'warn' | 'fail';

/**
 * 实测倍率分级（期望值 1.0），只读复用基线漂移阈值 DRIFT_BILLING_ABS/REL：
 * - |ratio-1| 同时超过绝对(0.05)与相对(0.2)带宽 → warn（与 baseline 计费斜率漂移判据同构）；
 * - ratio > 1.5 → fail（与审计实测倍率硬阈值一致：实际扣费超宣称 1.5 倍）；
 * - 其余（含小幅下偏）→ ok。
 */
export function gradeRatio(ratio: number): RatioVerdict {
  const absDelta = Math.abs(ratio - 1);
  if (ratio > 1.5) return 'fail';
  if (absDelta > DRIFT_BILLING_ABS && absDelta > DRIFT_BILLING_REL) return 'warn';
  return 'ok';
}

export interface ReconcilerOptions {
  baseUrl: string;
  apiKey: string;
  /** 宣称价格（$/M tokens），成对正数；cost = Σ(tokens × price / 1e6) */
  prices: { input: number; output: number };
  /** 对账周期毫秒数（>0；0 时不建 Reconciler） */
  intervalMs: number;
  journal: JournalWriter;
  balanceTimeoutMs?: number;
  /** 可注入余额查询（默认 probeBalance），供单测使用 */
  queryBalance?: (baseUrl: string, apiKey: string, timeoutMs: number) => Promise<BalanceReading | null>;
  now?: () => Date;
  onSummary?: (line: string) => void;
  onAlert?: (level: 'warn' | 'error', message: string) => void;
  /** 每次结算落 journal 后回调（含 skipped 类全部；评分卡成本维度经此接线）；异常由 Reconciler 内部吞掉 */
  onSettled?: (entry: ReconcileEntry) => void;
}

/**
 * 滚动对账器：余额差值 ÷ 窗口预期成本。
 * - 请求按「完成时间」归属窗口（recordCompletion 在请求 finalize 时调用）；
 * - usage 缺失/无效的请求单列计数（usageMissing），不进 cost 分母；
 * - 余额不可得 / 跨端点不同源 / 分母为 0 → skipped 事件，不出 ratio；
 * - Δbalance < 0（充值/退款混入）→ skipped_recharge 事件，不出 ratio。
 */
export class Reconciler {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly prices: { input: number; output: number };
  private readonly intervalMs: number;
  private readonly journal: JournalWriter;
  private readonly balanceTimeoutMs: number;
  private readonly query: (baseUrl: string, apiKey: string, timeoutMs: number) => Promise<BalanceReading | null>;
  private readonly now: () => Date;
  private readonly onSummary: (line: string) => void;
  private readonly onAlert: (level: 'warn' | 'error', message: string) => void;
  private readonly onSettled: ((entry: ReconcileEntry) => void) | null;

  private lastReading: BalanceReading | null = null;
  private windowStart: Date;
  private windowRequests = 0;
  private windowUsageMissing = 0;
  private windowCost = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(options: ReconcilerOptions) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.prices = options.prices;
    this.intervalMs = options.intervalMs;
    this.journal = options.journal;
    this.balanceTimeoutMs = options.balanceTimeoutMs ?? 30000;
    this.query = options.queryBalance ?? probeBalance;
    this.now = options.now ?? (() => new Date());
    this.onSummary = options.onSummary ?? ((line: string) => console.log(line));
    this.onAlert = options.onAlert ?? ((level, message) => console.error(`[guard][${level.toUpperCase()}] ${message}`));
    this.onSettled = options.onSettled ?? null;
    this.windowStart = this.now();
  }

  /** 启动时建立窗口基线余额；查询失败不致命（后续 tick 会再取，届时按 skipped 出事件）。 */
  async initialize(): Promise<void> {
    this.lastReading = await this.query(this.baseUrl, this.apiKey, this.balanceTimeoutMs);
  }

  start(): void {
    if (this.timer !== null || this.intervalMs <= 0) return;
    this.timer = setInterval(() => {
      void this.tick(false);
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 请求完成时登记：usage 有效 → 累加成本；缺失/无效 → 单列计数，不进分母。 */
  recordCompletion(usage: Usage | null): void {
    this.windowRequests += 1;
    if (usage === null) {
      this.windowUsageMissing += 1;
      return;
    }
    this.windowCost +=
      (usage.prompt_tokens * this.prices.input + usage.completion_tokens * this.prices.output) / 1e6;
  }

  /** 结算当前窗口并开新窗口。final=true 用于优雅退出的末次结算。 */
  async tick(final: boolean): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const reading = await this.query(this.baseUrl, this.apiKey, this.balanceTimeoutMs);
      const endedAt = this.now();
      const spendDelta =
        this.lastReading !== null && reading !== null ? spendBetween(this.lastReading, reading) : null;

      // 空窗静默：没有本工具请求且余额无变化（或不可比）时不产生事件，避免长期挂机刷屏
      if (
        !final &&
        this.windowRequests === 0 &&
        this.windowCost === 0 &&
        (spendDelta === null || spendDelta === 0)
      ) {
        this.roll(reading, endedAt);
        return;
      }

      const entry = this.settle(reading, spendDelta, endedAt, final);
      this.journal.append(entry);
      if (entry.verdict === 'warn' || entry.verdict === 'fail') {
        // 前缀由 onAlert 实现统一加（[guard][LEVEL]），这里只给正文
        this.onAlert(entry.verdict === 'fail' ? 'error' : 'warn', `对账：${entry.message}`);
      } else {
        this.onSummary(`[guard] 对账：${entry.message}`);
      }
      // 含 skipped 类全部回调（评分卡成本维度接线）；try/catch 防审计副作用外溢到对账主流程
      if (this.onSettled !== null) {
        try {
          this.onSettled(entry);
        } catch (error) {
          this.onSummary(
            `[guard] onSettled 回调失败（不影响对账）：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      this.roll(reading, endedAt);
    } finally {
      this.ticking = false;
    }
  }

  private settle(
    reading: BalanceReading | null,
    spendDelta: number | null,
    endedAt: Date,
    final: boolean,
  ): ReconcileEntry {
    let verdict: ReconcileEntry['verdict'];
    let ratio: number | null = null;
    let message: string;
    if (reading === null) {
      verdict = 'skipped';
      message = '余额查询不可得（未命中已知余额接口），本窗口跳过对账。';
    } else if (this.lastReading === null) {
      verdict = 'skipped';
      message = '缺少窗口前余额基线（启动查询失败），本窗口跳过对账。';
    } else if (spendDelta === null) {
      verdict = 'skipped';
      message = '两次余额读数不同源（endpoint/kind/unit 不一致），无法作差，本窗口跳过对账。';
    } else if (spendDelta < 0) {
      verdict = 'skipped_recharge';
      message = `窗口内余额不降反升（Δ=${round(spendDelta)}），疑充值/退款混入，作废本窗口不出倍率。`;
    } else if (this.windowCost <= 0) {
      verdict = 'skipped';
      message = `窗口内无有效 usage（分母为 0；缺失/无效 ${this.windowUsageMissing} 笔单列），跳过对账。`;
    } else {
      const computed = spendDelta / this.windowCost;
      if (!Number.isFinite(computed)) {
        verdict = 'skipped';
        message = `实测倍率计算越界（Δ=${round(spendDelta)}，cost=${round(this.windowCost)}），本窗口跳过对账。`;
      } else {
        ratio = computed;
        verdict = gradeRatio(computed);
        message =
          verdict === 'fail'
            ? `实测倍率 ${round(computed)} > 1.5：窗口扣费显著高于按宣称价格的应缴金额（${final ? '退出结算' : '滚动对账'}）。`
            : verdict === 'warn'
              ? `实测倍率 ${round(computed)} 偏离宣称价格带宽（|ratio-1| > ${DRIFT_BILLING_REL}），存在加价/单位错配嫌疑（${final ? '退出结算' : '滚动对账'}）。`
              : `实测倍率 ${round(computed)} 在正常带宽内（${final ? '退出结算' : '滚动对账'}）。`;
      }
    }
    return {
      type: 'reconcile',
      ts: endedAt.toISOString(),
      windowStart: this.windowStart.toISOString(),
      windowEnd: endedAt.toISOString(),
      requests: this.windowRequests,
      usageMissing: this.windowUsageMissing,
      cost: round(this.windowCost),
      balanceBefore: snapshot(this.lastReading),
      balanceAfter: snapshot(reading),
      spendDelta: spendDelta === null ? null : round(spendDelta),
      ratio: ratio === null ? null : round(ratio),
      verdict,
      message,
    };
  }

  private roll(reading: BalanceReading | null, endedAt: Date): void {
    // 读数失败（null）必须清空基线：若沿用旧基线，下个窗口的 Δ 会跨两个周期、
    // 而 cost 只含一个窗口，会把倍率系统性抬高约一倍（假阳性 fail）。
    this.lastReading = reading;
    this.windowStart = endedAt;
    this.windowRequests = 0;
    this.windowUsageMissing = 0;
    this.windowCost = 0;
  }
}

function snapshot(reading: BalanceReading | null): BalanceSnapshot | null {
  if (reading === null) return null;
  return { value: reading.value, kind: reading.kind, unit: reading.unit, endpoint: reading.endpoint };
}

function round(value: number): number {
  if (!Number.isFinite(value)) return value;
  if (Math.abs(value) >= 1e12) return value;
  return Math.round(value * 1000000) / 1000000;
}
