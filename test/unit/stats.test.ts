import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linearRegression, mad, median, quantile, stdev, wilsonLowerBound, wilsonUpperBound } from '../../src/stats.js';

test('quantile: interpolation and edges', () => {
  const xs = [1, 2, 3, 4, 5];
  assert.equal(quantile(xs, 0), 1);
  assert.equal(quantile(xs, 1), 5);
  assert.equal(quantile(xs, 0.5), 3);
  assert.equal(quantile(xs, 0.25), 2);
});

test('quantile: NaN q falls back to median, out-of-range q clamps', () => {
  const xs = [10, 20, 30, 40];
  assert.equal(quantile(xs, Number.NaN), 25);
  assert.equal(quantile(xs, -1), 10);
  assert.equal(quantile(xs, 2), 40);
});

test('median and mad', () => {
  assert.equal(median([1, 3, 2]), 2);
  assert.equal(mad([1, 2, 3, 4, 5]), 1);
});

test('linearRegression: exact line', () => {
  const xs = [1, 2, 3, 4];
  const ys = xs.map((x) => 3 * x + 7);
  const reg = linearRegression(xs, ys);
  assert.equal(reg.slope, 3);
  assert.equal(reg.intercept, 7);
  assert.equal(reg.r2, 1);
});

test('linearRegression: noisy series keeps r2 in range', () => {
  const xs = [100, 200, 300, 400];
  const ys = [104, 193, 311, 402];
  const reg = linearRegression(xs, ys);
  assert.ok(reg.r2 > 0.9 && reg.r2 <= 1);
  assert.ok(reg.slope > 0.9 && reg.slope < 1.1);
});

test('stdev and wilson', () => {
  assert.equal(stdev([5, 5, 5]), 0);
  const lower = wilsonLowerBound(10, 10);
  assert.ok(lower > 0.5 && lower < 1);
  assert.equal(wilsonLowerBound(0, 0), 0);
  assert.ok(wilsonLowerBound(5, 10) >= 0 && wilsonLowerBound(5, 10) <= 1);
  assert.ok(wilsonLowerBound(-3, 10) >= 0);
  assert.ok(wilsonLowerBound(99, 10) <= 1);
});

test('wilson guard: non-finite or non-positive totals return 0 (no >1 pseudo-lower-bound, no NaN propagation)', () => {
  assert.equal(wilsonLowerBound(Number.NaN, 10), 0);
  assert.equal(wilsonLowerBound(5, Number.NaN), 0);
  assert.equal(wilsonLowerBound(5, Number.POSITIVE_INFINITY), 0);
  assert.equal(wilsonLowerBound(5, -1), 0);
  assert.equal(wilsonLowerBound(5, 0), 0);
});

test('wilsonUpperBound mirrors lower bound and stays in [0,1]', () => {
  const upper = wilsonUpperBound(10, 10);
  assert.ok(upper > 0.5 && upper <= 1);
  assert.ok(wilsonUpperBound(0, 0) === 1);
  assert.ok(wilsonUpperBound(5, 10) >= 0 && wilsonUpperBound(5, 10) <= 1);
  assert.ok(wilsonUpperBound(-3, 10) >= 0);
  assert.ok(wilsonUpperBound(99, 10) <= 1);

  // 镜像性：successes 与 total-successes 互换时上下界互补（同一区间两端）
  const low = wilsonLowerBound(7, 20, 1.96);
  const high = wilsonUpperBound(13, 20, 1.96);
  assert.ok(Math.abs(low + high - 1) < 1e-9, `low=${low} high=${high}`);

  // 守卫对称：total 非正/非有限时上界返回 1（与下界 0 组成完整 [0,1] 不确定区间）
  assert.equal(wilsonUpperBound(Number.NaN, 10), 1);
  assert.equal(wilsonUpperBound(5, Number.NaN), 1);
  assert.equal(wilsonUpperBound(5, 0), 1);
  assert.equal(wilsonUpperBound(5, -1), 1);
});
