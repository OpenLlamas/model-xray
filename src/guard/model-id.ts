// src/guard/model-id.ts — 模型 id 归一（换壳检测的比较口径，三处共用）。
/**
 * 中转站常把请求模型 id 规范化后回显：glm-5.3-flash → glm-5-3-flash / GLM-5.3-Flash。
 * 这类「仅大小写与分隔符不同」的写法指向同一模型，若按原样比对会稳定误报 model_mismatch，
 * 把身份维度拉成 FAIL——实测终卡 身份 67[FAIL] 即由此产生。
 *
 * 归一只做两件事：小写化 + 分隔符统一（. _ - / 与空白一律折成单个 '-'，并去首尾）。
 * 统一成 '-' 而不是删掉，是为了让「数字段边界」保留下来：
 *   · 同族规范化写法仍然相等：glm-5.3-flash ≡ glm-5-3-flash ≡ glm_5_3__flash；
 *   · 版本/数字段不同仍然不等：glm-3.5 ≠ glm-35、gpt-4-1 ≠ gpt41、glm-5.3-flash ≠ deepseek-v4.1-flash。
 * （若删掉分隔符，glm-3.5 与 glm-35 会被误判同一模型 → 漏报真实换壳；红队审查 2026-10-18 实证该合并可达。）
 *
 * 空/非字符串/归一后为空一律返回 null：两个空 id 不算「同一模型」，避免把缺失信息判成一致。
 */
export function canonicalModelId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[\s._\-/]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized === '' ? null : normalized;
}

/** 两个模型 id 是否指同一模型（大小写与分隔符不敏感）；任一侧缺失/为空一律判不同。 */
export function sameModelId(a: unknown, b: unknown): boolean {
  const left = canonicalModelId(a);
  const right = canonicalModelId(b);
  return left !== null && right !== null && left === right;
}
