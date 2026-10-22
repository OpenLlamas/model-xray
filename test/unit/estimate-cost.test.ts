import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateCost } from '../../src/cli.js';
import type { RunConfig } from '../../src/types.js';

function cfg(overrides: Partial<RunConfig>): RunConfig {
  return {
    deep: false,
    claimedContext: 32000,
    expect: [],
    ...overrides,
  } as RunConfig;
}

test('estimateCost: low-cost default (1 sample/depth, 5 billing levels, 9 TTFT calls, 10 params calls)', () => {
  const standard = estimateCost(cfg({}));
  assert.equal(standard.calls, 68);
  assert.equal(standard.inputTokens, 240600);
  assert.equal(estimateCost(cfg({ deep: true })).calls, 107);
  assert.equal(estimateCost(cfg({ expect: ['vision', 'tool'] })).calls, 73);
  // 统计定论档（用户显式 --context-samples 3）保留 2 发确认复采
  assert.equal(estimateCost(cfg({ contextSamples: 3 })).calls, 82);
});
