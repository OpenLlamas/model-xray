// test/unit/ledger-crash.test.ts —— 真实子进程 kill -9 崩溃恢复端到端用例：
//   子进程写入 200 条 requests（确定性 id crash-req-0..199）、仅结算前 120 条，打印 READY 后阻塞；
//   父进程 SIGKILL 强杀后重开同一库，断言：重开不抛、integrity_check='ok'、前 120 条结算可读、
//   recover() 恰补 80 条 interrupted/gateway 且幂等、hash 链在崩溃恢复后仍全通（200+200 行全部上链）。
// 子进程非 shell 直起（process.execPath + 参数数组）；临时目录 finally try/catch 清理。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../../src/ledger/ledger.js';

/** 子进程脚本：写满 200 请求、结算前 120 条后打印 READY 并阻塞（等待被强杀，模拟崩溃进程）。 */
const CRASH_WRITER_SOURCE = [
  'const ledgerUrl = process.argv[2];',
  'const dbPath = process.argv[3];',
  'const { Ledger } = await import(ledgerUrl);',
  'const ledger = new Ledger(dbPath);',
  'const TOTAL = 200;',
  'const SETTLED = 120;',
  'for (let i = 0; i < TOTAL; i += 1) {',
  '  const id = ledger.recordRequest({',
  "    id: 'crash-req-' + i,",
  '    ts_ms: 1000 + i,',
  "    origin: 'user',",
  "    channel_id: 'ch-crash',",
  "    alias: 'alias-crash',",
  "    model_upstream: 'real-crash',",
  '    req_bytes: 10,',
  '    has_tools: 0,',
  '    has_image: 0,',
  '    messages_count: 1,',
  '  });',
  '  if (id === null) {',
  "    console.error('recordRequest failed at ' + i);",
  '    process.exit(3);',
  '  }',
  '  if (i < SETTLED) {',
  '    const ok = ledger.settle({',
  "      request_id: 'crash-req-' + i,",
  '      attempt_no: 1,',
  '      ts_ms: 2000 + i,',
  "      channel_id: 'ch-crash',",
  "      alias: 'alias-crash',",
  '      upstream_status: 200,',
  "      client_status: 'ok',",
  '      error_source: null,',
  '      error_class: null,',
  "      finish_reason: 'stop',",
  '      ttft_upstream_ms: 5.5,',
  '      ttft_client_ms: null,',
  '      ttft_contaminated: 0,',
  '      token_prompt: 3,',
  '      token_completion: 1,',
  '      token_cached: null,',
  '      token_reasoning: null,',
  "      token_source: 'usage',",
  '      token_missing_reason: null,',
  '      usage_valid: 1,',
  '      amount: null,',
  '    });',
  '    if (ok !== true) {',
  "      console.error('settle failed at ' + i);",
  '      process.exit(4);',
  '    }',
  '  }',
  '}',
  "console.log('READY');",
  'setInterval(() => {}, 1000);',
].join('\n');

test('崩溃恢复：kill -9 后重开——integrity ok、已结算不丢、recover 补 80 条、链仍全通', { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mx-ledger-crash-'));
  const dbPath = join(dir, 'crash.db');
  const scriptPath = join(dir, 'crash-writer.mjs');
  writeFileSync(scriptPath, CRASH_WRITER_SOURCE, 'utf8');
  const ledgerJsUrl = new URL('../../src/ledger/ledger.js', import.meta.url).href;
  try {
    const child = spawn(process.execPath, [scriptPath, ledgerJsUrl, dbPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const exited = new Promise<number | null>((resolveExit) => child.on('exit', (code) => resolveExit(code)));
    const ready = new Promise<boolean>((resolveReady) => {
      child.stdout.on('data', () => {
        if (stdout.includes('READY')) resolveReady(true);
      });
    });
    const firstEvent = await Promise.race([
      ready.then(() => 'ready' as const),
      exited.then((code) => `exit:${String(code)}` as const),
    ]);
    assert.equal(firstEvent, 'ready', `子进程未打印 READY 即退出（stderr：${stderr}）`);
    child.kill('SIGKILL');
    await exited;

    const ledger = new Ledger(dbPath);
    try {
      const integrity = ledger.rawDbForTest.prepare('PRAGMA integrity_check').get() as { integrity_check: string } | undefined;
      assert.equal(integrity?.integrity_check, 'ok', '崩溃后库完整性必须为 ok（WAL 自动恢复）');
      for (let i = 0; i < 120; i += 1) {
        const rows = ledger.settlementsOf(`crash-req-${i}`);
        assert.equal(rows.length, 1, `已结算的 crash-req-${i} 崩溃后必须保留恰一行`);
        assert.equal(rows[0]!.clientStatus, 'ok');
      }
      assert.equal(ledger.recover(), 80, '未结算的 80 条请求必须被恰补一次 interrupted');
      assert.equal(ledger.recover(), 0, '重复 recover 必须幂等');
      const recovered = ledger.settlementsOf('crash-req-199');
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0]!.clientStatus, 'interrupted');
      assert.equal(recovered[0]!.errorSource, 'gateway', '恢复补结归因 gateway，绝不冤枉渠道');
      const report = ledger.verifyChain();
      assert.equal(report.ok, true, '崩溃恢复后 hash 链必须仍全通');
      assert.equal(report.checked, 400, '200 请求 +（120 原有 + 80 恢复）结算全部上链');
      assert.deepEqual(report.legacy, { requests: 0, settlements: 0 });
    } finally {
      ledger.close();
    }
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* Windows 句柄兜底：极端情况下句柄未释放，残留临时目录可接受 */
    }
  }
});
