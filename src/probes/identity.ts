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
  // 以下为扩容族（模式保守，只认 distinctive 串，避免把通用词误收进指纹）：
  ['minimax', /minimax|abab|海螺/i],
  ['hunyuan', /hunyuan|混元/i],
  ['step', /step[-\s]?\d|阶跃/i],
  ['spark', /spark[-\s]?\d|星火|讯飞|iflytek/i],
  ['yi', /\byi[-\s]?(large|lightning)|零一万物|01\.ai/i],
  ['baichuan', /baichuan|百川/i],
  ['internlm', /internlm|书生/i],
  ['phi', /\bphi[-\s]?\d/i],
  ['cohere', /\bcommand[-\s]?r\b|cohere/i],
];

/** 固定追加的精确版本自述题：每次审计必问 1 道，用于提取 claimed_version 旁证。 */
const EXACT_VERSION_QUESTION = '你的完整模型名称与精确版本号是什么？只回答名称与版本号。';

// 自述中的具体版本号串（claimed_version 展示用）：family+数字（GLM-4、glm-5.3、gpt-4 前缀形态）
// 或独立 X.Y(.Z)（4.5、5.3.1）。纯字母尾版本（如 gpt-4o 的 "o"）不匹配，属可接受的保守提取。
const CLAIMED_VERSION_RE = /\b(?:[a-z][\w-]*-)?\d+\.\d+(?:\.\d+)?\b|\b[a-z][\w-]*-\d+\b/i;
// X.Y(.Z) 形式的可比版本号（目标模型名与自述文本的交集比较用），lowercase 后比较。
const COMPARABLE_VERSION_RE = /\d+\.\d+(?:\.\d+)?/g;

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

/** 从目标模型名集合提取期望模型族别名（detectFalsified 与版本旁证共用）。 */
function expectedFamiliesFor(targets: readonly string[]): Set<string> {
  const expectedAliases = new Set<string>();
  for (const target of targets) {
    for (const [name, pattern] of MODEL_ALIAS) {
      if (pattern.test(target)) expectedAliases.add(name);
    }
  }
  return expectedAliases;
}

/**
 * 族失配统计（falsified 与多数不一致告警共用同一计数口径）：
 * 统计「声明了模型族且与期望族无交集」的样本数。未声明族（declared 为空）的样本
 * 不计入 mismatch；期望族为空（目标模型名不在别名表内）时 mismatch 恒为 0。
 */
function countFamilyMismatch(
  samples: readonly IdentitySample[],
  expect: readonly string[],
): { mismatch: number; expectedAliases: Set<string> } {
  const expectedAliases = expectedFamiliesFor(expect);
  if (expectedAliases.size === 0) return { mismatch: 0, expectedAliases };
  let mismatch = 0;
  for (const sample of samples) {
    const declared = familiesIn(sample.result.text);
    if (declared.size === 0) continue;
    const consistentWithExpect = [...declared].some((d) => expectedAliases.has(d));
    if (!consistentWithExpect) mismatch += 1;
  }
  return { mismatch, expectedAliases };
}

/**
 * falsified 判定（全体一致语义）：所有有效样本都声明了模型族、且无一与期望族相交，
 * 才判伪造。样本 5/8 个时与旧口径（3 样本 3 mismatch）同等严格度——个别样本空响应/
 * 失败天然缩样本，未声明族（declared 为空）的样本不计入 mismatch。
 */
function detectFalsified(stats: { mismatch: number; expectedAliases: Set<string> }, sampleCount: number): boolean {
  if (stats.expectedAliases.size === 0) return false;
  if (sampleCount < 3) return false;
  return stats.mismatch === sampleCount;
}

/** 去中转站厂商前缀（z-ai/、openai/、zhipu/ 等，可叠多层），只留模型本体，供版本号提取。 */
function stripVendorPrefix(model: string): string {
  return model.toLowerCase().replace(/^(?:[a-z0-9][\w.-]*\/)+/, '');
}

/** 提取文本中首个具体版本号串（展示用）；提取不到返回 null。 */
function extractClaimedVersion(text: string): string | null {
  const m = text.match(CLAIMED_VERSION_RE);
  return m ? m[0] : null;
}

/** 提取文本中全部 X.Y(.Z) 版本号（lowercase 集合，交集比较用）。 */
function extractComparableVersions(text: string): Set<string> {
  return new Set((text.match(COMPARABLE_VERSION_RE) ?? []).map((v) => v.toLowerCase()));
}

