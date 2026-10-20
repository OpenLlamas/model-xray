import { deriveOrigin, isPlausibleQuotaPerUnit, QUOTA_PER_UNIT_MAX, QUOTA_PER_UNIT_MIN } from './pricing.js';

export interface BalanceReading {
  value: number;
  kind: 'spent_total' | 'balance'; // 累计消费型 / 剩余额度型，Δ 语义相反
  unit: string; // 'USD' | 'quota' | 'total_usage_raw' 等，仅标注不换算
  endpoint: string; // 命中的 path，用于两次查询同源校验
  currency: string | null;
  /** 读数最小分辨率（与 value 同单位）：低于 3×resolution 的差值只能视为精度噪声，不得用于倍率判定 */
  resolution?: number;
  /**
   * 换算来源说明（new-api quota 端点）：value 已按 /api/status 校准的 quota_per_unit 折算为 USD。
   * 该说明必须随 metrics 披露——换算假设是倍率结论的一部分。
   */
  conversionNote?: string;
  /**
   * total_usage 专属：该读数是否符合 OpenAI「整数美分」schema。
   * true = 整数（校准可作 cents 口径可信依据）；false = 非整数（单位未知，只能候选比值择近）。
   */
  integerCents?: boolean;
}

export type BalanceExtraction = Omit<BalanceReading, 'endpoint'>;

export interface BalanceEndpoint {
  path: string;
  extract: (json: Record<string, unknown>) => BalanceExtraction | null;
}

/** 候选余额接口，按序尝试；extract 为纯函数，只认已知 schema，形态不符返回 null。 */
export const BALANCE_ENDPOINTS: readonly BalanceEndpoint[] = [
  {
    path: '/dashboard/billing/usage',
    extract(json) {
      const totalUsage = json['total_usage'];
      // 不再在提取层做 ÷100：整数与非整数统一原样返回，由 decideRatio 以「应缴金额」为锚做单位
      // 校准（美分/美元/quota 三口径择近）。整数读数带 integerCents 元数据（OpenAI total_usage
      // 整数美分 schema），校准时可作为 cents 口径的可信依据；非整数则只能靠候选比值择近
      // （盲猜单位即 2026-10-18 142.975× 假 fail 的根因；一律拒读则丢掉该类中转站的可用数据）。
      if (typeof totalUsage !== 'number' || !Number.isFinite(totalUsage)) return null;
      if (Number.isInteger(totalUsage)) {
        return { value: totalUsage, kind: 'spent_total', unit: 'total_usage_raw', currency: null, resolution: 1, integerCents: true };
      }
      return { value: totalUsage, kind: 'spent_total', unit: 'total_usage_raw', currency: null, resolution: 0.001, integerCents: false };
    },
  },
  {
    path: '/dashboard/billing/credit_grants',
    extract(json) {
      const totalAvailable = json['total_available'];
      if (typeof totalAvailable !== 'number' || !Number.isFinite(totalAvailable)) return null;
      return { value: totalAvailable, kind: 'balance', unit: 'USD', currency: null, resolution: 0.01 };
    },
  },
  {
    path: '/api/user/self',
    extract(json) {
      if (json['success'] !== true) return null;
      const data = json['data'];
      if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
      const quota = (data as Record<string, unknown>)['quota'];
      if (typeof quota !== 'number' || !Number.isFinite(quota)) return null;
      // one-api / new-api 系真实 schema：data.quota 为剩余额度（quota 单位，整数粒度）
      return { value: quota, kind: 'balance', unit: 'quota', currency: null, resolution: 1 };
    },
  },
];

export interface BalanceDetailed {
  reading: BalanceReading | null;
  /** reading 为 null 时给出「为什么没读到」的可披露诊断；成功时为 null */
  reason: string | null;
}

/** 余额端点的命中来源：new-api 令牌用量端点，或通用候选端点（按 path 索引）。 */
type BalanceSourceKind = { kind: 'token-usage' } | { kind: 'candidate'; path: string };

/** 内部探测结果：在 BalanceDetailed 之外带上「命中的是哪个端点」，供轮询钉住同一端点。 */
interface BalanceProbe extends BalanceDetailed {
  source: BalanceSourceKind | null;
}

