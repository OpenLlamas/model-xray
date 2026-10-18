import type { Level, ProbeId, ProbeOutcome, ScoreEntry } from './types.js';
import { clampScore } from './stats.js';

export const WEIGHTS: Record<ProbeId, number> = {
  billing: 25,
  quality: 25,
  identity: 15,
  context: 15,
  capability: 10,
  // TTFT 仅观测，不参与总分；权重必须为 0，避免未来误接分数时把观测项算进可信度。
  ttft: 0,
  decoy: 0,
};

export const PROBE_ORDER: readonly ProbeId[] = ['identity', 'context', 'billing', 'capability', 'quality', 'ttft'];

export const HARD_RED: ReadonlySet<ProbeId> = new Set<ProbeId>(['billing', 'capability', 'context', 'quality']);

const HARD_RED_CAP = 45;

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

  const anyFail = scores.some((s) => s.level === 'fail');
  const anyWarn = scores.some((s) => s.level === 'warn');
  const inconclusiveLevel: Level = anyFail || capabilityFalsified ? 'fail' : anyWarn ? 'warn' : 'unknown';

  if (scorable.length < 2) {
    notes.push('可评分项不足（<2），总分未判定，仅展示分项结论。');
    return { total: null, overall: inconclusiveLevel, scores, notes };
  }

  if (scorable.some((s) => (s.score as number) <= 0)) {
    notes.push('存在 0 分项，总分直接判定为 0（不做对数平滑兜底）。');
    return { total: 0, overall: 'fail', scores, notes };
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

  // capability 被证伪罚：与硬红线并列生效（取 min，不抬分），并把 overall 强制为 fail。
  if (capabilityFalsified) {
    total = Math.min(total, CAPABILITY_FALSIFIED_CAP);
    notes.push('标称能力被证伪（capability 存在 fail 级异常），可信度总分上限 60。');
  }

  const rounded = clampScore(total);
  let overall: Level;
  if (anyFail || capabilityFalsified || rounded < 40) overall = 'fail';
  else if (rounded < 75 || scores.some((s) => s.level === 'warn')) overall = 'warn';
  else overall = 'pass';

  return { total: rounded, overall, scores, notes };
}

export function levelLabel(level: Level): string {
  switch (level) {
    case 'pass':
      return '通过';
    case 'warn':
      return '可疑';
    case 'fail':
      return '不通过';
    default:
      return '未判定';
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
