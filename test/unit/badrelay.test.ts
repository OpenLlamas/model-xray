import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BADRELAY_MATRIX, auditScenario, levelOf } from './badrelay-fixture.js';
import type { ProbeId } from '../../src/types.js';

test('badrelay 标定台：坏中转模式检出矩阵（逐维度等级断言）', { timeout: 240000 }, async () => {
  for (const scenario of BADRELAY_MATRIX) {
    const report = await auditScenario(scenario);
    for (const [id, expected] of Object.entries(scenario.expect)) {
      const actual = levelOf(report, id as ProbeId | 'overall');
      assert.equal(actual, expected, `[${scenario.name}] ${id} 期望 ${expected}，实际 ${actual}`);
    }
  }
});

test('badrelay 组合作弊：billing shape-only pass 必须披露「等比缩放不可见 + 未做绝对对账」，且评分不超过 85', async () => {
  const scenario = BADRELAY_MATRIX.find((s) => s.name === 'combined-usage-relabel-truncate');
  assert.ok(scenario !== undefined);
  const report = await auditScenario(scenario);
  const billing = report.outcomes.find((o) => o.id === 'billing');
  assert.ok(billing !== undefined);
  assert.equal(billing.level, 'pass');
  assert.ok(billing.score !== null && billing.score <= 85, `shape-only 上限 85（实际 ${billing.score}）`);
  assert.equal(billing.metrics['evidence_level'], 'shape-only');
  assert.ok(
    billing.findings.some((f) => /等比缩放.*不可见|未做绝对对账/.test(f.message)),
    JSON.stringify(billing.findings),
  );
});

test('badrelay honest 基线：overall pass 且评分健康（反锚点）', async () => {
  const scenario = BADRELAY_MATRIX.find((s) => s.name === 'honest');
  assert.ok(scenario !== undefined);
  const report = await auditScenario(scenario);
  assert.equal(report.overall, 'pass', JSON.stringify(report.outcomes.map((o) => ({ id: o.id, level: o.level, headline: o.headline }))));
  assert.ok(report.total !== null && report.total >= 90, `honest 基线总分应 ≥90（实际 ${report.total}）`);
});