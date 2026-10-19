import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gradeRatio, Reconciler } from '../../src/guard/reconcile.js';
import { JournalWriter, type JournalEntry, type ReconcileEntry } from '../../src/guard/journal.js';
import type { Usage } from '../../src/types.js';
import type { BalanceReading } from '../../src/balance.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'guard-reconcile-'));
}

/** 等写入链落盘后再读（JournalWriter 异步串行写，读前必须 flush）。 */
async function readReconcileEntries(harness: Harness): Promise<ReconcileEntry[]> {
  await harness.flush();
  const dir = harness.dir;
  const out: ReconcileEntry[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (line.length === 0) continue;
      const parsed = JSON.parse(line) as JournalEntry;
      if (parsed.type === 'reconcile') out.push(parsed);
    }
  }
  return out;
}

function spent(value: number, endpoint = '/dashboard/billing/usage'): BalanceReading {
  return { value, kind: 'spent_total', unit: 'USD', currency: null, endpoint };
}

const PRICES = { input: 2, output: 8 };
const USAGE: Usage = { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 };
// cost = (1000×2 + 500×8)/1e6 = 0.006
const UNIT_COST = (1000 * PRICES.input + 500 * PRICES.output) / 1e6;

interface Harness {
  dir: string;
  flush: () => Promise<void>;
  makeReconciler: (overrides?: { readings?: Array<BalanceReading | null>; prices?: { input: number; output: number; cachedRead?: number; threshold?: number; input2?: number; output2?: number; cachedRead2?: number } }) => Reconciler;
  cleanup: () => void;
}

