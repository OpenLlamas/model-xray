import type { AuditReport, EvidenceRecord, ProbeOutcome } from '../types.js';
import { statusTag, verdictLabel } from '../scoring.js';
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
  // 倍率摘要：终端输出也要一眼看到「你填的单价÷站点现价 / 实扣倍率 / 金额核验状态」，
  // 否则用户只看到 "token 计数核验通过" 这类文字，看不到任何倍率数字。
  const billing = report.outcomes.find((outcome) => outcome.id === 'billing');
  if (billing !== undefined) {
    const values = new Map(billingSummaryRows(billing.metrics).map(([key, , value]) => [key, value]));
    const measured = values.get('measured_ratio');
    const declaredModel = values.get('declared_model_ratio');
    const declaredCompletion = values.get('declared_completion_ratio');
    if (
      measured !== undefined ||
      declaredModel !== undefined ||
      declaredCompletion !== undefined ||
      values.has('claimed_price_ratio_input') ||
      values.has('public_price_ratio_input') ||
      values.has('expected_cost_usd_declared')
    ) {
      const fmtRatio = (value: unknown): string | null => {
        // billingSummaryRows 统一把指标转成字符串；这里必须接受数字字符串，否则实测/列表价倍率永远读不到。
        const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
        return Number.isFinite(parsed) ? `${Math.round(parsed * 1000) / 1000}×` : null;
      };
      const measuredText = fmtRatio(measured);
      const claimedInValue = values.get('claimed_price_ratio_input');
      const claimedOutValue = values.get('claimed_price_ratio_output');
      const claimedIn = fmtRatio(claimedInValue);
      const claimedOut = fmtRatio(claimedOutValue);
      const claimedEqual =
        claimedIn !== null &&
        claimedOut !== null &&
        Number.isFinite(Number(claimedInValue)) &&
        Number.isFinite(Number(claimedOutValue)) &&
        Math.abs(Number(claimedInValue) - Number(claimedOutValue)) < 1e-9;
      const listInValue = values.get('public_price_ratio_input');
      const listOutValue = values.get('public_price_ratio_output');
      const listIn = fmtRatio(listInValue);
      const listOut = fmtRatio(listOutValue);
      const listEqual =
        listIn !== null &&
        listOut !== null &&
        Number.isFinite(Number(listInValue)) &&
        Number.isFinite(Number(listOutValue)) &&
        Math.abs(Number(listInValue) - Number(listOutValue)) < 1e-9;
      const pairText = (
        input: string | null,
        output: string | null,
        equal: boolean,
        equalNote = '输入/输出一致',
        note = '',
      ): string => {
        if (equal) return `${input}（${equalNote}）`;
        const text = `输入 ${input ?? '-'} / 输出 ${output ?? '-'}`;
        return note !== '' ? `${text}（${note}）` : text;
      };
      let ratioText: string;
      if (measuredText !== null) {
        ratioText = `实扣倍率 ${measuredText}`;
      } else if (claimedIn !== null || claimedOut !== null) {
        // 用户直觉里的倍率：录入价 ÷ 官方公示价。用户与官方一致时应为 1×。
        // 列表价折扣是另一个口径（站内促销），只作为附注，不能抢主位。
        // 只比两张价目表，不含实收证据，必须显式标「未看实扣」。
        ratioText = `你填的单价÷站点现价 ${pairText(
          claimedIn,
          claimedOut,
          claimedEqual,
          '输入/输出一致；只比价目，未看实扣',
          '只比价目，未看实扣',
        )}`;
        if (listIn !== null || listOut !== null) {
          ratioText += ` · 站点现价÷官方列表价 ${pairText(listIn, listOut, listEqual, '输入/输出一致，仅披露', '仅披露')}`;
        }
        if (measured !== undefined) ratioText += ' · 实际扣款未核对';
      } else if (listIn !== null || listOut !== null) {
        // 没有宣称价可比时才退回列表价折扣，并明确它不代表计费倍率。
        ratioText = `站点现价÷官方列表价 ${pairText(
          listIn,
          listOut,
          listEqual,
          '输入/输出一致；站点现价÷官方列表价，仅披露',
          '站点现价÷官方列表价，仅披露',
        )}`;
        if (measured !== undefined) ratioText += ' · 实际扣款未核对';
      } else {
        ratioText = measured !== undefined ? `实扣 ${measured ?? '-'}` : '不可得（缺录入价或站点现价）';
      }
      const totalCostRaw = values.get('expected_cost_usd_declared');
      const totalCost =
        totalCostRaw !== undefined && totalCostRaw.trim() !== '' && Number.isFinite(Number(totalCostRaw))
          ? Number(totalCostRaw)
          : null;
      const costText =
        totalCost === null
          ? null
          : `本轮测试按价目应扣 $${Math.round(totalCost * 1000) / 1000}（估算${
              values.get('cost_is_upper_bound') === '1' ? '，上界' : ''
            }）`;
      const lineParts = [`倍率: ${ratioText}`];
      if (costText !== null) lineParts.push(costText);
      lineParts.push(`金额核验 ${values.get('money_check_state') ?? '-'}`);
      lines.push(lineParts.join(' · '));
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
      verdictLabel(report.overall) === '不通过'
        ? '存在乱收费/换壳实锤（计费或身份维度不通过），结论：不通过'
        : '证据不足，无法得出结论';
    lines.push(`可信度总分 未判定 — ${reason}`);
  } else {
    const verdict = verdictLabel(report.overall);
    lines.push(
      verdict === null
        ? // 非实锤不设结论档：只展示分数（「可疑」结论档已移除）
          `可信度总分 ${report.total}/100`
        : colorize(`可信度总分 ${report.total}/100 — ${verdict}`, report.overall, color),
    );
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
