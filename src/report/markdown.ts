import type { AuditReport, EvidenceRecord, ProbeOutcome, ScoreEntry } from '../types.js';
import { levelLabel, statusTag } from '../scoring.js';
import { collectAnomalies } from './summary.js';

export function renderMarkdown(report: AuditReport): string {
  const lines: string[] = [];
  const meta = report.meta;
  lines.push(`# model-xray 报告 — ${singleLine(meta.model)}`);
  lines.push('');
  lines.push(`> 结论：**${levelLabel(report.overall)}** · 总分 **${report.total ?? '未判定'}${report.total === null ? '' : '/100'}**`);
  lines.push('');

  const anomalies = collectAnomalies(report);
  lines.push('## 异常要点');
  lines.push('');
  if (anomalies.length === 0) {
    lines.push('未发现异常');
  } else {
    for (const a of anomalies) {
      const refs = a.evidenceIds.length > 0 ? `（证据：${a.evidenceIds.join(', ')}）` : '';
      lines.push(`- **${a.level.toUpperCase()}** [${a.probe}] ${cell(a.message)}${refs}`);
    }
  }
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
  lines.push('| 检测项 | 判定 | 得分 | 权重 | 摘要 |');
  lines.push('|---|---|---|---|---|');
  for (const entry of report.scores) {
    lines.push(`| ${entry.id} | ${statusTag(entry.level)} | ${entry.score ?? '-'} | ${weightText(entry)} | ${cell(entry.headline)} |`);
  }
  lines.push('');
  if (report.notes.length > 0) {
    lines.push('## 说明');
    lines.push('');
    for (const note of report.notes) lines.push(`- ${singleLine(note)}`);
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
  // headline 可能内嵌上游错误消息（可含换行），单行化避免破坏 Markdown 段落结构。
  lines.push(singleLine(outcome.headline));
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

/** 未计入总分的行（status 非 ok / score 缺失）不展示配置权重，避免按表复算总分对不上（总分用归一化后权重）。 */
function weightText(entry: ScoreEntry): string {
  const counted = entry.status === 'ok' && typeof entry.score === 'number' && Number.isFinite(entry.score);
  return counted && entry.weight > 0 ? String(entry.weight) : '-';
}

// C0（除 \t \n 外）与 C1 控制字符剥离：上游内容可能夹带终端转义序列/控制符，
// Markdown 报告是渲染边界，剥离后避免查看器异常解析（\r\n 行尾归一在 singleLine 内一并处理）。
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

function singleLine(text: string): string {
  return text.replace(/\r\n|\n|\r/g, ' ').replace(CONTROL_RE, '');
}

function cell(text: string): string {
  // 先转义反斜杠再转义管道：原文 `a\|b` 否则会被转成 `a\\|b`，`\\` 渲染为字面反斜杠后管道重新破列。
  return singleLine(text).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/```/g, '`` `');
}

function quote(text: string): string {
  // quote 仅出现在列表项上下文（非表格行），转义管道只会制造 `\|` 字面噪声；
  // 先截断再转义：避免转义序列被截断在中间，留下无法配对的半截转义。
  return singleLine(text.slice(0, 500)).replace(/\\/g, '\\\\').replace(/```/g, '`` `');
}
