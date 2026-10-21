import { DRIFT_BILLING_ABS, DRIFT_BILLING_REL } from '../baseline.js';
import { probeBalance, spendBetween, type BalanceReading } from '../balance.js';
import { calibrateSpendDelta, calibrationLowConfidenceNote, firstFinitePositive } from '../calibration.js';
import { computeCostUsd, type ModelPrice } from '../gateway/pricing.js';
import type { Usage } from '../types.js';
import { JournalWriter, type BalanceSnapshot, type ReconcileEntry } from './journal.js';

export type RatioVerdict = 'ok' | 'warn' | 'fail';

/** 对账侧读数：billing 在 quota / total_usage_raw 口径下会注入可信换算元数据（guard 自身不发请求）。 */
type ReconcileReading = BalanceReading & { quotaToUsd?: number | null };

/**
 * 实扣倍率分级（期望值 1.0），只读复用基线漂移阈值 DRIFT_BILLING_ABS/REL：
 * - |ratio-1| 同时超过绝对(0.05)与相对(0.2)带宽 → warn（与 baseline 计费斜率漂移判据同构）；
 * - ratio > 1.5 → fail（与审计实扣倍率硬阈值一致：实际扣费超宣称 1.5 倍）；
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
  /** 宣称价格（$/M tokens；含可选缓存读与二档阶梯），cost = computeCostUsd(usage, prices) */
  prices: ModelPrice;
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
 * - 窗口内存在缺失/无效 usage（分母不完整，实扣倍率只会上偏）→ skipped，不出 ratio（防假阳性 fail）；
 * - 余额不可得 / 跨端点不同源 / 分母为 0 → skipped 事件，不出 ratio；
 * - Δbalance < 0（充值/退款混入）→ skipped_recharge 事件，不出 ratio。
 */
export class Reconciler {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly prices: ModelPrice;
  private readonly intervalMs: number;
  private readonly journal: JournalWriter;
  private readonly balanceTimeoutMs: number;
  private readonly query: (baseUrl: string, apiKey: string, timeoutMs: number) => Promise<BalanceReading | null>;
  private readonly now: () => Date;
  private readonly onSummary: (line: string) => void;
  private readonly onAlert: (level: 'warn' | 'error', message: string) => void;
  private readonly onSettled: ((entry: ReconcileEntry) => void) | null;

