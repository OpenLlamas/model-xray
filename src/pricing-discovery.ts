// src/pricing-discovery.ts — 站点价格接口自动发现（多协议，不按站点/模型硬编码）。
//
// 同一个站点可能只开放其中一种接口：new-api /api/pricing、new-api /api/ratio_config、
// OpenRouter /api/v1/models、LiteLLM /model/info、公开价表 JSON。本模块按固定顺序探测这些
// 标准端点，用 schema 识别格式并归一化；用户也可传入同源自定义端点，由 schema 自动识别。
//
// 安全边界：只请求 deriveOrigin 推导出的同源地址；绝不携带 Authorization/Cookie；不跟随跨源
// 重定向；单次响应 512KB 硬限；每个端点只请求一次，不重试。
//
// 选择语义：
// - 未指定 model：返回第一个成功解析的端点（全表模式）。
// - 指定 model：优先返回包含该模型的端点；若所有成功端点都不含该模型，返回第一个成功解析的
//   端点（调用方据此如实报告「表可读但模型未收录」，而不是伪造价格）。

import {
  deriveOrigin,
  getJsonText,
  isPlausibleQuotaPerUnit,
  lookupDeclaredModel,
  normalizeModelName,
  PRICING_BODY_LIMIT_BYTES,
  usdPerMillionPerRatio,
  type DeclaredPricing,
  type QuotaPerUnitSource,
} from './pricing.js';
import { getWithSameOriginRedirect, type PublicPricingResult, type PublicUsdPrice } from './pricing-public.js';
import {
  detectPricingFormat,
  parseKnownPricingFormat,
  PRICING_FORMAT_LABELS,
  type ParsedPricingFormat,
  type PricingFormatId,
} from './pricing-formats.js';

/** 内置标准端点（协议约定，不是按站点名/域名分支）。候选越少越快，按覆盖面排序。 */
export const BUILTIN_PRICING_ENDPOINTS: readonly { path: string; format: PricingFormatId }[] = [
  { path: '/api/pricing', format: 'new-api-pricing' },
  { path: '/api/ratio_config', format: 'new-api-ratio-config' },
  { path: '/api/v1/models', format: 'openrouter-models' },
  { path: '/v1/model/info', format: 'litellm-model-info' },
  { path: '/model/info', format: 'litellm-model-info' },
  { path: '/public/model-prices', format: 'public-price-json' },
  { path: '/public/models', format: 'public-price-json' },
];

export type PricingProbeState =
  | 'ok'
  | 'not_found'
  | 'redirect'
  | 'auth_required'
  | 'http_error'
  | 'timeout'
  | 'too_large'
  | 'network'
  | 'schema_mismatch';

export interface PricingProbe {
  path: string;
  format: PricingFormatId | null;
  state: PricingProbeState;
  reason: string | null;
  /** 成功解析时的条目数；其余状态为 null。 */
  entries: number | null;
}

export interface PricingDiscoveryResult {
  /** ok = 至少一个端点解析成功；not_applicable = 没有可解析的价格接口；failed = 有接口但请求/读取失败。 */
  state: 'ok' | 'not_applicable' | 'failed';
  reason: string | null;
  origin: string | null;
  /** 成功端点对应的格式；失败时为 null。 */
  adapter: PricingFormatId | null;
  /** 成功端点路径（相对 origin）。 */
  path: string | null;
  pricing: DeclaredPricing | null;
  /** 归一化后的 USD/百万 tokens 价格（按模型 key）；没有可展示价时为空对象。 */
  prices: Record<string, PublicUsdPrice> | null;
  /** 有效 quota 换算率（CLI 优先于站点 /api/status）；公开价表无真实换算率时为 null。 */
  quotaPerUnit: number | null;
  quotaPerUnitSource: QuotaPerUnitSource;
  /** quotaPerUnit 未知时，prices/modelRatio 的 USD 换算是否使用了标准基价（仅展示，不写账本）。 */
  quotaPerUnitSynthetic: boolean;
  quotaPerUnitConflict: string | null;
  /** 每次端点探测的结果，供 CLI/报告解释「为什么拿不到」。 */
  probes: PricingProbe[];
}

export interface PricingDiscoveryOptions {
  /** 单次 GET 超时；每个候选端点独立计时，不重试。 */
  timeoutMs: number;
  /** 审计目标模型；提供时优先选择包含该模型的端点。 */
  model?: string | null;
  /** 用户声明的 $1 = N quota；优先于站点 /api/status。 */
  quotaPerUsd?: number | null;
  /** 用户指定的站点分组（仅用于展示/快照，不改变换算口径）。 */
  group?: string | null;
  /** 额外同源 JSON 端点（相对 origin 或同源绝对 URL）；先于内置端点探测，schema 自动识别。 */
  endpoints?: readonly string[];
}

