// src/pricing-formats.ts — 多站点价格格式归一化。
// 目标：不按站点名/模型名硬编码，按响应 schema 识别常见公开价格格式，统一转成
// DeclaredModelPricing（new-api 倍率口径）与 USD/百万 tokens；倍率↔USD 换算优先使用
// 站点真实 quota_per_unit，未知时才退回 new-api 标准基价（500000 quota/$ ⇒ ratio 1 = $2/M）。
//
// 支持的格式（按探测顺序）：
// - new-api / one-api `/api/pricing`：data[] + model_name/model_ratio/completion_ratio
// - new-api `/api/ratio_config`：data.model_ratio/completion_ratio/model_price 映射
// - OpenRouter `/api/v1/models`：data[].pricing.prompt/completion（USD/token）
// - LiteLLM `/v1/model/info` 或 `/model/info`：data[].model_info.input_cost_per_token 等
// - 公开价表 `/public/model-prices`、`/public/models`：items[].price_*_usd（USD/百万 tokens）
//
// 信任边界：解析失败/字段缺失一律跳过并计数，绝不猜价格；价格为 0 的模型不进倍率锚，
// 避免把免费模型当成 0 倍率。所有数值只接受有限数或明确的十进制/科学计数法字符串。

import {
  parsePricingPayload,
  USD_PER_MILLION_PER_RATIO,
  type DeclaredModelPricing,
  type PricingSource,
} from './pricing.js';
import { parsePublicPriceTable, type PublicPriceTable, type PublicUsdPrice } from './pricing-public.js';

/** 单格式最多保留的模型数：与 /api/pricing 的 2000 条上限同口径，防大站聚合页拖垮报告。 */
export const MAX_FORMAT_MODELS = 2000;

export type PricingFormatId =
  | 'new-api-pricing'
  | 'new-api-ratio-config'
  | 'openrouter-models'
  | 'litellm-model-info'
  | 'public-price-json';

export interface ParsedPricingFormat extends PublicPriceTable {
  format: PricingFormatId;
  source: PricingSource;
  groupRatio: Record<string, number>;
}

export type PricingFormatParse =
  | { ok: true; table: ParsedPricingFormat }
  | { ok: false; format: PricingFormatId | null; reason: string };

export const PRICING_FORMAT_LABELS: Readonly<Record<PricingFormatId, string>> = {
  'new-api-pricing': 'new-api /api/pricing',
  'new-api-ratio-config': 'new-api /api/ratio_config',
  'openrouter-models': 'OpenRouter /api/v1/models',
  'litellm-model-info': 'LiteLLM /model/info',
  'public-price-json': '公开价表 JSON',
};

