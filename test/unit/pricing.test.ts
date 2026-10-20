// src/pricing.ts 单测：站点 origin 推导、公示价解析、名称归并、应缴估算与抓取状态机。
// 这些是金额侧核验的地基——解析错一条 model_ratio 就会把诚实站点误判成「加价/错配」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  deriveOrigin,
  expectedCostFromDeclared,
  fetchDeclaredPricing,
  isPlausibleQuotaPerUnit,
  lookupDeclaredModel,
  modelFamily,
  normalizeModelName,
  parsePricingPayload,
  USD_PER_MILLION_PER_RATIO,
  type DeclaredModelPricing,
} from '../../src/pricing.js';

function model(patch: Partial<DeclaredModelPricing> = {}): DeclaredModelPricing {
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

test('deriveOrigin：剥掉末尾 API 版本段，保留反代子路径', () => {
  assert.equal(deriveOrigin('https://relay.example.com/v1'), 'https://relay.example.com');
  assert.equal(deriveOrigin('https://relay.example.com/v1/'), 'https://relay.example.com');
  assert.equal(deriveOrigin('https://relay.example.com/v1beta'), 'https://relay.example.com');
  assert.equal(deriveOrigin('https://relay.example.com/compatible-mode/v1'), 'https://relay.example.com');
  assert.equal(deriveOrigin('https://relay.example.com/openai/v1'), 'https://relay.example.com');
  assert.equal(deriveOrigin('https://relay.example.com/foo/v1'), 'https://relay.example.com/foo');
  assert.equal(deriveOrigin('https://relay.example.com/'), 'https://relay.example.com');
  assert.equal(deriveOrigin('http://127.0.0.1:8080/v1?x=1#h'), 'http://127.0.0.1:8080');
  assert.throws(() => deriveOrigin('not a url'), /Invalid URL/);
});

test('normalizeModelName / modelFamily：大小写、空白与族系粗分类', () => {
  assert.equal(normalizeModelName('  GPT-4o '), 'gpt-4o');
  assert.equal(normalizeModelName('GLM  5.3 Flash'), 'glm5.3flash');
  assert.equal(modelFamily('gpt-4o-mini'), 'gpt');
  assert.equal(modelFamily('GLM-5.3'), 'glm');
  assert.equal(modelFamily('qwen2.5-72b'), 'qwen');
  assert.equal(modelFamily('123'), null);
});

test('lookupDeclaredModel：精确 → 归一 → 版本尾缀 → 带边界的版本化前缀（取最长）', () => {
  const declared = {
    models: {
      'gpt-4o': model({ modelRatio: 1 }),
      'gpt-4o-mini': model({ modelRatio: 0.2 }),
      'gpt-4o-latest': model({ modelRatio: 1.2 }),
      'GLM-5.3': model({ modelRatio: 0.5 }),
    },
  };
  assert.deepEqual(lookupDeclaredModel(declared, 'gpt-4o'), { key: 'gpt-4o', model: declared.models['gpt-4o'] });
  assert.equal(lookupDeclaredModel(declared, 'GPT-4O')?.key, 'gpt-4o');
  assert.equal(lookupDeclaredModel(declared, 'gpt-4o-2024-08-06')?.key, 'gpt-4o');
  assert.equal(lookupDeclaredModel(declared, 'glm-5.3')?.key, 'GLM-5.3');
  // 边界：gpt-4o 不得把 gpt-4o-mini 误配为同价（余下 "-mini" 不是版本尾缀）
  const mini = lookupDeclaredModel(declared, 'gpt-4o-mini');
  assert.equal(mini?.key, 'gpt-4o-mini');
  assert.deepEqual(mini?.model, declared.models['gpt-4o-mini']);
  assert.equal(lookupDeclaredModel(declared, 'gpt-4o-mini-2024-07-18')?.key, 'gpt-4o-mini');
  // 长前缀优先：gpt-4o-latest 存在时，查询 gpt-4o-latest 命中自身而非 gpt-4o
  assert.equal(lookupDeclaredModel(declared, 'gpt-4o-latest')?.key, 'gpt-4o-latest');
  assert.equal(lookupDeclaredModel(declared, 'claude-3-opus'), null);
});

test('expectedCostFromDeclared：quota 公式、美元折算、上下界标注', () => {
  const estimate = expectedCostFromDeclared({ quotaPerUnit: 500000 }, model(), {
    promptTokens: 1000,
    completionTokens: 500,
    samples: 2,
    droppedSamples: 0,
  });
  assert.equal(estimate.quota, 3000);
  assert.equal(estimate.usd, 3000 / 500000);
  assert.equal(estimate.inputUsdPerM, 2);
  assert.equal(estimate.outputUsdPerM, 8);
  assert.equal(estimate.isUpperBound, true, '缓存未折扣 → 上界');
  assert.equal(estimate.isLowerBound, false);

  const missingQuota = expectedCostFromDeclared({ quotaPerUnit: null }, model(), {
    promptTokens: 10,
    completionTokens: 0,
    samples: 1,
    droppedSamples: 0,
  });
  assert.equal(missingQuota.usd, null);

  const dropped = expectedCostFromDeclared({ quotaPerUnit: 1 }, model(), {
    promptTokens: 10,
    completionTokens: 0,
    samples: 1,
    droppedSamples: 3,
  });
  assert.equal(dropped.isLowerBound, true, '有样本缺 usage → 下界');
});

test('expectedCostFromDeclared：分组倍率参与换算；分组未公示 → 不声称上下界；省略 options 保持旧口径', () => {
  const totals = { promptTokens: 1000, completionTokens: 0, samples: 1, droppedSamples: 0 };
  const priced = expectedCostFromDeclared(
    { quotaPerUnit: 500000, group: 'vip', groupRatio: { vip: 0.8 } },
    model(),
    totals,
    { group: 'vip' },
  );
  assert.equal(priced.quota, 800, '分组倍率 0.8 必须乘进 quota');
  assert.equal(priced.state, 'priced');
  assert.equal(priced.groupRatioUnverified, false);
  assert.equal(priced.isUpperBound, true);
  assert.equal(priced.unverifiedReason, null);

  // 声明了分组但公示表没有该倍率：按倍率 1 参照，且不声称上界/下界（避免误导为「已核验」）
  const unverified = expectedCostFromDeclared(
    { quotaPerUnit: 500000, group: 'vip', groupRatio: {} },
    model(),
    totals,
    { group: 'vip' },
  );
  assert.equal(unverified.quota, 1000);
  assert.equal(unverified.groupRatioUnverified, true);
  assert.equal(unverified.isUpperBound, false);
  assert.equal(unverified.isLowerBound, false);

  // 省略 options：旧口径（不评估分组），不因缺组而标未核验
  const legacy = expectedCostFromDeclared({ quotaPerUnit: 500000, group: 'vip', groupRatio: {} }, model(), totals);
  assert.equal(legacy.isUpperBound, true);
  assert.equal(legacy.isLowerBound, false);
  assert.equal(legacy.groupRatioUnverified, false);
});

test('expectedCostFromDeclared：quota_type=1（按次计费）→ 金额侧整体未核验', () => {
  const estimate = expectedCostFromDeclared({ quotaPerUnit: 500000 }, model({ quotaType: 1, modelRatio: 0 }), {
    promptTokens: 100,
    completionTokens: 10,
    samples: 1,
    droppedSamples: 0,
  });
  assert.equal(estimate.state, 'unverified');
  assert.equal(estimate.quota, 0);
  assert.equal(estimate.usd, null);
  assert.equal(estimate.isUpperBound, false);
  assert.equal(estimate.isLowerBound, false);
  assert.match(estimate.unverifiedReason ?? '', /quota_type=1/);
  // 单价字段仍保留（供报告展示「单价单位未核验」），但不作为换算证据
  assert.equal(estimate.inputUsdPerM, 0);
});

test('parsePricingPayload：cache_ratio 解析（缺省/null → null，数值保留）', () => {
  const parsed = parsePricingPayload({
    data: [
      { model_name: 'gpt-4o', model_ratio: 1, completion_ratio: 4, cache_ratio: 0.28, enable_groups: ['default'] },
      { model_name: 'gpt-4o-mini', model_ratio: 0.1, completion_ratio: 8, enable_groups: ['default'] },
    ],
    group_ratio: { default: 1 },
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.table.models['gpt-4o']?.cacheRatio, 0.28);
    assert.equal(parsed.table.models['gpt-4o-mini']?.cacheRatio, null);
  }
});


test('parsePricingPayload：合法表（含 group_ratio）与重复名保留首条', () => {
  const parsed = parsePricingPayload({
    data: [
      { model_name: 'gpt-4o', model_ratio: 1, completion_ratio: 4, quota_type: 0, enable_groups: ['default', 'vip'] },
      { model_name: 'gpt-4o', model_ratio: 9, completion_ratio: 9 },
      { model_name: 'claude-3', model_ratio: 0.75, completion_ratio: 5 },
    ],
    group_ratio: { default: 1, vip: 0.7, broken: -1, nan: 'x' },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.table.models['gpt-4o']?.modelRatio, 1);
  assert.deepEqual(parsed.table.models['gpt-4o']?.groups, ['default', 'vip']);
  assert.equal(parsed.table.models['claude-3']?.completionRatio, 5);
  assert.deepEqual(parsed.table.groupRatio, { default: 1, vip: 0.7 });
});

test('parsePricingPayload：schema 能力边界（404 之外的「不是 new-api」）', () => {
  assert.equal(parsePricingPayload(null).ok, false);
  assert.equal(parsePricingPayload({}).ok, false);
  assert.equal(parsePricingPayload({ data: [] }).ok, false);
  assert.equal(parsePricingPayload({ data: [{ foo: 'bar' }] }).ok, false);
  // 字符串数字不做隐式转换：宁可不判定，也不猜站点口径
  assert.equal(parsePricingPayload({ data: [{ model_name: 'x', model_ratio: '1', completion_ratio: 4 }] }).ok, false);
  // completion_ratio=0 / 负数 → 输出免费属异常价格，整条丢弃
  assert.equal(parsePricingPayload({ data: [{ model_name: 'x', model_ratio: 1, completion_ratio: 0 }] }).ok, false);
  assert.equal(parsePricingPayload({ data: [{ model_name: 'x', model_ratio: -1, completion_ratio: 4 }] }).ok, false);
  // quota_type=1（按次）允许 model_ratio=0；按 token 计费则拒绝 0
  assert.equal(parsePricingPayload({ data: [{ model_name: 'x', model_ratio: 0, completion_ratio: 4, quota_type: 1 }] }).ok, true);
  assert.equal(parsePricingPayload({ data: [{ model_name: 'x', model_ratio: 0, completion_ratio: 4, quota_type: 0 }] }).ok, false);
});

function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: ReturnType<typeof createServer>; origin: string }> {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    });
  });
}

