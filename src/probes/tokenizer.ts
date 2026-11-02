import type { ChatMessage, Finding, OpenAIClient, ProbeCtx, ProbeOutcome } from '../types.js';
import { recordCall } from '../evidence.js';
import { median } from '../stats.js';

interface TokenizerCorpus {
  id: string;
  category: string;
  text: string;
}

const CORPUS: readonly TokenizerCorpus[] = [
  { id: 'baseline', category: 'baseline', text: 'Reply with OK.' },
  { id: 'digits', category: 'digits', text: '0123456789'.repeat(20) },
  {
    id: 'chinese',
    category: 'chinese',
    text: '模型检测需要比较输入分词与输出结构，并核对协议元数据。'.repeat(4),
  },
  {
    id: 'cjk',
    category: 'cjk',
    text: '日本語の文章です。한국어 문장입니다。中文混排。'.repeat(4),
  },
  {
    id: 'emoji',
    category: 'emoji',
    text: '😀🚀🧪🛰️🧬🎯'.repeat(10),
  },
  {
    id: 'code',
    category: 'code',
    text: 'function f(x){return x.map(v=>v+1).filter(Boolean);}'.repeat(5),
  },
  {
    id: 'mixed',
    category: 'mixed',
    text: 'alpha beta gamma delta 123 中文 日本語 한국어 😀\n'.repeat(8),
  },
];

interface Sample {
  id: string;
  mainTokens: number;
  referenceTokens: number;
}

