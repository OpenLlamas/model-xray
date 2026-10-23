/**
 * 探针失败归因：把请求错误串分类，供 UNKNOWN/insufficient 标题与运行级 notes 说明「是谁的问题」。
 * 设计约束（层 3 审查必修项）：
 * - 错误详情白名单化：状态码 + 截断 + 去控制字符，防上游错误体携带 ANSI/控制字符注入报告；
 * - 文案称「端点/网关」而非「上游」（中转隧道场景下 503 实为隧道/网关返回）；
 * - 归因区分网关拒绝/鉴权/路径/网络超时/错误载荷，不把本地配置问题栽给端点。
 */

export type FailureCategory = 'gateway' | 'auth' | 'not-found' | 'network' | 'endpoint-error' | 'other';

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** 去控制字符、折叠空白并截断（供 headline/notes 展示的错误详情）。 */
export function sanitizeErrorSnippet(text: string, maxChars = 90): string {
  const cleaned = text.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars)}…` : cleaned;
}

export function categorizeFailure(error: string | null): FailureCategory {
  if (error === null || error === '') return 'other';
  if (/^HTTP (429|50[23])\b/.test(error)) return 'gateway';
  if (/^HTTP 40[123]\b/.test(error)) return 'auth';
  if (/^HTTP 404\b/.test(error)) return 'not-found';
  if (/^(timeout|network)\b/.test(error)) return 'network';
  if (/^(upstream error payload|stream ended|invalid JSON|empty stream|response has no body)/.test(error)) {
    return 'endpoint-error';
  }
  return 'other';
}

export const FAILURE_CATEGORY_LABEL: Record<FailureCategory, string> = {
  gateway: '端点/网关拒绝',
  auth: '鉴权/配额问题（本地 key 或账户，非模型问题）',
  'not-found': '模型 ID 或路径不存在（请核对模型名）',
  network: '网络/超时（本地到端点链路）',
  'endpoint-error': '端点返回错误载荷',
  other: '其他错误',
};

export interface FailureSummary {
  category: FailureCategory;
  label: string;
  count: number;
  detail: string;
}

/** 从一组错误串中选出主导类别（并列取先出现者），并产出人类可读的摘要。 */
export function summarizeFailures(errors: Array<string | null>): FailureSummary | null {
  const valid = errors.filter((e): e is string => typeof e === 'string' && e.length > 0);
  if (valid.length === 0) return null;
  const byCategory = new Map<FailureCategory, string[]>();
  for (const e of valid) {
    const category = categorizeFailure(e);
    const list = byCategory.get(category);
    if (list === undefined) byCategory.set(category, [e]);
    else list.push(e);
  }
  let dominant: FailureCategory = 'other';
  let dominantList: string[] = [];
  for (const [category, list] of byCategory) {
    if (list.length > dominantList.length) {
      dominant = category;
      dominantList = list;
    }
  }
  const first = dominantList[0] ?? valid[0] ?? '';
  return {
    category: dominant,
    label: FAILURE_CATEGORY_LABEL[dominant],
    count: dominantList.length,
    detail: sanitizeErrorSnippet(first),
  };
}

/** 形如「端点/网关拒绝（6/6 笔）：HTTP 503: system cpu overloaded…」的单行摘要；无失败返回 null。 */
export function failureDigest(errors: Array<string | null>, totalRequests: number): string | null {
  const summary = summarizeFailures(errors);
  if (summary === null) return null;
  return `${summary.label}（${summary.count}/${totalRequests} 笔）：${summary.detail}`;
}

const FAILURE_ADVICE: Record<FailureCategory, string> = {
  gateway: '限流/过载类（429/503）建议错峰或稍后重测，请求未进推理通常不产生费用',
  auth: '请核对 API key 与账户余额',
  'not-found': '请核对模型 ID 拼写与端点路径',
  network: '请检查本机到端点的网络链路与超时设置',
  'endpoint-error': '建议查看证据中的原始错误详情并与端点方核对',
  other: '建议查看证据中的原始错误详情',
};

/** 运行级失败汇总（供 runner notes）：N/M 笔请求失败 + 主导归因 + 对应建议。全部成功返回 null。 */
export function runFailureDigest(
  records: Array<{ response: { status: number; error: string | null } }>,
): string | null {
  const failed = records.filter((r) => r.response.error !== null || r.response.status >= 400);
  if (failed.length === 0) return null;
  const digest = failureDigest(failed.map((r) => r.response.error), records.length);
  if (digest === null) {
    return `本轮 ${failed.length}/${records.length} 笔请求失败（无错误详情），失败样本所在维度可能因此未判定。`;
  }
  const summary = summarizeFailures(failed.map((r) => r.response.error));
  const advice = summary !== null ? FAILURE_ADVICE[summary.category] : FAILURE_ADVICE.other;
  return `本轮 ${failed.length}/${records.length} 笔请求失败，失败样本所在维度可能因此未判定。主因：${digest}。${advice}。`;
}