/** 候选端点单次抓取结果（读数或失败原因）。 */
interface CandidateProbe {
  extracted: BalanceExtraction | null;
  failure: string | null;
}

/**
 * 逐候选带诊断的余额探测：全败时返回每个候选的具体失败原因（HTTP 状态/超时/schema 不符），
 * 供 billing probe 把「读不到余额」从静默 N/A 升级为可披露的 reason。成功即返回首个可用读数。
 *
 * preferredEndpoint：轮询稳定化时钉住上次命中的端点（省掉整条候选链的重跑）；
 * 钉住的端点读不到时自动回落整条链（端点下线/改 schema 也不会丢读数）。
 */
export async function probeBalanceDetailed(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number,
  preferredEndpoint: string | null = null,
): Promise<BalanceDetailed> {
  const { reading, reason } = await probeBalanceDetailedFull(baseUrl, apiKey, timeoutMs, preferredEndpoint);
  return { reading, reason };
}

/** 探测实现（带命中端点信息）：/api/status 只拉一次，候选链按「钉住 → 回落」两段执行。 */
async function probeBalanceDetailedFull(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number,
  preferredEndpoint: string | null,
): Promise<BalanceProbe> {
  let origin: string;
  try {
    origin = deriveOrigin(baseUrl);
  } catch {
    return { reading: null, reason: `baseUrl 无法解析为 URL：${baseUrl}`, source: null };
  }
  const base = baseUrl.replace(/\/+$/, '');
  const failures: string[] = [];
  // 同一轮探测内 /api/status 只取一次：令牌用量端点与 /api/user/self 分支都要 quota_per_unit，
  // 重复拉取纯属浪费（且站点可能对高频探测限流）。
  let quotaPerUnitCache: number | null | undefined;
  const quotaPerUnit = async (): Promise<number | null> => {
    if (quotaPerUnitCache === undefined) quotaPerUnitCache = await fetchQuotaPerUnit(origin, timeoutMs);
    return quotaPerUnitCache;
  };
  // 读数落定：quota 口径按站点公示的 quota_per_unit 折算为 USD（不可达则保留原单位，
  // decideRatio 按非 USD 口径整体作废，无行为回退）。
  const settle = async (extracted: BalanceExtraction, path: string): Promise<BalanceProbe> => {
    let reading: BalanceReading = { ...extracted, endpoint: path };
    if (reading.unit === 'quota') {
      const qpu = await quotaPerUnit();
      // 换算系数必须为正的有限数：0/负数/NaN 会把读数除成 Infinity/NaN，产出「伪 USD 余额」，
      // 进而让倍率判定拿到荒谬读数（或把两次读数判成「稳定」）。非法时保留原 quota 单位，
      // 由调用方按「非计价单位」整体作废金额侧——宁可 N/A 也不产出假读数。
      if (isUsableQuotaPerUnit(qpu)) {
        reading = {
          ...reading,
          value: reading.value / qpu,
          unit: 'USD',
          resolution: 1 / qpu,
          conversionNote: `quota_per_unit=${qpu} (source: /api/status; user-level balance)`,
        };
      } else if (qpu !== null) {
        // 兜底分支：显式排除 0/负数（除它们会产出 Infinity），其余越界情形（量级荒谬等）已由
        // extractQuotaPerUnit 在取数时过滤，qpu 恒为有效域内的值。
        reading = {
          ...reading,
          conversionNote: `quota_per_unit=${qpu} 不可用于换算（需为 ${QUOTA_PER_UNIT_MIN}~${QUOTA_PER_UNIT_MAX} 之间的正数），未做 quota→USD 换算`,
        };
      }
    }
    return { reading, reason: null, source: { kind: 'candidate', path } };
  };

  // 第一段：钉住上次命中的端点（轮询期只关心读数是否稳定，整链重跑是纯浪费）。
  if (preferredEndpoint !== null) {
    if (preferredEndpoint === '/api/usage/token') {
      const usage = await probeNewApiTokenUsage(origin, apiKey, timeoutMs, quotaPerUnit);
      if (usage !== null) return { reading: usage, reason: null, source: { kind: 'token-usage' } };
      failures.push(`${preferredEndpoint} → new-api 令牌用量端点不可用（404/非 JSON/校准失败）`);
    } else {
      const candidate = BALANCE_ENDPOINTS.find((item) => item.path === preferredEndpoint);
      if (candidate !== undefined) {
        const probe = await probeBalanceCandidate(origin, base, apiKey, timeoutMs, candidate);
        if (probe.extracted !== null) return settle(probe.extracted, candidate.path);
        failures.push(`${candidate.path} → ${probe.failure ?? '不可用'}`);
      }
    }
  }

  // 第二段：完整候选链（new-api 令牌用量端点优先——key 级、分辨率最细）。
  const quotaReading = await probeNewApiTokenUsage(origin, apiKey, timeoutMs, quotaPerUnit);
  if (quotaReading !== null) return { reading: quotaReading, reason: null, source: { kind: 'token-usage' } };
  failures.push(`${'/api/usage/token'} → new-api 令牌用量端点不可用（404/非 JSON/校准失败）`);
  for (const candidate of BALANCE_ENDPOINTS) {
    // dashboard 计费端点在真实部署有两种形态：new-api 挂站点根（deriveOrigin 剥掉 /v1/反代段），
    // 部分中转按 OpenAI 兼容布局代理在用户 baseUrl（含 /v1）之下（某中转站实证）。两种都试：
    // 根路径 404 才回退用户路径；/api/* 控制台端点只在站点根（两种口径一致）。
    const probe = await probeBalanceCandidate(origin, base, apiKey, timeoutMs, candidate);
    if (probe.extracted !== null) return settle(probe.extracted, candidate.path);
    failures.push(`${candidate.path} → ${probe.failure ?? '不可用'}`);
  }
  return { reading: null, reason: `候选余额接口均不可用（origin ${origin}）：${failures.join('；')}`, source: null };
}

