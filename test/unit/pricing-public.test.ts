import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchPublicPricing } from '../../src/pricing-public.js';

function closeTo(actual: number | null, expected: number, epsilon = 1e-12): boolean {
  return actual !== null && Math.abs(actual - expected) <= epsilon;
}

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (baseUrl: string, server: Server) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}/v1`, server);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const GLM_ITEM = {
  code: 'glm-5.3-flash',
  price_input_usd: '0.2400',
  price_output_usd: '0.8400',
  price_cached_usd: '0.0690',
  price_list_input_usd: '0.8000',
  price_list_output_usd: '2.8000',
  price_list_cached_usd: '0.2300',
};

test('fetchPublicPricing: 字符串 USD 单价 → 倍率、原始价与元数据', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/public/model-prices') return json(res, { items: [GLM_ITEM] });
      res.writeHead(404).end();
    },
    async (baseUrl) => {
      const result = await fetchPublicPricing(baseUrl, { timeoutMs: 1000 });
      assert.equal(result.state, 'ok');
      assert.equal(result.page, '/public/model-prices');
      assert.equal(result.entries, 1);
      assert.equal(result.skipped, 0);
      assert.equal(result.duplicates, 0);
      assert.equal(result.truncated, 0);
      assert.equal(result.unusable, 0);
      assert.equal(result.pricing?.source, 'public-json');
      assert.equal(result.pricing?.quotaPerUnit, 500_000);
      const model = result.pricing?.models['glm-5.3-flash'];
      assert.ok(model);
      assert.ok(closeTo(model.modelRatio, 0.12));
      assert.ok(closeTo(model.completionRatio, 3.5));
      assert.ok(closeTo(model.cacheRatio, 0.2875));
      assert.equal(model.quotaType, 0);
      assert.equal(model.modelPrice, null);
      assert.deepEqual(model.groups, []);
      const price = result.prices?.['glm-5.3-flash'];
      assert.ok(price);
      assert.equal(price.inputUsdPerM, 0.24);
      assert.equal(price.outputUsdPerM, 0.84);
      assert.equal(price.cachedUsdPerM, 0.069);
      assert.equal(price.listInputUsdPerM, 0.8);
      assert.equal(price.listOutputUsdPerM, 2.8);
      assert.equal(price.listCachedUsdPerM, 0.23);
    },
  );
});

test('fetchPublicPricing: 非法条目跳过（科学计数/加号/缺 code/负价/全零）', async () => {
  const items = [
    { code: 'good', price_input_usd: '2', price_output_usd: '4', price_cached_usd: 'nope' },
    { code: 'sci', price_input_usd: '1e999', price_output_usd: '2' },
    { code: 'plus', price_input_usd: '+0.5', price_output_usd: '1' },
    { price_input_usd: '1', price_output_usd: '2' },
    { code: 'zero', price_input_usd: '0', price_output_usd: '0' },
    { code: 'neg', price_input_usd: '-1', price_output_usd: '2' },
  ];
  await withServer(
    (req, res) => {
      if (req.url === '/public/model-prices') return json(res, { items });
      res.writeHead(404).end();
    },
    async (baseUrl) => {
      const result = await fetchPublicPricing(baseUrl, { timeoutMs: 1000 });
      assert.equal(result.state, 'ok');
      assert.equal(result.entries, 1);
      assert.equal(result.skipped, 5);
      assert.deepEqual(Object.keys(result.pricing?.models ?? {}), ['good']);
      assert.equal(result.prices?.['good']?.cachedUsdPerM, null);
    },
  );
});

test('fetchPublicPricing: 首个候选 404 后探测第二个；仅 404 继续', async () => {
  const paths: string[] = [];
  await withServer(
    (req, res) => {
      paths.push(req.url ?? '');
      if (req.url === '/public/model-prices') return res.writeHead(404).end();
      if (req.url === '/public/models') {
        return json(res, { items: [{ code: 'm', price_input_usd: '2', price_output_usd: '4' }] });
      }
      res.writeHead(404).end();
    },
    async (baseUrl) => {
      const result = await fetchPublicPricing(baseUrl, { timeoutMs: 1000 });
      assert.equal(result.state, 'ok');
      assert.equal(result.page, '/public/models');
      assert.deepEqual(paths, ['/public/model-prices', '/public/models']);
    },
  );
});

test('fetchPublicPricing: 首个候选 500 → failed 且不请求第二个', async () => {
  const paths: string[] = [];
  await withServer(
    (req, res) => {
      paths.push(req.url ?? '');
      res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"boom"}');
    },
    async (baseUrl) => {
      const result = await fetchPublicPricing(baseUrl, { timeoutMs: 1000 });
      assert.equal(result.state, 'failed');
      assert.match(result.reason ?? '', /HTTP 500/);
      assert.deepEqual(paths, ['/public/model-prices']);
    },
  );
});

test('fetchPublicPricing: 响应体超 512KB → failed 且不请求第二个', async () => {
  const paths: string[] = [];
  await withServer(
    (req, res) => {
      paths.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('x'.repeat(512 * 1024 + 1));
    },
    async (baseUrl) => {
      const result = await fetchPublicPricing(baseUrl, { timeoutMs: 5000 });
      assert.equal(result.state, 'failed');
      assert.match(result.reason ?? '', /超过上限/);
      assert.deepEqual(paths, ['/public/model-prices']);
    },
  );
});

test('fetchPublicPricing: 请求超时 → failed 且不请求第二个', async () => {
  let requests = 0;
  await withServer(
    () => {
      requests += 1;
      // 故意不响应：让 AbortController 在 timeoutMs 后中止。
    },
    async (baseUrl) => {
      const result = await fetchPublicPricing(baseUrl, { timeoutMs: 50 });
      assert.equal(result.state, 'failed');
      assert.match(result.reason ?? '', /超时/);
      assert.equal(requests, 1);
    },
  );
});

test('fetchPublicPricing: 两个候选均 404 → not_applicable（能力边界）', async () => {
  const paths: string[] = [];
  await withServer(
    (req, res) => {
      paths.push(req.url ?? '');
      res.writeHead(404).end();
    },
    async (baseUrl) => {
      const result = await fetchPublicPricing(baseUrl, { timeoutMs: 1000 });
      assert.equal(result.state, 'not_applicable');
      assert.equal(result.page, null);
      assert.equal(
        result.reason,
        '站点未提供公开价格表（/public/model-prices 与 /public/models 均 404）',
      );
      assert.deepEqual(paths, ['/public/model-prices', '/public/models']);
    },
  );
});

test('fetchPublicPricing: 重复 code 保留首次出现', async () => {
  const duplicates = [
    { code: 'dup', price_input_usd: '2', price_output_usd: '4' },
    { code: 'dup', price_input_usd: '200', price_output_usd: '400' },
  ];
  await withServer(
    (req, res) => {
      if (req.url === '/public/model-prices') return json(res, { items: duplicates });
      res.writeHead(404).end();
    },
    async (baseUrl) => {
      const result = await fetchPublicPricing(baseUrl, { timeoutMs: 1000 });
      assert.equal(result.entries, 1);
      assert.equal(result.duplicates, 1);
      assert.equal(result.pricing?.models['dup']?.modelRatio, 1);
    },
  );
});

test('fetchPublicPricing: 超过 2000 条按出现顺序截断并记录', async () => {
  const many = Array.from({ length: 2001 }, (_, index) => ({
    code: `m${index}`,
    price_input_usd: '2',
    price_output_usd: '4',
  }));
  await withServer(
    (req, res) => {
      if (req.url === '/public/model-prices') return json(res, { items: many });
      res.writeHead(404).end();
    },
    async (baseUrl) => {
      const result = await fetchPublicPricing(baseUrl, { timeoutMs: 1000 });
      assert.equal(result.page, '/public/model-prices');
      assert.equal(result.entries, 2000);
      assert.equal(result.truncated, 1);
      assert.equal(result.pricing?.models['m0']?.modelRatio, 1);
      assert.equal(result.pricing?.models['m1999']?.modelRatio, 1);
      assert.equal(result.pricing?.models['m2000'], undefined);
    },
  );
});

test('fetchPublicPricing: 输入价为 0 → 条目不参与倍率锚（unusable 计数）', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/public/model-prices') {
        return json(res, { items: [{ code: 'free', price_input_usd: '0', price_output_usd: '1' }] });
      }
      res.writeHead(404).end();
    },
    async (baseUrl) => {
      const result = await fetchPublicPricing(baseUrl, { timeoutMs: 1000 });
      assert.equal(result.state, 'ok');
      assert.equal(result.entries, 1);
      assert.equal(result.unusable, 1);
      assert.deepEqual(Object.keys(result.pricing?.models ?? {}), []);
      assert.equal(result.prices?.['free']?.outputUsdPerM, 1);
    },
  );
});

test('fetchPublicPricing: baseUrl 含 userinfo 时不发送凭证，且请求无 Authorization/Cookie', async () => {
  const headers: Array<{ authorization: string | undefined; cookie: string | undefined }> = [];
  await withServer(
    (req, res) => {
      if (req.url !== '/public/model-prices') return res.writeHead(404).end();
      headers.push({ authorization: req.headers.authorization, cookie: req.headers.cookie });
      json(res, { items: [{ code: 'm', price_input_usd: '2', price_output_usd: '4' }] });
    },
    async (baseUrl) => {
      const port = new URL(baseUrl).port;
      const result = await fetchPublicPricing(`http://user:secret@127.0.0.1:${port}/v1`, { timeoutMs: 1000 });
      assert.equal(result.state, 'ok');
      assert.equal(headers.length, 1);
      assert.equal(headers[0]?.authorization, undefined);
      assert.equal(headers[0]?.cookie, undefined);
    },
  );
});