export async function probeIdentity(ctx: ProbeCtx): Promise<ProbeOutcome> {
  const findings: Finding[] = [];
  const metrics: Record<string, number | string | null> = {};
  const samples: IdentitySample[] = [];
  // 自述样本数：普通档 5、deep 档 8。构成 = 随机题（n-1）+ 固定追加 1 题精确版本自述。
  const sampleTarget = ctx.cfg.deep ? 8 : 5;
  const questions = [...ctx.rng.shuffle(IDENTITY_QUESTIONS).slice(0, sampleTarget - 1), EXACT_VERSION_QUESTION];
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

  // claimed_version：首个含具体版本号的自述串（如 GLM-4、glm-5.3、4.5）；提取不到记 'none'
  let claimedVersion: string | null = null;
  const claimedVersions = new Set<string>();
  for (const sample of samples) {
    if (claimedVersion === null) {
      claimedVersion = extractClaimedVersion(sample.result.text);
    }
    for (const v of extractComparableVersions(sample.result.text)) claimedVersions.add(v);
  }
  metrics['claimed_version'] = claimedVersion ?? 'none';

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

  // 与族判定无关的软信号（refusal / 逐字一致 / 格式合规）：诚实降级分支里也应披露，
  // 不因降级而丢失；文案与下方主流程对应分支保持一致（主流程版本额外压分，降级分支无分可压）。
  const attachSoftWarns = (): void => {
    if (refusalCount >= 3) {
      findings.push({ level: 'warn', message: '自述问题全部被回避，行为指纹结论置信度低。', evidenceIds: [] });
    }
    if (identicalPairs >= samples.length - 1 && samples.length >= 3) {
      findings.push({ level: 'warn', message: '多次采样回答逐字一致，疑似模板特判或缓存。', evidenceIds: [] });
    }
    if (!schemaStarved && schemaResult.ok && !schemaKeysOk) {
      findings.push({
        level: 'warn',
        message: '严格 JSON 输出探针未按结构返回（弱指纹：网关可能重写响应）。',
        evidenceIds: [schemaEvidence.id],
      });
    }
  };

  const familyStats = countFamilyMismatch(samples, [ctx.cfg.model]);

  // —— 诚实降级分支（真实事故：中转站全程自述他族，旧逻辑却输出 PASS「身份探针未见异常」）——
  // a) 目标族未知：别名表认不出目标模型族 → 无法据自述核验身份，诚实降级，不出 PASS。
  if (familyStats.expectedAliases.size === 0) {
    const declaredNote =
      familyUnion.size > 0
        ? `自述声明族：${[...familyUnion].sort().join(', ')}。`
        : '自述未声明任何可识别模型族。';
    findings.push({
      level: 'info',
      message: `目标模型族（${ctx.cfg.model}）不在已知别名表内，无法据自述核验身份。${declaredNote}`,
      evidenceIds: [],
    });
    attachSoftWarns();
    return {
      id: 'identity',
      status: 'insufficient',
      score: null,
      level: 'unknown',
      headline: '目标模型族不在已知别名表内，无法据自述核验身份',
      findings,
      metrics,
    };
  }
  // b) 无族证据：有有效样本但均未声明可识别模型族 → 无法核验，诚实降级，不出 PASS。
  //    （全部空响应走下方专用分支——其证据更弱、措辞更准确，故此处要求 answerable > 0。）
  if (familyUnion.size === 0 && answerable > 0) {
    findings.push({
      level: 'info',
      message: '自述未声明可识别模型族，无法核验身份（不作为异常指控）。',
      evidenceIds: [],
    });
    attachSoftWarns();
    return {
      id: 'identity',
      status: 'insufficient',
      score: null,
      level: 'unknown',
      headline: '自述未声明可识别模型族，无法核验身份',
      findings,
      metrics,
    };
  }

  const falsified = detectFalsified(familyStats, samples.length);

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
  } else if (samples.length >= 3 && familyStats.mismatch >= Math.ceil(samples.length / 2) && familyStats.mismatch >= 2) {
    // c) 多数不一致告警：未达全体一致定罪线，但多数自述指向其他模型族——疑似换壳，
    //    压制可信度分并降为可疑，不再输出「未见异常」的假清白。
    score = Math.min(score, 60);
    level = 'warn';
    headline = `多数自述（${familyStats.mismatch}/${samples.length}）指向其他模型族，疑似换壳（未达全体一致定罪线）`;
    findings.push({
      level: 'warn',
      message: `多数自述（${familyStats.mismatch}/${samples.length}）指向其他模型族，疑似换壳（未达全体一致定罪线）。`,
      evidenceIds: samples.map((s) => s.evidenceId),
    });
  } else if (claimedVersions.size > 0) {
    // 版本矛盾旁证（仅 warn，不定罪）：前提是自述族与期望族有交集（falsified 不成立）。
    // 双侧均有具体版本号且无交集才判；任一侧无版本（如 gpt-4o 无 X.Y 段）不判，metric 照记。
    const targetVersions = extractComparableVersions(stripVendorPrefix(ctx.cfg.model));
    const declaredOverlap = [...familyUnion].some((f) => expectedFamiliesFor([ctx.cfg.model]).has(f));
    if (declaredOverlap && targetVersions.size > 0 && ![...claimedVersions].some((v) => targetVersions.has(v))) {
      findings.push({
        level: 'warn',
        message: `自述版本（${[...claimedVersions].sort().join('/')}）与目标模型（${ctx.cfg.model}）不符。模型自述版本天然不可靠，仅作旁证，不构成换壳定罪。`,
        evidenceIds: samples.map((s) => s.evidenceId),
      });
      score = Math.min(score, 90);
      if (level === 'pass') level = 'warn';
    }
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
  // 全体逐字一致（相邻对 = 样本数-1 时即所有有效样本完全相同）才疑似模板特判：
  // 旧口径为 3 样本 3 连同（pairs>=2），5/8 样本下按同强度换算，避免多样本随机重复误伤。
  if (identicalPairs >= samples.length - 1 && samples.length >= 3) {
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
