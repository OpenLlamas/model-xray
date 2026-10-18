import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEvidenceRecorder } from '../../src/evidence.js';
import { createRng } from '../../src/random.js';
import { PROBE_BUDGETS, chatWithStarveRetry, isStarved } from '../../src/probes/starve.js';
import { describeDecoyResponse } from '../../src/runner.js';
import type { ChatRequest, ChatResult, OpenAIClient, ProbeCtx, RunConfig } from '../../src/types.js';

function starvedResult(maxTokens: number, text = ''): ChatResult {
  return {
    ok: true,
    status: 200,
    finishReason: 'length',
    model: null,
    text,
    reasoning: null,
    usage: { prompt_tokens: 10, completion_tokens: maxTokens, total_tokens: 10 + maxTokens },
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
    model: null,
    text,
    reasoning: null,
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    usageRejected: null,
    attempts: 1,
    toolCalls: [],
    ttftMs: null,
    durationMs: 1,
    error: null,
    raw: '',
  };
}

function blankResult(): ChatResult {
  return {
    ok: true,
    status: 200,
    finishReason: null,
    model: null,
    text: '',
    reasoning: null,
    usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
    usageRejected: null,
    attempts: 1,
    toolCalls: [],
    ttftMs: null,
    durationMs: 1,
    error: 'empty stream',
    raw: '',
  };
}

function httpErrorResult(status: number): ChatResult {
  return {
    ok: false,
    status,
    finishReason: null,
    model: null,
    text: '',
    reasoning: null,
    usage: null,
    usageRejected: null,
    attempts: 1,
    toolCalls: [],
    ttftMs: null,
    durationMs: 1,
    error: `HTTP ${status}: rejected`,
    raw: '',
  };
}

function stubClient(results: ChatResult[]): { client: OpenAIClient; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const queue = [...results];
  const client: OpenAIClient = {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(req: ChatRequest): Promise<ChatResult> {
      requests.push(req);
      const next = queue.shift();
      if (!next) throw new Error('stub client: no queued result');
      return next;
    },
  };
  return { client, requests };
}

function makeCtx(client: OpenAIClient): ProbeCtx {
  const cfg: RunConfig = {
    baseUrl: 'http://127.0.0.1:0/v1',
    apiKey: 'k',
    model: 'test-model',
    claimedContext: null,
    expect: [],
    deep: false,
    seed: 1,
    timeoutMs: 1000,
    retries: 0,
    streamFallback: false,
    outDir: 'reports',
    html: false,
    yes: true,
    quiet: true,
  };
  return { client, cfg, rng: createRng(1), evidence: createEvidenceRecorder() };
}

test('isStarved: ok + finish_reason=length captures empty AND non-empty truncated content', () => {
  assert.equal(isStarved(starvedResult(64)), true);
  // 非空截断（半截 JSON）同样是 starvation
  assert.equal(isStarved(starvedResult(64, '{"a":')), true);
  // 正常完成不是 starvation
  assert.equal(isStarved(okResult('done')), false);
  // 请求失败（401/400/传输）即使带 length 语义也不是 starvation（ok=false）
  assert.equal(isStarved(httpErrorResult(401)), false);
});

test('describeDecoyResponse: 200 空响应不得写成「正常」，失败需带错误原因', () => {
  assert.equal(describeDecoyResponse(okResult('')), '为空（HTTP 200，无 content）');
  assert.equal(describeDecoyResponse(starvedResult(120)), '为空/截断（推理占满预算）');
  assert.equal(describeDecoyResponse(httpErrorResult(500)), '失败（HTTP 500: rejected）');
  assert.equal(describeDecoyResponse(okResult('no')), '正常');
});

