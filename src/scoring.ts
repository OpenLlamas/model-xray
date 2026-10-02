import type { Level, ProbeId, ProbeOutcome, ScoreEntry } from './types.js';
import { clampScore } from './stats.js';

export const WEIGHTS: Record<ProbeId, number> = {
  billing: 25,
  quality: 25,
  identity: 15,
  context: 15,
  capability: 10,
  ttft: 10,
  decoy: 0,
};

export const PROBE_ORDER: readonly ProbeId[] = ['identity', 'context', 'billing', 'capability', 'quality', 'ttft'];

export const HARD_RED: ReadonlySet<ProbeId> = new Set<ProbeId>(['billing', 'capability', 'context', 'quality']);

const HARD_RED_CAP = 45;

export interface ScoreResult {
  total: number | null;
  overall: Level;
  scores: ScoreEntry[];
  notes: string[];
}

export function computeTotal(outcomes: readonly ProbeOutcome[]): ScoreResult {
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

  const scorable = scores.filter((s) => s.status === 'ok' && typeof s.score === 'number');
  const unscorable = scores.filter((s) => !(s.status === 'ok' && typeof s.score === 'number'));

  if (scorable.length < 2) {
    notes.push('可评分项不足（<2），总分未判定，仅展示分项结论。');
    const anyFail = scores.some((s) => s.level === 'fail');
    return { total: null, overall: anyFail ? 'fail' : 'unknown', scores, notes };
  }

  if (unscorable.length > 0) {
    notes.push(
      `未判定项（不参与总分，权重已重新归一化）：${unscorable.map((s) => `${s.id}(${s.headline})`).join('、')}`,
    );
  }

  if (scorable.some((s) => (s.score as number) <= 0)) {
    notes.push('存在 0 分项，总分直接判定为 0（不做对数平滑兜底）。');
    return { total: 0, overall: 'fail', scores, notes };
  }

  const weightSum = scorable.reduce((acc, s) => acc + s.weight, 0);
  const logSum = scorable.reduce((acc, s) => acc + s.weight * Math.log(s.score as number), 0);
  let total = Math.exp(logSum / weightSum);

  const hardRed = scorable.filter((s) => HARD_RED.has(s.id) && (s.score as number) < 40);
  if (hardRed.length > 0) {
    total = Math.min(total, HARD_RED_CAP);
    notes.push(`硬红线触发（${hardRed.map((s) => s.id).join('、')} < 40），总分上限 ${HARD_RED_CAP}。`);
  }

  const rounded = clampScore(total);
  const anyFail = scores.some((s) => s.level === 'fail');
  let overall: Level;
  if (anyFail || rounded < 40) overall = 'fail';
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
