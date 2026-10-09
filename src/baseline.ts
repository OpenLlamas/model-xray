import { readFileSync } from 'node:fs';
import type { ProbeId, ProbeOutcome } from './types.js';

export interface BaselineFile {
  version: 1;
  model: string;
  seed: number;
  createdAt: string;
  probesetVersion: string;
  assetsVersion: string;
  identity: { families: string[]; schemaCompliant: boolean | null; refusalRate: number } | null;
  quality: { accuracy: number; mainCorrect: number; mainTotal: number } | null;
  capability: Record<string, string> | null;
  billing: { slopeEn: number | null; slopeZh: number | null } | null;
}

export interface BaselineMeta {
  model: string;
  seed: number;
  probesetVersion: string;
  assetsVersion: string;
  createdAt?: string;
}

// 漂移阈值为启发式初值，写死在代码里并版本化管理，保证报告间可比；调整需 bump probeset 版本。
export const DRIFT_QUALITY_WARN = 0.15;
export const DRIFT_QUALITY_FAIL = 0.3;
export const DRIFT_BILLING_ABS = 0.05;
export const DRIFT_BILLING_REL = 0.2;

export interface BaselineDiffItem {
  probeId: ProbeId;
  level: 'warn' | 'fail';
  message: string;
  cap: number | null;
}

export interface BaselineDiff {
  comparable: boolean;
  skipReason: string | null;
  items: BaselineDiffItem[];
}

/** 从本轮各探针 outcome 的 metrics 提取指纹基线；探针缺失/证据不足的维度输出 null。 */
export function buildBaseline(outcomes: ProbeOutcome[], meta: BaselineMeta): BaselineFile {
  const find = (id: ProbeId): ProbeOutcome | undefined => outcomes.find((o) => o.id === id);
  return {
    version: 1,
    model: meta.model,
    seed: meta.seed,
    createdAt: meta.createdAt ?? new Date().toISOString(),
    probesetVersion: meta.probesetVersion,
    assetsVersion: meta.assetsVersion,
    identity: buildIdentity(find('identity')),
    quality: buildQuality(find('quality')),
    capability: buildCapability(find('capability')),
    billing: buildBilling(find('billing')),
  };
}

function buildIdentity(outcome: ProbeOutcome | undefined): BaselineFile['identity'] {
  if (!outcome) return null;
  const familiesRaw = outcome.metrics['families'];
  const families =
    typeof familiesRaw === 'string' && familiesRaw.length > 0 && familiesRaw !== 'none'
      ? familiesRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
  const schemaRaw = outcome.metrics['schema_compliant'];
  const schemaCompliant = schemaRaw === 1 ? true : schemaRaw === 0 ? false : null;
  const samples = outcome.metrics['samples'];
  const refusals = outcome.metrics['refusals'];
  const sampleCount = typeof samples === 'number' ? samples : 0;
  const refusalCount = typeof refusals === 'number' ? refusals : 0;
  return { families, schemaCompliant, refusalRate: sampleCount > 0 ? refusalCount / sampleCount : 0 };
}

function buildQuality(outcome: ProbeOutcome | undefined): BaselineFile['quality'] {
  if (!outcome) return null;
  const main = outcome.metrics['main'];
  if (typeof main !== 'string') return null;
  const match = main.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!match) return null;
  const correct = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isFinite(correct) || !Number.isFinite(total) || total <= 0) return null;
  return { accuracy: correct / total, mainCorrect: correct, mainTotal: total };
}

function buildCapability(outcome: ProbeOutcome | undefined): BaselineFile['capability'] {
  if (!outcome) return null;
  const caps: Record<string, string> = {};
  for (const key of ['vision', 'tool', 'thinking']) {
    const value = outcome.metrics[key];
    if (typeof value === 'string') caps[key] = value;
  }
  return Object.keys(caps).length > 0 ? caps : null;
}

function buildBilling(outcome: ProbeOutcome | undefined): BaselineFile['billing'] {
  if (!outcome) return null;
  const en = outcome.metrics['slope_en'];
  const zh = outcome.metrics['slope_zh'];
  const slopeEn = typeof en === 'number' ? en : null;
  const slopeZh = typeof zh === 'number' ? zh : null;
  if (slopeEn === null && slopeZh === null) return null;
  return { slopeEn, slopeZh };
}