/** 关闭测试服务器：先断开残留 keep-alive/挂起连接，避免 server.close 等 4s 保活超时。 */
function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

test('fetchDeclaredPricing：ok + status quota，且绝不携带 Authorization', async () => {
  const seenAuth: Array<string | undefined> = [];
  const { server, origin } = await listen((req, res) => {
    seenAuth.push(req.headers.authorization);
    if (req.url?.endsWith('/api/pricing')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ model_name: 'gpt-4o', model_ratio: 1, completion_ratio: 4 }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { quota_per_unit: 500000 } }));
  });
  try {
    const result = await fetchDeclaredPricing(`${origin}/v1`, { timeoutMs: 1000, group: ' vip ' });
    assert.equal(result.state, 'ok');
    assert.equal(result.origin, origin);
    assert.equal(result.quotaPerUnit, 500000);
    assert.equal(result.pricing?.models['gpt-4o']?.modelRatio, 1);
    assert.equal(result.pricing?.group, 'vip');
    assert.equal(result.reason, null);
    assert.ok(seenAuth.every((value) => value === undefined), '公示价 GET 不得携带凭证');
  } finally {
    await closeServer(server);
  }
});

test('fetchDeclaredPricing：CLI quota 优先于站点并记录冲突', async () => {
  const { server, origin } = await listen((req, res) => {
    if (req.url?.endsWith('/api/pricing')) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { quota_per_unit: 500000 } }));
  });
  try {
    const result = await fetchDeclaredPricing(`${origin}/v1`, { timeoutMs: 1000, quotaPerUsd: 400000 });
    // pricing 404 → not_applicable，但 quota 换算率仍透出（余额 quota 口径可用）
    assert.equal(result.state, 'not_applicable');
    assert.equal(result.quotaPerUnit, 400000);
    // 冲突说明只在 pricing.ok 的快照里暴露（not_applicable 不需要展示）
    assert.match(result.reason ?? '', /未提供 \/api\/pricing/);
  } finally {
    await closeServer(server);
  }
});

