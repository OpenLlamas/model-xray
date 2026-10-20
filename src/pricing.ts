// src/pricing.ts — 站点公示倍率快照（new-api / one-api 的 /api/pricing 与 /api/status）。
// 审计动机：余额 Δ 只能证明「扣了多少钱」，不能说明「按什么倍率扣」；站点把倍率偷偷上调时，
// 只要 token 计数与线性关系正常，纯形状核验仍会通过。这里读取站点自己公示的 model_ratio /
// completion_ratio，与用户宣称价、模型回显、历史快照三方交叉，给金额侧一个可复核的参照。
//
// 安全边界：只请求从 baseUrl 推导出的同源 origin；绝不携带 Authorization / API key；不跟随重定向
// （防止探测流量被导向第三方）；响应体硬限 512KB；超时由 AbortController 控制。

/** 公示价条目数上限：超过视为非预期 schema（大站聚合页可能有数千条，审计不为此拖垮报告）。 */
const MAX_DECLARED_MODELS = 2000;
/** 响应体上限：公示价 JSON 正常为几十 KB 量级，512KB 已足够覆盖大站且防止内存打爆。 */
export const PRICING_BODY_LIMIT_BYTES = 512 * 1024;
/** new-api 的倍率基价：model_ratio=1 对应 $0.002 / 1K tokens = $2 / 百万 tokens。 */
export const USD_PER_MILLION_PER_RATIO = 2;

/** 公示价来源：api=/api/pricing；public-json=/public/model-prices 等公开 JSON；scrape=网页抓价；manual=人工。 */
export type PricingSource = 'api' | 'public-json' | 'scrape' | 'manual';
export const PRICING_SOURCES: readonly PricingSource[] = ['api', 'public-json', 'scrape', 'manual'];
/**
 * quota_per_unit（$1 = N quota 换算系数）的来源：
 * - site：站点 /api/status 公示；
 * - cli：--quota-per-usd 覆盖（用户断言，不是站点公示）；
 * - none：未公示或合成值（公开价表用合成系数只为内部 USD 换算）。
 * 漂移比对据此区分「站点改了换算系数」（实收金额随之变化，属漂移证据）与
 * 「用户换了 CLI 覆盖值 / 旧条目无来源」（口径变化，只披露不判站点漂移）。
 */
export type QuotaPerUnitSource = 'site' | 'cli' | 'none';
/**
 * quota_per_unit（$1 = N quota）的有效域：下限 1（低于 1 意味着 1 quota 价值超过 1 美元，不成立）、
 * 上限 1e12（超出即荒谬量级，多半不是换算系数）。
 * 全工具（余额换算、公示价快照、--quota-per-usd 覆盖、控制台表单）共用这一条域：
 * 同一个数字在不同路径上一处采信、一处作废，会让「同一份数据两种结论」，比作废更难解释。
 */
export const QUOTA_PER_UNIT_MIN = 1;
export const QUOTA_PER_UNIT_MAX = 1e12;

/** quota_per_unit 是否落在有效域内（有限、≥1、≤1e12）。 */
export function isPlausibleQuotaPerUnit(value: number | null | undefined): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= QUOTA_PER_UNIT_MIN &&
    value <= QUOTA_PER_UNIT_MAX
  );
}
/** 视为「版本尾缀」的路径段：出现在路径末尾时属于 API 版本而非站点前缀，需剥掉后再拼余额/公示价路由。 */
const ORIGIN_STRIP_SEGMENTS = new Set(['v1', 'v1beta', 'v1alpha', 'openai', 'api', 'compatible-mode']);
/** 模型名尾部的版本/快照标记（-latest、-v1、-2024-08-06、-0613、-2508 等），名称归并时逐层剥掉。 */
const VERSION_SUFFIX = /-(?:latest|v\d+(?:\.\d+)*|\d{4}-\d{2}-\d{2}|\d{6}|\d{4})$/i;

