import type { Usage, UsageRejection } from '../types.js';
import { median } from '../stats.js';
import { colorize } from '../color.js';

/**
 * guard 多维实时评分卡：
 * - 窗口 = 最近 windowSize（默认 100）个「已实际发往上游」的请求样本（滚动，剔除最旧）；
 * - emit 语义：累计完成计数 totalCompleted 每达到 emitEvery（默认 20）的整数倍时输出一次
 *   （计数不复位、继续累计；重启从 0 起）；退出时 final() 无论计数必再输出一次终卡；
 * - 无定时器：完全由请求完成事件驱动。
 */

export interface ScoreSample {
  /** 客户端收到的状态码；0=中断未产生响应 */
  status: number;
  /** 客户端提前断连导致转发中止 */
  aborted: boolean;
  modelReq: string | null;
  modelResp: string | null;
  usage: Usage | null;
  usageRejected: UsageRejection | null;
  finishReason: string | null;
  /** 首字节延迟毫秒；null=非流式或未观测（流式与否由 ttftMs!=null 隐含，不单列） */
  ttftMs: number | null;
  /** true=完成深检；false=超限/降级/解析失败等自身局限，不计缺用量观测 */
  deepInspect: boolean;
}

export type ScoreLevel = 'ok' | 'warn' | 'fail' | 'na';

export type DimId = 'availability' | 'billing' | 'identity' | 'latency' | 'cost';

export interface DimensionScore {
  id: DimId;
  score: number | null;
  level: ScoreLevel;
  /** 仅 latency 携带：p50 TTFT 毫秒（供单行卡展示，不入 journal） */
  p50Ms?: number | null;
}

export interface ObservedStats {
  /** finish_reason=length 占有 finish_reason 样本的比例（0-1；无样本 null）——观测值，不计总评 */
  finishLengthRate: number | null;
  /** usage 与 usageRejected 均缺失的**已深检**样本数——观测值，不计总评（未深检=自身局限，不归因上游） */
  usageMissing: number;
  /** 客户端断连中止数——观测值，不计总评（aborted 不入可用性分母） */
  aborted: number;
}

export interface Scorecard {
  /** 窗口内最旧/最新样本的本地 seq id（服务端生成，非客户端可控）；空窗为 null */
  fromId: string | null;
  toId: string | null;
  /** 窗口样本数（≤ windowSize） */
  requests: number;
  dims: DimensionScore[];
  observed: ObservedStats;
  /** 总评 = 最差维度分；全 N/A → score null / level na（空窗同） */
  overall: { score: number | null; level: ScoreLevel };
}

export type CostVerdict = 'ok' | 'warn' | 'fail' | 'skipped' | 'skipped_recharge';

export interface ScoreboardOptions {
  /** 窗口大小，默认 100（最近 N 个已转发样本） */
  windowSize?: number;
  /** 每 N 个累计完成请求输出一次评分卡，默认 20 */
  emitEvery?: number;
  /** 输出回调（journal 落盘 + 控制台打印由调用方在此实现）；每次 emit / final 都会调用 */
  onEmit?: (card: Scorecard) => void;
}

/** 分级：≥95 ok、80-94 warn、<80 fail。 */
export function grade(score: number): ScoreLevel {
  if (score >= 95) return 'ok';
  if (score >= 80) return 'warn';
  return 'fail';
}

const COST_SCORE: Readonly<Record<CostVerdict, number | null>> = { ok: 100, warn: 70, fail: 40, skipped: null, skipped_recharge: null };

/**
 * 维度计算（纯函数，便于单测）：
 * - 可用性：非 aborted 样本中 2xx 占比；非 aborted 样本为 0 → N/A（aborted 不进分母，只进观测）；
 * - 计量：有判定样本（usage!=null || usageRejected!=null）中 usageRejected==null 占比；无判定样本 → N/A；
 * - 身份：modelReq/modelResp 均非 null 样本中相等占比；无样本 → N/A；
 * - 时延：ttftMs!=null 样本的 p50 分段（≤2000ms→100、≤5000→85、≤8000→70、否则 50）；无样本 → N/A；
 * - 成本：最近一次 setCost（多结算取最新）：ok→100、warn→70、fail→40；skipped/skipped_recharge/未注入 → N/A。
 */
