import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockServer, type MockServer } from './mock-server.js';
import { runAudit } from '../src/runner.js';
import { buildBaseline } from '../src/baseline.js';
import { ASSETS_VERSION, PROBESET_VERSION } from '../src/assets.js';
import type { AuditReport, ProbeId, RunConfig } from '../src/types.js';

async function audit(mock: MockServer, overrides: Partial<RunConfig> = {}): Promise<AuditReport> {
  const cfg: RunConfig = {
    baseUrl: mock.baseUrl,
    apiKey: 'test-key',
    model: 'gpt-4o',
    claimedContext: null,
    expect: ['vision', 'tool'],
    deep: false,
    seed: 1234,
    timeoutMs: 20000,
    retries: 1,
    outDir: 'reports',
    html: false,
    yes: true,
    quiet: true,
    ...overrides,
  };
  return runAudit(cfg);
}

function scoreOf(report: AuditReport, id: ProbeId) {
  return report.scores.find((s) => s.id === id);
}

function levelOf(report: AuditReport, id: ProbeId) {
  return report.outcomes.find((o) => o.id === id)?.level;
}

function headlineOf(report: AuditReport, id: ProbeId) {
  return report.outcomes.find((o) => o.id === id)?.headline ?? '';
}

test('e2e honest endpoint scores 100 with no failures', async () => {
  const mock = await createMockServer({ mode: 'honest' });
  try {
    const report = await audit(mock, { claimedContext: 4000 });
    assert.equal(report.total, 100);
    assert.equal(report.overall, 'pass');
    assert.ok(!report.scores.some((s) => s.level === 'fail'));
    assert.equal(scoreOf(report, 'identity')?.score, 100);
    assert.equal(scoreOf(report, 'context')?.score, 100);
    assert.equal(scoreOf(report, 'billing')?.score, 100);
    assert.equal(scoreOf(report, 'capability')?.score, 100);
    assert.equal(scoreOf(report, 'quality')?.score, 100);
    assert.equal(scoreOf(report, 'ttft')?.status ?? 'insufficient', 'insufficient');
  } finally {
    mock.server.close();
  }
});

test('e2e same seed + fresh endpoint yields identical scores', async () => {
  const first = await createMockServer({ mode: 'honest' });
  const second = await createMockServer({ mode: 'honest' });
  try {
    const a = await audit(first, { claimedContext: 4000, seed: 777 });
    const b = await audit(second, { claimedContext: 4000, seed: 777 });
    assert.deepEqual(
      a.scores.map((s) => [s.id, s.score, s.level]),
      b.scores.map((s) => [s.id, s.score, s.level]),
    );
    assert.equal(a.total, b.total);
  } finally {
    first.server.close();
    second.server.close();
  }
});

test('e2e relabeled endpoint (GLM pretending to be gpt-4o) fails identity', async () => {
  const mock = await createMockServer({ mode: 'relabel' });
  try {
    const report = await audit(mock);
    assert.equal(levelOf(report, 'identity'), 'fail');
    assert.equal(scoreOf(report, 'identity')?.score, 0);
    assert.equal(report.total, 0);
    assert.equal(report.overall, 'fail');
    assert.ok(report.outcomes.find((o) => o.id === 'identity')?.findings.some((f) => f.level === 'fail'));
  } finally {
    mock.server.close();
  }
});

test('e2e silently truncating endpoint fails context probe', async () => {
  const mock = await createMockServer({ mode: 'truncate', truncateTokens: 7000 });
  try {
    const report = await audit(mock, { claimedContext: 32000 });
    assert.equal(levelOf(report, 'context'), 'fail');
    const headline = headlineOf(report, 'context');
    assert.ok(/截断|回显|窗口不实/.test(headline), headline);
    assert.ok(report.total !== null && report.total <= 45);
    assert.equal(report.overall, 'fail');
  } finally {
    mock.server.close();
  }
});

test('e2e oversize-rejecting endpoint is reported as explicit reject, not silent truncation', async () => {
  const mock = await createMockServer({ mode: 'oversize-reject', truncateTokens: 7000 });
  try {
    const report = await audit(mock, { claimedContext: 32000 });
    assert.equal(levelOf(report, 'context'), 'fail');
    assert.ok(/显式拒绝/.test(headlineOf(report, 'context')), headlineOf(report, 'context'));
  } finally {
    mock.server.close();
  }
});

