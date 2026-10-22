import type { AuditReport, EvidenceRecord, ProbeOutcome, ScoreEntry } from '../types.js';
import { FAIL_LEVEL_SCORE_CAP, PROBE_ORDER, statusTag, verdictLabel } from '../scoring.js';
import { collectAnomalies } from './summary.js';
import { CREDIBILITY_NOTE, HIDDEN_METRICS, billingSummaryRows } from './markdown.js';

/** 每维度一行静态说明：测什么 / 评分依据（纯展示，不参与评分）。 */
const DIMENSION_DESC: Readonly<Record<string, string>> = {
  identity: '身份与指纹：多角度自述问答与行为指纹比对，识破换标签/套皮；评分依据：自述一致性与指纹命中',
  context: '长上下文实测：在标称窗口各深度埋 needle 验证真实可用量；评分依据：各深度命中率',
  billing: 'token 计量与线性：自报 usage 随输入长度的回归一致性 + completion_tokens 硬矛盾检查；绝对对账（--token-reference 或价格+余额实扣倍率）缺失时判「未判定」，不给分',
  capability: '标称能力实测：vision/tool/thinking 逐项验证而非只看宣称；评分依据：标称能力实测通过率',
  params: '协议参数完整性：max_tokens/stop/response_format/n/logprobs 实测端点是否静默忽略或改写；不支持判「不适用」，不误判；评分依据：实测遵守项/有效项',
  quality: '程序化题集：版本化可复现题集对照参考答案；评分依据：程序化判定的正确率',
  ttft: '流式首字延迟：采样 TTFT 分位数；观测项不计分，仅披露 p50/p95（非流式响应计至完整响应体到达）',
  decoy: '诱饵对照项：不计分，仅用于识别「对固定题集特判」的端点',
};