export function computeDimensions(
  samples: readonly ScoreSample[],
  cost: { verdict: CostVerdict } | null,
): DimensionScore[] {
  const nonAborted = samples.filter((s) => !s.aborted);
  const availability =
    nonAborted.length === 0
      ? { id: 'availability' as const, score: null, level: 'na' as const }
      : graded('availability', pct(nonAborted.filter((s) => s.status >= 200 && s.status < 300).length, nonAborted.length));

  const judged = samples.filter((s) => s.usage !== null || s.usageRejected !== null);
  const billing =
    judged.length === 0
      ? { id: 'billing' as const, score: null, level: 'na' as const }
      : graded('billing', pct(judged.filter((s) => s.usageRejected === null).length, judged.length));

  const identified = samples.filter((s) => s.modelReq !== null && s.modelResp !== null);
  const identity =
    identified.length === 0
      ? { id: 'identity' as const, score: null, level: 'na' as const }
      : graded('identity', pct(identified.filter((s) => s.modelReq === s.modelResp).length, identified.length));

  const ttfts = samples.map((s) => s.ttftMs).filter((v): v is number => v !== null);
  let latency: DimensionScore;
  if (ttfts.length === 0) {
    latency = { id: 'latency', score: null, level: 'na', p50Ms: null };
  } else {
    const p50 = median(ttfts);
    const score = p50 <= 2000 ? 100 : p50 <= 5000 ? 85 : p50 <= 8000 ? 70 : 50;
    latency = { id: 'latency', score, level: grade(score), p50Ms: Math.round(p50) };
  }

  let costDim: DimensionScore;
  const costScore = cost === null ? null : COST_SCORE[cost.verdict] ?? null;
  costDim = costScore === null ? { id: 'cost', score: null, level: 'na' } : graded('cost', costScore);

  return [availability, billing, identity, latency, costDim];
}

/** 观测值（不计总评，输出必须标注）。 */
export function computeObserved(samples: readonly ScoreSample[]): ObservedStats {
  const withFinish = samples.filter((s) => s.finishReason !== null);
  const lengthCount = samples.filter((s) => s.finishReason === 'length').length;
  return {
    finishLengthRate: withFinish.length === 0 ? null : round4(lengthCount / withFinish.length),
    usageMissing: samples.filter((s) => s.deepInspect && s.usage === null && s.usageRejected === null).length,
    aborted: samples.filter((s) => s.aborted).length,
  };
}

export class Scoreboard {
  private readonly windowSize: number;
  private readonly emitEvery: number;
  private readonly onEmit: ((card: Scorecard) => void) | null;
  private readonly window: Array<{ id: string; sample: ScoreSample }> = [];
  private cost: { verdict: CostVerdict } | null = null;
  /** 累计完成计数：emit 后不复位、继续累计；重启从 0 起 */
  private totalCompleted = 0;

  constructor(options: ScoreboardOptions = {}) {
    this.windowSize = options.windowSize ?? 100;
    this.emitEvery = options.emitEvery ?? 20;
    this.onEmit = options.onEmit ?? null;
  }

  /** 仅由调用方在「请求已实际发往上游」时调用（本地 401/403 拒绝路径不得入窗）。 */
  record(sample: ScoreSample, requestId: string): void {
    this.totalCompleted += 1;
    this.window.push({ id: requestId, sample });
    if (this.window.length > this.windowSize) this.window.shift();
    if (this.emitEvery > 0 && this.totalCompleted % this.emitEvery === 0) this.emitNow();
  }

