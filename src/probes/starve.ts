import type { ChatMessage, ChatRequest, ChatResult, ProbeCtx, ProbeId } from '../types.js';
import { recordCall, type EvidenceInput } from '../evidence.js';

/**
 * 推理占满预算（thinking starvation）判定：请求成功但 finish_reason='length' 即视为截断。
 * 不看 text 是否为空——非空截断（如只生成了 `{"a":` 半截 JSON）同样是 starvation。
 * 此类响应是「证据不足」，绝不能按「答错/能力缺失」计 0 分（"证据不足不给 0 分"原则）。
 */
export function isStarved(result: ChatResult): boolean {
  return result.ok && result.finishReason === 'length';
}

/**
 * 「HTTP 200 但正文为空」判定：请求成功、未截断、却没有任何 content。
 * 这类响应是「未获得答案」，不是答错、更不是能力缺失/窗口不实——所有问答探针必须把
 * 它从分母剔除并显式披露。历史缺陷（2026-10-18 真机）：中转站 200 空流被 context 计为
 * needle 未命中、被 quality 计为答错、被 capability 计为未发起工具调用，导致集体误判。
 */
export function isBlankAnswer(result: ChatResult): boolean {
  return result.ok && !isStarved(result) && result.text.trim() === '';
}

/**
 * 各探针问答预算（max_tokens）与 starvation 重试升级预算，集中定义保证探针间一致、调整有据可查。
 * 实测来源：glm-5.3-flash（thinking 模型）真机审计（2026-10-10，中转站实测）：
 * - vision 16：reasoning 全部吃掉预算，content 恒空；实测需 >256，1024 可产出答案 → 基础 1024，重试升 2048；
 * - quality 64：同样被推理占满 → 基础 256，重试升 512；
 * - tool 次轮 64：同上 → 基础 256，重试升 512；
 * - identity 200：部分样本 starved → 基础 512（不重试：starved 仅按证据不足处理）。
 * billing/ttft 不需要答案正文，预算不改。
 * - context（2026-10-17 同站实测）：needle 13/13 样本 + tail_echo 全部 starved（max_tokens=32/64，
 *   context 维度整体判为「不可判定」= 思考型模型的上下文缩水无法实测）；沿用 vision 已验证可作答的
 *   1024/2048 组合。needle/echo 只需回一个 6 位 nonce，提高的是上限而非实际产出，计费增量可忽略。
 * - tool 首轮（2026-10-17 mock 矩阵 arm 17/22 实测缺口）：原写死 max_tokens=200 且不做 starvation
 *   判定 → thinking 模型推理吃掉 200 后返回纯文本，被误判「未发起工具调用」= fail 0（证据不足给 0 分，
 *   与 vision 路径自相矛盾）。改用与 vision 同级的 1024/2048 首查-重试组合，并把 starved 降级为 N/A。
 */
export const PROBE_BUDGETS = {
  vision: 1024,
  visionRetry: 2048,
  quality: 256,
  qualityRetry: 512,
  toolFirst: 1024,
  toolFirstRetry: 2048,
  toolSecond: 256,
  toolSecondRetry: 512,
  identity: 512,
  context: 1024,
  contextRetry: 2048,
} as const;

export interface BlankRetryCall {
  /** 最终采用的结果（首查有正文，或流式回退成功的那次） */
  result: ChatResult;
  /** 最终采用结果对应的证据 id */
  evidenceId: string;
  /** 全部证据 id（首查 + 可能的流式回退，按调用顺序） */
  evidenceIds: string[];
  /** 是否因首查空响应触发了流式回退 */
  blankRetried: boolean;
  /** 流式回退是否成功产出可用正文（否则保留首查空响应） */
  streamFallback: boolean;
}

/**
 * 空响应恢复：HTTP 200 但正文为空时，改用 stream:true 以 retryBudget 重发一次。
 * 真机实证（2026-10-18）：部分中转站的非流式路由对 thinking 模型恒返回 200 空流
 * （choices:[] + usage，finish_reason=null），而同模型流式路由可正常产出；同形重试无效，
 * 切换流式是唯一不改请求语义的自愈路径。回退失败时保留首查结果（空响应证据不丢），
 * 由探针按「证据不足」处理并在结论中说明。
 * 仅空响应触发；starved（finish=length）不走此路径，由 chatWithStarveRetry 升预算处理。
 */