export async function probeTokenizer(ctx: ProbeCtx): Promise<ProbeOutcome> {
  const referenceClient = ctx.referenceClient ?? null;
  const referenceModel = ctx.referenceModel ?? null;
  if (referenceClient === null || referenceModel === null) {
    return {
      id: 'tokenizer',
      status: 'insufficient',
      score: null,
      level: 'unknown',
      headline: '未配置参考端点：无法计算 tokenizer 差分指纹',
      findings: [
        {
          level: 'info',
          message:
            '配置 --reference-base-url、--reference-api-key（或 MODEL_XRAY_REFERENCE_KEY）和可选 --reference-model 后，可用同一固定语料比较输入 token 向量，识别同族换芯/不同 tokenizer。未配置时不伪造结论。',
          evidenceIds: [],
        },
      ],
      metrics: { reference_configured: 0 },
    };
  }

  const findings: Finding[] = [];
  const samples: Sample[] = [];
  const attemptedEvidenceIds: string[] = [];
  let attempts = 0;
  for (const corpus of CORPUS) {
    const messages: ChatMessage[] = [{ role: 'user', content: corpus.text }];
    const main = await measure(ctx.client, ctx.cfg.model, corpus, messages, 'main', ctx);
    const reference = await measure(referenceClient, referenceModel, corpus, messages, 'reference', ctx);
    attempts += main.evidenceIds.length + reference.evidenceIds.length;
    attemptedEvidenceIds.push(...main.evidenceIds, ...reference.evidenceIds);
    if (main.tokens === null || reference.tokens === null) continue;
    samples.push({
      id: corpus.id,
      mainTokens: main.tokens,
      referenceTokens: reference.tokens,
    });
  }

  const baseline = samples.find((sample) => sample.id === 'baseline');
  if (baseline === undefined) {
    return {
      id: 'tokenizer',
      status: 'insufficient',
      score: null,
      level: 'unknown',
      headline: 'tokenizer 指纹证据不足：参考端点未返回可用 usage',
      findings: [
        {
          level: 'warn',
          message: '主端点或参考端点的基线样本缺少有效 usage.prompt_tokens，无法消除聊天模板开销；本次不做 tokenizer 判定。',
          evidenceIds: attemptedEvidenceIds,
        },
      ],
      metrics: { reference_configured: 1, compared: 0 },
    };
  }

  const comparable = samples
    .filter((sample) => sample.id !== 'baseline')
    .map((sample) => {
      const mainDelta = sample.mainTokens - baseline.mainTokens;
      const referenceDelta = sample.referenceTokens - baseline.referenceTokens;
      const absDiff = Math.abs(mainDelta - referenceDelta);
      const relativeDelta = absDiff / Math.max(1, Math.abs(referenceDelta));
      return { ...sample, mainDelta, referenceDelta, absDiff, relativeDelta };
    });

  const deltas = comparable.map((sample) => sample.relativeDelta);
  const medianDelta = median(deltas);
  const mismatches = comparable.filter(
    (sample) => sample.absDiff >= 2 && sample.relativeDelta >= 0.2,
  );
  const mismatchRatio = comparable.length > 0 ? mismatches.length / comparable.length : 0;
  const compared = comparable.length;

  if (compared < 5) {
    return {
      id: 'tokenizer',
      status: 'insufficient',
      score: null,
      level: 'unknown',
      headline: `tokenizer 指纹证据不足：仅 ${compared} 类语料可比`,
      findings: [
        {
          level: 'warn',
          message: `需要至少 5 类有效 tokenizer 样本，本次仅 ${compared} 类；已获得的差分不用于评分。`,
          evidenceIds: attemptedEvidenceIds,
        },
      ],
      metrics: {
        reference_configured: 1,
        compared,
      },
    };
  }

  const vector = comparable
    .map((sample) => `${sample.id}:main=${sample.mainDelta},ref=${sample.referenceDelta}`)
    .join('|');
  const mainIds = collectDistinct(ctx, 'main', 'responseId');
  const referenceIds = collectDistinct(ctx, 'reference', 'responseId');
  const responseIdDiffers =
    mainIds.size > 0 && referenceIds.size > 0 && ![...mainIds].some((id) => referenceIds.has(id));
  const fingerprintMissing = collectDistinct(ctx, 'main', 'systemFingerprint').size === 0;

  let level: ProbeOutcome['level'];
  let score: number;
  let headline: string;
  if (mismatches.length >= 3 && mismatchRatio >= 0.5 && medianDelta >= 0.2) {
    level = 'fail';
    score = Math.max(10, Math.round(100 - mismatchRatio * 70 - Math.min(20, medianDelta * 20)));
    headline = `tokenizer 指纹显著不匹配：${mismatches.length}/${compared} 类语料偏离参考端点`;
    findings.push({
      level: 'fail',
      message:
        `主端点与参考模型 ${referenceModel} 的输入 token 向量系统性不一致（${mismatches.length}/${compared} 类，` +
        `中位相对差 ${(medianDelta * 100).toFixed(1)}%）。这强烈提示 tokenizer/模型族或上游实现不同；` +
        '单一差异不算实锤，本结论基于多类别一致偏离。',
      evidenceIds: collectEvidenceIds(ctx),
    });
  } else if (mismatches.length >= 2 || medianDelta >= 0.12) {
    level = 'warn';
    score = Math.round(Math.max(50, 82 - medianDelta * 40));
    headline = `tokenizer 指纹存在偏差：${mismatches.length}/${compared} 类语料异常`;
    findings.push({
      level: 'warn',
      message:
        `tokenizer 向量与参考端点存在局部差异（${mismatches.length}/${compared} 类，中位相对差 ` +
        `${(medianDelta * 100).toFixed(1)}%）。可能是版本/路由/模板差异，建议复测并结合身份与质量证据复核。`,
      evidenceIds: collectEvidenceIds(ctx),
    });
  } else {
    level = 'pass';
    score = Math.round(100 - mismatchRatio * 10);
    headline = `tokenizer 指纹与参考端点一致：${compared} 类语料`;
    findings.push({
      level: 'info',
      message: `固定语料的输入 token 增量与参考端点一致（中位相对差 ${(medianDelta * 100).toFixed(1)}%）。该证据不能单独证明模型身份。`,
      evidenceIds: collectEvidenceIds(ctx),
    });
  }

  if (responseIdDiffers || fingerprintMissing) {
    findings.push({
      level: 'info',
      message:
        '协议元数据仅作旁证：response id/请求头会因网关不同而不同，system_fingerprint 缺失也不构成换芯证据。',
      evidenceIds: [],
    });
  }

  return {
    id: 'tokenizer',
    status: 'ok',
    score,
    level,
    headline,
    findings,
    metrics: {
      reference_configured: 1,
      reference_model: referenceModel,
      compared,
      mismatches: mismatches.length,
      median_relative_delta: Math.round(medianDelta * 1000) / 1000,
      vector,
      samples: attempts,
    },
  };
}

async function measure(
  client: OpenAIClient,
  model: string,
  corpus: TokenizerCorpus,
  messages: ChatMessage[],
  side: 'main' | 'reference',
  ctx: ProbeCtx,
): Promise<{ tokens: number | null; evidenceIds: string[] }> {
  const result = await client.chat({
    model,
    messages,
    temperature: 0,
    max_tokens: 1,
  });
  const evidence = recordCall(ctx.evidence, {
    probe: 'tokenizer',
    endpoint: side,
    label: `${side} ${corpus.id}`,
    request: { model, stream: false, temperature: 0, maxTokens: 1, messages },
    result,
  });
  return { tokens: result.ok ? (result.usage?.prompt_tokens ?? null) : null, evidenceIds: [evidence.id] };
}

function collectEvidenceIds(ctx: ProbeCtx): string[] {
  return ctx.evidence
    .all()
    .filter((record) => record.probe === 'tokenizer')
    .map((record) => record.id);
}

function collectDistinct(
  ctx: ProbeCtx,
  side: 'main' | 'reference',
  key: 'responseId' | 'systemFingerprint',
): Set<string> {
  const values = new Set<string>();
  for (const record of ctx.evidence.all()) {
    if (record.probe !== 'tokenizer' || !record.label.startsWith(`${side} `)) continue;
    const value = record.response[key];
    if (typeof value === 'string' && value !== '') values.add(value);
  }
  return values;
}
