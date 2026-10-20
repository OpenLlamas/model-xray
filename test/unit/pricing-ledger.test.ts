// src/pricing-ledger.ts 单测：账本路径/锁/追加/读取/轮转与漂移比较。
// 这些是「无 --baseline 也能自动检出倍率漂移」的地基——写坏账本或误判显著项会直接制造假告警/漏报。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendPricingSnapshot,
  buildLedgerEntry,
  comparePricingSnapshots,
  ledgerOriginKey,
  ledgerPath,
  normalizeLedgerOrigin,
  readLastPricingSnapshot,
  sanitizeHost,
  shouldRemoveStaleLock,
  snapshotFromDeclared,
  withLedgerLock,
  type PricingLedgerEntry,
} from '../../src/pricing-ledger.js';
import type { DeclaredModelPricing, DeclaredPricing } from '../../src/pricing.js';
import type { DeclaredPricingSnapshot, DeclaredPricingSnapshotModel } from '../../src/types.js';

const ORIGIN = 'https://relay.example.com';

/** 启动一个立即退出的子进程并返回其 pid（该 pid 必然不可达，用于模拟崩溃遗留锁）。 */
function exitedPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true });
    child.on('error', reject);
    child.on('close', () => resolve(child.pid as number));
  });
}

/** 启动一个长期存活的子进程（模拟仍在持锁的慢写入者）。 */
function liveChild(): Promise<{ pid: number; kill: () => void }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore', windowsHide: true });
    child.on('error', reject);
    child.on('spawn', () => resolve({ pid: child.pid as number, kill: () => child.kill() }));
  });
}

function ledgerModel(patch: Partial<DeclaredModelPricing> = {}): DeclaredModelPricing {
  return {
    modelName: 'gpt-4o',
    modelRatio: 1,
    completionRatio: 4,
    cacheRatio: null,
    quotaType: 0,
    modelPrice: null,
    groups: [],
    ...patch,
  };
}

function declared(patch: Partial<DeclaredPricing> = {}): DeclaredPricing {
  return {
    origin: ORIGIN,
    capturedAt: '2026-10-19T00:00:00.000Z',
    quotaPerUnit: 500000,
    quotaPerUnitConflict: null,
    models: { 'gpt-4o': ledgerModel() },
    groupRatio: { default: 1 },
    group: null,
    ...patch,
  };
}

function snapshotModel(patch: Partial<DeclaredPricingSnapshotModel> = {}): DeclaredPricingSnapshotModel {
  return { modelRatio: 1, completionRatio: 4, cacheRatio: null, modelPrice: null, quotaType: 0, ...patch };
}

function snapshot(patch: Partial<DeclaredPricingSnapshot> = {}): DeclaredPricingSnapshot {
  return {
    origin: ORIGIN,
    capturedAt: '2026-10-01T00:00:00.000Z',
    quotaPerUnit: 500000,
    group: null,
    models: { 'gpt-4o': snapshotModel() },
    groupRatio: { default: 1 },
    ...patch,
  };
}

test('ledgerPath/sanitizeHost：同源稳定、字符安全、非 http(s) 拒绝', () => {
  const path = ledgerPath('reports', 'https://relay.example.com:8443/v1');
  assert.match(path, /pricing[\\/]relay\.example\.com_8443-[0-9a-f]{12}\.jsonl$/, path);
  // 归一化后相同（尾斜杠/query/凭证不影响哈希）→ 同源同文件
  assert.equal(
    ledgerPath('reports', 'https://user:pass@relay.example.com:8443/v1?x=1#h'),
    ledgerPath('reports', 'https://relay.example.com:8443/v1'),
  );
  // 归档键只含「协议//主机:端口」：同一主机的不同反代路径前缀共享同一账本文件
  assert.equal(ledgerOriginKey('https://user:pass@Relay.Example.COM:443/v1?x=1#h'), 'https://relay.example.com');
  assert.equal(ledgerOriginKey('https://relay.example.com:8443/relay/v1'), 'https://relay.example.com:8443');
  assert.equal(
    ledgerPath('reports', 'https://relay.example.com/v1'),
    ledgerPath('reports', 'https://relay.example.com/relay/v1'),
  );
  assert.notEqual(ledgerPath('reports', 'https://relay.example.com/v1'), ledgerPath('reports', 'https://other.example.com/v1'));
  assert.equal(normalizeLedgerOrigin('https://relay.example.com/v1'), 'https://relay.example.com/v1');
  assert.throws(() => normalizeLedgerOrigin('ftp://relay.example.com'), /http\/https/);
  assert.equal(sanitizeHost('Relay.Example.COM:443'), 'relay.example.com_443');
  assert.equal(sanitizeHost('[::1]:8080'), '_1_8080');
  assert.equal(sanitizeHost('......'), 'origin');
  assert.equal(sanitizeHost('../..'), 'origin');
});

