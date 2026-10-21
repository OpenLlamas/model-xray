import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { scanPricingSites, type PricingScanRequest } from '../../src/pricing-scan/cli.js';

function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function pathOf(req: IncomingMessage): string {
  return new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
}

async function withServers(
  handlers: Array<(req: IncomingMessage, res: ServerResponse) => void>,
  run: (origins: string[]) => Promise<void>,
): Promise<void> {
  const servers = handlers.map((handler) => createServer(handler));
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))));
  const origins = servers.map((server) => {
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  });
  try {
    await run(origins);
  } finally {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
}

function request(overrides: Partial<PricingScanRequest> = {}): PricingScanRequest {
  return {
    model: null,
    group: null,
    quotaPerUsd: null,
    endpoints: [],
    timeoutMs: 1000,
    ...overrides,
  };
}

test('pricing-scan：多站点 schema 自动识别，全表保留免费模型且不泄漏合成 quota', async () => {
  await withServers(
    [
      (req, res) => {
        const path = pathOf(req);
        if (path === '/api/status') return json(res, { data: { quota_per_unit: 500_000 } });
        if (path === '/api/ratio_config') {
          return json(res, {
            success: true,
            data: { model_ratio: { 'paid-model': 1 }, completion_ratio: { 'paid-model': 4 } },
          });
        }
        res.writeHead(404).end();
      },
      (req, res) => {
        if (pathOf(req) === '/api/v1/models') {
          return json(res, {
            data: [
              { id: 'paid-model', pricing: { prompt: '0.000002', completion: '0.000008' } },
              { id: 'free-model', pricing: { prompt: '0', completion: '0' } },
            ],
          });
        }
        res.writeHead(404).end();
      },
    ],
    async (origins) => {
      const sites = await scanPricingSites(origins.map((origin) => `${origin}/v1`), request());
      assert.equal(sites.length, 2);
      assert.equal(sites[0]?.adapter, 'new-api-ratio-config');
      assert.equal(sites[0]?.quotaPerUnit, 500_000);
      assert.equal(sites[0]?.quotaPerUnitSynthetic, false);
      assert.equal(sites[1]?.adapter, 'openrouter-models');
      assert.equal(sites[1]?.quotaPerUnit, null);
      assert.equal(sites[1]?.quotaPerUnitSynthetic, true);
      assert.equal(sites[1]?.quotaPerUnitSource, 'none');
      assert.doesNotMatch(JSON.stringify(sites[1]), /500000/);
      const free = sites[1]?.models.find((row) => row.model === 'free-model');
      assert.ok(free !== undefined);
      assert.equal(free.hasRatio, false);
      assert.equal(free.inputUsdPerM, 0);
      assert.equal(free.outputUsdPerM, 0);
    },
  );
});

test('pricing-scan：目标免费模型只有原始价也能匹配，不误报 model_missing', async () => {
  await withServers(
    [
      (req, res) => {
        if (pathOf(req) === '/api/v1/models') {
          return json(res, {
            data: [{ id: 'free-model', pricing: { prompt: '0', completion: '0' } }],
          });
        }
        res.writeHead(404).end();
      },
    ],
    async (origins) => {
      const sites = await scanPricingSites([`${origins[0]}/v1`], request({ model: 'free-model' }));
      assert.equal(sites[0]?.status, 'ok');
      const row = sites[0]?.models.find((item) => item.model === 'free-model');
      assert.ok(row !== undefined);
      assert.equal(row.matched, true);
      assert.equal(row.hasRatio, false);
    },
  );
});

test('pricing-scan：单站点 500 不拖垮整批，后续站点继续成功', async () => {
  await withServers(
    [
      (_req, res) => {
        res.writeHead(500).end('boom');
      },
      (req, res) => {
        if (pathOf(req) === '/api/pricing') {
          return json(res, {
            data: [{ model_name: 'gpt-4o', model_ratio: 1, completion_ratio: 4 }],
          });
        }
        res.writeHead(404).end();
      },
    ],
    async (origins) => {
      const sites = await scanPricingSites(origins.map((origin) => `${origin}/v1`), request());
      assert.equal(sites[0]?.status, 'failed');
      assert.equal(sites[1]?.status, 'ok');
      assert.equal(sites[1]?.models[0]?.model, 'gpt-4o');
    },
  );
});

test('pricing-scan：目标模型缺失 → model_missing，且仍返回全表', async () => {
  await withServers(
    [
      (req, res) => {
        if (pathOf(req) === '/api/pricing') {
          return json(res, {
            data: [{ model_name: 'other-model', model_ratio: 1, completion_ratio: 4 }],
          });
        }
        res.writeHead(404).end();
      },
    ],
    async (origins) => {
      const sites = await scanPricingSites([`${origins[0]}/v1`], request({ model: 'missing-model' }));
      assert.equal(sites[0]?.status, 'model_missing');
      assert.equal(sites[0]?.models[0]?.model, 'other-model');
      assert.equal(sites[0]?.models.some((row) => row.matched), false);
    },
  );
});
