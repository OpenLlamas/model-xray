import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRatioDecision, decideRatio, type RatioArgs, type RatioDecision } from '../../src/probes/billing.js';
import type { BalanceReading, } from '../../src/balance.js';

function reading(patch: Partial<BalanceReading> = {}): BalanceReading {
  return {
    value: 0,
    kind: 'spent_total',
    unit: 'USD',
    endpoint: '/dashboard/billing/usage',
    currency: null,
    ...patch,
  };
}

function args(patch: Partial<RatioArgs> = {}): RatioArgs {
  return {
    before: reading({ value: 1.0 }),
    after: reading({ value: 2.0 }),
    spendDelta: 1.0,
    expectedCost: 1.0,
    ratioDropped: 0,
    regressionLevel: 'pass',
    ...patch,
  };
}

test('decideRatio N/A: balance endpoint unavailable (before/after null)', () => {
  for (const patch of [{ before: null }, { after: null }]) {
    const decision = decideRatio(args(patch));
    assert.equal(decision?.verdict, 'N/A');
    assert.equal(decision?.cap, null);
    assert.equal(decision?.ratio, null);
    assert.equal(decision?.finding.level, 'info');
  }
  assert.match(decideRatio(args({ before: null }))?.finding.message ?? '', /余额端点不可用/);
});

test('decideRatio N/A: two readings from different sources', () => {
  const decision = decideRatio(args({ spendDelta: null }));
  assert.equal(decision?.verdict, 'N/A');
  assert.match(decision?.finding.message ?? '', /不同源/);
});

test('decideRatio N/A: zero delta (granularity / delayed billing)', () => {
  const decision = decideRatio(args({ spendDelta: 0, expectedCost: 1 }));
  assert.equal(decision?.verdict, 'N/A');
  assert.match(decision?.finding.message ?? '', /粒度不足或消费延迟入账/);
});

test('decideRatio N/A: negative delta (suspected recharge interference)', () => {
  const decision = decideRatio(args({ spendDelta: -0.5, expectedCost: 1 }));
  assert.equal(decision?.verdict, 'N/A');
  assert.match(decision?.finding.message ?? '', /充值/);
});

test('decideRatio N/A: no usable usage records (expectedCost zero)', () => {
  const decision = decideRatio(args({ expectedCost: 0 }));
  assert.equal(decision?.verdict, 'N/A');
  assert.match(decision?.finding.message ?? '', /无有效 usage/);
});

test('decideRatio N/A: non-finite ratio (overflowing balance/usage readings)', () => {
  const decision = decideRatio(args({ spendDelta: 1e308, expectedCost: 1e-300 }));
  assert.equal(decision?.verdict, 'N/A');
  assert.equal(decision?.cap, null);
  assert.equal(decision?.ratio, null);
  assert.match(decision?.finding.message ?? '', /越界/);
});

test('decideRatio N/A: negative expectedCost (defensive, prices are validated non-negative upstream)', () => {
  const decision = decideRatio(args({ expectedCost: -1 }));
  assert.equal(decision?.verdict, 'N/A');
  assert.match(decision?.finding.message ?? '', /无有效 usage/);
});

test('decideRatio underflow: ratio rounds to 0, pinned to unit-mismatch warn (not N/A)', () => {
  const decision = decideRatio(args({ spendDelta: 1e-308, expectedCost: 1e308 }));
  assert.equal(decision?.verdict, 'warn');
  assert.match(decision?.finding.message ?? '', /单位错配/);
});

test('decideRatio masked dual-code: dropped usage masks an underlying fail, surfaced via maskedVerdict', () => {
  // 偏差推演：2 笔 usage 缺失 → 这些请求的应缴金额未计入 expectedCost → 分母偏小 → ratio 上偏
  //（只能把档位往 fail 方向高判，采信会冤枉端点）。无缺失重算：ratio = 3/1.5 = 2.0 > 1.5
  // 且 regressionLevel='fail' → 底层档位 fail（下限推理仍成立，因为上偏只会更高）。
  // 因此 verdict 保守降为 ok/info，但事实经 maskedVerdict 双码透出，CI 可见不被静默吞掉。
  const decision = decideRatio(args({ spendDelta: 3, expectedCost: 1.5, ratioDropped: 2, regressionLevel: 'fail' }));
  assert.equal(decision?.verdict, 'ok');
  assert.equal(decision?.finding.level, 'info');
  assert.equal(decision?.maskedVerdict, 'fail');
  assert.match(decision?.finding.message ?? '', /usage 缺失/);
  assert.match(decision?.finding.message ?? '', /底层档位为 fail/);
});

