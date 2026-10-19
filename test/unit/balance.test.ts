import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { BALANCE_ENDPOINTS, probeBalance, probeBalanceStable, spendBetween, type BalanceReading } from '../../src/balance.js';
import { createMockServer } from '../mock-server.js';

const usage = BALANCE_ENDPOINTS[0]!;
const grants = BALANCE_ENDPOINTS[1]!;
const self = BALANCE_ENDPOINTS[2]!;

test('usage extractor normalizes cents to USD as spent_total', () => {
  assert.deepEqual(usage.extract({ total_usage: 1234 }), {
    value: 12.34,
    kind: 'spent_total',
    unit: 'USD',
    currency: null,
    resolution: 0.01,
  });
  assert.equal(usage.extract({}), null);
  assert.equal(usage.extract({ total_usage: '1234' }), null);
  assert.equal(usage.extract({ total_usage: Number.NaN }), null);
});

test('usage extractor rejects non-integer cents (unknown unit/schema)', () => {
  // 真机回归：某中转站返回 13058.6184，按 ÷100 读成 USD 后与 $0.019 应缴作比，产出 142.975× 假 fail。
  // OpenAI 规范该字段为整数美分；非整数说明单位不是美分，必须拒绝而不是猜。
  assert.equal(usage.extract({ total_usage: 13058.6184 }), null);
  assert.equal(usage.extract({ total_usage: 99.5 }), null);
  assert.deepEqual(usage.extract({ total_usage: 1234.0 }), usage.extract({ total_usage: 1234 }));
});

test('credit_grants extractor maps total_available to balance USD', () => {
  assert.deepEqual(grants.extract({ total_available: 50 }), {
    value: 50,
    kind: 'balance',
    unit: 'USD',
    currency: null,
    resolution: 0.01,
  });
  assert.equal(grants.extract({ total_available: '50' }), null);
  assert.equal(grants.extract({ success: true }), null);
});

test('self extractor unwraps data.quota only on success=true (one-api/new-api schema)', () => {
  assert.deepEqual(self.extract({ success: true, data: { quota: 500000 } }), {
    value: 500000,
    kind: 'balance',
    unit: 'quota',
    currency: null,
    resolution: 1,
  });
  assert.equal(self.extract({ success: false, data: { quota: 500000 } }), null);
  assert.equal(self.extract({ success: true, data: { quota: '500000' } }), null);
  assert.equal(self.extract({ success: true, data: null }), null);
  assert.equal(self.extract({ success: true }), null);
});

test('spendBetween keeps kind-dependent sign for same-source readings', () => {
  const spentBefore: BalanceReading = { value: 10, kind: 'spent_total', unit: 'USD', endpoint: '/usage', currency: null };
  const spentAfter: BalanceReading = { value: 13.5, kind: 'spent_total', unit: 'USD', endpoint: '/usage', currency: null };
  assert.equal(spendBetween(spentBefore, spentAfter), 3.5);
  assert.equal(spendBetween(spentAfter, spentBefore), -3.5);

  const balBefore: BalanceReading = { value: 100, kind: 'balance', unit: 'USD', endpoint: '/grants', currency: null };
  const balAfter: BalanceReading = { value: 90, kind: 'balance', unit: 'USD', endpoint: '/grants', currency: null };
  assert.equal(spendBetween(balBefore, balAfter), 10);
  assert.equal(spendBetween(balAfter, balBefore), -10);
});

test('spendBetween rejects cross endpoint/kind/unit readings', () => {
  const base: BalanceReading = { value: 10, kind: 'spent_total', unit: 'USD', endpoint: '/usage', currency: null };
  assert.equal(spendBetween(base, { ...base, endpoint: '/other' }), null);
  assert.equal(spendBetween(base, { ...base, kind: 'balance' }), null);
  assert.equal(spendBetween(base, { ...base, unit: 'quota' }), null);
});

