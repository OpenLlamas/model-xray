// src/pricing-public.ts — 站点公开价表（/public/model-prices、/public/models）兜底锚点。
// 动机：非 new-api 站点没有 /api/pricing，但可能公开「USD / 百万 tokens」价目表；把它作为
// 模型级公示价锚，可在无余额端点时给出「公示价 vs 宣称价」与应缴上界。
//
// 安全与信任边界：只请求从 baseUrl 推导出的同源 origin；剥除 userinfo；绝不携带 Authorization /
// cookie；不跟随重定向；单次请求硬限 512KB；不重试。公开价表只作公示价锚，不参与余额 quota 换算；
// 写入价格账本时由 billing 覆盖为真实 quotaPerUnit 并打 source=public-json 标记。

import {
  deriveOrigin,
  getJsonText,
  PRICING_BODY_LIMIT_BYTES,
  USD_PER_MILLION_PER_RATIO,
  type DeclaredModelPricing,
  type DeclaredPricing,
  type RawGet,
} from './pricing.js';

/** 候选页：按顺序探测；仅 404 继续下一个，其余失败立即终止。 */
export const PUBLIC_PRICE_CANDIDATES = ['/public/model-prices', '/public/models'] as const;

/** 公开价表条目上限：与 /api/pricing 一致，超过按出现顺序截断并披露。 */
const MAX_PUBLIC_PRICE_ENTRIES = 2000;

/** 公开价表原始 USD 单价（每百万 tokens）。 */
export interface PublicUsdPrice {
  inputUsdPerM: number;
  outputUsdPerM: number;
  cachedUsdPerM: number | null;
  listInputUsdPerM: number | null;
  listOutputUsdPerM: number | null;
  listCachedUsdPerM: number | null;
}

export interface PublicPricingResult {
  /** ok = 至少一条可用价格；not_applicable = 两个候选均 404；failed = 有响应但读不到/解析不了。 */
  state: 'ok' | 'not_applicable' | 'failed';
  reason: string | null;
  /** 实际响应的候选页；两个都 404 时为 null。 */
  page: string | null;
  /** 通过基础 schema 校验的条目数（含输入价为 0、无法反推倍率的条目）。 */
  entries: number;
  pricing: DeclaredPricing | null;
  /** code → 原始 USD 单价；保留列表价与缓存价，供报告披露。 */
  prices: Record<string, PublicUsdPrice> | null;
  /** 缺 code / 价格字段非法 / 负价 / 输入输出同时为 0 的条目数。 */
  skipped: number;
  /** 重复 code（保留首次出现）的条目数。 */
  duplicates: number;
  /** 超过 2000 条被截断的条目数。 */
  truncated: number;
  /** 输入价为 0（无法反推 modelRatio）的条目数。 */
  unusable: number;
}

/** 公开价表解析后的归一化表格（不绑定具体页面/来源，供多协议适配层复用）。 */
export interface PublicPriceTable {
  models: Record<string, DeclaredModelPricing>;
  prices: Record<string, PublicUsdPrice>;
  entries: number;
  skipped: number;
  duplicates: number;
  truncated: number;
  unusable: number;
}

export type PublicPriceTableParse =
  | { ok: true; table: PublicPriceTable }
  | { ok: false; reason: string; skipped: number; truncated: number };

