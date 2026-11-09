import type { ChatMessage, ChatResult, Finding, ProbeCtx, Rng } from '../types.js';
import { recordCall } from '../evidence.js';

/**
 * logprob 指纹（v0.3，参考端点可选增强）：
 * 同一组随机 prompt 在主/参考端点各发一次（temperature=0、max_tokens=2、logprobs=true、top_logprobs=5），
 * 只比较**第一个非空白 token**——自由生成一旦分叉，后续位置的条件分布不同，按位置比较无效。
 * 判定只比较「同 token 的 logprob 差」与「top5 集合重合度」；两轮全新随机 prompt 同向才确认不一致，
 * 避免单轮抖动/量化部署误伤。任何一侧不支持 logprobs 都只披露、不判定（网关普遍会剥除该字段）。
 */

export interface TopToken {
  token: string;
  logprob: number;
}

export interface LogprobPosition {
  token: string;
  logprob: number;
  top: TopToken[];
}

export interface ExtractedLogprob {
  position: LogprobPosition | null;
  trusted: boolean;
  reason: string | null;
}

export interface LogprobVector {
  promptId: string;
  position: LogprobPosition | null;
  trusted: boolean;
  reason: string | null;
  evidenceId: string;
}

export interface LogprobComparison {
  comparable: number;
  agreement: number;
  mae: number | null;
  jaccard: number;
  sameTokenCount: number;
  suspicious: boolean;
  untrusted: number;
  replayVectors: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asFiniteLogprob(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value <= 0 ? value : null;
}

function parseTopTokens(value: unknown): TopToken[] | null {
  if (!Array.isArray(value)) return null;
  const out: TopToken[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (record === null) continue;
    const token = record['token'];
    const logprob = asFiniteLogprob(record['logprob']);
    if (typeof token === 'string' && token !== '' && logprob !== null) out.push({ token, logprob });
  }
  return out.length > 0 ? out : null;
}

/** 校验 top_logprobs 的形状与概率和：截断的 top-k 天然 ≤1，>1+ε 说明数据不可信（只降级，不定罪）。 */
function validatePosition(position: LogprobPosition): string | null {
  if (position.top.length === 0) return 'empty_top_logprobs';
  if (!position.top.some((entry) => entry.token === position.token)) return 'top1_missing';
  let probabilityMass = 0;
  for (const entry of position.top) probabilityMass += Math.exp(entry.logprob);
  if (probabilityMass > 1.001) return 'probability_mass';
  return null;
}

/**
 * 从 OpenAI 兼容响应中提取第一个非空白 content token 的 logprob。
 * 同时兼容旧版 `tokens/token_logprobs/top_logprobs` 形态。无法提取时返回 null，不猜测。
 */
export function extractFirstTokenLogprob(raw: unknown): ExtractedLogprob {
  const record = asRecord(raw);
  if (record === null) return { position: null, trusted: false, reason: 'missing_logprobs' };

  let position: LogprobPosition | null = null;
  const content = record['content'];
  if (Array.isArray(content)) {
    for (const item of content) {
      const entry = asRecord(item);
      if (entry === null) continue;
      const token = entry['token'];
      const logprob = asFiniteLogprob(entry['logprob']);
      if (typeof token !== 'string' || logprob === null || token.trim() === '') continue;
      const top = parseTopTokens(entry['top_logprobs']);
      position = { token, logprob, top: top ?? [] };
      break;
    }
  } else {
    const tokens = record['tokens'];
    const tokenLogprobs = record['token_logprobs'];
    const topLogprobs = record['top_logprobs'];
    if (Array.isArray(tokens) && Array.isArray(tokenLogprobs)) {
      for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i];
        const logprob = asFiniteLogprob(tokenLogprobs[i]);
        if (typeof token !== 'string' || logprob === null || token.trim() === '') continue;
        const topRaw = Array.isArray(topLogprobs) ? asRecord(topLogprobs[i]) : null;
        const top: TopToken[] = [];
        if (topRaw !== null) {
          for (const [key, value] of Object.entries(topRaw)) {
            const valueLogprob = asFiniteLogprob(value);
            if (valueLogprob !== null) top.push({ token: key, logprob: valueLogprob });
          }
        }
        position = { token, logprob, top };
        break;
      }
    }
  }

  if (position === null) return { position: null, trusted: false, reason: 'no_content_token' };
  const invalid = validatePosition(position);
  return { position, trusted: invalid === null, reason: invalid };
}