/** 单个候选端点的抓取：先站点根、404 才回退用户 baseUrl 之下；返回读数或失败原因。 */
async function probeBalanceCandidate(
  origin: string,
  base: string,
  apiKey: string,
  timeoutMs: number,
  candidate: BalanceEndpoint,
): Promise<CandidateProbe> {
  const urls = candidate.path.startsWith('/api/')
    ? [`${origin}${candidate.path}`]
    : [`${origin}${candidate.path}`, `${base}${candidate.path}`];
  let lastFailure: string | null = null;
  for (const url of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        lastFailure = describeBalanceStatus(response.status);
        // 404 才值得换路径重试（该路径不存在）；401/403/5xx 说明路由存在但鉴权/网关有问题，换路径无意义
        if (response.status !== 404 || url === urls[urls.length - 1]) break;
        continue;
      }
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        lastFailure = '响应非 JSON';
        break;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        lastFailure = '响应不是 JSON 对象';
        break;
      }
      const extracted = candidate.extract(parsed as Record<string, unknown>);
      if (extracted !== null) return { extracted, failure: null };
      lastFailure = 'schema 不符（缺该接口的额度字段）';
      break;
    } catch {
      lastFailure = controller.signal.aborted ? `超时 ${timeoutMs}ms` : '网络错误';
      if (url === urls[urls.length - 1]) break;
      continue;
    } finally {
      clearTimeout(timer);
    }
  }
  return { extracted: null, failure: lastFailure ?? '不可用' };
}

function describeBalanceStatus(status: number): string {
  if (status === 401 || status === 403) return `HTTP ${status}（需要登录态或该 key 无权读取余额）`;
  if (status === 404) return 'HTTP 404（该站未提供此接口）';
  if (status >= 500) return `HTTP ${status}（站点/网关错误）`;
  return `HTTP ${status}`;
}

/** 兼容旧调用方（guard 等）：只取读数，全败返回 null；诊断原因用 probeBalanceDetailed。 */
export async function probeBalance(baseUrl: string, apiKey: string, timeoutMs: number): Promise<BalanceReading | null> {
  return (await probeBalanceDetailed(baseUrl, apiKey, timeoutMs)).reading;
}

