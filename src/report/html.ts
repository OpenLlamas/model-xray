import type { AuditReport, EvidenceRecord, ProbeOutcome } from '../types.js';
import { levelLabel, PROBE_ORDER, statusTag } from '../scoring.js';

export function renderHtml(report: AuditReport): string {
  const meta = report.meta;
  const totalText = report.total === null ? '未判定' : `${report.total}/100`;
  const verdictClass = report.overall === 'pass' ? 'ok' : report.overall === 'fail' ? 'bad' : 'warn';
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>model-xray report - ${esc(meta.model)}</title>
<style>
:root{color-scheme:light dark;--ok:#0a7d32;--bad:#c01c28;--warn:#a05a00;--muted:#777;--line:#d8d8d8}
body{font:15px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;padding:32px;background:#fafafa;color:#1a1a1a}
main{max-width:960px;margin:0 auto}
h1{font-size:22px} h2{margin-top:32px;border-bottom:1px solid var(--line);padding-bottom:6px}
table{border-collapse:collapse;width:100%;background:#fff} th,td{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}
th{background:#f0f0f0}
.badge{display:inline-block;padding:6px 14px;border-radius:6px;font-weight:700;color:#fff;margin-right:8px}
.badge.ok{background:var(--ok)} .badge.bad{background:var(--bad)} .badge.warn{background:var(--warn)}
.tag{font-weight:700;white-space:nowrap}.tag.pass{color:var(--ok)} .tag.fail{color:var(--bad)} .tag.warn{color:var(--warn)} .tag.unknown{color:var(--muted)}
.ev{margin:8px 0;border:1px solid var(--line);background:#fff;border-radius:4px;padding:8px 12px}
.ev summary{cursor:pointer;font-weight:600}
.ev pre{white-space:pre-wrap;word-break:break-all;background:#f6f6f6;padding:8px;border-radius:4px;font-size:13px}
.muted{color:var(--muted);font-size:13px}
@media (prefers-color-scheme:dark){body{background:#161616;color:#e8e8e8}table{background:#1f1f1f}th{background:#2a2a2a}.ev{background:#1f1f1f}.ev pre{background:#2a2a2a}:root{--line:#3a3a3a;--muted:#999}}
</style>
</head>
<body><main>
<h1>model-xray 报告 — ${esc(meta.model)}</h1>
<p><span class="badge ${verdictClass}">${esc(levelLabel(report.overall))}</span><strong>总分 ${esc(totalText)}</strong></p>
<p class="muted">端点 ${esc(meta.baseUrl)} · seed ${meta.seed} · 题集 ${esc(meta.probesetVersion)} · ${esc(meta.startedAt)} · 耗时 ${(meta.durationMs / 1000).toFixed(1)}s · model-xray ${esc(meta.tool)}</p>

<h2>分项得分</h2>
<table><thead><tr><th>检测项</th><th>判定</th><th>得分</th><th>摘要</th></tr></thead><tbody>
${report.scores
  .map(
    (entry) =>
      `<tr><td>${esc(entry.id)}</td><td class="tag ${entry.level}">${esc(statusTag(entry.level))}</td><td>${entry.score ?? '-'}</td><td>${esc(entry.headline)}</td></tr>`,
  )
  .join('\n')}
</tbody></table>

${report.notes.length > 0 ? `<h2>说明</h2><ul>${report.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}

<h2>检测详情</h2>
${report.outcomes.map(renderOutcome).join('\n')}

<h2>原始证据（${report.evidence.length} 条）</h2>
${report.evidence.map(renderEvidence).join('\n')}
</main></body></html>
`;
}

function renderOutcome(outcome: ProbeOutcome): string {
  const findings = outcome.findings
    .map((f) => {
      const cls = f.level === 'fail' ? 'fail' : f.level === 'warn' ? 'warn' : 'unknown';
      const refs = f.evidenceIds.length > 0 ? ` <span class="muted">(${esc(f.evidenceIds.join(', '))})</span>` : '';
      return `<li><span class="tag ${cls}">${esc(f.level.toUpperCase())}</span> ${esc(f.message)}${refs}</li>`;
    })
    .join('\n');
  const metrics = Object.entries(outcome.metrics).filter(([, v]) => v !== null);
  const metricRows = metrics.length
    ? `<table><thead><tr><th>指标</th><th>值</th></tr></thead><tbody>${metrics
        .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(String(v))}</td></tr>`)
        .join('')}</tbody></table>`
    : '';
  return `<h3>${esc(outcome.id)} — <span class="tag ${outcome.level}">${esc(statusTag(outcome.level))}</span> (${outcome.score ?? '未判定'})</h3>
<p>${esc(outcome.headline)}</p>
${findings ? `<ul>${findings}</ul>` : ''}
${metricRows}`;
}

function renderEvidence(record: EvidenceRecord): string {
  const usage = record.response.usage
    ? `usage: prompt=${record.response.usage.prompt_tokens} completion=${record.response.usage.completion_tokens} total=${record.response.usage.total_tokens}`
    : 'usage: 无';
  return `<details class="ev"><summary>${esc(record.id)} · ${esc(record.probe)} · ${esc(record.label)}</summary>
<p class="muted">HTTP ${record.response.status} · ${record.durationMs}ms${record.ttftMs !== null ? ` · TTFT ${record.ttftMs}ms` : ''} · ${esc(usage)}</p>
${record.response.error ? `<p class="muted">error: ${esc(record.response.error)}</p>` : ''}
<pre>请求: ${esc(record.request.lastUserPreview)}</pre>
<pre>响应: ${esc(record.response.textPreview)}</pre>
</details>`;
}

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