/** 两轮 prompt 的成对比较；只统计双方都可信且都有首个 token 的位置。 */
export function compareLogprobVectors(
  main: readonly LogprobVector[],
  reference: readonly LogprobVector[],
): LogprobComparison {
  const referenceById = new Map(reference.map((vector) => [vector.promptId, vector]));
  let comparable = 0;
  let sameToken = 0;
  let maeSum = 0;
  let maeCount = 0;
  let jaccardSum = 0;
  let untrusted = 0;

  for (const left of main) {
    const right = referenceById.get(left.promptId);
    if (right === undefined) continue;
    if (!left.trusted || !right.trusted || left.position === null || right.position === null) {
      untrusted += 1;
      continue;
    }
    comparable += 1;
    const leftTop = new Set(left.position.top.map((entry) => entry.token));
    const rightTop = new Set(right.position.top.map((entry) => entry.token));
    const intersection = [...leftTop].filter((token) => rightTop.has(token)).length;
    const union = new Set([...leftTop, ...rightTop]).size;
    jaccardSum += union === 0 ? 0 : intersection / union;

    if (left.position.token === right.position.token) {
      sameToken += 1;
      maeSum += Math.abs(left.position.logprob - right.position.logprob);
      maeCount += 1;
    }
  }

  const agreement = comparable > 0 ? sameToken / comparable : 0;
  const mae = maeCount > 0 ? maeSum / maeCount : null;
  const jaccard = comparable > 0 ? jaccardSum / comparable : 0;
  const suspicious =
    comparable >= 4 &&
    (agreement <= 0.5 || (sameToken >= 4 && mae !== null && mae > 0.6 && jaccard < 0.4));

  return {
    comparable,
    agreement,
    mae,
    jaccard,
    sameTokenCount: sameToken,
    suspicious,
    untrusted,
    replayVectors: countReplayVectors(main),
  };
}

/** 不同 prompt 返回完全相同的 top5 向量：可能是伪造/回放，只作披露（短 prompt 的高频 token 也可能巧合）。 */
function countReplayVectors(vectors: readonly LogprobVector[]): number {
  const seen = new Set<string>();
  let replays = 0;
  for (const vector of vectors) {
    if (!vector.trusted || vector.position === null) continue;
    const key = `${vector.position.token}|${vector.position.top
      .map((entry) => `${entry.token}:${entry.logprob.toFixed(3)}`)
      .sort()
      .join(',')}`;
    if (seen.has(key)) replays += 1;
    else seen.add(key);
  }
  return replays;
}

export interface LogprobPrompt {
  id: string;
  prompt: string;
}

const CAPITAL_COUNTRIES = ['France', 'Japan', 'Italy', 'Germany', 'Spain', 'Canada'] as const;

/** 每条 prompt 都期望一个短、确定的首 token；操作数/国家/随机码全部变化，避免题库回放与定向缓存。 */
export function buildLogprobPrompts(rng: Rng, round: number): LogprobPrompt[] {
  const a = rng.int(11, 89);
  const b = rng.int(3, 9);
  const n = rng.int(10, 60);
  const d = rng.int(3, 12);
  const nonce = rng.nonce(6).toUpperCase();
  const country = rng.pick(CAPITAL_COUNTRIES);
  return [
    { id: `r${round}-add`, prompt: `Compute ${a} + ${b}. Answer with the number only.` },
    { id: `r${round}-mul`, prompt: `${a} times ${b} equals` },
    { id: `r${round}-sub`, prompt: `What is ${a * 10 + b} minus ${b}? Answer:` },
    { id: `r${round}-seq`, prompt: `Continue the sequence ${n}, ${n + d}, ${n + 2 * d},` },
    { id: `r${round}-capital`, prompt: `The capital city of ${country} is` },
    { id: `r${round}-nonce`, prompt: `Repeat this code exactly once: ${nonce}` },
  ];
}

