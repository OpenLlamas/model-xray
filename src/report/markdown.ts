import type { AuditReport, EvidenceRecord, ProbeOutcome } from '../types.js';
import { levelLabel, statusTag } from '../scoring.js';

export function renderMarkdown(report: AuditReport): string {
  const lines: string[] = [];
  const meta = report.meta;
  lines.push(`# model-xray 报告 — ${meta.model}`);
  lines.push('');
  lines.push(`> 结论：**${levelLabel(report.overall)}** · 总分 **${report.total ?? '未判定'}${report.total === null ? '' : '/100'}**`);
  lines.push('');

  lines.push('## 元信息');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('|---|---|');
  lines.push(`| 工具 | model-xray ${meta.tool} |`);
  lines.push(`| 端点 | ${cell(meta.baseUrl)} |`);
  lines.push(`| 模型 | ${cell(meta.model)} |`);
  lines.push(`| 标称上下文 | ${meta.claimedContext ?? '未提供'} |`);
  lines.push(`| 随机种子 | ${meta.seed} |`);
  lines.push(`| 题集版本 | ${meta.probesetVersion} / ${meta.assetsVersion} |`);
  lines.push(`| 开始时间 | ${meta.startedAt} |`);
  lines.push(`| 耗时 | ${(meta.durationMs / 1000).toFixed(1)}s |`);
  lines.push(`| Node | ${meta.nodeVersion} |`);
  lines.push('');

  lines.push('## 分项得分');
  lines.push('');
  lines.push('| 检测项 | 判定 | 得分 | 摘要 |');
  lines.push('|---|---|---|---|');
  for (const entry of report.scores) {
    lines.push(`| ${entry.id} | ${statusTag(entry.level)} | ${entry.score ?? '-'} | ${cell(entry.headline)} |`);
  }
  lines.push('');
  if (report.notes.length > 0) {
    lines.push('## 说明');
    lines.push('');
    for (const note of report.notes) lines.push(`- ${note}`);
    lines.push('');
  }

  lines.push('## 检测详情');
  lines.push('');
  for (const outcome of report.outcomes) {
    lines.push(renderOutcome(outcome));
  }

  if (report.evidence.length > 0) {
    lines.push('## 原始证据');
    lines.push('');
    lines.push('完整原始记录见同目录 JSON 文件；以下为关键摘要。');
    lines.push('');
    for (const record of report.evidence) {
      lines.push(renderEvidence(record));
    }
  }
  return `${lines.join('\n')}\n`;
}

function renderOutcome(outcome: ProbeOutcome): string {
  const lines: string[] = [];
  lines.push(`### ${outcome.id} — ${statusTag(outcome.level)}（${outcome.score ?? '未判定'}）`);
  lines.push('');
  lines.push(outcome.headline);
  lines.push('');
  if (outcome.findings.length > 0) {
    for (const finding of outcome.findings) {
      const tag = finding.level === 'fail' ? 'FAIL' : finding.level === 'warn' ? 'WARN' : 'INFO';
      const refs = finding.evidenceIds.length > 0 ? `（证据：${finding.evidenceIds.join(', ')}）` : '';
      lines.push(`- **${tag}** ${cell(finding.message)}${refs}`);
    }
    lines.push('');
  }
  const metricEntries = Object.entries(outcome.metrics).filter(([, v]) => v !== null);
  if (metricEntries.length > 0) {
    lines.push('| 指标 | 值 |');
    lines.push('|---|---|');
    for (const [key, value] of metricEntries) {
      lines.push(`| ${cell(key)} | ${cell(String(value))} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function renderEvidence(record: EvidenceRecord): string {
  const lines: string[] = [];
  lines.push(`#### ${record.id} · ${record.probe} · ${record.label}`);
  lines.push('');
  lines.push(
    `- HTTP ${record.response.status} · ${record.durationMs}ms${record.ttftMs !== null ? ` · TTFT ${record.ttftMs}ms` : ''}`,
  );
  if (record.response.usage) {
    lines.push(
      `- usage: prompt=${record.response.usage.prompt_tokens} completion=${record.response.usage.completion_tokens} total=${record.response.usage.total_tokens}`,
    );
  }
  if (record.response.error) lines.push(`- error: ${quote(record.response.error)}`);
  lines.push(`- 请求摘要: ${quote(record.request.lastUserPreview)}`);
  lines.push(`- 响应摘要: ${quote(record.response.textPreview)}`);
  lines.push('');
  return lines.join('\n');
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').replace(/```/g, '`` `');
}

function quote(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').replace(/```/g, '`` `').slice(0, 500);
}
