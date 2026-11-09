import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEvidenceRecorder } from '../../src/evidence.js';
import { createRng } from '../../src/random.js';
import { probeTokenizer } from '../../src/probes/tokenizer.js';
import type { ChatRequest, ChatResult, OpenAIClient, ProbeCtx, RunConfig } from '../../src/types.js';

function okUsage(promptTokens: number): ChatResult {
  return {
    ok: true,
    status: 200,
    finishReason: 'stop',
    model: null,
    text: '',
    reasoning: null,
    usage: { prompt_tokens: promptTokens, completion_tokens: 0, total_tokens: promptTokens },
    usageRejected: null,
    attempts: 1,
    toolCalls: [],
    ttftMs: null,
    durationMs: 1,
    error: null,
    raw: '',
  };
}

function clientFor(tokens: (request: ChatRequest, index: number) => number | null, requests: ChatRequest[]): OpenAIClient {
  let index = 0;
  return {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(request: ChatRequest): Promise<ChatResult> {
      requests.push(request);
      const promptTokens = tokens(request, index);
      index += 1;
      return promptTokens === null ? { ...okUsage(0), usage: null } : okUsage(promptTokens);
    },
  };
}

function logprobClient(token: string, logprob: number, requests: ChatRequest[]): OpenAIClient {
  return {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(request: ChatRequest): Promise<ChatResult> {
      requests.push(request);
      if (request.logprobs === true) {
        return {
          ...okUsage(10),
          text: token,
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
          logprobs: {
            content: [
              {
                token,
                logprob,
                top_logprobs: [
                  { token, logprob },
                  { token: 'other', logprob: logprob - 2.5 },
                ],
              },
            ],
          },
        };
      }
      return okUsage(40 + String(request.messages[0]?.content ?? '').length);
    },
  };
}

function logprobThenUnsupportedClient(
  token: string,
  logprob: number,
  requests: ChatRequest[],
  supportedLogprobCalls: number,
): OpenAIClient {
  let logprobCalls = 0;
  return {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(request: ChatRequest): Promise<ChatResult> {
      requests.push(request);
      if (request.logprobs === true) {
        logprobCalls += 1;
        if (logprobCalls > supportedLogprobCalls) return okUsage(10);
        return {
          ...okUsage(10),
          text: token,
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
          logprobs: {
            content: [
              {
                token,
                logprob,
                top_logprobs: [
                  { token, logprob },
                  { token: 'other', logprob: logprob - 2.5 },
                ],
              },
            ],
          },
        };
      }
      return okUsage(40 + String(request.messages[0]?.content ?? '').length);
    },
  };
}

function logprobWithCorpusUsageLimit(
  token: string,
  logprob: number,
  requests: ChatRequest[],
  maxUsageSamples: number,
): OpenAIClient {
  let corpusCalls = 0;
  return {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(request: ChatRequest): Promise<ChatResult> {
      requests.push(request);
      if (request.logprobs === true) {
        return {
          ...okUsage(10),
          text: token,
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
          logprobs: {
            content: [
              {
                token,
                logprob,
                top_logprobs: [
                  { token, logprob },
                  { token: 'other', logprob: logprob - 2.5 },
                ],
              },
            ],
          },
        };
      }
      corpusCalls += 1;
      if (corpusCalls > maxUsageSamples) return { ...okUsage(0), usage: null };
      return okUsage(40 + String(request.messages[0]?.content ?? '').length);
    },
  };
}

function tokenizerCtx(referenceClient: OpenAIClient | null): ProbeCtx {
  const cfg: RunConfig = {
    baseUrl: 'http://127.0.0.1:0/v1',
    apiKey: 'main-key',
    model: 'gpt-4o',
    claimedContext: null,
    expect: [],
    deep: false,
    seed: 7,
    timeoutMs: 1000,
    retries: 0,
    streamFallback: false,
    outDir: 'reports',
    html: false,
    yes: true,
    quiet: true,
  };
  return {
    client: clientFor((request) => 40 + String(request.messages[0]?.content ?? '').length, []),
    referenceClient,
    referenceModel: referenceClient === null ? null : 'gpt-4o',
    cfg,
    rng: createRng(7),
    evidence: createEvidenceRecorder(),
  };
}

test('tokenizer: no reference endpoint is explicitly undetermined and sends no requests', async () => {
  const requests: ChatRequest[] = [];
  const ctx = tokenizerCtx(null);
  ctx.client = clientFor(() => 10, requests);
  const outcome = await probeTokenizer(ctx);

  assert.equal(outcome.status, 'insufficient');
  assert.equal(outcome.metrics['reference_configured'], 0);
  assert.equal(requests.length, 0);
});

