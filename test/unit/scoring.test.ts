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

test('weights sum to 90 across scored probes; TTFT is observation-only (weight 0)', () => {
  const sum = WEIGHTS.billing + WEIGHTS.quality + WEIGHTS.identity + WEIGHTS.context + WEIGHTS.capability;
  assert.equal(sum, 90);
  assert.equal(WEIGHTS.ttft, 0);
  assert.equal(WEIGHTS.decoy, 0);
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
  assert.ok(result.notes.some((n) => n.includes('评分覆盖：已判定 75/90 权重')), JSON.stringify(result.notes));
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

test('fewer than 2 scorable entries: total stays null, unknown unless billing/identity hard fail', () => {
  const singlePass = computeTotal([outcome('identity', 100)]);
  assert.equal(singlePass.total, null);
  assert.equal(singlePass.overall, 'unknown');

  // warn 不再作为结论档派生（无总分且无实锤 → 一律 unknown，展示层只给分数）
  const singleWarn = computeTotal([outcome('identity', 70)]);
  assert.equal(singleWarn.total, null);
  assert.equal(singleWarn.overall, 'unknown');

  // 身份维度 fail（明显换壳）= 实锤：即使无总分也判不通过
  const singleFail = computeTotal([outcome('identity', 10)]);
  assert.equal(singleFail.total, null);
  assert.equal(singleFail.overall, 'fail');
  assert.ok(singleFail.notes.some((n) => n.includes('可评分项不足')));
});

// ---------- capability 被证伪罚（fail 级 finding → 总分上限 60，只压分数不触发不通过） ----------

/** capability outcome 携带指定级别 finding（其余探针默认满分）。 */
function withCapabilityFinding(level: 'warn' | 'fail', score: number): ProbeOutcome[] {
  return [
    outcome('identity', 100),
    outcome('context', 100),
    outcome('billing', 100),
    {
      ...outcome('capability', score),
      findings: [{ level, message: 'vision 未全对：仅 2/3 次识别正确', evidenceIds: [] }],
    },
    outcome('quality', 100),
    outcome('ttft', null, 'insufficient'),
  ];
}

test('capability with a fail finding caps total at 60 (score-only, no overall fail)', () => {
  const result = computeTotal(withCapabilityFinding('fail', 100));
  assert.ok(result.total !== null && result.total <= 60, `total=${result.total}`);
  // 计费/身份均 pass：证伪只封顶分数，不触发整体不通过（60 < 75 → 内部 warn，展示层只出分数）
  assert.equal(result.overall, 'warn');
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
  assert.equal(result.overall, 'warn');
});

test('billing hard fail forces overall fail even when total is already capped by hard red', () => {
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
  // 计费维度 fail（乱收费实锤）→ 整体不通过
  assert.equal(result.overall, 'fail');
});

// ---------- 整体不通过的唯一触发面：计费/身份维度 fail（乱收费/明显换壳） ----------

test('non-billing/non-identity dim fails (context/quality) stay score-only, never overall fail', () => {
  const result = computeTotal([
    outcome('identity', 100),
    outcome('context', 30),
    outcome('billing', 100),
    outcome('capability', 100),
    outcome('quality', 10),
    outcome('ttft', null, 'insufficient'),
  ]);
  // 上下文/质量双双跌破 40 → 硬红线封顶 45，但不通过不触发（仅计费/身份实锤触发）
  assert.ok(result.total !== null && result.total <= 45, `total=${result.total}`);
  assert.equal(result.overall, 'warn');
});

test('identity hard fail (明显换壳) forces overall fail', () => {
  const result = computeTotal([
    outcome('identity', 0),
    outcome('context', 100),
    outcome('billing', 100),
    outcome('capability', 100),
    outcome('quality', 100),
    outcome('ttft', null, 'insufficient'),
  ]);
  assert.equal(result.overall, 'fail');
});

// ---------- 实锤封顶：定罪维度不保留及格分 ----------

test('实锤 fail 维度分项分与总分均封顶 45（换芯实锤时 billing 残余 70 → 45）', () => {
  const result = computeTotal([
    outcome('identity', 100),
    outcome('context', 100),
    // 真机口径：换芯回显 fail 由 billing.ts 封顶 PRICING_FAILED_SCORE=70，档位 fail；
    // 70 是及格分，违反「定罪维度不保留及格分」的常理，必须在聚合层压到 45。
    { ...outcome('billing', 70), level: 'fail' as const },
    outcome('capability', 100),
    outcome('quality', 100),
    outcome('ttft', null, 'insufficient'),
  ]);
  const billing = result.scores.find((s) => s.id === 'billing');
  assert.equal(billing?.level, 'fail');
  assert.equal(billing?.score, 45, `定罪维度分项分必须封顶 45，实得 ${billing?.score}`);
  assert.equal(result.total, 45, `hardFail 时总分同样封顶 45（不通过不得配及格区总分），实得 ${result.total}`);
  assert.equal(result.overall, 'fail');
  assert.ok(result.notes.some((n) => n.includes('实锤封顶')), JSON.stringify(result.notes));
  assert.ok(result.notes.some((n) => n.includes('可信度总分上限 45')), JSON.stringify(result.notes));
});

test('实锤封顶与 null 总分路径的顺序锁定：唯一 fail 项（70）封顶 45，总分仍 null/不通过', () => {
  // 锁定顺序：分项封顶在任何总分早退（可评分项不足/核心维度未判定/覆盖率不足）之前执行；
  // null 总分路径绝不允许 Math.min(null, 45) 把「未判定」洗成 0。
  const result = computeTotal([
    { ...outcome('billing', 70), level: 'fail' as const },
    outcome('identity', null, 'insufficient'),
    outcome('context', null, 'insufficient'),
    outcome('capability', null, 'insufficient'),
    outcome('quality', null, 'insufficient'),
  ]);
  const billing = result.scores.find((s) => s.id === 'billing');
  assert.equal(billing?.score, 45, `null 总分路径下分项仍必须封顶：${billing?.score}`);
  assert.equal(result.total, null, '唯一可评分项 <2 → 总分必须保持 null，不得被封顶逻辑洗成 0');
  assert.equal(result.overall, 'fail');
  assert.ok(result.notes.some((n) => n.includes('实锤封顶')), JSON.stringify(result.notes));
  assert.ok(!result.notes.some((n) => n.includes('可信度总分上限 45')), '总分封顶注记不得出现在 null 总分路径');
});

test('实锤总分封顶注记仅在封顶实际生效时出现（几何聚合已低于 45 不加注）', () => {
  const result = computeTotal([
    outcome('identity', 100),
    outcome('context', 100),
    { ...outcome('billing', 35), level: 'fail' as const },
    outcome('capability', 100),
    outcome('quality', 10),
    outcome('ttft', null, 'insufficient'),
  ]);
  assert.equal(result.overall, 'fail');
  assert.ok(result.total !== null && result.total < 45, `几何聚合实值应低于 45：${result.total}`);
  assert.ok(!result.notes.some((n) => n.includes('可信度总分上限 45')), JSON.stringify(result.notes));
  assert.ok(result.notes.some((n) => n.includes('硬红线')), '低分走既有硬红线口径');
});

test('非实锤维度 fail（context/quality）不受实锤总分封顶影响（硬红线 45 照旧）', () => {
  const result = computeTotal([
    outcome('identity', 100),
    outcome('context', 30),
    outcome('billing', 100),
    outcome('capability', 100),
    outcome('quality', 10),
    outcome('ttft', null, 'insufficient'),
  ]);
  // context/quality 已跌破 40：分项分本身 ≤45 不触发封顶，总分走硬红线 45（非 hardFail 路径）；
  // 几何聚合实值 43 < 45，封顶取 min 不抬分
  assert.ok(result.total !== null && result.total <= 45, `total=${result.total}`);
  assert.equal(result.overall, 'warn');
  assert.ok(!result.notes.some((n) => n.includes('可信度总分上限 45')), JSON.stringify(result.notes));
});

// ---------- 覆盖率门槛：核心维度不可测 / 覆盖不足时不得出总分 ----------

test('核心维度 quality 未判定时总分不出（billing+identity 高分不得外推为整体可信度）', () => {
  const result = computeTotal(
    [
      outcome('identity', 80),
      outcome('context', null, 'insufficient'),
      outcome('billing', 100),
      outcome('capability', null, 'insufficient'),
      outcome('quality', null, 'insufficient'),
    ],
    { claimedContext: false, expectedCapabilities: [] },
  );
  assert.equal(result.total, null, '真机实证：quality 全空 + billing 100 曾报 96，必须改为未判定');
  // warn 不再作为结论档：无总分且无计费/身份实锤 → 一律 unknown（展示层只给分数）
  assert.equal(result.overall, 'unknown');
  assert.ok(result.notes.some((n) => n.includes('核心维度 quality')), JSON.stringify(result.notes));
});

test('核心维度 billing 未判定时总分同样不出', () => {
  const result = computeTotal(
    [
      outcome('identity', 100),
      outcome('billing', null, 'insufficient'),
      outcome('quality', 100),
    ],
    { claimedContext: false, expectedCapabilities: [] },
  );
  assert.equal(result.total, null);
  assert.ok(result.notes.some((n) => n.includes('核心维度 billing')), JSON.stringify(result.notes));
});

test('未声明的 context/capability 不计入覆盖率分母（默认命令仍可给出总分）', () => {
  const result = computeTotal(
    [
      outcome('identity', null, 'insufficient'),
      outcome('context', null, 'insufficient'),
      outcome('billing', 100),
      outcome('capability', null, 'insufficient'),
      outcome('quality', 100),
    ],
    { claimedContext: false, expectedCapabilities: [] },
  );
  assert.equal(result.total, 100);
  assert.ok(result.notes.some((n) => n.includes('已判定 50/65 权重')), JSON.stringify(result.notes));
});

test('覆盖率低于 60% 时总分不出（即使核心维度已判定）', () => {
  const result = computeTotal([
    outcome('identity', null, 'insufficient'),
    outcome('context', null, 'insufficient'),
    outcome('billing', 100),
    outcome('capability', null, 'insufficient'),
    outcome('quality', 100),
  ]);
  // 默认 scope 包含 context/capability：50/90 = 56%
  assert.equal(result.total, null);
  assert.ok(result.notes.some((n) => n.includes('评分覆盖不足')), JSON.stringify(result.notes));
});