  private lastReading: ReconcileReading | null = null;
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
      // 定时器回调绝不允许未处理 rejection 击穿常驻进程：任何异常降级为一行摘要
      this.tick(false).catch((error) => {
        this.onSummary(`[guard] 对账周期异常（不影响转发）：${error instanceof Error ? error.message : String(error)}`);
      });
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
    this.windowCost += computeCostUsd(usage, this.prices);
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
    reading: ReconcileReading | null,
    spendDelta: number | null,
    endedAt: Date,
    final: boolean,
  ): ReconcileEntry {
    let verdict: ReconcileEntry['verdict'] = 'skipped';
    let ratio: number | null = null;
    let message = '本窗口跳过对账。';
    let normalizedDelta = spendDelta;
    let unitSkipMessage: string | null = null;
    let lowConfidenceNote = '';
    let settled = false;
    if (reading === null) {
      verdict = 'skipped';
      message = '余额查询不可得（未命中已知余额接口），本窗口跳过对账。';
      settled = true;
    } else if (this.lastReading === null) {
      verdict = 'skipped';
      message = '缺少窗口前余额基线（启动查询失败），本窗口跳过对账。';
      settled = true;
    } else if (spendDelta === null) {
      verdict = 'skipped';
      message = '两次余额读数不同源（endpoint/kind/unit 不一致），无法作差，本窗口跳过对账。';
      settled = true;
    } else if (!Number.isFinite(spendDelta)) {
      // NaN/Infinity 差值（接口层异常读数）单独标记，防止静默流入倍率计算或充值判定
      verdict = 'skipped';
      message = '余额差值包含非有限数值（NaN/Infinity），无法对账，本窗口跳过。';
      settled = true;
    } else if (this.lastReading.unit !== 'USD' || reading.unit !== 'USD') {
      if (this.lastReading.unit === 'total_usage_raw' && reading.unit === 'total_usage_raw') {
        // 整数/非整数 total_usage 统一走单位假设校准（与一次性审计 decideRatio 同源）：
        // 整数美分站由 cents 候选复现旧 ÷100 数学，quota 站需上下文已有换算率才能折算。
        const outcome = calibrateSpendDelta({
          before: this.lastReading,
          after: reading,
          spendDelta,
          expectedCost: this.windowCost,
        });
        if (outcome.status === 'adopted' && outcome.delta !== null) {
          normalizedDelta = outcome.delta;
          if (outcome.confidence === 'low') lowConfidenceNote = calibrationLowConfidenceNote(outcome);
        } else {
          unitSkipMessage = `实扣倍率判定作废：${outcome.message ?? 'total_usage 单位口径无法校准。'}`;
        }
      } else if (this.lastReading.unit === 'quota' && reading.unit === 'quota') {
        // guard 不新增网络请求：只用读数上下文已附着的声明式换算率（站点/CLI 预置）。
        const quotaToUsd = firstFinitePositive(this.lastReading.quotaToUsd, reading.quotaToUsd);
        if (quotaToUsd !== null) {
          normalizedDelta = spendDelta * quotaToUsd;
        } else {
          unitSkipMessage =
            `余额读数单位为 ${this.lastReading.unit ?? 'unknown'}/${reading.unit}，与宣称价既不同单位也无站点公示换算率，` +
            '无法与应缴金额作比（工具只做同单位比值，不做币种换算），本窗口跳过对账。';
        }
      } else {
        // 其余混合单位无法换算：保留原不同源/单位不可比 skip 文案。
        unitSkipMessage =
          `余额读数单位为 ${this.lastReading.unit ?? 'unknown'}/${reading.unit}，与宣称价既不同单位也无站点公示换算率，` +
          '无法与应缴金额作比（工具只做同单位比值，不做币种换算），本窗口跳过对账。';
      }
    }
    // 充值判定的噪声锚：Δ 低于读数最小刻度（resolution）的负差值是精度噪声（与审计侧分辨率
    // 噪声纪律同源），不得判充值；换算系数恒正保号，锚定 raw Δ 即覆盖全部非 USD 口径。
    // resolution 非法（NaN/负值/Infinity）一律回退 0，避免 NaN 使比较恒 false 静默漏判充值。
    const resOf = (r: BalanceReading | null): number => {
      const res = r !== null ? Number(r.resolution) : NaN;
      return Number.isFinite(res) && res > 0 ? res : 0;
    };
    const noiseFloor = Math.max(resOf(this.lastReading), resOf(reading));
    if (!settled) {
      // 判定优先级：充值（raw 符号锚定 + 分辨率噪声容差——单位无关的真经济事件）→ 窗口自身
      // 不可判（无 usage/分母不完整）→ 单位口径无法换算 → 计算倍率。单位分支放在窗口诊断
      // 之后，避免「校准失败」遮蔽「窗口根本没有有效 usage」这一更上游的真实原因。
      if (spendDelta !== null && spendDelta < -noiseFloor) {
        verdict = 'skipped_recharge';
        message = `窗口内余额不降反升（Δ=${round(normalizedDelta ?? spendDelta ?? 0)}），疑充值/退款混入，作废本窗口不出倍率。`;
      } else if (normalizedDelta === null && unitSkipMessage === null) {
        verdict = 'skipped';
        message = '余额差值不可得，本窗口跳过对账。';
      } else if (this.windowCost <= 0) {
        verdict = 'skipped';
        message = `窗口内无有效 usage（分母为 0；缺失/无效 ${this.windowUsageMissing} 笔单列），跳过对账。`;
      } else if (this.windowUsageMissing > 0) {
        // 分母不完整：余额差值含未观测 usage 请求的真实扣费，ratio 只会系统性上偏——
        // 与测试侧「ratio_contaminated 作废实测」同一纪律，绝不拿不完整窗口出判定（防假阳性 fail）
        verdict = 'skipped';
        message = `窗口内 ${this.windowUsageMissing} 笔请求缺失/无效 usage，分母不完整、实扣倍率只会上偏，作废本窗口不出倍率（缺失已单列）。`;
      } else if (unitSkipMessage !== null) {
        verdict = 'skipped';
        message = unitSkipMessage;
      } else if (normalizedDelta === null) {
        verdict = 'skipped';
        message = '余额差值不可得，本窗口跳过对账。';
      } else {
        const computed = normalizedDelta / this.windowCost;
        if (!Number.isFinite(computed)) {
          verdict = 'skipped';
          message = `实扣倍率计算越界（Δ=${round(normalizedDelta)}，cost=${round(this.windowCost)}），本窗口跳过对账。`;
        } else {
          ratio = computed;
          verdict = gradeRatio(computed);
          const suffix = lowConfidenceNote;
          message =
            verdict === 'fail'
              ? `实扣倍率 ${round(computed)} > 1.5：窗口扣费显著高于按宣称价格的应缴金额（${final ? '退出结算' : '滚动对账'}）。${suffix}`
              : verdict === 'warn'
                ? `实扣倍率 ${round(computed)} 偏离宣称价格带宽（|ratio-1| > ${DRIFT_BILLING_REL}），存在加价/单位错配嫌疑（${final ? '退出结算' : '滚动对账'}）。${suffix}`
                : `实扣倍率 ${round(computed)} 在正常带宽内（${final ? '退出结算' : '滚动对账'}）。${suffix}`;
        }
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
      spendDelta: normalizedDelta === null ? null : round(normalizedDelta),
      // rawDelta 恒记未换算原始差值，且不做圆整（round 会把极小负值舍为 -0，JSON 序列化
      // 丢符架空充值判定的 raw 符号锚定）；单位换算失败时 spendDelta 落的是 raw 值，
      // 此时 deltaUnit 记该 raw 单位，跨站点聚合必须按 deltaUnit==='USD' 归一。
      rawDelta: spendDelta === null ? null : spendDelta,
      deltaUnit:
        unitSkipMessage === null && normalizedDelta !== null ? 'USD' : this.lastReading?.unit ?? null,
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