test('decideRatio masked dual-code: underlying warn tier also surfaced (ratio in (1.1,1.5])', () => {
  const decision = decideRatio(args({ spendDelta: 1.3, expectedCost: 1, ratioDropped: 1 }));
  assert.equal(decision?.verdict, 'ok');
  assert.equal(decision?.finding.level, 'info');
  assert.equal(decision?.maskedVerdict, 'warn');
  assert.match(decision?.finding.message ?? '', /底层档位为 warn/);
});

test('decideRatio: dropped usage samples yield reference-only info without cap', () => {
  const decision = decideRatio(args({ ratioDropped: 2 }));
  assert.equal(decision?.verdict, 'ok');
  assert.equal(decision?.cap, null);
  assert.equal(decision?.finding.level, 'info');
  assert.equal(decision?.maskedVerdict, null);
  assert.match(decision?.finding.message ?? '', /2 笔请求 usage 缺失/);
  assert.equal(decision?.ratio, 1.0);
});

test('decideRatio four tiers on healthy regression', () => {
  const fail = decideRatio(args({ spendDelta: 3, expectedCost: 1.5 }));
  assert.equal(fail?.verdict, 'fail');
  assert.equal(fail?.cap, 30);
  assert.equal(fail?.finding.level, 'fail');

  const warn = decideRatio(args({ spendDelta: 1.3, expectedCost: 1 }));
  assert.equal(warn?.verdict, 'warn');
  assert.equal(warn?.cap, 70);
  assert.equal(warn?.finding.level, 'warn');

  const ok = decideRatio(args({ spendDelta: 1.0, expectedCost: 1 }));
  assert.equal(ok?.verdict, 'ok');
  assert.equal(ok?.cap, null);
  assert.equal(ok?.finding.level, 'info');

  const low = decideRatio(args({ spendDelta: 0.4, expectedCost: 1 }));
  assert.equal(low?.verdict, 'warn');
  assert.equal(low?.cap, null);
  assert.equal(low?.finding.level, 'warn');
  assert.match(low?.finding.message ?? '', /单位错配/);
});

test('decideRatio tier boundaries: 1.5 stays warn, 1.1 and 0.5 stay info', () => {
  assert.equal(decideRatio(args({ spendDelta: 1.5, expectedCost: 1 }))?.verdict, 'warn');
  assert.equal(decideRatio(args({ spendDelta: 1.1, expectedCost: 1 }))?.verdict, 'ok');
  assert.equal(decideRatio(args({ spendDelta: 0.5, expectedCost: 1 }))?.verdict, 'ok');
});

test('decideRatio on failed regression: ratio>1.5 still fails without cap, else info only', () => {
  const fail = decideRatio(args({ spendDelta: 3, expectedCost: 1.5, regressionLevel: 'fail' }));
  assert.equal(fail?.verdict, 'fail');
  assert.equal(fail?.cap, null);
  assert.equal(fail?.finding.level, 'fail');
  assert.match(fail?.finding.message ?? '', /端点自报 usage/);

  const info = decideRatio(args({ spendDelta: 1.0, expectedCost: 1, regressionLevel: 'fail' }));
  assert.equal(info?.verdict, 'ok');
  assert.equal(info?.cap, null);
  assert.equal(info?.finding.level, 'info');
  assert.match(info?.finding.message ?? '', /倍率无法判定/);
});