/** 仅接受十进制字面量：拒绝 1e999、+0.5、空串、0.24abc 等会被 Number() 宽松放过的输入。 */
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseUsd(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!DECIMAL_RE.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function optionalUsd(value: unknown): number | null {
  const parsed = parseUsd(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function failed(reason: string, page: string | null): PublicPricingResult {
  return {
    state: 'failed',
    reason,
    page,
    entries: 0,
    pricing: null,
    prices: null,
    skipped: 0,
    duplicates: 0,
    truncated: 0,
    unusable: 0,
  };
}

function classifyFailure(raw: Exclude<RawGet, { kind: 'ok' | 'not_found' }>, page: string): PublicPricingResult {
  switch (raw.kind) {
    case 'redirect':
      return failed(
        raw.location !== null
          ? `${page} 返回跨源或二次重定向（HTTP ${raw.status} → ${raw.location}），不跟随`
          : `${page} 返回重定向（HTTP ${raw.status}，无 Location），不跟随`,
        page,
      );
    case 'http_error':
      return failed(`${page} 返回 HTTP ${raw.status}`, page);
    case 'timeout':
      return failed(`${page} 请求超时`, page);
    case 'too_large':
      return failed(`${page} 响应体 ${raw.bytes} 字节超过上限 ${PRICING_BODY_LIMIT_BYTES}`, page);
    case 'network':
      return failed(`${page} 网络错误：${raw.message}`, page);
  }
}

/**
 * 同源跟随一次重定向（尾斜杠/规范化跳转很常见），跨源或二次跳转一律不跟随。
 * 只放宽「同一 origin 的 301/302/307/308」，不改变任何凭证/超时/大小边界。
 */
export async function getWithSameOriginRedirect(url: URL, timeoutMs: number): Promise<RawGet> {
  const raw = await getJsonText(url.toString(), timeoutMs);
  if (raw.kind !== 'redirect' || raw.location === null) return raw;
  let target: URL;
  try {
    target = new URL(raw.location, url);
  } catch {
    return raw;
  }
  if (target.origin !== url.origin) return raw;
  // origin 已含协议；显式限定 http(s) 并把协议不符也视为越界，避免未来放宽 origin 比较时退回 file/ftp。
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return raw;
  if (target.protocol !== url.protocol) return raw;
  // URL 内嵌 userinfo 一律不跟随：即使主机相同，也不接受把凭证写进探测请求。
  if (target.username !== '' || target.password !== '') return raw;
  target.username = '';
  target.password = '';
  const followed = await getJsonText(target.toString(), timeoutMs);
  if (followed.kind === 'redirect') return followed;
  return followed;
}

/**
 * 解析公开价表 JSON（items[] → 归一化倍率表 + 原始 USD 单价）。
 * 不绑定页面/来源，供 `/public/model-prices`、`/public/models` 及其他同 schema 的自定义端点复用。
 */
export function parsePublicPriceTable(
  payload: unknown,
  ratioToUsdPerMillion: number = USD_PER_MILLION_PER_RATIO,
): PublicPriceTableParse {
  if (!isRecord(payload)) return { ok: false, reason: '响应不是 JSON 对象', skipped: 0, truncated: 0 };
  const items = payload['items'];
  if (!Array.isArray(items)) return { ok: false, reason: '缺少 items 数组', skipped: 0, truncated: 0 };

  const truncated = Math.max(0, items.length - MAX_PUBLIC_PRICE_ENTRIES);
  const limited = items.slice(0, MAX_PUBLIC_PRICE_ENTRIES);
  const models: Record<string, DeclaredModelPricing> = {};
  const prices: Record<string, PublicUsdPrice> = {};
  let entries = 0;
  let skipped = 0;
  let duplicates = 0;
  let unusable = 0;

  for (const entry of limited) {
    if (!isRecord(entry)) {
      skipped += 1;
      continue;
    }
    const codeRaw = entry['code'];
    if (typeof codeRaw !== 'string' || codeRaw.trim() === '') {
      skipped += 1;
      continue;
    }
    const code = codeRaw.trim();
    const input = parseUsd(entry['price_input_usd']);
    const output = parseUsd(entry['price_output_usd']);
    if (input === null || output === null || input < 0 || output < 0 || (input === 0 && output === 0)) {
      skipped += 1;
      continue;
    }
    if (models[code] !== undefined || prices[code] !== undefined) {
      duplicates += 1;
      continue;
    }
    const cached = optionalUsd(entry['price_cached_usd']);
    const listInput = optionalUsd(entry['price_list_input_usd']);
    const listOutput = optionalUsd(entry['price_list_output_usd']);
    const listCached = optionalUsd(entry['price_list_cached_usd']);
    entries += 1;
    prices[code] = {
      inputUsdPerM: input,
      outputUsdPerM: output,
      cachedUsdPerM: cached,
      listInputUsdPerM: listInput,
      listOutputUsdPerM: listOutput,
      listCachedUsdPerM: listCached,
    };
    if (input === 0) {
      // 免费模型可展示但不能反推 modelRatio；跳过金额锚，避免 0 倍率被当成可用公示价。
      unusable += 1;
      continue;
    }
    models[code] = {
      modelName: code,
      modelRatio: input / ratioToUsdPerMillion,
      completionRatio: output / input,
      cacheRatio: cached !== null && cached > 0 ? cached / input : null,
      quotaType: 0,
      modelPrice: null,
      groups: [],
    };
  }

  if (entries === 0) {
    return { ok: false, reason: '条目为空或全部 schema 不符', skipped, truncated };
  }
  return { ok: true, table: { models, prices, entries, skipped, duplicates, truncated, unusable } };
}

function parsePublicPayload(payload: unknown, page: string, origin: string): PublicPricingResult {
  const parsed = parsePublicPriceTable(payload);
  if (!parsed.ok) {
    return {
      ...failed(`${page} ${parsed.reason}`, page),
      skipped: parsed.skipped,
      truncated: parsed.truncated,
    };
  }
  return {
    state: 'ok',
    reason: null,
    page,
    entries: parsed.table.entries,
    pricing: {
      origin,
      capturedAt: new Date().toISOString(),
      source: 'public-json',
      // 公开价表不公示 quota_per_unit：保持未知，绝不把标准基价当成站点值。
      quotaPerUnit: null,
      quotaPerUnitSource: 'none',
      quotaPerUnitConflict: null,
      models: parsed.table.models,
      groupRatio: {},
      group: null,
    },
    prices: parsed.table.prices,
    skipped: parsed.table.skipped,
    duplicates: parsed.table.duplicates,
    truncated: parsed.table.truncated,
    unusable: parsed.table.unusable,
  };
}

/**
 * 抓取站点公开价表：候选页按顺序探测，仅 404 继续；其余失败立即 failed 且不重试。
 * 成功解析至少一条 → state=ok；两个候选均 404 → not_applicable（能力边界）。
 */
export async function fetchPublicPricing(baseUrl: string, options: { timeoutMs: number }): Promise<PublicPricingResult> {
  let origin: string;
  try {
    origin = deriveOrigin(baseUrl);
  } catch {
    return failed(`baseUrl 无法解析为 URL：${baseUrl}`, null);
  }

  for (const candidate of PUBLIC_PRICE_CANDIDATES) {
    let url: URL;
    try {
      url = new URL(`${origin}${candidate}`);
      url.username = '';
      url.password = '';
    } catch {
      return failed(`公开价表地址无法解析：${origin}${candidate}`, candidate);
    }
    const raw = await getWithSameOriginRedirect(url, options.timeoutMs);
    if (raw.kind === 'not_found') continue;
    if (raw.kind !== 'ok') return classifyFailure(raw, candidate);
    let payload: unknown;
    try {
      payload = JSON.parse(raw.text);
    } catch {
      return failed(`${candidate} 响应不是合法 JSON`, candidate);
    }
    return parsePublicPayload(payload, candidate, origin);
  }

  return {
    state: 'not_applicable',
    reason: `站点未提供公开价格表（${PUBLIC_PRICE_CANDIDATES.join(' 与 ')} 均 404）`,
    page: null,
    entries: 0,
    pricing: null,
    prices: null,
    skipped: 0,
    duplicates: 0,
    truncated: 0,
    unusable: 0,
  };
}
