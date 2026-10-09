import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { BALANCE_ENDPOINTS, probeBalance, spendBetween, type BalanceReading } from '../../src/balance.js';
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
  });
  assert.equal(usage.extract({}), null);
  assert.equal(usage.extract({ total_usage: '1234' }), null);
  assert.equal(usage.extract({ total_usage: Number.NaN }), null);
});

test('credit_grants extractor maps total_available to balance USD', () => {
  assert.deepEqual(grants.extract({ total_available: 50 }), {
    value: 50,
    kind: 'balance',
    unit: 'USD',
    currency: null,
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
    assert.equal(second?.value, 0.995);
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
