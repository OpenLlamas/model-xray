import { readFileSync } from 'node:fs';
import { PRICING_SOURCES, type PricingSource } from './pricing.js';
import type { DeclaredPricingSnapshot, DeclaredPricingSnapshotModel, ProbeId, ProbeOutcome } from './types.js';

export interface BaselineFile {
  version: 1;
  model: string;
  seed: number;
  createdAt: string;
  probesetVersion: string;
  assetsVersion: string;
  identity: { families: string[]; schemaCompliant: boolean | null; refusalRate: number } | null;
  /** quality 指标口径版本：'pass1' = 首答正确率（2026-10-19 起）；缺省 = 旧两次机会口径，对比时跳过质量项 */
  quality: { accuracy: number; mainCorrect: number; mainTotal: number; metricVersion?: string } | null;
  capability: Record<string, string> | null;
  billing: { slopeEn: number | null; slopeZh: number | null } | null;
  /** 公示倍率快照（本轮起写入）：下一轮经 --baseline 注入 billing 的倍率漂移检测；
   * 旧基线无该字段 → loadBaseline 补 null（视为无公示价快照，不做倍率漂移对比）。 */
  pricing: DeclaredPricingSnapshot | null;
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
/**
 * 阈值比较的浮点容忍：0.9 - 0.6 = 0.30000000000000004，数学上恰好 30% 的降幅
 * 若按裸 `> 0.3` 比较会被浮点噪声顶进 fail 硬阈值（封顶 30），制造一次「疑似降智」误报。
 * 这里给所有阈值比较统一加 1e-9 容忍：恰好等于阈值按「未超过」处理，与文案一致。
 */
export const DRIFT_EPS = 1e-9;

export interface BaselineDiffItem {
  probeId: ProbeId;
  level: 'warn' | 'fail';
  message: string;
  cap: number | null;
}

export interface BaselineDiff {
  comparable: boolean;
  skipReason: string | null;
  /** 非扣分披露（基线判据不可靠、准确率提升等）：只进 notes，绝不封顶或升级 level。 */
  notes: string[];
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
    pricing: buildPricing(find('billing')),
  };
}