interface EndpointSpec {
  /** 展示/探测记录用的路径（自定义绝对 URL 也归一成 pathname+search）。 */
  path: string;
  format: PricingFormatId | null;
  /** 自定义端点的绝对同源 URL；内置端点用 origin+path 拼接。 */
  url?: string;
}

interface Success {
  spec: EndpointSpec;
  table: ParsedPricingFormat;
  pricing: DeclaredPricing;
  quota: QuotaContext;
  /** prices/modelRatio 是否用标准基价做 USD 展示（无真实 quota 时为 true）。 */
  quotaPerUnitSynthetic: boolean;
}

interface QuotaContext {
  quotaPerUnit: number | null;
  quotaPerUnitSource: QuotaPerUnitSource;
  quotaPerUnitConflict: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function statusQuotaPerUnit(payload: unknown): number | null {
  if (!isRecord(payload)) return null;
  const data = payload['data'];
  if (!isRecord(data)) return null;
  const value = data['quota_per_unit'];
  return typeof value === 'number' && Number.isFinite(value) && isPlausibleQuotaPerUnit(value) ? value : null;
}

function resolveCustomEndpoint(origin: string, raw: string): EndpointSpec | null {
  const value = raw.trim();
  if (value === '') return null;
  let url: URL;
  try {
    if (/^https?:\/\//i.test(value)) {
      url = new URL(value);
    } else {
      url = new URL(`${origin}${value.startsWith('/') ? value : `/${value}`}`);
    }
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.origin !== new URL(origin).origin) return null;
  url.hash = '';
  return { path: `${url.pathname}${url.search}`, format: null, url: url.toString() };
}

function endpointUrl(origin: string, spec: EndpointSpec): URL | null {
  const raw = spec.url ?? spec.path;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      if (url.origin !== new URL(origin).origin) return null;
      url.username = '';
      url.password = '';
      url.hash = '';
      return url;
    } catch {
      return null;
    }
  }
  try {
    const url = new URL(`${origin}${raw.startsWith('/') ? raw : `/${raw}`}`);
    url.username = '';
    url.password = '';
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

function quotaContext(status: unknown, options: PricingDiscoveryOptions): QuotaContext {
  const siteQuota = statusQuotaPerUnit(status);
  const cliQuota =
    typeof options.quotaPerUsd === 'number' && isPlausibleQuotaPerUnit(options.quotaPerUsd)
      ? options.quotaPerUsd
      : null;
  let quotaPerUnit = siteQuota;
  let quotaPerUnitSource: QuotaPerUnitSource = siteQuota !== null ? 'site' : 'none';
  let quotaPerUnitConflict: string | null = null;
  if (cliQuota !== null) {
    if (siteQuota !== null && Math.abs(siteQuota - cliQuota) > Math.max(1e-9, Math.abs(siteQuota) * 1e-9)) {
      quotaPerUnitConflict = `--quota-per-usd ${cliQuota} 与站点 /api/status 的 quota_per_unit ${siteQuota} 不一致，按 CLI 值换算`;
    }
    quotaPerUnit = cliQuota;
    quotaPerUnitSource = 'cli';
  }
  return { quotaPerUnit, quotaPerUnitSource, quotaPerUnitConflict };
}

function buildSuccess(
  spec: EndpointSpec,
  table: ParsedPricingFormat,
  origin: string,
  quota: QuotaContext,
  groupRaw: string | null | undefined,
): Success {
  const group = typeof groupRaw === 'string' && groupRaw.trim() !== '' ? groupRaw.trim() : null;
  const pricing: DeclaredPricing = {
    origin,
    capturedAt: new Date().toISOString(),
    source: table.source,
    quotaPerUnit: quota.quotaPerUnit,
    quotaPerUnitSource: quota.quotaPerUnitSource,
    quotaPerUnitConflict: quota.quotaPerUnitConflict,
    models: table.models,
    groupRatio: table.groupRatio,
    group,
  };
  return {
    spec,
    table,
    pricing,
    quota: { ...quota },
    quotaPerUnitSynthetic: quota.quotaPerUnit === null,
  };
}

/** 目标模型是否在该成功表中：倍率表按归并规则查；免费模型可能只在 prices 里有原始价。 */
function tableContainsModel(success: Success, model: string): boolean {
  if (lookupDeclaredModel(success.pricing, model) !== null) return true;
  const target = normalizeModelName(model);
  return Object.keys(success.table.prices).some((key) => normalizeModelName(key) === target);
}

function summarizeFailure(probes: PricingProbe[]): string {
  const hard = probes.filter(
    (probe) =>
      probe.state === 'auth_required' ||
      probe.state === 'http_error' ||
      probe.state === 'timeout' ||
      probe.state === 'too_large' ||
      probe.state === 'network',
  );
  if (hard.length > 0) {
    return hard.map((probe) => `${probe.path}: ${probe.reason ?? probe.state}`).join('；');
  }
  const schema = probes.filter((probe) => probe.state === 'schema_mismatch');
  if (schema.length > 0) {
    return `已探测的接口均不符合已知价格 schema：${schema
      .map((probe) => `${probe.path}（${probe.reason ?? 'schema 不符'}）`)
      .join('；')}`;
  }
  return `未发现可解析的公开价格接口（已探测 ${probes.map((probe) => probe.path).join('、') || '无'}）`;
}

/**
 * 自动发现站点公示价格并归一化。
 * `endpoints` 中的自定义端点先探测；内置端点随后。每个端点只请求一次。
 */
export async function discoverPricing(
  baseUrl: string,
  options: PricingDiscoveryOptions,
): Promise<PricingDiscoveryResult> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    return {
      state: 'failed',
      reason: `timeoutMs 非法：${String(options.timeoutMs)}`,
      origin: null,
      adapter: null,
      path: null,
      pricing: null,
      prices: null,
      quotaPerUnit: null,
      quotaPerUnitSource: 'none',
      quotaPerUnitSynthetic: false,
      quotaPerUnitConflict: null,
      probes: [],
    };
  }
  if (options.quotaPerUsd != null && !isPlausibleQuotaPerUnit(options.quotaPerUsd)) {
    return {
      state: 'failed',
      reason: `quotaPerUsd 必须在 [1, 1e12] 内：${String(options.quotaPerUsd)}`,
      origin: null,
      adapter: null,
      path: null,
      pricing: null,
      prices: null,
      quotaPerUnit: null,
      quotaPerUnitSource: 'none',
      quotaPerUnitSynthetic: false,
      quotaPerUnitConflict: null,
      probes: [],
    };
  }

  let origin: string;
  try {
    origin = deriveOrigin(baseUrl);
  } catch {
    return {
      state: 'failed',
      reason: `baseUrl 无法解析为 URL：${baseUrl}`,
      origin: null,
      adapter: null,
      path: null,
      pricing: null,
      prices: null,
      quotaPerUnit: null,
      quotaPerUnitSource: 'none',
      quotaPerUnitSynthetic: false,
      quotaPerUnitConflict: null,
      probes: [],
    };
  }

  const probes: PricingProbe[] = [];
  const custom: EndpointSpec[] = [];
  for (const raw of options.endpoints ?? []) {
    const resolved = resolveCustomEndpoint(origin, raw);
    if (resolved === null) {
      probes.push({
        path: raw,
        format: null,
        state: 'schema_mismatch',
        reason: '自定义端点非法或跨源（只允许同源 http(s) 地址）',
        entries: null,
      });
      continue;
    }
    custom.push(resolved);
  }
  const specs: EndpointSpec[] = [...custom, ...BUILTIN_PRICING_ENDPOINTS];

  // /api/status 与价格探测并行；它只是 quota_per_unit 的 best-effort 来源，失败不影响价格解析。
  const statusPromise = getJsonText(`${origin}/api/status`, options.timeoutMs);
  let first: Success | null = null;

  for (const spec of specs) {
    const url = endpointUrl(origin, spec);
    if (url === null) {
      probes.push({ path: spec.path, format: spec.format, state: 'schema_mismatch', reason: '端点地址非法或跨源', entries: null });
      continue;
    }
    const raw = await getWithSameOriginRedirect(url, options.timeoutMs);
    if (raw.kind === 'not_found') {
      probes.push({ path: spec.path, format: spec.format, state: 'not_found', reason: 'HTTP 404', entries: null });
      continue;
    }
    if (raw.kind === 'redirect') {
      probes.push({
        path: spec.path,
        format: spec.format,
        state: 'redirect',
        reason:
          raw.location !== null
            ? `重定向 HTTP ${raw.status} → ${raw.location}（不跟随跨源/二次跳转）`
            : `重定向 HTTP ${raw.status}（无 Location，不跟随）`,
        entries: null,
      });
      continue;
    }
    if (raw.kind === 'http_error') {
      probes.push({
        path: spec.path,
        format: spec.format,
        state: raw.status === 401 || raw.status === 403 ? 'auth_required' : 'http_error',
        reason: `HTTP ${raw.status}`,
        entries: null,
      });
      continue;
    }
    if (raw.kind === 'timeout') {
      probes.push({ path: spec.path, format: spec.format, state: 'timeout', reason: '请求超时', entries: null });
      continue;
    }
    if (raw.kind === 'too_large') {
      probes.push({
        path: spec.path,
        format: spec.format,
        state: 'too_large',
        reason: `响应体 ${raw.bytes} 字节超过上限 ${PRICING_BODY_LIMIT_BYTES}`,
        entries: null,
      });
      continue;
    }
    if (raw.kind === 'network') {
      probes.push({
        path: spec.path,
        format: spec.format,
        state: 'network',
        reason: `网络错误：${raw.message}`,
        entries: null,
      });
      continue;
    }

    const payload = safeJson(raw.text);
    if (payload === null) {
      probes.push({
        path: spec.path,
        format: spec.format,
        state: 'schema_mismatch',
        reason: '响应不是合法 JSON',
        entries: null,
      });
      continue;
    }
    const statusPayload = await statusPromise.then((value) => (value.kind === 'ok' ? safeJson(value.text) : null));
    const quota = quotaContext(statusPayload, options);
    const ratioToUsdPerMillion = usdPerMillionPerRatio(quota.quotaPerUnit);
    const parsed =
      spec.format === null
        ? detectPricingFormat(payload, ratioToUsdPerMillion)
        : parseKnownPricingFormat(spec.format, payload, ratioToUsdPerMillion);
    if (!parsed.ok) {
      probes.push({
        path: spec.path,
        format: spec.format ?? parsed.format,
        state: 'schema_mismatch',
        reason: parsed.reason,
        entries: null,
      });
      continue;
    }

    const success = buildSuccess(spec, parsed.table, origin, quota, options.group);
    probes.push({
      path: spec.path,
      format: parsed.table.format,
      state: 'ok',
      reason: null,
      entries: parsed.table.entries,
    });

    if (options.model == null || options.model.trim() === '') {
      return successResult(success, probes);
    }
    if (tableContainsModel(success, options.model)) {
      return successResult(success, probes);
    }
    if (first === null) first = success;
  }

  const status = statusPromise.then((value) => (value.kind === 'ok' ? safeJson(value.text) : null));
  const finalQuota = quotaContext(await status, options);
  if (first !== null) {
    // 表可读但没有目标模型：保留首个成功表，quota 用最终结果补齐（真实值或 null）。
    const pricing: DeclaredPricing = {
      ...first.pricing,
      quotaPerUnit: finalQuota.quotaPerUnit,
      quotaPerUnitSource: finalQuota.quotaPerUnitSource,
      quotaPerUnitConflict: finalQuota.quotaPerUnitConflict,
    };
    first = {
      ...first,
      pricing,
      quota: { ...finalQuota },
      quotaPerUnitSynthetic: finalQuota.quotaPerUnit === null,
    };
    return successResult(first, probes);
  }

  const hard = probes.some(
    (probe) =>
      probe.state === 'auth_required' ||
      probe.state === 'http_error' ||
      probe.state === 'timeout' ||
      probe.state === 'too_large' ||
      probe.state === 'network',
  );
  return {
    state: hard ? 'failed' : 'not_applicable',
    reason: summarizeFailure(probes),
    origin,
    adapter: null,
    path: null,
    pricing: null,
    prices: null,
    quotaPerUnit: finalQuota.quotaPerUnit,
    quotaPerUnitSource: finalQuota.quotaPerUnitSource,
    quotaPerUnitSynthetic: false,
    quotaPerUnitConflict: finalQuota.quotaPerUnitConflict,
    probes,
  };
}

