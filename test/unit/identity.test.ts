import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeIdentity } from '../../src/probes/identity.js';
import { createEvidenceRecorder } from '../../src/evidence.js';
import { createRng } from '../../src/random.js';
import type { ChatRequest, ChatResult, OpenAIClient, ProbeCtx, RunConfig } from '../../src/types.js';

function starvedResult(text: string): ChatResult {
  return {
    ok: true,
    status: 200,
    finishReason: 'length',
    text,
    reasoning: null,
    usage: { prompt_tokens: 10, completion_tokens: 512, total_tokens: 522 },
    usageRejected: null,
    attempts: 1,
    toolCalls: [],
    ttftMs: null,
    durationMs: 1,
    error: null,
    raw: '',
  };
}

function okResult(text: string): ChatResult {
  return {
    ok: true,
    status: 200,
    finishReason: 'stop',
    text,
    reasoning: null,
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    usageRejected: null,
    attempts: 1,
    toolCalls: [],
    ttftMs: null,
    durationMs: 1,
    error: null,
    raw: '',
  };
}

/** 覆盖两个 SCHEMA_PROBES 全部键的超集 JSON，避免测试依赖 rng 选中哪个 schema 探针。 */
const COMPLETE_SCHEMA_JSON = '{"model_family": "gpt", "language_count": 9, "self_name": "gpt-4o", "context_window": 128000}';

function stubClient(results: ChatResult[]): { client: OpenAIClient; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const queue = [...results];
  return {
    requests,
    client: {
      baseUrl: 'http://127.0.0.1:0/v1',
      async chat(req: ChatRequest): Promise<ChatResult> {
        requests.push(req);
        const next = queue.shift();
        if (!next) throw new Error('stub client: no queued result');
        return next;
      },
    },
  };
}

function makeCtx(client: OpenAIClient): ProbeCtx {
  const cfg: RunConfig = {
    baseUrl: 'http://127.0.0.1:0/v1',
    apiKey: 'k',
    model: 'gpt-4o',
    claimedContext: null,
    expect: [],
    deep: false,
    seed: 1,
    timeoutMs: 1000,
    retries: 0,
    outDir: 'reports',
    html: false,
    yes: true,
    quiet: true,
  };
  return { client, cfg, rng: createRng(1), evidence: createEvidenceRecorder() };
}

test('identity: self-id fully starved (non-empty truncation) → insufficient, no template/identical accusation', async () => {
  // 3 次自述全部返回相同截断文本；若 starved 样本被计入统计，会被误判「逐字一致（模板特判）」
  const { client, requests } = stubClient([
    starvedResult('{"a":'),
    starvedResult('{"a":'),
    starvedResult('{"a":'),
    okResult(COMPLETE_SCHEMA_JSON),
  ]);
  const ctx = makeCtx(client);
  const outcome = await probeIdentity(ctx);
  assert.equal(requests.length, 4);
  assert.ok(requests.every((r) => r.max_tokens === 512), 'self-id 与 schema 预算均为 512');
  assert.equal(outcome.status, 'insufficient');
  assert.equal(outcome.score, null);
  assert.equal(outcome.level, 'unknown');
  assert.match(outcome.headline, /推理占满预算/);
  assert.ok(!outcome.findings.some((f) => /逐字一致/.test(f.message)), JSON.stringify(outcome.findings));
  assert.ok(!outcome.findings.some((f) => f.level === 'fail'));
  assert.equal(outcome.metrics['starved_samples'], 3);
});

test('identity: partial starvation — starved samples excluded from identical stats (invalid samples)', async () => {
  // 2 个有效样本逐字一致 + 1 个 starved 相同截断文本：
  // 若 starved 计入 → nonEmpty=3 全等 → identicalPairs=2 且 samples=3 → 误出「模板特判」WARN -30；
  // 正确行为：starved 无效 → comparable=2 → pairs=1 → 不触发。
  const { client } = stubClient([
    okResult('I am gpt-4o, made by OpenAI.'),
    okResult('I am gpt-4o, made by OpenAI.'),
    starvedResult('{"a":'),
    okResult(COMPLETE_SCHEMA_JSON),
  ]);
  const ctx = makeCtx(client);
  const outcome = await probeIdentity(ctx);
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.score, 100);
  assert.equal(outcome.level, 'pass');
  assert.equal(outcome.metrics['samples'], 2);
  assert.equal(outcome.metrics['identical_samples'], 1);
  assert.equal(outcome.metrics['starved_samples'], 1);
  assert.ok(!outcome.findings.some((f) => /逐字一致/.test(f.message)), JSON.stringify(outcome.findings));
  assert.ok(outcome.findings.some((f) => /推理占满预算/.test(f.message) && f.level === 'info'));
});

test('identity: schema probe starved → no deduction, no gateway-rewrite WARN, metric N/A', async () => {
  const { client } = stubClient([
    okResult('I am gpt-4o, made by OpenAI.'),
    okResult('I am gpt-4o by OpenAI.'),
    okResult("I'm gpt-4o (OpenAI)."),
    starvedResult('{"model_family": "gp'), // 非空截断 JSON
  ]);
  const ctx = makeCtx(client);
  const outcome = await probeIdentity(ctx);
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.score, 100);
  assert.equal(outcome.level, 'pass');
  assert.equal(outcome.metrics['schema_compliant'], 'N/A');
  assert.ok(!outcome.findings.some((f) => /网关可能重写响应/.test(f.message)), JSON.stringify(outcome.findings));
  assert.ok(outcome.findings.some((f) => /预算不足无法判定格式合规/.test(f.message)));
});
