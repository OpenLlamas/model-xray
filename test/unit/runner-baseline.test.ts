// test/unit/runner-baseline.test.ts —— 基线漂移落到 outcome 的语义：
//   分项可评分 → cap 落分 + 按 cap 升级 level（原有行为）；
//   分项不可评分（score=null，如 insufficient 降级）→ 无 cap 落点，但漂移 level 必须提升 outcome.level——
//   overall 由各分项 level 派生（computeTotal 的 anyFail/anyWarn），否则会出现
//   「FAIL 级『疑似模型被更换』finding 之下 overall=warn/exit 0」的矛盾判定（审计 R2）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBaselineDiff } from '../../src/runner.js';
import type { ProbeOutcome } from '../../src/types.js';
import type { BaselineDiff } from '../../src/baseline.js';

function outcome(overrides: Partial<ProbeOutcome> = {}): ProbeOutcome {
  return {
    id: 'identity',
    status: 'ok',
    score: 90,
    level: 'pass',
    headline: '正常',
    findings: [],
    metrics: {},
    ...overrides,
  };
}

function diff(items: BaselineDiff['items']): BaselineDiff {
  return { comparable: true, skipReason: null, items, notes: [] };
}

test('基线漂移：分项不可评分（insufficient）时 fail 漂移仍提升 outcome.level（防 verdict 与 finding 矛盾）', () => {
  const insufficient = outcome({ status: 'insufficient', score: null, level: 'unknown' });
  applyBaselineDiff([insufficient], diff([{ probeId: 'identity', level: 'fail', cap: 0, message: '指纹漂移：glm → qwen' }]));
  assert.equal(insufficient.level, 'fail', '漂移 fail 必须反映到分项 level');
  assert.equal(insufficient.score, null, '不可评分项保持 score=null（N/A 不入总分）');
  assert.equal(insufficient.findings.length, 1);
});

test('基线漂移：可评分分项走 cap 落分 + 按档升级（原有行为不回退）', () => {
  const scorable = outcome({ score: 90, level: 'pass' });
  applyBaselineDiff([scorable], diff([{ probeId: 'identity', level: 'fail', cap: 0, message: '漂移' }]));
  assert.equal(scorable.score, 0);
  assert.equal(scorable.level, 'fail');

  const capped = outcome({ score: 90, level: 'pass' });
  applyBaselineDiff([capped], diff([{ probeId: 'identity', level: 'warn', cap: 70, message: '小幅漂移' }]));
  assert.equal(capped.score, 70);
  assert.equal(capped.level, 'warn');
});

test('基线漂移：不可评分分项上 warn 漂移升 warn，不夸大为 fail', () => {
  const insufficient = outcome({ id: 'quality', status: 'insufficient', score: null, level: 'unknown' });
  applyBaselineDiff([insufficient], diff([{ probeId: 'quality', level: 'warn', cap: null, message: '正确率漂移' }]));
  assert.equal(insufficient.level, 'warn');
});