test('e2e constant usage endpoint fails billing', async () => {
  const mock = await createMockServer({ mode: 'const-usage' });
  try {
    const report = await audit(mock);
    assert.equal(levelOf(report, 'billing'), 'fail');
    assert.equal(scoreOf(report, 'billing')?.score, 0);
    assert.equal(report.total, 0);
  } finally {
    mock.server.close();
  }
});

test('e2e inflated usage endpoint fails billing with capped total', async () => {
  const mock = await createMockServer({ mode: 'inflated' });
  try {
    const report = await audit(mock);
    assert.equal(levelOf(report, 'billing'), 'fail');
    assert.ok((scoreOf(report, 'billing')?.score ?? 100) <= 30);
    assert.ok(report.total !== null && report.total <= 45);
  } finally {
    mock.server.close();
  }
});

test('e2e no-vision endpoint fails capability instead of scoring a fake', async () => {
  const mock = await createMockServer({ mode: 'no-vision' });
  try {
    const report = await audit(mock);
    assert.equal(levelOf(report, 'capability'), 'fail');
    assert.ok(report.outcomes.find((o) => o.id === 'capability')?.findings.some((f) => /vision/.test(f.message)));
  } finally {
    mock.server.close();
  }
});

test('e2e tool-fail endpoint fails capability', async () => {
  const mock = await createMockServer({ mode: 'tool-fail' });
  try {
    const report = await audit(mock);
    assert.equal(levelOf(report, 'capability'), 'fail');
    assert.ok(report.outcomes.find((o) => o.id === 'capability')?.findings.some((f) => /工具调用/.test(f.message)));
  } finally {
    mock.server.close();
  }
});

test('e2e dumb endpoint fails quality while controls pass', async () => {
  const mock = await createMockServer({ mode: 'dumb' });
  try {
    const report = await audit(mock);
    const quality = report.outcomes.find((o) => o.id === 'quality');
    assert.equal(quality?.level, 'fail');
    assert.equal(quality?.score, 0);
    assert.equal(quality?.metrics['controls'], '3/3');
    assert.equal(report.total, 0);
  } finally {
    mock.server.close();
  }
});

test('e2e flaky endpoint completes with retries and no probe errors', async () => {
  const mock = await createMockServer({ mode: 'flaky', failEvery: 9 });
  try {
    const report = await audit(mock);
    assert.ok(report.total !== null);
    assert.ok(!report.outcomes.some((o) => o.status === 'error'));
  } finally {
    mock.server.close();
  }
});

test('e2e dead endpoint yields insufficient probes, not a false pass', async () => {
  const mock = await createMockServer({ mode: 'flaky', failEvery: 1 });
  try {
    const report = await audit(mock, { retries: 0 });
    assert.equal(report.total, null);
    assert.equal(report.overall, 'unknown');
    assert.ok(!report.scores.some((s) => s.level === 'pass'));
    assert.ok(!report.scores.some((s) => s.level === 'fail'));
  } finally {
    mock.server.close();
  }
});

test('e2e price flags produce measured-ratio metrics from balance delta', async () => {
  const mock = await createMockServer({ mode: 'honest', balanceSeries: [9950, 10000] });
  try {
    const report = await audit(mock, { priceInput: 2.5, priceOutput: 10 });
    const billing = report.outcomes.find((o) => o.id === 'billing');
    assert.ok(billing);
    assert.equal(billing?.metrics['balance_endpoint'], '/dashboard/billing/usage');
    assert.equal(billing?.metrics['balance_unit'], 'USD');
    assert.equal(billing?.metrics['balance_before'], 99.5);
    assert.equal(billing?.metrics['balance_after'], 100);
    assert.equal(billing?.metrics['spend_delta'], 0.5);
    assert.equal(billing?.metrics['ratio_samples'], 10);
    assert.equal(billing?.metrics['ratio_dropped'], 0);
    assert.ok(typeof billing?.metrics['measured_ratio'] === 'number');
    assert.ok(typeof billing?.metrics['expected_cost'] === 'number');
    // 余额查询不是 chat 调用：billing 探针 evidence 仅含 10 次请求
    assert.equal(report.evidence.filter((e) => e.probe === 'billing').length, 10);
  } finally {
    mock.server.close();
  }
});

