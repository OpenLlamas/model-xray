import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decideTokenReference,
  loadTokenReference,
  type TokenReference,
} from '../../src/token-reference.js';

const TARGET = { model: 'gpt-4o', probesetVersion: 'v0.2.2' };

function reference(promptTokens: Record<string, number>, overrides: Partial<TokenReference> = {}): TokenReference {
  return {
    sourceFile: 'reports/gpt-4o-2026-01-01_00-00-00.json',
    model: 'gpt-4o',
    probesetVersion: 'v0.2.2',
    baseUrl: 'https://relay.example.com/v1',
    startedAt: '2026-01-01T00:00:00.000Z',
    promptTokens,
    ...overrides,
  };
}

/**
 * 构造 ref 基准值 100·2^i 的档位表 + 按倍率（整数化，避免浮点边界假阳性）生成的 current 表。
 * ratio 传数组时逐档指定（不足处复用最后一个值），传数字时全档同倍率。
 */
function pairTables(
  ratioEn: number | number[],
  ratioZh: number | number[],
  levels = 5,
): { ref: TokenReference; current: Record<string, number> } {
  const promptTokens: Record<string, number> = {};
  const current: Record<string, number> = {};
  const enRatios = Array.isArray(ratioEn) ? ratioEn : Array.from({ length: levels }, () => ratioEn);
  const zhRatios = Array.isArray(ratioZh) ? ratioZh : Array.from({ length: levels }, () => ratioZh);
  for (let i = 0; i < levels; i++) {
    const base = 100 * 2 ** i;
    const enRatio = enRatios[i] ?? (enRatios.at(-1) as number);
    const zhRatio = zhRatios[i] ?? (zhRatios.at(-1) as number);
    promptTokens[`en_${2000 + i}`] = base;
    current[`en_${2000 + i}`] = Math.round(base * enRatio);
    promptTokens[`zh_${2000 + i}`] = base;
    current[`zh_${2000 + i}`] = Math.round(base * zhRatio);
  }
  return { ref: reference(promptTokens), current };
}

function withTempFile(content: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'mx-token-ref-'));
  try {
    const path = join(dir, 'ref.json');
    writeFileSync(path, content);
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const MINIMAL_REPORT = JSON.stringify({
  meta: { model: 'gpt-4o', probesetVersion: 'v0.2.2', baseUrl: 'https://relay.example.com/v1', startedAt: '2026-01-01T00:00:00.000Z' },
  outcomes: [{ id: 'billing', metrics: { prompt_tokens_en_2000: 100, prompt_tokens_zh_2000: 110, requests: 10 } }],
});

// --- loader ---

test('token-reference loader: minimal valid report loads with normalized keys', () => {
  withTempFile(MINIMAL_REPORT, (path) => {
    const ref = loadTokenReference(path);
    assert.equal(ref.model, 'gpt-4o');
    assert.equal(ref.probesetVersion, 'v0.2.2');
    assert.deepEqual(ref.promptTokens, { en_2000: 100, zh_2000: 110 });
    assert.equal(ref.sourceFile, path);
  });
});

test('token-reference loader: bad JSON reports parse failure', () => {
  withTempFile('{ not json', (path) => {
    assert.throws(() => loadTokenReference(path), /参考报告不是合法 JSON/);
  });
});

test('token-reference loader: missing file reports unreadable path with the received value', () => {
  const missing = join(tmpdir(), 'mx-token-ref-missing', 'nope.json');
  assert.throws(() => loadTokenReference(missing), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /无法读取参考报告/);
    assert.ok(error.message.includes(missing));
    return true;
  });
});

test('token-reference loader: missing meta.model reports field path', () => {
  const broken = JSON.stringify({
    meta: { probesetVersion: 'v0.2.2', baseUrl: 'u', startedAt: 't' },
    outcomes: [{ id: 'billing', metrics: { prompt_tokens_en_2000: 1 } }],
  });
  withTempFile(broken, (path) => {
    assert.throws(() => loadTokenReference(path), /字段 meta\.model 缺失或不合法/);
  });
});

test('token-reference loader: missing outcomes array reports field path', () => {
  const broken = JSON.stringify({ meta: { model: 'm', probesetVersion: 'v', baseUrl: 'u', startedAt: 't' } });
  withTempFile(broken, (path) => {
    assert.throws(() => loadTokenReference(path), /字段 outcomes 缺失或不是数组/);
  });
});

