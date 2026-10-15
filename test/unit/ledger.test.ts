// test/unit/ledger.test.ts —— 请求账本切片（S1）单元用例：
//   ① 幂等：同一 (request_id, attempt_no) 重复结算恰落一行、聚合恰计一次；
//   ② 五终态（ok/truncated/aborted/timeout/interrupted）如实落库、二次结算被拒；attempt_no=2 重试轮记新行；
//   ③ token 缺失矩阵：四项全 NULL + token_source='none' + 四种 missing_reason 可落库（绝不写 0 冒充）；
//      非法枚举被 CHECK 拒收且只计 writeErrors（fail-open 不卡死）；
//   ④ recover()：为无结算请求补 interrupted（归因 gateway，绝不冤枉渠道），重复调用幂等；
//   ⑤ usageSummary 按 (channel_id, alias) 聚合：requests/ok/errors/token SUM 与跨渠道隔离正确。
//   ⑥ verifyChain：空库边界（checked=0 全通）；基本链全通且两表计数精确；
//   ⑦/⑧ 篡改 requests/settlements 中间行 → 首个断点精确报 brokenAtId（table 归属正确）；
//   ⑨ v1 旧库迁移：补列 + legacy 行只计数不计断点、新行从链起点续链、重开幂等（文件库）；
//   ⑩ ttft_contaminated 三态（1/0/NULL）如实落库（无样本绝不写 0 冒充）、篡改即断链；
//   ⑪ recover() 补结行同样上链（checked 精确）、篡改即检出。
// ⑥-⑧/⑩-⑪ 用 ':memory:' 内存库；⑨ 用临时目录文件库（迁移只对文件库有意义）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Ledger, type LedgerRequestInput, type LedgerSettlementInput } from '../../src/ledger/ledger.js';

function requestInput(overrides: Partial<LedgerRequestInput> = {}): LedgerRequestInput {
  return {
    ts_ms: Date.now(),
    origin: 'user',
    channel_id: 'ch-1',
    alias: 'alias-a',
    model_upstream: 'real-a',
    req_bytes: 100,
    has_tools: 0,
    has_image: 0,
    messages_count: 1,
    ...overrides,
  };
}

function settleInput(requestId: string, overrides: Partial<LedgerSettlementInput> = {}): LedgerSettlementInput {
  return {
    request_id: requestId,
    ts_ms: Date.now(),
    channel_id: 'ch-1',
    alias: 'alias-a',
    upstream_status: 200,
    client_status: 'ok',
    error_source: null,
    error_class: null,
    finish_reason: 'stop',
    ttft_upstream_ms: 12.5,
    ttft_client_ms: null,
    token_prompt: 10,
    token_completion: 5,
    token_cached: null,
    token_reasoning: null,
    token_source: 'usage',
    token_missing_reason: null,
    usage_valid: 1,
    amount: null,
    ...overrides,
  };
}

test('ledger ①：重复结算幂等——恰一行、聚合恰计一次、无写错误', () => {
  const ledger = new Ledger(':memory:');
  try {
    const id = ledger.recordRequest(requestInput());
    assert.ok(id, 'recordRequest 应返回账本 id');
    assert.equal(ledger.settle(settleInput(id)), true, '首次结算应生效');
    for (let i = 0; i < 4; i += 1) {
      assert.equal(ledger.settle(settleInput(id)), false, '重复结算必须被拒（绝不双记）');
    }
    assert.equal(ledger.settlementsOf(id).length, 1);
    const summary = ledger.usageSummary();
    assert.equal(summary.length, 1);
    const row = summary[0]!;
    assert.equal(row.requests, 1);
    assert.equal(row.ok, 1);
    assert.equal(row.errors, 0);
    assert.deepEqual(ledger.stats(), { writeErrors: 0, degraded: false, recovered: 0 });
  } finally {
    ledger.close();
  }
});

