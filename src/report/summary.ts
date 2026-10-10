import type { AuditReport } from '../types.js';

export interface AnomalyLine {
  /** 所属探针 id（如 identity/capability） */
  probe: string;
  level: 'fail' | 'warn';
  message: string;
  evidenceIds: string[];
  /** true=该 outcome 无 fail/warn findings（全 info），以 headline 合成（如 capability 全 partial 抬升 warn） */
  synthesized: boolean;
}

/**
 * 聚合「异常要点」：取所有 level∈{fail,warn} 的 outcome，
 * - 有 fail/warn findings → 逐条取该 outcome 的 fail/warn findings；
 * - 无 fail/warn findings（全 info）→ 以 outcome.headline 合成一条，level 取 outcome.level。
 * fail 优先于 warn（稳定排序），供 HTML/Markdown/控制台三处渲染复用。
 */
export function collectAnomalies(report: AuditReport): AnomalyLine[] {
  const lines: AnomalyLine[] = [];
  for (const outcome of report.outcomes) {
    if (outcome.level !== 'fail' && outcome.level !== 'warn') continue;
    const bad = outcome.findings.filter((f) => f.level === 'fail' || f.level === 'warn');
    if (bad.length > 0) {
      for (const finding of bad) {
        if (finding.level !== 'fail' && finding.level !== 'warn') continue; // 收窄类型：bad 已过滤，恒不触发
        lines.push({
          probe: outcome.id,
          level: finding.level,
          message: finding.message,
          evidenceIds: finding.evidenceIds,
          synthesized: false,
        });
      }
    } else {
      lines.push({ probe: outcome.id, level: outcome.level, message: outcome.headline, evidenceIds: [], synthesized: true });
    }
  }
  // fail 在前 warn 在后；同级别保持 outcome 出现顺序（稳定）
  return lines.sort((a, b) => (a.level === b.level ? 0 : a.level === 'fail' ? -1 : 1));
}
