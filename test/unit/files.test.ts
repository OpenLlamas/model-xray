import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeReports } from '../../src/report/files.js';
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