test('ledger ②：五终态如实落库（非硬编码）、二次结算被拒；attempt_no=2 记为新行', () => {
  const ledger = new Ledger(':memory:');
  try {
    const states: Array<Pick<LedgerSettlementInput, 'client_status' | 'error_source' | 'upstream_status'>> = [
      { client_status: 'ok', error_source: null, upstream_status: 200 },
      { client_status: 'truncated', error_source: 'upstream', upstream_status: 200 },
      { client_status: 'aborted', error_source: 'client', upstream_status: null },
      { client_status: 'timeout', error_source: 'upstream', upstream_status: 504 },
      { client_status: 'interrupted', error_source: 'gateway', upstream_status: null },
    ];
    for (const [index, state] of states.entries()) {
      const alias = `s-${index}`;
      const id = ledger.recordRequest(requestInput({ alias }));
      assert.ok(id);
      assert.equal(ledger.settle(settleInput(id, { alias, ...state })), true, `${state.client_status} 应可落库`);
      assert.equal(ledger.settle(settleInput(id, { alias, ...state })), false, '二次结算必须被拒');
      const rows = ledger.settlementsOf(id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.clientStatus, state.client_status, '终态必须如实存储（防硬编码 ok）');
      assert.equal(rows[0]!.errorSource, state.error_source);
      assert.equal(rows[0]!.upstreamStatus, state.upstream_status);
      assert.equal(rows[0]!.attemptNo, 1);
    }
    // 重试轮：同一 request_id 的 attempt_no=2 是新行（UNIQUE(request_id, attempt_no)）
    const retryId = ledger.recordRequest(requestInput({ alias: 'retry' }));
    assert.ok(retryId);
    assert.equal(ledger.settle(settleInput(retryId, { alias: 'retry' })), true);
    assert.equal(ledger.settle(settleInput(retryId, { alias: 'retry', attempt_no: 2 })), true);
    assert.equal(ledger.settlementsOf(retryId).length, 2);
    // 聚合：5 个终态请求（1 ok）+ 1 个重试请求（2 行全 ok）
    const total = ledger.usageSummary().reduce((sum, row) => sum + row.requests, 0);
    const errors = ledger.usageSummary().reduce((sum, row) => sum + row.errors, 0);
    assert.equal(total, 6, 'requests 来自请求表：每请求恰计一次（重试轮不虚增请求数）');
    assert.equal(errors, 4, '结算数 7 − ok 数 3 = errors 4');
  } finally {
    ledger.close();
  }
});

test('ledger ③：token 缺失矩阵（四项 NULL + none/absent..inconsistent）；非法枚举被 CHECK 拒收只计数', () => {
  const ledger = new Ledger(':memory:');
  try {
    const reasons = ['absent', 'missing', 'negative', 'inconsistent'] as const;
    for (const reason of reasons) {
      const alias = `t-${reason}`;
      const id = ledger.recordRequest(requestInput({ alias }));
      assert.ok(id);
      assert.equal(
        ledger.settle(
          settleInput(id, {
            alias,
            client_status: 'truncated',
            error_source: 'upstream',
            token_prompt: null,
            token_completion: null,
            token_cached: null,
            token_reasoning: null,
            token_source: 'none',
            token_missing_reason: reason,
            usage_valid: 0,
          }),
        ),
        true,
        `${reason} 缺失原因应可落库`,
      );
      const row = ledger.settlementsOf(id)[0]!;
      assert.equal(row.tokenSource, 'none');
      assert.equal(row.tokenMissingReason, reason);
      assert.equal(row.tokenPrompt, null, '缺失 token 必须为 NULL，绝不写 0 冒充');
      assert.equal(row.tokenCompletion, null);
      assert.equal(row.tokenCached, null);
      assert.equal(row.tokenReasoning, null);
      assert.equal(row.usageValid, 0);
    }
    const tokens = ledger.usageSummary().reduce((sum, row) => sum + row.tokenPrompt + row.tokenCompletion, 0);
    assert.equal(tokens, 0, 'NULL token 不贡献 SUM');
    // 非法枚举：CHECK 拒收 → settle 返回 false 且 writeErrors 自增（degraded 必须可见）
    const bad = ledger.recordRequest(requestInput({ alias: 'bad' }));
    assert.ok(bad);
    assert.equal(ledger.settle(settleInput(bad, { alias: 'bad', token_missing_reason: 'bogus' as never })), false);
    assert.equal(ledger.settle(settleInput(bad, { alias: 'bad', client_status: 'weird' as never })), false);
    assert.equal(ledger.settlementsOf(bad).length, 0);
    assert.equal(ledger.stats().writeErrors, 2);
    assert.equal(ledger.stats().degraded, true);
    // fail-open：拒收后账本仍可正常写入（不卡死、不进入不可用态）
    assert.equal(ledger.settle(settleInput(bad, { alias: 'bad' })), true);
  } finally {
    ledger.close();
  }
});

