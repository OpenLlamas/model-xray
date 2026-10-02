import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockServer, type MockServer } from './mock-server.js';
import { runAudit } from '../src/runner.js';
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
