import type { ChatMessage, ProbeCtx, ProbeOutcome, ChatResult, Finding } from '../types.js';
import { IDENTITY_QUESTIONS, SCHEMA_PROBES } from '../assets.js';
import { PROBE_BUDGETS, chatWithBlankFallback, isBlankAnswer, isStarved } from './starve.js';

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

/**
 * 比对用的规范化形式：分隔符等价（. _ - 视为同一字符）。
 * 实测来源：[中转站] 同一模型会混用点号与连字符回显（glm-5.3-flash / glm-5-3-flash），
 * 不归一会把「网关规范化」误判成换壳（2026-10-17 官方 1M 上下文复核实证）。
 */
function normalizeModelName(model: string): string {
  return stripVendorPrefix(model).replace(/[._]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/**
 * 上游别名后缀（滚动别名而非更轻的变体）：请求 gpt-4o 回显 gpt-4o-latest 属官方别名，
 * 不应按换壳告警。只认「剩余段恰好是这些词」——glm-5.3-flash / gpt-4o-mini / 1-flash-preview
 * 这类真降级名不会命中（剩余段含更多内容），仍按可疑计。
 */
const BENIGN_ALIAS_SUFFIXES = new Set(['latest', 'preview', 'beta', 'exp', 'experimental']);

/**
 * 统计上游回显 model 字段与请求模型的一致性（分母只计非空回显：端点不回 model 属无证据，不稀释真实换壳信号）。
 * 判定口径（保守，宁可少判也不诬告）：
 * - 回显为空/缺失：不计入（无证据），且不进分母（否则端点偶尔不回 model 会稀释真实换壳信号）；
 * - 分隔符等价（glm-5.3-flash ≡ glm-5-3-flash，网关混用点号/连字符）：视为一致；
 * - 完全相等（去厂商前缀、大小写不敏感）：一致；
 * - 回显是请求名的前缀（上游规范化掉日期/变体后缀，如 gpt-4o-2024-08-06 → gpt-4o）：视为一致；
 * - 回显 = 请求名 + 纯数字后缀（日期钉版）或官方滚动别名后缀（latest/preview/beta/exp）：视为一致；
 * - 其余（回显是请求的「更窄变体」如 glm-5.3-flash、gpt-4o-mini，或完全另一个模型）：计入 suspicious。
 */
function countEchoMismatch(
  models: Array<string | null>,
  target: string,
): { total: number; match: number; suspicious: number; values: Set<string> } {
  const values = new Set<string>();
  let total = 0;
  let match = 0;
  let suspicious = 0;
  const wanted = normalizeModelName(target);
  for (const raw of models) {
    if (raw === null || raw.trim() === '') continue;
    total += 1;
    const echoed = raw.trim();
    values.add(echoed);
    const got = normalizeModelName(echoed);
    if (got === wanted) {
      match += 1;
      continue;
    }
    if (wanted.startsWith(`${got}-`)) {
      match += 1;
      continue;
    }
    const narrowed = got.startsWith(`${wanted}-`) ? got.slice(wanted.length + 1) : '';
    if (narrowed !== '' && (/^\d[\d.-]*$/.test(narrowed) || BENIGN_ALIAS_SUFFIXES.has(narrowed))) {
      match += 1;
      continue;
    }
    suspicious += 1;
  }
  return { total, match, suspicious, values };
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

// —— 人格注入检测（F2，v0.2.2 起）——
// 场景：端点注入 system prompt（「你是 NovaRelay 助手」）或改写响应，让模型以「品牌名 + assistant/
// 助手」形态自述非模型族人格。候选品牌词由静态正则捕获，绝不由候选构造正则（错别候选不进 RegExp，
// 无元字符注入面；候选字符集被正则限定为 [\w.-]，比较时只做归一化字符串与静态表成员判定）。
const PERSONA_PATTERNS: readonly RegExp[] = [
  // EN1（句首锚定）：I am / I'm / this is / you are talking to X (AI) assistant
  /(?:^|[.!?。！？\n])\s*(?:i am|i'm|this is|you are talking to)\s+(?:an?\s+|the\s+)?([a-z][\w.-]{2,}(?:\s[a-z][\w.-]{2,})?)(?:'s|s')?\s+(?:ai\s+)?assistant\b/gi,
  // EN2（任意位置）：assistant called/named X
  /\bassistant\s+(?:called|named)\s+([\w][\w.-]{1,}(?:\s[\w][\w.-]{1,})?)/gi,
  // EN3（句首锚定同位语）：I am X, an AI/helpful/virtual/digital assistant
  /(?:^|[.!?。！？\n])\s*(?:i am|i'm)\s+(?:an?\s+|the\s+)?([a-z][\w.-]{2,}(?:\s[a-z][\w.-]{2,})?)\s*,\s*(?:an?\s+|the\s+)?(?:ai\s+|helpful\s+|virtual\s+|digital\s+)?assistant\b/gi,
  // ZH（句首锚定）：我是/我叫/作为 X 助手|助理
  /(?:^|[.!?。！？\n])\s*(?:我是|我叫|作为)\s*([A-Za-z][\w.-]{2,}(?:\s[A-Za-z][\w.-]{2,})?)\s*(?:的)?\s*(?:助手|助理)/gi,
];

// 停用词表（小写）：通用描写词/冠词/代词/自指词。真实品牌名一律不入表。
const PERSONA_STOPWORDS = new Set([
  'ai', 'an', 'a', 'the', 'your', 'my', 'our', 'their', 'his', 'her', 'its', 'this', 'that',
  'helpful', 'virtual', 'digital', 'smart', 'personal', 'advanced', 'general', 'capable', 'intelligent',
  'friendly', 'professional', 'official', 'useful', 'powerful', 'best', 'great', 'good', 'new', 'super',
  'ultra', 'large', 'largest', 'tiny', 'little', 'modern', 'sophisticated', 'language', 'chat', 'llm',
  'model', 'assistant', 'chatbot', 'companion', 'buddy', 'friend', 'expert', 'skilled', 'knowledgeable',
  'creative', 'curious', 'enthusiastic', 'passionate', 'chief', 'lead', 'senior', 'first', 'only', 'world',
  'world-class', 'cutting-edge', 'state-of-the-art', 'ai-powered', 'aipowered', 'highly', 'very', 'truly', 'most',
]);

/**
 * 从一句自述中提取「非模型族人格品牌」候选（纯函数，供单测与探针共用）。
 * 过滤：归一化长度 < 3、整体或其全部分词命中停用词表、与任一已知模型族别名相交（族名自述属正常）。
 * 返回按归一化去重的原始展示形态列表（保留首次出现形态）；无命中返回 []。
 */
export function detectPersonaBrands(text: string): string[] {
  const hits = new Map<string, string>();
  for (const pattern of PERSONA_PATTERNS) {
    // matchAll 会克隆正则并从克隆体迭代，不依赖/不改动原正则 lastIndex（g 正则可安全复用）。
    for (const match of text.matchAll(pattern)) {
      const raw = match[1];
      if (raw === undefined) continue;
      // 最小偏离（规格语义优先）：候选字符集含点号（支持 Nova.Relay），EN2 句末形态会把句读点
      // 一并捕获（"called NovaRelay." → "NovaRelay."），剥掉尾点后再做归一化/展示。
      const candidate = raw.trim().replace(/\.+$/, '');
      const normalized = normalize(candidate);
      if (normalized.length < 3) continue;
      if (PERSONA_STOPWORDS.has(normalized)) continue;
      const tokens = normalized.split(' ').filter((t) => t.length > 0);
      if (tokens.length > 0 && tokens.every((t) => PERSONA_STOPWORDS.has(t))) continue;
      if (familiesIn(candidate).size > 0) continue;
      if (!hits.has(normalized)) hits.set(normalized, candidate);
    }
  }
  return [...hits.values()];
}

export async function probeIdentity(ctx: ProbeCtx): Promise<ProbeOutcome> {
  const findings: Finding[] = [];
  const metrics: Record<string, number | string | null> = {};
  const samples: IdentitySample[] = [];
  // 回显 model 字段按「全部请求」统计：starved/失败样本的文本不可用，但回显字段仍是机器证据。
  const echoModels: Array<string | null> = [];
  const echoEvidenceIds: string[] = [];
  // 自述样本数：普通档 5、deep 档 8。构成 = 随机题（n-1）+ 固定追加 1 题精确版本自述。
  const sampleTarget = ctx.cfg.deep ? 8 : 5;
  const questions = [...ctx.rng.shuffle(IDENTITY_QUESTIONS).slice(0, sampleTarget - 1), EXACT_VERSION_QUESTION];
  let starvedSelfId = 0;
  let blankRetried = 0;
  let streamFallbacks = 0;
  const fallbackEvidenceIds: string[] = [];

  for (const question of questions) {
    const call = await chatWithBlankFallback(ctx, {
      probe: 'identity',
      label: `self-id: ${question.slice(0, 24)}`,
      request: {
        model: ctx.cfg.model,
        messages: [{ role: 'user', content: question } satisfies ChatMessage],
        temperature: 0.7,
        max_tokens: PROBE_BUDGETS.identity,
      },
      streamBudget: PROBE_BUDGETS.identity,
    });
    const { result } = call;
    if (call.blankRetried) blankRetried += 1;
    if (call.streamFallback) {
      streamFallbacks += 1;
      fallbackEvidenceIds.push(...call.evidenceIds);
    }
    echoModels.push(result.model);
    if (result.model !== null && result.model.trim() !== '') echoEvidenceIds.push(call.evidenceId);
    if (!result.ok) {
      findings.push({
        level: 'warn',
        message: `身份问答请求失败：${result.error ?? 'unknown'}`,
        evidenceIds: call.evidenceIds,
      });
      continue;
    }
    if (isStarved(result)) {
      starvedSelfId += 1;
      findings.push({
        level: 'info',
        message: `自述样本「${question.slice(0, 24)}…」因推理占满预算未产出答案，视为无效样本（不计入指纹统计）。`,
        evidenceIds: call.evidenceIds,
      });
      continue;
    }
    if (isBlankAnswer(result)) {
      findings.push({
        level: 'info',
        message: call.blankRetried
          ? `自述样本「${question.slice(0, 24)}…」非流式返回空响应，已自动改用流式回退仍为空：视为无效样本（空响应 ≠ 答错）。`
          : `自述样本「${question.slice(0, 24)}…」返回空响应（HTTP 200，无 content）：视为无效样本（空响应 ≠ 答错）。`,
        evidenceIds: call.evidenceIds,
      });
    }
    samples.push({ question, result, evidenceId: call.evidenceId });
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
  const schemaCall = await chatWithBlankFallback(ctx, {
    probe: 'identity',
    label: 'json-schema compliance',
    request: {
      model: ctx.cfg.model,
      messages: [{ role: 'user', content: schemaProbe.prompt } satisfies ChatMessage],
      temperature: 0,
      max_tokens: PROBE_BUDGETS.identity,
    },
    streamBudget: PROBE_BUDGETS.identity,
  });
  const schemaResult = schemaCall.result;
  if (schemaCall.blankRetried) blankRetried += 1;
  if (schemaCall.streamFallback) {
    streamFallbacks += 1;
    fallbackEvidenceIds.push(...schemaCall.evidenceIds);
  }
  if (schemaResult.model !== null && schemaResult.model.trim() !== '') echoEvidenceIds.push(schemaCall.evidenceId);
  const schemaStarved = isStarved(schemaResult);
  // 200 空文本同样是「未获得答案」：不能把空响应当成「未按结构返回」而扣分/告警，
  // 与 starved 同口径记 N/A（空响应 ≠ 格式不合规）。
  const schemaBlank = isBlankAnswer(schemaResult);
  const schemaParsed = schemaStarved || schemaBlank ? null : parseJsonLoose(schemaResult.text);
  const schemaKeysOk = schemaParsed !== null && schemaProbe.keys.every((key) => key in schemaParsed);
  const schemaValuesOk = schemaKeysOk && schemaProbe.keys.every((key) => schemaParsed !== null && schemaParsed[key] !== undefined);

  metrics['samples'] = samples.length;
  metrics['identical_samples'] = identicalPairs;
  metrics['schema_compliant'] = !schemaResult.ok || schemaStarved || schemaBlank ? 'N/A' : (schemaKeysOk && schemaValuesOk ? 1 : 0);
  if (starvedSelfId > 0) metrics['starved_samples'] = starvedSelfId;
  if (blankRetried > 0) metrics['blank_retried'] = blankRetried;
  if (streamFallbacks > 0) metrics['stream_fallbacks'] = streamFallbacks;
  if (streamFallbacks > 0) {
    findings.push({
      level: 'info',
      message: `身份探针有 ${streamFallbacks} 次非流式空响应，已自动改用流式回退并取得答案（空响应 ≠ 答错）。`,
      evidenceIds: fallbackEvidenceIds,
    });
  }
  if (schemaStarved) {
    findings.push({
      level: 'info',
      message: '格式合规探针因推理占满预算未产出完整 JSON（预算不足无法判定格式合规），不扣分、不作异常指控。',
      evidenceIds: schemaCall.evidenceIds,
    });
  } else if (schemaBlank) {
    findings.push({
      level: 'info',
      message: schemaCall.blankRetried
        ? '格式合规探针返回空文本（HTTP 200，无 content），已自动改用流式回退仍为空：未获得答案，无法判定格式合规，不扣分、不作异常指控。'
        : '格式合规探针返回空文本（HTTP 200，无 content）：未获得答案，无法判定格式合规，不扣分、不作异常指控。',
      evidenceIds: schemaCall.evidenceIds,
    });
  }

  // 上游回显 model 是独立于自述文本的机器证据：即使自述全部空响应/请求失败，
  // 也必须统计并在结论中披露，不能因「无有效样本」提前返回而丢掉换壳线索。
  const echoStats = countEchoMismatch([...echoModels, schemaResult.model], ctx.cfg.model);
  metrics['model_echo'] = `${echoStats.match}/${echoStats.total}`;
  metrics['model_echo_values'] = [...echoStats.values].join('/') || 'none';
  const echoMajor = echoStats.suspicious >= Math.max(1, Math.ceil(echoStats.total / 2));
  const echoFinding: Finding | null = echoStats.suspicious > 0
    ? {
        level: 'warn',
        message: `请求模型 ${ctx.cfg.model}，上游回显 ${[...echoStats.values].join('/')}：回显字段与请求不一致（换壳/降级冒充的直接线索；单独不定罪，需与其余探针合看）。`,
        evidenceIds: echoEvidenceIds,
      }
    : null;

  const refusalCount = texts.filter((t) => REFUSAL_PATTERNS.some((p) => p.test(t))).length;
  metrics['refusals'] = refusalCount;

  // 模型族指纹集合（各次自述声明的并集），供指纹基线对比使用
  const familyUnion = new Set<string>();
  for (const sample of samples) {
    for (const family of familiesIn(sample.result.text)) familyUnion.add(family);
  }
  metrics['families'] = familyUnion.size > 0 ? [...familyUnion].sort().join(',') : 'none';

  // 族失配统计上移至此（原在降级分支前）：人格扫描与分支 a 的族判据共用同一份统计。
  const familyStats = countFamilyMismatch(samples, [ctx.cfg.model]);

  // 人格注入扫描（F2）：仅当目标族可识别（有「非模型族」基线）时扫全部有效样本。
  const personaHits = new Map<string, { display: string; count: number; evidenceIds: string[] }>();
  if (familyStats.expectedAliases.size > 0) {
    for (const sample of samples) {
      for (const brand of detectPersonaBrands(sample.result.text)) {
        const key = normalize(brand);
        const hit = personaHits.get(key);
        if (hit !== undefined) {
          hit.count += 1;
          hit.evidenceIds.push(sample.evidenceId);
        } else {
          personaHits.set(key, { display: brand, count: 1, evidenceIds: [sample.evidenceId] });
        }
      }
    }
  }
  metrics['persona_hits'] =
    personaHits.size > 0 ? [...personaHits.values()].map((v) => `${v.display}×${v.count}`).join('/') : 'none';

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
    if (echoFinding !== null) {
      findings.push(echoFinding);
      // 无有效自述 ⇒ 不给分（status insufficient），但回显不一致必须升到 warn，
      // 让总分保持诚实（不计入 90/60），同时不被 unknown 掩盖。
      return {
        id: 'identity',
        status: 'insufficient',
        score: null,
        level: 'warn',
        headline: `自述请求均未产出有效答案；上游回显模型与请求不一致（${echoStats.suspicious}/${echoStats.total}）：疑似换壳/换通道`,
        findings,
        metrics,
      };
    }
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

  // 与族判定无关的软信号（refusal / 逐字一致 / 格式合规 / 人格注入）：诚实降级分支里也应披露，
  // 不因降级而丢失；文案与下方主流程对应分支保持一致（主流程版本额外压分，降级分支无分可压）。
  const personaMessage = (): string => {
    const list = [...personaHits.values()].map((v) => v.display).join('、');
    const total = [...personaHits.values()].reduce((n, v) => n + v.count, 0);
    return `自述出现非模型族人格名：${list}（合计 ${total} 处命中，目标族为 ${ctx.cfg.model}）：疑似上游注入 system prompt 或响应被改写（弱证据，单独不定罪）。`;
  };
  const attachSoftWarns = (): void => {
    // 回显字段是独立于自述文本的机器证据：诚实降级（无法核验自述身份）不等于忽略换壳线索，
    // 否则「自述未声明族 + 回显他族」会被 unknown 掩盖（历史漏报）。
    if (echoFinding !== null) {
      findings.push(echoFinding);
    }
    if (refusalCount >= 3) {
      findings.push({ level: 'warn', message: '自述问题全部被回避，行为指纹结论置信度低。', evidenceIds: [] });
    }
    // 分母只计非空自述：空响应不构成模板证据，但也不能稀释「其余有效样本全部逐字一致」的信号。
    if (identicalPairs >= nonEmpty.length - 1 && nonEmpty.length >= 3) {
      findings.push({ level: 'warn', message: '多次采样回答逐字一致，疑似模板特判或缓存。', evidenceIds: [] });
    }
    if (!schemaStarved && !schemaBlank && schemaResult.ok && !schemaKeysOk) {
      findings.push({
        level: 'warn',
        message: '严格 JSON 输出探针未按结构返回（弱指纹：网关可能重写响应）。',
        evidenceIds: schemaCall.evidenceIds,
      });
    }
    if (personaHits.size > 0) {
      findings.push({
        level: 'warn',
        message: personaMessage(),
        evidenceIds: [...personaHits.values()].flatMap((v) => v.evidenceIds),
      });
    }
  };

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
    const echoNote =
      echoFinding !== null ? `；上游回显模型与请求不一致（${echoStats.suspicious}/${echoStats.total}）：疑似换壳/换通道` : '';
    return {
      id: 'identity',
      status: 'insufficient',
      score: null,
      level: echoFinding !== null ? 'warn' : 'unknown',
      headline: `目标模型族不在已知别名表内，无法据自述核验身份${echoNote}`,
      findings,
      metrics,
    };
  }
  // a2) 最少有效证据门槛（2026-10-18 真机实证）：仅 1 条非空自述（其余为空流/失败）时，
  //     无论它声明了什么族，都不足以构成身份结论——单条自述既不能证伪也不能核实，不出分。
  //     回显不一致仍需披露（attachSoftWarns 统一处理），避免「1 条自述 + 回显异常」被当成 PASS 或 90 分。
  if (answerable === 1) {
    findings.push({
      level: 'info',
      message: `有效自述样本仅 ${answerable} 条（其余为空响应/请求失败/推理占满预算），不足以核验身份，结论不出分。`,
      evidenceIds: [],
    });
    attachSoftWarns();
    const echoNote =
      echoFinding !== null ? `；上游回显模型与请求不一致（${echoStats.suspicious}/${echoStats.total}）：疑似换壳/换通道` : '';
    return {
      id: 'identity',
      status: 'insufficient',
      score: null,
      level: echoFinding !== null ? 'warn' : 'unknown',
      headline: `有效自述样本不足（${answerable} 条），无法核验身份${echoNote}`,
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
    const echoNote =
      echoFinding !== null ? `；上游回显模型与请求不一致（${echoStats.suspicious}/${echoStats.total}）：疑似换壳/换通道` : '';
    return {
      id: 'identity',
      status: 'insufficient',
      score: null,
      level: echoFinding !== null ? 'warn' : 'unknown',
      headline: `自述未声明可识别模型族，无法核验身份${echoNote}`,
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
  // ⑤ 上游回显 model 字段与请求模型不一致（换壳/换通道的机器证据，与 guard model_mismatch 同口径）。
  //    自述可被「教」，回显字段不会：请求 glm-5.3 却回显 glm-5.3-flash = 轻量版冒充旗舰的典型签名。
  //    但回显也可能被网关规范化（丢厂商前缀、丢日期后缀），故只压分到 warn，绝不单判定罪。
  if (echoFinding !== null) {
    score = Math.min(score, echoMajor ? 60 : 80);
    level = 'warn';
    headline = `上游回显模型与请求不一致（${echoStats.suspicious}/${echoStats.total}）：疑似换壳/换通道`;
    findings.push(echoFinding);
  }
  // ⑥ 人格注入（F2）：自述出现「非模型族品牌名 + assistant/助手」人格形态——端点注入 system prompt
  //    或改写响应的弱证据（模型可能照抄引导句）。独立块（非 else-if）：压分到 80 且降 pass→warn，
  //    绝不单独定罪（falsified 时 Math.min(0, 80) 仍为 fail，不影响定罪）。
  if (personaHits.size > 0) {
    findings.push({
      level: 'warn',
      message: personaMessage(),
      evidenceIds: [...personaHits.values()].flatMap((v) => v.evidenceIds),
    });
    score = Math.min(score, 80);
    if (level === 'pass') level = 'warn';
  }

  if (answerable === 0 && samples.length > 0) {
    // 全部空响应：文本层面没有可核验的自述（可能是限流/截断/内容过滤），但上游回显 model
    // 仍是独立机器证据——若回显与请求不一致，必须按 warn 报出，不能以「证据不足」掩盖换壳线索。
    const allZeroCompletion = samples.every((s) => (s.result.usage?.completion_tokens ?? 0) === 0);
    findings.push({
      level: 'info',
      message: `共采样 ${samples.length} 次自述 + 1 次格式合规探针，全部返回空文本（HTTP 200${allZeroCompletion ? ' 且 completion_tokens=0' : ''}），无法完成身份核验（这是上游端点未产出内容，不是检测程序错误）。`,
      evidenceIds: [],
    });
    if (echoFinding !== null) {
      return {
        id: 'identity',
        status: 'insufficient',
        score: null,
        level: 'warn',
        headline: `自述全部空响应；上游回显模型与请求不一致（${echoStats.suspicious}/${echoStats.total}）：疑似换壳/换通道`,
        findings,
        metrics,
      };
    }
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
  // 全体逐字一致（相邻对 = 有效样本数-1 时即所有非空自述完全相同）才疑似模板特判：
  // 分母只用非空文本（空响应没有指纹含义），避免空样本稀释后漏检模板/缓存端点。
  if (identicalPairs >= nonEmpty.length - 1 && nonEmpty.length >= 3) {
    findings.push({ level: 'warn', message: '多次采样回答逐字一致，疑似模板特判或缓存。', evidenceIds: [] });
    score = Math.min(score, 70);
    if (level === 'pass') level = 'warn';
  }
  if (!schemaStarved && !schemaBlank && schemaResult.ok && !schemaKeysOk) {
    findings.push({ level: 'warn', message: '严格 JSON 输出探针未按结构返回（弱指纹：网关可能重写响应）。', evidenceIds: schemaCall.evidenceIds });
    score = Math.min(score, 90);
  }

  const starvedNote = starvedSelfId > 0 ? `（另有 ${starvedSelfId} 次自述因推理占满预算按无效样本处理）` : '';
  findings.push({ level: 'info', message: `共采样 ${samples.length} 次自述 + 1 次格式合规探针。${starvedNote}`, evidenceIds: [] });
  // headline 诚实性：任何把 level 降为 warn 却不自带 headline 的分支（版本旁证/回显少数不一致/
  // 回避/逐字一致/格式不合规）都必须在这里统一改写，否则报告会并列出现
  // 「身份探针未见异常」与 warn finding——既自相矛盾，也会误导人工复核。
  if (level === 'warn' && headline === '身份探针未见异常') {
    const warnCount = findings.filter((f) => f.level === 'warn').length;
    headline = `身份探针存在 ${warnCount} 项可疑信号（未达定罪线，见明细）`;
  }
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