export function renderHtml(report: AuditReport): string {
  const meta = report.meta;
  const totalText = report.total === null ? '未判定' : `${report.total}/100`;
  // 总评徽标：仅 fail（不通过，红）/unknown（未判定，灰）有结论徽标；pass/warn 只展示分数。
  const verdict = verdictLabel(report.overall);
  const verdictBadge =
    verdict === null
      ? ''
      : `<span class="badge ${report.overall === 'fail' ? 'bad' : 'unknown'}">${esc(verdict)}</span>`;
  const anomalies = collectAnomalies(report);
  const boxLevel = anomalies.some((a) => a.level === 'fail') ? 'fail' : anomalies.length > 0 ? 'warn' : 'ok';
  // 分项得分（含实锤封顶）按 id 建索引：检测详情区与评分卡同源展示，不显示探针原始分。
  const scoreById = new Map(report.scores.map((s) => [s.id, s.score]));
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
h4{font-size:15px;margin:16px 0 6px}
table{border-collapse:collapse;width:100%;background:#fff} th,td{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}
th{background:#f0f0f0}
.badge{display:inline-block;padding:6px 14px;border-radius:6px;font-weight:700;color:#fff;margin-right:8px}
.badge.ok{background:var(--ok)} .badge.bad{background:var(--bad)} .badge.warn{background:var(--warn)} .badge.unknown{background:var(--muted)}
.tag{font-weight:700;white-space:nowrap}.tag.pass{color:var(--ok)} .tag.fail{color:var(--bad)} .tag.warn{color:var(--warn)} .tag.unknown{color:var(--muted)}
.ev{margin:8px 0;border:1px solid var(--line);background:#fff;border-radius:4px;padding:8px 12px}
.ev summary{cursor:pointer;font-weight:600}
.ev pre{white-space:pre-wrap;word-break:break-all;background:#f6f6f6;padding:8px;border-radius:4px;font-size:13px}
.muted{color:var(--muted);font-size:13px}
.anomaly{margin:16px 0;padding:10px 14px;border-radius:6px;border:1px solid}
.anomaly.fail{background:#fdecea;border-color:#e6a5a0;color:#7a1218}
.anomaly.warn{background:#fff4e0;border-color:#e0b25a;color:#6b4400}
.anomaly.ok{background:#e8f6ec;border-color:#9ccfae;color:#0a5c26}
.anomaly-title{font-weight:700;margin-bottom:6px}
.anomaly ul{margin:0;padding-left:20px}
.anomaly .dim{font-weight:700}
@media (prefers-color-scheme:dark){
body{background:#161616;color:#e8e8e8}table{background:#1f1f1f}th{background:#2a2a2a}.ev{background:#1f1f1f}.ev pre{background:#2a2a2a}:root{--line:#3a3a3a;--muted:#999}
.anomaly.fail{background:#3a1214;color:#ffb4ae;border-color:#6e2a2e}
.anomaly.warn{background:#33260d;color:#ffd48a;border-color:#6e5522}
.anomaly.ok{background:#0f2a18;color:#8fdca8;border-color:#2c5a3c}
}
</style>
</head>
<body><main>
<h1>model-xray 报告 — ${esc(meta.model)}</h1>
<p>${verdictBadge}<strong>可信度总分 ${esc(totalText)}</strong></p>
<div class="anomaly ${boxLevel}">
<div class="anomaly-title">异常要点${anomalies.length > 0 ? `（${anomalies.length} 项）` : ''}</div>
${
  anomalies.length === 0
    ? '<div>未发现异常</div>'
    : `<ul>${anomalies
        .map(
          (a) =>
            `<li><span class="tag ${a.level}">${esc(a.level.toUpperCase())}</span> <span class="dim">${esc(a.probe)}</span> ${esc(a.message)}${
              a.evidenceIds.length > 0 ? ` <span class="muted">(${esc(a.evidenceIds.join(', '))})</span>` : ''
            }</li>`,
        )
        .join('\n')}</ul>`
}
</div>
<p class="muted">端点 ${esc(meta.baseUrl)} · seed ${meta.seed} · 题集 ${esc(meta.probesetVersion)} · ${esc(meta.startedAt)} · 耗时 ${(meta.durationMs / 1000).toFixed(1)}s · model-xray ${esc(meta.tool)}</p>

<h2>分项得分</h2>
<table><thead><tr><th>检测项</th><th>判定</th><th>得分</th><th>权重</th><th>摘要</th></tr></thead><tbody>
${report.scores
  .map(
    (entry) =>
      `<tr><td>${esc(entry.id)}<div class="muted">${esc(DIMENSION_DESC[entry.id] ?? '')}</div></td><td class="tag ${entry.level}">${esc(
        statusTag(entry.level),
      )}</td><td>${entry.score ?? '-'}</td><td>${weightText(entry)}</td><td>${esc(entry.headline)}</td></tr>`,
  )
  .join('\n')}
</tbody></table>

${`<h2>说明</h2><ul>${[...report.notes, CREDIBILITY_NOTE].map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`}

<h2>检测详情</h2>
${report.outcomes
  .map((o) => renderOutcome(o, scoreById.get(o.id)))
  .join('\n')}

${
  report.evidence.length > 0
    ? `<h2>原始证据（${report.evidence.length} 条）</h2>\n${report.evidence.map(renderEvidence).join('\n')}`
    : '<p class="muted">本次审计未产生原始证据记录。</p>'
}
</main></body></html>
`;
}

function renderOutcome(outcome: ProbeOutcome, scoreOverride?: number | null): string {
  // 分数展示与评分卡同源：scores 里的分项分已经过聚合层实锤封顶（定罪维度不保留及格分），
  // 详情区不得再显示探针原始分（否则同一份报告出现「评分卡 45 / 详情 70」的矛盾数字）。
  // 覆盖完整性兜底：scores 未覆盖的观测项（如 decoy）回退 outcome.score，但 fail 档位
  // 无论是否被 scores 覆盖一律执行封顶——「定罪维度不保留及格分」不依赖 scores 覆盖完整。
  const base = scoreOverride !== undefined ? scoreOverride : outcome.score;
  const shownScore =
    outcome.level === 'fail' && base !== null && base > FAIL_LEVEL_SCORE_CAP ? FAIL_LEVEL_SCORE_CAP : base;
  const findings = outcome.findings
    .map((f) => {
      const cls = f.level === 'fail' ? 'fail' : f.level === 'warn' ? 'warn' : 'unknown';
      const refs = f.evidenceIds.length > 0 ? ` <span class="muted">(${esc(f.evidenceIds.join(', '))})</span>` : '';
      return `<li><span class="tag ${cls}">${esc(f.level.toUpperCase())}</span> ${esc(f.message)}${refs}</li>`;
    })
    .join('\n');
  const metrics = Object.entries(outcome.metrics).filter(([key, v]) => v !== null && !HIDDEN_METRICS.has(key));
  const metricRows = metrics.length
    ? `<table><thead><tr><th>指标</th><th>值</th></tr></thead><tbody>${metrics
        .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(String(v))}</td></tr>`)
        .join('')}</tbody></table>`
    : '';
  // 计费维度：倍率/金额摘要块（中文标签 + 实测/公示倍率 + 「为什么没有倍率」的原因），紧跟 headline。
  const billingRows = outcome.id === 'billing' ? billingSummaryRows(outcome.metrics) : [];
  const billingBlock =
    billingRows.length > 0
      ? `<h4>计费与倍率</h4><table><thead><tr><th>指标</th><th>值</th></tr></thead><tbody>${billingRows
          .map(([, label, value]) => `<tr><td>${esc(label)}</td><td>${esc(value)}</td></tr>`)
          .join('')}</tbody></table>`
      : '';
  return `<h3>${esc(outcome.id)} — <span class="tag ${outcome.level}">${esc(statusTag(outcome.level))}</span> (${shownScore ?? '未判定'})</h3>
<p>${esc(outcome.headline)}</p>
${billingBlock}
${findings ? `<ul>${findings}</ul>` : ''}
${metricRows}`;
}

function renderEvidence(record: EvidenceRecord): string {
  const usage = record.response.usage
    ? `usage: prompt=${record.response.usage.prompt_tokens} completion=${record.response.usage.completion_tokens} total=${record.response.usage.total_tokens}`
    : 'usage: 无';
  const parsed = record.probe === 'params'
    ? ` · choices=${record.response.choiceCount ?? 'n/a'} · logprobs=${record.response.logprobsTokenCount ?? 'n/a'} · viaStream=${record.response.viaStream === true ? 'true' : record.response.viaStream === false ? 'false' : 'n/a'}`
    : '';
  const protocol = [
    record.request.stop != null ? `stop=${JSON.stringify(record.request.stop)}` : '',
    record.request.seed != null ? `seed=${record.request.seed}` : '',
    record.request.n != null ? `n=${record.request.n}` : '',
    record.request.logprobs != null ? `logprobs=${record.request.logprobs}` : '',
    record.request.topLogprobs != null ? `top_logprobs=${record.request.topLogprobs}` : '',
    record.request.responseFormat != null ? `response_format=${record.request.responseFormat}` : '',
  ].filter((part) => part.length > 0).join(' · ');
  return `<details class="ev"><summary>${esc(record.id)} · ${esc(record.probe)} · ${esc(record.label)}</summary>
<p class="muted">HTTP ${record.response.status} · ${record.durationMs}ms${record.ttftMs !== null ? ` · TTFT ${record.ttftMs}ms` : ''}${esc(parsed)} · ${esc(usage)}</p>
${record.response.error ? `<p class="muted">error: ${esc(record.response.error)}</p>` : ''}
${record.response.model !== null ? `<p class="muted">回显模型: ${esc(record.response.model)}${record.response.model === record.request.model ? '' : `（请求 ${esc(record.request.model)}）`}</p>` : ''}
${protocol ? `<p class="muted">协议参数: ${esc(protocol)}</p>` : ''}
<pre>请求${truncationNote(record.request.lastUserPreview, record.request.lastUserChars)}: ${esc(record.request.lastUserPreview)}</pre>
${record.request.lastUserTailPreview ? `<pre>请求结尾（长请求尾部摘要，用于核对问题是否在末尾）: ${esc(record.request.lastUserTailPreview)}</pre>` : ''}
<pre>响应${truncationNote(record.response.textPreview, record.response.textChars)}: ${esc(record.response.textPreview)}</pre>
</details>`;
}

function truncationNote(preview: string, fullChars: number): string {
  const shown = Array.from(preview).length;
  return shown >= fullChars && !preview.endsWith('…') ? '' : `（预览 ${shown}/${fullChars} 字符，已截断）`;
}

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 与 markdown.ts 同口径：未计入总分的行不展示配置权重（总分用归一化后权重，避免按表复算对不上）。 */
function weightText(entry: ScoreEntry): string {
  const counted = entry.status === 'ok' && typeof entry.score === 'number' && Number.isFinite(entry.score);
  return counted && entry.weight > 0 ? String(entry.weight) : '-';
}