test('chatWithStarveRetry: starved first call retries once with higher budget, records both calls', async () => {
  const { client, requests } = stubClient([starvedResult(PROBE_BUDGETS.quality), okResult('42')]);
  const ctx = makeCtx(client);
  const call = await chatWithStarveRetry(ctx, {
    probe: 'quality',
    label: 'main mul',
    buildRequest: (maxTokens) => ({ model: ctx.cfg.model, messages: [{ role: 'user', content: 'q' }], temperature: 0, max_tokens: maxTokens }),
    budget: PROBE_BUDGETS.quality,
    retryBudget: PROBE_BUDGETS.qualityRetry,
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.max_tokens, PROBE_BUDGETS.quality);
  assert.equal(requests[1]?.max_tokens, PROBE_BUDGETS.qualityRetry);
  assert.equal(call.retried, true);
  assert.equal(call.starved, false);
  assert.equal(call.result.text, '42');
  // 两次调用都必须进证据；attempts 保持客户端语义（每笔独立请求的实试次数）
  assert.equal(ctx.evidence.size(), 2);
  const [first, second] = ctx.evidence.all();
  assert.equal(first?.request.maxTokens, PROBE_BUDGETS.quality);
  assert.equal(first?.response.finishReason, 'length');
  assert.equal(second?.request.maxTokens, PROBE_BUDGETS.qualityRetry);
  assert.match(second?.label ?? '', /retry@512/);
  assert.equal(second?.response.attempts, 1);
  assert.equal(second?.response.finishReason, 'stop');
});

test('chatWithStarveRetry: non-starved first call makes exactly one request', async () => {
  const { client, requests } = stubClient([okResult('8')]);
  const ctx = makeCtx(client);
  const call = await chatWithStarveRetry(ctx, {
    probe: 'quality',
    label: 'main mod',
    buildRequest: (maxTokens) => ({ model: ctx.cfg.model, messages: [{ role: 'user', content: 'q' }], temperature: 0, max_tokens: maxTokens }),
    budget: PROBE_BUDGETS.quality,
    retryBudget: PROBE_BUDGETS.qualityRetry,
  });
  assert.equal(requests.length, 1);
  assert.equal(call.retried, false);
  assert.equal(call.starved, false);
  assert.equal(ctx.evidence.size(), 1);
});

test('chatWithStarveRetry: 401/400/5xx/transport failures never retry (request-count assertion)', async () => {
  for (const status of [0, 400, 401, 403, 404, 429, 500, 503]) {
    const { client, requests } = stubClient([httpErrorResult(status)]);
    const ctx = makeCtx(client);
    const call = await chatWithStarveRetry(ctx, {
      probe: 'capability',
      label: 'vision color=red',
      buildRequest: (maxTokens) => ({ model: ctx.cfg.model, messages: [{ role: 'user', content: 'q' }], temperature: 0, max_tokens: maxTokens }),
      budget: PROBE_BUDGETS.vision,
      retryBudget: PROBE_BUDGETS.visionRetry,
    });
    assert.equal(requests.length, 1, `status ${status} must not be retried`);
    assert.equal(call.starved, false, `status ${status} must not be starved`);
    assert.equal(ctx.evidence.size(), 1, `status ${status} must record exactly one evidence entry`);
  }
});

test('chatWithStarveRetry: persistent starvation after retry is flagged', async () => {
  const { client, requests } = stubClient([starvedResult(PROBE_BUDGETS.vision), starvedResult(PROBE_BUDGETS.visionRetry, '{"a":')]);
  const ctx = makeCtx(client);
  const call = await chatWithStarveRetry(ctx, {
    probe: 'capability',
    label: 'vision color=red',
    buildRequest: (maxTokens) => ({ model: ctx.cfg.model, messages: [{ role: 'user', content: 'q' }], temperature: 0, max_tokens: maxTokens }),
    budget: PROBE_BUDGETS.vision,
    retryBudget: PROBE_BUDGETS.visionRetry,
  });
  assert.equal(requests.length, 2);
  assert.equal(call.retried, true);
  assert.equal(call.starved, true);
  assert.equal(call.result.finishReason, 'length');
  // 非空截断正文透传，供上层按「证据不足」处理
  assert.equal(call.result.text, '{"a":');
});

test('chatWithStarveRetry: blank first call falls back to stream at retry budget and adopts answer', async () => {
  const { client, requests } = stubClient([blankResult(), okResult('42')]);
  const ctx = makeCtx(client);
  // 默认 true；单测基线为 false，这里显式开启验证真实路径。
  ctx.cfg.streamFallback = true;
  const call = await chatWithStarveRetry(ctx, {
    probe: 'quality',
    label: 'main mod',
    buildRequest: (maxTokens) => ({ model: ctx.cfg.model, messages: [{ role: 'user', content: 'q' }], temperature: 0, max_tokens: maxTokens }),
    budget: PROBE_BUDGETS.quality,
    retryBudget: PROBE_BUDGETS.qualityRetry,
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.stream ?? false, false);
  assert.equal(requests[0]?.max_tokens, PROBE_BUDGETS.quality);
  assert.equal(requests[1]?.stream, true);
  assert.equal(requests[1]?.max_tokens, PROBE_BUDGETS.qualityRetry);
  assert.equal(call.starved, false);
  assert.equal(call.retried, false);
  assert.equal(call.blankRetried, true);
  assert.equal(call.streamFallback, true);
  assert.equal(call.result.text, '42');
  assert.equal(ctx.evidence.size(), 2);
  assert.match(ctx.evidence.all()[1]?.label ?? '', /stream-retry@512/);
});

test('chatWithStarveRetry: blank fallback also blank keeps first blank (no fabricated answer)', async () => {
  const { client, requests } = stubClient([blankResult(), blankResult()]);
  const ctx = makeCtx(client);
  ctx.cfg.streamFallback = true;
  const call = await chatWithStarveRetry(ctx, {
    probe: 'quality',
    label: 'main mod',
    buildRequest: (maxTokens) => ({ model: ctx.cfg.model, messages: [{ role: 'user', content: 'q' }], temperature: 0, max_tokens: maxTokens }),
    budget: PROBE_BUDGETS.quality,
    retryBudget: PROBE_BUDGETS.qualityRetry,
  });
  assert.equal(requests.length, 2);
  assert.equal(call.starved, false);
  assert.equal(call.blankRetried, true);
  assert.equal(call.streamFallback, false);
  assert.equal(call.result.text, '');
  assert.equal(ctx.evidence.size(), 2);
});

test('chatWithStarveRetry: streamFallback=false keeps single blank request', async () => {
  const { client, requests } = stubClient([blankResult()]);
  const ctx = makeCtx(client);
  const call = await chatWithStarveRetry(ctx, {
    probe: 'quality',
    label: 'main mod',
    buildRequest: (maxTokens) => ({ model: ctx.cfg.model, messages: [{ role: 'user', content: 'q' }], temperature: 0, max_tokens: maxTokens }),
    budget: PROBE_BUDGETS.quality,
    retryBudget: PROBE_BUDGETS.qualityRetry,
  });
  assert.equal(requests.length, 1);
  assert.equal(call.blankRetried, false);
  assert.equal(call.streamFallback, false);
});

test('PROBE_BUDGETS: documented values fixed by test (regression anchor)', () => {
  assert.deepEqual(PROBE_BUDGETS, {
    vision: 1024,
    visionRetry: 2048,
    quality: 256,
    qualityRetry: 512,
    toolFirst: 1024,
    toolFirstRetry: 2048,
    toolSecond: 256,
    toolSecondRetry: 512,
    identity: 512,
    context: 1024,
    contextRetry: 2048,
  });
});
