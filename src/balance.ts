export interface BalanceReading {
  value: number;
  kind: 'spent_total' | 'balance'; // 累计消费型 / 剩余额度型，Δ 语义相反
  unit: string; // 'USD' | 'quota' 等，仅标注不换算
  endpoint: string; // 命中的 path，用于两次查询同源校验
  currency: string | null;
  /** 读数最小分辨率（与 value 同单位）：低于 3×resolution 的差值只能视为精度噪声，不得用于倍率判定 */
  resolution?: number;
  /**
   * 换算来源说明（new-api quota 端点）：value 已按 /api/status 校准的 quota_per_unit 折算为 USD。
   * 该说明必须随 metrics 披露——换算假设是倍率结论的一部分。
   */
  conversionNote?: string;
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
      // 只认 OpenAI 的整数美分 schema：非整数说明该字段不是美分（可能是美元/quota/自造单位），
      // 误按 ÷100 读取会产出数量级错误的倍率（2026-10-18 真机 13058.6184 → 142.975× 假 fail）。
      if (typeof totalUsage !== 'number' || !Number.isFinite(totalUsage) || !Number.isInteger(totalUsage)) return null;
      // OpenAI 官方该字段单位为美分，extractor 内除以 100 归一为美元；字段本身为美分整数，分辨率 0.01 USD
      return { value: totalUsage / 100, kind: 'spent_total', unit: 'USD', currency: null, resolution: 0.01 };
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

/** 按序探测候选余额接口；非 2xx / 解析失败静默尝试下一个，全败返回 null。单次尝试不重试。
 * new-api quota 端点（key 级、分辨率最细）优先于下方候选：但必须先经 /api/status 的
 * quota_per_unit 校准换算为 USD——校准不可达时整体跳过该端点，不按假设默认值折算
 * （图纸双审必修：换算误差可把诚实倍率推出 [0.8,1.5] 门限，假设性读数绝不能参与 fail 判定）。 */
export async function probeBalance(baseUrl: string, apiKey: string, timeoutMs: number): Promise<BalanceReading | null> {
  const base = baseUrl.replace(/\/+$/, '');
  // one-api/new-api 的控制台 API（/api/*）挂在站点根，baseUrl 带 /v1 时必须剥掉（与
  // probeNewApiTokenUsage 同口径），否则该候选在真实部署上永远打不到。
  const origin = base.replace(/\/v1$/i, '');
  const quotaReading = await probeNewApiTokenUsage(base, apiKey, timeoutMs);
  if (quotaReading !== null) return quotaReading;
  for (const candidate of BALANCE_ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${candidate.path.startsWith('/api/') ? origin : base}${candidate.path}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) continue;
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      const extracted = candidate.extract(parsed as Record<string, unknown>);
      if (extracted === null) continue;
      let reading: BalanceReading = { ...extracted, endpoint: candidate.path };
      // one-api 经典 /api/user/self 返回 raw quota：与美元应缴金额直接作比会产出天文倍率。
      // 站点自己的 /api/status quota_per_unit 可校准时换算为 USD（不可达则保留原单位，
      // decideRatio 按非 USD 口径整体作废，无行为回退）。注意该端点为用户级余额口径。
      if (reading.unit === 'quota') {
        const qpu = await fetchQuotaPerUnit(origin, timeoutMs);
        if (qpu !== null) {
          reading = {
            ...reading,
            value: reading.value / qpu,
            unit: 'USD',
            resolution: 1 / qpu,
            conversionNote: `quota_per_unit=${qpu} (source: /api/status; user-level balance)`,
          };
        }
      }
      return reading;
    } catch {
      // 网络 / 超时 / 中止：静默尝试下一个候选
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
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
 * new-api 令牌用量端点（GET /api/usage/token，Bearer key；官方 schema 见 PR #1161：
 * data.total_granted/total_used/total_available，单位 quota）。quota→USD 换算依赖
 * /api/status 公开的 quota_per_unit（new-api 默认 500000，站方可改）。
 * 校准失败（404/非 JSON/字段非法）时返回 null：该端点整体不采信，回落到通用候选。
 * 余额口径只采信 total_available（禁止把累计 total_granted 当余额）；spent 口径采信
 * total_used（key 级累计，独占 key 窗口下 Δ 即本次审计扣费）。
 */
async function probeNewApiTokenUsage(baseUrl: string, apiKey: string, timeoutMs: number): Promise<BalanceReading | null> {
  // new-api 控制台 API（/api/status、/api/usage/token）挂在站点根，而用户 baseUrl 通常带 /v1
  // 后缀（OpenAI 兼容路径）；剥掉末尾 /v1 再拼（与真实 new-api 部署布局一致）。
  const origin = baseUrl.replace(/\/v1$/i, '');
  const quotaPerUnit = await fetchQuotaPerUnit(origin, timeoutMs);
  if (quotaPerUnit === null) return null;
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
 * 0/负数/字符串/缺失/荒谬量级均属校准失败。 */
function extractQuotaPerUnit(status: Record<string, unknown> | null): number | null {
  if (status === null) return null;
  const data = status['data'];
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const value = (data as Record<string, unknown>)['quota_per_unit'];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 1e12) return null;
  return value;
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
  const first = await probeBalance(baseUrl, apiKey, timeoutMs);
  if (first === null) return null;
  let current = first;
  let polls = 1;
  for (let i = 0; i < maxExtraPolls; i += 1) {
    if (gapMs > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
    const next = await probeBalance(baseUrl, apiKey, timeoutMs);
    if (next === null) break; // 中途不可达：保留最后已得读数，settled=false 交由调用方披露
    polls += 1;
    const stable =
      next.value === current.value && next.unit === current.unit && next.endpoint === current.endpoint && next.kind === current.kind;
    current = next;
    if (stable) return { reading: next, settled: true, polls };
  }
  return { reading: current, settled: false, polls };
}
