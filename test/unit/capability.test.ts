import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSingleColorWord, probeCapability } from '../../src/probes/capability.js';
import { createEvidenceRecorder } from '../../src/evidence.js';
import { createRng } from '../../src/random.js';
import type { ChatRequest, ChatResult, OpenAIClient, ProbeCtx, RunConfig, ToolCall } from '../../src/types.js';

function rejectedResult(status: number, error: string): ChatResult {
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
    error,
    raw: '',
  };
}

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
// ---------- 2026-10-18 审计缺陷 ⑥：多色绕过（单色图问题不存在多个正确颜色） ----------

test('capability: parseSingleColorWord — 恰好一个词表内颜色词才命中，多词/零词返回 null', () => {
  assert.equal(parseSingleColorWord('The color is red.'), 'red');
  assert.equal(parseSingleColorWord('RED'), 'red');
  assert.equal(parseSingleColorWord('I see a grey circle.'), 'gray');
  assert.equal(parseSingleColorWord('It could be blue or blue.'), 'blue');
  assert.equal(parseSingleColorWord('red green blue'), null);
  assert.equal(parseSingleColorWord('red and green'), null);
  // 词表外颜色词（cyan 不在 8 色盘）不算第二个候选：唯一盘内词仍命中
  assert.equal(parseSingleColorWord('maybe green? no idea, also cyan.'), 'green');
  assert.equal(parseSingleColorWord('no palette words here'), null);
  assert.equal(parseSingleColorWord(''), null);
  // 否定短语不得被当成颜色描述：'not blue' / "isn't blue" 不是「看到蓝色」
  assert.equal(parseSingleColorWord('This is not blue.'), null);
  assert.equal(parseSingleColorWord("It isn't blue."), null);
  assert.equal(parseSingleColorWord('The color is not blue; it is red.'), 'red');
  // 否定作用域覆盖并列颜色：not blue or green 不是「看到绿色」；not blue but green 仍应保留 green
  assert.equal(parseSingleColorWord('It is not blue or green.'), null);
  assert.equal(parseSingleColorWord('not blue and green'), null);
  assert.equal(parseSingleColorWord('not blue/green'), null);
  assert.equal(parseSingleColorWord('not blue but green'), 'green');
  // not only 是强调而非否定，但列出多个颜色/单色都不构成单一答案
  assert.equal(parseSingleColorWord('not only red but blue'), null);
  assert.equal(parseSingleColorWord('not only red'), null);
  assert.equal(parseSingleColorWord('not just blue'), null);
  assert.equal(parseSingleColorWord('not even blue'), null);
});

test('capability vision: 仅 1 个有效作答且答错、其余空响应 → na/insufficient，不得凭 0/1 判 fail', async () => {
  let calls = 0;
  const client: OpenAIClient = {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(): Promise<ChatResult> {
      calls += 1;
      return calls === 1 ? textResult('not blue') : textResult('');
    },
  };
  const ctx = makeCtx(client);
  ctx.cfg.expect = ['vision'];
  const outcome = await probeCapability(ctx);
  assert.equal(outcome.metrics['vision'], 'na');
  assert.equal(outcome.status, 'insufficient');
  assert.equal(outcome.score, null);
  assert.equal(outcome.level, 'unknown');
  assert.ok(!outcome.findings.some((f) => f.level === 'fail'), JSON.stringify(outcome.findings));
  assert.ok(outcome.findings.some((f) => f.level === 'warn' && /有效样本仅 1\/3/.test(f.message)));
});

