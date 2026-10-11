import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTotal, WEIGHTS } from '../../src/scoring.js';
import type { ProbeOutcome } from '../../src/types.js';

function outcome(id: ProbeOutcome['id'], score: number | null, status: ProbeOutcome['status'] = 'ok'): ProbeOutcome {
  return {
    id,
    status,
    score,
    level: score === null ? 'unknown' : score >= 90 ? 'pass' : score >= 60 ? 'warn' : 'fail',
    headline: `${id} headline`,
    findings: [],
    metrics: {},
  };
}

test('weights sum to 100 across scored probes', () => {
  const sum = WEIGHTS.billing + WEIGHTS.quality + WEIGHTS.identity + WEIGHTS.context + WEIGHTS.capability + WEIGHTS.ttft;
  assert.equal(sum, 100);
});

test('all perfect scores produce 100 and pass', () => {
  const result = computeTotal([
    outcome('identity', 100),
    outcome('context', 100),
    outcome('billing', 100),
    outcome('capability', 100),
    outcome('quality', 100),
    outcome('ttft', null, 'insufficient'),
  ]);
  assert.equal(result.total, 100);
  assert.equal(result.overall, 'pass');
});

test('a zero score short-circuits the total to zero', () => {
  const result = computeTotal([
    outcome('identity', 100),
    outcome('context', 100),
    outcome('billing', 0),
    outcome('capability', 100),
    outcome('quality', 100),
    outcome('ttft', null, 'insufficient'),
  ]);
  assert.equal(result.total, 0);
  assert.equal(result.overall, 'fail');
});

test('hard red below 40 caps the total at 45', () => {
  const result = computeTotal([
    outcome('identity', 100),
    outcome('context', 100),
    outcome('billing', 35),
    outcome('capability', 100),
    outcome('quality', 100),
    outcome('ttft', null, 'insufficient'),
  ]);
  assert.equal(result.total, 45);
  assert.equal(result.overall, 'fail');
});

test('unscorable probes are excluded and logged, weights renormalize', () => {
  const result = computeTotal([
    outcome('identity', 90),
    outcome('context', null, 'insufficient'),
    outcome('billing', 90),
    outcome('capability', 90),
    outcome('quality', 90),
    outcome('ttft', null, 'insufficient'),
  ]);
  assert.equal(result.total, 90);
  assert.ok(result.notes.some((n) => n.includes('未判定项')));
});

test('geometric mean penalizes a single low score', () => {
  const result = computeTotal([
    outcome('identity', 100),
    outcome('context', 100),
    outcome('billing', 100),
    outcome('capability', 100),
    outcome('quality', 49),
    outcome('ttft', null, 'insufficient'),
  ]);
  assert.ok(result.total !== null && result.total < 85);
});

// ---------- 非有限分数守卫 + 可评分项不足分支 ----------

test('non-finite scores (NaN/Infinity) are unscorable, never washed into the log aggregate', () => {
  const result = computeTotal([
    outcome('identity', Number.NaN),
    outcome('context', Number.POSITIVE_INFINITY),
    outcome('billing', 90),
    outcome('capability', 90),
    outcome('quality', 90),
    outcome('ttft', null, 'insufficient'),
  ]);
  // 3 个有限项归一化聚合出分；NaN/Infinity 记入未判定项而非把总分洗成 0
  assert.ok(result.total !== null && result.total > 0 && result.total <= 100);
  assert.ok(result.notes.some((n) => n.includes('identity') && n.includes('context')), JSON.stringify(result.notes));
});

test('fewer than 2 scorable entries: total stays null, overall follows worst observed level', () => {
  const singlePass = computeTotal([outcome('identity', 100)]);
  assert.equal(singlePass.total, null);
  assert.equal(singlePass.overall, 'unknown');

  const singleWarn = computeTotal([outcome('identity', 70)]);
  assert.equal(singleWarn.total, null);
  assert.equal(singleWarn.overall, 'warn');

  const singleFail = computeTotal([outcome('identity', 10)]);
  assert.equal(singleFail.total, null);
  assert.equal(singleFail.overall, 'fail');
  assert.ok(singleFail.notes.some((n) => n.includes('可评分项不足')));
});

// ---------- capability 被证伪罚（fail 级 finding → 总分上限 60 + overall fail） ----------

/** capability outcome 携带指定级别 finding（其余探针默认满分）。 */
function withCapabilityFinding(level: 'warn' | 'fail', score: number): ProbeOutcome[] {
  return [
    outcome('identity', 100),
    outcome('context', 100),
    outcome('billing', 100),
    {
      ...outcome('capability', score),
      findings: [{ level, message: 'vision 可疑：仅 2/3 次识别正确', evidenceIds: [] }],
    },
    outcome('quality', 100),
    outcome('ttft', null, 'insufficient'),
  ];
}

test('capability with a fail finding caps total at 60 and forces overall fail', () => {
  const result = computeTotal(withCapabilityFinding('fail', 100));
  assert.ok(result.total !== null && result.total <= 60, `total=${result.total}`);
  assert.equal(result.overall, 'fail');
  assert.ok(result.notes.some((n) => n.includes('标称能力被证伪') && n.includes('60')), JSON.stringify(result.notes));
});

test('capability with only a warn finding does not trigger the falsified penalty', () => {
  const result = computeTotal(withCapabilityFinding('warn', 100));
  assert.equal(result.total, 100);
  assert.equal(result.overall, 'pass');
  assert.ok(!result.notes.some((n) => n.includes('标称能力被证伪')));
});

test('capability falsified penalty takes min with existing low scores (never raises total)', () => {
  // 其他维度已低分（quality 20）：几何聚合总分已低于 60，封顶取 min 不得抬分
  const result = computeTotal([
    outcome('identity', 100),
    outcome('context', 100),
    outcome('billing', 100),
    {
      ...outcome('capability', 100),
      findings: [{ level: 'fail', message: '标称支持 vision，但端点明确拒绝', evidenceIds: [] }],
    },
    outcome('quality', 20),
    outcome('ttft', null, 'insufficient'),
  ]);
  assert.ok(result.total !== null && result.total < 60, `total=${result.total}`);
  assert.equal(result.overall, 'fail');
});

test('capability fail finding forces fail even when total is already capped by hard red', () => {
  const result = computeTotal([
    outcome('identity', 100),
    outcome('context', 100),
    outcome('billing', 35),
    {
      ...outcome('capability', 100),
      findings: [{ level: 'fail', message: '工具调用参数错误', evidenceIds: [] }],
    },
    outcome('quality', 100),
    outcome('ttft', null, 'insufficient'),
  ]);
  // 硬红线 45 与 capability 证伪 60 并列取 min → 45
  assert.equal(result.total, 45);
  assert.equal(result.overall, 'fail');
});
