import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockServer, type MockServer } from './mock-server.js';
import { runAudit } from '../src/runner.js';
import { buildBaseline } from '../src/baseline.js';
import { loadTokenReference } from '../src/token-reference.js';
import { ASSETS_VERSION, PROBESET_VERSION } from '../src/assets.js';
import type { AuditReport, ProbeId, RunConfig } from '../src/types.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function runCli(
  args: string[],
  timeoutMs = 60000,
): Promise<{ status: number | null; stdout: string; stderr: string; elapsedMs: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [CLI, ...args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI timeout after ${timeoutMs}ms.\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr, elapsedMs: Date.now() - started });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function audit(
  mock: MockServer,
  overrides: Partial<RunConfig> = {},
  onActivity?: (message: string) => void,
): Promise<AuditReport> {
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
  return runAudit(cfg, undefined, undefined, onActivity);
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
  // 绝对对账：余额按 1.0 倍累加 usage 成本，billing 给 PASS 100（仅形状证据上限为 85）。
  const mock = await createMockServer({ mode: 'honest', balanceRate: 1 });
  try {
    // 余额对账分支仍由库内 readBalance 显式开启；CLI 默认价格核验不读余额。
    const report = await audit(mock, { claimedContext: 4000, priceInput: 2, priceOutput: 8, readBalance: true });
    assert.equal(report.total, 100);
    assert.equal(report.overall, 'pass');
    assert.ok(!report.scores.some((s) => s.level === 'fail'));
    assert.equal(scoreOf(report, 'identity')?.score, 100);
    assert.equal(scoreOf(report, 'context')?.score, 100);
    assert.equal(scoreOf(report, 'billing')?.score, 100);
    assert.equal(scoreOf(report, 'capability')?.score, 100);
    assert.equal(scoreOf(report, 'quality')?.score, 100);
    assert.equal(scoreOf(report, 'ttft')?.status ?? 'insufficient', 'insufficient');
    // Usage 契约扩展：evidence[].response.usage 须携带缓存/推理明细（mock: cached=0、reasoning=min(1,completion)=1）
    const billed = report.evidence.filter((e) => e.probe === 'billing');
    assert.ok(billed.length > 0);
    for (const e of billed) {
      assert.equal(e.response.usage?.cached_tokens, 0);
      assert.equal(e.response.usage?.reasoning_tokens, 1);
    }
    // billing metrics 三键（snake_case）：cached=0 全样本、reasoning=1/样本、details 全上报
    const billing = report.outcomes.find((o) => o.id === 'billing');
    assert.equal(billing?.metrics['cached_tokens_total'], 0);
    assert.equal(billing?.metrics['reasoning_tokens_total'], billed.length);
    assert.equal(billing?.metrics['details_reported_count'], billed.length);
    assert.equal(billing?.metrics['ratio_verified'], 1);
    assert.equal(billing?.metrics['absolute_reconciliation'], 1);
    assert.equal(billing?.metrics['evidence_level'], 'absolute');
  } finally {
    mock.server.close();
  }
});