test('token-reference loader: no billing outcome reports missing probe result', () => {
  const broken = JSON.stringify({
    meta: { model: 'm', probesetVersion: 'v', baseUrl: 'u', startedAt: 't' },
    outcomes: [{ id: 'identity', metrics: {} }],
  });
  withTempFile(broken, (path) => {
    assert.throws(() => loadTokenReference(path), /参考报告缺少 billing 探针结果/);
  });
});

test('token-reference loader: billing outcome without prompt_tokens samples reports missing samples', () => {
  const broken = JSON.stringify({
    meta: { model: 'm', probesetVersion: 'v', baseUrl: 'u', startedAt: 't' },
    outcomes: [{ id: 'billing', metrics: { requests: 10, slope_en: 1.01 } }],
  });
  withTempFile(broken, (path) => {
    assert.throws(() => loadTokenReference(path), /参考报告的 billing\.metrics 中未找到 prompt_tokens_\* 样本/);
  });
});

// --- decide: 阈值带（无灰区） ---

test('token-reference decide: ratio 1.3 everywhere → fail, cap 30, high-side message', () => {
  const { ref, current } = pairTables(1.3, 1.3);
  const decision = decideTokenReference(ref, current, TARGET);
  assert.equal(decision.verdict, 'fail');
  assert.equal(decision.cap, 30);
  assert.equal(decision.finding?.level, 'fail');
  assert.match(decision.finding?.message ?? '', /token 计数与参考报告系统偏离/);
  assert.match(decision.finding?.message ?? '', /×1\.3/);
  assert.match(decision.finding?.message ?? '', /参考：gpt-4o-2026-01-01_00-00-00\.json/);
  assert.equal(decision.summary['en']?.levels, 5);
});

test('token-reference decide: ratio 1.15 → warn, cap 70', () => {
  const { ref, current } = pairTables(1.15, 1.15);
  const decision = decideTokenReference(ref, current, TARGET);
  assert.equal(decision.verdict, 'warn');
  assert.equal(decision.cap, 70);
  assert.match(decision.finding?.message ?? '', /偏离：en 档位比值 1\.15~1\.15（>1\.1 或 <0\.8）/);
});

test('token-reference decide: ratio 1.0 → ok, no cap', () => {
  const { ref, current } = pairTables(1.0, 1.0);
  const decision = decideTokenReference(ref, current, TARGET);
  assert.equal(decision.verdict, 'ok');
  assert.equal(decision.cap, null);
  assert.match(decision.finding?.message ?? '', /token 计数与参考报告一致（en\/zh 10 档/);
});

test('token-reference decide: boundary 1.1 stays ok, 1.25 stays warn (spec bands are half-open)', () => {
  const okTable = pairTables(1.1, 1.1);
  const okCase = decideTokenReference(okTable.ref, okTable.current, TARGET);
  assert.equal(okCase.verdict, 'ok', String(okCase.finding?.message));
  const warnTable = pairTables(1.25, 1.25);
  const warnCase = decideTokenReference(warnTable.ref, warnTable.current, TARGET);
  assert.equal(warnCase.verdict, 'warn');
  assert.equal(warnCase.cap, 70);
});

test('token-reference decide: low-side 0.75 / 0.6 → warn never fail', () => {
  const lowTable = pairTables(0.75, 0.75);
  const low = decideTokenReference(lowTable.ref, lowTable.current, TARGET);
  assert.equal(low.verdict, 'warn');
  assert.equal(low.cap, 70);
  const lowerTable = pairTables(0.6, 0.6);
  const lower = decideTokenReference(lowerTable.ref, lowerTable.current, TARGET);
  assert.equal(lower.verdict, 'warn', '低报方向不得判 fail');
});

test('token-reference decide: median is display-only, worst tier drives the verdict', () => {
  // [0.9, 0.9, 1.3]：中位 0.9（显示值在带内），但最高档 1.3 必须定 fail
  const { ref, current } = pairTables([0.9, 0.9, 1.3], [0.9, 0.9, 1.3], 3);
  const decision = decideTokenReference(ref, current, TARGET);
  assert.equal(decision.verdict, 'fail');
  assert.equal(decision.cap, 30);
  assert.equal(decision.summary['en']?.median, 0.9);
  assert.equal(decision.summary['en']?.max, 1.3);
});

