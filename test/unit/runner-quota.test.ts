import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { runAudit } from '../../src/runner.js';
import type { RunConfig } from '../../src/types.js';

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no port'));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}/v1`);
    });
  });
}

function makeCfg(baseUrl: string): RunConfig {
  return {
    baseUrl,
    apiKey: 'k',
    model: 'glm-5.3-flash',
    claimedContext: null,
    expect: [],
    deep: false,
    seed: 1,
    timeoutMs: 5000,
    retries: 0,
    outDir: 'reports',
    html: false,
    yes: true,
    quiet: true,
  };
}

test('runner: quota exhaustion aborts remaining phases and stops network traffic', async () => {
  // 真机实证（2026-10-18）：key 配额耗尽后旧实现仍把 54 次请求全部发完，报告被几十条 429 噪音淹没。
  // 期望：首个配额 429 熔断，后续维度明确标记「跳过」，整轮只发生 1 次网络请求。
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { message: 'key quota exceeded: used 2.113287/2', type: 'upstream_error', code: 'QUOTA_EXCEEDED' },
      }),
    );
  });
  const baseUrl = await listen(server);
  try {
    const report = await runAudit(makeCfg(baseUrl));
    assert.equal(report.total, null);
    assert.equal(hits, 1, `配额耗尽后不得继续空发请求（实际 ${hits} 次）`);

    const identity = report.outcomes.find((o) => o.id === 'identity');
    assert.ok(identity !== undefined);
    assert.equal(identity.status, 'insufficient');
    assert.match(identity.headline, /本维度提前中止/);
    assert.equal(identity.metrics['quotaAborted'], 1);
    // 首个 429 是唯一真实网络请求：不得把熔断后的本地短路累积成多条「假失败」证据。
    assert.equal(report.evidence.length, 1, `证据应只含首个真实请求（实际 ${report.evidence.length} 条）`);

    for (const id of ['context', 'billing', 'capability', 'decoy', 'quality', 'ttft']) {
      const outcome = report.outcomes.find((o) => o.id === id);
      assert.ok(outcome !== undefined, `缺少 ${id} 结果`);
      assert.equal(outcome.status, 'insufficient');
      assert.equal(outcome.score, null);
      assert.match(outcome.headline, /跳过该维度/);
      assert.equal(outcome.metrics['skipped'], 1);
    }
    assert.ok(report.notes.some((n) => /配额耗尽.*提前熔断/.test(n)), JSON.stringify(report.notes));
  } finally {
    server.close();
  }
});
