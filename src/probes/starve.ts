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
 * 各探针问答预算（max_tokens）与 starvation 重试升级预算，集中定义保证探针间一致、调整有据可查。
 * 实测来源：glm-5.3-flash（thinking 模型）真机审计（2026-10-10，中转站 llamas.nat100.top）：
 * - vision 16：reasoning 全部吃掉预算，content 恒空；实测需 >256，1024 可产出答案 → 基础 1024，重试升 2048；
 * - quality 64：同样被推理占满 → 基础 256，重试升 512；
 * - tool 次轮 64：同上 → 基础 256，重试升 512；
 * - identity 200：部分样本 starved → 基础 512（不重试：starved 仅按证据不足处理）。
 * billing/ttft 不需要答案正文，预算不改。
 */
export const PROBE_BUDGETS = {
  vision: 1024,
  visionRetry: 2048,
  quality: 256,
  qualityRetry: 512,
  toolSecond: 256,
  toolSecondRetry: 512,
  identity: 512,
} as const;

export interface StarveRetryCall {
  /** 最终采用的结果（首查成功或升预算重试的那次） */
  result: ChatResult;
  /** 全部证据 id（首查 + 可能的重试，按调用顺序） */
  evidenceIds: string[];
  /** 最终结果是否仍处于推理占满预算状态 */
  starved: boolean;
  /** 是否触发了升预算重试 */
  retried: boolean;
}

/**
 * 共享 starvation 重试：首查 isStarved 时以 retryBudget 重发一次；其余失败
 * （401/400/5xx/传输错误等）绝不重试——只有截断值得升预算，错误重发只会放大计费污染。
 * 每次调用（含重试）都 recordCall 进证据；attempts 保持客户端语义（每次独立请求的实试次数）。
 */
export async function chatWithStarveRetry(
  ctx: ProbeCtx,
  input: {
    probe: ProbeId;
    label: string;
    buildRequest: (maxTokens: number) => ChatRequest;
    budget: number;
    retryBudget: number;
  },
): Promise<StarveRetryCall> {
  const firstRequest = input.buildRequest(input.budget);
  const first = await ctx.client.chat(firstRequest);
  const firstEvidence = recordCall(ctx.evidence, {
    probe: input.probe,
    label: input.label,
    request: evidenceRequestOf(firstRequest),
    result: first,
  });
  if (!isStarved(first)) {
    return { result: first, evidenceIds: [firstEvidence.id], starved: false, retried: false };
  }
  const retryRequest = input.buildRequest(input.retryBudget);
  const retry = await ctx.client.chat(retryRequest);
  const retryEvidence = recordCall(ctx.evidence, {
    probe: input.probe,
    label: `${input.label} (retry@${input.retryBudget})`,
    request: evidenceRequestOf(retryRequest),
    result: retry,
  });
  return {
    result: retry,
    evidenceIds: [firstEvidence.id, retryEvidence.id],
    starved: isStarved(retry),
    retried: true,
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
