import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockServer } from './mock-server.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

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
    assert.ok(files.some((f) => f.endsWith('.json')), files.join(','));
    const mdName = files.find((f) => f.endsWith('.md')) as string;
    const md = readFileSync(join(out, mdName), 'utf8');
    assert.ok(md.includes('model-xray'));
    assert.ok(!md.includes('sk-TESTSECRET'));
    const json = JSON.parse(readFileSync(join(out, files.find((f) => f.endsWith('.json')) as string), 'utf8')) as {
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
