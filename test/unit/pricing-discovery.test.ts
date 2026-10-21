import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { discoverPricing } from '../../src/pricing-discovery.js';

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function pathOf(req: IncomingMessage): string {
  return new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
}

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}/v1`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('discoverPricing：/api/pricing 404 → /api/ratio_config 成功，quota 取 /api/status', async () => {
  await withServer(
    (req, res) => {
      const path = pathOf(req);
      if (path === '/api/status') return json(res, { data: { quota_per_unit: 500_000 } });
      if (path === '/api/ratio_config') {
        return json(res, {
          success: true,
          data: { model_ratio: { 'gpt-4o': 1 }, completion_ratio: { 'gpt-4o': 4 } },
        });
      }
      res.writeHead(404).end();
    },
    async (baseUrl) => {
      const result = await discoverPricing(baseUrl, { timeoutMs: 1000 });
      assert.equal(result.state, 'ok');
      assert.equal(result.adapter, 'new-api-ratio-config');
      assert.equal(result.path, '/api/ratio_config');
      assert.equal(result.pricing?.source, 'api');
      assert.equal(result.quotaPerUnit, 500_000);
      assert.equal(result.quotaPerUnitSource, 'site');
      assert.equal(result.quotaPerUnitSynthetic, false);
      assert.equal(result.pricing?.quotaPerUnit, 500_000);
      assert.equal(result.pricing?.models['gpt-4o']?.completionRatio, 4);
      assert.equal(result.prices?.['gpt-4o']?.inputUsdPerM, 2);
      assert.deepEqual(
        result.probes.map((probe) => probe.state),
        ['not_found', 'ok'],
      );
    },
  );
});

test('discoverPricing：指定 model 时跳过不含该模型的 /api/pricing，选择 OpenRouter 价表', async () => {
  await withServer(
    (req, res) => {
      const path = pathOf(req);
      if (path === '/api/pricing') {
        return json(res, {
          data: [{ model_name: 'other-model', model_ratio: 1, completion_ratio: 4 }],
        });
      }
      if (path === '/api/v1/models') {
        return json(res, {
          data: [
            {
              id: 'gpt-4o',
              pricing: { prompt: '0.000002', completion: '0.000008' },
            },
          ],
        });
      }
      res.writeHead(404).end();
    },
    async (baseUrl) => {
      const result = await discoverPricing(baseUrl, { timeoutMs: 1000, model: 'gpt-4o' });
      assert.equal(result.state, 'ok');
      assert.equal(result.adapter, 'openrouter-models');
      assert.equal(result.path, '/api/v1/models');
      assert.equal(result.pricing?.source, 'public-json');
      assert.equal(result.prices?.['gpt-4o']?.inputUsdPerM, 2);
      assert.equal(result.prices?.['gpt-4o']?.outputUsdPerM, 8);
      assert.ok(result.probes.some((probe) => probe.path === '/api/pricing' && probe.state === 'ok'));
    },
  );
});

test('discoverPricing：所有候选 404 → not_applicable（能力边界，不伪造价格）', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(404).end();
    },
    async (baseUrl) => {
      const result = await discoverPricing(baseUrl, { timeoutMs: 1000 });
      assert.equal(result.state, 'not_applicable');
      assert.equal(result.pricing, null);
      assert.equal(result.adapter, null);
      assert.match(result.reason ?? '', /未发现可解析的公开价格接口/);
      assert.equal(result.probes.length, 7);
    },
  );
});

test('discoverPricing：候选返回 500 → failed（接口存在但读不到，区别于 404）', async () => {
  await withServer(
    (req, res) => {
      if (pathOf(req) === '/api/pricing') {
        res.writeHead(500).end('boom');
        return;
      }
      res.writeHead(404).end();
    },
    async (baseUrl) => {
      const result = await discoverPricing(baseUrl, { timeoutMs: 1000 });
      assert.equal(result.state, 'failed');
      assert.match(result.reason ?? '', /HTTP 500/);
      assert.equal(result.probes[0]?.state, 'http_error');
    },
  );
});

test('discoverPricing：请求不携带 Authorization/Cookie（公开接口零凭证）', async () => {
  let authorization: string | undefined;
  let cookie: string | undefined;
  await withServer(
    (req, res) => {
      authorization = req.headers.authorization;
      cookie = req.headers.cookie;
      if (pathOf(req) === '/api/pricing') {
        return json(res, {
          data: [{ model_name: 'gpt-4o', model_ratio: 1, completion_ratio: 4 }],
        });
      }
      res.writeHead(404).end();
    },
    async (baseUrl) => {
      const result = await discoverPricing(baseUrl, { timeoutMs: 1000 });
      assert.equal(result.state, 'ok');
      assert.equal(authorization, undefined);
      assert.equal(cookie, undefined);
    },
  );
});

test('discoverPricing：自定义同源端点优先，schema 自动识别', async () => {
  await withServer(
    (req, res) => {
      const path = pathOf(req);
      if (path === '/custom/prices.json') {
        return json(res, {
          success: true,
          data: { model_ratio: { 'custom-model': 2 }, completion_ratio: { 'custom-model': 3 } },
        });
      }
      if (path === '/api/pricing') {
        return json(res, {
          data: [{ model_name: 'site-model', model_ratio: 1, completion_ratio: 4 }],
        });
      }
      res.writeHead(404).end();
    },
    async (baseUrl) => {
      const result = await discoverPricing(baseUrl, {
        timeoutMs: 1000,
        endpoints: ['/custom/prices.json'],
      });
      assert.equal(result.state, 'ok');
      assert.equal(result.adapter, 'new-api-ratio-config');
      assert.equal(result.path, '/custom/prices.json');
      assert.equal(result.pricing?.models['custom-model']?.modelRatio, 2);
      assert.equal(result.prices?.['custom-model']?.inputUsdPerM, 4);
      assert.equal(result.probes.length, 1);
    },
  );
});

test('discoverPricing：CLI quota 覆盖站点值并披露冲突', async () => {
  await withServer(
    (req, res) => {
      const path = pathOf(req);
      if (path === '/api/status') return json(res, { data: { quota_per_unit: 500_000 } });
      if (path === '/api/pricing') {
        return json(res, {
          data: [{ model_name: 'gpt-4o', model_ratio: 1, completion_ratio: 4 }],
        });
      }
      res.writeHead(404).end();
    },
    async (baseUrl) => {
      const result = await discoverPricing(baseUrl, { timeoutMs: 1000, quotaPerUsd: 123_456 });
      assert.equal(result.quotaPerUnit, 123_456);
      assert.equal(result.quotaPerUnitSource, 'cli');
      assert.match(result.quotaPerUnitConflict ?? '', /不一致/);
    },
  );
});

test('discoverPricing：目标模型只在免费价目里（无倍率锚）也能选中该表', async () => {
  await withServer(
    (req, res) => {
      const path = pathOf(req);
      if (path === '/api/pricing') {
        return json(res, {
          data: [{ model_name: 'paid-model', model_ratio: 1, completion_ratio: 4 }],
        });
      }
      if (path === '/api/v1/models') {
        return json(res, {
          data: [{ id: 'free-model', pricing: { prompt: '0', completion: '0' } }],
        });
      }
      res.writeHead(404).end();
    },
    async (baseUrl) => {
      const result = await discoverPricing(baseUrl, { timeoutMs: 1000, model: 'free-model' });
      assert.equal(result.state, 'ok');
      assert.equal(result.adapter, 'openrouter-models');
      assert.equal(result.pricing?.models['free-model'], undefined);
      assert.equal(result.prices?.['free-model']?.inputUsdPerM, 0);
      assert.equal(result.prices?.['free-model']?.outputUsdPerM, 0);
    },
  );
});

test('discoverPricing：公开价表无真实 quota → quota 返回 null 并标记合成，绝不泄露 500000', async () => {
  await withServer(
    (req, res) => {
      if (pathOf(req) === '/api/v1/models') {
        return json(res, {
          data: [{ id: 'gpt-4o', pricing: { prompt: '0.000002', completion: '0.000008' } }],
        });
      }
      res.writeHead(404).end();
    },
    async (baseUrl) => {
      const result = await discoverPricing(baseUrl, { timeoutMs: 1000 });
      assert.equal(result.state, 'ok');
      assert.equal(result.adapter, 'openrouter-models');
      assert.equal(result.quotaPerUnit, null);
      assert.equal(result.quotaPerUnitSource, 'none');
      assert.equal(result.quotaPerUnitSynthetic, true);
      assert.equal(result.pricing?.quotaPerUnit, null);
      assert.equal(result.pricing?.quotaPerUnitSource, 'none');
      assert.equal(result.prices?.['gpt-4o']?.inputUsdPerM, 2);
      assert.doesNotMatch(JSON.stringify(result), /500000/);
    },
  );
});

test('discoverPricing：公开价表的 modelRatio 按真实 quota 换算，而不是固定 2 倍', async () => {
  await withServer(
    (req, res) => {
      const path = pathOf(req);
      if (path === '/api/status') return json(res, { data: { quota_per_unit: 100_000 } });
      if (path === '/api/v1/models') {
        return json(res, {
          data: [{ id: 'gpt-4o', pricing: { prompt: '0.000002', completion: '0.000008' } }],
        });
      }
      res.writeHead(404).end();
    },
    async (baseUrl) => {
      const result = await discoverPricing(baseUrl, { timeoutMs: 1000 });
      assert.equal(result.state, 'ok');
      assert.equal(result.quotaPerUnit, 100_000);
      assert.equal(result.quotaPerUnitSynthetic, false);
      assert.equal(result.pricing?.quotaPerUnit, 100_000);
      // $2/M ÷ ($10/M per ratio) = 0.2，证明换算使用站点真实 quota。
      assert.equal(result.pricing?.models['gpt-4o']?.modelRatio, 0.2);
      assert.equal(result.prices?.['gpt-4o']?.inputUsdPerM, 2);
      assert.equal(result.prices?.['gpt-4o']?.outputUsdPerM, 8);
    },
  );
});

test('discoverPricing：非法 --quota-per-usd 直接 failed，不猜测换算率', async () => {
  let requested = false;
  await withServer(
    (_req, res) => {
      requested = true;
      res.writeHead(500).end();
    },
    async (baseUrl) => {
      const result = await discoverPricing(baseUrl, { timeoutMs: 1000, quotaPerUsd: 0 });
      assert.equal(result.state, 'failed');
      assert.match(result.reason ?? '', /quotaPerUsd 必须在/);
      assert.equal(requested, false);
      assert.deepEqual(result.probes, []);
    },
  );
});

test('discoverPricing：跨源自定义端点被记录为 schema_mismatch，且继续探测内置端点', async () => {
  let requested = false;
  await withServer(
    (_req, res) => {
      requested = true;
      res.writeHead(404).end();
    },
    async (baseUrl) => {
      const result = await discoverPricing(baseUrl, {
        timeoutMs: 1000,
        endpoints: ['https://other.invalid/prices.json'],
      });
      assert.equal(result.state, 'not_applicable');
      assert.equal(requested, true);
      assert.equal(result.probes.length, 8);
      assert.equal(result.probes[0]?.path, 'https://other.invalid/prices.json');
      assert.equal(result.probes[0]?.state, 'schema_mismatch');
      assert.match(result.probes[0]?.reason ?? '', /跨源/);
    },
  );
});

test('discoverPricing：目标模型在所有成功价表中都不存在 → 返回首个成功表，不伪造匹配', async () => {
  await withServer(
    (req, res) => {
      if (pathOf(req) === '/api/pricing') {
        return json(res, {
          data: [{ model_name: 'other-model', model_ratio: 1, completion_ratio: 4 }],
        });
      }
      res.writeHead(404).end();
    },
    async (baseUrl) => {
      const result = await discoverPricing(baseUrl, { timeoutMs: 1000, model: 'missing-model' });
      assert.equal(result.state, 'ok');
      assert.equal(result.path, '/api/pricing');
      assert.equal(result.pricing?.models['missing-model'], undefined);
      assert.equal(result.prices?.['missing-model'], undefined);
    },
  );
});