test('decideRatio round guard: huge ratios keep magnitude, never degrade to Infinity', () => {
  const huge = decideRatio(args({ spendDelta: 1e300, expectedCost: 1, regressionLevel: 'pass' }));
  assert.equal(huge?.verdict, 'fail');
  assert.match(huge?.finding.message ?? '', /1e\+300/);
  assert.ok(!(huge?.finding.message ?? '').includes('Infinity'), huge?.finding.message);

  // 1e308 * 1000 会溢出为 Infinity：无守卫时消息里会出现 "Infinity"
  const overflow = decideRatio(args({ spendDelta: 1e308, expectedCost: 1, regressionLevel: 'pass' }));
  assert.equal(overflow?.verdict, 'fail');
  assert.match(overflow?.finding.message ?? '', /1e\+308/);
  assert.ok(!(overflow?.finding.message ?? '').includes('Infinity'), overflow?.finding.message);
});

test('applyRatioDecision never composes into a null score', () => {
  const failDecision = decideRatio(args({ spendDelta: 3, expectedCost: 1.5 }))!;
  const kept = applyRatioDecision(null, 'unknown', failDecision);
  assert.equal(kept.score, null);
  assert.equal(kept.level, 'unknown');

  const noDecision = applyRatioDecision(null, 'unknown', null);
  assert.equal(noDecision.score, null);
  assert.equal(noDecision.level, 'unknown');
});

test('applyRatioDecision caps numeric scores and re-derives level', () => {
  const failDecision = decideRatio(args({ spendDelta: 3, expectedCost: 1.5 }))!; // cap 30
  const failed = applyRatioDecision(100, 'pass', failDecision);
  assert.equal(failed.score, 30);
  assert.equal(failed.level, 'fail');

  const warnCapped = applyRatioDecision(100, 'pass', decideRatio(args({ spendDelta: 1.3, expectedCost: 1 }))!);
  assert.equal(warnCapped.score, 70);
  assert.equal(warnCapped.level, 'warn');

  const warnNoCap = applyRatioDecision(100, 'pass', decideRatio(args({ spendDelta: 0.4, expectedCost: 1 }))!);
  assert.equal(warnNoCap.score, 100);
  assert.equal(warnNoCap.level, 'warn');

  const info = applyRatioDecision(100, 'pass', decideRatio(args({ spendDelta: 1.0, expectedCost: 1 }))!);
  assert.equal(info.score, 100);
  assert.equal(info.level, 'pass');

  // cap 只往下压，不抬高
  const alreadyLow = applyRatioDecision(20, 'fail', failDecision);
  assert.equal(alreadyLow.score, 20);
  assert.equal(alreadyLow.level, 'fail');
});

test('applyRatioDecision guards: non-finite score/cap bypass cap math', () => {
  const failDecision = decideRatio(args({ spendDelta: 3, expectedCost: 1.5 }))!; // cap 30

  // score 非有限（防御分支）：整体不合成，level 原样返回，NaN 不被 Math.min 污染成 cap 值
  const nanScore = applyRatioDecision(Number.NaN, 'pass', failDecision);
  assert.ok(Number.isNaN(nanScore.score));
  assert.equal(nanScore.level, 'pass');

  // score Infinity 同样被有限性守卫拦下：不进 Math.min，不把异常输入「洗白」成有限分
  //（管道内 score 恒为有限值：起点 100、只被有限 cap 下压，此处纯防御）
  const infiniteScore = applyRatioDecision(Number.POSITIVE_INFINITY, 'pass', failDecision);
  assert.equal(infiniteScore.score, Number.POSITIVE_INFINITY);
  assert.equal(infiniteScore.level, 'pass');

  // cap NaN / cap Infinity：跳过封顶但 finding.level 仍然升档
  const capNaN: RatioDecision = {
    verdict: 'fail',
    maskedVerdict: null,
    cap: Number.NaN,
    ratio: 2,
    finding: { level: 'fail', message: '', evidenceIds: [] },
  };
  const keptNaN = applyRatioDecision(100, 'pass', capNaN);
  assert.equal(keptNaN.score, 100);
  assert.equal(keptNaN.level, 'fail');

  const capInfinity: RatioDecision = { ...capNaN, cap: Number.POSITIVE_INFINITY };
  const keptInfinity = applyRatioDecision(100, 'pass', capInfinity);
  assert.equal(keptInfinity.score, 100);
  assert.equal(keptInfinity.level, 'fail');
});