test('token-reference decide: mixed en fail + zh ok → overall fail with maxRatio from the worst lang', () => {
  const { ref, current } = pairTables(1.4, 1.0);
  const decision = decideTokenReference(ref, current, TARGET);
  assert.equal(decision.verdict, 'fail');
  assert.equal(decision.maxRatio, 1.4);
  assert.match(decision.finding?.message ?? '', /^token 计数与参考报告系统偏离：en /);
});

test('token-reference decide: model mismatch → skip without verdict', () => {
  const { ref, current } = pairTables(1.3, 1.3);
  const decision = decideTokenReference(ref, current, { model: 'glm-4.6', probesetVersion: 'v0.2.2' });
  assert.equal(decision.verdict, 'skip');
  assert.equal(decision.cap, null);
  assert.match(decision.finding?.message ?? '', /参考报告模型（gpt-4o）与本次（glm-4\.6）不一致/);
});

test('token-reference decide: probeset version mismatch → skip', () => {
  const { ref, current } = pairTables(1.3, 1.3);
  const decision = decideTokenReference(ref, current, { model: 'gpt-4o', probesetVersion: 'v0.2.1' });
  assert.equal(decision.verdict, 'skip');
  assert.match(decision.finding?.message ?? '', /参考报告题集版本（v0\.2\.2）与本次（v0\.2\.1）不一致/);
});

test('token-reference decide: fewer than 3 comparable tiers per language → skip with counts', () => {
  const { ref, current } = pairTables(1.3, 1.3, 2);
  const decision = decideTokenReference(ref, current, TARGET);
  assert.equal(decision.verdict, 'skip');
  assert.match(decision.finding?.message ?? '', /参考可比档位不足（en 2\/3、zh 2\/3）/);
  assert.equal(decision.summary['en']?.levels, 2);
});

test('token-reference decide: one language ok + other skipped → verdict follows the comparable language', () => {
  const { ref, current } = pairTables(1.0, 1.0, 5);
  for (const key of Object.keys(current)) {
    if (key.startsWith('zh_')) delete current[key];
  }
  const decision = decideTokenReference(ref, current, TARGET);
  assert.equal(decision.verdict, 'ok');
  assert.equal(decision.summary['zh']?.levels, 0);
  assert.match(decision.finding?.message ?? '', /token 计数与参考报告一致（en 5 档/);
});

test('token-reference decide: non-finite/zero current values are excluded per key', () => {
  const { ref, current } = pairTables(1.3, 1.3, 5);
  current['en_2000'] = 0;
  current['en_2001'] = Number.NaN;
  const decision = decideTokenReference(ref, current, TARGET);
  assert.equal(decision.summary['en']?.levels, 3, '两档剔除后仅剩 3 档可比');
  assert.equal(decision.verdict, 'fail');
});

test('token-reference decide: stale reference (>180d) appends tokenizer drift note on ok', () => {
  const { ref, current } = pairTables(1.0, 1.0);
  ref.startedAt = '2025-01-01T00:00:00.000Z';
  const decision = decideTokenReference(ref, current, TARGET);
  assert.equal(decision.verdict, 'ok');
  assert.match(decision.finding?.message ?? '', /超过 180 天/);
  // 新鲜参考不得出现该提示
  const fresh = decideTokenReference(
    { ...ref, startedAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString() },
    current,
    TARGET,
  );
  assert.ok(!(fresh.finding?.message ?? '').includes('超过 180 天'));
});

// --- loader 稳健性补测（形状校验全覆盖） ---

test('token-reference loader: root not an object (array/null/number) → meta field error', () => {
  for (const raw of ['[1,2]', 'null', '42', '"str"']) {
    withTempFile(raw, (path) => {
      assert.throws(() => loadTokenReference(path), /字段 meta 缺失或不合法/, `root=${raw}`);
    });
  }
});

test('token-reference loader: meta not an object → meta field error', () => {
  withTempFile(JSON.stringify({ meta: 'x', outcomes: [] }), (path) => {
    assert.throws(() => loadTokenReference(path), /字段 meta 缺失或不合法/);
  });
});