export function canonicalModel(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/^(?:[a-z0-9][\w.-]*\/)+/, '')
    .replace(/[._]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function message(prompt: string): ChatMessage[] {
  return [{ role: 'user', content: prompt }];
}

async function measure(
  ctx: ProbeCtx,
  side: 'main' | 'reference',
  client: NonNullable<ProbeCtx['referenceClient']> | ProbeCtx['client'],
  model: string,
  prompt: LogprobPrompt,
): Promise<LogprobVector> {
  const messages = message(prompt.prompt);
  const result = await client.chat({
    model,
    messages,
    temperature: 0,
    max_tokens: 2,
    logprobs: true,
    top_logprobs: 5,
  });
  const evidence = recordCall(ctx.evidence, {
    probe: 'tokenizer',
    endpoint: side,
    label: `logprob ${side} ${prompt.id}`,
    request: { model, stream: false, temperature: 0, maxTokens: 2, messages },
    result,
  });
  const extracted = result.ok ? extractFirstTokenLogprob(result.logprobs) : { position: null, trusted: false, reason: result.error ?? 'request_failed' };
  return {
    promptId: prompt.id,
    position: extracted.position,
    trusted: extracted.trusted,
    reason: extracted.reason,
    evidenceId: evidence.id,
  };
}

async function collectRound(
  ctx: ProbeCtx,
  referenceClient: NonNullable<ProbeCtx['referenceClient']>,
  referenceModel: string,
  round: number,
): Promise<{ main: LogprobVector[]; reference: LogprobVector[]; unsupported: boolean; evidenceIds: string[] }> {
  const prompts = buildLogprobPrompts(ctx.rng, round);
  const main: LogprobVector[] = [];
  const reference: LogprobVector[] = [];
  const evidenceIds: string[] = [];
  for (const prompt of prompts) {
    const left = await measure(ctx, 'main', ctx.client, ctx.cfg.model, prompt);
    const right = await measure(ctx, 'reference', referenceClient, referenceModel, prompt);
    main.push(left);
    reference.push(right);
    evidenceIds.push(left.evidenceId, right.evidenceId);
    // 第一条任一侧完全没有 logprobs 时提前退出：不要把后续 10 次短请求浪费在明确不支持的端点上。
    // 只是「不可信」（概率和/对齐校验失败）仍继续采样，留给调用方按证据不足披露。
    if (prompt === prompts[0] && (left.position === null || right.position === null)) {
      return { main, reference, unsupported: true, evidenceIds };
    }
  }
  return { main, reference, unsupported: false, evidenceIds };
}

export interface LogprobFingerprint {
  findings: Finding[];
  metrics: Record<string, number | string | null>;
  /** 两轮一致确认的 logprob 不一致：供 tokenizer 压分。 */
  confirmedMismatch: boolean;
}

export async function runLogprobFingerprint(ctx: ProbeCtx): Promise<LogprobFingerprint> {
  const findings: Finding[] = [];
  const metrics: Record<string, number | string | null> = {};
  const referenceClient = ctx.referenceClient ?? null;
  const referenceModel = ctx.referenceModel ?? null;
  const unsupported = (reason: string): LogprobFingerprint => {
    metrics['logprob_supported'] = 0;
    findings.push({ level: 'info', message: reason, evidenceIds: [] });
    return { findings, metrics, confirmedMismatch: false };
  };

  if (referenceClient === null || referenceModel === null) {
    return unsupported('未配置参考端点：跳过 logprob 指纹（单端点无法区分“同族不同权重”与“正常抖动”）。');
  }
  if (canonicalModel(ctx.cfg.model) !== canonicalModel(referenceModel)) {
    return unsupported(
      `参考模型 ${referenceModel} 与请求模型 ${ctx.cfg.model} 不是同一模型：logprob 指纹需要同模型参考，已跳过。`,
    );
  }

  const first = await collectRound(ctx, referenceClient, referenceModel, 1);
  if (first.unsupported) {
    metrics['logprob_supported'] = 0;
    findings.push({
      level: 'info',
      message:
        '主/参考端点至少一侧未返回可用 logprobs（部分网关会剥除该字段，Claude/Gemini 兼容层常不支持）：本次不做 logprob 指纹判定，也不据此扣分。',
      evidenceIds: first.evidenceIds,
    });
    return { findings, metrics, confirmedMismatch: false };
  }

  const round1 = compareLogprobVectors(first.main, first.reference);
  metrics['logprob_supported'] = 1;
  metrics['logprob_round1_comparable'] = round1.comparable;
  metrics['logprob_round1_agreement'] = Math.round(round1.agreement * 1000) / 1000;
  if (round1.mae !== null) metrics['logprob_round1_mae'] = Math.round(round1.mae * 1000) / 1000;
  metrics['logprob_round1_jaccard'] = Math.round(round1.jaccard * 1000) / 1000;
  metrics['logprob_round1_untrusted'] = round1.untrusted;
  metrics['logprob_round1_suspicious'] = round1.suspicious ? 1 : 0;
  if (round1.replayVectors > 0) {
    metrics['logprob_replay_vectors'] = round1.replayVectors;
    findings.push({
      level: 'info',
      message: `有 ${round1.replayVectors} 条不同 prompt 返回了完全相同的 top5 logprob 向量：可能是回放/伪造，也可能只是短 prompt 命中相同高频 token，仅披露。`,
      evidenceIds: first.evidenceIds,
    });
  }

  if (round1.comparable < 4) {
    findings.push({
      level: 'info',
      message:
        `logprob 可比样本不足（${round1.comparable} 条 < 4，另有 ${round1.untrusted} 条不可信）：` +
        'top_logprobs 形状/概率和/对齐校验未通过时不作指纹结论，也不扣分。',
      evidenceIds: first.evidenceIds,
    });
    return { findings, metrics, confirmedMismatch: false };
  }
  if (round1.untrusted > 0) {
    findings.push({
      level: 'info',
      message: `有 ${round1.untrusted} 条 logprob 样本未通过形状/概率和/对齐校验，已从比较中剔除（不影响其余 ${round1.comparable} 条）。`,
      evidenceIds: first.evidenceIds,
    });
  }

  if (!round1.suspicious) {
    findings.push({
      level: 'info',
      message:
        `logprob 指纹与参考端点一致（首 token 一致率 ${(round1.agreement * 100).toFixed(0)}%` +
        `${round1.mae === null ? '' : `，同 token logprob 平均差 ${round1.mae.toFixed(3)}`}）：` +
        '该证据支持同模型/同权重量化部署，但不能单独证明身份。',
      evidenceIds: first.evidenceIds,
    });
    return { findings, metrics, confirmedMismatch: false };
  }

  // 首轮可疑：换一批全新随机 prompt 复测，两轮同向才压分。
  const second = await collectRound(ctx, referenceClient, referenceModel, 2);
  if (second.unsupported) {
    findings.push({
      level: 'info',
      message: '首轮 logprob 指纹可疑，但复测轮未获得可用 logprobs：证据不足，不作不一致结论、不扣分。',
      evidenceIds: second.evidenceIds,
    });
    return { findings, metrics, confirmedMismatch: false };
  }
  const round2 = compareLogprobVectors(second.main, second.reference);
  metrics['logprob_round2_comparable'] = round2.comparable;
  metrics['logprob_round2_agreement'] = Math.round(round2.agreement * 1000) / 1000;
  if (round2.mae !== null) metrics['logprob_round2_mae'] = Math.round(round2.mae * 1000) / 1000;
  metrics['logprob_round2_jaccard'] = Math.round(round2.jaccard * 1000) / 1000;
  metrics['logprob_round2_untrusted'] = round2.untrusted;
  metrics['logprob_round2_suspicious'] = round2.suspicious ? 1 : 0;
  if (round2.replayVectors > 0) metrics['logprob_round2_replay_vectors'] = round2.replayVectors;
  if (round2.comparable < 4) {
    findings.push({
      level: 'info',
      message: `首轮 logprob 指纹可疑，但复测轮可比样本不足（${round2.comparable} 条 < 4）：证据不足，不作不一致结论、不扣分。`,
      evidenceIds: second.evidenceIds,
    });
    return { findings, metrics, confirmedMismatch: false };
  }

  if (round2.suspicious) {
    findings.push({
      level: 'warn',
      message:
        `两轮独立随机 prompt 的 logprob 指纹均显著不一致（首轮一致率 ${(round1.agreement * 100).toFixed(0)}%、` +
        `次轮 ${(round2.agreement * 100).toFixed(0)}%）：同一模型名下的 token 概率分布与参考端点不同，` +
        '强烈提示上游权重/模型族不同（量化部署通常只抬高 MAE、不会让首 token 一致率降到 50% 以下）。',
      evidenceIds: [...first.evidenceIds, ...second.evidenceIds],
    });
    metrics['logprob_confirmed_mismatch'] = 1;
    return { findings, metrics, confirmedMismatch: true };
  }

  findings.push({
    level: 'info',
    message:
      `首轮 logprob 偏差未复现（次轮一致率 ${(round2.agreement * 100).toFixed(0)}%）：判为采样抖动或端点瞬时差异，不作指纹结论。`,
    evidenceIds: [...first.evidenceIds, ...second.evidenceIds],
  });
  return { findings, metrics, confirmedMismatch: false };
}