test('ledger ④：recover() 补 interrupted（归因 gateway）恰一次，重复调用幂等', () => {
  const ledger = new Ledger(':memory:');
  try {
    const settledId = ledger.recordRequest(requestInput({ alias: 'done' }));
    const openA = ledger.recordRequest(requestInput({ alias: 'open-a' }));
    const openB = ledger.recordRequest(requestInput({ alias: 'open-b' }));
    assert.ok(settledId && openA && openB);
    assert.equal(ledger.settle(settleInput(settledId, { alias: 'done' })), true);
    assert.equal(ledger.recover(), 2, '恰补两条中断请求');
    assert.equal(ledger.recover(), 0, '再次调用不重复补结（幂等）');
    const rows = ledger.settlementsOf(openA);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.clientStatus, 'interrupted');
    assert.equal(rows[0]!.errorSource, 'gateway', '恢复补结归因 gateway，绝不冤枉渠道');
    assert.equal(rows[0]!.tokenSource, 'none');
    assert.equal(rows[0]!.tokenMissingReason, 'absent');
    assert.equal(ledger.stats().recovered, 2);
    const summary = ledger.usageSummary();
    assert.equal(summary.reduce((sum, row) => sum + row.requests, 0), 3);
    assert.equal(summary.reduce((sum, row) => sum + row.ok, 0), 1);
    assert.equal(summary.reduce((sum, row) => sum + row.errors, 0), 2);
  } finally {
    ledger.close();
  }
});

test('ledger ⑤：usageSummary 按 (channel_id, alias) 聚合；ok 口径 = 送达完整且上游 2xx；跨渠道隔离', () => {
  const ledger = new Ledger(':memory:');
  try {
    // ch-1/alias-a：2 请求（1 ok 带 token；1 timeout 缺失）
    const a1 = ledger.recordRequest(requestInput());
    const a2 = ledger.recordRequest(requestInput());
    // ch-1/alias-b：1 请求（ok，含 cached/reasoning 明细；model_upstream 可为 NULL）
    const b1 = ledger.recordRequest(requestInput({ alias: 'alias-b', model_upstream: null }));
    // ch-2/alias-a：1 请求（同名别名但不同渠道 = 独立行）
    const c1 = ledger.recordRequest(requestInput({ channel_id: 'ch-2' }));
    assert.ok(a1 && a2 && b1 && c1);
    ledger.settle(settleInput(a1, { token_prompt: 10, token_completion: 5, token_cached: 2, token_reasoning: 1 }));
    ledger.settle(
      settleInput(a2, {
        client_status: 'timeout',
        error_source: 'upstream',
        upstream_status: 504,
        token_prompt: null,
        token_completion: null,
        token_source: 'none',
        token_missing_reason: 'absent',
        usage_valid: 0,
      }),
    );
    ledger.settle(settleInput(b1, { alias: 'alias-b', token_prompt: 20, token_completion: 7 }));
    ledger.settle(
      settleInput(c1, {
        channel_id: 'ch-2',
        client_status: 'truncated',
        error_source: 'upstream',
        token_prompt: null,
        token_completion: null,
        token_source: 'none',
        token_missing_reason: 'absent',
        usage_valid: 0,
      }),
    );
    const rows = ledger.usageSummary();
    assert.equal(rows.length, 3, '同名别名跨渠道是不同行（渠道隔离）');
    const pick = (channelId: string, alias: string) => rows.find((row) => row.channelId === channelId && row.alias === alias)!;
    const rowA = pick('ch-1', 'alias-a');
    assert.equal(rowA.requests, 2);
    assert.equal(rowA.ok, 1);
    assert.equal(rowA.errors, 1, 'timeout 归错误（error_source=upstream，结算不含 ok）');
    assert.equal(rowA.tokenPrompt, 10);
    assert.equal(rowA.tokenCompletion, 5);
    assert.equal(rowA.tokenCached, 2);
    assert.equal(rowA.tokenReasoning, 1);
    const rowB = pick('ch-1', 'alias-b');
    assert.equal(rowB.requests, 1);
    assert.equal(rowB.ok, 1);
    assert.equal(rowB.errors, 0);
    assert.equal(rowB.tokenPrompt, 20);
    assert.equal(rowB.tokenCompletion, 7);
    assert.equal(rowB.tokenCached, 0, '未上报明细按 0 求和展示（库内仍为 NULL）');
    const rowC = pick('ch-2', 'alias-a');
    assert.equal(rowC.requests, 1);
    assert.equal(rowC.ok, 0, '截断不算 ok');
    assert.equal(rowC.errors, 1);
    assert.equal(rowC.tokenPrompt, 0);
  } finally {
    ledger.close();
  }
});

