import type { Level, ProbeId, ProbeOutcome, ScoreEntry } from './types.js';
import { clampScore } from './stats.js';

export const WEIGHTS: Record<ProbeId, number> = {
  billing: 25,
  quality: 20,
  identity: 10,
  context: 15,
  capability: 10,
  params: 10,
  // TTFT 仅观测，不参与总分；权重必须为 0，避免未来误接分数时把观测项算进可信度。
  ttft: 0,
  decoy: 0,
};

export const PROBE_ORDER: readonly ProbeId[] = ['identity', 'context', 'billing', 'capability', 'params', 'quality', 'ttft'];

export const HARD_RED: ReadonlySet<ProbeId> = new Set<ProbeId>(['billing', 'capability', 'context', 'quality']);

const HARD_RED_CAP = 45;

/**
 * 实锤封顶：fail 档位只由实测硬证据产生（档位已定罪），定罪维度不保留及格分——
 * 分项分一律压到该值（如换芯实锤时 billing 残余 usage 形状分 70 会被压到 45），
 * hardFail（计费/身份实锤）时可信度总分同样封顶到该值：结论「不通过」配上
 * 「总分 82」违反常理，定罪必须同时体现在档位与分数上。
 */
export const FAIL_LEVEL_SCORE_CAP = 45;

/** 最低评分覆盖率：低于该比例不出总分（避免「只测了 billing 就报 96」）。 */
export const MIN_COVERAGE = 0.6;

export interface ScoreScope {
  /** 本轮是否提供 --claimed-context（未提供时 context 不计入覆盖率分母）。 */
  claimedContext?: boolean;
  /** 本轮声明需要核验的能力（空数组=未声明，capability 不计入覆盖率分母）。 */
  expectedCapabilities?: readonly string[];
}

/** capability 被证伪（存在 fail 级异常）时的可信度总分上限：标称能力实测答错/被明确拒绝，一票压制。 */
export const CAPABILITY_FALSIFIED_CAP = 60;

export interface ScoreResult {
  total: number | null;
  overall: Level;
  scores: ScoreEntry[];
  notes: string[];
}