test('e2e baseline drift appends findings and caps identity before scoring', async () => {
  const mock = await createMockServer({ mode: 'honest' });
  const dir = mkdtempSync(join(tmpdir(), 'mx-baseline-'));
  try {
    const first = await audit(mock, { seed: 4321 });
    const baseline = buildBaseline(first.outcomes, {
      model: 'gpt-4o',
      seed: 4321,
      probesetVersion: PROBESET_VERSION,
      assetsVersion: ASSETS_VERSION,
    });
    assert.deepEqual(baseline.identity?.families, ['gpt']);
    // 伪造基线指向另一个模型族，制造指纹漂移
    baseline.identity = { families: ['glm'], schemaCompliant: true, refusalRate: 0 };
    const baselinePath = join(dir, 'base.json');
    writeFileSync(baselinePath, JSON.stringify(baseline));

    const second = await audit(mock, { seed: 4321, baselineIn: baselinePath });
    const identity = second.outcomes.find((o) => o.id === 'identity');
    assert.ok(identity?.findings.some((f) => f.level === 'fail' && /模型族指纹漂移/.test(f.message)));
    assert.equal(identity?.score, 0);
    assert.equal(identity?.level, 'fail');
    assert.equal(second.total, 0);
    assert.equal(second.overall, 'fail');
    assert.ok(second.notes.some((n) => n.includes('基线对比')));
  } finally {
    mock.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('e2e badusage endpoint flags inconsistent/negative usage and drops samples', async () => {
  const mock = await createMockServer({ mode: 'badusage' });
  try {
    const report = await audit(mock, { priceInput: 2.5, priceOutput: 10 });
    const billing = report.outcomes.find((o) => o.id === 'billing');
    assert.ok(billing);
    assert.ok((billing?.metrics['usage_inconsistent'] as number) >= 1, String(billing?.metrics['usage_inconsistent']));
    assert.ok((billing?.metrics['usage_invalid'] as number) >= 1, String(billing?.metrics['usage_invalid']));
    assert.ok(
      billing?.findings.some((f) => f.level === 'warn' && /total_tokens 与 prompt\+completion 不一致/.test(f.message)),
      JSON.stringify(billing?.findings),
    );
    assert.ok(billing?.findings.some((f) => f.level === 'warn' && /负 token 数/.test(f.message)));
    assert.ok(billing?.findings.some((f) => /样本已剔除/.test(f.message)));
    // 被剔除样本不得进入回归/expectedCost
    assert.equal(billing?.metrics['ratio_samples'], 0);
  } finally {
    mock.server.close();
  }
});

test('e2e flaky500 with retries invalidates measured ratio (contamination gate)', async () => {
  const mock = await createMockServer({ mode: 'flaky500' });
  try {
    const report = await audit(mock, { retries: 1, priceInput: 2.5, priceOutput: 10 });
    // 重试成功后的 evidence 记录 attempts 必须为 2
    assert.ok(report.evidence.some((e) => e.response.attempts === 2), 'no attempts===2 record');
    const billing = report.outcomes.find((o) => o.id === 'billing');
    assert.ok(billing);
    assert.equal(billing?.metrics['ratio_contaminated'], 1);
    assert.equal(billing?.metrics['measured_ratio'], 'N/A');
    // balance 查询不受污染闸影响，照常输出
    assert.equal(billing?.metrics['balance_endpoint'], '/dashboard/billing/usage');
    assert.ok(billing?.findings.some((f) => /审计窗口内存在重试请求/.test(f.message)));
  } finally {
    mock.server.close();
  }
});

test('e2e empty-content endpoint yields insufficient identity, not a template warning', async () => {
  const mock = await createMockServer({ mode: 'empty' });
  try {
    const report = await audit(mock);
    const identity = report.outcomes.find((o) => o.id === 'identity');
    assert.ok(identity);
    assert.equal(identity?.status, 'insufficient');
    assert.equal(identity?.score, null);
    assert.equal(identity?.level, 'unknown');
    assert.ok(/无有效回答/.test(identity?.headline ?? ''), identity?.headline);
    // 空响应没有指纹含义：不得出现「逐字一致」指控，也不得有 fail 级 finding
    assert.ok(!identity?.findings.some((f) => /逐字一致/.test(f.message)), JSON.stringify(identity?.findings));
    assert.ok(!identity?.findings.some((f) => f.level === 'fail'));
  } finally {
    mock.server.close();
  }
});