/** 两次读数同源（endpoint/kind/unit/currency 一致）才可作差；spent_total 为增量，balance 为消耗量。
 * 校准一致性守卫（qpu 锁定）：两次读数的 resolution（含 quota_per_unit 换算粒度）不一致 → 伪 Δ，
 * 一律作废（站方中途改 qpu/读数被路由到不同校准实例时，直接作比会产出荒谬倍率）。 */
export function spendBetween(before: BalanceReading, after: BalanceReading): number | null {
  if (
    before.endpoint !== after.endpoint ||
    before.kind !== after.kind ||
    before.unit !== after.unit ||
    before.currency !== after.currency
  ) {
    return null;
  }
  const beforeRes = Number.isFinite(before.resolution) ? (before.resolution as number) : null;
  const afterRes = Number.isFinite(after.resolution) ? (after.resolution as number) : null;
  if (beforeRes !== null && afterRes !== null && beforeRes !== afterRes) return null;
  if (before.kind === 'spent_total') return after.value - before.value;
  return before.value - after.value;
}

/**
 * quota→计价单位换算是否可用：换算系数必须是正的有限数。
 * 0/负数/NaN/Infinity 会把读数除成伪金额（Infinity/NaN），进而让倍率判定拿到荒谬读数
 * （或把两次读数误判成「稳定」）——宁可保留原单位由上层作废金额侧，也不产出假读数。
 */
/**
 * quota→USD 换算系数是否可用：必须是有限数且落在公示口径的有效域内
 * （与 src/pricing.ts 的 isPlausibleQuotaPerUnit 同一域：全工具只认一个换算系数口径）。
 * 0/负数/NaN/超量级一律作废：除以它们会产出 Infinity/NaN 的「伪 USD 余额」。
 */
export function isUsableQuotaPerUnit(quotaPerUnit: number | null): quotaPerUnit is number {
  return isPlausibleQuotaPerUnit(quotaPerUnit);
}

/**
 * new-api 令牌用量端点（GET /api/usage/token，Bearer key；官方 schema 见 PR #1161：
 * data.total_granted/total_used/total_available，单位 quota）。quota→USD 换算依赖
 * /api/status 公开的 quota_per_unit（new-api 默认 500000，站方可改）。
 * 校准失败（404/非 JSON/字段非法）时返回 null：该端点整体不采信，回落到通用候选。
 * 余额口径只采信 total_available（禁止把累计 total_granted 当余额）；spent 口径采信
 * total_used（key 级累计，独占 key 窗口下 Δ 即本次审计扣费）。
 */
async function probeNewApiTokenUsage(
  origin: string,
  apiKey: string,
  timeoutMs: number,
  quotaPerUnitProvider: () => Promise<number | null>,
): Promise<BalanceReading | null> {
  // 控制台 API（/api/status、/api/usage/token）挂在站点根；origin 由调用方经 deriveOrigin 统一
  // 剥掉 /v1 与反代版本段（/compatible-mode/v1 等），与候选余额循环同一站点根口径。
  const quotaPerUnit = await quotaPerUnitProvider();
  // 换算系数非法（0/负数/非有限）时整体作废该端点：除以非法值会产出 Infinity/NaN 伪读数。
  if (!isUsableQuotaPerUnit(quotaPerUnit)) return null;
  const payload = await fetchJson(`${origin}/api/usage/token`, apiKey, timeoutMs);
  if (payload === null) return null;
  const data = payload['data'];
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const totalUsed = record['total_used'];
  const totalAvailable = record['total_available'];
  const resolution = 1 / quotaPerUnit;
  const conversionNote = `quota_per_unit=${quotaPerUnit} (source: /api/status)`;
  if (typeof totalUsed === 'number' && Number.isFinite(totalUsed) && totalUsed >= 0) {
    return {
      value: totalUsed / quotaPerUnit,
      kind: 'spent_total',
      unit: 'USD',
      endpoint: '/api/usage/token',
      currency: null,
      resolution,
      conversionNote,
    };
  }
  if (typeof totalAvailable === 'number' && Number.isFinite(totalAvailable) && totalAvailable >= 0) {
    return {
      value: totalAvailable / quotaPerUnit,
      kind: 'balance',
      unit: 'USD',
      endpoint: '/api/usage/token',
      currency: null,
      resolution,
      conversionNote,
    };
  }
  return null;
}