test('runner activity: every phase logs start and completion with level/score/duration', async () => {
  const mock = await createMockServer({ mode: 'honest' });
  try {
    const lines: string[] = [];
    await audit(mock, { claimedContext: 4000 }, (message) => lines.push(message));
    for (const phase of ['identity', 'context', 'billing', 'capability', 'decoy', 'quality', 'ttft']) {
      assert.ok(
        lines.some((line) => line.includes(`[RUN] 阶段 ${phase}（`)),
        `missing start line for ${phase}`,
      );
      const done = lines.find((line) => line.includes(`[RUN] 阶段 ${phase}（`) && line.includes('完成'));
      assert.ok(done !== undefined, `missing completion line for ${phase}`);
      assert.match(done, /完成 · (PASS|WARN|FAIL|UNKNOWN) · 得分 (—|\d+\/100) · \d+\.\d+s/);
    }
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

test('e2e silently truncating endpoint fails context probe (deep)', async () => {
  // --deep 走 boundaryTruncated 二分定罪（确定性证据）；非 --deep 仅统计信号 → warn 不指控
  const mock = await createMockServer({ mode: 'truncate', truncateTokens: 7000, balanceRate: 1 });
  try {
    const report = await audit(mock, { claimedContext: 32000, deep: true, priceInput: 2, priceOutput: 8 });
    assert.equal(levelOf(report, 'context'), 'fail');
    const headline = headlineOf(report, 'context');
    assert.ok(/截断|回显|窗口不实/.test(headline), headline);
    assert.ok(report.total !== null && report.total <= 45);
    assert.equal(report.overall, 'fail');
  } finally {
    mock.server.close();
  }
});

test('e2e silently truncating endpoint without --deep is warn, not fail (零误报口径)', async () => {
  const mock = await createMockServer({ mode: 'truncate', truncateTokens: 7000 });
  try {
    const report = await audit(mock, { claimedContext: 32000 });
    assert.equal(levelOf(report, 'context'), 'warn', headlineOf(report, 'context'));
    assert.ok(!report.outcomes.find((o) => o.id === 'context')?.findings.some((f) => f.level === 'fail'));
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

test('e2e transport-failed needle samples are excluded, not counted as truncation misses', async () => {
  // 回归（2026-10-17 官方 1M 标称实测实证）：深度 25% 的 1/3 needle 样本「network：fetch failed」
  // 被计入分母 → depth_hits 2/3 → 误判「标称窗口不实（15 分 fail）」，而排除后该深度 2/2 全命中。
  const mock = await createMockServer({ mode: 'auth-required' });
  try {
    const report = await audit(mock, { claimedContext: 32000 });
    const outcome = report.outcomes.find((o) => o.id === 'context');
    assert.ok(outcome, 'context outcome missing');
    assert.equal(levelOf(report, 'context'), 'unknown', `全部样本请求失败必须诚实不可判定：${headlineOf(report, 'context')}`);
    assert.equal(outcome?.score, null, '证据不足不得给 0 分');
    assert.ok(Number(outcome?.metrics['errored_samples'] ?? 0) > 0, 'errored_samples 应被记录');
    assert.ok(
      outcome?.findings.some((f) => /不计入截断判定/.test(f.message)),
      '必须披露被排除的传输故障样本',
    );
  } finally {
    mock.server.close();
  }
});

test('e2e 200+error-payload endpoint: capability/context degrade to N/A, never accused of missing ability or unreadable context', async () => {
  // 层 3 审查实证的诬告路径：HTTP 200 + `{"error":{...}}` 此前被解析为「成功但空正文」，
  // capability 会判「未发起工具调用」fail、context 会判「内容不可读」fail。
  const mock = await createMockServer({ mode: 'error-payload' });
  try {
    const report = await audit(mock, { expect: ['vision', 'tool'], claimedContext: 8000 });
    assert.equal(levelOf(report, 'capability'), 'unknown', `${headlineOf(report, 'capability')}：上游错误载荷不得判能力缺失`);
    assert.equal(scoreOf(report, 'capability')?.score, null);
    assert.equal(levelOf(report, 'context'), 'unknown', `${headlineOf(report, 'context')}：上游错误载荷不得判内容不可读`);
    assert.equal(scoreOf(report, 'context')?.score, null);
    assert.ok(
      !report.scores.some((s) => (s.id === 'capability' || s.id === 'context') && s.level !== 'unknown'),
      'capability/context 只能是 unknown，不得有 fail/warn 指控',
    );
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

test('e2e invalid-key endpoint degrades capability to N/A instead of FAIL', async () => {
  const mock = await createMockServer({ mode: 'auth-required' });
  try {
    const report = await audit(mock);
    assert.equal(report.outcomes.find((o) => o.id === 'capability')?.status, 'insufficient');
    assert.equal(levelOf(report, 'capability'), 'unknown');
    assert.equal(report.overall, 'unknown');
    assert.equal(report.total, null);
    assert.ok(!report.outcomes.find((o) => o.id === 'capability')?.findings.some((f) => f.level === 'fail'));
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
    // 重试请求可能被上游重复计费：billing 必须 warn（不得 PASS），但仍可参与总分。
    assert.equal(levelOf(report, 'billing'), 'warn');
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
  const mock = await createMockServer({ mode: 'honest', balanceSeries: [9950, 9950, 10000, 10000] });
  try {
    const report = await audit(mock, { priceInput: 2.5, priceOutput: 10, readBalance: true });
    const billing = report.outcomes.find((o) => o.id === 'billing');
    assert.ok(billing);
    assert.equal(billing?.metrics['balance_endpoint'], '/dashboard/billing/usage');
    // raw 透传口径：balance_unit 记录原始读数单位，balance_before/after 为 raw 值（不再提取层 ÷100）；
    // 单位校准由 decideRatio 完成，校准采信口径落在 balance_calibrated_unit，spend_delta 被校准覆写。
    assert.equal(billing?.metrics['balance_unit'], 'total_usage_raw');
    assert.equal(billing?.metrics['balance_calibrated_unit'], 'cents');
    assert.equal(billing?.metrics['balance_before'], 9950);
    assert.equal(billing?.metrics['balance_after'], 10000);
    assert.equal(billing?.metrics['spend_delta'], 0.5);
    assert.equal(billing?.metrics['ratio_samples'], 10);
    assert.equal(billing?.metrics['ratio_dropped'], 0);
    assert.ok(typeof billing?.metrics['measured_ratio'] === 'number');
    assert.ok(typeof billing?.metrics['expected_cost'] === 'number');
    // 余额查询不是 chat 调用：billing 探针 evidence 仅含 10 次请求（5 档 × 2 语言，默认档位）
    assert.equal(report.evidence.filter((e) => e.probe === 'billing').length, 10);
  } finally {
    mock.server.close();
  }
});

test('e2e no-baseline run appends 未加载指纹基线 note; with --baseline the note is absent', async () => {
  const mock = await createMockServer({ mode: 'honest' });
  const dir = mkdtempSync(join(tmpdir(), 'mx-no-baseline-'));
  try {
    // 无基线：notes 必须携带检测边界披露
    const first = await audit(mock, { seed: 4321 });
    assert.ok(
      first.notes.some((n) => n.includes('未加载指纹基线') && n.includes('--baseline 复测')),
      JSON.stringify(first.notes),
    );
    // 带基线：该提示不得出现，且基线对比 note 照常
    const baseline = buildBaseline(first.outcomes, {
      model: 'gpt-4o',
      seed: 4321,
      probesetVersion: PROBESET_VERSION,
      assetsVersion: ASSETS_VERSION,
    });
    const baselinePath = join(dir, 'base.json');
    writeFileSync(baselinePath, JSON.stringify(baseline));
    const second = await audit(mock, { seed: 4321, baselineIn: baselinePath });
    assert.ok(!second.notes.some((n) => n.includes('未加载指纹基线')), JSON.stringify(second.notes));
    assert.ok(second.notes.some((n) => n.includes('基线对比')));
  } finally {
    mock.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('e2e baseline drift appends findings and caps identity before scoring', async () => {  const mock = await createMockServer({ mode: 'honest' });
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
    const report = await audit(mock, { retries: 1, priceInput: 2.5, priceOutput: 10, readBalance: true });
    // 重试成功后的 evidence 记录 attempts 必须为 2
    assert.ok(report.evidence.some((e) => e.response.attempts === 2), 'no attempts===2 record');
    const billing = report.outcomes.find((o) => o.id === 'billing');
    assert.ok(billing);
    assert.equal(billing?.metrics['ratio_contaminated'], 1);
    assert.equal(billing?.metrics['measured_ratio'], 'N/A');
    // balance 查询不受污染闸影响，照常输出
    assert.equal(billing?.metrics['balance_endpoint'], '/dashboard/billing/usage');
    // 新口径：污染 warn 描述「可能已计费的尝试后重试（重复计费风险）」并给出 contaminating_retries 指标
    assert.ok(billing?.findings.some((f) => /重复计费/.test(f.message)), JSON.stringify(billing?.findings));
    // flaky500 对每个唯一请求体首次注入 500 → 10 笔计费样本（5 档 × en/zh）全部经历污染重试
    assert.equal(billing?.metrics['contaminating_retries'], 10);
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

// --- thinking-starve：推理占满 max_tokens 预算（thinking 模型假阴性修复）的端到端回归 ---

test('e2e thinking-starve vision: first call starves, auto-retries at max_tokens=2048, ends non-fail with budget finding', async () => {
  // 阈值 1536：首查 1024 被截断，重试 2048 通过
  const mock = await createMockServer({ mode: 'thinking-starve', starveBelow: 1536 });
  try {
    const report = await audit(mock, { expect: ['vision'] });
    const capability = report.outcomes.find((o) => o.id === 'capability');
    assert.ok(capability);
    assert.equal(capability?.status, 'ok');
    assert.equal(capability?.level, 'pass');
    assert.ok(capability?.findings.some((f) => f.level === 'info' && /升预算/.test(f.message) && /2048/.test(f.message)));
    // 第二次请求 max_tokens=2048（证据 request.maxTokens 断言）
    const visionEvidence = report.evidence.filter((e) => e.label.startsWith('vision '));
    assert.ok(visionEvidence.length >= 6, '3 色 × (首查+重试) 应有 6 条证据');
    assert.ok(visionEvidence.some((e) => e.request.maxTokens === 1024));
    assert.ok(visionEvidence.some((e) => e.request.maxTokens === 2048));
    // 首查的 starved 响应（finish_reason=length）已透传进证据
    assert.ok(visionEvidence.some((e) => e.response.finishReason === 'length'));
    assert.ok(visionEvidence.some((e) => e.response.finishReason === 'stop'));
  } finally {
    mock.server.close();
  }
});

test('e2e thinking-starve vision: fully starved → capability insufficient (not fail)', async () => {
  const mock = await createMockServer({ mode: 'thinking-starve', starveBelow: 4096 });
  try {
    const report = await audit(mock, { expect: ['vision'] });
    const capability = report.outcomes.find((o) => o.id === 'capability');
    assert.ok(capability);
    assert.equal(capability?.status, 'insufficient');
    assert.equal(capability?.level, 'unknown');
    assert.ok(!capability?.findings.some((f) => f.level === 'fail'), JSON.stringify(capability?.findings));
    assert.ok(capability?.findings.some((f) => /推理占满预算/.test(f.message)));
  } finally {
    mock.server.close();
  }
});

test('e2e thinking-starve identity: non-empty truncation → schema no rewrite-warning, self-id insufficient', async () => {
  const mock = await createMockServer({ mode: 'thinking-starve', starveBelow: 600, starveTruncated: '{"a":' });
  try {
    const report = await audit(mock, { expect: [] });
    const identity = report.outcomes.find((o) => o.id === 'identity');
    assert.ok(identity);
    assert.equal(identity?.status, 'insufficient');
    // 非空截断也是 starvation：不得判「网关重写响应」，也不得判「逐字一致（模板特判）」
    assert.ok(!identity?.findings.some((f) => /网关可能重写响应/.test(f.message)), JSON.stringify(identity?.findings));
    assert.ok(!identity?.findings.some((f) => /逐字一致/.test(f.message)), JSON.stringify(identity?.findings));
    assert.ok(!identity?.findings.some((f) => f.level === 'fail'));
    assert.equal(identity?.metrics['schema_compliant'], 'N/A');
    assert.ok(identity?.findings.some((f) => /预算/.test(f.message)));
  } finally {
    mock.server.close();
  }
});

const CONTROL_EXEMPT = /一年有几个月|^\s*\d{1,2}\s*[+＋]\s*\d{1,2}\s*等于|^\s*\d{1,2}\s*[×x*]\s*\d{1,2}\s*等于/;

test('e2e thinking-starve quality: control starved → insufficient with starvation-specific copy', async () => {
  const mock = await createMockServer({ mode: 'thinking-starve', starveBelow: 5000 });
  try {
    const report = await audit(mock, { expect: [] });
    const quality = report.outcomes.find((o) => o.id === 'quality');
    assert.ok(quality);
    assert.equal(quality?.status, 'insufficient');
    assert.match(quality?.headline ?? '', /推理占满预算/);
    assert.ok(quality?.findings.some((f) => /控制题 .*推理占满预算未作答/.test(f.message)), JSON.stringify(quality?.findings));
  } finally {
    mock.server.close();
  }
});

test('e2e thinking-starve quality: all mains excluded → insufficient (denominator 0)', async () => {
  // 控制题豁免（平凡题小预算即可答），主问题 256/512 均截断 → 全部剔除
  const mock = await createMockServer({ mode: 'thinking-starve', starveBelow: 600, starveExempt: CONTROL_EXEMPT });
  try {
    const report = await audit(mock, { expect: [] });
    const quality = report.outcomes.find((o) => o.id === 'quality');
    assert.ok(quality);
    assert.equal(quality?.status, 'insufficient');
    assert.match(quality?.headline ?? '', /主问题全部/);
    assert.equal(quality?.metrics['main'], '0/0');
    assert.equal(quality?.metrics['excluded'], 12);
  } finally {
    mock.server.close();
  }
});

test('e2e thinking-starve quality: partial exclusion keeps correct denominator and scores on usable samples', async () => {
  // 仅「除以(余数)」与「days→hours」两题不豁免（256/512 均截断被剔除）→ 10/12 有效（≥80% 下限）
  const exempt =
    /一年有几个月|^\s*\d{1,2}\s*[+＋]\s*\d{1,2}\s*等于|^\s*\d{1,2}\s*[×x*]\s*\d{1,2}\s*等于|数列|包含几个|偶数|面积|哪一组更大|Multiply|JSON|%|计算|个苹果/;
  const mock = await createMockServer({ mode: 'thinking-starve', starveBelow: 600, starveExempt: exempt });
  try {
    const report = await audit(mock, { expect: [], seed: 99 });
    const quality = report.outcomes.find((o) => o.id === 'quality');
    assert.ok(quality);
    assert.equal(quality?.status, 'ok');
    assert.equal(quality?.level, 'pass');
    assert.equal(quality?.metrics['main'], '10/10');
    assert.equal(quality?.metrics['excluded'], 2);
    assert.equal(quality?.score, 100);
    assert.ok(quality?.findings.some((f) => /剔除分母/.test(f.message)), JSON.stringify(quality?.findings));
  } finally {
    mock.server.close();
  }
});

test('e2e thinking-starve: 401 endpoint makes no starvation retries (request-count anchor)', async () => {
  const mock = await createMockServer({ mode: 'auth-required' });
  try {
    const report = await audit(mock, { expect: ['vision'] });
    // 401 非 starvation：绝不触发升预算重试 → 每色/每题恰好一条证据，无 retry 标签，attempts 全为 1
    const vision = report.evidence.filter((e) => e.label.startsWith('vision '));
    assert.equal(vision.length, 3);
    const quality = report.evidence.filter((e) => e.probe === 'quality');
    assert.equal(quality.length, 15);
    assert.ok(report.evidence.every((e) => e.response.attempts === 1));
    assert.ok(!report.evidence.some((e) => /retry@/.test(e.label)), JSON.stringify(report.evidence.map((e) => e.label)));
  } finally {
    mock.server.close();
  }
});

// --- F1 复采样抗噪 / 防洗白（v0.2.2）：mock retry-fix 端到端 ---

test('e2e retry-fix (perturb=3): first-answer noise mostly recovered → pass@1 9/12 首答自达 0.9 线 → pass 92', async () => {
  // 端点对前 3 个主题首答 +1 扰动、同题面重放返回正确答案——pass@1 主口径下首答 9/12 = 0.75
  // < 0.9 → warn；复采样恢复 3 题仅披露（recovered metric + info finding）。
  // 注：本测试名与旧两次机会口径「pass 100」的差别是 2026-10-19 裁决的主指标变更。
  const mock = await createMockServer({ mode: 'retry-fix' });
  try {
    const report = await audit(mock, { expect: ['vision', 'tool'] });
    const quality = report.outcomes.find((o) => o.id === 'quality');
    assert.ok(quality);
    assert.equal(quality?.level, 'warn', quality?.headline);
    assert.equal(quality?.score, 75);
    assert.match(quality?.headline ?? '', /首答 9\/12/);
    assert.equal(quality?.metrics['main'], '9/12');
    assert.equal(quality?.metrics['main_recovered'], '12/12');
    assert.equal(quality?.metrics['retried'], 3);
    assert.equal(quality?.metrics['recovered'], 3);
    // 复采样请求（temperature 0.7）必须以证据形式留痕：首答 + 复采样双证据
    assert.ok(
      quality?.findings.some((f) => f.level === 'info' && /首答错误、复采样/.test(f.message)),
      JSON.stringify(quality?.findings),
    );
    const resampleEvidence = report.evidence.filter((e) => e.request.temperature === 0.7 && e.probe === 'quality');
    assert.equal(resampleEvidence.length, 3, '复采样必须逐题 recordCall（3 题）');
  } finally {
    mock.server.close();
  }
});

test('e2e retry-fix whitewash guard (perturb=12): all topics first-wrong → pass@1 0/12，复采恢复 → warn 封顶 80', async () => {
  const mock = await createMockServer({ mode: 'retry-fix', retryFixPerturb: 12 });
  try {
    const report = await audit(mock, { expect: [] });
    const quality = report.outcomes.find((o) => o.id === 'quality');
    assert.ok(quality);
    assert.equal(quality?.level, 'warn', quality?.headline);
    assert.equal(quality?.score, 80);
    assert.equal(quality?.metrics['main'], '0/12');
    assert.equal(quality?.metrics['main_recovered'], '12/12');
    assert.equal(quality?.metrics['recovered'], 12);
    assert.match(quality?.headline ?? '', /首答仅 0\/12，复采样恢复至 12\/12/);
    assert.ok(quality?.findings.some((f) => f.level === 'info' && /恢复率异常高/.test(f.message)));
    assert.equal(report.overall, 'warn', '质量防洗白告警必须传导到 overall');
  } finally {
    mock.server.close();
  }
});

// --- F2 人格注入检测（v0.2.2）：mock persona-inject 端到端 ---

test('e2e persona-inject endpoint: brand persona in self-description → identity warn capped 80, findings disclose', async () => {
  const mock = await createMockServer({ mode: 'persona-inject' });
  try {
    const report = await audit(mock, { expect: [] });
    const identity = report.outcomes.find((o) => o.id === 'identity');
    assert.ok(identity);
    assert.equal(identity?.level, 'warn', identity?.headline);
    assert.equal(identity?.score, 80);
    assert.ok(
      identity?.findings.some((f) => f.level === 'warn' && /自述出现非模型族人格名/.test(f.message) && /NovaRelay/.test(f.message)),
      JSON.stringify(identity?.findings),
    );
    assert.match(String(identity?.metrics['persona_hits']), /NovaRelay×2/);
    // 其余样本照常声明目标族：族指纹不受污染、回显正常（人格信号必须独立于族判定）
    assert.equal(identity?.metrics['families'], 'gpt');
    assert.match(String(identity?.metrics['model_echo']), /^6\/6$/);
    assert.equal(report.overall, 'warn');
  } finally {
    mock.server.close();
  }
});

// --- F3 token-reference：全量等比虚增（线性回归不可见）的端到端识别 ---

test('e2e usage-scale 1.3 without --token-reference: prompt 侧形状不可见，输出侧 completion 合计比对抓到 warn', async () => {
  // billing 核验对象是 usage：全量等比虚增对 prompt 回归/常量检测不可见（形状不变）；
  // 2026-10-19 起新增输出侧合计比对——completion 同倍率虚增使 Σ可见completion/Σ正文估算 系统性
  // 偏大（本夹具 ×1.5 > 1.35），无需 token-reference 即给出「疑似输出 token 灌水」warn（封顶 70）。
  // prompt 侧等比缩放仍未定罪：绝对定论仍需 --token-reference / 价格+余额对账。
  const mock = await createMockServer({ mode: 'usage-scale', usageScale: 1.3 });
  try {
    const report = await audit(mock);
    const billing = report.outcomes.find((o) => o.id === 'billing');
    assert.ok(billing);
    assert.equal(billing?.status, 'ok', billing?.headline);
    assert.equal(billing?.level, 'warn');
    assert.ok((billing?.score ?? 100) <= 70, `score=${billing?.score}`);
    assert.match(billing?.headline ?? '', /灌水/);
    assert.ok(
      billing?.findings.some((f) => f.level === 'warn' && /输出侧 completion 合计/.test(f.message)),
      JSON.stringify(billing?.findings),
    );
    assert.ok(
      (billing?.metrics['completion_ratio_en'] as number) > 1.35,
      `completion_ratio_en=${String(billing?.metrics['completion_ratio_en'])}`,
    );
    assert.equal(billing?.metrics['absolute_reconciliation'], 0);
    assert.notEqual(report.total, null);
  } finally {
    mock.server.close();
  }
});

test('e2e token-reference: scale-1.0 report as reference catches scale-1.3 inflation (fail, cap 30)', async () => {
  const honestScale = await createMockServer({ mode: 'usage-scale', usageScale: 1.0 });
  const inflated = await createMockServer({ mode: 'usage-scale', usageScale: 1.3 });
  const dir = mkdtempSync(join(tmpdir(), 'mx-token-ref-e2e-'));
  try {
    const first = await audit(honestScale, { seed: 4321 });
    const refPath = join(dir, 'reference.json');
    // 最小参考报告形状：{ meta, outcomes }（本工具报告同构即可被 loadTokenReference 消费）
    writeFileSync(refPath, JSON.stringify({ meta: first.meta, outcomes: first.outcomes }));
    const reference = loadTokenReference(refPath);
    const report = await audit(inflated, { seed: 4321, tokenReference: reference });
    const billing = report.outcomes.find((o) => o.id === 'billing');
    assert.ok(billing);
    assert.equal(billing?.level, 'fail', billing?.headline);
    assert.ok((billing?.score ?? 100) <= 30);
    const maxEn = billing?.metrics['reference_ratio_max_en'];
    assert.ok(typeof maxEn === 'number' && Math.abs(maxEn - 1.3) <= 0.05, `reference_ratio_max_en=${String(maxEn)}`);
    assert.ok(
      billing?.findings.some((f) => f.level === 'fail' && /参考报告/.test(f.message)),
      JSON.stringify(billing?.findings),
    );
    assert.match(String(billing?.metrics['reference_source']), /reference\.json \| gpt-4o \|/);
  } finally {
    honestScale.server.close();
    inflated.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('e2e usage-scale 1.3 with honest baseline flags billing slope drift (regression guard)', async () => {
  // 现有 --baseline 机制对全量等比虚增的兜底：斜率相对基线漂移 → warn 级告警
  const honest = await createMockServer({ mode: 'honest' });
  const inflated = await createMockServer({ mode: 'usage-scale', usageScale: 1.3 });
  const dir = mkdtempSync(join(tmpdir(), 'mx-scale-baseline-'));
  try {
    const first = await audit(honest, { seed: 4321 });
    const baseline = buildBaseline(first.outcomes, {
      model: 'gpt-4o',
      seed: 4321,
      probesetVersion: PROBESET_VERSION,
      assetsVersion: ASSETS_VERSION,
    });
    const baselinePath = join(dir, 'base.json');
    writeFileSync(baselinePath, JSON.stringify(baseline));
    const report = await audit(inflated, { seed: 4321, baselineIn: baselinePath });
    const billing = report.outcomes.find((o) => o.id === 'billing');
    assert.ok(billing);
    assert.equal(billing?.level, 'warn', billing?.headline);
    assert.ok(
      billing?.findings.some((f) => f.level === 'warn' && /计费斜率相对基线漂移/.test(f.message)),
      JSON.stringify(billing?.findings),
    );
  } finally {
    honest.server.close();
    inflated.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- F3 CLI 子进程：fail-fast 零请求 + 正常审计退出契约 ---

test('cli: --context-budget-usd without price flags exits 2 with zero requests', async () => {
  const mock = await createMockServer({ mode: 'honest' });
  const dir = mkdtempSync(join(tmpdir(), 'mx-cli-budget-'));
  try {
    const result = await runCli([
      'test',
      '--base-url',
      mock.baseUrl,
      '--key',
      'k',
      '--model',
      'gpt-4o',
      '--claimed-context',
      '8000',
      '--context-budget-usd',
      '0.5',
      '--out',
      dir,
    ]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /--context-budget-usd 必须与 --price-input\/--price-output 成对提供/);
    assert.match(result.stderr, /示例：--context-budget-usd 0\.5 --price-input 2 --price-output 8/);
    assert.equal(mock.state.served, 0, 'fail-fast 阶段不得发起任何请求');
  } finally {
    mock.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: --context-budget-usd with non-numeric value exits 2 with zero requests', async () => {
  const mock = await createMockServer({ mode: 'honest' });
  const dir = mkdtempSync(join(tmpdir(), 'mx-cli-budget-bad-'));
  try {
    // 注意：'-0.5' 会被 parseArgs 判为「ambiguous option argument」参数错误（另类 exit 2），不列入本用例
    for (const bad of ['abc', 'NaN', 'Infinity', '0']) {
      const result = await runCli([
        'test',
        '--base-url',
        mock.baseUrl,
        '--key',
        'k',
        '--model',
        'gpt-4o',
        '--claimed-context',
        '8000',
        '--context-budget-usd',
        bad,
        '--price-input',
        '2',
        '--price-output',
        '8',
        '--out',
        dir,
      ]);
      assert.equal(result.status, 2, `--context-budget-usd ${bad} 应 exit 2：${result.stderr}`);
      assert.match(result.stderr, /--context-budget-usd 必须是大于 0/);
      assert.ok(result.stderr.includes(JSON.stringify(bad)), `错误信息须回显收到值：${result.stderr}`);
      assert.equal(mock.state.served, 0, 'fail-fast 阶段不得发起任何请求');
    }
  } finally {
    mock.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: --token-reference to a missing file exits 2 with zero requests', async () => {
  const mock = await createMockServer({ mode: 'honest' });
  const dir = mkdtempSync(join(tmpdir(), 'mx-cli-ref-'));
  try {
    const missing = join(dir, 'nope.json');
    const result = await runCli([
      'test',
      '--base-url',
      mock.baseUrl,
      '--key',
      'k',
      '--model',
      'gpt-4o',
      '--token-reference',
      missing,
      '--out',
      dir,
    ]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /--token-reference 文件不存在或不可读/);
    assert.ok(result.stderr.includes(missing));
    assert.equal(mock.state.served, 0, 'fail-fast 阶段不得发起任何请求');
  } finally {
    mock.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: --token-reference with malformed JSON exits 2 with zero requests', async () => {
  const mock = await createMockServer({ mode: 'honest' });
  const dir = mkdtempSync(join(tmpdir(), 'mx-cli-ref-bad-'));
  try {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ definitely not json');
    const result = await runCli([
      'test',
      '--base-url',
      mock.baseUrl,
      '--key',
      'k',
      '--model',
      'gpt-4o',
      '--token-reference',
      bad,
      '--out',
      dir,
    ]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /--token-reference 参考报告非法/);
    assert.equal(mock.state.served, 0, 'fail-fast 阶段不得发起任何请求');
  } finally {
    mock.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: honest audit subprocess exits within 20s with the right exit code', async () => {
  // 价格核验路径（CLI 默认不读余额，billing 85）验证正常成功路径为退出码 0。
  const mock = await createMockServer({ mode: 'honest', balanceRate: 1 });
  const dir = mkdtempSync(join(tmpdir(), 'mx-cli-audit-'));
  try {
    const result = await runCli(
      [
        'test',
        '--base-url',
        mock.baseUrl,
        '--key',
        'k',
        '--model',
        'gpt-4o',
        '--seed',
        '7',
        '--price-input',
        '2',
        '--price-output',
        '8',
        '--out',
        dir,
      ],
      60000,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.elapsedMs < 20000, `审计子进程耗时 ${result.elapsedMs}ms，超过 20s`);
  } finally {
    mock.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: honest audit without price/balance still concludes on usage (exit 0, shape-only billing 85)', async () => {
  // billing 只验证 usage：无价格/余额时形状证据全过 → usage 判定 pass 85 + 如实披露，
  // 总分照常给出、退出码 0（不再因缺绝对对账悬置整轮）。
  const mock = await createMockServer({ mode: 'honest' });
  const dir = mkdtempSync(join(tmpdir(), 'mx-cli-no-recon-'));
  try {
    const result = await runCli(
      ['test', '--base-url', mock.baseUrl, '--key', 'k', '--model', 'gpt-4o', '--seed', '7', '--out', dir],
      60000,
    );
    assert.equal(result.status, 0, result.stderr);
    const reportFile = readdirSync(dir).find((f) => f.startsWith('report-') && f.endsWith('.json'));
    assert.ok(reportFile, '应产出报告 JSON');
    const report = JSON.parse(readFileSync(join(dir, reportFile as string), 'utf8')) as {
      outcomes: Array<{ id: string; status: string; score: number | null; headline: string }>;
      total: number | null;
    };
    const billing = report.outcomes.find((o) => o.id === 'billing');
    assert.ok(billing);
    assert.equal(billing.status, 'ok');
    assert.equal(billing.score, 85);
    assert.match(billing.headline, /未做绝对对账/);
    assert.notEqual(report.total, null);
  } finally {
    mock.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