test('tokenizer: matching token vectors pass with paired evidence for every corpus', async () => {
  const mainRequests: ChatRequest[] = [];
  const referenceRequests: ChatRequest[] = [];
  const ctx = tokenizerCtx(null);
  ctx.client = clientFor((request) => 40 + String(request.messages[0]?.content ?? '').length, mainRequests);
  ctx.referenceClient = clientFor(
    (request) => 40 + String(request.messages[0]?.content ?? '').length,
    referenceRequests,
  );
  ctx.referenceModel = 'gpt-4o';
  const outcome = await probeTokenizer(ctx);

  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.level, 'pass');
  assert.equal(outcome.score, 100);
  assert.equal(outcome.metrics['compared'], 6);
  assert.equal(outcome.metrics['mismatches'], 0);
  // 7 类语料 + 1 次 logprob 能力探测（stub 不返回 logprobs → 提前判定不支持，不再发后续 5 条）。
  assert.equal(mainRequests.length, 8);
  assert.equal(referenceRequests.length, 8);
  assert.ok(referenceRequests.every((request) => request.model === 'gpt-4o'));
  assert.equal(outcome.metrics['logprob_supported'], 0);
  const evidence = ctx.evidence.all().filter((record) => record.probe === 'tokenizer');
  assert.equal(evidence.length, 16);
  assert.ok(evidence.some((record) => record.label.startsWith('main ')));
  assert.ok(evidence.some((record) => record.label.startsWith('reference ')));
  assert.ok(evidence.filter((record) => record.label.startsWith('main ')).every((record) => record.endpoint === 'main'));
  assert.ok(
    evidence.filter((record) => record.label.startsWith('reference ')).every((record) => record.endpoint === 'reference'),
    '参考端点证据必须标 reference，否则会被计入主端点汇总与费用估算',
  );
});

test('tokenizer: 两轮 logprob 首 token 指纹均不一致 → warn 且封顶 65', async () => {
  const mainRequests: ChatRequest[] = [];
  const referenceRequests: ChatRequest[] = [];
  const ctx = tokenizerCtx(null);
  // 语料 token 数一致（tokenizer 本身 pass）；logprob 请求主端点恒为 A、参考端点恒为 B。
  ctx.client = logprobClient('A', -0.1, mainRequests);
  ctx.referenceClient = logprobClient('B', -0.1, referenceRequests);
  ctx.referenceModel = 'gpt-4o';
  const outcome = await probeTokenizer(ctx);

  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.level, 'warn');
  assert.equal(outcome.score, 65);
  assert.equal(outcome.metrics['logprob_supported'], 1);
  assert.equal(outcome.metrics['logprob_round1_suspicious'], 1);
  assert.equal(outcome.metrics['logprob_round2_suspicious'], 1);
  assert.equal(outcome.metrics['logprob_confirmed_mismatch'], 1);
  assert.ok(outcome.findings.some((f) => f.level === 'warn' && /两轮独立随机 prompt/.test(f.message)));
  assert.equal(mainRequests.filter((request) => request.logprobs === true).length, 12);
});

test('tokenizer: 参考模型日期钉版不同 → 跳过 logprob 指纹，不发 logprob 请求', async () => {
  const mainRequests: ChatRequest[] = [];
  const referenceRequests: ChatRequest[] = [];
  const ctx = tokenizerCtx(null);
  ctx.cfg.model = 'gpt-4o-2024-08-06';
  ctx.referenceModel = 'gpt-4o-2024-11-20';
  ctx.client = logprobClient('A', -0.1, mainRequests);
  ctx.referenceClient = logprobClient('A', -0.1, referenceRequests);
  const outcome = await probeTokenizer(ctx);

  assert.equal(outcome.metrics['logprob_supported'], 0);
  assert.equal(mainRequests.filter((request) => request.logprobs === true).length, 0);
  assert.equal(referenceRequests.filter((request) => request.logprobs === true).length, 0);
  assert.ok(
    outcome.findings.some((f) => f.level === 'info' && /不是同一模型/.test(f.message)),
    JSON.stringify(outcome.findings),
  );
});