export interface DeclaredModelPricing {
  modelName: string;
  /** new-api 输入倍率（1 = $2/百万 tokens）；quota_type=1（按次计费）时允许为 0。 */
  modelRatio: number;
  /** 输出/输入倍率。 */
  completionRatio: number;
  /** 缓存读取倍率（new-api cache_ratio）；null = 站点未公示，缓存部分按输入价计（上界口径）。 */
  cacheRatio: number | null;
  /** new-api quota_type：0/缺省 = 按 token；1 = 按次（本工具不解释 model_price，仅保留字段）。 */
  quotaType: number | null;
  /** 按次计费单价（原始字段，不做单位假设）。 */
  modelPrice: number | null;
  /** 该模型允许的分组（enable_groups）；仅用于展示，不参与换算。 */
  groups: string[];
}

export interface DeclaredPricing {
  origin: string;
  capturedAt: string;
  /** 快照来源；旧快照/测试夹具可缺省（缺省表示来源未知，不冒充 api）。 */
  source?: PricingSource;
  /** 有效换算率（$1 = N quota）；CLI --quota-per-usd 优先于 /api/status。null = 站点未公示且用户未提供。 */
  quotaPerUnit: number | null;
  /** quotaPerUnit 的来源（site/cli/none）；缺省视为来源未知（旧快照/夹具）。 */
  quotaPerUnitSource?: QuotaPerUnitSource;
  /** CLI 与站点值冲突时的说明（按 CLI 值换算）；无冲突为 null。 */
  quotaPerUnitConflict: string | null;
  models: Record<string, DeclaredModelPricing>;
  groupRatio: Record<string, number>;
  /** 用户指定的分组（仅用于挑选展示的 group_ratio）。 */
  group: string | null;
}

export interface PricingFetchOptions {
  /** 单次 GET 的超时（与聊天请求共享同一档位；公示价接口不重试）。 */
  timeoutMs: number;
  /** 用户声明的 $1 = N quota；优先于 /api/status。 */
  quotaPerUsd?: number | null;
  /** 用户指定的站点分组（仅用于挑选展示的 group_ratio，不改变换算口径）。 */
  group?: string | null;
}

export interface PricingFetchResult {
  /** ok = 成功解析公示价；not_applicable = 站点没有该接口或 schema 不符；failed = 有接口但拿不到。 */
  state: 'ok' | 'not_applicable' | 'failed';
  /** 推导出的站点 origin（baseUrl 非法时为 null），供报告与余额路径复用。 */
  origin: string | null;
  pricing: DeclaredPricing | null;
  /** 即使 pricing 不可用，/api/status 的 quota_per_unit 或 CLI 值仍可用于余额 quota 换算。 */
  quotaPerUnit: number | null;
  /** 状态原因（not_applicable/failed 时必填；ok 时为 null）。 */
  reason: string | null;
}

export interface ParsedPricingTable {
  models: Record<string, DeclaredModelPricing>;
  groupRatio: Record<string, number>;
}

export type PricingPayloadParse =
  | { ok: true; table: ParsedPricingTable }
  | { ok: false; reason: string };

export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  /** 计入总量的样本数。 */
  samples: number;
  /** 因缺 usage / usage 被拒而剔除的样本数：>0 时估算只能视为下界。 */
  droppedSamples: number;
}

export interface DeclaredCostEstimate {
  /** 公示倍率换算出的应缴 quota 总量。 */
  quota: number;
  /** 按有效 quota_per_unit 折算的美元；缺换算率时为 null。 */
  usd: number | null;
  /** 公示口径的输入单价（USD / 百万 tokens），用于与用户宣称价对照。 */
  inputUsdPerM: number;
  /** 公示口径的输出单价（USD / 百万 tokens）。 */
  outputUsdPerM: number;
  /** 缓存未折扣：结果可能高于实际扣费（上界），报告必须标注。 */
  isUpperBound: boolean;
  /** 有样本缺 usage：结果可能低于实际扣费（下界）。 */
  isLowerBound: boolean;
  /** priced = 金额按公示倍率算出；unverified = 只能确认计费形态，金额侧不可用。 */
  state: 'priced' | 'unverified';
  /** unverified 的原因（state=priced 时为 null）。 */
  unverifiedReason: string | null;
  /** 请求的分组倍率未能从公示表核验：金额按分组倍率 1 参照，不能作为实收依据。 */
  groupRatioUnverified: boolean;
  /** 与 quota 相同的显式别名（quota_type=1 等 unverified 情形下金额侧整体作废）。 */
  expectedQuota: number;
}