test('fetchDeclaredPricing：冲突文案进入快照（pricing ok 时）', async () => {
  const { server, origin } = await listen((req, res) => {
    if (req.url?.endsWith('/api/pricing')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ model_name: 'gpt-4o', model_ratio: 1, completion_ratio: 4 }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { quota_per_unit: 500000 } }));
  });
  try {
    const result = await fetchDeclaredPricing(`${origin}/v1`, { timeoutMs: 1000, quotaPerUsd: 400000 });
    assert.equal(result.state, 'ok');
    assert.equal(result.quotaPerUnit, 400000);
    assert.match(result.pricing?.quotaPerUnitConflict ?? '', /400000.*500000|500000.*400000/);
  } finally {
    await closeServer(server);
  }
});

test('fetchDeclaredPricing：401/500 → failed；重定向 → not_applicable；超时 → failed', async () => {
  for (const [status, expected] of [
    [401, 'failed'],
    [500, 'failed'],
    [302, 'not_applicable'],
  ] as const) {
    const { server, origin } = await listen((_req, res) => {
      res.writeHead(status).end();
    });
    try {
      const result = await fetchDeclaredPricing(`${origin}/v1`, { timeoutMs: 1000 });
      assert.equal(result.state, expected, `HTTP ${status}`);
      assert.equal(result.pricing, null);
      assert.ok(result.reason !== null, `HTTP ${status} 必须给出原因`);
    } finally {
      await closeServer(server);
    }
  }

  const { server, origin } = await listen((_req, res) => {
    // 比 timeoutMs 更晚响应：AbortController 必须先触发
    setTimeout(() => {
      try {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      } catch {
        // 客户端已 abort，写已关闭的连接失败无妨
      }
    }, 300);
  });
  try {
    const result = await fetchDeclaredPricing(`${origin}/v1`, { timeoutMs: 30 });
    assert.equal(result.state, 'failed');
    assert.match(result.reason ?? '', /超时/);
  } finally {
    await closeServer(server);
  }
});

