export interface BalanceReading {
  value: number;
  kind: 'spent_total' | 'balance'; // 累计消费型 / 剩余额度型，Δ 语义相反
  unit: string; // 'USD' | 'quota' 等，仅标注不换算
  endpoint: string; // 命中的 path，用于两次查询同源校验
  currency: string | null;
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
      if (typeof totalUsage !== 'number' || !Number.isFinite(totalUsage)) return null;
      // OpenAI 官方该字段单位为美分，extractor 内除以 100 归一为美元
      return { value: totalUsage / 100, kind: 'spent_total', unit: 'USD', currency: null };
    },
  },
  {
    path: '/dashboard/billing/credit_grants',
    extract(json) {
      const totalAvailable = json['total_available'];
      if (typeof totalAvailable !== 'number' || !Number.isFinite(totalAvailable)) return null;
      return { value: totalAvailable, kind: 'balance', unit: 'USD', currency: null };
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
      // one-api / new-api 系真实 schema：data.quota 为剩余额度（quota 单位）
      return { value: quota, kind: 'balance', unit: 'quota', currency: null };
    },
  },
];

/** 按序探测候选余额接口；非 2xx / 解析失败静默尝试下一个，全败返回 null。单次尝试不重试。 */
export async function probeBalance(baseUrl: string, apiKey: string, timeoutMs: number): Promise<BalanceReading | null> {
  const base = baseUrl.replace(/\/+$/, '');
  for (const candidate of BALANCE_ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${base}${candidate.path}`, {
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
      if (extracted !== null) return { ...extracted, endpoint: candidate.path };
    } catch {
      // 网络 / 超时 / 中止：静默尝试下一个候选
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** 两次读数同源（endpoint/kind/unit/currency 一致）才可作差；spent_total 为增量，balance 为消耗量。 */
export function spendBetween(before: BalanceReading, after: BalanceReading): number | null {
  if (
    before.endpoint !== after.endpoint ||
    before.kind !== after.kind ||
    before.unit !== after.unit ||
    before.currency !== after.currency
  ) {
    return null;
  }
  if (before.kind === 'spent_total') return after.value - before.value;
  return before.value - after.value;
}