export function computeTotal(outcomes: readonly ProbeOutcome[], scope: ScoreScope = {}): ScoreResult {
  const notes: string[] = [];
  const scores: ScoreEntry[] = [];

  for (const id of PROBE_ORDER) {
    const outcome = outcomes.find((o) => o.id === id);
    if (!outcome) continue;
    scores.push({
      id: outcome.id,
      weight: WEIGHTS[outcome.id],
      score: outcome.score,
      level: outcome.level,
      headline: outcome.headline,
      status: outcome.status,
    });
  }

  // 常理封顶：定罪维度不保留及格分。fail 档位 = 实测硬证据定罪，该维度即使其余检查
  // （usage 形状等）仍通过，分项分也不得停在及格区，否则「billing FAIL 70」读起来像及格。
  const failCapped = scores.filter(
    (s) => s.level === 'fail' && s.score !== null && s.score > FAIL_LEVEL_SCORE_CAP,
  );
  for (const s of failCapped) s.score = FAIL_LEVEL_SCORE_CAP;
  if (failCapped.length > 0) {
    notes.push(
      `实锤封顶（${failCapped.map((s) => s.id).join('、')} fail）：定罪维度分项分上限 ${FAIL_LEVEL_SCORE_CAP}，不保留及格分。`,
    );
  }

  // 覆盖率分母只包含「本轮实际声称/应测」的维度：未提供 --claimed-context、--expect none
  // 属于用户主动不测，不应被当成「证据缺失」；反之 quality/billing 是每轮必测的核心维度。
  const contextInScope = scope.claimedContext ?? true;
  const capabilityInScope = scope.expectedCapabilities === undefined ? true : scope.expectedCapabilities.length > 0;
  const inScope = (id: ProbeId): boolean => {
    if (id === 'context') return contextInScope;
    if (id === 'capability') return capabilityInScope;
    return WEIGHTS[id] > 0;
  };
  const scopedScores = scores.filter((s) => inScope(s.id));

  // Number.isFinite 守卫：NaN/Infinity 一旦混入按未判定处理（入 unscorable note），
  // 绝不让其进入对数聚合后被 clampScore 洗成总分 0 的静默错误。
  const isScorable = (s: ScoreEntry): boolean =>
    s.status === 'ok' && typeof s.score === 'number' && Number.isFinite(s.score);
  const scorable = scopedScores.filter(isScorable);
  const unscorable = scopedScores.filter((s) => !isScorable(s));

  // 标称能力被证伪：capability findings 存在 fail 级异常（真实答错或端点明确拒绝）。
  // fail 只由实测证据产生（429/超时/5xx/starved 全走 warn/na），故此条件足以定「证伪」。
  const capabilityFalsified = outcomes.some(
    (o) => o.id === 'capability' && o.findings.some((f) => f.level === 'fail'),
  );

  // 整体不通过（fail）只由两类实锤触发：计费维度 fail（倍率/计量造假、乱收费）、
  // 身份维度 fail（明显换壳：自述族矛盾、基线指纹漂移）。
  // 其余维度（上下文/质量/能力）的 fail 只压分数（硬红线/证伪封顶），不再触发整体不通过；
  // 无总分时也只在有实锤时判 fail，否则一律 unknown（warn 不再作为结论档外露）。
  const hardFail = scores.some((s) => (s.id === 'billing' || s.id === 'identity') && s.level === 'fail');
  const anyWarn = scores.some((s) => s.level === 'warn');
  const inconclusiveLevel: Level = hardFail ? 'fail' : 'unknown';

  if (scorable.length < 2) {
    notes.push('可评分项不足（<2），总分未判定，仅展示分项结论。');
    return { total: null, overall: inconclusiveLevel, scores, notes };
  }

  if (scorable.some((s) => (s.score as number) <= 0)) {
    notes.push('存在 0 分项，总分直接判定为 0（不做对数平滑兜底）。');
    return { total: 0, overall: hardFail ? 'fail' : 'warn', scores, notes };
  }

  // 核心维度（billing/quality）不可测时不出总分：端点连控制题/用量都无法给出有效证据，
  // 其余维度的高分不能外推为整体可信度（真机实证：quality 全空 + billing 100 曾报 96）。
  const unscorableById = new Map(unscorable.map((s) => [s.id, s]));
  const missingCore = (['billing', 'quality'] as const)
    .map((id) => unscorableById.get(id))
    .filter((s): s is ScoreEntry => s !== undefined);
  if (missingCore.length > 0) {
    notes.push(
      `总分不出：核心维度 ${missingCore.map((s) => `${s.id}（${s.headline}）`).join('、')} 未获得有效证据；核心维度不可测时，其余维度的分数不能外推为整体可信度。`,
    );
    return { total: null, overall: inconclusiveLevel, scores, notes };
  }

  const totalWeight = scopedScores.reduce((acc, s) => acc + s.weight, 0);
  const scoredWeight = scorable.reduce((acc, s) => acc + s.weight, 0);
  const coverage = totalWeight > 0 ? scoredWeight / totalWeight : 0;
  const coveragePct = Math.round(coverage * 100);
  const unscorableList = unscorable.map((s) => `${s.id}(${s.headline})`).join('、');

  if (unscorable.length > 0) {
    notes.push(`未判定项（不参与总分）：${unscorableList}`);
    notes.push(
      `评分覆盖：已判定 ${scoredWeight}/${totalWeight} 权重（${coveragePct}%）；总分仅在已判定维度内归一化，未判定维度不能视为通过。`,
    );
  }

  if (coverage < MIN_COVERAGE) {
    notes.push(
      `总分不出：评分覆盖不足（${scoredWeight}/${totalWeight} 权重，${coveragePct}% < ${Math.round(MIN_COVERAGE * 100)}%）。`,
    );
    return { total: null, overall: inconclusiveLevel, scores, notes };
  }

  const weightSum = scorable.reduce((acc, s) => acc + s.weight, 0);
  const logSum = scorable.reduce((acc, s) => acc + s.weight * Math.log(s.score as number), 0);
  let total = Math.exp(logSum / weightSum);

  const hardRed = scorable.filter((s) => HARD_RED.has(s.id) && (s.score as number) < 40);
  if (hardRed.length > 0) {
    total = Math.min(total, HARD_RED_CAP);
    notes.push(`硬红线触发（${hardRed.map((s) => s.id).join('、')} < 40），总分上限 ${HARD_RED_CAP}。`);
  }

  // capability 被证伪罚：与硬红线并列生效（取 min，不抬分）。只压分数，不再触发整体不通过。
  if (capabilityFalsified) {
    total = Math.min(total, CAPABILITY_FALSIFIED_CAP);
    notes.push('标称能力被证伪（capability 存在 fail 级异常），可信度总分上限 60。');
  }

  // 实锤总分封顶：计费/身份实锤时，总分与档位必须一致进入不及格区间，
  // 「不通过」结论不得配上及格区总分（换芯/乱收费实锤下「总分 82」违反常理）。
  // 上限注记仅在实际压低总分时出现——几何聚合已低于 45 时该注记只剩误导。
  if (hardFail && total > FAIL_LEVEL_SCORE_CAP) {
    total = FAIL_LEVEL_SCORE_CAP;
    notes.push(`存在实锤（计费/身份维度 fail），可信度总分上限 ${FAIL_LEVEL_SCORE_CAP}。`);
  }

  const rounded = clampScore(total);
  let overall: Level;
  if (hardFail) overall = 'fail';
  else if (rounded < 75 || anyWarn) overall = 'warn';
  else overall = 'pass';

  return { total: rounded, overall, scores, notes };
}

/**
 * 总结论标签：仅 fail/unknown 有结论词；pass/warn 一律返回 null（只展示分数，
 * 不设「通过/可疑」中间结论档——warn 仅作内部档位驱动 JSON/硬红线，不外露为结论词）。
 */
export function verdictLabel(level: Level): string | null {
  switch (level) {
    case 'fail':
      return '不通过';
    case 'unknown':
      return '未判定';
    default:
      return null;
  }
}

export function statusTag(level: Level): string {
  switch (level) {
    case 'pass':
      return 'PASS';
    case 'warn':
      return 'WARN';
    case 'fail':
      return 'FAIL';
    default:
      return 'N/A';
  }
}
