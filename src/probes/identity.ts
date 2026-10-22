import type { ChatMessage, ProbeCtx, ProbeOutcome, ChatResult, Finding } from '../types.js';
import { failureDigest } from '../diagnostics.js';
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
const FAMILY_INT_VERSION_RE = /\b[a-z][\w-]*-(\d+)\b/gi;

interface IdentitySample {
  question: string;
  result: ChatResult;
  evidenceId: string;
}

/**
 * 否定语境检测（2026-10-18 审计缺陷 ④）：模型常用「I am Claude, not OpenAI.」这类否定句
 * 排除他人家族；若不识别否定，单句会同时声明被否定族（红队实证：5 条
 * 「I am Claude, not OpenAI.」样本声明 {claude, gpt}，与期望族 gpt 有交集 → 换壳检测失效）。
 * 判定只面向别名匹配所在的分句，保守实现：任一侧能读出针对该匹配的否定即视为否定。
 */
function isNegated(text: string, index: number, length: number): boolean {
  const before = text.slice(0, index);
  const after = text.slice(index + length, index + length + 40);
  // 分句切片：句读号/换行/转折词之后才是作用于本匹配的分句
  const seg = before.split(/[，,。;；!?！？\n]|\b(?:but|however)\b|但(?:是)?/).pop() ?? '';
  // 「not only/not just/isn't just」「不只/不仅」是强调而非否认（"I am not only OpenAI" 仍与
  // openai 关联），若当否定处理会把真实族归属漏判，削弱换壳检测——先于否定分支排除。
  const notOnly = /\b(?:not|n['’]t)\s+(?:only|just|merely)\b[^,;.!?\n]{0,24}$/i.test(seg) || /(?:不只|不仅)/.test(seg);
  // 前缀否定：分句尾部的 not/never 或缩写式 n't（如 "I am not "）、"不是/并非/不叫…"）
  if (!notOnly && /\b(?:not|never)\b[^,;.!?\n]{0,24}$/i.test(seg)) return true;
  if (!notOnly && /[a-z]['’]t\b[^,;.!?\n]{0,24}$/i.test(seg)) return true;
  if (!notOnly && /(?:不是|并非|不叫|否认)[^，,。;；!?！？\n]{0,12}$/.test(seg)) return true;
  if (!notOnly && /非\s*$/.test(seg)) return true;
  // 后缀否定：「X is not me / OpenAI is not this model / 不是本模型」等形式
  if (/\b(?:is|are|was|were)(?:\s+not|\s*n['’]t|n['’]t)\s+(?:me|this\s+(?:ai\s+)?model|my\s+(?:ai\s+)?model)\b/i.test(after)) return true;
  if (/(?:不是|并非)(?:我|本模型|我的模型)/.test(after)) return true;
  return false;
}

/**
 * 从自述文本提取已声明的模型族集合。逐匹配做否定过滤：被否定语境的别名不构成声明
 * （如 "I am Claude, not OpenAI." 只声明 claude）。对每个别名用 matchAll 遍历全部出现位置，
 * 存在任一未否定匹配即声明该族。
 */
export function familiesIn(text: string): Set<string> {
  const declared = new Set<string>();
  for (const [name, pattern] of MODEL_ALIAS) {
    const global = pattern.flags.includes('g') ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
    let hit = false;
    for (const match of text.matchAll(global)) {
      const index = match.index ?? -1;
      if (index < 0) continue;
      if (!isNegated(text, index, match[0].length)) {
        hit = true;
        break;
      }
    }
    if (hit) declared.add(name);
  }
  return declared;
}

/**
 * 只提取「第一人称自归属」分句里的模型族，供 mixed 判定使用。
 * 旧实现直接对整段文本 familiesIn：合法比较句（"GPT 适合 X，Claude 适合 Y"）、引语、
 * prompt 回显里的他族会被误算成「我也是他族」，把正常回答压成 warn 80。
 * 规则：按句读切分 → 仅保留含第一人称/模型标签的分句 → 去掉 similar to/compared to 之后的比较内容。
 */
const SELF_CLAIM_RE =
  /\b(?:i\s*(?:am|['’]m)|my (?:model|name)\b|this model is|the model is|we are)\b|我是|我叫|我来自|是我|本模型|我的模型|model\s*:/i;
const SELF_CLAIM_SKIP_RE = /^(?:you|the user|user|prompt|question)\b/i;
const COMPARISON_CUT_RE = /\b(?:similar to|like|compared (?:to|with)|unlike|whereas)\b[\s\S]*$/i;

function selfClaimFamilies(text: string): Set<string> {
  const declared = new Set<string>();
  const cleaned = text.replace(/["“][^"”]*["”]/g, ' ');
  for (const clause of cleaned.split(/[，,。;；!?！？\n]/)) {
    const trimmed = clause.trim();
    if (!SELF_CLAIM_RE.test(trimmed) || SELF_CLAIM_SKIP_RE.test(trimmed)) continue;
    for (const family of familiesIn(trimmed.replace(COMPARISON_CUT_RE, ''))) declared.add(family);
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
 * 族失配统计（falsified 与多数不一致告警共用计数口径）：
 * - mismatch：声明了模型族且与期望族无交集（纯他族）；
 * - mixed：同时声明目标族与他人族（对冲/多身份声明，不能算一致）。
 * 未声明族（declared 为空）的样本不计入；期望族为空时两者恒为 0。
 * mixed 不得被 some(has) 洗成一致，否则「我是 GPT，也是 Claude」可稳定绕开 falsified/多数告警；
 * 但也不能直接等同纯他族定罪，故单列并由告警层合并统计。
 */
function countFamilyMismatch(
  samples: readonly IdentitySample[],
  expect: readonly string[],
): { mismatch: number; mixed: number; expectedAliases: Set<string> } {
  const expectedAliases = expectedFamiliesFor(expect);
  if (expectedAliases.size === 0) return { mismatch: 0, mixed: 0, expectedAliases };
  let mismatch = 0;
  let mixed = 0;
  for (const sample of samples) {
    const declared = familiesIn(sample.result.text);
    if (declared.size === 0) continue;
    const expectedHits = [...declared].filter((d) => expectedAliases.has(d)).length;
    if (expectedHits === 0) mismatch += 1;
    else if (expectedHits < declared.size) {
      const selfDeclared = selfClaimFamilies(sample.result.text);
      if ([...selfDeclared].some((d) => !expectedAliases.has(d))) mixed += 1;
    }
  }
  return { mismatch, mixed, expectedAliases };
}

/**
 * falsified 判定（全体一致语义）：所有有效样本都声明了模型族、且无一与期望族相交，
 * 才判伪造。分母用有效自述数（空响应/截断/失败不加入分母），3 条有效且全部 mismatch
 * 即可定罪；未声明族（declared 为空）的样本不计入 mismatch。
 */
function detectFalsified(stats: { mismatch: number; expectedAliases: Set<string> }, validSampleCount: number): boolean {
  if (stats.expectedAliases.size === 0) return false;
  if (validSampleCount < 3) return false;
  return stats.mismatch === validSampleCount;
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
 * - 回显是请求名的前缀且裁掉的是纯数字日期钉版（gpt-4o-2024-08-06 → gpt-4o）或官方滚动
 *   别名后缀（gpt-4o-latest → gpt-4o）：视为一致；裁掉的其余部分（qwen2.5-72b-instruct →
 *   qwen2.5、glm-5.3-flash → glm-5.3）意味着上游只认领了不同的更小变体，按可疑计（审计钉 ⑤）；
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
      // 回显是请求名的删节：仅当裁掉的部分是纯数字日期钉版或官方滚动别名后缀才按一致处理
      const removed = wanted.slice(got.length + 1);
      if (/^\d[\d.-]*$/.test(removed) || BENIGN_ALIAS_SUFFIXES.has(removed)) {
        match += 1;
      } else {
        suspicious += 1;
      }
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

/** 提取文本中首个未被否定的具体版本号串（展示用）；提取不到返回 null。 */
function extractClaimedVersion(text: string): string | null {
  const pattern = new RegExp(CLAIMED_VERSION_RE.source, `${CLAIMED_VERSION_RE.flags}g`);
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? -1;
    if (index >= 0 && !isNegated(text, index, match[0].length)) return match[0];
  }
  return null;
}

/** 提取文本中全部 X.Y(.Z) 版本号（lowercase 集合，交集比较用）。 */
function extractComparableVersions(text: string): Set<string> {
  return new Set((text.match(COMPARABLE_VERSION_RE) ?? []).map((v) => v.toLowerCase()));
}

/**
 * 提取自述中未被否定的版本号。否定句（"I am GLM, not GPT-4"）不是自报版本；
 * 若把被否定的他族版本也计入，会把正常回答误判为版本矛盾（2026-10-21 回归）。
 */
function extractClaimedVersions(text: string): Set<string> {
  const versions = new Set<string>();
  for (const match of text.matchAll(COMPARABLE_VERSION_RE)) {
    const index = match.index ?? -1;
    if (index >= 0 && !isNegated(text, index, match[0].length)) versions.add(match[0].toLowerCase());
  }
  for (const match of text.matchAll(FAMILY_INT_VERSION_RE)) {
    const version = match[1];
    const index = match.index ?? -1;
    if (version !== undefined && index >= 0 && !isNegated(text, index, match[0].length)) versions.add(version);
  }
  return versions;
}

interface VersionParts {
  major: number;
  minor: number | null;
  patch: number | null;
}

function parseVersionParts(value: string): VersionParts | null {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(value);
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: match[2] === undefined ? null : Number(match[2]),
    patch: match[3] === undefined ? null : Number(match[3]),
  };
}

function claimedVersionCompatible(target: VersionParts, claimed: VersionParts): boolean {
  if (claimed.major !== target.major) return false;
  if (claimed.minor !== null && claimed.minor !== target.minor) return false;
  if (claimed.patch !== null && claimed.patch !== target.patch) return false;
  return true;
}

function hasCompatibleClaimedVersion(claimed: Iterable<string>, target: Iterable<string>): boolean {
  const targets = [...target]
    .map(parseVersionParts)
    .filter((version): version is VersionParts => version !== null);
  if (targets.length === 0) return false;
  for (const claim of claimed) {
    const parsed = parseVersionParts(claim);
    if (parsed !== null && targets.some((version) => claimedVersionCompatible(version, parsed))) {
      return true;
    }
  }
  return false;
}

// —— 自述具体型号后缀比对（审计钉 ⑤：glm-5.3 实际是 glm-5.3-flash 的核心取证面）——
// 场景：中转把请求模型换成同族更轻变体（glm-5.3 → glm-5.3-flash、gpt-4.1 → gpt-4.1-mini）。
// 族指纹（glm）一致、X.Y 版本号一致，既有族/版本判定全部失明；唯一暴露面是自述带出了
// 具体变体名。判定只比对「族前缀 + 版本锚点 + 变体段」这一精确形态，避免全文字符串猜测。

/**
 * 目标模型名解析（vendor 剥离 + 小写）：族前缀（可含字母段，如 claude-3）、X.Y(.Z) 版本锚点、
 * 可选变体段。无 X.Y 版本（gpt-4o、claude-3-5 整名无小数点）返回 null——该形态无版本锚点，
 * 变体比对无从谈起，换壳检测由回显字段与族指纹兜底，不做无锚点猜测。
 */
const TARGET_IDENTITY_RE = /^([a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*?)[-\s]?(\d+(?:\.\d+)?)(?:[-\s]([a-z][a-z0-9]{0,15}))?$/;

interface TargetModelIdentity {
  prefix: string;
  version: string;
  variant: string | null;
}

function parseTargetModelIdentity(model: string): TargetModelIdentity | null {
  const m = stripVendorPrefix(model).trim().toLowerCase().match(TARGET_IDENTITY_RE);
  if (m === null) return null;
  const prefix = m[1] ?? '';
  const version = m[2] ?? '';
  if (prefix === '' || version === '') return null;
  return { prefix, version, variant: m[3] ?? null };
}

/** 正则转义（动态拼装 claimed 匹配正则用：候选文本不直接进 RegExp 字符类，仅整体转义）。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** claimed 侧匹配正则：族前缀 + 分隔符等价版本号（glm-5.3 / glm 5.3 / GLM-5-3 均命中）+ 可选变体段。
 * 变体段分隔符只认 [-._]（不含空白）：「GLM-5.3 by Zhipu」里变体组若允许空白会吞掉
 * 后续普通英文词（by/from/made）产出「变体 by」假冲突（红队实证于 2026-10-19 用例）。 */
function buildClaimedModelPattern(identity: TargetModelIdentity): RegExp {
  const versionPattern = escapeRegExp(identity.version).replace(/\\\./g, '[.\\-_\\s]?');
  return new RegExp(
    `${escapeRegExp(identity.prefix)}[-\\s]?${versionPattern}(?:[-._]([a-z][a-z0-9]{0,15}))?`,
    'gi',
  );
}

/** 变体段归一：去 benign 滚动别名尾缀与裸别名词（latest/preview/…）后的比较形态；
 * 剥空视为无变体声明（与回显判定 BENIGN_ALIAS_SUFFIXES 同口径，不诬告）。 */
function normalizeClaimedVariant(variant: string): string {
  let v = variant.toLowerCase().trim();
  for (;;) {
    const m = v.match(/^(.*)-(latest|preview|beta|exp|experimental)$/);
    if (m === null) break;
    v = m[1] ?? '';
  }
  if (/^(latest|preview|beta|exp|experimental)$/.test(v)) return '';
  return v;
}

/** 不确定语境（本分句内）：模型自己也经常拿不准身份，不确定声明不构成矛盾证据。 */
const UNCERTAINTY_CLAUSE_RE = /可能|大概|也许|或许|不确定|也许|maybe|perhaps|might\s+be|could\s+be|猜/i;

interface ClaimedVariantScan {
  /** 各冲突变体命中的样本（key=归一化变体名，value=样本 evidenceId 列表） */
  conflicts: Map<string, string[]>;
  /** 冲突样本总数（每样本至多计 1 次） */
  conflictSamples: number;
  /** 精确版本题是否命中冲突 */
  exactQuestionConflict: boolean;
  /** 目标带变体但自述只认领族+版本（更窄声明，如 glm-5.3-flash 自述 glm-5.3）的样本数 */
  narrowerClaims: number;
  /** 全部捕获到的自述具体型号展示形态（去重） */
  claimedDisplays: Set<string>;
}

function scanClaimedVariants(
  samples: readonly IdentitySample[],
  identity: TargetModelIdentity,
): ClaimedVariantScan {
  const pattern = buildClaimedModelPattern(identity);
  const scan: ClaimedVariantScan = {
    conflicts: new Map(),
    conflictSamples: 0,
    exactQuestionConflict: false,
    narrowerClaims: 0,
    claimedDisplays: new Set(),
  };
  for (const sample of samples) {
    const text = sample.result.text;
    let sampleConflict = false;
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? -1;
      if (index < 0) continue;
      // 否定语境（复用族判定的分句否定检测）与不确定语境都不构成自报身份
      if (isNegated(text, index, match[0].length)) continue;
      const clause =
        text.slice(0, index + match[0].length).split(/[，,。;；!?！？\n]/).pop() ?? text;
      if (UNCERTAINTY_CLAUSE_RE.test(clause)) continue;
      const claimed = match[0].replace(/\s+/g, ' ').trim();
      scan.claimedDisplays.add(claimed);
      const variant = normalizeClaimedVariant(match[1] ?? '');
      if (variant === identity.variant) continue; // 变体一致：同型号自述，正常
      if (variant === '') {
        // 目标带变体、自述只认领族+版本：可能是简写，也可能是自述被「提升」为旗舰名——
        // 不诬告优先，单独计数披露，不进冲突。
        if (identity.variant !== null) scan.narrowerClaims += 1;
        continue;
      }
      sampleConflict = true;
      const evidence = scan.conflicts.get(variant) ?? [];
      evidence.push(sample.evidenceId);
      scan.conflicts.set(variant, evidence);
      if (sample.question === EXACT_VERSION_QUESTION) scan.exactQuestionConflict = true;
    }
    if (sampleConflict) scan.conflictSamples += 1;
  }
  return scan;
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

// —— 模板/死板回复检测（2026-10-22 加强：防中转站固定话术回复模型名）——
// 旧口径只认「全部非空自述逐字一致」，两个逃逸面：①固定话术只覆盖多数样本（部分缓存/按端点
// 分流）；②逐字基础上微改写（加称呼、换标点/语序）。新增弱信号均只 warn 不定罪；近雷同比对
// 设归一化长度下限，避免小模型对短问答的天然复读被误伤。
const NEAR_DUP_JACCARD = 0.9;
const NEAR_DUP_MIN_LEN = 24;

/** 最大同文组：归一化文本中出现次数最多的那条文本及其计数。 */
function largestIdenticalGroup(texts: readonly string[]): { text: string; count: number } {
  const counts = new Map<string, number>();
  let best = { text: '', count: 0 };
  for (const text of texts) {
    const n = (counts.get(text) ?? 0) + 1;
    counts.set(text, n);
    if (n > best.count) best = { text, count: n };
  }
  return best;
}

/** 归一化文本的字符二元组集合（长度 <2 为空集，Jaccard 恒 0）。中文无分词，字符二元组对中英文都稳定。 */
function charBigrams(text: string): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i + 1 < text.length; i += 1) grams.add(text.slice(i, i + 2));
  return grams;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const gram of a) if (b.has(gram)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** 近逐字雷同检测（全量两两比较 + 并查集连通簇）：归一化长度 ≥ minLen 的样本两两
 * bigram Jaccard ≥ threshold 建边，返回最大连通簇大小。不用贪心代表归簇——贪心结果
 * 依赖采样顺序且 A~B、B~C 链式关系会因代表选择断裂漏聚；全量两两连通与顺序无关
 * （可复算）。样本量 ≤8，O(n²) 可忽略。逐字一致的文本天然 Jaccard=1，
 * 调用方须先用「逐字一致」信号分流，避免同一现象重复告警。 */
function largestNearDupGroup(texts: readonly string[], threshold: number, minLen: number): number {
  const grams = texts.filter((t) => t.length >= minLen).map(charBigrams);
  const parent = grams.map((_, i) => i);
  const find = (start: number): number => {
    let root = start;
    for (;;) {
      const p = parent[root];
      if (p === undefined || p === root) break;
      root = p;
    }
    let cur = start;
    while (cur !== root) {
      const next = parent[cur];
      parent[cur] = root;
      if (next === undefined) break;
      cur = next;
    }
    return root;
  };
  for (let i = 0; i < grams.length; i += 1) {
    const gi = grams[i];
    if (gi === undefined) continue;
    for (let j = i + 1; j < grams.length; j += 1) {
      const gj = grams[j];
      if (gj === undefined) continue;
      if (jaccard(gi, gj) >= threshold) {
        const ri = find(i);
        const rj = find(j);
        if (ri !== rj) parent[rj] = ri;
      }
    }
  }
  if (grams.length === 0) return 0;
  const sizes = new Map<number, number>();
  let max = 0;
  for (let i = 0; i < grams.length; i += 1) {
    const root = find(i);
    const n = (sizes.get(root) ?? 0) + 1;
    sizes.set(root, n);
    if (n > max) max = n;
  }
  return max;
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
  /** 失败请求的原始错误串（供「无有效样本」标题归因：端点拒绝/鉴权/网络…） */
  const selfIdErrors: string[] = [];

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
      selfIdErrors.push(result.error ?? 'unknown');
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
  // 有效自述：≥3 字，或虽只有 2 字但已明确声明模型族（如「豆包」「文心」）——
  // 后者必须计入分母，否则 mismatch 可能大于 answerable，稀释/扭曲 falsified 与多数告警。
  const answerable = samples.filter(
    (sample, i) => (normalized[i] ?? '').length >= 3 || familiesIn(sample.result.text).size > 0,
  ).length;
  // 逐字一致只在「非空非纯空白」的归一化文本之间统计：空响应没有指纹含义，
  // 参与相邻比较会把「多个空回答」误判成模板特判，冤枉限流/截断下的端点。
  const nonEmpty = normalized.filter((t) => t.length > 0);
  const identicalPairs = nonEmpty.filter((t, i) => i > 0 && t === nonEmpty[i - 1]).length;
  const identical = largestIdenticalGroup(nonEmpty);
  const identicalMaxGroup = identical.count;
  // 逐字最大组在近雷同聚类中恒成簇（同文 Jaccard=1）：该组 ≥2 条时先整组剔除再聚类，
  // 否则逐字侧（③已按 info/WARN 披露的同一现象）会在近雷同侧重复告警，且
  // 「少数逐字一致 + 另一组近雷同」的复合形态无法区分两组、被互斥条件漏检。
  const nearDupMaxGroup = largestNearDupGroup(
    identicalMaxGroup >= 2 ? nonEmpty.filter((t) => t !== identical.text) : nonEmpty,
    NEAR_DUP_JACCARD,
    NEAR_DUP_MIN_LEN,
  );

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
  metrics['identical_max_group'] = identicalMaxGroup;
  metrics['near_dup_group'] = nearDupMaxGroup;
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
  const conflictingFamilies = familyStats.mismatch + familyStats.mixed;

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
    for (const v of extractClaimedVersions(sample.result.text)) claimedVersions.add(v);
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
      headline: failureDigest(
        selfIdErrors,
        questions.length,
      ) ?? (starvedSelfId > 0
        ? '身份探针无有效样本（自述因推理占满预算或请求失败未产出答案），无法核验'
        : '身份探针无有效样本（自述请求全部失败），无法核验'),
      findings,
      metrics,
    };
  }

  // 与族判定无关的软信号（refusal / 逐字一致 / 格式合规 / 人格注入）：诚实降级分支里也应披露，
  // 不因降级而丢失；文案与下方主流程对应分支保持一致（主流程版本额外压分，降级分支无分可压）。
  // 模板/死板回复告警（主流程与诚实降级分支共用同一口径，文案一致）：
  // ① 全部非空逐字一致 → 疑似模板特判或缓存（压到 70）；
  // ② 多数逐字一致（≥3 条且过半，但未覆盖全部）→ 疑似部分缓存/按题分流（压到 85）；
  // ③ 少数逐字一致（≥3 条未过半）→ 仅 info 披露；
  // ④ 近逐字雷同组 ≥3（逐字信号缺席时才查，避免同一现象重复告警）→ 疑似同一固定话术微改写（压到 85）。
  const templateWarns = (): Finding[] => {
    const out: Finding[] = [];
    if (nonEmpty.length >= 3 && identicalMaxGroup >= nonEmpty.length) {
      out.push({ level: 'warn', message: '多次采样回答逐字一致，疑似模板特判或缓存。', evidenceIds: [] });
    } else if (identicalMaxGroup >= 3 && identicalMaxGroup >= Math.ceil(nonEmpty.length / 2)) {
      out.push({
        level: 'warn',
        message: `${identicalMaxGroup}/${nonEmpty.length} 条非空自述逐字一致（其余存在差异），疑似部分缓存或模板特判。`,
        evidenceIds: [],
      });
    } else if (identicalMaxGroup >= 3) {
      out.push({
        level: 'info',
        message: `${identicalMaxGroup}/${nonEmpty.length} 条非空自述逐字一致：疑似缓存痕迹，证据较弱仅披露。`,
        evidenceIds: [],
      });
    }
    // 近雷同：仅当逐字信号未产出 warn（全部/多数一致已定档）时才告警，避免同一现象双重扣分；
    // 复合形态（少数逐字一致仅 info + 另一组近雷同）也由此覆盖，不再被互斥条件漏检。
    if (!out.some((f) => f.level === 'warn') && nearDupMaxGroup >= 3) {
      out.push({
        level: 'warn',
        message: `${nearDupMaxGroup}/${nonEmpty.length} 条自述高度雷同（非逐字一致但几乎同文），疑似同一固定话术微改写或缓存。`,
        evidenceIds: [],
      });
    }
    return out;
  };

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
    for (const warn of templateWarns()) findings.push(warn);
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
  // a2) 仅有 2 条有效自述且存在族失配：既不够 falsified 的 3 条定罪线，也不能像一致样本一样 PASS。
  //     旧逻辑在 2 条有效自述（其余空响应/推理截断）全部指向他族时，因 samples.length<3 跳过多数告警，
  //     最终输出 100 分「身份探针未见异常」——2 条一致的他族自述虽不足以定罪，但绝不能算通过。
  if (answerable === 2 && familyStats.mismatch > 0) {
    findings.push({
      level: 'warn',
      message: `有效自述样本仅 2 条，其中 ${familyStats.mismatch} 条指向其他模型族：证据不足以定罪，也不足以判定身份通过。`,
      evidenceIds: samples.map((s) => s.evidenceId),
    });
    attachSoftWarns();
    const echoNote =
      echoFinding !== null ? `；上游回显模型与请求不一致（${echoStats.suspicious}/${echoStats.total}）：疑似换壳/换通道` : '';
    return {
      id: 'identity',
      status: 'insufficient',
      score: null,
      level: 'warn',
      headline: `有效自述样本仅 2 条且存在族失配，无法核验身份${echoNote}`,
      findings,
      metrics,
    };
  }
  // a3) 最少有效证据门槛（2026-10-18 真机实证；2026-10-19 扩到 2 条）：少于 3 条有效自述时，
  //     无论声明了什么族，都不足以构成身份结论——1 条既不能证伪也不能核实，2 条一致样本也不足
  //     以证明维度通过（其余样本为空/截断时尤其如此），不出分。回显/人格等软告警仍需披露。
  if (answerable > 0 && answerable < 3) {
    findings.push({
      level: 'info',
      message: `有效自述样本仅 ${answerable} 条（其余为空响应/请求失败/推理占满预算），不足以核验身份，结论不出分。`,
      evidenceIds: [],
    });
    if (conflictingFamilies > 0) {
      const detail = [
        familyStats.mismatch > 0 ? `${familyStats.mismatch} 条指向其他模型族` : '',
        familyStats.mixed > 0 ? `${familyStats.mixed} 条为混合声明（含目标族）` : '',
      ]
        .filter((s) => s !== '')
        .join('、');
      findings.push({
        level: 'warn',
        message: `有效自述仅 ${answerable} 条，其中 ${detail}：证据不足以定罪，也不能判身份通过。`,
        evidenceIds: samples.map((s) => s.evidenceId),
      });
    }
    attachSoftWarns();
    const echoNote =
      echoFinding !== null ? `；上游回显模型与请求不一致（${echoStats.suspicious}/${echoStats.total}）：疑似换壳/换通道` : '';
    return {
      id: 'identity',
      status: 'insufficient',
      score: null,
      level: findings.some((f) => f.level === 'warn') ? 'warn' : 'unknown',
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

  const falsified = detectFalsified(familyStats, answerable);

  let score = 100;
  let level: ProbeOutcome['level'] = 'pass';
  let headline = '身份探针未见异常';

  if (falsified) {
    score = 0;
    level = 'fail';
    headline = `身份矛盾：${answerable} 条有效自述均未提及目标模型族（${ctx.cfg.model} 或其厂商）`;
    findings.push({
      level: 'fail',
      message: `目标模型族为 ${ctx.cfg.model}，但每条有效自述都指向其他模型族。自述不可单独定罪，但与其余探针一致时构成换壳证据。`,
      evidenceIds: samples.map((s) => s.evidenceId),
    });
  } else if (answerable >= 3 && conflictingFamilies >= Math.ceil(answerable / 2) && conflictingFamilies >= 2) {
    // c) 多数不一致告警：未达全体一致定罪线，但多数有效自述未明确目标族（纯他族或混合声明）——
    //    疑似换壳/多身份对冲，压制可信度分并降为可疑，不再输出「未见异常」的假清白。
    //    分母只计有效自述，避免空响应稀释后把「2 条他族 + 1 条中性 + 2 条空」洗成 PASS 100。
    score = Math.min(score, 60);
    level = 'warn';
    const mixedNote =
      familyStats.mixed > 0 ? `（${familyStats.mismatch} 条纯他族、${familyStats.mixed} 条混合声明）` : '';
    if (familyStats.mixed > 0) {
      headline = `多数自述（${conflictingFamilies}/${answerable}）包含其他模型族声明${mixedNote}，疑似换壳/混合身份（未达全体一致定罪线）`;
      findings.push({
        level: 'warn',
        message: `多数自述（${conflictingFamilies}/${answerable}）包含其他模型族声明${mixedNote}，疑似换壳/混合身份（未达全体一致定罪线）。`,
        evidenceIds: samples.map((s) => s.evidenceId),
      });
    } else {
      headline = `多数自述（${conflictingFamilies}/${answerable}）指向其他模型族，疑似换壳（未达全体一致定罪线）`;
      findings.push({
        level: 'warn',
        message: `多数自述（${conflictingFamilies}/${answerable}）指向其他模型族，疑似换壳（未达全体一致定罪线）。`,
        evidenceIds: samples.map((s) => s.evidenceId),
      });
    }
  } else if (claimedVersions.size > 0) {
    const targetVersions = extractComparableVersions(stripVendorPrefix(ctx.cfg.model));
    const declaredOverlap = [...familyUnion].some((f) => expectedFamiliesFor([ctx.cfg.model]).has(f));
    if (
      declaredOverlap &&
      targetVersions.size > 0 &&
      !hasCompatibleClaimedVersion(claimedVersions, targetVersions)
    ) {
      const claimedVersionText = claimedVersion ?? [...claimedVersions].sort().join('/');
      findings.push({
        level: 'warn',
        message: `自述版本（${claimedVersionText}）与目标模型（${ctx.cfg.model}）不符。模型自述版本天然不可靠，仅作旁证，不构成换壳定罪。`,
        evidenceIds: samples.map((s) => s.evidenceId),
      });
      score = Math.min(score, 90);
      if (level === 'pass') level = 'warn';
    }
  }
  // —— 自述具体型号后缀比对（审计钉 ⑤）：族+版本一致但变体不一致 = 同族异版本换壳的自述证据。
  //    场景：请求 glm-5.3 实际服务 glm-5.3-flash——族指纹与 X.Y 版本号全部一致，既有判定失明，
  //    唯一暴露面是自述带出的具体变体名（精确版本题与随机题的多源一致性）。
  const targetIdentity = parseTargetModelIdentity(ctx.cfg.model);
  if (targetIdentity !== null) {
    const scan = scanClaimedVariants(samples, targetIdentity);
    metrics['claimed_variant_conflicts'] = scan.conflictSamples;
    metrics['claimed_variants'] = scan.claimedDisplays.size > 0 ? [...scan.claimedDisplays].sort().join('/') : 'none';
    if (scan.narrowerClaims > 0) metrics['claimed_narrower_claims'] = scan.narrowerClaims;
    // 触发口径（不诬告优先）：精确版本题 1 次冲突（专门提问的直接回答），或 ≥2 条样本自述
    // 同一个冲突变体（多源一致）；零散不同变体各 1 次只 info 披露不定罪。
    const consistentVariant = [...scan.conflicts.values()].some((ids) => ids.length >= 2);
    if (scan.exactQuestionConflict || consistentVariant) {
      const variants = [...scan.conflicts.entries()].sort((a, b) => b[1].length - a[1].length).map(([v]) => v);
      findings.push({
        level: 'warn',
        message: `请求模型 ${ctx.cfg.model}，自述具体型号为 ${variants.join('/')}：族与版本号一致但变体不一致，同族异版本（疑似降级/轻量版冒充；自述单独不定罪，需与回显/质量探针合看）。`,
        evidenceIds: [...scan.conflicts.values()].flat(),
      });
      score = Math.min(score, 80);
      if (level === 'pass') {
        level = 'warn';
        headline = `自述具体型号与请求不一致（请求 ${ctx.cfg.model}，自述 ${variants.join('/')}）：同族异版本，疑似降级换壳`;
      }
    } else if (scan.conflictSamples > 0) {
      findings.push({
        level: 'info',
        message: `自述出现的具体型号变体（${[...scan.conflicts.keys()].join('/')}）与请求 ${ctx.cfg.model} 不一致，但各只出现 1 次、无多源一致性：仅披露不定罪。`,
        evidenceIds: [...scan.conflicts.values()].flat(),
      });
    }
    if (scan.narrowerClaims > 0) {
      findings.push({
        level: 'info',
        message: `${scan.narrowerClaims} 条自述只认领到「族+版本」而无变体段（目标为 ${ctx.cfg.model}）：可能是简写或自述被改写为旗舰名，证据不足以指控。`,
        evidenceIds: [],
      });
    }
  }
  // d) 少量混合声明：未达多数告警线，但「目标族 + 其他族」同时出现仍不能算「未见异常」。
  //    例如 1/5 条说「我是 GPT，也是 Claude」时不得 PASS 100；降至 warn 80 并要求人工复核。
  if (
    !falsified &&
    familyStats.mixed > 0 &&
    !findings.some((f) => f.level === 'warn' && /混合声明/.test(f.message))
  ) {
    score = Math.min(score, 80);
    if (level === 'pass') {
      level = 'warn';
      headline = `自述同时声明目标族与其他模型族（混合声明 ${familyStats.mixed}/${answerable}），身份存疑`;
    }
    findings.push({
      level: 'warn',
      message: `自述同时声明目标族与其他模型族（混合声明 ${familyStats.mixed}/${answerable}）：不能据此判定身份通过，也不能单独定罪，建议人工复核。`,
      evidenceIds: samples.map((s) => s.evidenceId),
    });
  }
  // ⑤ 上游回显 model 字段与请求模型不一致（换壳/换通道的机器证据，与 guard model_mismatch 同口径）。
  //    自述可被「教」，回显字段不会：请求 glm-5.3 却回显 glm-5.3-flash = 轻量版冒充旗舰的典型签名。
  //    但回显也可能被网关规范化（丢厂商前缀、丢日期后缀），故只压分到 warn，绝不单判定罪。
  if (echoFinding !== null) {
    score = Math.min(score, echoMajor ? 60 : 80);
    // 回显异常本身只压到 warn，但不得把已经由 falsified 定出的 fail 降级；
    // 否则报告会出现「分项 WARN 0 分 + 总分 FAIL 0」的自相矛盾层级，并掩盖更强结论。
    if (level === 'pass') level = 'warn';
    if (headline === '身份探针未见异常') {
      headline = `上游回显模型与请求不一致（${echoStats.suspicious}/${echoStats.total}）：疑似换壳/换通道`;
    }
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
  // 模板/死板回复告警：全部逐字一致压到 70，多数一致/近雷同压到 85（弱于实锤，强于无视）。
  for (const warn of templateWarns()) {
    findings.push(warn);
    if (warn.level === 'warn') {
      score = Math.min(score, /多次采样回答逐字一致/.test(warn.message) ? 70 : 85);
      if (level === 'pass') level = 'warn';
    }
  }
  if (!schemaStarved && !schemaBlank && schemaResult.ok && !schemaKeysOk) {
    findings.push({ level: 'warn', message: '严格 JSON 输出探针未按结构返回（弱指纹：网关可能重写响应）。', evidenceIds: schemaCall.evidenceIds });
    score = Math.min(score, 90);
    if (level === 'pass') level = 'warn';
  }

  const starvedNote = starvedSelfId > 0 ? `（另有 ${starvedSelfId} 次自述因推理占满预算按无效样本处理）` : '';
  findings.push({ level: 'info', message: `共采样 ${samples.length} 次自述 + 1 次格式合规探针。${starvedNote}`, evidenceIds: [] });
  // headline 诚实性：任何把 level 降为 warn 却不自带 headline 的分支（版本旁证/回显少数不一致/
  // 回避/逐字一致/格式不合规）都必须在这里统一改写，否则报告会并列出现
  // 「身份探针未见异常」与 warn finding——既自相矛盾，也会误导人工复核。
  if (level === 'warn' && headline === '身份探针未见异常') {
    const warnCount = findings.filter((f) => f.level === 'warn').length;
    headline = `身份探针存在 ${warnCount} 项未达实锤标准的信号（见明细）`;
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
