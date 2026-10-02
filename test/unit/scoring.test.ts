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
