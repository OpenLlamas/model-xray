// src/gateway/pricing.ts — 渠道级按模型定价（计费选填：价格表默认为空，未录价渠道金额恒 NULL，禁止显示误导性的 $0）。
// 纯函数库：不 import 任何有状态模块；价格单位统一为 USD / 每百万 tokens（与前端录入口径一致），
// 金额计算不做任何舍入（账本落 SQLite REAL 原值，展示层再按量级格式化）。

/**
 * 单模型价格（USD / 每百万 tokens）：
 * - input/output 必填（0 = 免费模型合法）；cachedRead 可选（缓存读命中价，缺省 = 按 input 价，防重复计费口径下不虚增）；
 * - 阶梯档（可选）：prompt_tokens 严格大于 threshold 时，整单按二档价（input2/output2）计费；
 *   cachedRead2 缺省 = 按 input2 价。字段合法性由 channels.ts 的 validateModelPrices 统一把关。
 */
export interface ModelPrice {
  input: number;
  output: number;
  cachedRead?: number;
  threshold?: number;
  input2?: number;
  output2?: number;
  cachedRead2?: number;
}

/**
 * 计算单请求费用（USD 浮点原值，不舍入）；usage 与价目均假定已通过校验（validateUsage / validateModelPrices）。
 * 口径：
 * - 缓存命中部分按 cachedRate 计价（prompt_tokens 已含缓存命中，先扣除再按 input 价计剩余部分，防重复计费）；
 * - 阶梯为「整单切换」：prompt_tokens > threshold（严格大于）即全部输入/输出走二档价，不做分段混算；
 * - 输出（completion）无缓存概念，恒按 output 价。
 */
export function computeCostUsd(usage: { prompt_tokens: number; completion_tokens: number; cached_tokens?: number | null }, price: ModelPrice): number {
  const cached = usage.cached_tokens ?? 0;
  const tier2 = price.threshold !== undefined && usage.prompt_tokens > price.threshold;
  const inputRate = tier2 ? (price.input2 ?? price.input) : price.input;
  const outputRate = tier2 ? (price.output2 ?? price.output) : price.output;
  const cachedRate = tier2 ? (price.cachedRead2 ?? inputRate) : (price.cachedRead ?? price.input);
  // 防御：validateUsage 保证 cached ≤ prompt；此处再夹取非负，防未来调用方传入未校验 usage 产出负金额。
  const uncachedPrompt = Math.max(0, usage.prompt_tokens - cached);
  return (uncachedPrompt * inputRate + cached * cachedRate + usage.completion_tokens * outputRate) / 1e6;
}