function makeHarness(readings: Array<BalanceReading | null>): Harness {
  const dir = makeTempDir();
  const journal = new JournalWriter(dir);
  let call = 0;
  const makeReconciler = (overrides?: { readings?: Array<BalanceReading | null>; prices?: { input: number; output: number; cachedRead?: number; threshold?: number; input2?: number; output2?: number; cachedRead2?: number } }): Reconciler => {
    const series = overrides?.readings ?? readings;
    call = 0;
    return new Reconciler({
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'test-key',
      prices: overrides?.prices ?? PRICES,
      intervalMs: 60000,
      journal,
      queryBalance: async () => {
        const value = series[Math.min(call, series.length - 1)];
        call += 1;
        return value ?? null;
      },
      onSummary: () => undefined,
      onAlert: () => undefined,
    });
  };
  return { dir, flush: () => journal.flush(), makeReconciler, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('guard gradeRatio：DRIFT 阈值分级（0.05/0.2 带宽 + 1.5 硬阈值）', () => {
  assert.equal(gradeRatio(1.0), 'ok');
  assert.equal(gradeRatio(1.05), 'ok'); // |Δ|=0.05 不超绝对阈值
  assert.equal(gradeRatio(1.2), 'ok'); // |Δ|=0.2 不超相对阈值（不大于）
  assert.equal(gradeRatio(0.8), 'ok');
  assert.equal(gradeRatio(1.21), 'warn'); // |Δ|=0.21 > 0.05 且 > 0.2
  assert.equal(gradeRatio(0.79), 'warn'); // 少收/单位错配同判 warn
  assert.equal(gradeRatio(1.3), 'warn');
  assert.equal(gradeRatio(1.5), 'warn'); // 1.5 不大于 1.5
  assert.equal(gradeRatio(1.51), 'fail');
  assert.equal(gradeRatio(2.0), 'fail');
});

test('guard reconcile：cost 数学（/1e6）与窗口累计', async () => {
  const harness = makeHarness([spent(0), spent(3 * UNIT_COST * 1)]);
  const { makeReconciler, cleanup } = harness;
  try {
    const reconciler = makeReconciler({ readings: [spent(0), spent(0.018)] });
    await reconciler.initialize(); // reading #1 = 0
    reconciler.recordCompletion(USAGE);
    reconciler.recordCompletion(USAGE);
    await reconciler.tick(false); // reading #2 = 0.018 → ratio = 0.018/0.012 = 1.5
    const entries = await readReconcileEntries(harness);
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.ok(entry);
    assert.equal(entry.requests, 2);
    assert.ok(Math.abs((entry.cost ?? 0) - 2 * UNIT_COST) < 1e-12, `cost=${entry.cost}`);
    assert.ok(Math.abs((entry.spendDelta ?? 0) - 0.018) < 1e-12);
    assert.ok(Math.abs((entry.ratio ?? 0) - 1.5) < 1e-9, `ratio=${entry.ratio}`);
    assert.equal(entry.verdict, 'warn');
  } finally {
    cleanup();
  }
});

test('guard reconcile：缓存读 + 二档阶梯价与 gateway 同口径（严格 > threshold 才切档）', async () => {
  const prices = { input: 1, output: 4, cachedRead: 0.5, threshold: 1000, input2: 3, output2: 6, cachedRead2: 0.25 };
  // 二档：prompt=1001 > 1000 → (1001-300)×3 + 300×0.25 + 4×6 = 2202；一档：prompt=1000 → 1000×1 + 4×4 = 1016
  const tier2: Usage = { prompt_tokens: 1001, completion_tokens: 4, total_tokens: 1005, cached_tokens: 300 };
  const tier1: Usage = { prompt_tokens: 1000, completion_tokens: 4, total_tokens: 1004 };
  const expected = (2202 + 1016) / 1e6;
  const harness = makeHarness([spent(0), spent(expected)]);
  try {
    const reconciler = harness.makeReconciler({ prices });
    await reconciler.initialize();
    reconciler.recordCompletion(tier2);
    reconciler.recordCompletion(tier1);
    await reconciler.tick(false);
    const entry = (await readReconcileEntries(harness))[0];
    assert.ok(entry);
    assert.ok(Math.abs((entry.cost ?? 0) - expected) < 1e-12, `cost=${entry.cost}`);
    assert.equal(entry.ratio, 1);
    assert.equal(entry.verdict, 'ok');
  } finally {
    harness.cleanup();
  }
});

test('guard reconcile：窗口含缺失/无效 usage → 作废不出倍率（分母不完整，防假阳性 fail）', async () => {
  // spendDelta=2.5×UNIT_COST 但只有 1 笔 usage 进分母：旧实现 ratio=2.5 → 假 fail；
  // 与测试侧「ratio_contaminated 作废实测」同纪律：缺 usage 的窗口绝不出判定
  const harness = makeHarness([spent(0), spent(2.5 * UNIT_COST)]);
  try {
    const reconciler = harness.makeReconciler();
    await reconciler.initialize();
    reconciler.recordCompletion(USAGE);
    reconciler.recordCompletion(null); // 上游已发但 usage 缺失/无效：真实扣费在 Δ 里，分母缺这份成本
    await reconciler.tick(true);
    const entry = (await readReconcileEntries(harness))[0];
    assert.ok(entry);
    assert.equal(entry.requests, 2);
    assert.equal(entry.usageMissing, 1);
    assert.equal(entry.verdict, 'skipped');
    assert.equal(entry.ratio, null);
    assert.match(entry.message, /缺失\/无效 usage/);
  } finally {
    harness.cleanup();
  }
});

test('guard reconcile：k=1.3 → verdict=warn，ratio≈1.3（e2e 同口径的纯逻辑面）', async () => {
  const cost = UNIT_COST;
  const harness = makeHarness([spent(0), spent(1.3 * cost)]);
  try {
    const reconciler = harness.makeReconciler();
    await reconciler.initialize();
    reconciler.recordCompletion(USAGE);
    await reconciler.tick(true);
    const entry = (await readReconcileEntries(harness))[0];
    assert.ok(entry);
    assert.equal(entry.verdict, 'warn');
    assert.ok(Math.abs((entry.ratio ?? 0) - 1.3) < 1e-9);
  } finally {
    harness.cleanup();
  }
});

test('guard reconcile：余额不可得 → skipped', async () => {
  const harness = makeHarness([null, null]);
  try {
    const reconciler = harness.makeReconciler();
    await reconciler.initialize();
    reconciler.recordCompletion(USAGE);
    await reconciler.tick(false);
    const entry = (await readReconcileEntries(harness))[0];
    assert.equal(entry?.verdict, 'skipped');
    assert.equal(entry?.ratio, null);
  } finally {
    harness.cleanup();
  }
});

test('guard reconcile：两次读数跨端点不同源 → skipped', async () => {
  const harness = makeHarness([spent(0, '/dashboard/billing/usage'), spent(5, '/api/user/self')]);
  try {
    const reconciler = harness.makeReconciler();
    await reconciler.initialize();
    reconciler.recordCompletion(USAGE);
    await reconciler.tick(false);
    const entry = (await readReconcileEntries(harness))[0];
    assert.equal(entry?.verdict, 'skipped');
    assert.equal(entry?.ratio, null);
  } finally {
    harness.cleanup();
  }
});

test('guard reconcile：分母 0（全部 usage 缺失）→ skipped，缺失单列计数', async () => {
  const harness = makeHarness([spent(0), spent(0)]);
  try {
    const reconciler = harness.makeReconciler();
    await reconciler.initialize();
    reconciler.recordCompletion(null);
    reconciler.recordCompletion(null);
    await reconciler.tick(false);
    const entry = (await readReconcileEntries(harness))[0];
    assert.equal(entry?.verdict, 'skipped');
    assert.equal(entry?.usageMissing, 2);
    assert.equal(entry?.cost, 0);
    assert.equal(entry?.ratio, null);
  } finally {
    harness.cleanup();
  }
});

test('guard reconcile：非美元口径（quota）→ skipped，不出假倍率', async () => {
  // quota 粒度与 USD 不同；同源 quota 差值 ÷ 美元应缴会产出天文倍率，必须跳过（不换算单位）。
  const quota = (value: number): BalanceReading => ({
    value,
    kind: 'balance',
    unit: 'quota',
    currency: null,
    endpoint: '/api/user/self',
  });
  const harness = makeHarness([quota(500000), quota(499000)]);
  try {
    const reconciler = harness.makeReconciler();
    await reconciler.initialize();
    reconciler.recordCompletion(USAGE);
    await reconciler.tick(true);
    const entry = (await readReconcileEntries(harness))[0];
    assert.ok(entry);
    assert.equal(entry.verdict, 'skipped');
    assert.equal(entry.ratio, null);
    assert.match(entry.message, /非美元口径/);
  } finally {
    harness.cleanup();
  }
});

test('guard reconcile：Δ<0（充值/退款混入）→ skipped_recharge，不出 ratio', async () => {
  const harness = makeHarness([spent(10), spent(9)]);
  try {
    const reconciler = harness.makeReconciler();
    await reconciler.initialize();
    reconciler.recordCompletion(USAGE);
    await reconciler.tick(false);
    const entry = (await readReconcileEntries(harness))[0];
    assert.equal(entry?.verdict, 'skipped_recharge');
    assert.equal(entry?.ratio, null);
    assert.ok((entry?.spendDelta ?? 0) < 0);
  } finally {
    harness.cleanup();
  }
});

test('guard reconcile：窗口按完成时间归属——tick 后的请求计入下一窗口', async () => {
  const cost = UNIT_COST;
  // 第 2 次查询在第一次 tick（cost=1×UNIT_COST）；第 3 次查询在第二次 tick（再完成 1 笔 → Δ=cost，ratio=1）
  const harness = makeHarness([spent(0), spent(cost), spent(2 * cost)]);
  try {
    const reconciler = harness.makeReconciler();
    await reconciler.initialize();
    reconciler.recordCompletion(USAGE);
    await reconciler.tick(false); // 窗口 1：requests=1 cost=UNIT_COST ratio=1
    reconciler.recordCompletion(USAGE);
    await reconciler.tick(false); // 窗口 2：requests=1 cost=UNIT_COST ratio=1
    const entries = await readReconcileEntries(harness);
    assert.equal(entries.length, 2);
    for (const entry of entries) {
      assert.equal(entry.requests, 1);
      assert.equal(entry.verdict, 'ok');
      assert.ok(Math.abs((entry.ratio ?? 0) - 1) < 1e-9);
    }
  } finally {
    harness.cleanup();
  }
});

test('guard reconcile：空窗静默——无请求且 Δ=0 不产生事件', async () => {
  const harness = makeHarness([spent(5), spent(5), spent(5)]);
  try {
    const reconciler = harness.makeReconciler();
    await reconciler.initialize();
    await reconciler.tick(false);
    await reconciler.tick(false);
    assert.equal((await readReconcileEntries(harness)).length, 0);
  } finally {
    harness.cleanup();
  }
});

test('guard reconcile：读数失败清空基线，下窗不产生跨窗口假倍率', async () => {
  // 初始成功 → 窗口 1 查询失败（null）→ 窗口 2 恢复：若无清基线，Δ 会跨两窗、ratio 虚高
  const harness = makeHarness([spent(0), null, spent(3 * UNIT_COST)]);
  try {
    const reconciler = harness.makeReconciler();
    await reconciler.initialize();
    reconciler.recordCompletion(USAGE);
    await reconciler.tick(false); // 查询失败 → skipped
    reconciler.recordCompletion(USAGE);
    reconciler.recordCompletion(USAGE);
    await reconciler.tick(false); // 基线已清 → skipped（不冒出 1.5 假倍率）
    const entries = await readReconcileEntries(harness);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.verdict, 'skipped');
    assert.equal(entries[1]?.verdict, 'skipped');
    assert.equal(entries[1]?.ratio, null);
  } finally {
    harness.cleanup();
  }
});
