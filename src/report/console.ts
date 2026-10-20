import type { AuditReport, EvidenceRecord, ProbeOutcome } from '../types.js';
import { levelLabel, statusTag } from '../scoring.js';
import { colorize } from '../color.js';
import { collectAnomalies } from './summary.js';
import { billingSummaryRows } from './markdown.js';

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
  lines.push(`model-xray ${meta.tool} · model: ${stripControl(meta.model)} · endpoint: ${stripControl(meta.baseUrl)}`);
  lines.push(`seed ${meta.seed} · probeset ${meta.probesetVersion} · assets ${meta.assetsVersion}`);
  // 固定 en-US 分组：toLocaleString() 默认随机器 locale 变化，跨机器输出不可比
  if (meta.claimedContext) lines.push(`claimed context: ${meta.claimedContext.toLocaleString('en-US')} tokens`);
  lines.push('');

  for (const entry of report.scores) {
    const score = entry.score === null ? '  -' : String(entry.score).padStart(3, ' ');
    const tag = colorize(`[${statusTag(entry.level)}]`.padEnd(6), entry.level, color);
    lines.push(`${tag} ${entry.id.padEnd(10)} ${score}  ${stripControl(entry.headline)}`);
  }
  for (const outcome of report.outcomes) {
    if (report.scores.some((s) => s.id === outcome.id)) continue;
    // 分值列占位与评分行完全一致（`  -` 三字符），保证 - 与数字同列。
    const tag = colorize(`[${statusTag(outcome.level)}]`.padEnd(6), outcome.level, color);
    lines.push(`${tag} ${outcome.id.padEnd(10)}   -  ${stripControl(outcome.headline)}`);
  }

  lines.push('');
  // 倍率摘要：终端输出也要一眼看到「实测倍率 / 公示倍率 / 金额核验状态」，否则用户只看到
  // "usage 计数核验通过" 这类文字，看不到任何倍率数字。
  const billing = report.outcomes.find((outcome) => outcome.id === 'billing');
  if (billing !== undefined) {
    const values = new Map(billingSummaryRows(billing.metrics).map(([key, , value]) => [key, value]));
    const measured = values.get('measured_ratio');
    const declaredModel = values.get('declared_model_ratio');
    const declaredCompletion = values.get('declared_completion_ratio');
    if (measured !== undefined || declaredModel !== undefined || declaredCompletion !== undefined) {
      lines.push(
        `倍率: 实测 ${measured ?? '-'} · 公示 输入 ${declaredModel ?? '-'} / 输出 ${declaredCompletion ?? '-'} · 金额核验 ${values.get('money_check_state') ?? '-'}`,
      );
    }
  }

  lines.push('');
  lines.push('异常要点:');
  const anomalies = collectAnomalies(report);
  if (anomalies.length === 0) {
    lines.push('  未发现异常');
  } else {
    for (const a of anomalies) {
      const refs = a.evidenceIds.length > 0 ? ` (${a.evidenceIds.join(', ')})` : '';
      lines.push(`  ${colorize(`[${a.level.toUpperCase()}]`, a.level, color)} ${a.probe}: ${stripControl(a.message)}${refs}`);
    }
  }

  lines.push('');
  lines.push('='.repeat(56));
  if (report.total === null) {
    const reason =
      report.overall === 'fail'
        ? '存在失败项，结论：不通过'
        : report.overall === 'warn'
          ? '存在可疑项，结论：可疑'
          : '证据不足，无法得出结论';
    lines.push(`可信度总分 未判定 — ${reason}`);
  } else {
    lines.push(colorize(`可信度总分 ${report.total}/100 — ${levelLabel(report.overall)}`, report.overall, color));
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

/**
 * 剥离 C0/C1 控制字符（含 ESC/CSI/OSC 序列头与 \t）。
 * 被审端点天然不可信：其错误体/生成文本可能携带终端转义序列，经 findings/headline
 * 进入控制台输出即可清屏、改写剪贴板（OSC 52）等。渲染边界统一剥离；报告 JSON 保留原文。
 */
function stripControl(text: string): string {
  return text.replace(/[\r\n\t]/g, ' ').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
}
