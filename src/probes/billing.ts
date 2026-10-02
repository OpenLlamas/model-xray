import type { ChatMessage, Finding, ProbeCtx, ProbeOutcome } from '../types.js';
import { estimateMessageTokens } from '../tokens.js';
import { linearRegression, mean } from '../stats.js';
import { recordCall } from '../evidence.js';

const FILLER_EN =
  'The quick brown fox jumps over the lazy dog while engineers keep measuring latency and correctness in production systems. ';

export async function probeBilling(ctx: ProbeCtx): Promise<ProbeOutcome> {
  const findings: Finding[] = [];
  const metrics: Record<string, number | string | null> = {};
  const levels = ctx.cfg.deep ? [2000, 4000, 8000, 16000, 24000, 32000] : [2000, 4000, 8000, 16000, 24000];
  const langs: Array<'en' | 'zh'> = ['en', 'zh'];

  interface Track {
    lang: 'en' | 'zh';
    xs: number[];
    ys: number[];
    raws: number[];
  }
  const tracks: Track[] = langs.map((lang) => ({ lang, xs: [], ys: [], raws: [] }));
  const allResponses: number[] = [];
  let usageMissing = 0;
  let requests = 0;
  const failures: string[] = [];

  for (const lang of langs) {
    for (const targetTokens of levels) {
      const track = tracks.find((t) => t.lang === lang) as Track;
      const nonce = ctx.rng.nonce(5);
      const body =
        lang === 'en'
          ? buildEnglish(targetTokens)
          : buildChinese(targetTokens);
      const prompt = `请逐字复述下面这段文本，不要添加任何其他内容。\n\n${body}\n\n（本段校验编号 ${nonce}）`;
      const messages: ChatMessage[] = [{ role: 'user', content: prompt }];
      const result = await ctx.client.chat({
        model: ctx.cfg.model,
        messages,
        temperature: 0,
        max_tokens: 16,
      });
      const evidence = recordCall(ctx.evidence, {
        probe: 'billing',
        label: `billing ${lang} target=${targetTokens}`,
        request: { model: ctx.cfg.model, stream: false, temperature: 0, maxTokens: 16, messages },
        result,
      });
      requests += 1;
      if (!result.ok) {
        failures.push(`${lang}@${targetTokens}: ${result.error ?? 'error'}`);
        continue;
      }
      if (!result.usage) {
        usageMissing += 1;
        findings.push({
          level: 'warn',
          message: `请求（${lang}，目标 ${targetTokens} tokens）未返回 usage，无法参与回归。`,
          evidenceIds: [evidence.id],
        });
        continue;
      }
      const estimated = estimateMessageTokens(messages);
      track.xs.push(estimated);
      track.ys.push(result.usage.prompt_tokens);
      track.raws.push(result.usage.prompt_tokens);
      allResponses.push(result.usage.prompt_tokens);
      metrics[`prompt_tokens_${lang}_${targetTokens}`] = result.usage.prompt_tokens;
    }
  }

  const constantUsage = allResponses.length >= 3 && new Set(allResponses).size === 1;
  metrics['requests'] = requests;
  metrics['usage_missing'] = usageMissing;
  metrics['constant_usage'] = constantUsage ? 1 : 0;

  if (failures.length > 0) {
    findings.push({ level: 'warn', message: `部分计费探针请求失败：${failures.slice(0, 4).join('；')}`, evidenceIds: [] });
  }

  let score = 100;
  let level: ProbeOutcome['level'] = 'pass';
  let headline = 'Token 计数与长度线性关系正常';

  if (constantUsage) {
    score = 0;
    level = 'fail';
    headline = 'usage 恒定不变：对任意长度的输入返回同一个 token 计数，计费数据不可信';
    findings.push({ level: 'fail', message: '端点对 3+ 个不同长度的请求返回完全相同的 prompt_tokens，这是伪造计费的直接证据。', evidenceIds: [] });
  } else {
    for (const track of tracks) {
      if (track.xs.length < 3) continue;
      const reg = linearRegression(track.xs, track.ys);
      metrics[`slope_${track.lang}`] = round(reg.slope);
      metrics[`r2_${track.lang}`] = round(reg.r2);
      metrics[`intercept_${track.lang}`] = round(reg.intercept);
      if (reg.r2 < 0.98) {
        score = Math.min(score, 40);
        level = escalate(level, 'warn');
        headline = `usage 与输入长度非线性（${track.lang} R²=${round(reg.r2)}），存在异常`;
        findings.push({
          level: 'fail',
          message: `${track.lang} 轨道回归 R²=${round(reg.r2)}（<0.98）：token 计数不随输入长度稳定增长，疑似计数造假或按请求硬编码。`,
          evidenceIds: [],
        });
      }
      const ratio = reg.slope;
      if (ratio < 0.05 || ratio > 1.6) {
        score = Math.min(score, 30);
        level = escalate(level, 'fail');
        headline = `usage 斜率异常（${track.lang} slope=${round(ratio)}）`;
        findings.push({
          level: 'fail',
          message: `${track.lang} 轨道斜率 ${round(ratio)} tokens/估算token，超出合理区间 [0.05, 1.6]，疑似虚增或压缩计费。`,
          evidenceIds: [],
        });
      }
    }
    const enTrack = tracks.find((t) => t.lang === 'en') as Track;
    const zhTrack = tracks.find((t) => t.lang === 'zh') as Track;
    if (enTrack.xs.length >= 3 && zhTrack.xs.length >= 3) {
      const enRatio = linearRegression(enTrack.xs, enTrack.ys).slope;
      const zhRatio = linearRegression(zhTrack.xs, zhTrack.ys).slope;
      metrics['zh_en_slope_ratio'] = round(zhRatio / Math.max(enRatio, 0.001));
      if (enRatio > 0 && zhRatio / enRatio > 2.5) {
        findings.push({ level: 'warn', message: '中文轨道计费斜率异常高于英文轨道，可能存在按字符数而非 token 计费的伪装。', evidenceIds: [] });
        score = Math.min(score, 55);
        level = escalate(level, 'warn');
      }
    }
  }

  if (usageMissing >= Math.ceil(requests / 2) && requests > 0) {
    score = 0;
    level = 'fail';
    headline = '多数请求不返回 usage，计费不可核验';
    findings.push({ level: 'fail', message: `全部 ${requests} 次请求中 ${usageMissing} 次缺少 usage 字段。`, evidenceIds: [] });
  } else if (allResponses.length < 3) {
    return {
      id: 'billing',
      status: 'insufficient',
      score: null,
      level: 'unknown',
      headline: '计费探针样本不足（请求失败），无法运行回归',
      findings,
      metrics,
    };
  }

  if (level === 'pass') {
    findings.push({ level: 'info', message: `token 估计为保守估算（非精确 tokenizer），判据使用回归一致性而非绝对相等。`, evidenceIds: [] });
  }
  return { id: 'billing', status: 'ok', score, level, headline, findings, metrics };
}

function buildEnglish(tokens: number): string {
  return FILLER_EN.repeat(Math.max(1, Math.ceil((tokens * 4) / FILLER_EN.length)));
}

function buildChinese(tokens: number): string {
  const unit = '工程实践中必须以测量结果为准绳，而不是依赖直觉或者厂商的自我声明，只有可复现的证据链条才能支撑可靠的结论。';
  return unit.repeat(Math.max(1, Math.ceil(tokens / unit.length)));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

const LEVEL_RANK = { unknown: 0, pass: 1, warn: 2, fail: 3 } as const;

function escalate(current: ProbeOutcome['level'], next: ProbeOutcome['level']): ProbeOutcome['level'] {
  return LEVEL_RANK[next] > LEVEL_RANK[current] ? next : current;
}

export function meanY(ys: readonly number[]): number {
  return mean(ys);
}