/** 分组评估选项：省略 = 旧口径（只按模型倍率换算，不评估 group_ratio）。 */
export interface ExpectedCostOptions {
  /** 站点分组（billing 传 declared.group ?? cfg.group）；null = 无分组可评估。 */
  group?: string | null;
}

/**
 * 从 baseUrl 推导站点 origin（保留反向代理前缀，剥掉末尾 API 版本段）：
 *   https://host/v1        → https://host
 *   https://host/v1beta    → https://host
 *   https://host/foo/v1    → https://host/foo   （反代挂在子路径时保留 /foo）
 *   https://host/openai/v1 → https://host
 * 余额接口与 /api/pricing 都位于站点根路径；直接拼在带 /v1 的 baseUrl 后是既有真实故障点。
 */
export function deriveOrigin(baseUrl: string): string {
  const url = new URL(baseUrl);
  const parts = url.pathname.split('/').filter((part) => part !== '');
  while (parts.length > 0 && ORIGIN_STRIP_SEGMENTS.has((parts[parts.length - 1] ?? '').toLowerCase())) {
    parts.pop();
  }
  url.pathname = parts.length > 0 ? `/${parts.join('/')}` : '/';
  url.search = '';
  url.hash = '';
  return parts.length > 0 ? `${url.origin}/${parts.join('/')}` : url.origin;
}

/** 名称归一：小写 + 去空白（站点/用户对大小写与空格的处理不一致）。 */
export function normalizeModelName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '');
}

/** 逐层剥掉版本/快照尾缀（-latest、-v1、-2024-08-06、-0613、-2508…）。 */
function stripVersionSuffix(name: string): string {
  let current = name;
  for (;;) {
    const match = current.match(VERSION_SUFFIX);
    if (match === null) return current;
    current = current.slice(0, -match[0].length);
  }
}

export interface DeclaredRatioEntry {
  modelRatio: number;
  completionRatio: number;
}

/**
 * 在公示价表中按名称找模型：精确 → 归一后精确 → 剥版本尾缀后精确 → 带边界的版本化前缀（取最长命中）。
 * 返回站点原始 key（报告里可复核）与条目本体。
 */
export function lookupDeclaredModel<T extends DeclaredRatioEntry>(
  declared: { models: Record<string, T> },
  name: string,
): { key: string; model: T } | null {
  const raw = name.trim();
  const exact = declared.models[raw];
  if (exact !== undefined) return { key: raw, model: exact };

  const entries = Object.entries(declared.models);
  const target = normalizeModelName(raw);
  for (const [key, model] of entries) {
    if (normalizeModelName(key) === target) return { key, model };
  }

  const targetBase = stripVersionSuffix(target);
  let best: { key: string; model: T } | null = null;
  let bestLength = -1;
  for (const [key, model] of entries) {
    const keyBase = stripVersionSuffix(normalizeModelName(key));
    if (keyBase === targetBase) return { key, model };
    // 前缀命中要求余下部分本身是「-版本尾缀」，否则 gpt-4o 会把 gpt-4o-mini 误配成同价。
    const remainder = targetBase.slice(keyBase.length);
    if (targetBase.startsWith(keyBase) && VERSION_SUFFIX.test(remainder) && keyBase.length > bestLength) {
      best = { key, model };
      bestLength = keyBase.length;
    }
  }
  return best;
}

/** 模型族系（首个字母段）：用于回显错配的粗分类，不参与 identity 维度判定。 */
export function modelFamily(name: string): string | null {
  const match = name.trim().toLowerCase().match(/^[a-z]+/);
  return match?.[0] ?? null;
}

