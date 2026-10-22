import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildBaseline,
  diffBaseline,
  loadBaseline,
  DRIFT_QUALITY_WARN,
  DRIFT_QUALITY_FAIL,
  type BaselineFile,
} from '../../src/baseline.js';
import { PROBESET_VERSION } from '../../src/assets.js';
import type { ProbeOutcome } from '../../src/types.js';

function outcome(id: ProbeOutcome['id'], metrics: ProbeOutcome['metrics']): ProbeOutcome {
  return {
    id,
    status: 'ok',
    score: 100,
    level: 'pass',
    headline: `${id} headline`,
    findings: [],
    metrics,
  };
}

const META = { model: 'gpt-4o', seed: 42, probesetVersion: 'v0.1.0', assetsVersion: 'assets-v0.1.0' };

function sampleOutcomes(): ProbeOutcome[] {
  return [
    outcome('identity', { families: 'claude', schema_compliant: 1, samples: 3, refusals: 1 }),
    outcome('quality', { main: '9/12' }),
    outcome('capability', { vision: 'pass', tool: 'pass', thinking: 'no_reasoning_field' }),
    outcome('billing', { slope_en: 1.0, slope_zh: 1.2 }),
  ];
}

test('buildBaseline extracts fingerprints from probe metrics', () => {
  const baseline = buildBaseline(sampleOutcomes(), META);
  assert.equal(baseline.version, 1);
  assert.equal(baseline.model, 'gpt-4o');
  assert.equal(baseline.seed, 42);
  assert.deepEqual(baseline.identity, { families: ['claude'], schemaCompliant: true, refusalRate: 1 / 3 });
  assert.deepEqual(baseline.quality, { accuracy: 0.75, mainCorrect: 9, mainTotal: 12 });
  assert.deepEqual(baseline.capability, { vision: 'pass', tool: 'pass', thinking: 'no_reasoning_field' });
  assert.deepEqual(baseline.billing, { slopeEn: 1.0, slopeZh: 1.2 });
});

test('buildBaseline maps families none and N/A schema to null/false', () => {
  const baseline = buildBaseline([outcome('identity', { families: 'none', schema_compliant: 'N/A', samples: 0, refusals: 0 })], META);
  assert.deepEqual(baseline.identity?.families, []);
  assert.equal(baseline.identity?.schemaCompliant, null);
  assert.equal(baseline.identity?.refusalRate, 0);
});

test('buildBaseline yields null sections when probes are missing', () => {
  const baseline = buildBaseline([], META);
  assert.equal(baseline.identity, null);
  assert.equal(baseline.quality, null);
  assert.equal(baseline.capability, null);
  assert.equal(baseline.billing, null);
});

function pricingOutcome(source?: string): ProbeOutcome {
  const metrics: ProbeOutcome['metrics'] = {
    declared_origin: 'https://relay.example.com',
    declared_captured_at: '2026-10-01T00:00:00.000Z',
    declared_models_json: JSON.stringify({ 'gpt-4o': [1, 4, null, null, 0] }),
    declared_group_ratio_json: '{}',
    quota_per_unit: 500000,
    declared_group: null,
  };
  if (source !== undefined) metrics['declared_source'] = source;
  return outcome('billing', metrics);
}

test('buildBaseline pricing source：合法值透传，legacy/非法值不生成键', () => {
  const publicBaseline = buildBaseline([pricingOutcome('public-json')], META);
  assert.equal(publicBaseline.pricing?.source, 'public-json');

  const legacy = buildBaseline([pricingOutcome()], META);
  assert.equal(Object.hasOwn(legacy.pricing ?? {}, 'source'), false);

  const invalid = buildBaseline([pricingOutcome('bogus')], META);
  assert.equal(Object.hasOwn(invalid.pricing ?? {}, 'source'), false);
});

test('diffBaseline：公示价快照来源不同 → 跳过数值对比并给出跨来源 note', () => {
  const oldBaseline = buildBaseline([pricingOutcome('api')], META);
  const current = buildBaseline([pricingOutcome('public-json')], META);
  const diff = diffBaseline(oldBaseline, current);
  assert.ok(
    diff.notes.some((note) => note.includes('跨来源快照跳过漂移比对')),
    JSON.stringify(diff.notes),
  );
});