  /** 成本维度输入（reconciler.onSettled 接线）；多结算按调用顺序取最新。 */
  setCost(input: { ratio: number | null; verdict: CostVerdict }): void {
    this.cost = { verdict: input.verdict };
  }

  /** 当前窗口评分卡（纯读取，不触发输出）。 */
  card(): Scorecard {
    const samples = this.window.map((w) => w.sample);
    const dims = computeDimensions(samples, this.cost);
    const scored = dims.filter((d) => d.score !== null);
    const worst = scored.length === 0 ? null : Math.min(...scored.map((d) => d.score as number));
    return {
      fromId: this.window.length > 0 ? (this.window[0]?.id ?? null) : null,
      toId: this.window.length > 0 ? (this.window[this.window.length - 1]?.id ?? null) : null,
      requests: this.window.length,
      dims,
      observed: computeObserved(samples),
      overall: { score: worst, level: worst === null ? 'na' : grade(worst) },
    };
  }

  /** 退出时调用：无论计数必输出一次终卡（空窗也是一张全 N/A 卡，总评 N/A）。 */
  final(): void {
    this.emitNow();
  }

  /** 窗口内已记录样本数（测试/观测用）。 */
  size(): number {
    return this.window.length;
  }

  private emitNow(): void {
    if (this.onEmit !== null) this.onEmit(this.card());
  }
}

function pct(part: number, total: number): number {
  return Math.round((part / total) * 100);
}

function graded(id: DimId, score: number): DimensionScore {
  return { id, score, level: grade(score) };
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

const DIM_LABEL: Readonly<Record<DimId, string>> = {
  availability: '可用性',
  billing: '计量',
  identity: '身份',
  latency: '时延',
  cost: '成本',
};

const LEVEL_TAG: Readonly<Record<ScoreLevel, string>> = { ok: '[OK]', warn: '[WARN]', fail: '[FAIL]', na: '[N/A]' };
const LEVEL_NAME: Readonly<Record<ScoreLevel, string>> = { ok: 'OK', warn: 'WARN', fail: 'FAIL', na: 'N/A' };

/**
 * 单行评分卡（维度名/分数/级别/观测标注/总评全在一行，可断言）：
 * `[guard][评分] #41-#60（20 请求） 可用性 100[OK] · 计量 100[OK] · 身份 95[OK] · 时延 85[WARN](1500ms) · 成本 N/A | 观测(不计总评)：截断 12% 缺用量 2 中止 0 | 总评 WARN(85)`
 * color=true 时级别标记与总评按级别着色；color=false（默认）零 ANSI 字节。
 */
export function formatScorecard(card: Scorecard, opts?: { color?: boolean }): string {
  const color = opts?.color ?? false;
  const range = card.fromId !== null && card.toId !== null ? `#${card.fromId}-#${card.toId}` : '#-';
  const dimText = card.dims
    .map((dim) => {
      if (dim.score === null) return `${DIM_LABEL[dim.id]} N/A`;
      let text = `${DIM_LABEL[dim.id]} ${dim.score}${colorize(LEVEL_TAG[dim.level], dim.level, color)}`;
      if (dim.id === 'latency' && dim.p50Ms != null) text += `(${dim.p50Ms}ms)`;
      return text;
    })
    .join(' · ');
  const truncation = card.observed.finishLengthRate === null ? '—' : `${Math.round(card.observed.finishLengthRate * 100)}%`;
  const observedText = `观测(不计总评)：截断 ${truncation} 缺用量 ${card.observed.usageMissing} 中止 ${card.observed.aborted}`;
  const overallText =
    card.overall.score === null
      ? '总评 N/A'
      : colorize(`总评 ${LEVEL_NAME[card.overall.level]}(${card.overall.score})`, card.overall.level, color);
  return `[guard][评分] ${range}（${card.requests} 请求） ${dimText} | ${observedText} | ${overallText}`;
}
