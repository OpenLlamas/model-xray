import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI_PATH = fileURLToPath(new URL('../../src/cli.js', import.meta.url));

function runCli(args: string[]): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      windowsHide: true,
      env: {
        ...process.env,
        MODEL_XRAY_KEY: '',
        OPENAI_API_KEY: '',
        MODEL_XRAY_REFERENCE_KEY: '',
      },
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('close', (status) => resolve({ status, stderr }));
    child.on('error', (error) => resolve({ status: -1, stderr: String(error) }));
  });
}

const baseArgs = [
  'test',
  '--base-url',
  'https://main.example.com/v1',
  '--model',
  'gpt-4o',
];

test('CLI reference: key/model flags require a reference base URL', async () => {
  for (const flag of ['--reference-api-key', '--reference-model']) {
    const result = await runCli([...baseArgs, '--dry-run', flag, 'ref-value']);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /reference-base-url/);
  }
});

test('CLI reference: malformed URL is rejected before any request', async () => {
  const result = await runCli([
    ...baseArgs,
    '--dry-run',
    '--reference-base-url',
    'not-a-url',
    '--reference-model',
    'gpt-4o',
  ]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /不是合法 URL/);
});

test('CLI reference: dry-run accepts a reference endpoint without a reference key', async () => {
  const result = await runCli([
    ...baseArgs,
    '--dry-run',
    '--reference-base-url',
    'https://reference.example.com/v1',
    '--reference-model',
    'gpt-4o',
  ]);
  assert.equal(result.status, 0, result.stderr);
});

test('CLI reference: a real run requires a reference key when a reference URL is set', async () => {
  const result = await runCli([
    ...baseArgs,
    '--key',
    'main-key',
    '--reference-base-url',
    'https://reference.example.com/v1',
    '--reference-model',
    'gpt-4o',
  ]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /缺少参考端点 API key/);
});
