import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { median } from './stats.js';
import type { Finding } from './types.js';

/**
 * 计费参考计数（F3）：把本轮审计的逐档 prompt_tokens 与「同名模型历史报告」对比。
 * 动机：全量等比虚增（prompt/completion 同比例放大）在单轮审计内不可见——回归仍是完美直线、
 * 斜率也只是整体放大（[0.05,1.6] 带宽内容得下 ×1.3），只有跨审计的绝对计数对比能识别。
 */
export interface TokenReference {
  sourceFile: string; // 原始路径（报告内仅存 basename 脱敏）
  model: string;
  probesetVersion: string;
  baseUrl: string;
  startedAt: string;
  /** key: `${lang}_${level}`，如 'en_2000'（与 billing metrics 的 prompt_tokens_* 同形状） */
  promptTokens: Record<string, number>;
}

/** 加载参考报告 JSON（本工具生成的审计报告即可），逐层校验并在错误信息中给出字段路径。 */
export function loadTokenReference(path: string): TokenReference {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`无法读取参考报告：${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`参考报告不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('字段 meta 缺失或不合法');
  }
  const root = parsed as Record<string, unknown>;
  const meta = root['meta'];
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    throw new Error('字段 meta 缺失或不合法');
  }
  const metaObj = meta as Record<string, unknown>;
  const picked: Record<string, string> = {};
  for (const field of ['model', 'probesetVersion', 'baseUrl', 'startedAt'] as const) {
    const value = metaObj[field];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`字段 meta.${field} 缺失或不合法`);
    }
    picked[field] = value;
  }
  const outcomes = root['outcomes'];
  if (!Array.isArray(outcomes)) {
    throw new Error('字段 outcomes 缺失或不是数组');
  }
  const billing = outcomes.find(
    (entry) => typeof entry === 'object' && entry !== null && (entry as { id?: unknown }).id === 'billing',
  );
  if (billing === undefined) {
    throw new Error('参考报告缺少 billing 探针结果');
  }
  const metrics = (billing as { metrics?: unknown }).metrics;
  const promptTokens: Record<string, number> = {};
  if (typeof metrics === 'object' && metrics !== null) {
    for (const [key, value] of Object.entries(metrics as Record<string, unknown>)) {
      const match = /^prompt_tokens_(en|zh)_(\d+)$/.exec(key);
      if (!match) continue;
      // 有限正数才提取（负值/NaN/null 一律剔除，不参与判定）
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
      promptTokens[`${match[1]}_${match[2]}`] = value;
    }
  }
  if (Object.keys(promptTokens).length === 0) {
    throw new Error('参考报告的 billing.metrics 中未找到 prompt_tokens_* 样本');
  }
  return {
    sourceFile: path,
    model: picked['model'] as string,
    probesetVersion: picked['probesetVersion'] as string,
    baseUrl: picked['baseUrl'] as string,
    startedAt: picked['startedAt'] as string,
    promptTokens,
  };
}

export interface TokenReferenceDecision {
  verdict: 'ok' | 'warn' | 'fail' | 'skip';
  cap: number | null;
  maxRatio: number | null;
  summary: Record<string, { levels: number; max: number; min: number; median: number }>;
  finding: Finding | null;
}

const LANGS = ['en', 'zh'] as const;
const VERDICT_RANK = { ok: 1, warn: 2, fail: 3 } as const;
const STALE_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * 逐档判定（无灰区）：r>1.25 → fail；r>1.1 或 r<0.8 → warn；[0.8,1.1] → ok。
 * 语言级别 = 该语言最差档；总判定 = 两语言最差档。median 仅作 metric 展示，不驱动判定。
 */