/**
 * 按公示倍率估算应缴额度：quota = group_ratio × (modelRatio×prompt + modelRatio×completionRatio×completion)。
 * 缓存未折扣 → isUpperBound；缺 usage 样本被剔除 → isLowerBound；两者都不代表精确对账。
 * quota_type=1（按次计费）时 token→quota 换算不成立 → state=unverified，金额侧整体作废；
 * options 省略时保持旧口径（不评估分组倍率），提供但分组倍率缺失时按倍率 1 参照并显式标记未核验。
 */
export function expectedCostFromDeclared(
  declared: Pick<DeclaredPricing, 'quotaPerUnit'> & Partial<Pick<DeclaredPricing, 'group' | 'groupRatio'>>,
  model: DeclaredModelPricing,
  totals: UsageTotals,
  options?: ExpectedCostOptions,
): DeclaredCostEstimate {
  const inputUsdPerM = model.modelRatio * USD_PER_MILLION_PER_RATIO;
  const outputUsdPerM = inputUsdPerM * model.completionRatio;
  if (model.quotaType === 1) {
    return {
      quota: 0,
      usd: null,
      inputUsdPerM,
      outputUsdPerM,
      isUpperBound: false,
      isLowerBound: false,
      state: 'unverified',
      unverifiedReason: '按次计费（quota_type=1），单价单位未核验',
      groupRatioUnverified: false,
      expectedQuota: 0,
    };
  }
  const effectiveGroup = options === undefined ? null : (declared.group ?? options.group ?? null);
  const groupRatio = effectiveGroup !== null ? (declared.groupRatio?.[effectiveGroup] ?? null) : null;
  // 只有「存在分组口径但公示表没有该分组倍率」才算未核验；无分组时倍率 1 本身就是精确口径。
  const groupRatioUnverified = options !== undefined && effectiveGroup !== null && groupRatio === null;
  const multiplier = groupRatio ?? 1;
  const quota =
    multiplier *
    (model.modelRatio * totals.promptTokens + model.modelRatio * model.completionRatio * totals.completionTokens);
  const usd = declared.quotaPerUnit !== null && declared.quotaPerUnit > 0 ? quota / declared.quotaPerUnit : null;
  return {
    quota,
    usd,
    inputUsdPerM,
    outputUsdPerM,
    isUpperBound: !groupRatioUnverified,
    isLowerBound: !groupRatioUnverified && totals.droppedSamples > 0,
    state: 'priced',
    unverifiedReason: null,
    groupRatioUnverified,
    expectedQuota: quota,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function finitePositive(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function parseGroupRatio(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const result: Record<string, number> = {};
  for (const [group, ratio] of Object.entries(value)) {
    const parsed = finitePositive(ratio);
    if (parsed !== null) result[group] = parsed;
  }
  return result;
}

function parseModelEntry(entry: unknown): DeclaredModelPricing | null {
  if (!isRecord(entry)) return null;
  const modelName = entry['model_name'];
  if (typeof modelName !== 'string' || modelName.trim() === '') return null;
  const quotaType = finiteNumber(entry['quota_type']);
  const modelRatio = finiteNumber(entry['model_ratio']);
  const completionRatio = finiteNumber(entry['completion_ratio']);
  if (modelRatio === null || completionRatio === null) return null;
  // completion_ratio 为 0 会让输出免费（价格异常）；quota_type=1（按次）才允许 model_ratio=0。
  if (!(completionRatio > 0)) return null;
  if (quotaType === 1) {
    if (modelRatio < 0) return null;
  } else if (!(modelRatio > 0)) {
    return null;
  }
  const groups =
    Array.isArray(entry['enable_groups']) ? entry['enable_groups'].filter((g): g is string => typeof g === 'string') : [];
  return {
    modelName: modelName.trim(),
    modelRatio,
    completionRatio,
    cacheRatio: finiteNumber(entry['cache_ratio']),
    quotaType,
    modelPrice: finiteNumber(entry['model_price']),
    groups,
  };
}

/**
 * 解析 /api/pricing 响应体。schema 不符返回 not_applicable（站点可能不是 new-api 系），
 * 与「接口存在但请求失败」严格区分：前者是能力边界，后者才是异常。
 */
export function parsePricingPayload(payload: unknown): PricingPayloadParse {
  if (!isRecord(payload)) return { ok: false, reason: '响应不是 JSON 对象' };
  const data = payload['data'];
  if (!Array.isArray(data)) return { ok: false, reason: '缺少 data 数组（不是 new-api 公示价格式）' };
  if (data.length > MAX_DECLARED_MODELS) {
    return { ok: false, reason: `data 条目 ${data.length} 超过上限 ${MAX_DECLARED_MODELS}` };
  }
  if (data.length === 0) return { ok: false, reason: 'data 为空（站点未公示任何模型）' };

  const models: Record<string, DeclaredModelPricing> = {};
  let valid = 0;
  for (const entry of data) {
    const model = parseModelEntry(entry);
    if (model === null) continue;
    valid += 1;
    // 同名条目保留第一条：站点重复公示时以首次出现为准，避免后写覆盖造成漂移假象。
    if (models[model.modelName] === undefined) models[model.modelName] = model;
  }
  if (valid === 0) return { ok: false, reason: '全部条目 schema 不符（缺 model_name/model_ratio/completion_ratio）' };
  return { ok: true, table: { models, groupRatio: parseGroupRatio(payload['group_ratio']) } };
}

export type RawGet =
  | { kind: 'ok'; text: string }
  | { kind: 'not_found' }
  | { kind: 'redirect'; status: number; location: string | null }
  | { kind: 'http_error'; status: number }
  | { kind: 'timeout' }
  | { kind: 'too_large'; bytes: number }
  | { kind: 'network'; message: string };

class BodyTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`响应体 ${bytes} 字节超过上限 ${PRICING_BODY_LIMIT_BYTES}`);
    this.name = 'BodyTooLargeError';
  }
}

