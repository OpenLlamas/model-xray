// src/calibration.ts — total_usage_raw 读数的单位口径校准。
// 审计动机：/dashboard/billing/usage 的 total_usage 在不同站点刻度不一（OpenAI 整数美分 schema
// 的站点给整数、部分中转站直接给主单位数值或自造 quota 数值）。审计不可能对每家站点的字段含义做假设，
// 但也不能因为口径猜错就放过「按 1.5 倍率收钱」——这里把三种可能的换算口径同时摆出来，用
// 应缴金额作为锚做一次可复核的对齐，而不是先入为主地认定一个单位。
//
// 反向边界（校准不等于免责）：单位口径是假设，假设可以被用来「洗白」同向暗扣。若胜出倍率本身
// 已明显 >1（超过可信带下沿阈值），无论哪种口径都是虚高 → 正常判罚；只有在倍率接近 1 且存在
// 「更小口径是极端虚高」这一无法用应缴额排除的备选解释时，才按 N/A（不判定）收口并要求人工复核，
// 避免把疑点洗成合格，也避免把口径歧义误报成造假。

/**
 * 单位假设的三种刻度：分位（×0.01）/同单位（×1）/quota（需站点公示换算率）。
 * 这里是「刻度」假设而非「币种」假设：×1 候选的含义就是「读数已经与宣称价同一单位」，
 * 无论该单位是美元、人民币还是站方自造额度，倍率判定都不依赖币种本身。
 */
export type CalibrationUnit = 'cents' | 'usd' | 'quota';

/** 刻度假设的中文名（报告与 finding 文案用）。 */
const UNIT_LABELS: Record<CalibrationUnit, string> = { cents: '分位(×0.01)', usd: '同单位(×1)', quota: 'quota(×换算率)' };

/** 采信结果的置信档：high = 有可核验的声明式元数据或无歧义；low = 同向虚高形态下按最接近口径采信。 */
export type CalibrationConfidence = 'high' | 'low';

/** 候选刻度（换算前的假设）：factor 把 raw Δ 换算成与宣称价同一单位。 */
export interface CalibrationCandidate {
  unit: CalibrationUnit;
  factor: number;
}

/** 候选口径 + 校准结果：delta 为换算后的扣费额，ratio 为相对应缴金额的倍率。 */
export interface CalibrationHypothesis extends CalibrationCandidate {
  delta: number;
  ratio: number;
}

/**
 * 参与校准的读数最小契约：balance.ts 的 BalanceReading + 计费侧注入的可信元数据。
 * 用结构化最小契约而非直接引用 BalanceReading，是为了让余额读数上附加的校准元数据
 * （integerCents / quotaToUsd）与换算逻辑解耦——校准只读这两个标记，不关心读数怎么来的。
 */
export interface CalibrationReading {
  /** 原始读数单位；只有 'total_usage_raw' 口径才可校准。 */
  unit: string;
  /** 读数最小分辨率（与 value 同单位）：校准后必须按同比例缩放，否则噪声判断会用错粒度。 */
  resolution?: number;
  /** 读数取自 OpenAI 整数美分 schema（可信元数据：整数读数 + 美分 schema → 口径可核验）。 */
  integerCents?: boolean;
  /** quota→计价单位 换算率（1 个计价单位 = ? quota，new-api 取 1/quota_per_unit）；缺省则没有 quota 刻度假设。 */
  quotaToUsd?: number | null;
}

/** calibrateSpendDelta 的入参：前后两次读数 + 实测扣费 Δ + 应缴金额锚。 */
export interface CalibrateSpendDeltaArgs {
  before: CalibrationReading;
  after: CalibrationReading;
  /** 实测扣费差额（原始 total_usage 读数之差，尚未按任何口径换算）。 */
  spendDelta: number;
  /** 按 token 用公示价算出的应缴金额（与宣称价同单位）；<=0 或非有限 → 无法作为锚。 */
  expectedCost: number;
}

/** 各状态共有的字段。 */
interface CalibrationOutcomeBase {
  /** 胜出口径名；未走到择近阶段（impossible）为 null。 */
  unit: CalibrationUnit | null;
  /** 校准后的读数分辨率（原始分辨率 × 胜出口径系数）。 */
  resolution: number;
  /** 采信置信档；未采信（impossible/out_of_band/ambiguous）为 null。 */
  confidence: CalibrationConfidence | null;
  /** 全部通过形状校验的候选口径（按 cents → usd → quota 顺序，报告用它展示证据链）。 */
  hypotheses: CalibrationHypothesis[];
  /** 不判定原因文案；采信成功为 null。 */
  message: string | null;
}