test('spendBetween：两次读数校准粒度（resolution）不一致 → 伪 Δ 作废（qpu 中途变更守卫）', () => {
  const before: BalanceReading = { value: 0, kind: 'spent_total', unit: 'USD', endpoint: '/api/usage/token', currency: null, resolution: 1 / 500000 };
  const after: BalanceReading = { value: 0.02, kind: 'spent_total', unit: 'USD', endpoint: '/api/usage/token', currency: null, resolution: 1 / 250000 };
  // 站方中途把 quota_per_unit 从 500000 改成 250000：同值 quota 折出的 USD 分辨率不同，直接作比会产出伪 Δ
  assert.equal(spendBetween(before, after), null);
  const sameRes: BalanceReading = { ...after, resolution: 1 / 500000 };
  assert.equal(spendBetween(before, sameRes), 0.02);
  // 任一侧未上报 resolution 时不拦（dashboard 老端点缺省 resolution 的既有行为）
  assert.equal(spendBetween({ ...before, resolution: undefined }, after), 0.02);
});

test('probeBalance reads scripted usage from the mock server', async () => {
  const mock = await createMockServer({ mode: 'honest' });
  try {
    const first = await probeBalance(mock.baseUrl, 'test-key', 2000);
    assert.ok(first);
    assert.equal(first?.endpoint, '/dashboard/billing/usage');
    assert.equal(first?.kind, 'spent_total');
    assert.equal(first?.unit, 'USD');
    assert.equal(first?.value, 1.0);
    const second = await probeBalance(mock.baseUrl, 'test-key', 2000);
    assert.equal(second?.value, 0.99);
  } finally {
    mock.server.close();
  }
});

test('probeBalance returns null when every candidate 404s', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}/v1`;
    assert.equal(await probeBalance(base, 'test-key', 2000), null);
  } finally {
    server.close();
  }
});

// ---------- new-api quota 端点（/api/usage/token + /api/status 校准，2026-10-19） ----------

interface QuotaFixtureOptions {
  /** /api/status 的 data.quota_per_unit；null = 返回 data 但无该字段；默认 500000 */
  quotaPerUnit?: number | string | null;
  status404?: boolean; // true = /api/status 直接 404（校准不可达）
  usagePayload?: Record<string, unknown> | null; // null = /api/usage/token 404
}

/** 可调参 new-api 余额夹具：默认返回校准 500000 + spent 125000 quota（$0.25）。 */
function startQuotaFixture(options: QuotaFixtureOptions): Promise<{ base: string; close: () => void }> {
  const server = createServer((req, res) => {
    const reply = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/api/status') {
      if (options.status404 === true) return reply(404, { message: 'not found' });
      const quotaPerUnit = options.quotaPerUnit === undefined ? 500000 : options.quotaPerUnit;
      const data = quotaPerUnit === null ? {} : { quota_per_unit: quotaPerUnit };
      return reply(200, { success: true, data });
    }
    if (req.url === '/api/usage/token') {
      if (options.usagePayload === null) return reply(404, { message: 'not found' });
      return reply(200, {
        success: true,
        data: options.usagePayload ?? { total_granted: 500000, total_used: 125000, total_available: 375000 },
      });
    }
    return reply(404, { message: 'not found' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address !== null && typeof address === 'object');
      resolve({
        base: `http://127.0.0.1:${(address as { port: number }).port}`,
        close: () => server.close(),
      });
    });
  });
}

test('new-api quota: total_used 校准换算为 USD spent_total，conversionNote 随读数披露', async () => {
  const fixture = await startQuotaFixture({});
  try {
    const reading = await probeBalance(`${fixture.base}/v1`, 'test-key', 2000);
    assert.ok(reading);
    assert.equal(reading?.endpoint, '/api/usage/token');
    assert.equal(reading?.kind, 'spent_total');
    assert.equal(reading?.unit, 'USD');
    assert.equal(reading?.value, 0.25);
    assert.equal(reading?.resolution, 1 / 500000);
    assert.match(reading?.conversionNote ?? '', /quota_per_unit=500000 \(source: \/api\/status\)/);
  } finally {
    fixture.close();
  }
});

test('new-api quota: 无 total_used 时余额口径只采信 total_available（不得把 granted 当余额）', async () => {
  const fixture = await startQuotaFixture({ usagePayload: { total_granted: 500000, total_available: 375000 } });
  try {
    const reading = await probeBalance(`${fixture.base}/v1`, 'test-key', 2000);
    assert.ok(reading);
    assert.equal(reading?.kind, 'balance');
    assert.equal(reading?.value, 0.75);
  } finally {
    fixture.close();
  }
});

