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
    model: null,
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
    model: null,
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
    model: null,
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
    streamFallback: false,
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

test('capability tool: round 2 answers without echoing nonce → partial (never fail), round 1 proved tool emission', async () => {
  // 回归（2026-10-17 官方 1M 上下文复核实证）：glm-5.3-flash 首轮正确发起工具调用且参数正确，
  // 仅次轮未复述 nonce，被判 fail（capability 50）——与首轮已实证的工具调用能力自相矛盾。
  const { client } = scriptedClient(() => textResult('好的，工具已执行'));
  const outcome = await probeCapability(makeCtx(client));
  assert.equal(outcome.metrics['tool'], 'partial');
  assert.notEqual(outcome.metrics['tool'], 'fail');
  assert.ok(!outcome.findings.some((f) => f.level === 'fail'), JSON.stringify(outcome.findings));
  assert.ok(outcome.findings.some((f) => /tool calling 能力已实证/.test(f.message) && f.level === 'warn'));
});

test('capability tool: first round starved after retry → na (never fail 0), budgets 1024→2048', async () => {
  // 回归：首轮原写死 max_tokens=200 且无 starved 判定 → thinking 模型推理吃掉预算后返回纯文本，
  // 被误判「未发起工具调用」= fail 0（证据不足给 0 分，与 vision 路径自相矛盾）。
  const requests: ChatRequest[] = [];
  let calls = 0;
  const client: OpenAIClient = {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(req: ChatRequest): Promise<ChatResult> {
      requests.push(req);
      calls += 1;
      return starvedResult();
    },
  };
  const outcome = await probeCapability(makeCtx(client));
  assert.equal(requests.length, 2, '首轮 1024 截断 → 2048 重试仍截断 → 证据不足，不再继续次轮');
  assert.equal(requests[0]?.max_tokens, 1024);
  assert.equal(requests[1]?.max_tokens, 2048);
  assert.equal(outcome.metrics['tool'], 'na');
  assert.equal(outcome.status, 'insufficient');
  assert.ok(!outcome.findings.some((f) => f.level === 'fail'), JSON.stringify(outcome.findings));
  assert.ok(outcome.findings.some((f) => /首轮因推理占满预算/.test(f.message) && f.level === 'warn'));
});

test('capability tool: first round recovers at 2048 → tool call recorded with 2048 budget', async () => {
  const requests: ChatRequest[] = [];
  let calls = 0;
  let nonce = 'NONCE1';
  const client: OpenAIClient = {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(req: ChatRequest): Promise<ChatResult> {
      requests.push(req);
      calls += 1;
      if (calls === 1) return starvedResult();
      if (calls === 2) {
        const last = req.messages[req.messages.length - 1];
        const prompt = typeof last?.content === 'string' ? last.content : '';
        nonce = prompt.match(/"([A-Z0-9]{6})"/)?.[1] ?? 'NONCE1';
        return toolCallResult(nonce);
      }
      return textResult(`nonce ${nonce} confirmed`);
    },
  };
  const outcome = await probeCapability(makeCtx(client));
  assert.equal(requests[0]?.max_tokens, 1024);
  assert.equal(requests[1]?.max_tokens, 2048);
  assert.equal(outcome.metrics['tool'], 'pass');
  assert.equal(outcome.status, 'ok');
});

// ---------- vision：测试图尺寸守卫（8px 图是识别伪影，必须发 256px） ----------

test('capability vision: every request carries a 256x256 PNG (VISION_IMAGE_SIZE, not the 8px artifact)', async () => {
  const requests: ChatRequest[] = [];
  const client: OpenAIClient = {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(req: ChatRequest): Promise<ChatResult> {
      requests.push(req);
      return textResult('red');
    },
  };
  const ctx = makeCtx(client);
  ctx.cfg.expect = ['vision'];
  await probeCapability(ctx);
  // 3 个采样颜色，各 1 次请求（textResult 非截断，无重试）
  assert.equal(requests.length, 3);
  for (const req of requests) {
    const content = req.messages[0]?.content;
    assert.ok(Array.isArray(content), 'vision 请求应为多模态 content 数组');
    const imagePart = content.find((part) => typeof part === 'object' && part !== null && (part as unknown as Record<string, unknown>)['type'] === 'image_url') as
      | { image_url: { url: string } }
      | undefined;
    assert.ok(imagePart, 'vision 请求应携带 image_url');
    const dataUrl = imagePart.image_url.url;
    assert.ok(dataUrl.startsWith('data:image/png;base64,'));
    const png = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
    // PNG IHDR：宽高分别位于第 16-19、20-23 字节（big-endian）
    assert.equal(png.readUInt32BE(16), 256, `图片宽度应为 256，实际 ${png.readUInt32BE(16)}`);
    assert.equal(png.readUInt32BE(20), 256, `图片高度应为 256，实际 ${png.readUInt32BE(20)}`);
  }
});

test('capability vision: all HTTP 200 blank responses → na (never fail, not a color error)', async () => {
  const client: OpenAIClient = {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(): Promise<ChatResult> {
      return textResult('');
    },
  };
  const ctx = makeCtx(client);
  ctx.cfg.expect = ['vision'];
  const outcome = await probeCapability(ctx);
  assert.equal(outcome.metrics['vision'], 'na');
  assert.equal(outcome.status, 'insufficient');
  assert.equal(outcome.level, 'unknown');
  assert.ok(!outcome.findings.some((f) => f.level === 'fail'), JSON.stringify(outcome.findings));
  assert.ok(outcome.findings.some((f) => f.level === 'warn' && /空文本/.test(f.message)));
});

test('capability tool: first round HTTP 200 blank → na (blank response is not "no tool call")', async () => {
  const requests: ChatRequest[] = [];
  const client: OpenAIClient = {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(req: ChatRequest): Promise<ChatResult> {
      requests.push(req);
      return textResult('');
    },
  };
  const ctx = makeCtx(client);
  const outcome = await probeCapability(ctx);
  assert.equal(requests.length, 1, '空响应直接按证据不足处理，不再发次轮');
  assert.equal(outcome.metrics['tool'], 'na');
  assert.equal(outcome.status, 'insufficient');
  assert.equal(outcome.level, 'unknown');
  assert.ok(!outcome.findings.some((f) => f.level === 'fail'), JSON.stringify(outcome.findings));
  assert.ok(outcome.findings.some((f) => f.level === 'warn' && /空文本/.test(f.message)));
});