test('capability vision: 1 个有效错误 + 1 个 415 + 1 个空响应 → na，不因混合 4xx 单判 fail', async () => {
  let calls = 0;
  const client: OpenAIClient = {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(): Promise<ChatResult> {
      calls += 1;
      if (calls === 1) return rejectedResult(415, 'HTTP 415: Unsupported Media Type');
      if (calls === 2) return textResult('not blue');
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
  assert.ok(outcome.findings.some((f) => f.level === 'warn' && /有效样本仅 1\/3/.test(f.message)));
});

test('capability vision: 仅 1 个 415 + 2 个空响应 → na，不凭单次 4xx 判 fail', async () => {
  let calls = 0;
  const client: OpenAIClient = {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(): Promise<ChatResult> {
      calls += 1;
      if (calls === 1) return rejectedResult(415, 'HTTP 415: Unsupported Media Type');
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
  assert.ok(outcome.findings.some((f) => f.level === 'warn' && /1 次请求失败（状态码 415）、2 次空响应/.test(f.message)));
});

test('capability vision: 全部有效作答均识别错误（罗列全部颜色名）→ fail（不得按 partial 50 洗白）', async () => {
  // 审计缺陷 ⑥：旧 containsColorWord 会把 "red green blue" 计为命中 → 端点输出全部颜色名即可假通过。
  // 新口径只认单一颜色词：罗列式回答 0/3 全错 → vision fail（8 色随机猜中率 1/8，0 正确是强证据）。
  const client: OpenAIClient = {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(): Promise<ChatResult> {
      return textResult('red green blue');
    },
  };
  const ctx = makeCtx(client);
  ctx.cfg.expect = ['vision'];
  const outcome = await probeCapability(ctx);
  assert.equal(outcome.metrics['vision'], 'fail');
  assert.equal(outcome.level, 'fail', outcome.headline);
  assert.ok(outcome.findings.some((f) => f.level === 'fail' && /vision 失败/.test(f.message)), JSON.stringify(outcome.findings));
  assert.ok(!outcome.findings.some((f) => f.level === 'warn' && /vision 可疑/.test(f.message)), JSON.stringify(outcome.findings));
});

// ---------- 2026-10-18 审计缺陷 ⑦：415/422 与 400 同属「能力不存在」的显式拒绝 ----------

test('capability vision: 全部 415 → 显式拒绝 fail（不再降为证据不足）', async () => {
  const client: OpenAIClient = {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(): Promise<ChatResult> {
      return rejectedResult(415, 'HTTP 415: Unsupported Media Type');
    },
  };
  const ctx = makeCtx(client);
  ctx.cfg.expect = ['vision'];
  const outcome = await probeCapability(ctx);
  assert.equal(outcome.metrics['vision'], 'fail');
  assert.equal(outcome.level, 'fail', outcome.headline);
  assert.ok(outcome.findings.some((f) => f.level === 'fail' && /明确返回 4xx 拒绝/.test(f.message)), JSON.stringify(outcome.findings));
});

test('capability: vision 证据不足 + tool 通过 → insufficient，不得把未判定项静默过滤成 100 分通过', async () => {
  let nonce = 'NONCE1';
  const client: OpenAIClient = {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(req: ChatRequest): Promise<ChatResult> {
      const hasImage = req.messages.some(
        (m) => Array.isArray(m.content) && m.content.some((part) => part.type === 'image_url'),
      );
      if (hasImage) return textResult('');
      const isSecondRound = req.messages.some((m) => m.role === 'tool');
      if (isSecondRound) {
        return textResult(`已收到工具结果，nonce ${nonce} 已确认。`);
      }
      const last = req.messages[req.messages.length - 1];
      const prompt = typeof last?.content === 'string' ? last.content : '';
      nonce = prompt.match(/"([A-Z0-9]{6})"/)?.[1] ?? 'NONCE1';
      return toolCallResult(nonce);
    },
  };
  const ctx = makeCtx(client);
  ctx.cfg.expect = ['vision', 'tool'];
  const outcome = await probeCapability(ctx);
  assert.equal(outcome.metrics['vision'], 'na');
  assert.equal(outcome.metrics['tool'], 'pass');
  assert.equal(outcome.status, 'insufficient', outcome.headline);
  assert.equal(outcome.score, null);
  assert.equal(outcome.level, 'unknown');
  assert.equal(outcome.metrics['unverified'], 'vision');
  assert.match(outcome.headline, /部分无法判定/);
  assert.ok(outcome.findings.some((f) => f.level === 'warn' && /vision/.test(f.message)));
});

test('capability tool: 首轮全 422 → 显式拒绝 fail（与 400 同口径）', async () => {
  const client: OpenAIClient = {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(): Promise<ChatResult> {
      return rejectedResult(422, 'HTTP 422: Unprocessable Entity');
    },
  };
  const ctx = makeCtx(client);
  ctx.cfg.expect = ['tool'];
  const outcome = await probeCapability(ctx);
  assert.equal(outcome.metrics['tool'], 'fail');
  assert.equal(outcome.level, 'fail', outcome.headline);
  assert.ok(outcome.findings.some((f) => f.level === 'fail' && /明确拒绝（HTTP 422/.test(f.message)), JSON.stringify(outcome.findings));
});
