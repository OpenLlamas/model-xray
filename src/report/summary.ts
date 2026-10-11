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
 * 聚合「异常要点」：扫描**所有** outcome 的 level∈{fail,warn} findings，
 * 不做 outcome.level 门槛——pass 级 outcome 可携带 warn findings（如 billing 零星
 * usage 异常）、unknown 降级路径可携带 fail finding（如 context 回显控制失败），
 * 按 outcome.level 过滤会让异常要点与检测详情矛盾、甚至误报「未发现异常」。
 * - 有 fail/warn findings → 逐条收录；
 * - 无 fail/warn findings 且 outcome.level∈{fail,warn} → 以 outcome.headline 合成一条
 *   （如 capability 全 partial 抬升 warn）。
 * fail 优先于 warn（稳定排序），供 HTML/Markdown/控制台三处渲染复用。
 */
export function collectAnomalies(report: AuditReport): AnomalyLine[] {
  const lines: AnomalyLine[] = [];
  for (const outcome of report.outcomes) {
    const bad = outcome.findings.filter((f) => f.level === 'fail' || f.level === 'warn');
    if (bad.length > 0) {
      let sawFail = false;
      for (const finding of bad) {
        if (finding.level !== 'fail' && finding.level !== 'warn') continue; // 收窄类型：bad 已过滤，恒不触发
        if (finding.level === 'fail') sawFail = true;
        lines.push({
          probe: outcome.id,
          level: finding.level,
          message: finding.message,
          evidenceIds: finding.evidenceIds,
          synthesized: false,
        });
      }
      // outcome 整体判定 fail 但 fail/warn findings 只有 warn（如 quality 答错题只发 warn finding）：
      // 补一条 headline 合成的 fail 行，保证异常要点区与分项表/总分口径一致，不丢 FAIL 优先级。
      if (outcome.level === 'fail' && !sawFail) {
        lines.push({ probe: outcome.id, level: 'fail', message: outcome.headline, evidenceIds: [], synthesized: true });
      }
    } else if (outcome.level === 'fail' || outcome.level === 'warn') {
      lines.push({ probe: outcome.id, level: outcome.level, message: outcome.headline, evidenceIds: [], synthesized: true });
    }
  }
  // fail 在前 warn 在后；同级别保持 outcome 出现顺序（稳定）
  return lines.sort((a, b) => (a.level === b.level ? 0 : a.level === 'fail' ? -1 : 1));
}