/**
 * 校准结论（按 status 判别）：
 * - adopted：采信某口径的换算结果（delta 为换算后扣费额）；
 * - out_of_band：所有候选口径的倍率都超出可信带 [0.1,10]，无法区分单位错配与真实超额计费；
 * - ambiguous：口径存在结构性歧义（胜出与备选同为虚高方向），为防遮蔽暗扣而不判定；
 * - impossible：输入不足以校准（非 raw 口径 / Δ<=0 / 无有效应缴额 / 无任何有效候选）。
 */
export type CalibrationOutcome =
  | (CalibrationOutcomeBase & { status: 'impossible'; delta: null; unit: null })
  | (CalibrationOutcomeBase & { status: 'out_of_band'; delta: null })
  | (CalibrationOutcomeBase & { status: 'ambiguous'; delta: null })
  | (CalibrationOutcomeBase & { status: 'adopted'; delta: number; unit: CalibrationUnit; confidence: CalibrationConfidence });

/** 取第一个有限正数（quota→USD 换算率可能只挂在前后某一个读数上）。 */
export function firstFinitePositive(...values: Array<number | null | undefined>): number | null {
  for (const value of values) {
    if (value !== undefined && value !== null && Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

/** 校准失败文案的倍率展示：>=1 用 3 位小数，[0.001,1) 保留 4 位小数，更小用有效数字避免显示成 0。 */
export function formatCalibrationRatio(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Math.abs(value) >= 1) return String(Math.round(value * 1000) / 1000);
  if (Math.abs(value) >= 0.001) return String(Math.round(value * 10000) / 10000);
  return value.toPrecision(3);
}

/** 候选证据链的紧凑展示（metrics 用）：按候选顺序列出未被过滤的口径与比值。 */
export function formatCalibrationCandidates(hypotheses: readonly CalibrationHypothesis[]): string {
  return hypotheses.map((hypothesis) => `${hypothesis.unit}=${formatCalibrationRatio(hypothesis.ratio)}`).join(';');
}

/** 低置信采信提示：胜出读数同为虚高方向，极端虚高的备选口径无法用应缴额排除。 */
export function calibrationLowConfidenceNote(outcome: CalibrationOutcome): string {
  const alts = outcome.hypotheses.filter((hypothesis) => hypothesis.unit !== outcome.unit && hypothesis.ratio >= 10);
  const list = alts.map((hypothesis) => `${hypothesis.unit}=${formatCalibrationRatio(hypothesis.ratio)}`).join('、');
  return `（单位校准置信较低：${list} 口径下为极端虚高形态，同为虚高方向故按最接近口径采信；请人工核对账单单位后复核）`;
}

/**
 * total_usage_raw 读数的刻度假设校准：以应缴金额为锚，在分位（×0.01）/同单位（×1）/quota（需可用
 * 换算率）三种刻度中按 |ln(倍率)| 择近。刻度 ≠ 币种：×1 候选即「读数已与宣称价同单位」。
 *
 * 防遮蔽：胜出倍率在 [0.1,10] 带内也未必可信——若其他口径的备选解释是「极端虚高」（ratio>=10），
 * 且胜出口径不是可核验的声明式元数据（整数美分 schema / quota 公示换算率），则同向虚高可能是暗扣
 * 被单位假设「洗白」；此时只有胜出倍率明显 >1.1（本身已判罚）才低置信采信，否则结构性歧义 N/A。
 */
export function calibrateSpendDelta(args: CalibrateSpendDeltaArgs): CalibrationOutcome {
  const { before, after, spendDelta, expectedCost } = args;
  const resolution = Math.max(
    Number.isFinite(before.resolution) ? (before.resolution ?? 0) : 0,
    Number.isFinite(after.resolution) ? (after.resolution ?? 0) : 0,
  );
  // 调用方只在 raw 对且 Δ>0 时进入；不满足时按 impossible 收口，避免误采信。
  if (before.unit !== 'total_usage_raw' || after.unit !== 'total_usage_raw' || !(spendDelta > 0)) {
    return {
      status: 'impossible',
      delta: null,
      unit: null,
      resolution,
      confidence: null,
      hypotheses: [],
      message: 'total_usage 刻度无法校准（Δ 无法按分位/同单位/quota 任一假设换算为有效扣费）：本次不判定，请人工核对账单。',
    };
  }
  if (!(expectedCost > 0) || !Number.isFinite(expectedCost)) {
    return {
      status: 'impossible',
      delta: null,
      unit: null,
      resolution,
      confidence: null,
      hypotheses: [],
      message: '无有效 usage 记录，无法估算应缴金额，实测倍率无法计算。',
    };
  }
  const candidates: CalibrationCandidate[] = [
    { unit: 'cents', factor: 0.01 },
    { unit: 'usd', factor: 1 },
  ];
  const quotaRate = firstFinitePositive(before.quotaToUsd, after.quotaToUsd);
  if (quotaRate !== null) candidates.push({ unit: 'quota', factor: quotaRate });
  const hypotheses: CalibrationHypothesis[] = [];
  for (const candidate of candidates) {
    const delta = spendDelta * candidate.factor;
    if (!Number.isFinite(delta) || delta <= 0) continue;
    const ratio = delta / expectedCost;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    hypotheses.push({ ...candidate, delta, ratio });
  }
  if (hypotheses.length === 0) {
    return {
      status: 'impossible',
      delta: null,
      unit: null,
      resolution,
      confidence: null,
      hypotheses,
      message: 'total_usage 刻度无法校准（Δ 无法按分位/同单位/quota 任一假设换算为有效扣费）：本次不判定，请人工核对账单。',
    };
  }
  // |ln(ratio)| 最小 = 离「与应缴额一致」最近的刻度；平局保留候选顺序靠前者（分位优先）。
  const winner = hypotheses.reduce((best, current) =>
    Math.abs(Math.log(current.ratio)) < Math.abs(Math.log(best.ratio)) ? current : best,
  );
  const calibratedResolution = resolution * winner.factor;
  if (winner.ratio < 0.1 || winner.ratio > 10) {
    return {
      status: 'out_of_band',
      delta: null,
      unit: winner.unit,
      resolution: calibratedResolution,
      confidence: null,
      hypotheses,
      message: `total_usage 单位口径无法校准（${hypotheses
        .map((hypothesis) => `${UNIT_LABELS[hypothesis.unit]}口径倍率 ${formatCalibrationRatio(hypothesis.ratio)}`)
        .join('、')} 均超出可信带 [0.1,10]）：无法区分单位错配与真实超额计费，本次不判定，请人工核对账单。`,
    };
  }
  // 可信元数据：OpenAI 整数美分 schema 的整数读数，或站点/用户声明的 quota 换算率。
  const trusted =
    (winner.unit === 'cents' && before.integerCents === true && after.integerCents === true) || winner.unit === 'quota';
  const extremeAlts = hypotheses.filter((hypothesis) => hypothesis !== winner && hypothesis.ratio >= 10);
  if (trusted || extremeAlts.length === 0) {
    return {
      status: 'adopted',
      delta: winner.delta,
      unit: winner.unit,
      resolution: calibratedResolution,
      confidence: 'high',
      hypotheses,
      message: null,
    };
  }
  if (winner.ratio > 1.1) {
    return {
      status: 'adopted',
      delta: winner.delta,
      unit: winner.unit,
      resolution: calibratedResolution,
      confidence: 'low',
      hypotheses,
      message: null,
    };
  }
  return {
    status: 'ambiguous',
    delta: null,
    unit: winner.unit,
    resolution: calibratedResolution,
    confidence: null,
    hypotheses,
    message:
      `total_usage 单位口径存在歧义：按${UNIT_LABELS[winner.unit]}口径倍率为 ${formatCalibrationRatio(winner.ratio)}，` +
      `但按${extremeAlts
        .map((hypothesis) => `${UNIT_LABELS[hypothesis.unit]}口径倍率为 ${formatCalibrationRatio(hypothesis.ratio)}`)
        .join('、')}（极端虚高形态），两者无法用应缴额区分，为防遮蔽暗扣本次不判定；` +
      '请人工核对账单单位，并建议在账户静默窗口（无并发消费）复测。',
  };
}