function successResult(success: Success, probes: PricingProbe[]): PricingDiscoveryResult {
  return {
    state: 'ok',
    reason: null,
    origin: success.pricing.origin,
    adapter: success.table.format,
    path: success.spec.path,
    pricing: success.pricing,
    prices: success.table.prices,
    quotaPerUnit: success.quota.quotaPerUnit,
    quotaPerUnitSource: success.quota.quotaPerUnitSource,
    quotaPerUnitSynthetic: success.quotaPerUnitSynthetic,
    quotaPerUnitConflict: success.quota.quotaPerUnitConflict,
    probes: [...probes],
  };
}

/** 人类可读的适配器名称（报告/CLI 用）。 */
export function pricingAdapterLabel(adapter: PricingFormatId | null): string {
  return adapter === null ? '未识别' : PRICING_FORMAT_LABELS[adapter];
}

/**
 * 把成功的公开价表发现结果转成既有 PublicPricingResult 形状，供 billing 继续复用原有
 * public_price_* 指标与列表价折扣逻辑。来源不是 public-json 时返回 null（API 系走 declared）。
 */
export function toPublicPricingResult(result: PricingDiscoveryResult): PublicPricingResult | null {
  if (result.state !== 'ok' || result.pricing === null || result.pricing.source !== 'public-json') return null;
  const okProbe = result.probes.find((probe) => probe.state === 'ok' && probe.path === result.path);
  const entries = okProbe?.entries ?? Object.keys(result.prices ?? {}).length;
  return {
    state: 'ok',
    reason: null,
    page: result.path,
    entries,
    pricing: result.pricing,
    prices: result.prices ?? {},
    skipped: 0,
    duplicates: 0,
    truncated: 0,
    unusable: 0,
  };
}