test('tokenizer: 首轮 logprob 可疑但复测不可用 → 只披露、不压分', async () => {
  const mainRequests: ChatRequest[] = [];
  const referenceRequests: ChatRequest[] = [];
  const ctx = tokenizerCtx(null);
  ctx.client = logprobClient('A', -0.1, mainRequests);
  // 参考端点只在第一轮 6 条 logprob 请求返回 B；第二轮开始不返回 logprobs。
  ctx.referenceClient = logprobThenUnsupportedClient('B', -0.1, referenceRequests, 6);
  ctx.referenceModel = 'gpt-4o';
  const outcome = await probeTokenizer(ctx);

  assert.equal(outcome.level, 'pass');
  assert.equal(outcome.score, 100);
  assert.equal(outcome.metrics['logprob_round1_suspicious'], 1);
  assert.ok(!('logprob_confirmed_mismatch' in outcome.metrics));
  assert.ok(outcome.findings.some((f) => f.level === 'info' && /复测轮未获得可用 logprobs/.test(f.message)));
});

test('tokenizer: 偶数样本的中位相对差用真中位数（插值），不取上中位', async () => {
  const ctx = tokenizerCtx(null);
  // 6 类可比语料的相对差为 [0,0,0,0.5,0.5,0.5]：真中位数 0.25，上中位数会算成 0.5。
  ctx.client = clientFor((_request, index) => (index === 0 ? 100 : 250), []);
  ctx.referenceClient = clientFor((_request, index) => (index === 0 ? 100 : index <= 3 ? 250 : 200), []);
  ctx.referenceModel = 'gpt-4o';
  const outcome = await probeTokenizer(ctx);

  assert.equal(outcome.metrics['compared'], 6);
  assert.equal(outcome.metrics['median_relative_delta'], 0.25);
});

test('tokenizer: systematic cross-category drift is a fail, not a single-sample guess', async () => {
  const ctx = tokenizerCtx(null);
  ctx.client = clientFor((request) => String(request.messages[0]?.content) === 'Reply with OK.' ? 15 : 55, []);
  ctx.referenceClient = clientFor((request) => String(request.messages[0]?.content) === 'Reply with OK.' ? 15 : 35, []);
  ctx.referenceModel = 'gpt-4o';
  const outcome = await probeTokenizer(ctx);

  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.level, 'fail');
  assert.equal(outcome.metrics['compared'], 6);
  assert.equal(outcome.metrics['mismatches'], 6);
  assert.ok(Number(outcome.metrics['median_relative_delta']) >= 0.2);
  assert.ok(outcome.findings.some((finding) => finding.level === 'fail'));
});

test('tokenizer: fewer than five comparable corpora stays insufficient', async () => {
  const ctx = tokenizerCtx(null);
  ctx.client = clientFor(() => 100, []);
  ctx.referenceClient = clientFor((_request, index) => (index <= 3 ? 80 : null), []);
  ctx.referenceModel = 'gpt-4o';
  const outcome = await probeTokenizer(ctx);

  assert.equal(outcome.status, 'insufficient');
  assert.equal(outcome.score, null);
  assert.equal(outcome.metrics['compared'], 3);
  assert.ok(
    (outcome.findings[0]?.evidenceIds.length ?? 0) > 0,
    '证据不足结论也要引用已记录调用，便于复核是哪一侧/哪类语料缺失',
  );
});

test('tokenizer: 语料不足时仍运行 logprob 指纹，两轮不一致可升 warn', async () => {
  const mainRequests: ChatRequest[] = [];
  const referenceRequests: ChatRequest[] = [];
  const ctx = tokenizerCtx(null);
  ctx.client = logprobClient('A', -0.1, mainRequests);
  // 参考端点只对前 3 类语料返回 usage：baseline + 2 类可比，触发 tokenizer 证据不足。
  ctx.referenceClient = logprobWithCorpusUsageLimit('B', -0.1, referenceRequests, 3);
  ctx.referenceModel = 'gpt-4o';
  const outcome = await probeTokenizer(ctx);

  assert.equal(outcome.status, 'insufficient');
  assert.equal(outcome.score, null);
  assert.equal(outcome.level, 'warn');
  assert.equal(outcome.metrics['compared'], 2);
  assert.equal(outcome.metrics['logprob_confirmed_mismatch'], 1);
  assert.equal(mainRequests.filter((request) => request.logprobs === true).length, 12);
  assert.ok(outcome.findings.some((f) => f.level === 'warn' && /两轮独立随机 prompt/.test(f.message)));
  assert.ok(/logprob 首 token 指纹两轮不一致/.test(outcome.headline), outcome.headline);
});