/** 读取并校验基线文件；version!==1 或结构非法直接抛错（错误含字段路径；cli fail-fast，runner 决定是否降级）。 */
export function loadBaseline(path: string): BaselineFile {
  const raw = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`基线文件不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('基线文件结构非法：顶层应为 JSON 对象。');
  }
  const version = (parsed as { version?: unknown }).version;
  if (version !== 1) {
    throw new Error(`不支持的基线版本：${String(version)}（仅支持 version=1）。`);
  }
  validateBaseline(parsed as Record<string, unknown>);
  return parsed as BaselineFile;
}

/** 基线运行时形状校验：畸形基线绝不能静默流入对比逻辑（否则可能制造假漂移、冤枉端点）。错误信息一律含字段路径。 */
function validateBaseline(b: Record<string, unknown>): void {
  requireNonEmptyString(b, 'model');
  requireNonEmptyString(b, 'probesetVersion');
  requireNonEmptyString(b, 'assetsVersion');
  if (typeof b['seed'] !== 'number' || !Number.isFinite(b['seed'])) {
    throw fieldError('baseline.seed', '有限数字', b['seed']);
  }
  if (typeof b['createdAt'] !== 'string') {
    throw fieldError('baseline.createdAt', '字符串', b['createdAt']);
  }

  const identity = section(b, 'identity');
  if (identity !== undefined) {
    if (!Array.isArray(identity['families']) || !identity['families'].every((f) => typeof f === 'string')) {
      throw fieldError('baseline.identity.families', '字符串数组', identity['families']);
    }
    if (identity['schemaCompliant'] !== null && typeof identity['schemaCompliant'] !== 'boolean') {
      throw fieldError('baseline.identity.schemaCompliant', 'boolean 或 null', identity['schemaCompliant']);
    }
    if (typeof identity['refusalRate'] !== 'number' || !Number.isFinite(identity['refusalRate'])) {
      throw fieldError('baseline.identity.refusalRate', '数字', identity['refusalRate']);
    }
  }

  const quality = section(b, 'quality');
  if (quality !== undefined) {
    for (const key of ['accuracy', 'mainCorrect'] as const) {
      if (typeof quality[key] !== 'number' || !Number.isFinite(quality[key])) {
        throw fieldError(`baseline.quality.${key}`, '数字', quality[key]);
      }
    }
    if (typeof quality['mainTotal'] !== 'number' || !Number.isFinite(quality['mainTotal']) || quality['mainTotal'] < 0) {
      throw fieldError('baseline.quality.mainTotal', '≥0 的数字', quality['mainTotal']);
    }
  }

  const capability = section(b, 'capability');
  if (capability !== undefined) {
    for (const [key, value] of Object.entries(capability)) {
      if (typeof value !== 'string') {
        throw fieldError(`baseline.capability.${key}`, '字符串', value);
      }
    }
  }

  const billing = section(b, 'billing');
  if (billing !== undefined) {
    for (const key of ['slopeEn', 'slopeZh'] as const) {
      const value = billing[key];
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
        throw fieldError(`baseline.billing.${key}`, '数字或 null', value);
      }
    }
  }
}

/** 取维度段：缺失(undefined)视同 null（容错旧基线），null 视同未采样；数组/标量一律拒绝。 */
function section(b: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = b[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw fieldError(`baseline.${key}`, '对象或 null', value);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(b: Record<string, unknown>, key: string): void {
  if (typeof b[key] !== 'string' || (b[key] as string).length === 0) {
    throw fieldError(`baseline.${key}`, '非空字符串', b[key]);
  }
}

function fieldError(path: string, expected: string, actual: unknown): Error {
  const shown = actual === undefined ? '字段缺失' : `实际为 ${shortJson(actual)}`;
  return new Error(`基线文件字段 ${path} 应为${expected}（${shown}）。请用对应 --baseline-out 重新生成基线。`);
}

function shortJson(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/**
 * 对比新旧基线，产出漂移项。seed 不同时跳过 quality 对比（题集不同），
 * identity/capability/billing 照常；其余不可比情形整体跳过。
 */
export function diffBaseline(oldBaseline: BaselineFile, current: BaselineFile): BaselineDiff {
  if (oldBaseline.version !== 1) {
    return { comparable: false, skipReason: `基线版本为 ${String(oldBaseline.version)}，仅支持 version=1`, items: [] };
  }
  if (oldBaseline.model !== current.model) {
    return {
      comparable: false,
      skipReason: `模型标识不一致（基线 ${oldBaseline.model} vs 本次 ${current.model}）`,
      items: [],
    };
  }
  if (oldBaseline.probesetVersion !== current.probesetVersion) {
    return {
      comparable: false,
      skipReason: `题集版本不一致（基线 ${oldBaseline.probesetVersion} vs 本次 ${current.probesetVersion}）`,
      items: [],
    };
  }
  if (oldBaseline.assetsVersion !== current.assetsVersion) {
    return {
      comparable: false,
      skipReason: `资产版本不一致（基线 ${oldBaseline.assetsVersion} vs 本次 ${current.assetsVersion}）`,
      items: [],
    };
  }

  const items: BaselineDiffItem[] = [];

  const oldFamilies = new Set(oldBaseline.identity?.families ?? []);
  const newFamilies = new Set(current.identity?.families ?? []);
  if (oldFamilies.size > 0 && newFamilies.size > 0) {
    const overlaps = [...oldFamilies].some((f) => newFamilies.has(f));
    if (!overlaps) {
      items.push({
        probeId: 'identity',
        level: 'fail',
        cap: 0,
        message: `模型族指纹漂移：基线为 ${[...oldFamilies].sort().join('/')}，本次为 ${[...newFamilies].sort().join('/')}，疑似模型被更换`,
      });
    }
  }

  if (oldBaseline.seed === current.seed && oldBaseline.quality && current.quality) {
    const delta = Math.abs(current.quality.accuracy - oldBaseline.quality.accuracy);
    const from = percent(oldBaseline.quality.accuracy);
    const to = percent(current.quality.accuracy);
    if (delta > DRIFT_QUALITY_FAIL) {
      items.push({
        probeId: 'quality',
        level: 'fail',
        cap: 30,
        message: `质量准确率漂移 ${percent(delta)}（${from} → ${to}），超过 ${percent(DRIFT_QUALITY_FAIL)} 阈值，疑似降智或换模型`,
      });
    } else if (delta > DRIFT_QUALITY_WARN) {
      items.push({
        probeId: 'quality',
        level: 'warn',
        cap: 70,
        message: `质量准确率漂移 ${percent(delta)}（${from} → ${to}），超过 ${percent(DRIFT_QUALITY_WARN)} 关注阈值`,
      });
    }
  }

  if (oldBaseline.capability && current.capability) {
    for (const key of ['vision', 'tool', 'thinking']) {
      const before = oldBaseline.capability[key];
      const after = current.capability[key];
      if ((before === 'pass' || before === 'true') && after !== undefined && after !== 'pass' && after !== 'true' && after !== 'na') {
        items.push({
          probeId: 'capability',
          level: 'warn',
          cap: 70,
          message: `能力 ${key} 相对基线退化：${before} → ${after}（单布尔易抖动，仅警告）`,
        });
      }
    }
  }

  if (oldBaseline.billing && current.billing) {
    const pairs: Array<[string, number | null, number | null]> = [
      ['英文', oldBaseline.billing.slopeEn, current.billing.slopeEn],
      ['中文', oldBaseline.billing.slopeZh, current.billing.slopeZh],
    ];
    for (const [label, before, after] of pairs) {
      if (typeof before !== 'number' || typeof after !== 'number' || Math.abs(before) < 1e-9) continue;
      const absDelta = Math.abs(after - before);
      const relDelta = absDelta / Math.abs(before);
      if (absDelta > DRIFT_BILLING_ABS && relDelta > DRIFT_BILLING_REL) {
        items.push({
          probeId: 'billing',
          level: 'warn',
          cap: null,
          message: `${label}计费斜率相对基线漂移：${before} → ${after}（相对偏差 ${percent(relDelta)}）`,
        });
      }
    }
  }

  return { comparable: true, skipReason: null, items };
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
