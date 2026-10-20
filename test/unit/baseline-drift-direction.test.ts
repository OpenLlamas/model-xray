// test/unit/baseline-drift-direction.test.ts —— 质量漂移判据的方向性与披露：
//   · 只对「变差」扣分（原 |Δ| 把「变好」也判成疑似降智：实测基线 0/12 → 本次 12/12 被封顶 30、总分 45）；
//   · 基线本身 0/N 全错时判据不可靠 → 只披露 notes，不封顶；
//   · 封顶时 headline 同步标注，避免「标题说题集通过、分数 30」的矛盾呈现。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffBaseline, type BaselineFile } from '../../src/baseline.js';
import { applyBaselineDiff } from '../../src/runner.js';
import type { ProbeOutcome } from '../../src/types.js';

function base(accuracy: number, mainCorrect: number, mainTotal: number): BaselineFile {
  return {
    version: 1,
    model: 'glm-5.3-flash',
    seed: 42,
    createdAt: '2026-10-17T00:00:00.000Z',
    probesetVersion: 'v0.2.1',
    assetsVersion: 'assets-v0.1.0',
    identity: { families: ['glm'], schemaCompliant: true, refusalRate: 0 },
    quality: { accuracy, mainCorrect, mainTotal },
    capability: null,
    billing: null,
    pricing: null,
  };
}

function qualityOutcome(): ProbeOutcome {
  return {
    id: 'quality',
    status: 'ok',
    score: 100,
    level: 'pass',
    headline: '质量题集通过：主题 12/12（控制题全对）',
    findings: [],
    metrics: {},
  };
}

test('质量漂移：准确率上升（0/12 → 12/12）→ 不扣分，只披露', () => {
  const diff = diffBaseline(base(0, 0, 12), base(1, 12, 12));
  const qualityItems = diff.items.filter((i) => i.probeId === 'quality');
  assert.equal(qualityItems.length, 0, `上升方向不应产生扣分项：${JSON.stringify(qualityItems)}`);
  assert.ok(diff.notes.some((n) => n.includes('不可靠')), '基线全错应披露判据不可靠');
  const outcome = qualityOutcome();
  applyBaselineDiff([outcome], diff);
  assert.equal(outcome.score, 100);
  assert.equal(outcome.level, 'pass');
});

test('质量漂移：准确率上升（50% → 100%）→ 不扣分，只披露「上升」', () => {
  const diff = diffBaseline(base(0.5, 6, 12), base(1, 12, 12));
  assert.equal(diff.items.filter((i) => i.probeId === 'quality').length, 0);
  assert.ok(diff.notes.some((n) => n.includes('上升')), `应披露上升：${JSON.stringify(diff.notes)}`);
});

test('质量漂移：准确率下降（100% → 50%）→ 仍按 fail 封顶 30 且 headline 标注', () => {
  const diff = diffBaseline(base(1, 12, 12), base(0.5, 6, 12));
  const item = diff.items.find((i) => i.probeId === 'quality');
  assert.equal(item?.level, 'fail');
  assert.equal(item?.cap, 30);
  const outcome = qualityOutcome();
  applyBaselineDiff([outcome], diff);
  assert.equal(outcome.score, 30);
  assert.equal(outcome.level, 'fail');
  assert.match(outcome.headline, /基线漂移封顶 30/, 'headline 必须标注封顶原因');
});

test('质量漂移：小幅下降（100% → 90%）不扣分；（100% → 80%）→ warn 封顶 70', () => {
  const small = diffBaseline(base(1, 20, 20), base(0.9, 18, 20));
  assert.equal(small.items.filter((i) => i.probeId === 'quality').length, 0);
  const over = diffBaseline(base(1, 20, 20), base(0.8, 16, 20));
  const item = over.items.find((i) => i.probeId === 'quality');
  assert.equal(item?.level, 'warn');
  assert.equal(item?.cap, 70);
});

test('阈值边界：恰好 30% 降幅（0.9 → 0.6）判 warn 封顶 70，不得因浮点噪声进 fail', () => {
  // 0.9 - 0.6 = 0.30000000000000004 > 0.3，裸比较会误判 fail（红队审查 2026-10-18 实证）
  assert.ok(0.9 - 0.6 > 0.3, '前置断言：裸浮点比较确实越界，回归才有意义');
  const item = diffBaseline(base(0.9, 9, 10), base(0.6, 6, 10)).items.find((i) => i.probeId === 'quality');
  assert.equal(item?.level, 'warn');
  assert.equal(item?.cap, 70);
  // 反向：恰好 30% 上升只披露 notes，不产出扣分项
  const rise = diffBaseline(base(0.6, 6, 10), base(0.9, 9, 10));
  assert.equal(rise.items.filter((i) => i.probeId === 'quality').length, 0);
  assert.equal(rise.notes.filter((n) => n.includes('上升')).length, 0);
  // 超过阈值仍必须 fail（容忍不得变成漏报）
  const realDrop = diffBaseline(base(0.9, 9, 10), base(0.5, 5, 10)).items.find((i) => i.probeId === 'quality');
  assert.equal(realDrop?.level, 'fail');
  assert.equal(realDrop?.cap, 30);
});

test('质量漂移：seed 不同 → 该项跳过且不产出任何质量 notes', () => {
  const current = { ...base(1, 12, 12), seed: 43 };
  const diff = diffBaseline(base(0, 0, 12), current);
  assert.equal(diff.items.filter((i) => i.probeId === 'quality').length, 0);
  assert.equal(diff.notes.filter((n) => n.includes('质量')).length, 0);
});

test('质量漂移：metricVersion 口径不同（旧两次机会 vs pass@1）→ 跳过质量对比并注明，不产出扣分项', () => {
  // 2026-10-19 pass@1 改口径：旧基线 accuracy 是两次机会口径，混比会把「复采样恢复」
  // 误读成漂移（基线 0.5 两次机会 ≈ pass@1 0.58 时更是反向假漂移）——必须跳过。
  const oldBaseline = { ...base(0.5, 6, 12), quality: { accuracy: 0.5, mainCorrect: 6, mainTotal: 12 } };
  const current = { ...base(0.42, 5, 12), quality: { accuracy: 0.42, mainCorrect: 5, mainTotal: 12, metricVersion: 'pass1' } };
  const diff = diffBaseline(oldBaseline, current);
  assert.equal(diff.comparable, true, '其余维度仍可比');
  assert.equal(diff.items.filter((i) => i.probeId === 'quality').length, 0);
  assert.ok(diff.notes.some((n) => /口径与本次不同|重建基线/.test(n)), JSON.stringify(diff.notes));
  // 同口径（双 pass1）→ 正常比较（此处 50% → 42% 降幅 8% < 15% → 无项）
  const same = diffBaseline(
    { ...oldBaseline, quality: { accuracy: 0.5, mainCorrect: 6, mainTotal: 12, metricVersion: 'pass1' } },
    current,
  );
  assert.equal(same.items.filter((i) => i.probeId === 'quality').length, 0);
});