function buildIdentity(outcome: ProbeOutcome | undefined): BaselineFile['identity'] {
  if (!outcome) return null;
  // 注意：identity.metrics 的 claimed_version / claimed 版本旁证不进基线——基线校验按已知字段路径
  // 白名单校验，指纹对比只用 families/schema/refusalRate；新增旁证字段保持不落盘（保守方案），
  // 避免「新基线写入 → 旧版本工具加载」出现未知字段兼容问题。
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
  // metrics['main'] 自 2026-10-19 起为 pass@1（首答正确率）口径；旧口径基线无 metricVersion，
  // diffBaseline 会跳过质量对比（两种口径的 accuracy 不可比，混比会假漂移）。
  const metricVersion = typeof outcome.metrics['metric_version'] === 'string' ? outcome.metrics['metric_version'] : undefined;
  return { accuracy: correct / total, mainCorrect: correct, mainTotal: total, ...(metricVersion !== undefined ? { metricVersion } : {}) };
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

/** 从 billing outcome 的 metrics 提取公示倍率快照：只有 billing 实际抓到 /api/pricing 时产出；
 * 任何字段缺失/JSON 损坏都返回 null（无快照 → 下一轮不做倍率漂移检测，不影响其余漂移对比）。 */
function buildPricing(outcome: ProbeOutcome | undefined): BaselineFile['pricing'] {
  if (!outcome) return null;
  const origin = outcome.metrics['declared_origin'];
  const capturedAt = outcome.metrics['declared_captured_at'];
  const modelsJson = outcome.metrics['declared_models_json'];
  if (typeof origin !== 'string' || origin === '') return null;
  if (typeof capturedAt !== 'string' || capturedAt === '') return null;
  if (typeof modelsJson !== 'string') return null;
  let rawModels: unknown;
  try {
    rawModels = JSON.parse(modelsJson);
  } catch {
    return null;
  }
  if (typeof rawModels !== 'object' || rawModels === null || Array.isArray(rawModels)) return null;
  const models: DeclaredPricingSnapshot['models'] = {};
  for (const [name, value] of Object.entries(rawModels)) {
    // 紧凑格式：name → [modelRatio, completionRatio]（旧账本）或
    // [modelRatio, completionRatio, cacheRatio, modelPrice, quotaType]（本轮起，尾部可空）
    if (!Array.isArray(value) || value.length < 2) continue;
    const modelRatio = value[0];
    const completionRatio = value[1];
    if (typeof modelRatio !== 'number' || !Number.isFinite(modelRatio) || modelRatio < 0) continue;
    if (typeof completionRatio !== 'number' || !Number.isFinite(completionRatio) || completionRatio < 0) continue;
    const model: DeclaredPricingSnapshotModel = { modelRatio, completionRatio };
    if (value.length >= 5) {
      // 旧账本只有两个倍率：缺的列保持 undefined，不额外生成键（深比较/序列化都保持旧形状）
      model.cacheRatio = nullableFinite(value[2]);
      model.modelPrice = nullableFinite(value[3]);
      model.quotaType = nullableFinite(value[4]);
    }
    models[name] = model;
  }
  if (Object.keys(models).length === 0) return null;
  const groupRatio: Record<string, number> = {};
  const groupRatioJson = outcome.metrics['declared_group_ratio_json'];
  if (typeof groupRatioJson === 'string') {
    try {
      const parsed: unknown = JSON.parse(groupRatioJson);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        for (const [group, ratio] of Object.entries(parsed)) {
          if (typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0) groupRatio[group] = ratio;
        }
      }
    } catch {
      // 分组倍率损坏不致命：丢弃分组维度，保留模型倍率快照
    }
  }
  const quotaRaw = outcome.metrics['quota_per_unit'];
  const quotaPerUnit = typeof quotaRaw === 'number' && Number.isFinite(quotaRaw) && quotaRaw > 0 ? quotaRaw : null;
  const quotaSourceRaw = outcome.metrics['quota_per_unit_source'];
  const quotaPerUnitSource =
    quotaSourceRaw === 'site' || quotaSourceRaw === 'cli' || quotaSourceRaw === 'none' ? quotaSourceRaw : undefined;
  const groupRaw = outcome.metrics['declared_group'];
  const group = typeof groupRaw === 'string' && groupRaw !== '' ? groupRaw : null;
  const sourceRaw = outcome.metrics['declared_source'];
  const source =
    typeof sourceRaw === 'string' && (PRICING_SOURCES as readonly string[]).includes(sourceRaw)
      ? (sourceRaw as PricingSource)
      : undefined;
  return {
    origin,
    capturedAt,
    ...(source !== undefined ? { source } : {}),
    quotaPerUnit,
    ...(quotaPerUnitSource !== undefined ? { quotaPerUnitSource } : {}),
    group,
    models,
    groupRatio,
  };
}

function nullableFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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
  const baseline = parsed as BaselineFile;
  // 旧基线（本轮新增 pricing 字段之前生成）没有该字段：补 null 表示「无公示价快照」，
  // 与「有快照但站点没提供公示价」区分不必要——两种情况下倍率漂移检测都不执行。
  if (baseline.pricing === undefined) {
    baseline.pricing = null;
  }
  return baseline;
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
    // metricVersion 可选（旧基线无此字段 = 旧口径）；存在时必须是非空字符串
    if ('metricVersion' in quality && (typeof quality['metricVersion'] !== 'string' || (quality['metricVersion'] as string) === '')) {
      throw fieldError('baseline.quality.metricVersion', '非空字符串', quality['metricVersion']);
    }
    // buildQuality 拒收 total<=0（题集恒 15 题，mainTotal 恒正数）——0 属畸形基线，与口径一致拒收
    if (typeof quality['mainTotal'] !== 'number' || !Number.isFinite(quality['mainTotal']) || quality['mainTotal'] <= 0) {
      throw fieldError('baseline.quality.mainTotal', '正数', quality['mainTotal']);
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

  const pricingRaw = b['pricing'];
  if (pricingRaw !== undefined && pricingRaw !== null) {
    if (typeof pricingRaw !== 'object' || Array.isArray(pricingRaw)) {
      throw fieldError('baseline.pricing', '对象或 null', pricingRaw);
    }
    validatePricingSnapshot(pricingRaw as Record<string, unknown>);
  }
}

