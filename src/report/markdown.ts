import type { AuditReport, EvidenceRecord, ProbeOutcome, ScoreEntry } from '../types.js';
import { levelLabel, statusTag } from '../scoring.js';
import { collectAnomalies } from './summary.js';

/** 固定注记：报告输出可信度评分而非真伪断言（html.ts 同步使用）。 */
export const CREDIBILITY_NOTE = '本报告输出可信度评分与异常证据，不对模型真伪做二元断言；结论与退出码仅供 CI 门禁参考。';

export function renderMarkdown(report: AuditReport): string {
  const lines: string[] = [];
  const meta = report.meta;
  lines.push(`# model-xray 报告 — ${singleLine(meta.model)}`);
  lines.push('');
  lines.push(
    `> 可信度总分：**${report.total ?? '未判定'}${report.total === null ? '' : '/100'}** · 结论：**${levelLabel(report.overall)}**`,
  );
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
  // 说明段固定渲染：无论 report.notes 是否为空，固定注记（CREDIBILITY_NOTE）总是追加在末尾
  const notes = [...report.notes, CREDIBILITY_NOTE];
  lines.push('## 说明');
  lines.push('');
  for (const note of notes) lines.push(`- ${singleLine(note)}`);
  lines.push('');

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
  // 计费维度：倍率/金额摘要块紧跟 headline（倍率是用户最关心的数字，不许埋在几十行原始指标里）。
  if (outcome.id === 'billing') {
    const rows = billingSummaryRows(outcome.metrics);
    if (rows.length > 0) {
      lines.push('**计费与倍率**');
      lines.push('');
      lines.push('| 指标 | 值 |');
      lines.push('|---|---|');
      for (const [, label, value] of rows) {
        lines.push(`| ${cell(label)} | ${cell(value)} |`);
      }
      lines.push('');
    }
  }
  if (outcome.findings.length > 0) {
    for (const finding of outcome.findings) {
      const tag = finding.level === 'fail' ? 'FAIL' : finding.level === 'warn' ? 'WARN' : 'INFO';
      const refs = finding.evidenceIds.length > 0 ? `（证据：${finding.evidenceIds.join(', ')}）` : '';
      lines.push(`- **${tag}** ${cell(finding.message)}${refs}`);
    }
    lines.push('');
  }
  const metricEntries = Object.entries(outcome.metrics).filter(([key, v]) => v !== null && !HIDDEN_METRICS.has(key));
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

/**
 * 人读报告（Markdown/HTML）隐藏的大型内部 metrics：完整模型倍率表是「模型名 → 倍率数组」的
 * JSON 串，几百个模型时能把人读版刷成几千行。JSON 报告保留原文（机器消费方/基线构建依赖）。
 */
export const HIDDEN_METRICS = new Set(['declared_models_json', 'declared_group_ratio_json']);

/**
 * 计费维度「计费与倍率」摘要块的固定展示顺序与中文标签。
 * 只列「决定性 + 解释性」指标：公示倍率、实测倍率、金额核验、以及「为什么没有倍率」的原因字段
 * （余额探测原因 / 污染标记 / 证据等级）；其余原始指标仍由下方完整指标表承载。
 * 控制台 web/app.js 有一份同口径副本（web/ 不参与 tsc 编译，无法直接 import 复用），
 * 两侧一致性由 test/unit/report.test.ts 的漂移钉子守住。
 */
export const BILLING_METRIC_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['pricing_state', '公示价接口'],
  ['declared_source', '公示价来源类型'],
  ['declared_origin', '公示价来源'],
  ['declared_captured_at', '公示价抓取时刻'],
  ['declared_group', '生效分组'],
  ['declared_group_ratio', '分组折扣倍率'],
  ['group_ratio_verified', '分组倍率可信'],
  ['declared_model_ratio', '公示输入倍率'],
  ['declared_completion_ratio', '公示输出倍率'],
  ['cache_ratio', '缓存倍率'],
  ['declared_drift_count', '公示价漂移项数'],
  ['declared_drift_fields', '公示价漂移字段'],
  ['public_price_state', '公开价表状态'],
  ['public_price_page', '公开价表页面'],
  ['public_price_reason', '公开价表原因'],
  ['public_price_entries', '公开价表条目数'],
  ['public_price_matched', '公开价表命中模型'],
  ['public_price_input_usd_per_m', '公开价输入价（$/百万）'],
  ['public_price_output_usd_per_m', '公开价输出价（$/百万）'],
  ['public_price_cached_usd_per_m', '公开价缓存价（$/百万）'],
  ['public_price_list_input_usd_per_m', '公开价列表输入价（$/百万）'],
  ['public_price_list_output_usd_per_m', '公开价列表输出价（$/百万）'],
  ['public_price_list_cached_usd_per_m', '公开价列表缓存价（$/百万）'],
  ['scraped_price_state', '网页抓价状态'],
  ['scraped_price_reason', '网页抓价原因'],
  ['scraped_price_page', '抓价页面'],
  ['scraped_price_matched', '抓价命中模型'],
  ['scraped_price_input_usd_per_m', '抓价输入价（$/百万）'],
  ['scraped_price_output_usd_per_m', '抓价输出价（$/百万）'],
  ['scraped_price_confidence', '抓价置信度'],
  ['scraped_price_currency', '抓价币种'],
  ['measured_ratio', '实测倍率'],
  ['ratio_verified', '实测倍率可信'],
  ['ratio_masked_verdict', '实测倍率结论'],
  ['ratio_contaminated', '倍率被污染'],
  ['ratio_samples', '倍率样本数'],
  ['ratio_dropped', '丢弃样本数'],
  ['balance_endpoint', '余额端点'],
  ['balance_probe_reason', '余额探测原因'],
  ['balance_unit', '余额读数单位'],
  ['balance_resolution', '余额读数刻度'],
  ['balance_calibrated_unit', '校准后单位'],
  ['balance_calibration_confidence', '单位校准置信度'],
  ['balance_scope', '余额口径'],
  ['balance_pre_settled', '前快照已结算'],
  ['balance_post_settled', '后快照已结算'],
  ['balance_before', '请求前余额读数'],
  ['balance_after', '请求后余额读数'],
  ['spend_delta', '余额扣费差值'],
  ['money_check_state', '金额核验状态'],
  ['money_verified', '金额已核验'],
  ['absolute_reconciliation', '绝对对账'],
  ['expected_cost_usd_declared', '按公示价应缴（USD）'],
  ['expected_quota_declared', '按公示价应缴（quota）'],
  ['cost_is_upper_bound', '应缴额为上界'],
  ['cost_is_lower_bound', '应缴额为下界'],
  ['calibration_confidence', '单位校准置信度'],
  ['reference_source', '令牌基准来源'],
  ['reference_verified', '令牌基准已核验'],
  ['quota_to_usd', 'quota→USD 系数'],
  ['quota_per_unit', '站点 quota 每美元'],
  ['expected_cost', '本轮应缴额'],
  ['price_input', '宣称输入价（$/百万）'],
  ['price_output', '宣称输出价（$/百万）'],
  ['price_cached_read', '宣称缓存读价（$/百万）'],
  ['price_threshold', '阶梯阈值（tokens）'],
  ['price_input2', '二档输入价（$/百万）'],
  ['price_output2', '二档输出价（$/百万）'],
  ['price_cached_read2', '二档缓存读价（$/百万）'],
  ['echo_model_mismatch', '回显模型不一致'],
  ['requests', '请求数'],
  ['details_reported_count', '已回报样本数'],
  ['usage_missing', 'usage 缺失数'],
  ['usage_inconsistent', 'usage 不一致数'],
  ['constant_usage', '恒定 usage 数'],
  ['completion_ratio_en', '输出侧倍率（英文题）'],
  ['completion_ratio_zh', '输出侧倍率（中文题）'],
  ['completion_pair_samples_en', '输出侧配对样本（英）'],
  ['completion_pair_samples_zh', '输出侧配对样本（中）'],
  ['slope_en', '输入 token 斜率（英）'],
  ['slope_zh', '输入 token 斜率（中）'],
  ['r2_en', '回归 R²（英）'],
  ['r2_zh', '回归 R²（中）'],
  ['evidence_level', '证据等级'],
];