test('fetchPublicPricing: 同源 301（尾斜杠规范化）跟随一次', async () => {
  const paths: string[] = [];
  await withServer(
    (req, res) => {
      paths.push(req.url ?? '');
      if (req.url === '/public/model-prices') {
        res.writeHead(301, { location: '/public/model-prices/' }).end();
        return;
      }
      if (req.url === '/public/model-prices/') return json(res, { items: [{ code: 'm', price_input_usd: '2', price_output_usd: '4' }] });
      res.writeHead(404).end();
    },
    async (baseUrl) => {
      const result = await fetchPublicPricing(baseUrl, { timeoutMs: 1000 });
      assert.equal(result.state, 'ok');
      assert.equal(result.page, '/public/model-prices');
      assert.deepEqual(paths, ['/public/model-prices', '/public/model-prices/']);
    },
  );
});

test('fetchPublicPricing: 跨源重定向不跟随（不泄漏请求到其他 origin）', async () => {
  let otherOriginRequests = 0;
  await withServer(
    (req, res) => {
      if (req.url === '/public/model-prices') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
        return;
      }
      otherOriginRequests += 1;
      res.writeHead(404).end();
    },
    async (baseUrl) => {
      const result = await fetchPublicPricing(baseUrl, { timeoutMs: 1000 });
      assert.equal(result.state, 'failed');
      assert.match(result.reason ?? '', /重定向/);
      assert.equal(otherOriginRequests, 0); // 跨源跳转既不跟随，也不改用第二个候选
    },
  );
});

test('fetchPublicPricing: 同源二次重定向 → failed（不无限跟随）', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/public/model-prices') {
        res.writeHead(301, { location: '/public/model-prices/a' }).end();
        return;
      }
      if (req.url === '/public/model-prices/a') {
        res.writeHead(301, { location: '/public/model-prices/b' }).end();
        return;
      }
      res.writeHead(404).end();
    },
    async (baseUrl) => {
      const result = await fetchPublicPricing(baseUrl, { timeoutMs: 1000 });
      assert.equal(result.state, 'failed');
      assert.match(result.reason ?? '', /重定向/);
    },
  );
});

test('fetchPublicPricing: baseUrl 非法 → failed（不抛异常）', async () => {
  const result = await fetchPublicPricing('not a url', { timeoutMs: 1000 });
  assert.equal(result.state, 'failed');
  assert.match(result.reason ?? '', /无法解析/);
  assert.equal(result.pricing, null);
});