test('USD_PER_MILLION_PER_RATIO 与 new-api 口径一致（model_ratio=1 → $2/M）', () => {
  assert.equal(USD_PER_MILLION_PER_RATIO, 2);
});

test('quota_per_unit 有效域全工具统一为 1~1e12（余额换算 / 公示价 / CLI 覆盖同域）', async () => {
  for (const bad of [0, -1, 0.5, 1e13, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(isPlausibleQuotaPerUnit(bad), false, `${String(bad)} 不应被判为可用换算系数`);
    // 域外值不得让 CLI 覆盖「污染」公示价快照
    assert.equal(isPlausibleQuotaPerUnit(bad) ? bad : null, null);
  }
  for (const good of [1, 500000, 1e12]) {
    assert.equal(isPlausibleQuotaPerUnit(good), true, `${good} 应在有效域内`);
  }
  assert.equal(isPlausibleQuotaPerUnit(null), false);
  assert.equal(isPlausibleQuotaPerUnit(undefined), false);

  // 站点公示了域外的 quota_per_unit：公示价路径必须与余额换算一起作废（同一字段两处口径不得分裂）
  for (const value of [0.5, 1e13, -1]) {
    const { server, origin } = await listen((req, res) => {
      if (req.url?.endsWith('/api/pricing')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ model_name: 'gpt-4o', model_ratio: 1, completion_ratio: 4 }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { quota_per_unit: value } }));
    });
    try {
      const result = await fetchDeclaredPricing(`${origin}/v1`, { timeoutMs: 1000 });
      assert.equal(result.quotaPerUnit, null, `quota_per_unit=${value} 应作废（与余额换算同域）`);
      assert.equal(result.pricing?.quotaPerUnitSource, 'none', '作废后不得声称来源为 site');
    } finally {
      await closeServer(server);
    }
  }
});