// ===== v2：hash 链 / v1 迁移 / TTFT 污染标记 =====

test('ledger ⑥：verifyChain 空库边界（checked=0 全通）与基本链全通（两表计数精确）', () => {
  const ledger = new Ledger(':memory:');
  try {
    assert.deepEqual(
      ledger.verifyChain(),
      { ok: true, table: 'settlements', brokenAtId: null, checked: 0, legacy: { requests: 0, settlements: 0 } },
      '空库必须判全通且 checked=0（不把「无行」误报为断链）',
    );
    const [idA, idB] = [ledger.recordRequest(requestInput()), ledger.recordRequest(requestInput({ alias: 'alias-b' }))];
    assert.ok(idA && idB);
    assert.equal(ledger.settle(settleInput(idA)), true);
    assert.equal(ledger.settle(settleInput(idB, { alias: 'alias-b' })), true);
    assert.equal(ledger.settle(settleInput(idB, { alias: 'alias-b', attempt_no: 2 })), true, '重试轮是新行，同样上链');
    assert.deepEqual(
      ledger.verifyChain(),
      { ok: true, table: 'settlements', brokenAtId: null, checked: 5, legacy: { requests: 0, settlements: 0 } },
      '2 请求 + 3 结算 = 5 行全部上链',
    );
    assert.equal(ledger.stats().writeErrors, 0, '正常写入不得产生写错误');
  } finally {
    ledger.close();
  }
});

test('ledger ⑦：篡改 requests 中间行 → 链在首个断点报 brokenAtId（精确到行）', () => {
  const ledger = new Ledger(':memory:');
  try {
    const [id0, id1, id2] = [0, 1, 2].map((i) => ledger.recordRequest(requestInput({ alias: `alias-${i}` })));
    assert.ok(id0 && id1 && id2);
    assert.equal(ledger.verifyChain().ok, true);
    ledger.rawDbForTest.prepare('UPDATE requests SET messages_count = 99 WHERE id = ?').run(id1);
    const report = ledger.verifyChain();
    assert.equal(report.ok, false, '篡改必须被检出');
    assert.equal(report.table, 'requests');
    assert.equal(report.brokenAtId, id1, '断点必须精确到被篡改的行');
    assert.equal(report.checked, 2, '第 1 行通过、第 2 行检出——在首个断点停止');
    assert.deepEqual(report.legacy, { requests: 0, settlements: 0 });
  } finally {
    ledger.close();
  }
});

test('ledger ⑧：篡改 settlements 中间行 → 报 settlements/brokenAtId；requests 照常计通过数', () => {
  const ledger = new Ledger(':memory:');
  try {
    const ids = [0, 1, 2].map((i) => ledger.recordRequest(requestInput({ alias: `alias-${i}` })));
    for (const [index, id] of ids.entries()) {
      assert.ok(id);
      assert.equal(ledger.settle(settleInput(id, { alias: `alias-${index}` })), true);
    }
    assert.equal(ledger.verifyChain().ok, true);
    const mid = ledger.rawDbForTest.prepare('SELECT id FROM settlements ORDER BY rowid LIMIT 1 OFFSET 1').get() as { id: string };
    ledger.rawDbForTest.prepare("UPDATE settlements SET finish_reason = 'tampered' WHERE id = ?").run(mid.id);
    const report = ledger.verifyChain();
    assert.equal(report.ok, false);
    assert.equal(report.table, 'settlements');
    assert.equal(report.brokenAtId, mid.id, '断点必须精确到被篡改的结算行');
    assert.equal(report.checked, 5, 'requests 3 行全过 + settlements 检出前 2 行');
  } finally {
    ledger.close();
  }
});

