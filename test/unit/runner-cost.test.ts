import test from 'node:test';
import assert from 'node:assert/strict';
import { totalAuditCostNote } from '../../src/runner.js';
import type { EvidenceRecord, ProbeOutcome, Usage } from '../../src/types.js';

function billingOutcome(): ProbeOutcome {
  return {
    id: 'billing',
    status: 'ok',
    score: 85,
    level: 'pass',
    headline: 'ok',
    findings: [],
    metrics: { price_input: 0.24, price_output: 0.84 },
  };
}

function record(usage: Usage | null): EvidenceRecord {
  return { response: { usage } } as EvidenceRecord;
}

test('totalAuditCostNote: 汇总全部带 usage 证据，按录入价估算并提示余额自核', () => {
  const note = totalAuditCostNote(
    [billingOutcome()],
    [
      record({ prompt_tokens: 1_000_000, completion_tokens: 500_000, total_tokens: 1_500_000 }),
      record(null),
    ],
  );
  assert.ok(note !== null);
  assert.match(note, /测试总费用（按录入价估算/);
  assert.match(note, /0\.660（与录入价同单位）/);
  assert.match(note, /输入 1000000 \/ 输出 500000 tokens/);
  assert.match(note, /余额消耗请自行核对/);
});

test('totalAuditCostNote: 无录入价或无 usage 时不编造费用', () => {
  assert.equal(totalAuditCostNote([{ ...billingOutcome(), metrics: {} }], [record(null)]), null);
  assert.equal(totalAuditCostNote([billingOutcome()], [record(null)]), null);
});
