import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JournalWriter, isSensitiveFieldName, redactEntry, type JournalEntry, type RequestEntry, type ScoreEntry } from '../../src/guard/journal.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'guard-journal-'));
}

function baseRequestEntry(id: string): RequestEntry {
  return {
    type: 'request',
    ts: '2026-01-01T00:00:00.000Z',
    id,
    method: 'POST',
    path: '/v1/chat/completions',
    status: 200,
    stream: true,
    deepInspect: true,
    modelReq: 'gpt-4o',
    modelResp: 'gpt-4o',
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    usageRejected: null,
    finishReason: 'stop',
    ttftMs: 5,
    durationMs: 50,
    bytesUp: 100,
    bytesDown: 200,
    aborted: false,
    errors: [],
  };
}

function readAllLines(dir: string): string[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
  const lines: string[] = [];
  for (const file of files) {
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (line.length > 0) lines.push(line);
    }
  }
  return lines;
}

test('journal：按日轮转命名 guard-YYYYMMDD.jsonl，同 writer 跨天写入新文件', async () => {
  const dir = makeTempDir();
  try {
    let current = new Date('2026-01-01T23:59:59');
    const writer = new JournalWriter(dir, { now: () => current });
    writer.append(baseRequestEntry('1'));
    await writer.flush();
    assert.equal(writer.path, join(dir, 'guard-20260101.jsonl'));

    current = new Date('2026-01-02T00:00:01');
    writer.append(baseRequestEntry('2'));
    await writer.flush();
    assert.equal(writer.path, join(dir, 'guard-20260102.jsonl'));
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort(), ['guard-20260101.jsonl', 'guard-20260102.jsonl']);

    const day1 = readFileSync(join(dir, 'guard-20260101.jsonl'), 'utf8').trim().split('\n');
    const day2 = readFileSync(join(dir, 'guard-20260102.jsonl'), 'utf8').trim().split('\n');
    assert.equal(day1.length, 1);
    assert.equal(day2.length, 1);
    assert.equal((JSON.parse(day1[0] ?? '') as RequestEntry).id, '1');
    assert.equal((JSON.parse(day2[0] ?? '') as RequestEntry).id, '2');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('journal：串行链保序 + 每行独立 catch（单行失败不断链、不抛出）', async () => {
  const dir = makeTempDir();
  const errors: string[] = [];
  try {
    let current = new Date('2026-02-01T10:00:00');
    const writer = new JournalWriter(dir, { now: () => current, onError: (message) => errors.push(message) });
    writer.append(baseRequestEntry('a'));
    await writer.flush();

    // 让第二天的写入目标变成目录 → appendFile 必然失败（EISDIR）
    current = new Date('2026-02-02T10:00:00');
    mkdirSync(join(dir, 'guard-20260202.jsonl'));
    writer.append(baseRequestEntry('b'));
    await writer.flush();
    assert.equal(errors.length, 1, '应捕获一次写入失败');
    assert.match(errors[0] ?? '', /写入失败/);

    // 移除目录后同一串行链继续工作（链未被失败打断）
    rmSync(join(dir, 'guard-20260202.jsonl'), { recursive: true, force: true });
    writer.append(baseRequestEntry('c'));
    writer.append(baseRequestEntry('d'));
    await writer.flush();
    const day2 = readFileSync(join(dir, 'guard-20260202.jsonl'), 'utf8').trim().split('\n');
    assert.equal(day2.length, 2);
    assert.equal((JSON.parse(day2[0] ?? '') as RequestEntry).id, 'c');
    assert.equal((JSON.parse(day2[1] ?? '') as RequestEntry).id, 'd');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('journal：脱敏——凭证与 query 字段剔除，token 计数字段保留', async () => {
  const dir = makeTempDir();
  try {
    const writer = new JournalWriter(dir);
    const poisoned = {
      ...baseRequestEntry('x'),
      authorization: 'Bearer sk-SECRETKEY',
      'proxy-authorization': 'Basic attacker',
      query: 'api-key=sk-QUERYKEY',
      nested: { apiKey: 'sk-NESTED', secret: 's3cret', access_token: 'tok-MARKER', total_tokens: 42 },
      weird: [{ api_key: 'k', keepme: 'yes' }],
    } as unknown as JournalEntry;
    writer.append(poisoned);
    await writer.flush();

    const file = join(dir, readdirSync(dir)[0] ?? '');
    const text = readFileSync(file, 'utf8');
    assert.ok(!text.includes('sk-SECRETKEY'), '不得出现 Authorization 值');
    assert.ok(!text.includes('attacker'), '不得出现 Proxy-Authorization 值');
    assert.ok(!text.includes('sk-QUERYKEY'), '不得出现 query 值');
    assert.ok(!text.includes('sk-NESTED'), '不得出现嵌套 apiKey');
    assert.ok(!text.includes('s3cret'), '不得出现 secret');
    assert.ok(!text.includes('tok-MARKER'), '不得出现 access_token 值');
    assert.ok(!/authorization/i.test(text), 'authorization 字段应整键剔除');
    assert.ok(text.includes('"total_tokens":42'), 'usage token 计数字段必须保留（不得过度脱敏）');
    assert.ok(text.includes('keepme'), '无关字段保留');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('journal：文件创建即 0600（Windows best-effort，仅 POSIX 断言权限位）', async () => {
  const dir = makeTempDir();
  try {
    const writer = new JournalWriter(dir);
    writer.append(baseRequestEntry('perm'));
    await writer.flush();
    const file = join(dir, readdirSync(dir)[0] ?? '');
    assert.ok(existsSync(file));
    if (process.platform !== 'win32') {
      const mode = statSync(file).mode & 0o777;
      assert.equal(mode, 0o600, `文件权限应为 0600，实际 ${mode.toString(8)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('journal：isSensitiveFieldName 精确边界（不误伤 prompt_tokens/completion_tokens）', () => {
  for (const name of ['authorization', 'Authorization', 'proxy-authorization', 'api-key', 'apiKey', 'api_key', 'x-api-key', 'key', 'token', 'access_token', 'secret', 'password', 'cookie', 'credential', 'query']) {
    assert.ok(isSensitiveFieldName(name), `${name} 应判为敏感`);
  }
  for (const name of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'usage', 'path', 'status', 'monkey', 'tokenizer']) {
    assert.ok(!isSensitiveFieldName(name), `${name} 不应判为敏感`);
  }
});

test('journal：构造目录失败时构造器抛错（由 CLI 转 exit 2）', () => {
  const dir = makeTempDir();
  try {
    const blocker = join(dir, 'blocker.txt');
    writeFileSync(blocker, 'not a dir');
    assert.throws(() => new JournalWriter(join(blocker, 'sub')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('journal：脱敏对 score 条目零删改（键名均非敏感，JSON 原样落盘）', async () => {
  const entry: ScoreEntry = {
    type: 'score',
    ts: '2026-01-01T00:00:00.000Z',
    fromId: '41',
    toId: '60',
    requests: 20,
    dims: [
      { id: 'availability', score: 100, level: 'ok' },
      { id: 'billing', score: 100, level: 'ok' },
      { id: 'identity', score: 95, level: 'ok' },
      { id: 'latency', score: 85, level: 'warn' },
      { id: 'cost', score: null, level: 'na' },
    ],
    observed: { finishLengthRate: 0.12, usageMissing: 2, aborted: 0 },
    overall: { score: 85, level: 'warn' },
  };
  assert.deepEqual(redactEntry(entry), entry, 'redactEntry 不得删除/改写 score 条目任何键');

  const dir = makeTempDir();
  try {
    const writer = new JournalWriter(dir);
    writer.append(entry);
    await writer.flush();
    const file = join(dir, readdirSync(dir).filter((f) => f.endsWith('.jsonl'))[0] ?? '');
    const parsed = JSON.parse(readFileSync(file, 'utf8').trim()) as ScoreEntry;
    assert.deepEqual(parsed, entry);
    assert.deepEqual(Object.keys(parsed).sort(), Object.keys(entry).sort(), '键集不变');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
