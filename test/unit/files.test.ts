import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeReports, makeFileStamp } from '../../src/report/files.js';
import { buildBaseline } from '../../src/baseline.js';
import type { AuditReport } from '../../src/types.js';

const META = { model: 'gpt-4o', probesetVersion: 'v0.1.0', assetsVersion: 'assets-v0.1.0' };

function sampleReport(): AuditReport {
  return {
    meta: {
      tool: '0.1.0',
      version: 'v0.1.0',
      probesetVersion: 'v0.1.0',
      assetsVersion: 'assets-v0.1.0',
      model: 'gpt-4o',
      baseUrl: 'https://relay.example.com/v1',
      seed: 42,
      startedAt: '2026-01-01T00:00:00Z',
      durationMs: 10,
      nodeVersion: 'v22.0.0',
      claimedContext: null,
    },
    total: null,
    overall: 'unknown',
    scores: [],
    outcomes: [],
    evidence: [],
    notes: [],
  };
}

test('files: same --baseline-out path is overwritten with complete parseable JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mx-files-'));
  try {
    const out = join(dir, 'reports');
    const baselineOut = join(dir, 'base.json');
    const first = writeReports(sampleReport(), out, 'stamp-1', buildBaseline([], { ...META, seed: 1 }), baselineOut);
    assert.equal(first.baselinePath, baselineOut);
    const second = writeReports(sampleReport(), out, 'stamp-2', buildBaseline([], { ...META, seed: 2 }), baselineOut);
    assert.equal(second.baselinePath, baselineOut);
    // 第二次写入的完整 JSON 必须能整体解析（原子覆盖，不产生半截文件）
    const parsed = JSON.parse(readFileSync(baselineOut, 'utf8')) as { seed: number; version: number };
    assert.equal(parsed.seed, 2);
    assert.equal(parsed.version, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('files: no *.tmp residue after successful writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mx-files-'));
  try {
    const out = join(dir, 'reports');
    writeReports(sampleReport(), out, 'stamp-3', buildBaseline([], { ...META, seed: 3 }), join(dir, 'base.json'));
    const leftovers = [...readdirSync(dir), ...readdirSync(out)].filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- makeFileStamp：文件名主干 = <safeModel>-<YYYY-MM-DD_HH-mm-ss> ----------

test('makeFileStamp: fixed local Date produces <model>-<YYYY-MM-DD_HH-mm-ss> with zero padding', () => {
  // 用本地时间构造器注入固定 Date，避免绝对时区值断言（本地构造 + 本地取段自洽）
  const stamp = makeFileStamp(new Date(2026, 0, 2, 3, 4, 5), 'gpt-4o');
  assert.equal(stamp, 'gpt-4o-2026-01-02_03-04-05');
  const general = makeFileStamp(new Date(2026, 10, 12, 23, 59, 9), 'glm-5.3-flash');
  assert.equal(general, 'glm-5.3-flash-2026-11-12_23-59-09');
});

test('makeFileStamp: output always matches <safe>-<date>_<time> shape for arbitrary models', () => {
  const stamp = makeFileStamp(new Date(2026, 4, 17, 8, 9, 10), 'z-ai/glm 5.3 flash!');
  assert.match(stamp, /^[A-Za-z0-9._-]+-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);
});

test('makeFileStamp: sanitizes illegal characters (spaces/slashes/CJK collapse to single -)', () => {
  const fixed = new Date(2000, 0, 1, 0, 0, 0);
  const base = '2000-01-01_00-00-00';
  assert.equal(makeFileStamp(fixed, 'GLM 5.3/flash (proxy)').replace(base, ''), 'GLM-5.3-flash-proxy-');
  assert.equal(makeFileStamp(fixed, 'a--b').replace(base, ''), 'a-b-');
  assert.equal(makeFileStamp(fixed, '-a-').replace(base, ''), 'a-');
  // 非 ASCII（如中文）整体清洗掉
  assert.equal(makeFileStamp(fixed, '智谱glm-5').replace(base, ''), 'glm-5-');
});

test('makeFileStamp: empty-after-sanitize falls back to unknown', () => {
  const fixed = new Date(2000, 0, 1, 0, 0, 0);
  assert.match(makeFileStamp(fixed, ''), /^unknown-\d{4}-/);
  assert.match(makeFileStamp(fixed, '///'), /^unknown-\d{4}-/);
  assert.match(makeFileStamp(fixed, '智谱'), /^unknown-\d{4}-/);
});

test('makeFileStamp: model name longer than 48 chars is truncated', () => {
  const fixed = new Date(2000, 0, 1, 0, 0, 0);
  const stamp = makeFileStamp(fixed, 'a'.repeat(100));
  // 主干 = 48 字符模型名 + '-' + 19 字符时间
  assert.equal(stamp.length, 48 + 1 + 19);
  assert.ok(stamp.startsWith('a'.repeat(48) + '-2000-01-01_00-00-00'));
});

test('makeFileStamp: truncation never leaves a trailing - or .', () => {
  const fixed = new Date(2000, 0, 1, 0, 0, 0);
  // 截断点（第 48 字符）落在 '-' 上：截断后必须再去尾，避免 stem 以 '-' 结尾
  const stamp = makeFileStamp(fixed, 'x'.repeat(47) + '-y');
  assert.match(stamp, /^x{47}-2000-01-01_00-00-00$/);
});