export function decideTokenReference(
  ref: TokenReference,
  currentTokens: Record<string, number>,
  target: { model: string; probesetVersion: string },
): TokenReferenceDecision {
  if (ref.model !== target.model) {
    return skipDecision(`参考报告模型（${ref.model}）与本次（${target.model}）不一致，跳过 token 计数对比。`);
  }
  if (ref.probesetVersion !== target.probesetVersion) {
    return skipDecision(`参考报告题集版本（${ref.probesetVersion}）与本次（${target.probesetVersion}）不一致，跳过 token 计数对比。`);
  }
  const ratiosByLang = new Map<'en' | 'zh', number[]>();
  const summary: TokenReferenceDecision['summary'] = {};
  for (const lang of LANGS) {
    const ratios: number[] = [];
    for (const [key, refValue] of Object.entries(ref.promptTokens)) {
      if (!key.startsWith(`${lang}_`)) continue;
      const current = currentTokens[key];
      if (typeof current !== 'number' || !Number.isFinite(current) || current <= 0) continue;
      if (!Number.isFinite(refValue) || refValue <= 0) continue;
      ratios.push(current / refValue);
    }
    ratios.sort((a, b) => a - b);
    summary[lang] =
      ratios.length > 0
        ? {
            levels: ratios.length,
            max: round2(ratios[ratios.length - 1] as number),
            min: round2(ratios[0] as number),
            median: round2(median(ratios)),
          }
        : { levels: 0, max: 0, min: 0, median: 0 };
    if (ratios.length >= 3) ratiosByLang.set(lang, ratios);
  }
  const participating = LANGS.filter((lang) => ratiosByLang.has(lang));
  if (participating.length === 0) {
    const decision = skipDecision(
      `参考可比档位不足（en ${summary['en'] ? summary['en'].levels : 0}/3、zh ${summary['zh'] ? summary['zh'].levels : 0}/3），跳过 token 计数对比。`,
    );
    decision.summary = summary;
    return decision;
  }

  // 总判定 = 最差语言；同档时取 max 更高的语言（报表文案取「更偏离」的那条轨）
  let worstLang = participating[0] as 'en' | 'zh';
  let worstVerdict = langVerdict(ratiosByLang.get(worstLang) as number[]);
  for (const lang of participating.slice(1)) {
    const verdict = langVerdict(ratiosByLang.get(lang) as number[]);
    const langMax = (ratiosByLang.get(lang) as number[]).at(-1) as number;
    const worstMax = (ratiosByLang.get(worstLang) as number[]).at(-1) as number;
    if (VERDICT_RANK[verdict] > VERDICT_RANK[worstVerdict] || (verdict === worstVerdict && langMax > worstMax)) {
      worstLang = lang;
      worstVerdict = verdict;
    }
  }
  let maxRatio = 0;
  for (const lang of participating) {
    const arr = ratiosByLang.get(lang) as number[];
    maxRatio = Math.max(maxRatio, arr[arr.length - 1] as number);
  }
  const refLabel = `${basename(ref.sourceFile)}（${ref.model}，${ref.startedAt}）`;
  const arr = ratiosByLang.get(worstLang) as number[];
  const min = round2(arr[0] as number);
  const max = round2(arr[arr.length - 1] as number);

  if (worstVerdict === 'fail') {
    return {
      verdict: 'fail',
      cap: 30,
      maxRatio: round2(maxRatio),
      summary,
      finding: {
        level: 'fail',
        message: `token 计数与参考报告系统偏离：${worstLang} 档位比值最高 ×${max}（>1.25）——端点上报 prompt_tokens 显著高于同名模型的参考审计，疑似等比虚增计费。参考：${refLabel}。`,
        evidenceIds: [],
      },
    };
  }
  if (worstVerdict === 'warn') {
    return {
      verdict: 'warn',
      cap: 70,
      maxRatio: round2(maxRatio),
      summary,
      finding: {
        level: 'warn',
        message: `token 计数与参考报告偏离：${worstLang} 档位比值 ${min}~${max}（>1.1 或 <0.8）。参考：${refLabel}。`,
        evidenceIds: [],
      },
    };
  }
  let levels = 0;
  let globalMin = Infinity;
  let globalMax = 0;
  for (const lang of participating) {
    const langRatios = ratiosByLang.get(lang) as number[];
    levels += langRatios.length;
    globalMin = Math.min(globalMin, langRatios[0] as number);
    globalMax = Math.max(globalMax, langRatios[langRatios.length - 1] as number);
  }
  let message = `token 计数与参考报告一致（${participating.join('/')} ${levels} 档，比值 ${round2(globalMin)}~${round2(globalMax)} 均在 [0.8,1.1]）。参考：${refLabel}。`;
  const startedMs = Date.parse(ref.startedAt);
  if (Number.isFinite(startedMs) && Date.now() - startedMs > STALE_MS) {
    message += `参考报告生成于 ${ref.startedAt}（超过 180 天），注意 tokenizer 版本漂移。`;
  }
  return {
    verdict: 'ok',
    cap: null,
    maxRatio: round2(maxRatio),
    summary,
    finding: { level: 'info', message, evidenceIds: [] },
  };
}

function langVerdict(ratios: readonly number[]): 'ok' | 'warn' | 'fail' {
  let verdict: 'ok' | 'warn' | 'fail' = 'ok';
  for (const ratio of ratios) {
    if (ratio > 1.25) return 'fail';
    if (ratio > 1.1 || ratio < 0.8) verdict = 'warn';
  }
  return verdict;
}

function skipDecision(message: string): TokenReferenceDecision {
  return {
    verdict: 'skip',
    cap: null,
    maxRatio: null,
    summary: {},
    finding: { level: 'info', message, evidenceIds: [] },
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