test('new-api quota: 校准不可达（/api/status 404）时端点整体不采信，回落通用候选', async () => {
  // 图纸双审必修：不得按假设默认 500000 折算——换算误差可把诚实倍率推出门限。
  // /api/usage/token 存在但 /api/status 404 → 全部候选 404 → null（无通用候选时）。
  const fixture = await startQuotaFixture({ status404: true });
  try {
    assert.equal(await probeBalance(`${fixture.base}/v1`, 'test-key', 2000), null);
  } finally {
    fixture.close();
  }
});

test('new-api quota: quota_per_unit 非法（0/负数/字符串/缺失）视为校准失败不采信', async () => {
  for (const bad of [0, -500000, '500000', null]) {
    const fixture = await startQuotaFixture({ quotaPerUnit: bad });
    try {
      assert.equal(await probeBalance(`${fixture.base}/v1`, 'test-key', 2000), null, `quotaPerUnit=${String(bad)}`);
    } finally {
      fixture.close();
    }
  }
});

test('new-api quota: total_used/total_available 非法（NaN/负数/字符串）时端点不采信', async () => {
  for (const payload of [
    { total_used: Number.NaN },
    { total_used: -1 },
    { total_used: '125000' },
    { total_available: Number.NaN },
    { total_available: -375000 },
    {},
  ]) {
    const fixture = await startQuotaFixture({ usagePayload: payload });
    try {
      assert.equal(await probeBalance(`${fixture.base}/v1`, 'test-key', 2000), null, JSON.stringify(payload));
    } finally {
      fixture.close();
    }
  }
});

test('new-api quota: 站点自定义 quota_per_unit=1000000 时换算随之（不写死 500000）', async () => {
  const fixture = await startQuotaFixture({ quotaPerUnit: 1000000 });
  try {
    const reading = await probeBalance(`${fixture.base}/v1`, 'test-key', 2000);
    assert.ok(reading);
    assert.equal(reading?.value, 0.125);
    assert.match(reading?.conversionNote ?? '', /quota_per_unit=1000000/);
  } finally {
    fixture.close();
  }
});

test('new-api quota: 换算后 USD 读数可作 spendBetween 差分（key 级累计窗口）', async () => {
  const fixture = await startQuotaFixture({});
  try {
    const first = await probeBalance(`${fixture.base}/v1`, 'test-key', 2000);
    const second = await probeBalance(`${fixture.base}/v1`, 'test-key', 2000);
    assert.ok(first && second);
    // 同源同 kind（Δ 语义正确性由 spendBetween 合同测试覆盖，此处验证换算读数参与差分不报 null
    assert.equal(typeof spendBetween(first!, second!), 'number');
  } finally {
    fixture.close();
  }
});

// ---------- post 快照稳定化轮询（chroe §2，2026-10-19 查漏补缺） ----------

/** 按序列吐 total_usage（整数美分）的余额夹具：用尽后重复最后一个值（与 mock-server 同语义）。 */
function startScriptedBalanceFixture(series: number[]): Promise<{ base: string; reads: () => number; close: () => void }> {
  let query = 0;
  const server = createServer((req, res) => {
    if (req.url !== undefined && req.url.split('?')[0]?.endsWith('/dashboard/billing/usage')) {
      const value = series[Math.min(query, series.length - 1)] ?? series[series.length - 1];
      query += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ total_usage: value }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'not found' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address !== null && typeof address === 'object');
      resolve({
        base: `http://127.0.0.1:${(address as { port: number }).port}/v1`,
        reads: () => query,
        close: () => server.close(),
      });
    });
  });
}

test('probeBalanceStable：异步结算收敛（读数序列 100→99→99）→ settled=true 取稳定值', async () => {
  const fixture = await startScriptedBalanceFixture([10000, 9950, 9950]);
  try {
    const stable = await probeBalanceStable(fixture.base, 'test-key', 2000, 3, 0);
    assert.ok(stable !== null);
    assert.equal(stable.settled, true);
    assert.equal(stable.polls, 3, '首次 + 两次对比读数');
    assert.equal(stable.reading.value, 99.5, '取收敛后的稳定值，而非首次读数');
  } finally {
    fixture.close();
  }
});

test('probeBalanceStable：轮询上限内仍在变化（异步结算未停/账户级并发）→ settled=false', async () => {
  const fixture = await startScriptedBalanceFixture([10000, 9950, 9900, 9850, 9800]);
  try {
    const stable = await probeBalanceStable(fixture.base, 'test-key', 2000, 3, 0);
    assert.ok(stable !== null);
    assert.equal(stable.settled, false);
    assert.equal(stable.polls, 4, '首次 + 3 次上限轮询');
    assert.equal(stable.reading.value, 98.5, '保留最后读数，交由调用方按不可归因作废倍率');
  } finally {
    fixture.close();
  }
});