/**
 * 计费摘要行：[指标 key, 中文标签, 文本值]。
 * 只输出报告里实际存在且非 null 的指标（缺失即不出现，绝不用占位值冒充结论）。
 */
export function billingSummaryRows(metrics: Record<string, number | string | null>): Array<[string, string, string]> {
  const present = new Map(
    Object.entries(metrics).filter(
      ([key, value]) => value !== null && value !== undefined && !HIDDEN_METRICS.has(key),
    ),
  );
  const rows: Array<[string, string, string]> = [];
  for (const [key, label] of BILLING_METRIC_LABELS) {
    if (!present.has(key)) continue;
    rows.push([key, label, String(present.get(key))]);
  }
  return rows;
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
  // 上游回显模型：与请求模型不一致是换壳/降级冒充的机器证据，报告里必须肉眼可见
  if (record.response.model !== null) {
    const echo = record.response.model;
    lines.push(`- 回显模型: ${quote(echo)}${echo === record.request.model ? '' : `（请求 ${record.request.model}）`}`);
  }
  const reqNote = record.request.lastUserChars > 500 ? '（Markdown 摘要最多 500 字符，JSON 保留 800 字符头部 + 400 字符尾部预览与完整字符数）' : '';
  const respNote = record.response.textChars > 500 ? '（Markdown 摘要最多 500 字符，JSON 保留 800 字符预览与完整字符数）' : '';
  lines.push(`- 请求摘要${reqNote}: ${quote(record.request.lastUserPreview)}`);
  if (record.request.lastUserTailPreview) {
    lines.push(`- 请求结尾（长请求尾部摘要，用于核对问题是否在末尾）: ${quote(record.request.lastUserTailPreview)}`);
  }
  lines.push(`- 响应摘要${respNote}: ${quote(record.response.textPreview)}`);
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