/** v1 版 schema（历史版原文，无 row_hash / ttft_contaminated 列）：用于迁移用例构造旧库。 */
const V1_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  ts_ms INTEGER NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('user','probe','health')),
  channel_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  model_upstream TEXT,
  req_bytes INTEGER,
  has_tools INTEGER,
  has_image INTEGER,
  messages_count INTEGER
);
CREATE TABLE IF NOT EXISTS settlements (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL DEFAULT 1,
  ts_ms INTEGER NOT NULL,
  channel_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  upstream_status INTEGER,
  client_status TEXT CHECK(client_status IN ('ok','truncated','aborted','timeout','interrupted')),
  error_source TEXT CHECK(error_source IN ('upstream','gateway','client')),
  error_class TEXT,
  finish_reason TEXT,
  ttft_upstream_ms REAL,
  ttft_client_ms REAL,
  token_prompt INTEGER,
  token_completion INTEGER,
  token_cached INTEGER,
  token_reasoning INTEGER,
  token_source TEXT CHECK(token_source IN ('usage','none')),
  token_missing_reason TEXT CHECK(token_missing_reason IN ('absent','missing','negative','inconsistent')),
  usage_valid INTEGER,
  amount INTEGER,
  UNIQUE(request_id, attempt_no)
);
CREATE INDEX IF NOT EXISTS idx_requests_channel_alias ON requests(channel_id, alias);
CREATE INDEX IF NOT EXISTS idx_settlements_channel_alias ON settlements(channel_id, alias);
`;

test('ledger ⑨：v1 旧库迁移——补列 + legacy 计数（旧行不上链不计断点）；新行从链起点续链；重开幂等', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mx-ledger-mig-'));
  const dbPath = join(dir, 'v1.db');
  try {
    const raw = new DatabaseSync(dbPath);
    raw.exec(V1_SCHEMA_SQL);
    raw.exec('PRAGMA user_version = 1');
    const insertRequest =
      'INSERT INTO requests (id, ts_ms, origin, channel_id, alias, model_upstream, req_bytes, has_tools, has_image, messages_count) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    raw.prepare(insertRequest).run('old-1', 1, 'user', 'ch-1', 'alias-a', 'real-a', 10, 0, 0, 1);
    raw.prepare(insertRequest).run('old-2', 2, 'user', 'ch-1', 'alias-b', 'real-b', 20, 0, 0, 2);
    const insertSettlement =
      'INSERT INTO settlements (id, request_id, attempt_no, ts_ms, channel_id, alias, upstream_status, client_status, error_source, error_class, ' +
      'finish_reason, ttft_upstream_ms, ttft_client_ms, token_prompt, token_completion, token_cached, token_reasoning, token_source, token_missing_reason, usage_valid, amount) ' +
      'VALUES (?, ?, 1, ?, ?, ?, 200, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    raw.prepare(insertSettlement).run('old-s1', 'old-1', 3, 'ch-1', 'alias-a', 'ok', null, null, 'stop', 9.5, null, 10, 5, null, null, 'usage', null, 1, null);
    raw.prepare(insertSettlement).run('old-s2', 'old-2', 4, 'ch-1', 'alias-b', 'timeout', 'upstream', null, null, null, null, null, null, null, null, 'none', 'absent', 0, null);
    raw.close();

    const ledger = new Ledger(dbPath);
    try {
      const columns = (ledger.rawDbForTest.prepare('PRAGMA table_info(settlements)').all() as Array<{ name: string }>).map((info) => info.name);
      assert.ok(columns.includes('row_hash') && columns.includes('ttft_contaminated'), '迁移必须补齐新列');
      const version = ledger.rawDbForTest.prepare('PRAGMA user_version').get() as { user_version: number };
      assert.equal(version.user_version, 2, '版本锚必须升到 2');
      assert.deepEqual(
        ledger.verifyChain(),
        { ok: true, table: 'settlements', brokenAtId: null, checked: 0, legacy: { requests: 2, settlements: 2 } },
        '迁移前旧行只计 legacy、绝不误报断点',
      );
      const freshId = ledger.recordRequest(requestInput({ id: 'new-1', alias: 'alias-new' }));
      assert.ok(freshId);
      assert.equal(ledger.settle(settleInput(freshId, { alias: 'alias-new' })), true);
      assert.deepEqual(
        ledger.verifyChain(),
        { ok: true, table: 'settlements', brokenAtId: null, checked: 2, legacy: { requests: 2, settlements: 2 } },
        '迁移后新行（1 请求 + 1 结算）从链起点续链，legacy 计数不变',
      );
    } finally {
      ledger.close();
    }
    const reopened = new Ledger(dbPath);
    try {
      assert.deepEqual(
        reopened.verifyChain(),
        { ok: true, table: 'settlements', brokenAtId: null, checked: 2, legacy: { requests: 2, settlements: 2 } },
        '重开必须幂等：不得重复迁移，也不得把 legacy 行回溯上链',
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('ledger ⑩：ttft_contaminated 三态（1/0/NULL）如实落库；篡改该列即断链', () => {
  const ledger = new Ledger(':memory:');
  try {
    const [contamId, cleanId, noTtftId] = [
      ledger.recordRequest(requestInput({ alias: 'contam' })),
      ledger.recordRequest(requestInput({ alias: 'clean' })),
      ledger.recordRequest(requestInput({ alias: 'no-ttft' })),
    ];
    assert.ok(contamId && cleanId && noTtftId);
    assert.equal(ledger.settle(settleInput(contamId, { alias: 'contam', ttft_contaminated: 1 })), true);
    assert.equal(ledger.settle(settleInput(cleanId, { alias: 'clean', ttft_contaminated: 0 })), true);
    assert.equal(ledger.settle(settleInput(noTtftId, { alias: 'no-ttft', ttft_upstream_ms: null, ttft_contaminated: null })), true);
    assert.equal(ledger.settlementsOf(contamId)[0]!.ttftContaminated, 1, '剔除标记必须如实落 1');
    assert.equal(ledger.settlementsOf(cleanId)[0]!.ttftContaminated, 0, '未剔除样本落 0');
    assert.equal(ledger.settlementsOf(noTtftId)[0]!.ttftContaminated, null, '无 TTFT 样本必须 NULL，绝不写 0 冒充');
    assert.equal(ledger.verifyChain().ok, true, '三态写入后链必须全通');
    const rowId = ledger.settlementsOf(contamId)[0]!.id;
    ledger.rawDbForTest.prepare('UPDATE settlements SET ttft_contaminated = 0 WHERE id = ?').run(rowId);
    const report = ledger.verifyChain();
    assert.equal(report.ok, false);
    assert.equal(report.table, 'settlements');
    assert.equal(report.brokenAtId, rowId, '剔除标记属链内容：篡改（如洗白污染样本）必须断链');
    assert.equal(report.checked, 4, 'requests 3 行全过 + settlements 首行检出');
  } finally {
    ledger.close();
  }
});

test('ledger ⑪：recover 补结行同样上链（checked 精确）；篡改恢复行即检出', () => {
  const ledger = new Ledger(':memory:');
  try {
    const [doneId, openId] = [ledger.recordRequest(requestInput({ alias: 'done' })), ledger.recordRequest(requestInput({ alias: 'open' }))];
    assert.ok(doneId && openId);
    assert.equal(ledger.settle(settleInput(doneId, { alias: 'done' })), true);
    assert.equal(ledger.recover(), 1);
    assert.deepEqual(
      ledger.verifyChain(),
      { ok: true, table: 'settlements', brokenAtId: null, checked: 4, legacy: { requests: 0, settlements: 0 } },
      '2 请求 + 2 结算（1 正常 + 1 恢复）全部上链',
    );
    const recovered = ledger.settlementsOf(openId)[0]!;
    assert.equal(recovered.clientStatus, 'interrupted');
    ledger.rawDbForTest.prepare("UPDATE settlements SET error_source = 'upstream' WHERE id = ?").run(recovered.id);
    const report = ledger.verifyChain();
    assert.equal(report.ok, false);
    assert.equal(report.table, 'settlements');
    assert.equal(report.brokenAtId, recovered.id, '恢复补结行被篡改（如洗白归因）必须断链');
  } finally {
    ledger.close();
  }
});