export async function chatWithBlankFallback(
  ctx: ProbeCtx,
  input: {
    probe: ProbeId;
    label: string;
    request: ChatRequest;
    /** 流式回退使用的 max_tokens（通常为更高预算） */
    streamBudget: number;
    /** 工具探针：流式回退返回 tool_calls 也算可用结果（纯文本探针不采纳） */
    acceptToolCalls?: boolean;
  },
): Promise<BlankRetryCall> {
  const first = await ctx.client.chat(input.request);
  const firstEvidence = recordCall(ctx.evidence, {
    probe: input.probe,
    label: input.label,
    request: evidenceRequestOf(input.request),
    result: first,
  });
  if (ctx.cfg.streamFallback === false || !isBlankAnswer(first)) {
    return {
      result: first,
      evidenceId: firstEvidence.id,
      evidenceIds: [firstEvidence.id],
      blankRetried: false,
      streamFallback: false,
    };
  }
  const fallbackRequest: ChatRequest = {
    ...input.request,
    stream: true,
    max_tokens: input.streamBudget,
  };
  const fallback = await ctx.client.chat(fallbackRequest);
  const fallbackEvidence = recordCall(ctx.evidence, {
    probe: input.probe,
    label: `${input.label} (stream-retry@${input.streamBudget})`,
    request: evidenceRequestOf(fallbackRequest),
    result: fallback,
  });
  const recovered =
    fallback.ok &&
    (fallback.text.trim() !== '' ||
      (input.acceptToolCalls === true && fallback.toolCalls.length > 0));
  return {
    result: recovered ? fallback : first,
    evidenceId: recovered ? fallbackEvidence.id : firstEvidence.id,
    evidenceIds: [firstEvidence.id, fallbackEvidence.id],
    blankRetried: true,
    streamFallback: recovered,
  };
}

export interface StarveRetryCall {
  /** 最终采用的结果（首查成功或升预算重试的那次） */
  result: ChatResult;
  /** 全部证据 id（首查 + 可能的升预算重试 + 可能的流式回退，按调用顺序） */
  evidenceIds: string[];
  /** 最终结果是否仍处于推理占满预算状态 */
  starved: boolean;
  /** 是否触发了升预算重试 */
  retried: boolean;
  /** 是否因空响应触发了流式回退（含回退失败） */
  blankRetried: boolean;
  /** 流式回退是否成功产出可用结果 */
  streamFallback: boolean;
}

/**
 * 共享 starvation 重试 + 空响应恢复：首查 isStarved 时以 retryBudget 重发一次；
 * 每次尝试若返回 200 空正文，则按 chatWithBlankFallback 改用流式重发（可关闭）。
 * HTTP 错误（401/400/5xx/传输错误等）不在本层重试，由 client 按 --retries 统一处理——
 * 这里只处理「截断」与「空响应」两类需要改请求形态的场景。
 * 每次调用（含重试/回退）都 recordCall 进证据；attempts 保持客户端语义。
 */
export async function chatWithStarveRetry(
  ctx: ProbeCtx,
  input: {
    probe: ProbeId;
    label: string;
    buildRequest: (maxTokens: number) => ChatRequest;
    budget: number;
    retryBudget: number;
    acceptToolCalls?: boolean;
  },
): Promise<StarveRetryCall> {
  const first = await chatWithBlankFallback(ctx, {
    probe: input.probe,
    label: input.label,
    request: input.buildRequest(input.budget),
    streamBudget: input.retryBudget,
    acceptToolCalls: input.acceptToolCalls,
  });
  if (!isStarved(first.result)) {
    return {
      result: first.result,
      evidenceIds: first.evidenceIds,
      starved: false,
      retried: false,
      blankRetried: first.blankRetried,
      streamFallback: first.streamFallback,
    };
  }
  const retry = await chatWithBlankFallback(ctx, {
    probe: input.probe,
    label: `${input.label} (retry@${input.retryBudget})`,
    request: input.buildRequest(input.retryBudget),
    streamBudget: input.retryBudget,
    acceptToolCalls: input.acceptToolCalls,
  });
  return {
    result: retry.result,
    evidenceIds: [...first.evidenceIds, ...retry.evidenceIds],
    starved: isStarved(retry.result),
    retried: true,
    blankRetried: first.blankRetried || retry.blankRetried,
    streamFallback: first.streamFallback || retry.streamFallback,
  };
}

function evidenceRequestOf(req: ChatRequest): EvidenceInput['request'] {
  const messages: ChatMessage[] = req.messages;
  return {
    model: req.model,
    stream: req.stream === true,
    temperature: req.temperature ?? null,
    maxTokens: req.max_tokens ?? null,
    messages,
  };
}