export async function readLimitedBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > PRICING_BODY_LIMIT_BYTES) {
    throw new BodyTooLargeError(declaredLength);
  }
  const body = response.body;
  if (body === null) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > PRICING_BODY_LIMIT_BYTES) {
      await reader.cancel();
      throw new BodyTooLargeError(total);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 同源 GET（不带任何凭证、不跟随重定向）。所有失败都折叠成可判定的分类，不抛异常。 */
export async function getJsonText(url: string, timeoutMs: number): Promise<RawGet> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      return { kind: 'redirect', status: response.status, location: response.headers.get('location') };
    }
    if (response.status === 404) return { kind: 'not_found' };
    if (!response.ok) return { kind: 'http_error', status: response.status };
    return { kind: 'ok', text: await readLimitedBody(response) };
  } catch (error) {
    if (controller.signal.aborted) return { kind: 'timeout' };
    if (error instanceof BodyTooLargeError) return { kind: 'too_large', bytes: error.bytes };
    const message = error instanceof Error ? error.message : String(error);
    return { kind: 'network', message };
  } finally {
    clearTimeout(timer);
  }
}

function statusQuotaPerUnit(payload: unknown): number | null {
  if (!isRecord(payload)) return null;
  const data = payload['data'];
  if (!isRecord(data)) return null;
  // 与余额换算共用同一有效域（见 isPlausibleQuotaPerUnit）：同一字段两处口径必须一致。
  const value = finitePositive(data['quota_per_unit']);
  return isPlausibleQuotaPerUnit(value) ? value : null;
}

/**
 * 抓取站点公示倍率与 quota 换算率。两个端点都同源、免鉴权、不重试：
 * - /api/pricing 决定 pricing.state（404/非 JSON/schema 不符 → not_applicable；超时/网络/401/403/5xx → failed）；
 * - /api/status 只补 quota_per_unit（best-effort，失败不影响 pricing 判定）。
 * 绝不发送 apiKey：公示接口不需要凭证，发送只会扩大泄露面。
 */
