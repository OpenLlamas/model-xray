import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeCapability } from '../../src/probes/capability.js';
import { createEvidenceRecorder } from '../../src/evidence.js';
import { createRng } from '../../src/random.js';
import type { ChatRequest, ChatResult, OpenAIClient, ProbeCtx, RunConfig, ToolCall } from '../../src/types.js';

function toolCallResult(nonce: string): ChatResult {
  const call: ToolCall = {
    id: 'call_1',
    type: 'function',
    function: { name: 'echo_nonce', arguments: JSON.stringify({ nonce }) },
  };
  return {
    ok: true,
    status: 200,
    finishReason: 'stop',
    text: '',
    reasoning: null,
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    usageRejected: null,
    attempts: 1,
    toolCalls: [call],
    ttftMs: null,
    durationMs: 1,
    error: null,
    raw: '',
  };
}

function starvedResult(): ChatResult {
  return {
    ok: true,
    status: 200,
    finishReason: 'length',
    text: '',
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

function textResult(text: string): ChatResult {
  return {
    ok: true,
    status: 200,
    finishReason: 'stop',
    text,
    reasoning: null,
    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
    usageRejected: null,
    attempts: 1,
    toolCalls: [],
    ttftMs: null,
    durationMs: 1,
    error: null,
    raw: '',
  };
}

/**
 * 首轮从提示词解析 nonce 回工具调用；次轮按回调脚本构造结果（nonce 由探针生成，须首查后才知道）。
 */
function scriptedClient(secondRound: (nonce: string) => ChatResult): { client: OpenAIClient; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let firstNonce = 'NONCE1';
  return {
    requests,
    client: {
      baseUrl: 'http://127.0.0.1:0/v1',
      async chat(req: ChatRequest): Promise<ChatResult> {
        requests.push(req);
        const isSecondRound = req.messages.some((m) => m.role === 'tool');
        if (isSecondRound) return secondRound(firstNonce);
        const last = req.messages[req.messages.length - 1];
        const prompt = typeof last?.content === 'string' ? last.content : '';
        firstNonce = prompt.match(/"([A-Z0-9]{6})"/)?.[1] ?? 'NONCE1';
        return toolCallResult(firstNonce);
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
    expect: ['tool'],
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

test('capability tool: second round starved after retry → na (never partial/fail), budgets 256→512', async () => {
  const { client, requests } = scriptedClient(() => starvedResult());
  const ctx = makeCtx(client);
  const outcome = await probeCapability(ctx);
  // 首轮 1 次 + 次轮 2 次（256 截断 → 512 重试仍截断）
  assert.equal(requests.length, 3);
  assert.equal(requests[1]?.max_tokens, 256);
  assert.equal(requests[2]?.max_tokens, 512);
  assert.equal(outcome.metrics['tool'], 'na');
  assert.equal(outcome.status, 'insufficient');
  assert.equal(outcome.level, 'unknown');
  assert.ok(!outcome.findings.some((f) => f.level === 'fail'), JSON.stringify(outcome.findings));
  assert.ok(outcome.findings.some((f) => /推理占满预算/.test(f.message) && f.level === 'warn'));
});

test('capability tool: second round recovers at 512 → pass', async () => {
  // 256 首查截断，512 重试后正常作答（回显探针生成的 nonce）
  let secondRoundCalls = 0;
  const { client, requests } = scriptedClient((nonce) => {
    secondRoundCalls += 1;
    return secondRoundCalls === 1 ? starvedResult() : textResult(`nonce ${nonce} confirmed`);
  });
  const ctx = makeCtx(client);
  const outcome = await probeCapability(ctx);
  assert.equal(requests.length, 3);
  assert.equal(requests[1]?.max_tokens, 256);
  assert.equal(requests[2]?.max_tokens, 512);
  assert.equal(outcome.metrics['tool'], 'pass');
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.level, 'pass');
});