/** 公示倍率快照的字段级校验（错误信息含完整字段路径，畸形快照绝不能流入倍率漂移对比）。 */
function validatePricingSnapshot(p: Record<string, unknown>): void {
  for (const key of ['origin', 'capturedAt'] as const) {
    const value = p[key];
    if (typeof value !== 'string' || value.length === 0) {
      throw fieldError(`baseline.pricing.${key}`, '非空字符串', value);
    }
  }
  const quotaPerUnit = p['quotaPerUnit'];
  if (quotaPerUnit !== null && (typeof quotaPerUnit !== 'number' || !Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0)) {
    throw fieldError('baseline.pricing.quotaPerUnit', '正数或 null', quotaPerUnit);
  }
  const group = p['group'];
  if (group !== null && typeof group !== 'string') {
    throw fieldError('baseline.pricing.group', '字符串或 null', group);
  }
  const quotaPerUnitSource = p['quotaPerUnitSource'];
  if (
    quotaPerUnitSource !== undefined &&
    quotaPerUnitSource !== null &&
    (typeof quotaPerUnitSource !== 'string' || !['site', 'cli', 'none'].includes(quotaPerUnitSource))
  ) {
    throw fieldError('baseline.pricing.quotaPerUnitSource', 'null 或 site/cli/none', quotaPerUnitSource);
  }
  const source = p['source'];
  if (
    source !== undefined &&
    source !== null &&
    (typeof source !== 'string' || !(PRICING_SOURCES as readonly string[]).includes(source))
  ) {
    throw fieldError('baseline.pricing.source', `null 或 ${PRICING_SOURCES.join('/')}`, source);
  }
  const models = p['models'];
  if (typeof models !== 'object' || models === null || Array.isArray(models)) {
    throw fieldError('baseline.pricing.models', '对象', models);
  }
  for (const [name, entry] of Object.entries(models)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw fieldError(`baseline.pricing.models.${name}`, '对象', entry);
    }
    const record = entry as Record<string, unknown>;
    for (const key of ['modelRatio', 'completionRatio'] as const) {
      const value = record[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw fieldError(`baseline.pricing.models.${name}.${key}`, '不小于 0 的数字', value);
      }
    }
  }
  const groupRatio = p['groupRatio'];
  if (typeof groupRatio !== 'object' || groupRatio === null || Array.isArray(groupRatio)) {
    throw fieldError('baseline.pricing.groupRatio', '对象', groupRatio);
  }
  for (const [name, value] of Object.entries(groupRatio)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw fieldError(`baseline.pricing.groupRatio.${name}`, '正数', value);
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
    return { comparable: false, skipReason: `基线版本为 ${String(oldBaseline.version)}，仅支持 version=1`, items: [], notes: [] };
  }
  if (oldBaseline.model !== current.model) {
    return {
      comparable: false,
      skipReason: `模型标识不一致（基线 ${oldBaseline.model} vs 本次 ${current.model}）`,
      items: [],
      notes: [],
    };
  }
  if (oldBaseline.probesetVersion !== current.probesetVersion) {
    return {
      comparable: false,
      skipReason: `题集版本不一致（基线 ${oldBaseline.probesetVersion} vs 本次 ${current.probesetVersion}）`,
      items: [],
      notes: [],
    };
  }
  if (oldBaseline.assetsVersion !== current.assetsVersion) {
    return {
      comparable: false,
      skipReason: `资产版本不一致（基线 ${oldBaseline.assetsVersion} vs 本次 ${current.assetsVersion}）`,
      items: [],
      notes: [],
    };
  }

  const items: BaselineDiffItem[] = [];
  const notes: string[] = [];

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
    if (oldBaseline.quality.metricVersion !== current.quality.metricVersion) {
      // 口径不同（旧两次机会 vs 新 pass@1）：两种 accuracy 不可比，混比会把「复采样恢复」
      // 误读成漂移。跳过质量对比并注明，要求重建基线。
      notes.push(
        `基线质量口径与本次不同（基线 ${oldBaseline.quality.metricVersion ?? '旧两次机会口径'} vs 本次 ${current.quality.metricVersion ?? '旧两次机会口径'}），质量漂移对比已跳过；建议用一次正常跑批重建基线。`,
      );
    } else {
      const from = percent(oldBaseline.quality.accuracy);
      const to = percent(current.quality.accuracy);
      // 只对「变差」扣分；用 |Δ| 会把「变好」也判成疑似降智（实测 0/12 → 12/12 被封顶 30、总分 45）
      const drop = oldBaseline.quality.accuracy - current.quality.accuracy;
      const rise = -drop;
      if (oldBaseline.quality.mainTotal > 0 && oldBaseline.quality.accuracy === 0) {
        notes.push(`基线质量为 0/${oldBaseline.quality.mainTotal}（疑似失败跑批或上游故障），质量漂移判据不可靠，已跳过该项对比（本次 ${to}）；建议用一次正常跑批重新生成基线。`);
      } else if (rise > DRIFT_QUALITY_FAIL + DRIFT_EPS) {
        notes.push(`质量首答准确率上升 ${percent(rise)}（${from} → ${to}），不视为降智、不扣分；疑似上游恢复或换成更强模型，可按需人工确认。`);
      } else if (drop > DRIFT_QUALITY_FAIL + DRIFT_EPS) {
        items.push({
          probeId: 'quality',
          level: 'fail',
          cap: 30,
          message: `质量首答准确率下降 ${percent(drop)}（${from} → ${to}），超过 ${percent(DRIFT_QUALITY_FAIL)} 阈值，疑似降智或换模型`,
        });
      } else if (drop > DRIFT_QUALITY_WARN + DRIFT_EPS) {
        items.push({
          probeId: 'quality',
          level: 'warn',
          cap: 70,
          message: `质量首答准确率下降 ${percent(drop)}（${from} → ${to}），超过 ${percent(DRIFT_QUALITY_WARN)} 关注阈值`,
        });
      }
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
      if (absDelta > DRIFT_BILLING_ABS + DRIFT_EPS && relDelta > DRIFT_BILLING_REL + DRIFT_EPS) {
        items.push({
          probeId: 'billing',
          level: 'warn',
          cap: null,
          message: `${label}计费斜率相对基线漂移：${before} → ${after}（相对偏差 ${percent(relDelta)}）`,
        });
      }
    }
  }

  // 公示倍率快照：两侧都非空才逐模型对比（null↔对象/键缺失一律显式降级为 note，绝不静默漏报
  // 也不崩溃）。权威漂移判定在 billing 探针（逐轮对照价格账本、warn 封顶），这里只做补充披露，
  // 记 note 不产 item，避免与账本漂移双重惩罚。
  const oldPricing = oldBaseline.pricing;
  const newPricing = current.pricing;
  const previousSource = oldPricing?.source;
  const currentSource = newPricing?.source;
  const sameSource =
    (previousSource === undefined && currentSource === undefined) ||
    (previousSource !== undefined && currentSource !== undefined && previousSource === currentSource);
  if (oldPricing && newPricing && !sameSource) {
    notes.push(
      `跨来源快照跳过漂移比对（上次来源 ${previousSource ?? '未知（legacy）'}，本轮来源 ${currentSource ?? '未知（legacy）'}）：不同来源的公示价口径不可互换。`,
    );
  } else if (oldPricing && newPricing) {
    const names = [...new Set([...Object.keys(oldPricing.models), ...Object.keys(newPricing.models)])].sort();
    const changed: string[] = [];
    for (const name of names) {
      const before = oldPricing.models[name];
      const after = newPricing.models[name];
      if (!before || !after) {
        changed.push(`${name}（${!before ? '本次新增' : '基线后下架'}）`);
      } else if (before.modelRatio !== after.modelRatio || before.completionRatio !== after.completionRatio) {
        changed.push(`${name} ${before.modelRatio}/${before.completionRatio} → ${after.modelRatio}/${after.completionRatio}`);
      }
    }
    if (changed.length > 0) {
      const digest = changed.length > 5 ? `${changed.slice(0, 5).join('；')} 等 ${changed.length} 项` : changed.join('；');
      notes.push(`公示倍率相对基线变化：${digest}（权威判定见 billing 探针的价格账本漂移对比）。`);
    }
  } else if (oldPricing || newPricing) {
    notes.push(
      '基线或本次运行缺少公示价快照（旧格式基线，或站点未提供公示价接口），公示倍率漂移对比已跳过；该判定由 billing 探针对照价格账本执行。',
    );
  }

  return { comparable: true, skipReason: null, items, notes };
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