export async function fetchDeclaredPricing(
  baseUrl: string,
  options: PricingFetchOptions,
): Promise<PricingFetchResult> {
  let origin: string;
  try {
    origin = deriveOrigin(baseUrl);
  } catch {
    return {
      state: 'failed',
      origin: null,
      pricing: null,
      quotaPerUnit: finitePositive(options.quotaPerUsd),
      reason: `baseUrl 无法解析为 URL：${baseUrl}`,
    };
  }

  // 两个端点互不依赖（同源、免鉴权、不重试），并发发起省掉一次串行 RTT；
  // /api/status 只是 best-effort 补充，并发不影响 /api/pricing 的判定语义。
  const [pricingRaw, statusRaw] = await Promise.all([
    getJsonText(`${origin}/api/pricing`, options.timeoutMs),
    getJsonText(`${origin}/api/status`, options.timeoutMs),
  ]);
  const statusQuota = statusRaw.kind === 'ok' ? statusQuotaPerUnit(safeJson(statusRaw.text)) : null;

  const cliQuota = finitePositive(options.quotaPerUsd);
  let quotaPerUnit = statusQuota;
  let quotaPerUnitConflict: string | null = null;
  // 换算系数来源：CLI 覆盖优先于站点公示（用于漂移比对区分「站点改价」与「用户换口径」）。
  let quotaPerUnitSource: QuotaPerUnitSource = statusQuota !== null ? 'site' : 'none';
  if (cliQuota !== null) {
    if (quotaPerUnit !== null && Math.abs(quotaPerUnit - cliQuota) > Math.max(1e-9, Math.abs(quotaPerUnit) * 1e-9)) {
      quotaPerUnitConflict = `--quota-per-usd ${cliQuota} 与站点 /api/status 的 quota_per_unit ${quotaPerUnit} 不一致，按 CLI 值换算`;
    }
    quotaPerUnit = cliQuota;
    quotaPerUnitSource = 'cli';
  }

  if (pricingRaw.kind !== 'ok') {
    const { state, reason } = classifyPricingFailure(pricingRaw);
    return { state, origin, pricing: null, quotaPerUnit, reason };
  }
  const parsed = parsePricingPayload(safeJson(pricingRaw.text));
  if (!parsed.ok) {
    return { state: 'not_applicable', origin, pricing: null, quotaPerUnit, reason: parsed.reason };
  }

  return {
    state: 'ok',
    origin,
    quotaPerUnit,
    pricing: {
      origin,
      capturedAt: new Date().toISOString(),
      source: 'api',
      quotaPerUnit,
      quotaPerUnitSource,
      quotaPerUnitConflict,
      models: parsed.table.models,
      groupRatio: parsed.table.groupRatio,
      group: typeof options.group === 'string' && options.group.trim() !== '' ? options.group.trim() : null,
    },
    reason: null,
  };
}

/** 把非 ok 的原始 GET 结果映射为 pricing 状态：能力边界 vs 异常。 */
function classifyPricingFailure(raw: Exclude<RawGet, { kind: 'ok' }>): {
  state: 'not_applicable' | 'failed';
  reason: string;
} {
  switch (raw.kind) {
    case 'not_found':
      return { state: 'not_applicable', reason: '站点未提供 /api/pricing（非 new-api 系或已关闭公示）' };
    case 'redirect':
      return { state: 'not_applicable', reason: `/api/pricing 返回重定向（HTTP ${raw.status}，不跟随）` };
    case 'http_error':
      return { state: 'failed', reason: `/api/pricing 返回 HTTP ${raw.status}` };
    case 'timeout':
      return { state: 'failed', reason: '/api/pricing 请求超时' };
    case 'too_large':
      return { state: 'failed', reason: `/api/pricing 响应体 ${raw.bytes} 字节超过上限 ${PRICING_BODY_LIMIT_BYTES}` };
    case 'network':
      return { state: 'failed', reason: `/api/pricing 网络错误：${raw.message}` };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