test('appendPricingSnapshot/readLastPricingSnapshot：追加-写回一致，锁文件不残留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mx-ledger-'));
  try {
    const entry = buildLedgerEntry(declared(), 'gpt-4o');
    const path = appendPricingSnapshot(dir, entry);
    assert.equal(path, ledgerPath(dir, ORIGIN));
    assert.ok(!existsSync(`${path}.lock`), '正常追加后锁文件必须释放');

    const read = readLastPricingSnapshot(dir, ORIGIN);
    assert.equal(read.kind, 'ok');
    assert.deepEqual(read.entry, entry);
    assert.equal(read.corruptLines, 0);

    // 再次追加：append-only，两条都保留
    appendPricingSnapshot(dir, buildLedgerEntry(declared({ capturedAt: '2026-10-20T00:00:00.000Z' }), 'gpt-4o'));
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(readLastPricingSnapshot(dir, ORIGIN).entry?.capturedAt, '2026-10-20T00:00:00.000Z');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readLastPricingSnapshot：缺失=missing；尾部损坏跳过并标 tailCorrupt；半行=尾部损坏；全坏=error；空文件=error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mx-ledger-'));
  try {
    assert.equal(readLastPricingSnapshot(dir, ORIGIN).kind, 'missing');
    const path = ledgerPath(dir, ORIGIN);
    appendPricingSnapshot(dir, buildLedgerEntry(declared(), 'gpt-4o'));

    // 尾部损坏行（比最新有效条目更新）：跳过并计数，仍取到有效条目，但 tailCorrupt=true
    appendFileSync(path, 'not-json\n');
    const skipped = readLastPricingSnapshot(dir, ORIGIN);
    assert.equal(skipped.kind, 'ok');
    assert.equal(skipped.corruptLines, 1);
    assert.equal(skipped.tailCorrupt, true, '更新的位置有坏行 → 无法确认最新快照');

    // 写入中断的半行（无换行）：不得被当成有效行，且标记尾部损坏
    appendFileSync(path, '{"schemaVersion":1,"origin":"https://relay.exam');
    const half = readLastPricingSnapshot(dir, ORIGIN);
    assert.equal(half.kind, 'ok');
    assert.equal(half.tailCorrupt, true, '未终止半行 → 无法确认最新快照');

    // 全是垃圾 → error（绝不冒充「首次运行」）
    writeFileSync(path, 'garbage\n');
    const broken = readLastPricingSnapshot(dir, ORIGIN);
    assert.equal(broken.kind, 'error');
    assert.match(broken.error ?? '', /无有效条目/);

    writeFileSync(path, '');
    assert.equal(readLastPricingSnapshot(dir, ORIGIN).kind, 'error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readLastPricingSnapshot：中段损坏只计数不标 tailCorrupt；尾部再坏才标记', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mx-ledger-'));
  try {
    const path = ledgerPath(dir, ORIGIN);
    // E1, garbage, E2：坏行比最新有效条目 E2 更旧 → 中段损坏
    appendPricingSnapshot(dir, buildLedgerEntry(declared({ capturedAt: '2026-10-20T00:00:00.000Z' }), 'gpt-4o'));
    appendFileSync(path, 'garbage-middle\n');
    appendPricingSnapshot(dir, buildLedgerEntry(declared({ capturedAt: '2026-10-21T00:00:00.000Z' }), 'gpt-4o'));
    const middle = readLastPricingSnapshot(dir, ORIGIN);
    assert.equal(middle.kind, 'ok');
    assert.equal(middle.entry?.capturedAt, '2026-10-21T00:00:00.000Z');
    assert.equal(middle.corruptLines, 1, '中段损坏计入诊断计数');
    assert.equal(middle.tailCorrupt, false, '中段损坏不影响「最新快照」判定');

    // E1, garbage-middle, E2, garbage-tail：尾部（更新位置）坏行 → tailCorrupt
    appendFileSync(path, 'garbage-tail\n');
    const tail = readLastPricingSnapshot(dir, ORIGIN);
    assert.equal(tail.kind, 'ok');
    assert.equal(tail.entry?.capturedAt, '2026-10-21T00:00:00.000Z');
    assert.equal(tail.corruptLines, 2);
    assert.equal(tail.tailCorrupt, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withLedgerLock：锁内读-比-写；陈旧锁自动清理；连续追加不丢条目', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mx-ledger-'));
  try {
    const path = ledgerPath(dir, ORIGIN);
    const first = buildLedgerEntry(declared(), 'gpt-4o');
    const written = withLedgerLock(dir, ORIGIN, (appendLocked) => {
      const before = readLastPricingSnapshot(dir, ORIGIN);
      assert.equal(before.kind, 'missing');
      return appendLocked(first);
    });
    assert.equal(written, path);
    assert.ok(!existsSync(`${path}.lock`), '锁必须在 finally 释放');

    // 陈旧锁（mtime 超过阈值 + 持锁 pid 已退出）：被清理后继续成功
    const deadPid = await exitedPid();
    writeFileSync(`${path}.lock`, `${deadPid}\n`);
    const past = new Date(Date.now() - 120_000);
    utimesSync(`${path}.lock`, past, past);
    withLedgerLock(dir, ORIGIN, (appendLocked) => appendLocked(buildLedgerEntry(declared({ capturedAt: '2026-10-21T00:00:00.000Z' }), 'gpt-4o')));
    assert.equal(readLastPricingSnapshot(dir, ORIGIN).entry?.capturedAt, '2026-10-21T00:00:00.000Z');

    // 锁内容不可解析 + 超过陈旧阈值：按陈旧锁清理
    writeFileSync(`${path}.lock`, 'not-a-pid\n');
    utimesSync(`${path}.lock`, past, past);
    withLedgerLock(dir, ORIGIN, (appendLocked) => appendLocked(buildLedgerEntry(declared({ capturedAt: '2026-10-21T12:00:00.000Z' }), 'gpt-4o')));
    assert.equal(readLastPricingSnapshot(dir, ORIGIN).entry?.capturedAt, '2026-10-21T12:00:00.000Z');

    // 并发追加（两个异步任务各自完整跑 appendPricingSnapshot）：两条都必须落盘
    await Promise.all([
      (async () => appendPricingSnapshot(dir, buildLedgerEntry(declared({ capturedAt: '2026-10-22T00:00:00.000Z' }), 'gpt-4o')))(),
      (async () => appendPricingSnapshot(dir, buildLedgerEntry(declared({ capturedAt: '2026-10-23T00:00:00.000Z' }), 'gpt-4o')))(),
    ]);
    const lines = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as PricingLedgerEntry);
    const stamps = lines.map((line) => line.capturedAt);
    assert.ok(stamps.includes('2026-10-22T00:00:00.000Z') && stamps.includes('2026-10-23T00:00:00.000Z'), stamps.join(','));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withLedgerLock：持锁进程存活时不得夺锁（即使锁文件超过陈旧阈值），超时报「价格账本被占用」', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mx-ledger-'));
  const child = await liveChild();
  try {
    const path = ledgerPath(dir, ORIGIN);
    appendPricingSnapshot(dir, buildLedgerEntry(declared(), 'gpt-4o'));
    // 锁 mtime 远超过 60s 阈值，但持锁 pid 仍存活 → 必须重试到超时，而不是把别人的锁删掉
    writeFileSync(`${path}.lock`, `${child.pid}\n`);
    const past = new Date(Date.now() - 120_000);
    utimesSync(`${path}.lock`, past, past);
    const startedAt = Date.now();
    assert.throws(
      () => withLedgerLock(dir, ORIGIN, (appendLocked) => appendLocked(buildLedgerEntry(declared({ capturedAt: '2026-10-24T00:00:00.000Z' }), 'gpt-4o'))),
      /价格账本被占用/,
    );
    assert.ok(Date.now() - startedAt >= 4000, `应等待锁超时而非立即夺锁（实际 ${Date.now() - startedAt}ms）`);
    assert.ok(existsSync(`${path}.lock`), '存活进程的锁不得被删除');
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shouldRemoveStaleLock：两次读之间 token 变化 → retry（绝不删新主人的锁）；token 一致 + pid 不可达 → delete', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mx-lock-'));
  try {
    const lockPath = join(dir, 'x.lock');
    const deadPid = await exitedPid();
    const tokenA = 'a'.repeat(32);
    const tokenB = 'b'.repeat(32);
    const contentA = `${JSON.stringify({ pid: deadPid, token: tokenA })}\n`;
    const contentB = `${JSON.stringify({ pid: deadPid, token: tokenB })}\n`;
    const past = new Date(Date.now() - 120_000);
    writeFileSync(lockPath, contentA);
    utimesSync(lockPath, past, past);
    const now = Date.now();

    // 第一次读 = 旧锁（token A），第二次读 = 新主人接管（token B）→ retry，绝不能删
    const flipping: string[] = [contentA, contentB];
    let flips = 0;
    assert.equal(
      shouldRemoveStaleLock(lockPath, now, () => flipping[flips++] ?? null),
      'retry',
      'token 变化必须重试而不是删除',
    );

    // 两次读一致（token A）+ pid 已退出 + 超过陈旧阈值 → delete
    assert.equal(shouldRemoveStaleLock(lockPath, now, () => contentA), 'delete');
    assert.ok(existsSync(lockPath), 'shouldRemoveStaleLock 本身不执行删除（由调用方 unlink）');

    // 锁新鲜（mtime 未超过阈值）→ keep，即使 pid 不可达
    utimesSync(lockPath, new Date(), new Date());
    assert.equal(shouldRemoveStaleLock(lockPath, Date.now(), () => contentA), 'keep');

    // 内容不可解析 + 陈旧：两次读一致 → delete；两次读不同 → retry
    writeFileSync(lockPath, 'not-a-lock\n');
    utimesSync(lockPath, past, past);
    assert.equal(shouldRemoveStaleLock(lockPath, Date.now(), () => 'not-a-lock\n'), 'delete');
    const garbageFlip: string[] = ['not-a-lock\n', 'not-a-lock-either\n'];
    let garbageFlips = 0;
    assert.equal(
      shouldRemoveStaleLock(lockPath, Date.now(), () => garbageFlip[garbageFlips++] ?? null),
      'retry',
    );

    // 读取竞态失败（null）→ retry
    assert.equal(shouldRemoveStaleLock(lockPath, Date.now(), () => null), 'retry');

    // 审查必修：旧式纯 pid 锁（token=''）——两次读之间被换成「另一把旧式锁且持活 pid」
    // 時，全记录比较（pid 不同）→ retry，绝不误删活锁
    const legacyDead = `${deadPid}\n`;
    const legacyLive = `${process.pid}\n`;
    writeFileSync(lockPath, legacyDead);
    utimesSync(lockPath, past, past);
    const legacyFlip: string[] = [legacyDead, legacyLive];
    let legacyFlips = 0;
    assert.equal(
      shouldRemoveStaleLock(lockPath, Date.now(), () => legacyFlip[legacyFlips++] ?? null),
      'retry',
      '旧式锁全记录比较：pid 变化必须 retry',
    );

    // 同号 pid、token 不同（新式 dead 锁 vs 旧式接管）：全记录比较 token 不等 → retry，
    // 只比 token 的旧实现会在这里误删
    const samePidLegacy = `${deadPid}\n`;
    writeFileSync(lockPath, contentA);
    utimesSync(lockPath, past, past);
    const samePidFlip: string[] = [contentA, samePidLegacy, samePidLegacy];
    let samePidFlips = 0;
    assert.equal(
      shouldRemoveStaleLock(lockPath, Date.now(), () => samePidFlip[samePidFlips++] ?? null),
      'retry',
      '同 pid 但 token 变化（新式→旧式）必须 retry',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shouldRemoveStaleLock：本进程自己持有的锁绝不删除', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mx-lock-'));
  try {
    withLedgerLock(dir, ORIGIN, () => {
      const lockPath = `${ledgerPath(dir, ORIGIN)}.lock`;
      const past = new Date(Date.now() - 120_000);
      utimesSync(lockPath, past, past);
      assert.equal(shouldRemoveStaleLock(lockPath, Date.now()), 'keep');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readLastPricingSnapshot：同主机不同路径共享账本，origin 不一致时给出 originNote；同路径为 null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mx-ledger-'));
  try {
    assert.equal(ledgerPath(dir, 'https://relay.example.com/v1'), ledgerPath(dir, 'https://relay.example.com/relay/v1'));
    appendPricingSnapshot(dir, buildLedgerEntry(declared({ origin: 'https://relay.example.com/v1' }), 'gpt-4o'));
    assert.equal(readdirSync(join(dir, 'pricing')).length, 1, '路径别名不得新建账本文件');

    const viaV1 = readLastPricingSnapshot(dir, 'https://relay.example.com/v1');
    assert.equal(viaV1.kind, 'ok');
    assert.equal(viaV1.originNote, null, '同一路径对照不得产生披露');

    const viaRelay = readLastPricingSnapshot(dir, 'https://relay.example.com/relay/v1');
    assert.equal(viaRelay.kind, 'ok');
    assert.equal(viaRelay.entry?.capturedAt, viaV1.entry?.capturedAt);
    assert.equal(viaRelay.originNote, '对照快照抓取自同主机不同路径（https://relay.example.com/v1）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('轮转：超过 5MB 保留最近 500 条有效行（原子重写），最新条目仍可读', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mx-ledger-'));
  try {
    const small = buildLedgerEntry(declared(), 'gpt-4o');
    for (let i = 0; i < 510; i += 1) appendPricingSnapshot(dir, small);
    const path = ledgerPath(dir, ORIGIN);
    for (let i = 1; i <= 6; i += 1) {
      // 单行 ≈1MB：6 条必然把文件推过 5MB 阈值
      const key = `big${i}-${'x'.repeat(999_000)}`;
      appendPricingSnapshot(
        dir,
        buildLedgerEntry(declared({ models: { [key]: ledgerModel({ modelName: key }) } }), 'gpt-4o'),
      );
    }
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    assert.equal(lines.length, 500, `轮转后应恰为 500 条有效行（实际 ${lines.length}）`);
    const last = readLastPricingSnapshot(dir, ORIGIN);
    assert.equal(last.kind, 'ok');
    assert.ok(Object.keys(last.entry?.models ?? {}).some((key) => key.startsWith('big6-')), '最后一条应为最新写入');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('snapshotFromDeclared/buildLedgerEntry：字段保全（cache/modelPrice/quotaType 缺省为 null）', () => {
  const snap = snapshotFromDeclared(declared());
  assert.deepEqual(snap.models['gpt-4o'], { modelRatio: 1, completionRatio: 4, cacheRatio: null, modelPrice: null, quotaType: 0 });
  const entry = buildLedgerEntry(declared({ group: 'vip' }), 'glm-5.3');
  assert.equal(entry.schemaVersion, 1);
  assert.equal(entry.model, 'glm-5.3');
  assert.equal(entry.group, 'vip');
});

test('comparePricingSnapshots：数值漂移显著性与文案（>5% 才算显著，恰好 5% 不算）', () => {
  const up = comparePricingSnapshots(snapshot({ models: { 'gpt-4o': snapshotModel({ modelRatio: 0.8 }) } }), declared());
  assert.equal(up.length, 1);
  assert.equal(up[0]?.kind, 'numeric');
  assert.equal(up[0]?.field, 'model_ratio');
  assert.equal(up[0]?.direction, 'up');
  assert.equal(up[0]?.significant, true);
  assert.equal((up[0]?.relativeChange ?? 0).toFixed(4), '0.2500');
  assert.equal(up[0]?.message, '由 0.8 上调至 1（+25.0%）');

  const down = comparePricingSnapshots(snapshot(), declared({ models: { 'gpt-4o': ledgerModel({ modelRatio: 0.8 }) } }));
  assert.equal(down[0]?.direction, 'down');
  assert.equal(down[0]?.message, '由 1 下调至 0.8（-20.0%）');

  // 恰好 +5% 不显著（浮点噪声不得顶进显著档）
  const exact = comparePricingSnapshots(snapshot(), declared({ models: { 'gpt-4o': ledgerModel({ modelRatio: 1.05 }) } }));
  assert.equal(exact[0]?.significant, false);
  assert.equal(exact[0]?.relativeChange, 0.050000000000000044);

  // 旧值为 0：无法算百分比，不显著，方向 unknown
  const zero = comparePricingSnapshots(
    snapshot({ models: { 'gpt-4o': snapshotModel({ modelRatio: 0 }) } }),
    declared({ models: { 'gpt-4o': ledgerModel({ modelRatio: 3 }) } }),
  );
  assert.equal(zero[0]?.relativeChange, null);
  assert.equal(zero[0]?.direction, 'unknown');
  assert.equal(zero[0]?.significant, false);
  assert.match(zero[0]?.message ?? '', /旧值为 0/);
});

test('comparePricingSnapshots：cache_ratio 补齐不告警、消失告警；quota_type 基准变更改为口径断裂项', () => {
  // 旧条目缺 cache_ratio（schema 升级噪声）：presence added 且不显著
  const added = comparePricingSnapshots(snapshot(), declared({ models: { 'gpt-4o': ledgerModel({ cacheRatio: 0.28 }) } }));
  assert.equal(added.length, 1);
  assert.equal(added[0]?.field, 'cache_ratio');
  assert.equal(added[0]?.significant, false);
  assert.equal(added[0]?.direction, 'unknown');
  // 反向：旧有新无 → 显著 presence
  const removed = comparePricingSnapshots(
    snapshot({ models: { 'gpt-4o': snapshotModel({ cacheRatio: 0.28 }) } }),
    declared({ models: { 'gpt-4o': ledgerModel({ cacheRatio: null }) } }),
  );
  assert.equal(removed[0]?.field, 'cache_ratio');
  assert.equal(removed[0]?.significant, true);
  // quota_type null→1（旧侧无口径证据）：不得断言「站点换了计费基准」——旧条目缺列只是 schema 演进噪声，
  // 断言显著会把每次升级都变成一次假漂移告警。只作非显著披露。
  const quota = comparePricingSnapshots(
    snapshot({ models: { 'gpt-4o': snapshotModel({ quotaType: null }) } }),
    declared({ models: { 'gpt-4o': ledgerModel({ quotaType: 1 }) } }),
  );
  assert.equal(quota.length, 1);
  assert.equal(quota[0]?.kind, 'basis');
  assert.equal(quota[0]?.field, 'quota_type');
  assert.equal(quota[0]?.significant, false);
  assert.equal(quota[0]?.relativeChange, null);
  assert.match(quota[0]?.message ?? '', /旧侧未公示/);
  // quota_type 0→1：两侧口径都有显式证据 → 确实换了计费基准，显著（不再是「只作 info」的枚举项）
  const enumDrift = comparePricingSnapshots(snapshot(), declared({ models: { 'gpt-4o': ledgerModel({ quotaType: 1 }) } }));
  assert.equal(enumDrift.length, 1);
  assert.equal(enumDrift[0]?.kind, 'basis');
  assert.equal(enumDrift[0]?.significant, true);
  assert.match(enumDrift[0]?.message ?? '', /计费基准变更/);
});

test('comparePricingSnapshots：旧条目缺 quota_type 列时按站点默认（按 token）比价，不产出假基准漂移', () => {
  // 旧条目来自没有 quota_type 列的账本 schema：口径未知，不能当 per-token 断言「站点改口径」，
  // 但新侧也公示了按 token → 两侧都按 token 比，倍率变化照样可见（不漏报）。
  const drifts = comparePricingSnapshots(
    snapshot({ models: { 'gpt-4o': snapshotModel({ quotaType: null, modelRatio: 1, completionRatio: 4 }) } }),
    declared({ models: { 'gpt-4o': ledgerModel({ quotaType: 0, modelRatio: 2, completionRatio: 4 }) } }),
  );
  const basis = drifts.find((drift) => drift.field === 'quota_type');
  assert.equal(basis?.significant, false, '口径未知只披露，不判显著');
  const ratio = drifts.find((drift) => drift.field === 'model_ratio');
  assert.equal(ratio?.kind, 'numeric');
  assert.equal(ratio?.significant, true, '按 token 比价不应被口径未知挡掉（否则漏报）');
  // 未知枚举值（站点自定义）同样按 unknown 处理，不得臆断成按 token 基准变更
  const custom = comparePricingSnapshots(
    snapshot({ models: { 'gpt-4o': snapshotModel({ quotaType: 0, modelRatio: 1 }) } }),
    declared({ models: { 'gpt-4o': ledgerModel({ quotaType: 2, modelRatio: 1 }) } }),
  );
  assert.equal(custom.find((drift) => drift.field === 'quota_type')?.significant, false);
  assert.equal(custom.some((drift) => drift.field === 'model_ratio'), false);
});

test('comparePricingSnapshots：有效倍率与 model_price 同时存在时不得判成按次（防止漏报倍率漂移）', () => {
  // 真按 token 计费的旧账本（ratio 有效），model_price 是站点顺带回填的遗留值/0：
  // 若据此判 per-call，就会比出「站点改成按次计费」的假基准告警，并把真正的倍率漂移一并漏掉。
  const drifts = comparePricingSnapshots(
    snapshot({ models: { 'gpt-4o': snapshotModel({ quotaType: null, modelRatio: 1, completionRatio: 4, modelPrice: 0 }) } }),
    declared({ models: { 'gpt-4o': ledgerModel({ quotaType: 0, modelRatio: 3, completionRatio: 4, modelPrice: 0 }) } }),
  );
  assert.equal(drifts.find((drift) => drift.field === 'quota_type')?.significant, false, '不得断言换基准');
  const ratio = drifts.find((drift) => drift.field === 'model_ratio');
  assert.equal(ratio?.kind, 'numeric', '有效倍率必须照比（漏报即失职）');
  assert.equal(ratio?.significant, true);
  // 按 token 口径下的 model_price 变化：只披露不判显著（one-api 类按 price 计费也不该判 fail）
  const priceSide = comparePricingSnapshots(
    snapshot({ models: { 'gpt-4o': snapshotModel({ quotaType: null, modelRatio: 1, modelPrice: 0.02 }) } }),
    declared({ models: { 'gpt-4o': ledgerModel({ quotaType: 0, modelRatio: 1, modelPrice: 0.05 }) } }),
  );
  const price = priceSide.find((drift) => drift.field === 'model_price');
  assert.equal(price?.kind, 'numeric');
  assert.equal(price?.significant, false, '按 token 口径下的附带单价字段不得判显著');
});

test('comparePricingSnapshots：两侧口径未知/单侧未公示的对称情形都只披露不比价', () => {
  // 旧 unknown（无 quota_type、无有效倍率、无单价）+ 新 per-call（两侧字段不对称）
  const oldUnknownNewCall = comparePricingSnapshots(
    snapshot({ models: { 'gpt-4o': snapshotModel({ quotaType: null, modelRatio: 0, modelPrice: null }) } }),
    declared({ models: { 'gpt-4o': ledgerModel({ quotaType: 1, modelRatio: 0, modelPrice: 0.02 }) } }),
  );
  const basisNew = oldUnknownNewCall.filter((drift) => drift.field === 'quota_type');
  assert.equal(basisNew.length, 1, '口径披露只出一条');
  assert.equal(basisNew[0]?.significant, false);
  assert.match(basisNew[0]?.message ?? '', /旧侧未公示/);
  assert.equal(basisNew[0]?.relativeChange, null, '口径披露项不得带数值结论');
  // 按次单价从无到有：旧条目缺列 = 升级噪声，只作非显著披露
  assert.equal(oldUnknownNewCall.find((drift) => drift.field === 'model_price')?.significant, false);

  // 旧 per-call + 新 unknown（对称方向）：新侧证据全消失（无 quota_type、无倍率、无单价），
  // 单价消失属真实变化（按次模型不再公示单价），判显著
  const oldCallNewUnknown = comparePricingSnapshots(
    snapshot({ models: { 'gpt-4o': snapshotModel({ quotaType: 1, modelRatio: 0, completionRatio: 0, modelPrice: 0.02 }) } }),
    declared({ models: { 'gpt-4o': ledgerModel({ quotaType: null, modelRatio: 0, completionRatio: 0, modelPrice: null }) } }),
  );
  assert.equal(oldCallNewUnknown[0]?.field, 'quota_type');
  assert.equal(oldCallNewUnknown[0]?.significant, false);
  assert.match(oldCallNewUnknown[0]?.message ?? '', /新侧未公示计费基准/);
  assert.equal(oldCallNewUnknown.find((drift) => drift.field === 'model_price')?.significant, true);

  // 双侧未知且两侧都没有任何可比的数值字段：只有一条口径披露，零数值项
  const bothUnknown = comparePricingSnapshots(
    snapshot({ models: { 'gpt-4o': snapshotModel({ quotaType: null, modelRatio: 0, modelPrice: null }) } }),
    declared({ models: { 'gpt-4o': ledgerModel({ quotaType: null, modelRatio: 0, modelPrice: null }) } }),
  );
  assert.equal(bothUnknown.length, 1);
  assert.equal(bothUnknown[0]?.kind, 'basis');
  assert.equal(bothUnknown[0]?.significant, false);
  assert.equal(bothUnknown.some((drift) => drift.kind === 'numeric'), false, '没有可比数值就不该产出数值项');
});

test('comparePricingSnapshots：计费基准不一致 → 拒绝数值比较（不得产出假漂移）', () => {
  // 站点把模型从按 token 改成按次：倍率数值不是同一口径，比出来必是噪声。
  const drifts = comparePricingSnapshots(
    snapshot({ models: { 'gpt-4o': snapshotModel({ quotaType: 0, modelRatio: 1, completionRatio: 4 }) } }),
    declared({ models: { 'gpt-4o': ledgerModel({ quotaType: 1, modelRatio: 1, completionRatio: 9, modelPrice: 0.02 }) } }),
  );
  assert.equal(drifts.length, 1, '基准变更只产出一条口径项，不得附带数值漂移');
  assert.equal(drifts[0]?.kind, 'basis');
  assert.equal(drifts[0]?.field, 'quota_type');
  assert.equal(drifts[0]?.significant, true);
  assert.equal(drifts.some((drift) => drift.field === 'model_ratio'), false);
  assert.equal(drifts.some((drift) => drift.field === 'completion_ratio'), false);
});

test('comparePricingSnapshots：按次计费下只比单价，倍率变化不参与计价 → 不判漂移', () => {
  const drifts = comparePricingSnapshots(
    snapshot({ models: { 'gpt-4o': snapshotModel({ quotaType: 1, modelRatio: 0, modelPrice: 0.02 }) } }),
    declared({ models: { 'gpt-4o': ledgerModel({ quotaType: 1, modelRatio: 5, modelPrice: 0.03 }) } }),
  );
  assert.equal(drifts.some((drift) => drift.field === 'model_ratio'), false, '按次计费下倍率不参与计价');
  const price = drifts.find((drift) => drift.field === 'model_price');
  assert.equal(price?.kind, 'numeric');
  assert.equal(price?.significant, true);
  assert.equal(price?.direction, 'up');
});

test('comparePricingSnapshots：quota 换算系数变更 → 口径断裂项（倍率不动也会变价）', () => {
  // 两侧均为站点公示：系数变了 = 实收金额变了，属漂移证据。
  const drifts = comparePricingSnapshots(
    snapshot({ quotaPerUnit: 500000, quotaPerUnitSource: 'site' }),
    declared({ quotaPerUnit: 250000, quotaPerUnitSource: 'site' }),
  );
  const qpu = drifts.find((drift) => drift.field === 'quota_per_unit');
  assert.equal(qpu?.kind, 'basis');
  assert.equal(qpu?.significant, true);
  assert.match(qpu?.message ?? '', /倍率不变也会改变实收金额/);

  // 来源不可比（CLI 覆盖 / 旧条目无来源）→ 只披露，不判站点漂移。
  const cliSide = comparePricingSnapshots(
    snapshot({ quotaPerUnit: 500000, quotaPerUnitSource: 'site' }),
    declared({ quotaPerUnit: 400000, quotaPerUnitSource: 'cli' }),
  );
  const cliItem = cliSide.find((drift) => drift.field === 'quota_per_unit');
  assert.equal(cliItem?.kind, 'basis');
  assert.equal(cliItem?.significant, false);
  assert.match(cliItem?.message ?? '', /来源：site → cli/);

  const legacy = comparePricingSnapshots(snapshot({ quotaPerUnit: 500000 }), declared({ quotaPerUnit: 250000, quotaPerUnitSource: 'site' }));
  assert.equal(legacy.find((drift) => drift.field === 'quota_per_unit')?.significant, false);
});

test('comparePricingSnapshots：按次单价在换算系数不一致时不做数值比较', () => {
  const drifts = comparePricingSnapshots(
    snapshot({
      quotaPerUnit: 500000,
      quotaPerUnitSource: 'site',
      models: { 'gpt-4o': snapshotModel({ quotaType: 1, modelPrice: 0.02 }) },
    }),
    declared({
      quotaPerUnit: 250000,
      quotaPerUnitSource: 'site',
      models: { 'gpt-4o': ledgerModel({ quotaType: 1, modelPrice: 0.02 }) },
    }),
  );
  const price = drifts.find((drift) => drift.field === 'model_price');
  assert.equal(price?.kind, 'basis');
  assert.equal(price?.significant, false);
  assert.equal(price?.relativeChange, null);
});

test('comparePricingSnapshots：group_ratio 数值/增删；全表模式模型增删按精确键（不折叠）', () => {
  const groupChanged = comparePricingSnapshots(snapshot({ groupRatio: { default: 1, vip: 1 } }), declared({ groupRatio: { default: 1, vip: 1.5 } }));
  assert.equal(groupChanged.length, 1);
  assert.equal(groupChanged[0]?.kind, 'group_numeric');
  assert.equal(groupChanged[0]?.field, 'group_ratio:vip');
  assert.equal(groupChanged[0]?.significant, true);
  assert.equal(groupChanged[0]?.message, '由 1 上调至 1.5（+50.0%）');

  const groupRemoved = comparePricingSnapshots(snapshot({ groupRatio: { default: 1, vip: 1 } }), declared({ groupRatio: { default: 1 } }));
  assert.equal(groupRemoved[0]?.kind, 'presence');
  assert.equal(groupRemoved[0]?.field, 'group_ratio:vip');
  assert.equal(groupRemoved[0]?.significant, true);

  // 全表模式：大小写不同的同名模型按两条 presence 处理（不做归并，避免重复/漏报歧义）
  const renamed = comparePricingSnapshots(
    snapshot({ models: { 'GPT-4O': snapshotModel() } }),
    declared({ models: { 'gpt-4o': ledgerModel() } }),
  );
  assert.equal(renamed.length, 2);
  assert.ok(renamed.every((drift) => drift.kind === 'presence' && drift.field === 'model' && drift.significant));
});

test('comparePricingSnapshots scope.model：按归并规则解析，任一侧缺失给单条 presence', () => {
  const folded = comparePricingSnapshots(
    snapshot({ models: { 'GLM-5.3': snapshotModel({ modelRatio: 0.5, completionRatio: 3 }) } }),
    declared({ models: { 'glm-5.3': ledgerModel({ modelName: 'glm-5.3', modelRatio: 0.5, completionRatio: 3 }) } }),
    { model: 'glm-5.3' },
  );
  assert.deepEqual(folded, []);

  const missingCurrent = comparePricingSnapshots(
    snapshot({ models: { 'GLM-5.3': snapshotModel({ modelRatio: 0.5 }) } }),
    declared({ models: { 'gpt-4o': ledgerModel() } }),
    { model: 'glm-5.3' },
  );
  assert.equal(missingCurrent.length, 1);
  assert.equal(missingCurrent[0]?.field, 'model');
  assert.equal(missingCurrent[0]?.significant, true);
  assert.match(missingCurrent[0]?.message ?? '', /由 1 变为（字段缺失）/);

  const missingPrevious = comparePricingSnapshots(
    snapshot({ models: { 'gpt-4o': snapshotModel() } }),
    declared({ models: { 'glm-5.3': ledgerModel({ modelName: 'glm-5.3' }), 'gpt-4o': ledgerModel() } }),
    { model: 'glm-5.3' },
  );
  assert.equal(missingPrevious.length, 1);
  assert.match(missingPrevious[0]?.message ?? '', /由（字段缺失）变为 1/);

  // scope 模型两侧都不存在：无漂移（该模型与本次审计无关，不制造噪声）
  assert.deepEqual(comparePricingSnapshots(snapshot(), declared(), { model: 'nope' }), []);
});

test('source：快照透传/legacy 省略；跨来源与已知来源不比较数值', () => {
  const apiSnapshot = snapshotFromDeclared(declared({ source: 'api' }));
  assert.equal(apiSnapshot.source, 'api');
  assert.equal(Object.hasOwn(apiSnapshot, 'source'), true);

  const legacy = snapshotFromDeclared(declared());
  assert.equal(Object.hasOwn(legacy, 'source'), false, 'legacy 快照不得生成 source:undefined 自有键');

  // 同来源照常比较（模型倍率 1→2 显著）
  const sameSource = comparePricingSnapshots(
    snapshot({ source: 'api' }),
    declared({ source: 'api', models: { 'gpt-4o': ledgerModel({ modelRatio: 2 }) } }),
  );
  assert.equal(sameSource.length, 1);
  assert.equal(sameSource[0]?.field, 'model_ratio');

  // 来源不同（api vs public-json）以及 legacy vs 已知来源：跳过，不制造跨口径漂移
  assert.deepEqual(
    comparePricingSnapshots(
      snapshot({ source: 'api' }),
      declared({ source: 'public-json', models: { 'gpt-4o': ledgerModel({ modelRatio: 2 }) } }),
    ),
    [],
  );
  assert.deepEqual(
    comparePricingSnapshots(snapshot(), declared({ source: 'api', models: { 'gpt-4o': ledgerModel({ modelRatio: 2 }) } })),
    [],
  );
});

test('comparePricingSnapshots：矛盾证据（未公示 quota_type 却同时有倍率与单价）不参与显著比价', () => {
  // 旧侧没有 quota_type，却同时有有效倍率与 model_price：那个单价是遗留/装饰值，
  // 拿它跟新侧的真按次单价比出「+150% 显著漂移」就是本项修复针对的假阳性。
  const stale = comparePricingSnapshots(
    snapshot({ models: { 'gpt-4o': snapshotModel({ quotaType: null, modelRatio: 1, modelPrice: 0.02 }) } }),
    declared({ models: { 'gpt-4o': ledgerModel({ quotaType: 1, modelRatio: 0, modelPrice: 0.05 }) } }),
  );
  assert.equal(stale.find((drift) => drift.field === 'quota_type')?.significant, false, '不得断言换基准');
  const price = stale.find((drift) => drift.field === 'model_price');
  assert.equal(price?.kind, 'numeric', '真实变化仍要披露');
  assert.equal(price?.significant, false, '来源不可信的一侧不得产出显著项');
  assert.match(price?.message ?? '', /遗留\/装饰值/);

  // 同样的真按次涨价，但旧侧没有公示任何倍率（单价可信）→ 必须判显著，不得被上面的降级规则连坐。
  const trusted = comparePricingSnapshots(
    snapshot({ models: { 'gpt-4o': snapshotModel({ quotaType: null, modelRatio: 0, completionRatio: 0, modelPrice: 0.02 }) } }),
    declared({ models: { 'gpt-4o': ledgerModel({ quotaType: 1, modelRatio: 0, completionRatio: 0, modelPrice: 0.05 }) } }),
  );
  const trustedPrice = trusted.find((drift) => drift.field === 'model_price');
  assert.equal(trustedPrice?.significant, true, '可信的真按次单价涨价必须判显著（否则漏报）');
  assert.match(trusted.find((drift) => drift.field === 'quota_type')?.message ?? '', /按单价推定为按次计费/);
});

test('comparePricingSnapshots：两侧口径都只能推定时的单价变化只披露（无可靠证据不判罚）', () => {
  // 两侧都没有 quota_type、都有倍率与单价：无法判定哪个字段驱动计费，
  // 按项目红线「不确定就披露、不判罚」处理——倍率与单价都只作非显著披露。
  const drifts = comparePricingSnapshots(
    snapshot({ models: { 'gpt-4o': snapshotModel({ quotaType: null, modelRatio: 1, modelPrice: 0.02 }) } }),
    declared({ models: { 'gpt-4o': ledgerModel({ quotaType: null, modelRatio: 1, modelPrice: 0.05 }) } }),
  );
  assert.equal(drifts.find((drift) => drift.field === 'quota_type')?.significant, false);
  const price = drifts.find((drift) => drift.field === 'model_price');
  assert.equal(price?.significant, false, '无法确认计费依据的字段不得判显著');
  assert.match(price?.message ?? '', /附带字段/);
  // 真正的按 token 倍率漂移在同一场景里仍判显著（口径推定一致时不必连坐降级）
  const ratioDrift = comparePricingSnapshots(
    snapshot({ models: { 'gpt-4o': snapshotModel({ quotaType: null, modelRatio: 1, completionRatio: 4 }) } }),
    declared({ models: { 'gpt-4o': ledgerModel({ quotaType: null, modelRatio: 3, completionRatio: 4 }) } }),
  );
  assert.equal(ratioDrift.find((drift) => drift.field === 'model_ratio')?.significant, true);
});

test('comparePricingSnapshots：只公示 completion_ratio 的模型同样视为按 token（不得掉进按次分支信任脏价）', () => {
  // 窄缝回归：旧侧没有 model_ratio、没有 quota_type，只公示 completion_ratio=4 与一个 model_price。
  // 若倍率证据只看 model_ratio，该侧会被推定成按次计费，其单价又因「无倍率」被判可信 →
  // 脏价重新获得显著判罚权（与必修 1 同源的假阳性）。
  const drifts = comparePricingSnapshots(
    snapshot({ models: { 'gpt-4o': snapshotModel({ quotaType: null, modelRatio: 0, completionRatio: 4, modelPrice: 0.02 }) } }),
    declared({ models: { 'gpt-4o': ledgerModel({ quotaType: 1, modelRatio: 0, completionRatio: 4, modelPrice: 0.05 }) } }),
  );
  assert.equal(drifts.find((drift) => drift.field === 'quota_type')?.significant, false);
  const price = drifts.find((drift) => drift.field === 'model_price');
  assert.equal(price?.significant, false, '只公示 completion_ratio 也算有倍率证据，单价不得获信');
  assert.match(price?.message ?? '', /遗留\/装饰值/);
});

test('comparePricingSnapshots：显式 per-token 侧的公示倍率整片消失 → 仍判显著（与 S4 对称）', () => {
  const drifts = comparePricingSnapshots(
    snapshot({ models: { 'gpt-4o': snapshotModel({ quotaType: 0, modelRatio: 1, completionRatio: 4 }) } }),
    declared({ models: { 'gpt-4o': ledgerModel({ quotaType: null, modelRatio: 0, completionRatio: 0, modelPrice: null }) } }),
  );
  assert.equal(drifts.find((drift) => drift.field === 'quota_type')?.significant, false);
  assert.equal(drifts.find((drift) => drift.field === 'model_ratio')?.significant, true, '倍率消失是真实公示变化');
});

test('comparePricingSnapshots：双侧显式口径相异/相同的两条分支都被覆盖', () => {
  // 口径显式翻转（按次 → 按 token）：两侧都有显式证据 → 显著基准变更，且不做任何数值比较。
  const flipped = comparePricingSnapshots(
    snapshot({ models: { 'gpt-4o': snapshotModel({ quotaType: 1, modelRatio: 0, completionRatio: 0, modelPrice: 0.02 }) } }),
    declared({ models: { 'gpt-4o': ledgerModel({ quotaType: 0, modelRatio: 3, completionRatio: 4, modelPrice: null }) } }),
  );
  assert.equal(flipped.length, 1, '换基准时只出一条基准项，不得混进数值项');
  assert.equal(flipped[0]?.kind, 'basis');
  assert.equal(flipped[0]?.field, 'quota_type');
  assert.equal(flipped[0]?.significant, true);
  assert.match(flipped[0]?.message ?? '', /计费基准变更/);
  assert.equal(flipped[0]?.relativeChange, null, '基准项不得带数值结论');

  // 两侧显式且口径相同：不出基准项，按按次口径正常比单价。
  const sameBasis = comparePricingSnapshots(
    snapshot({ models: { 'gpt-4o': snapshotModel({ quotaType: 1, modelRatio: 0, completionRatio: 0, modelPrice: 0.02 }) } }),
    declared({ models: { 'gpt-4o': ledgerModel({ quotaType: 1, modelRatio: 0, completionRatio: 0, modelPrice: 0.05 }) } }),
  );
  assert.equal(sameBasis.some((drift) => drift.field === 'quota_type'), false, '同口径不该产基准项');
  const price = sameBasis.find((drift) => drift.field === 'model_price');
  assert.equal(price?.significant, true, '两侧显式按次的单价变化必须判显著');
});

test('comparePricingSnapshots：新侧只公示 completion_ratio 时脏价不得重获显著判罚权', () => {
  // 旧侧显式按次有价 ↔ 新侧仅 completion_ratio（推定按 token）且带脏价：
  // 显式按次压过推定按 token，但新侧单价属按 token 口径的附带字段 → 数值与 presence 都不判显著。
  const numericCase = comparePricingSnapshots(
    snapshot({ models: { 'gpt-4o': snapshotModel({ quotaType: 1, modelRatio: 0, completionRatio: 0, modelPrice: 0.02 }) } }),
    declared({ models: { 'gpt-4o': ledgerModel({ quotaType: null, modelRatio: 0, completionRatio: 4, modelPrice: 0.05 }) } }),
  );
  assert.equal(numericCase.find((drift) => drift.field === 'quota_type')?.significant, false);
  const price = numericCase.find((drift) => drift.field === 'model_price');
  assert.equal(price?.kind, 'numeric');
  assert.equal(price?.significant, false, '新侧脏价不得获得显著判罚权');

  // presence 方向：旧侧显式按次有价，新侧仅 completion_ratio 且无单价 → 单价消失不判显著。
  const presenceCase = comparePricingSnapshots(
    snapshot({ models: { 'gpt-4o': snapshotModel({ quotaType: 1, modelRatio: 0, completionRatio: 0, modelPrice: 0.02 }) } }),
    declared({ models: { 'gpt-4o': ledgerModel({ quotaType: null, modelRatio: 0, completionRatio: 4, modelPrice: null }) } }),
  );
  assert.equal(presenceCase.find((drift) => drift.field === 'model_price')?.significant, false);

  // 双侧都只公示 completion_ratio、脏价不同 → 两侧都是按 token 推定，单价只作附带披露。
  const bothCompletionOnly = comparePricingSnapshots(
    snapshot({ models: { 'gpt-4o': snapshotModel({ quotaType: null, modelRatio: 0, completionRatio: 4, modelPrice: 0.02 }) } }),
    declared({ models: { 'gpt-4o': ledgerModel({ quotaType: null, modelRatio: 0, completionRatio: 4, modelPrice: 0.05 }) } }),
  );
  assert.equal(bothCompletionOnly.find((drift) => drift.field === 'model_price')?.significant, false);
});

test('comparePricingSnapshots：旧侧显式按 token、新侧推定按次且有价时不得跨口径比单价', () => {
  const drifts = comparePricingSnapshots(
    snapshot({ models: { 'gpt-4o': snapshotModel({ quotaType: 0, modelRatio: 1, completionRatio: 4, modelPrice: null }) } }),
    declared({ models: { 'gpt-4o': ledgerModel({ quotaType: null, modelRatio: 0, completionRatio: 0, modelPrice: 0.05 }) } }),
  );
  assert.equal(drifts.find((drift) => drift.field === 'quota_type')?.significant, false);
  const price = drifts.find((drift) => drift.field === 'model_price');
  assert.equal(price?.significant, false, '跨口径的单价不得判显著');
  assert.match(price?.message ?? '', /不判显著/);
});


test('comparePricingSnapshots：显式翻转只产显著基准项，推定侧与自定义枚举不产基准变更', () => {
  // 单侧显式（另一侧只能强推定）→ 不得断言「站点改了计费方式」：
  // 只允许一条 significant=false 的口径披露项，不得出现 significant=true 的基准变更。
  const mixed = comparePricingSnapshots(
    snapshot({ models: { 'gpt-4o': snapshotModel({ quotaType: 1, modelRatio: 0, completionRatio: 0, modelPrice: 0.02 }) } }),
    declared({ models: { 'gpt-4o': ledgerModel({ quotaType: null, modelRatio: 0, completionRatio: 4, modelPrice: 0.05 }) } }),
  );
  assert.equal(mixed.some((drift) => drift.kind === 'basis' && drift.significant === true), false, '单侧显式不得产出显著基准变更');
  assert.equal(mixed.find((drift) => drift.field === 'model_price')?.significant, false, '推定侧脏价不得获得显著判罚权');

  // 显式翻转 0→1（按 token → 按次）与 1→0 对称：只出一条显著基准项、无数值项。
  const flippedOther = comparePricingSnapshots(
    snapshot({ models: { 'gpt-4o': snapshotModel({ quotaType: 0, modelRatio: 1, completionRatio: 4, modelPrice: null }) } }),
    declared({ models: { 'gpt-4o': ledgerModel({ quotaType: 1, modelRatio: 0, completionRatio: 0, modelPrice: 0.05 }) } }),
  );
  assert.equal(flippedOther.length, 1);
  assert.equal(flippedOther[0]?.kind, 'basis');
  assert.equal(flippedOther[0]?.significant, true);
  assert.match(flippedOther[0]?.message ?? '', /计费基准变更/);

  // 自定义枚举 2→3（两侧口径都无法确认）：不产显著基准项，也没有可比的数值项。
  const custom = comparePricingSnapshots(
    snapshot({ models: { 'gpt-4o': snapshotModel({ quotaType: 2, modelRatio: 1, completionRatio: 4 }) } }),
    declared({ models: { 'gpt-4o': ledgerModel({ quotaType: 3, modelRatio: 1, completionRatio: 4 }) } }),
  );
  assert.equal(custom.some((drift) => drift.kind === 'basis' && drift.significant === true), false, '两侧口径均未知时不得断言换基准');
  assert.equal(custom.some((drift) => drift.kind === 'numeric'), false, '无口径证据时只披露不比价');
});

test('comparePricingSnapshots：口径选取里显式证据压过推定证据（双向各一条）', () => {
  // 新侧显式按 token，压过旧侧「无倍率有单价」的按次推定 → 按 token 口径比价。
  const newExplicitWins = comparePricingSnapshots(
    snapshot({ models: { 'gpt-4o': snapshotModel({ quotaType: null, modelRatio: 0, completionRatio: 0, modelPrice: 0.02 }) } }),
    declared({ models: { 'gpt-4o': ledgerModel({ quotaType: 0, modelRatio: 3, completionRatio: 4, modelPrice: null }) } }),
  );
  const newBasis = newExplicitWins.find((drift) => drift.field === 'quota_type');
  assert.match(newBasis?.message ?? '', /新侧公示为按 token 计费/);
  assert.match(newBasis?.message ?? '', /按 token 计费口径比价/, '显式证据必须压过旧侧推定');
  assert.equal(newBasis?.significant, false, '单侧显式只作披露');

  // 旧侧显式按 token，压过新侧「无倍率有单价」的按次推定 → 仍按 token 口径比价，单价不判显著。
  const oldExplicitWins = comparePricingSnapshots(
    snapshot({ models: { 'gpt-4o': snapshotModel({ quotaType: 0, modelRatio: 1, completionRatio: 4, modelPrice: 0.02 }) } }),
    declared({ models: { 'gpt-4o': ledgerModel({ quotaType: null, modelRatio: 0, completionRatio: 0, modelPrice: 0.05 }) } }),
  );
  const oldBasis = oldExplicitWins.find((drift) => drift.field === 'quota_type');
  assert.match(oldBasis?.message ?? '', /旧侧公示为按 token 计费/);
  assert.match(oldBasis?.message ?? '', /按 token 计费口径比价/, '显式证据必须压过新侧推定');
  assert.equal(oldExplicitWins.find((drift) => drift.field === 'model_price')?.significant, false, '按 token 口径下单价只作附带披露');
});