test('token-reference loader: every required meta field is validated with its own path (incl. empty string)', () => {
  const meta: Record<string, string> = { model: 'gpt-4o', probesetVersion: 'v0.2.2', baseUrl: 'u', startedAt: 't' };
  for (const field of ['model', 'probesetVersion', 'baseUrl', 'startedAt'] as const) {
    const broken: Record<string, string> = { ...meta };
    delete broken[field];
    withTempFile(JSON.stringify({ meta: broken, outcomes: [{ id: 'billing', metrics: { prompt_tokens_en_2000: 1 } }] }), (path) => {
      assert.throws(() => loadTokenReference(path), new RegExp(`字段 meta\\.${field} 缺失或不合法`), `missing ${field}`);
    });
  }
  withTempFile(
    JSON.stringify({ meta: { ...meta, startedAt: '' }, outcomes: [{ id: 'billing', metrics: { prompt_tokens_en_2000: 1 } }] }),
    (path) => {
      assert.throws(() => loadTokenReference(path), /字段 meta\.startedAt 缺失或不合法/);
    },
  );
});

test('token-reference loader: invalid/non-number/foreign keys are dropped, only finite positive en/zh samples survive', () => {
  const report = JSON.stringify({
    meta: { model: 'gpt-4o', probesetVersion: 'v0.2.2', baseUrl: 'u', startedAt: 't' },
    outcomes: [
      {
        id: 'billing',
        metrics: {
          prompt_tokens_en_2000: -5,
          prompt_tokens_en_4000: 0,
          prompt_tokens_en_8000: '100',
          prompt_tokens_en_16000: 50,
          prompt_tokens_zh_2000: null,
          prompt_tokens_fr_2000: 77,
          prompt_tokens_zh_abc: 9,
          requests: 10,
        },
      },
    ],
  });
  withTempFile(report, (path) => {
    const ref = loadTokenReference(path);
    assert.deepEqual(ref.promptTokens, { en_16000: 50 });
  });
});

test('token-reference loader: all samples invalid → missing samples error (no silent empty reference)', () => {
  const report = JSON.stringify({
    meta: { model: 'm', probesetVersion: 'v', baseUrl: 'u', startedAt: 't' },
    outcomes: [{ id: 'billing', metrics: { prompt_tokens_en_2000: 0, prompt_tokens_zh_2000: 'x' } }],
  });
  withTempFile(report, (path) => {
    assert.throws(() => loadTokenReference(path), /未找到 prompt_tokens_\* 样本/);
  });
});

// --- decide 语言选择与退化输入补测 ---

test('token-reference decide: en ok + zh warn → overall warn driven by zh (worst-lang rule)', () => {
  const { ref, current } = pairTables(1.0, 1.15);
  const decision = decideTokenReference(ref, current, TARGET);
  assert.equal(decision.verdict, 'warn');
  assert.equal(decision.cap, 70);
  assert.match(decision.finding?.message ?? '', /偏离：zh /);
});

test('token-reference decide: same verdict in both langs → higher-max language wins the report text', () => {
  const { ref, current } = pairTables(1.15, 1.2);
  const decision = decideTokenReference(ref, current, TARGET);
  assert.equal(decision.verdict, 'warn');
  assert.match(decision.finding?.message ?? '', /偏离：zh 档位比值 1\.2~1\.2/);
});

test('token-reference decide: zero ref value is excluded per key (decide double-checks what the loader guarantees)', () => {
  const { ref, current } = pairTables(1.0, 1.0);
  ref.promptTokens['en_2000'] = 0;
  const decision = decideTokenReference(ref, current, TARGET);
  assert.equal(decision.summary['en']?.levels, 4);
  assert.equal(decision.verdict, 'ok');
});

test('token-reference decide: unparseable startedAt does not crash and adds no stale note', () => {
  const { ref, current } = pairTables(1.0, 1.0);
  ref.startedAt = 'not-a-date';
  const decision = decideTokenReference(ref, current, TARGET);
  assert.equal(decision.verdict, 'ok');
  assert.ok(!(decision.finding?.message ?? '').includes('超过 180 天'));
});

test('token-reference decide: stale drift note only annotates ok verdicts, never fail/warn messages', () => {
  const old = '2025-01-01T00:00:00.000Z';
  const failTable = pairTables(1.3, 1.3);
  failTable.ref.startedAt = old;
  const failCase = decideTokenReference(failTable.ref, failTable.current, TARGET);
  assert.equal(failCase.verdict, 'fail');
  assert.ok(!(failCase.finding?.message ?? '').includes('超过 180 天'));

  const warnTable = pairTables(1.15, 1.15);
  warnTable.ref.startedAt = old;
  const warnCase = decideTokenReference(warnTable.ref, warnTable.current, TARGET);
  assert.equal(warnCase.verdict, 'warn');
  assert.ok(!(warnCase.finding?.message ?? '').includes('超过 180 天'));
});
