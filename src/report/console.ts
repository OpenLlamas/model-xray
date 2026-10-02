import type { AuditReport, EvidenceRecord, ProbeOutcome } from '../types.js';
import { levelLabel, statusTag } from '../scoring.js';

export function renderConsole(report: AuditReport): string {
  const lines: string[] = [];
  const meta = report.meta;
  lines.push(`model-xray ${meta.tool} · model: ${meta.model} · endpoint: ${meta.baseUrl}`);
  lines.push(`seed ${meta.seed} · probeset ${meta.probesetVersion} · assets ${meta.assetsVersion}`);
  if (meta.claimedContext) lines.push(`claimed context: ${meta.claimedContext.toLocaleString()} tokens`);
  lines.push('');

  for (const entry of report.scores) {
    const score = entry.score === null ? '  -' : String(entry.score).padStart(3, ' ');
    lines.push(`[${statusTag(entry.level)}] ${entry.id.padEnd(10)} ${score}  ${entry.headline}`);
  }
  for (const outcome of report.outcomes) {
    if (report.scores.some((s) => s.id === outcome.id)) continue;
    lines.push(`[${statusTag(outcome.level)}] ${outcome.id.padEnd(10)}  -   ${outcome.headline}`);
  }

  lines.push('');
  lines.push('='.repeat(56));
  const totalText = report.total === null ? '未判定' : `${report.total}/100`;
  lines.push(`总分 ${totalText} — ${levelLabel(report.overall)}`);
  for (const note of report.notes) lines.push(`· ${note}`);
  lines.push('');
  lines.push(`fail/warn 项证据见报告；共 ${report.evidence.length} 条原始记录。`);
  return lines.join('\n');
}

export function summarizeEvidence(records: readonly EvidenceRecord[], probe: string): string {
  const related = records.filter((r) => r.probe === probe);
  if (related.length === 0) return '无';
  return related.map((r) => r.id).join(', ');
}

export function renderOutcomeHeadline(outcome: ProbeOutcome): string {
  return `${outcome.headline}${outcome.status === 'insufficient' ? '（证据不足）' : ''}`;
}
