import type { ChatMessage, ProbeCtx, ProbeOutcome, ChatResult, Finding } from '../types.js';
import { IDENTITY_QUESTIONS, SCHEMA_PROBES } from '../assets.js';
import { recordCall } from '../evidence.js';
import { PROBE_BUDGETS, isStarved } from './starve.js';

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

function familiesIn(text: string): Set<string> {
  const declared = new Set<string>();
  for (const [name, pattern] of MODEL_ALIAS) {
    if (pattern.test(text)) declared.add(name);
  }
  return declared;
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
    const declared = familiesIn(sample.result.text);
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
  let starvedSelfId = 0;

  for (const question of questions) {
    const result = await ctx.client.chat({
      model: ctx.cfg.model,
      messages: [{ role: 'user', content: question } satisfies ChatMessage],
      temperature: 0.7,
      max_tokens: PROBE_BUDGETS.identity,
    });
    const evidence = recordCall(ctx.evidence, {
      probe: 'identity',
      label: `self-id: ${question.slice(0, 24)}`,
      request: {
        model: ctx.cfg.model,
        stream: false,
        temperature: 0.7,
        maxTokens: PROBE_BUDGETS.identity,
        messages: [{ content: question }],
      },
      result,
    });
    if (!result.ok) {
      findings.push({ level: 'warn', message: `身份问答请求失败：${result.error ?? 'unknown'}`, evidenceIds: [evidence.id] });
      continue;
    }
    if (isStarved(result)) {
      starvedSelfId += 1;
      findings.push({
        level: 'info',
        message: `自述样本「${question.slice(0, 24)}…」因推理占满预算未产出答案，视为无效样本（不计入指纹统计）。`,
        evidenceIds: [evidence.id],
      });
      continue;
    }
    samples.push({ question, result, evidenceId: evidence.id });
  }

  // starved（推理占满预算，含非空截断）样本视为无效：不参与逐字一致/族指纹统计，
  // 否则多份相同截断文本会被误判成「模板特判」，冤枉 thinking 模型。
  const texts = samples.map((s) => s.result.text);
  const normalized = texts.map(normalize);
  const answerable = normalized.filter((t) => t.length >= 3).length;
  // 逐字一致只在「非空非纯空白」的归一化文本之间统计：空响应没有指纹含义，
  // 参与相邻比较会把「多个空回答」误判成模板特判，冤枉限流/截断下的端点。
  const nonEmpty = normalized.filter((t) => t.length > 0);
  const identicalPairs = nonEmpty.filter((t, i) => i > 0 && t === nonEmpty[i - 1]).length;

  const schemaProbe = ctx.rng.pick(SCHEMA_PROBES);
  const schemaResult = await ctx.client.chat({
    model: ctx.cfg.model,
    messages: [{ role: 'user', content: schemaProbe.prompt } satisfies ChatMessage],
    temperature: 0,
    max_tokens: PROBE_BUDGETS.identity,
  });
  const schemaEvidence = recordCall(ctx.evidence, {
    probe: 'identity',
    label: 'json-schema compliance',
    request: {
      model: ctx.cfg.model,
      stream: false,
      temperature: 0,
      maxTokens: PROBE_BUDGETS.identity,
      messages: [{ content: schemaProbe.prompt }],
    },
    result: schemaResult,
  });
  const schemaStarved = isStarved(schemaResult);
  const schemaParsed = schemaStarved ? null : parseJsonLoose(schemaResult.text);
  const schemaKeysOk = schemaParsed !== null && schemaProbe.keys.every((key) => key in schemaParsed);
  const schemaValuesOk = schemaKeysOk && schemaProbe.keys.every((key) => schemaParsed !== null && schemaParsed[key] !== undefined);

  metrics['samples'] = samples.length;
  metrics['identical_samples'] = identicalPairs;
  metrics['schema_compliant'] = !schemaResult.ok || schemaStarved ? 'N/A' : (schemaKeysOk && schemaValuesOk ? 1 : 0);
  if (starvedSelfId > 0) metrics['starved_samples'] = starvedSelfId;
  if (schemaStarved) {
    findings.push({
      level: 'info',
      message: '格式合规探针因推理占满预算未产出完整 JSON（预算不足无法判定格式合规），不扣分、不作异常指控。',
      evidenceIds: [schemaEvidence.id],
    });
  }

  const refusalCount = texts.filter((t) => REFUSAL_PATTERNS.some((p) => p.test(t))).length;
  metrics['refusals'] = refusalCount;

  // 模型族指纹集合（各次自述声明的并集），供指纹基线对比使用
  const familyUnion = new Set<string>();
  for (const sample of samples) {
    for (const family of familiesIn(sample.result.text)) familyUnion.add(family);
  }
  metrics['families'] = familyUnion.size > 0 ? [...familyUnion].sort().join(',') : 'none';

  if (samples.length === 0) {
    return {
      id: 'identity',
      status: 'insufficient',
      score: null,
      level: 'unknown',
      headline:
        starvedSelfId > 0
          ? '身份探针无有效样本（自述因推理占满预算或请求失败未产出答案），无法核验'
          : '身份探针无有效样本（自述请求全部失败），无法核验',
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
    // 全部空响应：没有证据指控端点（可能是限流/截断/内容过滤），按证据不足处理，不碰 score/level
    findings.push({
      level: 'info',
      message: `共采样 ${samples.length} 次自述 + 1 次格式合规探针，全部返回空响应，无法完成身份核验（不作为异常指控）。`,
      evidenceIds: [],
    });
    return {
      id: 'identity',
      status: 'insufficient',
      score: null,
      level: 'unknown',
      headline: '身份探针无有效回答（全部空响应），无法核验',
      findings,
      metrics,
    };
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
  if (!schemaStarved && schemaResult.ok && !schemaKeysOk) {
    findings.push({ level: 'warn', message: '严格 JSON 输出探针未按结构返回（弱指纹：网关可能重写响应）。', evidenceIds: [schemaEvidence.id] });
    score = Math.min(score, 90);
  }

  const starvedNote = starvedSelfId > 0 ? `（另有 ${starvedSelfId} 次自述因推理占满预算按无效样本处理）` : '';
  findings.push({ level: 'info', message: `共采样 ${samples.length} 次自述 + 1 次格式合规探针。${starvedNote}`, evidenceIds: [] });
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
