import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linearRegression, mad, median, quantile, stdev, wilsonLowerBound } from '../../src/stats.js';

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