test('probeBalanceStable：首次读数即稳定（诚实站点无并发）→ 2 次读数即返回，不多发轮询', async () => {
  const fixture = await startScriptedBalanceFixture([10000, 10000, 10000, 10000]);
  try {
    const stable = await probeBalanceStable(fixture.base, 'test-key', 2000, 3, 0);
    assert.ok(stable !== null);
    assert.equal(stable.settled, true);
    assert.equal(stable.polls, 2);
    assert.equal(fixture.reads(), 2, '稳定即停，不烧多余 GET');
  } finally {
    fixture.close();
  }
});

test('probeBalanceStable：端点不可达（全 404）→ null（与 probeBalance 同口径）', async () => {
  const fixture = await startScriptedBalanceFixture([]);
  try {
    const stable = await probeBalanceStable(fixture.base, 'test-key', 2000, 2, 0);
    assert.equal(stable, null);
  } finally {
    fixture.close();
  }
});

// ---------- /api/user/self quota→USD 校准（one-api 经典端点，2026-10-19 图纸双审必修 C） ----------

interface UserSelfFixtureOptions {
  quotaPerUnit?: number | null; // null = /api/status 404（校准不可达）
  quota?: number;
}

/** one-api 风格夹具：控制台 API 挂站点根（baseUrl 须带 /v1），/api/user/self 返回 data.quota。 */
function startUserSelfFixture(options: UserSelfFixtureOptions): Promise<{ base: string; close: () => void }> {
  const server = createServer((req, res) => {
    const reply = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const path = req.url?.split('?')[0] ?? '';
    if (path === '/api/status') {
      if (options.quotaPerUnit === null) return reply(404, { message: 'not found' });
      return reply(200, { success: true, data: { quota_per_unit: options.quotaPerUnit ?? 500000 } });
    }
    if (path === '/api/user/self') {
      return reply(200, { success: true, data: { quota: options.quota ?? 375000 } });
    }
    return reply(404, { message: 'not found' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address !== null && typeof address === 'object');
      resolve({
        base: `http://127.0.0.1:${(address as { port: number }).port}/v1`,
        close: () => server.close(),
      });
    });
  });
}

test('probeBalance：/api/user/self 的 raw quota 经 /api/status 校准 → USD 读数（含换算披露）', async () => {
  const fixture = await startUserSelfFixture({ quotaPerUnit: 500000, quota: 375000 });
  try {
    const reading = await probeBalance(fixture.base, 'test-key', 2000);
    assert.ok(reading !== null);
    assert.equal(reading?.endpoint, '/api/user/self');
    assert.equal(reading?.kind, 'balance');
    assert.equal(reading?.unit, 'USD');
    assert.equal(reading?.value, 0.75, '375000 quota ÷ 500000 = $0.75');
    assert.equal(reading?.resolution, 1 / 500000);
    assert.ok(reading?.conversionNote?.includes('quota_per_unit=500000'));
    assert.ok(reading?.conversionNote?.includes('user-level'), '用户级口径必须在换算披露中注明');
  } finally {
    fixture.close();
  }
});

test('probeBalance：/api/status 校准不可达 → 保留 raw quota 单位（decideRatio 按 非 USD 作废兜底）', async () => {
  const fixture = await startUserSelfFixture({ quotaPerUnit: null, quota: 375000 });
  try {
    const reading = await probeBalance(fixture.base, 'test-key', 2000);
    assert.ok(reading !== null);
    assert.equal(reading?.unit, 'quota');
    assert.equal(reading?.value, 375000);
    assert.equal(reading?.conversionNote, undefined);
  } finally {
    fixture.close();
  }
});

test('probeBalance：quota_per_unit 量级不合理（<1）→ 视为校准失败，保留 raw quota', async () => {
  const fixture = await startUserSelfFixture({ quotaPerUnit: 0.5, quota: 375000 });
  try {
    const reading = await probeBalance(fixture.base, 'test-key', 2000);
    assert.ok(reading !== null);
    assert.equal(reading?.unit, 'quota');
  } finally {
    fixture.close();
  }
});
