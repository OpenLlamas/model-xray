import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPricingWatchCycle, type PricingWatchOptions } from '../../src/pricing-watch/cli.js';
import { ledgerPath } from '../../src/pricing-ledger.js';

interface Site {
  origin: string;
  /** 调整 /api/pricing 公示的 model_ratio（模拟站点偷偷调倍率）。 */
  setRatio: (modelRatio: number) => void;
  /** 调整公示的 quota_type（0=按 token，1=按次）——模拟站点换计费基准。 */
  setQuotaType: (quotaType: number) => void;
  /** 调整 /api/status 公示的 quota_per_unit（$1 = N quota）——模拟站点改换算系数。 */
  setQuotaPerUnit: (quotaPerUnit: number | null) => void;
  close: () => void;
}

/** mock 站点：/api/pricing 返回 new-api 风格公示倍率表；/api/status 返回 quota_per_unit；其余 404。 */
async function startSite(
  options: { withPricing?: boolean; quotaType?: number; quotaPerUnit?: number | null } = {},
): Promise<Site> {
  const withPricing = options.withPricing !== false;
  let modelRatio = 1;
  let quotaType = options.quotaType ?? 0;
  let quotaPerUnit = options.quotaPerUnit ?? null;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (withPricing && path.endsWith('/api/pricing')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [{ model_name: 'gpt-4o', model_ratio: modelRatio, completion_ratio: 4, quota_type: quotaType }],
          group_ratio: { default: 1 },
        }),
      );
      return;
    }
    if (path.endsWith('/api/status')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: quotaPerUnit === null ? {} : { quota_per_unit: quotaPerUnit } }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'not found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    setRatio: (value: number) => {
      modelRatio = value;
    },
    setQuotaType: (value: number) => {
      quotaType = value;
    },
    setQuotaPerUnit: (value: number | null) => {
      quotaPerUnit = value;
    },
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

function makeOptions(site: Site, outDir: string): PricingWatchOptions {
  return {
    baseUrl: `${site.origin}/v1`,
    model: 'gpt-4o',
    group: null,
    quotaPerUsd: null,
    outDir,
    timeoutMs: 2000,
  };
}

test('pricing-watch：首轮建立基线（不判漂移），第二轮无变化，第三轮倍率上调判漂移', async () => {
  const site = await startSite();
  const outDir = mkdtempSync(join(tmpdir(), 'model-xray-watch-'));
  try {
    const first = await runPricingWatchCycle(makeOptions(site, outDir));
    assert.equal(first.status, 'ok');
    assert.equal(first.baselineCreated, true);
    assert.equal(first.wrote, true);
    assert.equal(first.drifts.length, 0);

    const second = await runPricingWatchCycle(makeOptions(site, outDir));
    assert.equal(second.status, 'ok');
    assert.equal(second.baselineCreated, false);
    assert.equal(second.drifts.length, 0);
    assert.match(second.note ?? '', /无变化/);

    site.setRatio(1.5);
    const third = await runPricingWatchCycle(makeOptions(site, outDir));
    assert.equal(third.status, 'drift');
    assert.ok(third.drifts.length >= 1);
    const ratioDrift = third.drifts.find((drift) => drift.field === 'model_ratio');
    assert.ok(ratioDrift !== undefined);
    assert.equal(ratioDrift.direction, 'up');
    assert.equal(ratioDrift.model, 'gpt-4o');
  } finally {
    site.close();
  }
});

test('pricing-watch：站点无公示价 → 报错且不写账本', async () => {
  const site = await startSite({ withPricing: false });
  const outDir = mkdtempSync(join(tmpdir(), 'model-xray-watch-'));
  try {
    const result = await runPricingWatchCycle(makeOptions(site, outDir));
    assert.equal(result.status, 'error');
    assert.match(result.error ?? '', /未提供可解析的公示价/);
    assert.equal(result.wrote, false);
  } finally {
    site.close();
  }
});

test('pricing-watch：账本尾部损坏 → 拒绝判定「无变化」且不写入', async () => {
  const site = await startSite();
  const outDir = mkdtempSync(join(tmpdir(), 'model-xray-watch-'));
  try {
    const first = await runPricingWatchCycle(makeOptions(site, outDir));
    assert.equal(first.status, 'ok');
    // 追加一行未终止的半行（模拟进程被 kill 在写入中途）。
    appendFileSync(first.ledgerPath, '{"schemaVersion":1,"origin":"', 'utf8');
    const second = await runPricingWatchCycle(makeOptions(site, outDir));
    assert.equal(second.status, 'error');
    assert.match(second.error ?? '', /尾部损坏/);
    assert.equal(second.wrote, false);
    const content = readFileSync(first.ledgerPath, 'utf8');
    assert.ok(!content.includes('"schemaVersion":1,"origin":"\n'), '不得把新行粘在半行后');
  } finally {
    site.close();
  }
});

test('pricing-watch：账本按主机归档，路径别名共享同一份历史', async () => {
  const site = await startSite();
  const outDir = mkdtempSync(join(tmpdir(), 'model-xray-watch-'));
  try {
    const first = await runPricingWatchCycle(makeOptions(site, outDir));
    assert.equal(first.status, 'ok');
    const expected = ledgerPath(outDir, site.origin);
    assert.equal(first.ledgerPath, expected);
    // 同一主机、只换路径别名 → 仍然命中同一份账本（对比得到「无变化」而不是「首次建基线」）。
    const alias = await runPricingWatchCycle({ ...makeOptions(site, outDir), baseUrl: `${site.origin}/relay/v1` });
    assert.equal(alias.status, 'ok');
    assert.equal(alias.baselineCreated, false, '路径别名应复用同一份历史');
  } finally {
    site.close();
  }
});

test('pricing-watch：站点换计费基准（按 token → 按次）→ 只报口径断裂，不判数值漂移', async () => {
  const site = await startSite({ quotaType: 0 });
  const outDir = mkdtempSync(join(tmpdir(), 'model-xray-watch-'));
  try {
    const first = await runPricingWatchCycle(makeOptions(site, outDir));
    assert.equal(first.status, 'ok');
    site.setQuotaType(1);
    const second = await runPricingWatchCycle(makeOptions(site, outDir));
    // 口径断裂必须被披露（换计费方式必然影响金额），但不得产出任何数值漂移结论。
    assert.equal(second.status, 'drift');
    assert.ok(second.drifts.length >= 1);
    assert.ok(second.drifts.every((drift) => drift.kind === 'basis'), JSON.stringify(second.drifts));
    assert.equal(second.drifts.some((drift) => drift.field === 'model_ratio'), false);
  } finally {
    site.close();
  }
});

test('pricing-watch：站点改 quota 换算系数（倍率不动）→ 判漂移（实收金额随之变化）', async () => {
  const site = await startSite({ quotaPerUnit: 500000 });
  const outDir = mkdtempSync(join(tmpdir(), 'model-xray-watch-'));
  try {
    const first = await runPricingWatchCycle(makeOptions(site, outDir));
    assert.equal(first.status, 'ok');
    site.setQuotaPerUnit(250000);
    const second = await runPricingWatchCycle(makeOptions(site, outDir));
    assert.equal(second.status, 'drift');
    const qpu = second.drifts.find((drift) => drift.field === 'quota_per_unit');
    assert.ok(qpu !== undefined, '换算系数变更必须被检出');
    assert.equal(qpu?.kind, 'basis');
    assert.equal(qpu?.significant, true);
  } finally {
    site.close();
  }
});
