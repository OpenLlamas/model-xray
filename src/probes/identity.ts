import type { ChatMessage, ProbeCtx, ProbeOutcome, ChatResult, Finding } from '../types.js';
import { IDENTITY_QUESTIONS, SCHEMA_PROBES } from '../assets.js';
import { recordCall } from '../evidence.js';

const REFUSAL_PATTERNS: readonly RegExp[] = [
  /无法(告知|回答|确认|提供)|不能(告知|透露|确认)|不便(告知|透露)/,
  /抱歉[，,].*(不能|无法|不可以)/,
  /(I('m| am) (sorry|unable|not able))|cannot (tell|reveal|confirm)/i,
  /(don't|do not) have (access to )?(my )?(model|identity)/i,
];

const MODEL_ALIAS: readonly (readonly [string, RegExp])[] = [
  ['gpt', /\bgpt[-\s]?([0-9][\w.]*)?|openai/i],
  ['claude', /claude|anthropic/i],
  ['gemini', /gemini|google\b|deepmind/i],
  ['deepseek', /deepseek|深度求索/i],
  ['qwen', /\bqwen|通义|千问|alibaba|阿里巴巴/i],
  ['glm', /\bglm|智谱|zhipu|chatglm/i],
  ['llama', /llama|meta ai|meta\b/i],
  ['mistral', /mistral|mixtral/i],
  ['grok', /grok|xai|x\.ai/i],
  ['kimi', /kimi|moonshot|月之暗面/i],
  ['doubao', /doubao|豆包|字节|bytedance/i],
  ['ernie', /ernie|文心|baidu|百度/i],
];

interface IdentitySample {
  question: string;
  result: ChatResult;
  evidenceId: string;
}

function detectFalsified(samples: readonly IdentitySample[], expect: readonly string[]): boolean {
  if (expect.length === 0) return false;
  const expectedAliases = new Set<string>();
  for (const target of expect) {
    for (const [name, pattern] of MODEL_ALIAS) {
      if (pattern.test(target)) expectedAliases.add(name);
    }
  }
  if (expectedAliases.size === 0) return false;
  let mismatch = 0;
  for (const sample of samples) {
    const declared = new Set<string>();
    for (const [name, pattern] of MODEL_ALIAS) {
      if (pattern.test(sample.result.text)) declared.add(name);
    }
    if (declared.size === 0) continue;
    const consistentWithExpect = [...declared].some((d) => expectedAliases.has(d));
    if (!consistentWithExpect) mismatch += 1;
  }
  return mismatch >= 3;
}

export async function probeIdentity(ctx: ProbeCtx): Promise<ProbeOutcome> {
  const findings: Finding[] = [];
  const metrics: Record<string, number | string | null> = {};
  const samples: IdentitySample[] = [];
  const questions = ctx.rng.shuffle(IDENTITY_QUESTIONS).slice(0, 3);

  for (const question of questions) {
    const result = await ctx.client.chat({
      model: ctx.cfg.model,
      messages: [{ role: 'user', content: question } satisfies ChatMessage],
      temperature: 0.7,
      max_tokens: 200,
    });
    const evidence = recordCall(ctx.evidence, {
      probe: 'identity',
      label: `self-id: ${question.slice(0, 24)}`,
      request: { model: ctx.cfg.model, stream: false, temperature: 0.7, maxTokens: 200, messages: [{ content: question }] },
      result,
    });
    if (!result.ok) {
      findings.push({ level: 'warn', message: `身份问答请求失败：${result.error ?? 'unknown'}`, evidenceIds: [evidence.id] });
      continue;
    }
    samples.push({ question, result, evidenceId: evidence.id });
  }

  const texts = samples.map((s) => s.result.text);
  const normalized = texts.map(normalize);
  const answerable = normalized.filter((t) => t.length >= 3).length;
  const identicalPairs = normalized.filter((t, i) => i > 0 && t === normalized[i - 1]).length;

  const schemaProbe = ctx.rng.pick(SCHEMA_PROBES);
  const schemaResult = await ctx.client.chat({
    model: ctx.cfg.model,
    messages: [{ role: 'user', content: schemaProbe.prompt } satisfies ChatMessage],
    temperature: 0,
    max_tokens: 200,
  });
  const schemaEvidence = recordCall(ctx.evidence, {
    probe: 'identity',
    label: 'json-schema compliance',
    request: { model: ctx.cfg.model, stream: false, temperature: 0, maxTokens: 200, messages: [{ content: schemaProbe.prompt }] },
    result: schemaResult,
  });
  const schemaParsed = parseJsonLoose(schemaResult.text);
  const schemaKeysOk = schemaParsed !== null && schemaProbe.keys.every((key) => key in schemaParsed);
  const schemaValuesOk = schemaKeysOk && schemaProbe.keys.every((key) => schemaParsed !== null && schemaParsed[key] !== undefined);

  metrics['samples'] = samples.length;
  metrics['identical_samples'] = identicalPairs;
  metrics['schema_compliant'] = schemaResult.ok ? (schemaKeysOk && schemaValuesOk ? 1 : 0) : 'N/A';

  const refusalCount = texts.filter((t) => REFUSAL_PATTERNS.some((p) => p.test(t))).length;
  metrics['refusals'] = refusalCount;

  if (samples.length === 0) {
    return {
      id: 'identity',
      status: 'insufficient',
      score: null,
      level: 'unknown',
      headline: '身份探针无有效样本（自述请求全部失败），无法核验',
      findings,
      metrics,
    };
  }

  const falsified = detectFalsified(samples, [ctx.cfg.model]);

  let score = 100;
  let level: ProbeOutcome['level'] = 'pass';
  let headline = '身份探针未见异常';

  if (falsified) {
    score = 0;
    level = 'fail';
    headline = `身份矛盾：${samples.length} 次自述均未提及目标模型族（${ctx.cfg.model} 或其厂商）`;
    findings.push({
      level: 'fail',
      message: `目标模型族为 ${ctx.cfg.model}，但每次自述都指向其他模型族。自述不可单独定罪，但与其余探针一致时构成换壳证据。`,
      evidenceIds: samples.map((s) => s.evidenceId),
    });
  }
  if (answerable === 0 && samples.length > 0) {
    score = Math.min(score, 30);
    level = 'fail';
    headline = '身份探针无有效回答';
    findings.push({
      level: 'fail',
      message: '自述问题均无实质回答（空响应或纯拒答），无法完成身份核验。',
      evidenceIds: [],
    });
  } else if (refusalCount >= 3 && !falsified) {
    findings.push({ level: 'warn', message: '自述问题全部被回避，行为指纹结论置信度低。', evidenceIds: [] });
    score = Math.min(score, 85);
    if (level === 'pass') level = 'warn';
  }
  if (identicalPairs >= 2 && samples.length === 3) {
    findings.push({ level: 'warn', message: '多次采样回答逐字一致，疑似模板特判或缓存。', evidenceIds: [] });
    score = Math.min(score, 70);
    if (level === 'pass') level = 'warn';
  }
  if (schemaResult.ok && !schemaKeysOk) {
    findings.push({ level: 'warn', message: '严格 JSON 输出探针未按结构返回（弱指纹：网关可能重写响应）。', evidenceIds: [schemaEvidence.id] });
    score = Math.min(score, 90);
  }

  findings.push({ level: 'info', message: `共采样 ${samples.length} 次自述 + 1 次格式合规探针。`, evidenceIds: [] });
  return { id: 'identity', status: 'ok', score, level, headline, findings, metrics };
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function parseJsonLoose(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}