const NUMERIC_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 接受有限 number 或严格数值字符串（含科学计数法）；拒绝空串、0x10、Infinity、NaN。 */
function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || !NUMERIC_RE.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegative(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function positive(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function parseRatioMap(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const result: Record<string, number> = {};
  for (const [name, raw] of Object.entries(value)) {
    const parsed = positive(raw);
    if (name.trim() !== '' && parsed !== null) result[name.trim()] = parsed;
  }
  return result;
}

/** new-api 倍率 → USD/百万 tokens（completion_ratio 是输出/输入倍数）。 */
function usdPricesFromModel(model: DeclaredModelPricing, ratioToUsdPerMillion: number): PublicUsdPrice | null {
  if (model.quotaType === 1 || !(model.modelRatio > 0)) return null;
  const inputUsdPerM = model.modelRatio * ratioToUsdPerMillion;
  if (!(inputUsdPerM > 0)) return null;
  const outputUsdPerM = inputUsdPerM * model.completionRatio;
  const cachedUsdPerM =
    model.cacheRatio !== null && model.cacheRatio > 0 ? inputUsdPerM * model.cacheRatio : null;
  return {
    inputUsdPerM,
    outputUsdPerM,
    cachedUsdPerM,
    listInputUsdPerM: null,
    listOutputUsdPerM: null,
    listCachedUsdPerM: null,
  };
}

function pricesFromModels(
  models: Record<string, DeclaredModelPricing>,
  ratioToUsdPerMillion: number,
): Record<string, PublicUsdPrice> {
  const prices: Record<string, PublicUsdPrice> = {};
  for (const [name, model] of Object.entries(models)) {
    const price = usdPricesFromModel(model, ratioToUsdPerMillion);
    if (price !== null) prices[name] = price;
  }
  return prices;
}

function fromModels(
  format: PricingFormatId,
  source: PricingSource,
  models: Record<string, DeclaredModelPricing>,
  groupRatio: Record<string, number> = {},
  counters: Partial<Pick<PublicPriceTable, 'skipped' | 'duplicates' | 'truncated' | 'unusable'>> = {},
  ratioToUsdPerMillion: number = USD_PER_MILLION_PER_RATIO,
  prices: Record<string, PublicUsdPrice> = pricesFromModels(models, ratioToUsdPerMillion),
  entries: number = Object.keys(models).length,
): PricingFormatParse {
  if (entries === 0) return { ok: false, format, reason: '没有可用价格条目' };
  return {
    ok: true,
    table: {
      format,
      source,
      models,
      groupRatio,
      prices,
      entries,
      skipped: counters.skipped ?? 0,
      duplicates: counters.duplicates ?? 0,
      truncated: counters.truncated ?? 0,
      unusable: counters.unusable ?? 0,
    },
  };
}

/** new-api / one-api `/api/pricing`：复用既有严格解析器，补上 USD/M 展示价。 */
export function parseNewApiPricingFormat(
  payload: unknown,
  ratioToUsdPerMillion: number = USD_PER_MILLION_PER_RATIO,
): PricingFormatParse {
  const parsed = parsePricingPayload(payload);
  if (!parsed.ok) return { ok: false, format: 'new-api-pricing', reason: parsed.reason };
  return fromModels(
    'new-api-pricing',
    'api',
    parsed.table.models,
    parsed.table.groupRatio,
    {},
    ratioToUsdPerMillion,
  );
}

/**
 * new-api `/api/ratio_config`：data 是映射表而不是数组。
 * 文档示例：{ success: true, data: { model_ratio: {model: ratio}, completion_ratio: {...}, model_price: {...} } }。
 * - model_price > 0 视为按次计费（quota_type=1），不做 token 金额换算；
 * - 缺 completion_ratio 时按 new-api 缺省值 1 处理（站点未单独配置输出倍率）；
 * - model_ratio=0 且无 model_price → 免费/未配置，跳过倍率锚。
 */
export function parseNewApiRatioConfigFormat(
  payload: unknown,
  ratioToUsdPerMillion: number = USD_PER_MILLION_PER_RATIO,
): PricingFormatParse {
  if (!isRecord(payload)) return { ok: false, format: 'new-api-ratio-config', reason: '响应不是 JSON 对象' };
  if (payload['success'] === false) {
    const message = typeof payload['message'] === 'string' ? payload['message'] : '站点返回 success=false';
    return { ok: false, format: 'new-api-ratio-config', reason: message };
  }
  const data = payload['data'];
  if (!isRecord(data)) {
    return { ok: false, format: 'new-api-ratio-config', reason: '缺少 data 对象（不是 ratio_config 格式）' };
  }
  const modelRatios = isRecord(data['model_ratio']) ? data['model_ratio'] : {};
  const completionRatios = isRecord(data['completion_ratio']) ? data['completion_ratio'] : {};
  const modelPrices = isRecord(data['model_price']) ? data['model_price'] : {};
  const cacheRatios = isRecord(data['cache_ratio']) ? data['cache_ratio'] : {};
  const names = new Set([
    ...Object.keys(modelRatios),
    ...Object.keys(modelPrices),
    ...Object.keys(completionRatios),
    ...Object.keys(cacheRatios),
  ]);
  if (names.size === 0) {
    return { ok: false, format: 'new-api-ratio-config', reason: 'data 中没有任何倍率映射' };
  }

  const allNames = [...names].filter((name) => name.trim() !== '');
  const truncated = Math.max(0, allNames.length - MAX_FORMAT_MODELS);
  const limited = allNames.slice(0, MAX_FORMAT_MODELS);
  const models: Record<string, DeclaredModelPricing> = {};
  let skipped = 0;
  let unusable = 0;

  for (const rawName of limited) {
    const name = rawName.trim();
    const ratio = finiteNumber(modelRatios[rawName]);
    const completion = finiteNumber(completionRatios[rawName]);
    const price = finiteNumber(modelPrices[rawName]);
    const cache = finiteNumber(cacheRatios[rawName]);
    if (price !== null && price > 0) {
      models[name] = {
        modelName: name,
        modelRatio: ratio !== null && ratio >= 0 ? ratio : 0,
        completionRatio: completion !== null && completion > 0 ? completion : 1,
        cacheRatio: cache !== null && cache > 0 ? cache : null,
        quotaType: 1,
        modelPrice: price,
        groups: [],
      };
      continue;
    }
    if (ratio !== null && ratio > 0) {
      models[name] = {
        modelName: name,
        modelRatio: ratio,
        completionRatio: completion !== null && completion > 0 ? completion : 1,
        cacheRatio: cache !== null && cache > 0 ? cache : null,
        quotaType: 0,
        modelPrice: null,
        groups: [],
      };
      continue;
    }
    if (ratio === 0 || price === 0) unusable += 1;
    else skipped += 1;
  }

  const groupRatio = parseRatioMap(data['group_ratio'] ?? payload['group_ratio']);
  return fromModels(
    'new-api-ratio-config',
    'api',
    models,
    groupRatio,
    { skipped, truncated, unusable },
    ratioToUsdPerMillion,
  );
}

/**
 * OpenRouter `/api/v1/models`：pricing.prompt/completion 是 USD/token 字符串。
 * 转 USD/M 后按 new-api 口径反推倍率；request 价单独保留为按次（quota_type=1）。
 */
export function parseOpenRouterFormat(
  payload: unknown,
  ratioToUsdPerMillion: number = USD_PER_MILLION_PER_RATIO,
): PricingFormatParse {
  if (!isRecord(payload)) return { ok: false, format: 'openrouter-models', reason: '响应不是 JSON 对象' };
  const data = payload['data'];
  if (!Array.isArray(data)) return { ok: false, format: 'openrouter-models', reason: '缺少 data 数组' };
  if (data.length > MAX_FORMAT_MODELS) {
    return { ok: false, format: 'openrouter-models', reason: `data 条目 ${data.length} 超过上限 ${MAX_FORMAT_MODELS}` };
  }

  const models: Record<string, DeclaredModelPricing> = {};
  const prices: Record<string, PublicUsdPrice> = {};
  let entries = 0;
  let skipped = 0;
  let duplicates = 0;
  let unusable = 0;

  for (const entry of data) {
    if (!isRecord(entry)) {
      skipped += 1;
      continue;
    }
    const id = typeof entry['id'] === 'string' ? entry['id'].trim() : '';
    if (id === '') {
      skipped += 1;
      continue;
    }
    if (models[id] !== undefined || prices[id] !== undefined) {
      duplicates += 1;
      continue;
    }
    const pricing = entry['pricing'];
    if (!isRecord(pricing)) {
      skipped += 1;
      continue;
    }
    const prompt = nonNegative(pricing['prompt']);
    const completion = nonNegative(pricing['completion']);
    const request = nonNegative(pricing['request']);
    if (prompt === null || completion === null) {
      if (request !== null && request > 0) {
        entries += 1;
        models[id] = {
          modelName: id,
          modelRatio: 0,
          completionRatio: 1,
          cacheRatio: null,
          quotaType: 1,
          modelPrice: request,
          groups: [],
        };
        continue;
      }
      skipped += 1;
      continue;
    }
    entries += 1;
    const inputUsdPerM = prompt * 1_000_000;
    const outputUsdPerM = completion * 1_000_000;
    const cachedPerToken = nonNegative(pricing['input_cache_read'] ?? pricing['inputCacheRead']);
    const cachedUsdPerM = cachedPerToken === null ? null : cachedPerToken * 1_000_000;
    prices[id] = {
      inputUsdPerM,
      outputUsdPerM,
      cachedUsdPerM,
      listInputUsdPerM: null,
      listOutputUsdPerM: null,
      listCachedUsdPerM: null,
    };
    // 输入或输出为 0（免费/仅一种 token）无法建立可靠的 token 倍率锚，只展示原始价。
    if (!(inputUsdPerM > 0) || !(outputUsdPerM > 0)) {
      unusable += 1;
      continue;
    }
    models[id] = {
      modelName: id,
      modelRatio: inputUsdPerM / ratioToUsdPerMillion,
      completionRatio: outputUsdPerM / inputUsdPerM,
      cacheRatio: cachedUsdPerM !== null && cachedUsdPerM > 0 ? cachedUsdPerM / inputUsdPerM : null,
      quotaType: 0,
      modelPrice: null,
      groups: [],
    };
  }

  return fromModels(
    'openrouter-models',
    'public-json',
    models,
    {},
    { skipped, duplicates, unusable },
    ratioToUsdPerMillion,
    prices,
    entries,
  ) satisfies PricingFormatParse;
}

/**
 * LiteLLM `/v1/model/info` / `/model/info`：模型价格在 model_info（或顶层）的
 * input_cost_per_token / output_cost_per_token（USD/token）。
 * 兼容少数部署直接返回 *_cost_per_million_tokens 的情况。
 */
export function parseLiteLlmFormat(
  payload: unknown,
  ratioToUsdPerMillion: number = USD_PER_MILLION_PER_RATIO,
): PricingFormatParse {
  if (!isRecord(payload)) return { ok: false, format: 'litellm-model-info', reason: '响应不是 JSON 对象' };
  const data = payload['data'];
  if (!Array.isArray(data)) return { ok: false, format: 'litellm-model-info', reason: '缺少 data 数组' };
  if (data.length > MAX_FORMAT_MODELS) {
    return { ok: false, format: 'litellm-model-info', reason: `data 条目 ${data.length} 超过上限 ${MAX_FORMAT_MODELS}` };
  }

  const models: Record<string, DeclaredModelPricing> = {};
  const prices: Record<string, PublicUsdPrice> = {};
  let entries = 0;
  let skipped = 0;
  let duplicates = 0;
  let unusable = 0;

  for (const entry of data) {
    if (!isRecord(entry)) {
      skipped += 1;
      continue;
    }
    const modelInfo = isRecord(entry['model_info']) ? entry['model_info'] : null;
    const nameRaw =
      (typeof entry['model_name'] === 'string' && entry['model_name'].trim() !== ''
        ? entry['model_name']
        : null) ??
      (modelInfo !== null && typeof modelInfo['key'] === 'string' ? modelInfo['key'] : null);
    const name = typeof nameRaw === 'string' ? nameRaw.trim() : '';
    if (name === '') {
      skipped += 1;
      continue;
    }
    if (models[name] !== undefined || prices[name] !== undefined) {
      duplicates += 1;
      continue;
    }
    const litellmParams = isRecord(entry['litellm_params']) ? entry['litellm_params'] : null;
    const nestedInfo = litellmParams !== null && isRecord(litellmParams['model_info']) ? litellmParams['model_info'] : null;
    const costSources = [modelInfo, nestedInfo, entry, litellmParams].filter(
      (value): value is Record<string, unknown> => value !== null,
    );
    const pick = (keys: string[]): number | null => {
      for (const source of costSources) {
        for (const key of keys) {
          const parsed = nonNegative(source[key]);
          if (parsed !== null) return parsed;
        }
      }
      return null;
    };
    const inputPerToken = pick(['input_cost_per_token']);
    const outputPerToken = pick(['output_cost_per_token']);
    const inputPerM = pick(['input_cost_per_million_tokens', 'input_cost_per_1m_tokens']);
    const outputPerM = pick(['output_cost_per_million_tokens', 'output_cost_per_1m_tokens']);
    const inputUsdPerM = inputPerM ?? (inputPerToken !== null ? inputPerToken * 1_000_000 : null);
    const outputUsdPerM = outputPerM ?? (outputPerToken !== null ? outputPerToken * 1_000_000 : null);
    if (inputUsdPerM === null || outputUsdPerM === null) {
      skipped += 1;
      continue;
    }
    entries += 1;
    const cachedUsdPerM = (() => {
      const cached = pick([
        'input_cost_per_token_cache_read',
        'cache_read_input_token_cost',
        'input_cost_per_token_cache_hit',
      ]);
      return cached === null ? null : cached * 1_000_000;
    })();
    prices[name] = {
      inputUsdPerM,
      outputUsdPerM,
      cachedUsdPerM,
      listInputUsdPerM: null,
      listOutputUsdPerM: null,
      listCachedUsdPerM: null,
    };
    if (!(inputUsdPerM > 0) || !(outputUsdPerM > 0)) {
      unusable += 1;
      continue;
    }
    models[name] = {
      modelName: name,
      modelRatio: inputUsdPerM / ratioToUsdPerMillion,
      completionRatio: outputUsdPerM / inputUsdPerM,
      cacheRatio: cachedUsdPerM !== null && cachedUsdPerM > 0 ? cachedUsdPerM / inputUsdPerM : null,
      quotaType: 0,
      modelPrice: null,
      groups: [],
    };
  }

  return fromModels(
    'litellm-model-info',
    'public-json',
    models,
    {},
    { skipped, duplicates, unusable },
    ratioToUsdPerMillion,
    prices,
    entries,
  ) satisfies PricingFormatParse;
}

/** 公开价表 JSON（items[]，USD/百万 tokens）：复用 pricing-public 的严格解析。 */
export function parsePublicPriceJsonFormat(
  payload: unknown,
  ratioToUsdPerMillion: number = USD_PER_MILLION_PER_RATIO,
): PricingFormatParse {
  const parsed = parsePublicPriceTable(payload, ratioToUsdPerMillion);
  if (!parsed.ok) return { ok: false, format: 'public-price-json', reason: parsed.reason };
  return {
    ok: true,
    table: {
      format: 'public-price-json',
      source: 'public-json',
      models: parsed.table.models,
      groupRatio: {},
      prices: parsed.table.prices,
      entries: parsed.table.entries,
      skipped: parsed.table.skipped,
      duplicates: parsed.table.duplicates,
      truncated: parsed.table.truncated,
      unusable: parsed.table.unusable,
    },
  };
}

/** 明确知道端点格式时只跑对应解析器；格式不符立即失败，避免把别的 schema 误认成价格表。 */
export function parseKnownPricingFormat(
  format: PricingFormatId,
  payload: unknown,
  ratioToUsdPerMillion: number = USD_PER_MILLION_PER_RATIO,
): PricingFormatParse {
  switch (format) {
    case 'new-api-pricing':
      return parseNewApiPricingFormat(payload, ratioToUsdPerMillion);
    case 'new-api-ratio-config':
      return parseNewApiRatioConfigFormat(payload, ratioToUsdPerMillion);
    case 'openrouter-models':
      return parseOpenRouterFormat(payload, ratioToUsdPerMillion);
    case 'litellm-model-info':
      return parseLiteLlmFormat(payload, ratioToUsdPerMillion);
    case 'public-price-json':
      return parsePublicPriceJsonFormat(payload, ratioToUsdPerMillion);
  }
}

/** 自定义端点：按 schema 自动识别（顺序固定，绝不按站点名/域名分支）。 */
export function detectPricingFormat(
  payload: unknown,
  ratioToUsdPerMillion: number = USD_PER_MILLION_PER_RATIO,
): PricingFormatParse {
  const parsers: Array<() => PricingFormatParse> = [
    () => parseNewApiPricingFormat(payload, ratioToUsdPerMillion),
    () => parseNewApiRatioConfigFormat(payload, ratioToUsdPerMillion),
    () => parseOpenRouterFormat(payload, ratioToUsdPerMillion),
    () => parseLiteLlmFormat(payload, ratioToUsdPerMillion),
    () => parsePublicPriceJsonFormat(payload, ratioToUsdPerMillion),
  ];
  let firstReason: string | null = null;
  for (const parse of parsers) {
    const result = parse();
    if (result.ok) return result;
    firstReason ??= result.reason;
  }
  return {
    ok: false,
    format: null,
    reason: `未识别为已知价格格式（new-api / ratio_config / OpenRouter / LiteLLM / 公开价表 JSON）：${firstReason ?? 'schema 不符'}`,
  };
}
