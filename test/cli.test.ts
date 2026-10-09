import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockServer } from './mock-server.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

const REMOTE_ARGS = ['test', '--base-url', 'https://relay.example.com/v1', '--key', 'k', '--model', 'gpt-4o'];

function runCli(args: string[], timeoutMs = 120000): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI timeout.\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test('cli: missing required args exits 2 with usage', async () => {
  const result = await runCli(['test', '--model', 'gpt-4o']);
  assert.equal(result.status, 2);
  assert.ok(result.stderr.includes('--base-url'));
});

test('cli: unknown command exits 2', async () => {
  const result = await runCli(['frobnicate']);
  assert.equal(result.status, 2);
});

test('cli: --help exits 0', async () => {
  const result = await runCli(['--help']);
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes('model-xray'));
});

test('cli: --dry-run sends no requests', async () => {
  const mock = await createMockServer({ mode: 'honest' });
  try {
    const result = await runCli([
      'test',
      '--base-url',
      mock.baseUrl,
      '--key',
      'k',
      '--model',
      'gpt-4o',
      '--dry-run',
      '--seed',
      '5',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(mock.state.served, 0);
  } finally {
    mock.server.close();
  }
});

test('cli: honest endpoint exits 0 and writes md/html/json reports', async () => {
  const mock = await createMockServer({ mode: 'honest' });
  const out = mkdtempSync(join(tmpdir(), 'model-xray-'));
  try {
    const result = await runCli([
      'test',
      '--base-url',
      mock.baseUrl,
      '--key',
      'sk-TESTSECRET',
      '--model',
      'gpt-4o',
      '--claimed-context',
      '2000',
      '--seed',
      '11',
      '--out',
      out,
      '--yes',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('总分'));
    const files = readdirSync(out);
    assert.ok(files.some((f) => f.endsWith('.md')), files.join(','));
    assert.ok(files.some((f) => f.endsWith('.html')), files.join(','));
    const reportJsonName = files.find((f) => f.startsWith('report-') && f.endsWith('.json'));
    assert.ok(reportJsonName, files.join(','));
    const baselineName = files.find((f) => f.startsWith('baseline-') && f.endsWith('.json'));
    assert.ok(baselineName, files.join(','));
    const baseline = JSON.parse(readFileSync(join(out, baselineName), 'utf8')) as {
      version: number;
      model: string;
      seed: number;
      identity: { families: string[] } | null;
    };
    assert.equal(baseline.version, 1);
    // 顶层键白名单：基线格式是版本化契约，新增/删除字段必须显式过这一关（配合 version bump）
    assert.deepEqual(
      Object.keys(baseline).sort(),
      [
        'assetsVersion',
        'billing',
        'capability',
        'createdAt',
        'identity',
        'model',
        'probesetVersion',
        'quality',
        'seed',
        'version',
      ],
    );
    assert.equal(baseline.model, 'gpt-4o');
    assert.equal(typeof baseline.seed, 'number');
    assert.ok(baseline.identity !== null && Array.isArray(baseline.identity.families));
    const baselineRaw = readFileSync(join(out, baselineName), 'utf8');
    assert.ok(!baselineRaw.includes('sk-TESTSECRET'));
    assert.ok(!baselineRaw.includes('baseUrl'));
    const mdName = files.find((f) => f.endsWith('.md')) as string;
    const md = readFileSync(join(out, mdName), 'utf8');
    assert.ok(md.includes('model-xray'));
    assert.ok(!md.includes('sk-TESTSECRET'));
    const json = JSON.parse(readFileSync(join(out, reportJsonName), 'utf8')) as {
      evidence: unknown[];
    };
    assert.ok(Array.isArray(json.evidence));
    assert.ok(json.evidence.length > 10);
  } finally {
    mock.server.close();
  }
});

test('cli: relabeled endpoint exits 1', async () => {
  const mock = await createMockServer({ mode: 'relabel' });
  const out = mkdtempSync(join(tmpdir(), 'model-xray-'));
  try {
    const result = await runCli([
      'test',
      '--base-url',
      mock.baseUrl,
      '--key',
      'k',
      '--model',
      'gpt-4o',
      '--seed',
      '13',
      '--out',
      out,
      '--yes',
    ]);
    assert.equal(result.status, 1, result.stderr);
  } finally {
    mock.server.close();
  }
});

// --- WP1 输入严格化：以下用例均须 exit 2 + 明确错误 + 下一步示例，且不得发起任何请求 ---

test('cli: --seed 12abc is rejected as strict integer', async () => {
  const result = await runCli([...REMOTE_ARGS, '--seed', '12abc', '--dry-run']);
  assert.equal(result.status, 2, result.stderr);
  assert.ok(result.stderr.includes('--seed 必须是'), result.stderr);
  assert.ok(result.stderr.includes('12abc'), result.stderr);
  assert.ok(result.stderr.includes('示例'), result.stderr);
});

test('cli: --timeout 0 is rejected (out of range)', async () => {
  const result = await runCli([...REMOTE_ARGS, '--timeout', '0', '--dry-run']);
  assert.equal(result.status, 2, result.stderr);
  assert.ok(result.stderr.includes('--timeout 必须是'), result.stderr);
  assert.ok(result.stderr.includes('示例'), result.stderr);
});

test('cli: --timeout abc is rejected (not an integer)', async () => {
  const result = await runCli([...REMOTE_ARGS, '--timeout', 'abc', '--dry-run']);
  assert.equal(result.status, 2, result.stderr);
  assert.ok(result.stderr.includes('--timeout 必须是'), result.stderr);
  assert.ok(result.stderr.includes('abc'), result.stderr);
});

test('cli: empty --price-input is rejected', async () => {
  const result = await runCli([...REMOTE_ARGS, '--price-input', '', '--price-output', '2', '--dry-run']);
  assert.equal(result.status, 2, result.stderr);
  assert.ok(result.stderr.includes('必须为正数'), result.stderr);
  assert.ok(result.stderr.includes('每百万 tokens 宣称价格'), result.stderr);
});

test('cli: negative --price-input is rejected', async () => {
  const result = await runCli([...REMOTE_ARGS, '--price-input', '-1', '--price-output', '2', '--dry-run']);
  assert.equal(result.status, 2, result.stderr);
  assert.ok(result.stderr.includes('必须为正数'), result.stderr);
  assert.ok(result.stderr.includes('示例'), result.stderr);
});

test('cli: zero --price-input is rejected (non-negative semantics retired)', async () => {
  const result = await runCli([...REMOTE_ARGS, '--price-input', '0', '--price-output', '2', '--dry-run']);
  assert.equal(result.status, 2, result.stderr);
  assert.ok(result.stderr.includes('必须为正数'), result.stderr);
});

test('cli: unknown --expect token lists legal values', async () => {
  const result = await runCli([...REMOTE_ARGS, '--expect', 'foo', '--dry-run']);
  assert.equal(result.status, 2, result.stderr);
  assert.ok(result.stderr.includes('vision'), result.stderr);
  assert.ok(result.stderr.includes('tool'), result.stderr);
  assert.ok(result.stderr.includes('thinking'), result.stderr);
});

test('cli: missing --baseline file fails fast with zero requests served', async () => {
  const mock = await createMockServer({ mode: 'honest' });
  const dir = mkdtempSync(join(tmpdir(), 'model-xray-'));
  try {
    const missing = join(dir, 'does-not-exist.json');
    const result = await runCli([
      'test',
      '--base-url',
      mock.baseUrl,
      '--key',
      'k',
      '--model',
      'gpt-4o',
      '--baseline',
      missing,
      '--yes',
    ]);
    assert.equal(result.status, 2, result.stderr);
    assert.ok(result.stderr.includes('不存在'), result.stderr);
    assert.equal(mock.state.served, 0);
  } finally {
    mock.server.close();
  }
});

test('cli: malformed --baseline fails fast exposing the field path', async () => {
  const mock = await createMockServer({ mode: 'honest' });
  const dir = mkdtempSync(join(tmpdir(), 'model-xray-'));
  try {
    const bad = join(dir, 'bad-baseline.json');
    writeFileSync(
      bad,
      JSON.stringify({
        version: 1,
        model: 'gpt-4o',
        seed: 42,
        createdAt: '2026-01-01T00:00:00Z',
        probesetVersion: 'v0.1.0',
        assetsVersion: 'assets-v0.1.0',
        identity: null,
        quality: { accuracy: 'x', mainCorrect: 1, mainTotal: 2 },
        capability: null,
        billing: null,
      }),
    );
    const result = await runCli([
      'test',
      '--base-url',
      mock.baseUrl,
      '--key',
      'k',
      '--model',
      'gpt-4o',
      '--baseline',
      bad,
      '--yes',
    ]);
    assert.equal(result.status, 2, result.stderr);
    assert.ok(result.stderr.includes('quality.accuracy'), result.stderr);
    assert.equal(mock.state.served, 0);
  } finally {
    mock.server.close();
  }
});