test('loadBaseline accepts version 1 and rejects others', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mx-baseline-'));
  try {
    const good = join(dir, 'good.json');
    writeFileSync(good, JSON.stringify({ ...buildBaseline([], META), createdAt: '2026-01-01T00:00:00Z' }));
    assert.equal(loadBaseline(good).version, 1);

    const badVersion = join(dir, 'bad-version.json');
    writeFileSync(badVersion, JSON.stringify({ ...buildBaseline([], META), version: 2 }));
    assert.throws(() => loadBaseline(badVersion), /基线版本/);

    const badJson = join(dir, 'bad.json');
    writeFileSync(badJson, '{not json');
    assert.throws(() => loadBaseline(badJson), /JSON/);

    const badShape = join(dir, 'shape.json');
    writeFileSync(badShape, '[1,2,3]');
    assert.throws(() => loadBaseline(badShape), /结构非法/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function validBaselineJson(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    model: 'gpt-4o',
    seed: 42,
    createdAt: '2026-01-01T00:00:00Z',
    probesetVersion: 'v0.1.0',
    assetsVersion: 'assets-v0.1.0',
    identity: null,
    quality: null,
    capability: null,
    billing: null,
    ...patch,
  });
}

test('loadBaseline accepts a minimal valid baseline with all dimensions null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mx-baseline-min-'));
  try {
    const path = join(dir, 'min.json');
    writeFileSync(path, validBaselineJson());
    const parsed = loadBaseline(path);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.identity, null);
    assert.equal(parsed.quality, null);
    assert.equal(parsed.capability, null);
    assert.equal(parsed.billing, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateBaseline rejects malformed shapes with field-path errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mx-baseline-bad-'));
  try {
    const write = (name: string, content: string): string => {
      const path = join(dir, name);
      writeFileSync(path, content);
      return path;
    };

    // a. 坏 JSON
    assert.throws(() => loadBaseline(write('a.json', '{not json')), /JSON/);
    // b. 顶层数组
    assert.throws(() => loadBaseline(write('b.json', '[1,2,3]')), /结构非法/);
    // c. version=2
    assert.throws(() => loadBaseline(write('c.json', validBaselineJson({ version: 2 }))), /基线版本/);
    // d. seed 为字符串
    assert.throws(() => loadBaseline(write('d.json', validBaselineJson({ seed: '42' }))), /baseline\.seed/);
    // e. model 为数字
    assert.throws(() => loadBaseline(write('e.json', validBaselineJson({ model: 42 }))), /baseline\.model/);
    // f. identity.families 为字符串
    assert.throws(
      () => loadBaseline(write('f.json', validBaselineJson({ identity: { families: 'gpt', schemaCompliant: true, refusalRate: 0 } }))),
      /baseline\.identity\.families/,
    );
    // g. quality.accuracy 为字符串
    assert.throws(
      () => loadBaseline(write('g.json', validBaselineJson({ quality: { accuracy: 'x', mainCorrect: 1, mainTotal: 2 } }))),
      /baseline\.quality\.accuracy/,
    );
    // h. capability.vision 为数字
    assert.throws(
      () => loadBaseline(write('h.json', validBaselineJson({ capability: { vision: 1 } }))),
      /baseline\.capability\.vision/,
    );
    // i.（附加）billing.slopeEn 为字符串
    assert.throws(
      () => loadBaseline(write('i.json', validBaselineJson({ billing: { slopeEn: '1.0', slopeZh: null } }))),
      /baseline\.billing\.slopeEn/,
    );
    // j. 维度段为对象但缺 families 子键
    assert.throws(() => loadBaseline(write('j.json', validBaselineJson({ identity: {} }))), /baseline\.identity\.families/);
    // k. 维度段为数组/标量（非 null 对象）
    assert.throws(() => loadBaseline(write('k.json', validBaselineJson({ identity: 'oops' }))), /baseline\.identity 应为对象/);
    // l. createdAt 缺类型
    assert.throws(() => loadBaseline(write('l.json', validBaselineJson({ createdAt: 42 }))), /baseline\.createdAt/);
    // m. quality.mainTotal 为负
    assert.throws(
      () => loadBaseline(write('m.json', validBaselineJson({ quality: { accuracy: 0.5, mainCorrect: -1, mainTotal: -2 } }))),
      /baseline\.quality\.mainTotal/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function baselineOf(patch: Partial<BaselineFile> & { version?: number }): BaselineFile {
  return { ...buildBaseline(sampleOutcomes(), META), createdAt: '2026-01-01T00:00:00Z', ...patch } as BaselineFile;
}

test('diffBaseline marks version/versions/model mismatches incomparable', () => {
  const current = baselineOf({});
  for (const patch of [
    { version: 2 },
    { probesetVersion: 'v9.9.9' },
    { assetsVersion: 'assets-v9.9.9' },
    { model: 'claude-sonnet-4-5' },
  ] as Array<Partial<BaselineFile> & { version?: number }>) {
    const diff = diffBaseline(baselineOf(patch), current);
    assert.equal(diff.comparable, false);
    assert.ok(diff.skipReason);
    assert.deepEqual(diff.items, []);
  }
});

test('baseline: probeset_version bump v0.1.0 → current blocks comparison; same version stays comparable', () => {
  // 当前版本应为 v0.2.3（新增 params 协议参数完整性探针；沿承 v0.2.2 quality 抗噪与 v0.2.1 identity 加强）
  assert.equal(PROBESET_VERSION, 'v0.2.3');
  const current = baselineOf({ probesetVersion: PROBESET_VERSION });
  const oldV1 = baselineOf({ probesetVersion: 'v0.1.0' });
  const diff = diffBaseline(oldV1, current);
  assert.equal(diff.comparable, false);
  assert.match(diff.skipReason ?? '', /题集版本/);
  assert.ok(diff.skipReason?.includes('v0.1.0'));
  assert.ok(diff.skipReason?.includes('v0.2.3'));
  // 同版本基线照常可比（不存在版本不可比跳过）
  const same = diffBaseline(baselineOf({ probesetVersion: PROBESET_VERSION }), current);
  assert.equal(same.comparable, true);
});

test('baseline: old ISO-stamp filename format still loads (filename is irrelevant to loadBaseline)', () => {
  // 文件名格式改造（<model>-<本地时间戳>）不得影响旧命名基线的加载——加载只看文件内容
  const dir = mkdtempSync(join(tmpdir(), 'mx-baseline-oldname-'));
  try {
    const oldName = join(dir, 'baseline-2026-10-11T10-09-23-183Z.json');
    writeFileSync(oldName, JSON.stringify({ ...buildBaseline([], META), createdAt: '2026-10-11T10:09:23Z' }));
    const parsed = loadBaseline(oldName);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.model, 'gpt-4o');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('diffBaseline flags disjoint identity families as fail cap 0', () => {
  const diff = diffBaseline(baselineOf({ identity: { families: ['glm'], schemaCompliant: true, refusalRate: 0 } }), baselineOf({}));
  assert.equal(diff.comparable, true);
  const item = diff.items.find((i) => i.probeId === 'identity');
  assert.ok(item);
  assert.equal(item?.level, 'fail');
  assert.equal(item?.cap, 0);
  assert.match(item?.message ?? '', /模型族指纹漂移/);
});

test('diffBaseline keeps silent when identity families overlap or a side is empty', () => {
  const same = diffBaseline(baselineOf({}), baselineOf({}));
  assert.equal(same.items.find((i) => i.probeId === 'identity'), undefined);
  const emptySide = diffBaseline(baselineOf({ identity: null }), baselineOf({}));
  assert.equal(emptySide.items.find((i) => i.probeId === 'identity'), undefined);
});

function qualityBaseline(accuracy: number): BaselineFile {
  return baselineOf({ quality: { accuracy, mainCorrect: Math.round(accuracy * 12), mainTotal: 12 } });
}

test('diffBaseline quality thresholds just below/above 0.15 and 0.30', () => {
  // Δ=0.148（低于 0.15）→ 不触发
  assert.equal(
    diffBaseline(qualityBaseline(0.75), qualityBaseline(0.602)).items.find((i) => i.probeId === 'quality'),
    undefined,
  );
  // Δ=0.155（高于 0.15、低于 0.30）→ warn cap 70
  const warn = diffBaseline(qualityBaseline(0.75), qualityBaseline(0.595)).items.find((i) => i.probeId === 'quality');
  assert.equal(warn?.level, 'warn');
  assert.equal(warn?.cap, 70);
  // Δ=0.299（仍低于 0.30）→ warn
  const near = diffBaseline(qualityBaseline(0.75), qualityBaseline(0.451)).items.find((i) => i.probeId === 'quality');
  assert.equal(near?.level, 'warn');
  assert.equal(near?.cap, 70);
  // Δ=0.301（高于 0.30）→ fail cap 30
  const fail = diffBaseline(qualityBaseline(0.75), qualityBaseline(0.449)).items.find((i) => i.probeId === 'quality');
  assert.equal(fail?.level, 'fail');
  assert.equal(fail?.cap, 30);
  assert.equal(DRIFT_QUALITY_WARN, 0.15);
  assert.equal(DRIFT_QUALITY_FAIL, 0.3);
});

test('diffBaseline skips quality when seeds differ but compares other probes', () => {
  const oldBaseline = baselineOf({
    seed: 999,
    quality: { accuracy: 0.9, mainCorrect: 11, mainTotal: 12 },
    identity: { families: ['glm'], schemaCompliant: true, refusalRate: 0 },
  });
  const diff = diffBaseline(oldBaseline, baselineOf({}));
  assert.equal(diff.comparable, true);
  assert.equal(diff.items.find((i) => i.probeId === 'quality'), undefined);
  assert.ok(diff.items.find((i) => i.probeId === 'identity'));
});

test('diffBaseline warns when a capability degrades from pass', () => {
  const oldBaseline = baselineOf({ capability: { vision: 'pass', tool: 'pass' } });
  const degraded = diffBaseline(oldBaseline, baselineOf({ capability: { vision: 'fail', tool: 'pass' } }));
  const item = degraded.items.find((i) => i.probeId === 'capability');
  assert.equal(item?.level, 'warn');
  assert.equal(item?.cap, 70);
  // na / unknown 不算退化
  const unknown = diffBaseline(oldBaseline, baselineOf({ capability: { vision: 'na', tool: 'pass' } }));
  assert.equal(unknown.items.find((i) => i.probeId === 'capability'), undefined);
});

test('diffBaseline billing slope needs both abs and relative drift', () => {
  const oldBaseline = baselineOf({ billing: { slopeEn: 1.0, slopeZh: null } });
  // Δ=0.5，相对 50% → warn 无 cap
  const drift = diffBaseline(oldBaseline, baselineOf({ billing: { slopeEn: 1.5, slopeZh: null } })).items.find(
    (i) => i.probeId === 'billing',
  );
  assert.equal(drift?.level, 'warn');
  assert.equal(drift?.cap, null);
  // Δ=0.04 < 0.05 → 不触发
  assert.equal(
    diffBaseline(oldBaseline, baselineOf({ billing: { slopeEn: 1.04, slopeZh: null } })).items.find((i) => i.probeId === 'billing'),
    undefined,
  );
  // Δ=0.1 但相对 2% ≤ 20% → 不触发
  assert.equal(
    diffBaseline(baselineOf({ billing: { slopeEn: 5.0, slopeZh: null } }), baselineOf({ billing: { slopeEn: 5.1, slopeZh: null } })).items.find(
      (i) => i.probeId === 'billing',
    ),
    undefined,
  );
  // 任一侧非 number → 不触发
  assert.equal(
    diffBaseline(baselineOf({ billing: { slopeEn: null, slopeZh: null } }), baselineOf({ billing: { slopeEn: 9.9, slopeZh: null } })).items.find(
      (i) => i.probeId === 'billing',
    ),
    undefined,
  );
});

const PRICING_SNAPSHOT = {
  origin: 'https://relay.example.com',
  capturedAt: '2026-01-01T00:00:00Z',
  quotaPerUnit: null,
  group: null,
  models: { 'gpt-4o': { modelRatio: 2, completionRatio: 2 } },
  groupRatio: {},
} as const satisfies NonNullable<BaselineFile['pricing']>;

test('diffBaseline pricing：null↔快照不崩溃，显式降级为 note（旧基线兼容）', () => {
  const withPricing = baselineOf({ pricing: PRICING_SNAPSHOT });
  const withoutPricing = baselineOf({});
  for (const [oldB, newB] of [
    [withoutPricing, withPricing],
    [withPricing, withoutPricing],
    // 键缺失（极旧基线）与 null 同等对待：补 null 后进同一条降级 note 分支
    [{ ...withoutPricing, pricing: undefined } as unknown as BaselineFile, withPricing],
  ] as Array<[BaselineFile, BaselineFile]>) {
    const diff = diffBaseline(oldB, newB);
    assert.equal(diff.comparable, true);
    assert.deepEqual(diff.items, []);
    assert.ok(
      diff.notes.some((n) => n.includes('缺少公示价快照') && n.includes('价格账本')),
      `notes=${diff.notes.join('|')}`,
    );
  }
});

test('diffBaseline pricing：两侧快照倍率变化 → note；一致 → 无 note', () => {
  const oldB = baselineOf({ pricing: PRICING_SNAPSHOT });
  const changed = diffBaseline(
    oldB,
    baselineOf({
      pricing: { ...PRICING_SNAPSHOT, models: { 'gpt-4o': { modelRatio: 3, completionRatio: 2 } } },
    }),
  );
  assert.deepEqual(changed.items, []);
  const note = changed.notes.find((n) => n.includes('公示倍率相对基线变化'));
  assert.ok(note, `notes=${changed.notes.join('|')}`);
  assert.ok(note?.includes('gpt-4o 2/2 → 3/2'));
  assert.ok(note?.includes('价格账本'), 'note 必须注明权威判定在 billing 探针的账本对比');
  // 倍率无变化 → 不产任何 pricing note
  const same = diffBaseline(oldB, baselineOf({ pricing: { ...PRICING_SNAPSHOT, capturedAt: '2026-02-02T00:00:00Z' } }));
  assert.ok(!same.notes.some((n) => n.includes('公示倍率')));
});
