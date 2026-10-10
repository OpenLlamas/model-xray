import type { AuditReport, EvidenceRecord, ProbeOutcome } from '../types.js';
import { levelLabel, statusTag } from '../scoring.js';
import { colorize } from '../color.js';
import { collectAnomalies } from './summary.js';

export interface ConsoleRenderOptions {
  /**
   * 终端着色开关，默认 false：输出零 ANSI 字节（管道/测试环境零变化）；
   * 调用方（cli.ts）用 supportsColor(process.stdout) 决定。
   */
  color?: boolean;
}

export function renderConsole(report: AuditReport, opts?: ConsoleRenderOptions): string {
  const color = opts?.color ?? false;
  const lines: string[] = [];
  const meta = report.meta;
  lines.push(`model-xray ${meta.tool} · model: ${meta.model} · endpoint: ${meta.baseUrl}`);
  lines.push(`seed ${meta.seed} · probeset ${meta.probesetVersion} · assets ${meta.assetsVersion}`);
  if (meta.claimedContext) lines.push(`claimed context: ${meta.claimedContext.toLocaleString()} tokens`);
  lines.push('');

  for (const entry of report.scores) {
    const score = entry.score === null ? '  -' : String(entry.score).padStart(3, ' ');
    lines.push(`${colorize(`[${statusTag(entry.level)}]`, entry.level, color)} ${entry.id.padEnd(10)} ${score}  ${entry.headline}`);
  }
  for (const outcome of report.outcomes) {
    if (report.scores.some((s) => s.id === outcome.id)) continue;
    lines.push(`${colorize(`[${statusTag(outcome.level)}]`, outcome.level, color)} ${outcome.id.padEnd(10)}  -   ${outcome.headline}`);
  }

  lines.push('');
  lines.push('异常要点:');
  const anomalies = collectAnomalies(report);
  if (anomalies.length === 0) {
    lines.push('  未发现异常');
  } else {
    for (const a of anomalies) {
      const refs = a.evidenceIds.length > 0 ? ` (${a.evidenceIds.join(', ')})` : '';
      lines.push(`  ${colorize(`[${a.level.toUpperCase()}]`, a.level, color)} ${a.probe}: ${a.message}${refs}`);
    }
  }

  lines.push('');
  lines.push('='.repeat(56));
  if (report.total === null) {
    lines.push(report.overall === 'fail' ? '总分 未判定 — 存在失败项，结论：不通过' : '总分 未判定 — 证据不足，无法得出结论');
  } else {
    lines.push(colorize(`总分 ${report.total}/100 — ${levelLabel(report.overall)}`, report.overall, color));
  }
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
