import type { Rng } from './types.js';
import { estimateTokens } from './tokens.js';

export const PROBESET_VERSION = 'v0.1.0';
export const ASSETS_VERSION = 'assets-v0.1.0';

/** Base paragraphs used to construct long context probes. Deterministic given seed. */
export const NEEDLE_HOST_PARAGRAPHS: readonly string[] = [
  '在分布式系统的设计中，容量规划往往决定了系统能否在流量高峰期保持稳定。工程师需要根据历史数据估算峰值负载，并预留合理的冗余。冗余过大浪费成本，冗余过小则会在关键时刻造成级联故障。',
  'The design of resilient software systems relies on carefully chosen trade-offs. Teams must balance development velocity against long-term maintainability, and they must decide when to buy a solution instead of building one from scratch.',
  '数据管道的可靠性依赖于端到端的可观测性。当日志、指标和链路追踪三者在同一时间轴上对齐时，工程师才能快速定位问题。任何一环缺失，排障时间都会成倍增加。',
  'Caching is one of the most effective performance techniques, but it introduces consistency challenges. A stale cache entry can produce confusing behavior that is hard to reproduce, especially under concurrent writes.',
  '安全审计的重点不是列出所有已知漏洞，而是建立一套可持续的验证流程。流程必须可复现、可度量，并且能被第三方独立执行，否则审计结论只是自我声明。',
  'Machine learning evaluation requires discipline. A benchmark that leaks into training data inflates scores, and a benchmark that is too small produces noisy conclusions. Versioned, procedurally generated test sets are more trustworthy.',
  '网络协议的分层设计让不同厂商的设备可以互联互通，但也意味着任何一层的静默改写都会破坏端到端的信任。检测这种行为需要主动探测，而不是阅读文档。',
  'Software supply chains are complex. Every dependency, build step, and distribution channel adds risk. Minimizing the number of moving parts is a practical way to reduce the attack surface and simplify audits.',
];

export const SENTENCE_POOL: readonly string[] = [
  '系统在压力下应当优雅降级而不是直接崩溃。',
  '工程师用测量代替猜测来做决策。',
  'A reliable probe must be repeatable under identical inputs.',
  '缓存一致性是分布式系统中最容易被忽视的问题之一。',
  'Every silent truncation is a broken promise to the caller.',
  '验证流程本身也必须是可以被验证的。',
  'Latency percentiles tell a different story than averages.',
  '证据链完整的报告才能被第三方复现。',
  '计费系统的每个字节都应该能被解释。',
  'A fingerprint that can be spoofed by one prompt is not a fingerprint.',
  '随机化让按模板特判的网关无法稳定作弊。',
  'The cheapest way to fake a model is to route it to a smaller one.',
];

/** Identity probes: neutral, no hint of expected answer. */
export const IDENTITY_QUESTIONS: readonly string[] = [
  '请用一句话回答：你是什么AI模型？给出你的名称和所属机构。',
  'State your exact model name and the organization that created you, in one short sentence.',
  '你是什么模型？你的训练机构是谁？请直接回答，不要回避。',
  'Which AI model are you? Answer with your model name only.',
  '请告诉我你的真实身份：模型名称、版本号（如有）、开发机构。',
];

/** Probes that require strict JSON output; format compliance is a weak fingerprint. */
export const SCHEMA_PROBES: readonly { prompt: string; keys: readonly string[] }[] = [
  {
    prompt: '回复一个 JSON 对象，只包含两个字段："model_family"（你认为自己属于的模型系列）和 "language_count"（你训练数据涉及的语言数量估计，整数）。只输出 JSON，不要其他文字。',
    keys: ['model_family', 'language_count'],
  },
  {
    prompt: 'Return a JSON object with exactly these keys: "self_name" (your model name) and "context_window" (your advertised context window in tokens, integer). Output JSON only.',
    keys: ['self_name', 'context_window'],
  },
];

/** Filler text generator for context probes. Targets estimated tokens, not chars. */
export function buildFiller(rng: Rng, targetTokens: number): string {
  const parts: string[] = [];
  let tokens = 0;
  while (tokens < targetTokens) {
    const paragraph: string[] = [];
    const sentenceCount = rng.int(4, 8);
    for (let i = 0; i < sentenceCount; i += 1) {
      paragraph.push(rng.pick(SENTENCE_POOL));
    }
    const text = paragraph.join(' ');
    parts.push(text);
    tokens += estimateTokens(text) + 2;
  }
  return parts.join('\n\n');
}

/** Build a needle sentence carrying a unique nonce. */
export function buildNeedle(rng: Rng, nonce: string): string {
  return rng.pick([
    `【档案记录 ${nonce}】本节内容的校验口令是 ${nonce}。`,
    `[ARCHIVE RECORD ${nonce}] The verification passphrase for this section is ${nonce}.`,
    `【勘误条目 ${nonce}】唯一有效校验码：${nonce}。`,
  ]);
}

export function buildNeedleQuestion(nonce: string, lang: 'zh' | 'en'): string {
  if (lang === 'zh') return `在提供的文档中，编号${nonce}的记录里给出的存档口令是什么？只回答口令本身。`;
  return `In the provided document, what is the archive passphrase in record ${nonce}? Reply with the passphrase only.`;
}

export function buildEchoQuestion(): string {
  return '请逐字复述你收到的上一条用户消息的最后一句话（最后 15 个字以内），只输出那句话，不要解释。';
}

export function needleAnswer(nonce: string): string {
  return nonce;
}

/** Random-looking harmless decoy tasks to detect eager special-casing. */
export const DECOYS: readonly string[] = [
  '用三句话解释什么是快速排序。',
  'Write a haiku about databases.',
  '把这句话翻译成英文：今天天气很好。',
];