/** GET JSON 小工具：非 2xx / 超时 / 非 JSON 一律 null（与候选循环同口径：静默失败）。 */
async function fetchJson(url: string, apiKey: string | null, timeoutMs: number): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (apiKey !== null) headers['authorization'] = `Bearer ${apiKey}`;
    const response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    if (!response.ok) return null;
    const parsed: unknown = JSON.parse(await response.text());
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** /api/status 的 data.quota_per_unit：数字、有限、量级合理（1~1e12，超出说明该值不是换算系数）才采信；
 * 0/负数/字符串/缺失/荒谬量级均属校准失败。与公示价快照共用同一有效域（isPlausibleQuotaPerUnit）。 */
function extractQuotaPerUnit(status: Record<string, unknown> | null): number | null {
  if (status === null) return null;
  const data = status['data'];
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const value = (data as Record<string, unknown>)['quota_per_unit'];
  return isPlausibleQuotaPerUnit(value as number) ? (value as number) : null;
}

/** 拉取并校验站点的 quota_per_unit（quota→USD 换算系数）；不可达/非法返回 null。
 * new-api/one-api 的候选余额换算共用本校准路径，保证全工具只有一个换算系数口径。 */
async function fetchQuotaPerUnit(origin: string, timeoutMs: number): Promise<number | null> {
  const status = await fetchJson(`${origin}/api/status`, null, timeoutMs);
  return extractQuotaPerUnit(status);
}

export interface StableBalanceReading {
  reading: BalanceReading;
  /** 连续两次读数一致（同端点同单位同值）视为结算稳定；false = 达到轮询上限仍在变化 */
  settled: boolean;
  /** 实际发出的读数次数（含首次） */
  polls: number;
}

/**
 * 余额快照稳定化（chroe §2：post 快照要轮询到连续两次读数稳定再取）。
 * 计费序列结束后站点的异步结算可能仍在写入：单次读数会让 Δ 偏小、把诚实站点误判成
 * 「低报倍率 warn」。这里以 gapMs 间隔重读，连续两次一致即认定稳定；
 * 轮询上限内仍在变化（异步结算极慢或账户级并发流量）时 settled=false，
 * 由调用方按「Δ 不可归因」作废倍率，绝不静默采用。余额 GET 不消耗模型 token，成本可忽略。
 */
export async function probeBalanceStable(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number,
  maxExtraPolls = 3,
  gapMs = 400,
): Promise<StableBalanceReading | null> {
  // 首次探测走完整候选链；后续轮询钉住首次命中的端点（整链重跑一次要 1~3 次请求，
  // 轮询期只关心「读数是否稳定」）。钉住端点读不到时自动回落整链（端点下线/改 schema 也不丢读数）。
  const firstProbe = await probeBalanceDetailedFull(baseUrl, apiKey, timeoutMs, null);
  if (firstProbe.reading === null) return null;
  let current = firstProbe.reading;
  let pinned = firstProbe.source;
  let polls = 1;
  for (let i = 0; i < maxExtraPolls; i += 1) {
    if (gapMs > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
    const nextProbe = await probeBalanceDetailedFull(
      baseUrl,
      apiKey,
      timeoutMs,
      pinned === null ? null : pinned.kind === 'token-usage' ? '/api/usage/token' : pinned.path,
    );
    const next = nextProbe.reading;
    if (next === null) break; // 中途不可达：保留最后已得读数，settled=false 交由调用方披露
    polls += 1;
    // 回落整链时命中端点可能变了：端点变了就重新钉住（后续轮次继续走同端点）。
    pinned = nextProbe.source ?? pinned;
    const stable =
      next.value === current.value && next.unit === current.unit && next.endpoint === current.endpoint && next.kind === current.kind;
    current = next;
    if (stable) return { reading: next, settled: true, polls };
  }
  return { reading: current, settled: false, polls };
}