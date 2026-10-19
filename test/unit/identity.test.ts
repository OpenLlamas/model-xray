import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPersonaBrands, familiesIn, probeIdentity } from '../../src/probes/identity.js';
import { createEvidenceRecorder } from '../../src/evidence.js';
import { createRng } from '../../src/random.js';
import type { ChatRequest, ChatResult, OpenAIClient, ProbeCtx, RunConfig } from '../../src/types.js';

function starvedResult(text: string): ChatResult {
  return {
    ok: true,
    status: 200,
    finishReason: 'length',
    model: null,
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
    model: null,
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

/** stub 队列：v0.2.1 起自述样本数为 n-1 道随机题 + 1 道固定版本题，故有效样本必须按 5（deep 8）补齐。 */
function gptSelfResults(): ChatResult[] {
  return [
    okResult('I am gpt-4o, made by OpenAI.'),
    okResult('我是 gpt-4o，由 OpenAI 开发。'),
    okResult("I'm the gpt-4o model."),
    okResult('我来自 OpenAI 的 gpt-4o。'),
    okResult('gpt-4o is my model name.'),
  ];
}

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

function makeCtx(client: OpenAIClient, overrides: Partial<RunConfig> = {}): ProbeCtx {
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
    streamFallback: false,
    outDir: 'reports',
    html: false,
    yes: true,
    quiet: true,
    ...overrides,
  };
  return { client, cfg, rng: createRng(1), evidence: createEvidenceRecorder() };
}

test('identity: self-id fully starved (non-empty truncation) → insufficient, no template/identical accusation', async () => {
  // 5 次自述全部返回相同截断文本；若 starved 样本被计入统计，会被误判「逐字一致（模板特判）」
  const { client, requests } = stubClient([
    starvedResult('{"a":'),
    starvedResult('{"a":'),
    starvedResult('{"a":'),
    starvedResult('{"a":'),
    starvedResult('{"a":'),
    okResult(COMPLETE_SCHEMA_JSON),
  ]);
  const ctx = makeCtx(client);
  const outcome = await probeIdentity(ctx);
  assert.equal(requests.length, 6, '5 次自述 + 1 次格式合规');
  assert.ok(requests.every((r) => r.max_tokens === 512), 'self-id 与 schema 预算均为 512');
  assert.equal(outcome.status, 'insufficient');
  assert.equal(outcome.score, null);
  assert.equal(outcome.level, 'unknown');
  assert.match(outcome.headline, /推理占满预算/);
  assert.ok(!outcome.findings.some((f) => /逐字一致/.test(f.message)), JSON.stringify(outcome.findings));
  assert.ok(!outcome.findings.some((f) => f.level === 'fail'));
  assert.equal(outcome.metrics['starved_samples'], 5);
});

test('identity: partial starvation — starved samples excluded from identical stats (invalid samples)', async () => {
  // 2 个有效样本逐字一致 + 3 个 starved 相同截断文本：
  // starved 无效 → 有效样本 2 个（<3），不触发逐字一致 WARN，starved 记入无效样本；
  // 少于 3 条有效自述不足以证明身份维度通过，保持 insufficient（不出 PASS 100）。
  const { client } = stubClient([
    okResult('I am gpt-4o, made by OpenAI.'),
    okResult('I am gpt-4o, made by OpenAI.'),
    starvedResult('{"a":'),
    starvedResult('{"a":'),
    starvedResult('{"a":'),
    okResult(COMPLETE_SCHEMA_JSON),
  ]);
  const ctx = makeCtx(client);
  const outcome = await probeIdentity(ctx);
  assert.equal(outcome.status, 'insufficient');
  assert.equal(outcome.score, null);
  assert.equal(outcome.level, 'unknown');
  assert.match(outcome.headline, /有效自述样本不足（2 条）/);
  assert.equal(outcome.metrics['samples'], 2);
  assert.equal(outcome.metrics['identical_samples'], 1);
  assert.equal(outcome.metrics['starved_samples'], 3);
  assert.ok(!outcome.findings.some((f) => /逐字一致/.test(f.message)), JSON.stringify(outcome.findings));
  assert.ok(outcome.findings.some((f) => /推理占满预算/.test(f.message) && f.level === 'info'));
});

test('identity: schema probe starved → no deduction, no gateway-rewrite WARN, metric N/A', async () => {
  const { client } = stubClient([...gptSelfResults(), starvedResult('{"model_family": "gp')]);
  const ctx = makeCtx(client);
  const outcome = await probeIdentity(ctx);
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.score, 100);
  assert.equal(outcome.level, 'pass');
  assert.equal(outcome.metrics['schema_compliant'], 'N/A');
  assert.ok(!outcome.findings.some((f) => /网关可能重写响应/.test(f.message)), JSON.stringify(outcome.findings));
  assert.ok(outcome.findings.some((f) => /预算不足无法判定格式合规/.test(f.message)));
});

test('identity: 仅 1 条有效自述（其余空流）→ insufficient 不出分，即使声明目标族也不得 PASS 100', async () => {
  const { client } = stubClient([
    okResult('I am gpt-4o, made by OpenAI.'),
    okResult(''),
    okResult(''),
    okResult(''),
    okResult(''),
    okResult(COMPLETE_SCHEMA_JSON),
  ]);
  const outcome = await probeIdentity(makeCtx(client));
  assert.equal(outcome.status, 'insufficient', JSON.stringify(outcome.findings));
  assert.equal(outcome.score, null);
  assert.match(outcome.headline, /有效自述样本不足（1 条）/);
});

test('identity: 仅 1 条有效自述且指向他族 → insufficient warn，不 falsified', async () => {
  const { client } = stubClient([
    okResult('I am Claude, made by Anthropic.'),
    okResult(''),
    okResult(''),
    okResult(''),
    okResult(''),
    okResult(COMPLETE_SCHEMA_JSON),
  ]);
  const outcome = await probeIdentity(makeCtx(client));
  assert.equal(outcome.status, 'insufficient', JSON.stringify(outcome.findings));
  assert.equal(outcome.score, null);
  assert.equal(outcome.level, 'warn');
  assert.match(outcome.headline, /有效自述样本不足（1 条）/);
  assert.ok(outcome.findings.some((f) => f.level === 'warn' && /1 条指向其他模型族/.test(f.message)));
  assert.ok(!outcome.findings.some((f) => f.level === 'fail'), JSON.stringify(outcome.findings));
});

test('identity: 仅 2 条有效自述且均指向他族 → insufficient warn，不得 PASS 100', async () => {
  const { client } = stubClient([
    okResult('I am Claude, made by Anthropic.'),
    okResult('I am Claude, made by Anthropic.'),
    okResult(''),
    okResult(''),
    okResult(''),
    okResult(COMPLETE_SCHEMA_JSON),
  ]);
  const outcome = await probeIdentity(makeCtx(client));
  assert.equal(outcome.status, 'insufficient', JSON.stringify(outcome.findings));
  assert.equal(outcome.score, null);
  assert.equal(outcome.level, 'warn');
  assert.match(outcome.headline, /有效自述样本仅 2 条且存在族失配/);
  assert.ok(outcome.findings.some((f) => f.level === 'warn' && /2 条指向其他模型族/.test(f.message)));
});

test('identity: 2 条他族 + 1 条中性 + 2 空响应 → 多数告警 warn 60（空响应不稀释分母）', async () => {
  const { client } = stubClient([
    okResult('I am Claude, made by Anthropic.'),
    okResult('I am Claude, made by Anthropic.'),
    okResult('I am an AI assistant.'),
    okResult(''),
    okResult(''),
    okResult(COMPLETE_SCHEMA_JSON),
  ]);
  const outcome = await probeIdentity(makeCtx(client));
  assert.equal(outcome.status, 'ok', JSON.stringify(outcome.findings));
  assert.equal(outcome.score, 60);
  assert.equal(outcome.level, 'warn');
  assert.match(outcome.headline, /2\/3/);
  assert.ok(outcome.findings.some((f) => f.level === 'warn' && /多数自述（2\/3）/.test(f.message)));
});

test('identity: 5 条「我是 GPT-4o，也是 Claude」混合声明 → warn 60，不得 falsified/不得假通过', async () => {
  const mixed = 'I am GPT-4o by OpenAI, and I am also Claude by Anthropic.';
  const { client } = stubClient([
    okResult(mixed),
    okResult(mixed),
    okResult(mixed),
    okResult(mixed),
    okResult(mixed),
    okResult(COMPLETE_SCHEMA_JSON),
  ]);
  const outcome = await probeIdentity(makeCtx(client));
  assert.equal(outcome.status, 'ok', JSON.stringify(outcome.findings));
  assert.equal(outcome.score, 60);
  assert.equal(outcome.level, 'warn');
  assert.match(outcome.headline, /混合/);
  assert.ok(outcome.findings.some((f) => f.level === 'warn' && /混合声明/.test(f.message)));
  assert.ok(!outcome.findings.some((f) => f.level === 'fail'), JSON.stringify(outcome.findings));
});

test('identity: 1 条混合声明 + 4 条目标自述 → warn 80，不得 PASS 100', async () => {
  const { client } = stubClient([
    okResult('I am GPT-4o by OpenAI, and I am also Claude by Anthropic.'),
    okResult('I am GPT-4o by OpenAI.'),
    okResult('I am GPT-4o by OpenAI.'),
    okResult('I am GPT-4o by OpenAI.'),
    okResult('I am GPT-4o by OpenAI.'),
    okResult(COMPLETE_SCHEMA_JSON),
  ]);
  const outcome = await probeIdentity(makeCtx(client));
  assert.equal(outcome.status, 'ok', JSON.stringify(outcome.findings));
  assert.equal(outcome.score, 80);
  assert.equal(outcome.level, 'warn');
  assert.match(outcome.headline, /混合声明 1\/5/);
  assert.ok(outcome.findings.some((f) => f.level === 'warn' && /混合声明 1\/5/.test(f.message)));
  assert.ok(!outcome.findings.some((f) => f.level === 'fail'), JSON.stringify(outcome.findings));
});

test('identity: 合法比较句「I am GPT-4o similar to Claude」不触发混合告警', async () => {
  const { client } = stubClient([
    okResult('I am GPT-4o similar to Claude.'),
    okResult('I am GPT-4o by OpenAI.'),
    okResult('I am GPT-4o by OpenAI.'),
    okResult('I am GPT-4o by OpenAI.'),
    okResult('I am GPT-4o by OpenAI.'),
    okResult(COMPLETE_SCHEMA_JSON),
  ]);
  const outcome = await probeIdentity(makeCtx(client));
  assert.equal(outcome.status, 'ok', JSON.stringify(outcome.findings));
  assert.equal(outcome.score, 100);
  assert.equal(outcome.level, 'pass');
  assert.ok(!outcome.findings.some((f) => f.level === 'warn' && /混合声明/.test(f.message)), JSON.stringify(outcome.findings));
});

test('identity: 3 条有效自述全部他族 + 2 空响应 → falsified fail 0（空响应不稀释定罪分母）', async () => {
  const { client } = stubClient([
    okResult('I am Claude, made by Anthropic.'),
    okResult('I am Claude, made by Anthropic.'),
    okResult('I am Claude, made by Anthropic.'),
    okResult(''),
    okResult(''),
    okResult(COMPLETE_SCHEMA_JSON),
  ]);
  const outcome = await probeIdentity(makeCtx(client));
  assert.equal(outcome.status, 'ok', JSON.stringify(outcome.findings));
  assert.equal(outcome.score, 0);
  assert.equal(outcome.level, 'fail');
  assert.match(outcome.headline, /身份矛盾/);
  assert.ok(outcome.findings.some((f) => f.level === 'fail' && /每条有效自述都指向其他模型族/.test(f.message)));
});

test('identity: 2 字族名「豆包」也计入有效自述 → 3 条他族 + 2 空响应 fail 0', async () => {
  const { client } = stubClient([
    okResult('豆包'),
    okResult('豆包'),
    okResult('豆包'),
    okResult(''),
    okResult(''),
    okResult(COMPLETE_SCHEMA_JSON),
  ]);
  const outcome = await probeIdentity(makeCtx(client));
  assert.equal(outcome.status, 'ok', JSON.stringify(outcome.findings));
  assert.equal(outcome.score, 0);
  assert.equal(outcome.level, 'fail');
  assert.match(outcome.headline, /身份矛盾/);
  assert.ok(outcome.findings.some((f) => f.level === 'fail' && /每条有效自述都指向其他模型族/.test(f.message)));
});

test('identity: non-stream blank self-id falls back to stream and recovers (disclosed, no N/A)', async () => {
  const [first, ...rest] = gptSelfResults();
  const { client, requests } = stubClient([
    { ...okResult(''), finishReason: null, error: 'empty stream' },
    first!,
    ...rest,
    okResult(COMPLETE_SCHEMA_JSON),
  ]);
  const ctx = makeCtx(client);
  ctx.cfg.streamFallback = true;
  const outcome = await probeIdentity(ctx);
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.score, 100);
  assert.equal(outcome.metrics['samples'], 5);
  assert.equal(outcome.metrics['blank_retried'], 1);
  assert.equal(outcome.metrics['stream_fallbacks'], 1);
  assert.equal(requests.length, 7);
  assert.equal(requests.filter((r) => r.stream === true).length, 1);
  assert.ok(outcome.findings.some((f) => f.level === 'info' && /流式回退/.test(f.message)), JSON.stringify(outcome.findings));
});

test('identity: schema probe blank (HTTP 200 empty) → N/A metric, info only, no gateway-rewrite WARN', async () => {
  // 200 空文本是「未获得答案」，不是「未按结构返回」：不得扣分或告警（空响应 ≠ 格式不合规）。
  const { client } = stubClient([...gptSelfResults(), okResult('')]);
  const outcome = await probeIdentity(makeCtx(client));
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.score, 100);
  assert.equal(outcome.level, 'pass');
  assert.equal(outcome.metrics['schema_compliant'], 'N/A');
  assert.ok(!outcome.findings.some((f) => /网关可能重写响应/.test(f.message)), JSON.stringify(outcome.findings));
  assert.ok(outcome.findings.some((f) => f.level === 'info' && /格式合规探针返回空文本/.test(f.message)));
});

test('identity: identical non-empty self-ids amid blank samples → template WARN (blanks do not dilute)', async () => {
  // 2 个空响应不应稀释「其余 3 个有效自述逐字一致」的信号（旧口径按 5 样本算，漏检）。
  const same = 'I am gpt-4o, made by OpenAI.';
  const { client } = stubClient([
    okResult(same),
    okResult(''),
    okResult(same),
    okResult(''),
    okResult(same),
    okResult(COMPLETE_SCHEMA_JSON),
  ]);
  const outcome = await probeIdentity(makeCtx(client));
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.metrics['samples'], 5);
  assert.ok(
    outcome.findings.some((f) => f.level === 'warn' && /逐字一致/.test(f.message)),
    JSON.stringify(outcome.findings),
  );
  assert.ok(typeof outcome.score === 'number' && outcome.score <= 70);
});

// ---------- v0.2.1：自述样本数 5（deep 8）+ 固定版本自述题 ----------

test('identity: default samples are 5 self-id calls + 1 fixed exact-version question', async () => {
  const { client, requests } = stubClient([...gptSelfResults(), okResult(COMPLETE_SCHEMA_JSON)]);
  const ctx = makeCtx(client);
  const outcome = await probeIdentity(ctx);
  assert.equal(outcome.status, 'ok');
  // 自述调用 5 次（temperature 0.7），schema 探针 1 次（temperature 0）
  const selfId = requests.filter((r) => r.temperature === 0.7);
  assert.equal(selfId.length, 5);
  assert.equal(requests.length, 6);
  // 固定追加 1 题精确版本自述
  const exact = selfId.filter((r) => /精确版本号/.test(String(r.messages[0]?.content ?? '')));
  assert.equal(exact.length, 1, '必含 1 题精确版本自述');
  assert.equal(outcome.metrics['samples'], 5);
});

test('identity: deep mode makes 8 self-id calls', async () => {
  const deepResults = [
    ...gptSelfResults(),
    okResult('I am gpt-4o by OpenAI.'),
    okResult('The model is gpt-4o.'),
    okResult('My name is gpt-4o.'),
  ];
  const { client, requests } = stubClient([...deepResults, okResult(COMPLETE_SCHEMA_JSON)]);
  const ctx = makeCtx(client, { deep: true });
  const outcome = await probeIdentity(ctx);
  assert.equal(outcome.status, 'ok');
  const selfId = requests.filter((r) => r.temperature === 0.7);
  assert.equal(selfId.length, 8);
  assert.equal(requests.length, 9);
  assert.equal(outcome.metrics['samples'], 8);
});

// ---------- claimed_version 指标 + 版本矛盾旁证（仅 warn，不定罪） ----------

/** 5 条同族但版本为 4.5 的自述（措辞各异，避免逐字一致 WARN）。 */
function glm45SelfResults(): ChatResult[] {
  return [
    okResult('我是 GLM-4.5，由智谱开发。'),
    okResult('智谱 AI 的 GLM-4.5 是我。'),
    okResult('I am GLM-4.5 by Zhipu.'),
    okResult('我叫 GLM-4.5。'),
    okResult('Model: GLM-4.5.'),
  ];
}

function glmNoVersionSelfResults(): ChatResult[] {
  return [
    okResult('我是 GLM，由智谱开发。'),
    okResult('智谱 AI 的 GLM 是我。'),
    okResult('I am GLM by Zhipu.'),
    okResult('我叫 GLM。'),
    okResult('Model: GLM.'),
  ];
}

function schemaOk(): ChatResult {
  // 覆盖两个 SCHEMA_PROBES 全部键的超集，避免依赖 rng 选中哪个 schema 探针
  return okResult('{"model_family": "glm", "language_count": 9, "self_name": "glm", "context_window": 128000}');
}

test('identity: version mismatch (claimed 4.5 vs target 5.3) → warn, score ≤ 90, not falsified', async () => {
  const { client } = stubClient([...glm45SelfResults(), schemaOk()]);
  const ctx = makeCtx(client, { model: 'glm-5.3-flash' });
  const outcome = await probeIdentity(ctx);
  assert.equal(outcome.status, 'ok');
  const warn = outcome.findings.find((f) => /自述版本.*与目标模型.*不符/.test(f.message));
  assert.ok(warn, JSON.stringify(outcome.findings));
  assert.equal(warn?.level, 'warn');
  assert.ok(!outcome.findings.some((f) => f.level === 'fail'), '版本旁证不定罪');
  assert.equal(outcome.score, 90);
  assert.equal(outcome.level, 'warn');
  assert.ok(String(outcome.metrics['claimed_version']).includes('4.5'));
});

test('identity: 上游回显更窄变体（请求 gpt-4o 回显 gpt-4o-mini）→ warn + 压分，冒充线索可见', async () => {
  // 换壳方不改写回显字段时的唯一机器证据：自述可被「教」，回显字段不会。
  const echo = (results: ChatResult[], model: string): ChatResult[] => results.map((r) => ({ ...r, model }));
  const { client } = stubClient(echo([...gptSelfResults(), schemaOk()], 'gpt-4o-mini'));
  const ctx = makeCtx(client, { model: 'gpt-4o' });
  const outcome = await probeIdentity(ctx);
  assert.equal(outcome.status, 'ok');
  const warn = outcome.findings.find((f) => /上游回显/.test(f.message));
  assert.ok(warn, JSON.stringify(outcome.findings));
  assert.equal(warn?.level, 'warn');
  assert.equal(outcome.score, 60);
  assert.equal(outcome.level, 'warn');
  assert.ok(/疑似换壳/.test(outcome.headline), outcome.headline);
  assert.equal(outcome.metrics['model_echo_values'], 'gpt-4o-mini');
});

test('identity: 少数回显不一致（2/6）也只给 80，不得接近满分', async () => {
  // 真机实证（2026-10-18）：请求 glm-5.3-flash，6 次中 2 次回显 deepseek-flash，旧口径给 90。
  const results = [...glmNoVersionSelfResults(), schemaOk()].map((r, i) => ({
    ...r,
    model: i < 2 ? 'deepseek-flash' : 'glm-5.3-flash',
  }));
  const { client } = stubClient(results);
  const ctx = makeCtx(client, { model: 'glm-5.3-flash' });
  const outcome = await probeIdentity(ctx);
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.metrics['model_echo'], '4/6');
  assert.equal(outcome.score, 80);
  assert.equal(outcome.level, 'warn');
  assert.match(outcome.headline, /2\/6/);
});

test('identity: 回显被网关规范化（厂商前缀 + 日期钉版 / 滚动别名）不算异常，不诬告', async () => {
  const echo = (results: ChatResult[], model: string): ChatResult[] => results.map((r) => ({ ...r, model }));
  for (const alias of ['openai/gpt-4o-2024-08-06', 'gpt-4o-latest', 'gpt-4o']) {
    const { client } = stubClient(echo([...gptSelfResults(), schemaOk()], alias));
    const ctx = makeCtx(client, { model: 'gpt-4o' });
    const outcome = await probeIdentity(ctx);
    assert.equal(outcome.status, 'ok', alias);
    assert.equal(outcome.score, 100, alias);
    assert.equal(outcome.level, 'pass', alias);
    assert.equal(outcome.metrics['model_echo'], '6/6', alias);
    assert.ok(!outcome.findings.some((f) => /上游回显/.test(f.message)), `${alias}: ${JSON.stringify(outcome.findings)}`);
  }
});

test('identity: 回显仅分隔符不同（glm-5.3-flash ↔ glm-5-3-flash）不算异常', async () => {
  // 实证来源：[中转站] 同一模型混用点号/连字符回显，不归一会误判成换壳。
  const echo = (results: ChatResult[], model: string): ChatResult[] => results.map((r) => ({ ...r, model }));
  const { client } = stubClient(echo([...glmNoVersionSelfResults(), schemaOk()], 'glm-5-3-flash'));
  const ctx = makeCtx(client, { model: 'glm-5.3-flash' });
  const outcome = await probeIdentity(ctx);
  assert.equal(outcome.status, 'ok');
  assert.ok(!outcome.findings.some((f) => /上游回显/.test(f.message)), JSON.stringify(outcome.findings));
  assert.equal(outcome.metrics['model_echo'], '6/6');
});

test('identity: 请求带日期钉版、回显被规范化成短名 → 不算异常', async () => {
  const echo = (results: ChatResult[], model: string): ChatResult[] => results.map((r) => ({ ...r, model }));
  const { client } = stubClient(echo([...gptSelfResults(), schemaOk()], 'gpt-4o'));
  const ctx = makeCtx(client, { model: 'openai/gpt-4o-2024-08-06' });
  const outcome = await probeIdentity(ctx);
  assert.equal(outcome.level, 'pass');
  assert.equal(outcome.metrics['model_echo'], '6/6');
  assert.ok(!outcome.findings.some((f) => /上游回显/.test(f.message)), JSON.stringify(outcome.findings));
});

test('identity: starved sample still contributes model echo mismatch', async () => {
  // starved 样本文本不可用，但 HTTP 回显的 model 字段仍是换壳/换通道的机器证据，不能一并丢弃。
  const starved = { ...starvedResult('{"a":'), model: 'deepseek-flash' };
  const empty = (model: string): ChatResult => ({ ...okResult(''), model });
  const schema = { ...okResult(COMPLETE_SCHEMA_JSON), model: 'glm-5.3-flash' };
  const { client } = stubClient([
    starved,
    empty('glm-5.3-flash'),
    empty('glm-5.3-flash'),
    empty('glm-5.3-flash'),
    empty('glm-5.3-flash'),
    schema,
  ]);
  const ctx = makeCtx(client, { model: 'glm-5.3-flash' });
  const outcome = await probeIdentity(ctx);
  // 自述全部空响应时不能以「证据不足」掩盖回显不一致：回显是独立机器证据，按 warn 报出；
  // 但不给分（status insufficient / score null），避免「没核验到身份却拿 90 分」抬高中分。
  assert.equal(outcome.status, 'insufficient');
  assert.equal(outcome.score, null);
  assert.equal(outcome.level, 'warn');
  assert.match(outcome.headline, /自述全部空响应.*上游回显模型与请求不一致/);
  assert.equal(outcome.metrics['model_echo'], '5/6');
  assert.ok(String(outcome.metrics['model_echo_values']).includes('deepseek-flash'));
  const echoWarn = outcome.findings.find((f) => f.level === 'warn' && /上游回显/.test(f.message));
  assert.ok(echoWarn, JSON.stringify(outcome.findings));
  assert.ok(echoWarn?.evidenceIds.includes('ev-001'), 'starved 样本的回显证据应被引用');
  assert.equal(echoWarn?.evidenceIds.length, 6);
});

test('identity: all-empty responses without model echo mismatch stay insufficient (no false accusation)', async () => {
  // 回显一致但正文全空：仍应诚实降级为证据不足，不得凭空给 warn/分数。
  const empty = (model: string | null): ChatResult => ({ ...okResult(''), model });
  const schema = { ...okResult(''), model: 'glm-5.3-flash' };
  const { client } = stubClient([
    empty('glm-5.3-flash'),
    empty('glm-5.3-flash'),
    empty('glm-5.3-flash'),
    empty('glm-5.3-flash'),
    empty('glm-5.3-flash'),
    schema,
  ]);
  const outcome = await probeIdentity(makeCtx(client, { model: 'glm-5.3-flash' }));
  assert.equal(outcome.status, 'insufficient');
  assert.equal(outcome.score, null);
  assert.equal(outcome.level, 'unknown');
  assert.equal(outcome.metrics['model_echo'], '6/6');
  assert.ok(!outcome.findings.some((f) => f.level === 'warn' && /上游回显/.test(f.message)));
});

test('identity: self-descriptions without a concrete version → no version verdict, claimed_version none', async () => {
  const { client } = stubClient([...glmNoVersionSelfResults(), schemaOk()]);
  const ctx = makeCtx(client, { model: 'glm-5.3-flash' });
  const outcome = await probeIdentity(ctx);
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.score, 100);
  assert.equal(outcome.level, 'pass');
  assert.equal(outcome.metrics['claimed_version'], 'none');
  assert.ok(!outcome.findings.some((f) => /自述版本/.test(f.message)), JSON.stringify(outcome.findings));
});

test('identity: target model without X.Y version (gpt-4o) → no version verdict even with claimed version', async () => {
  const { client } = stubClient([...gptSelfResults(), schemaOk()]);
  const ctx = makeCtx(client, { model: 'gpt-4o' });
  const outcome = await probeIdentity(ctx);
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.score, 100);
  assert.ok(!outcome.findings.some((f) => /自述版本/.test(f.message)), JSON.stringify(outcome.findings));
});

test('identity: claimed_version metric records family+number form (GLM-4)', async () => {
  const results = [
    okResult('我是 GLM-4，由智谱开发。'),
    okResult('智谱 AI 的 GLM-4。'),
    okResult('I am GLM-4.'),
    okResult('我叫 GLM-4。'),
    okResult('Model: GLM-4.'),
  ];
  const { client } = stubClient([...results, schemaOk()]);
  const ctx = makeCtx(client, { model: 'glm-5.3-flash' });
  const outcome = await probeIdentity(ctx);
  assert.equal(outcome.metrics['claimed_version'], 'GLM-4');
});

// ---------- falsified 全体一致语义（v0.2.1） ----------

test('identity: falsified requires unanimous mismatch — 5/5 mismatch with expected family fails', async () => {
  const { client } = stubClient([...glm45SelfResults(), schemaOk()]);
  // 期望族 gpt，自述全部指向 glm → 全体一致 → 伪造
  const ctx = makeCtx(client, { model: 'gpt-4o' });
  const outcome = await probeIdentity(ctx);
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.score, 0);
  assert.equal(outcome.level, 'fail');
  assert.ok(outcome.findings.some((f) => f.level === 'fail' && /每条有效自述都指向其他模型族/.test(f.message)));
});

test('identity: 4/5 mismatch (one sample consistent) → majority warn, not falsified', async () => {
  const results = [
    okResult('我是 Claude，由 Anthropic 开发。'),
    okResult('I am Claude by Anthropic.'),
    okResult('我叫 Claude。'),
    okResult('Model: Claude.'),
    okResult('I am gpt-4o by OpenAI.'), // 一致样本 → 未达全体一致定罪线
  ];
  const { client } = stubClient([...results, schemaOk()]);
  const ctx = makeCtx(client, { model: 'gpt-4o' });
  const outcome = await probeIdentity(ctx);
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.level, 'warn', '多数不一致 → warn，不再「未见异常」假清白');
  assert.equal(outcome.score, 60);
  assert.ok(
    outcome.findings.some((f) => f.level === 'warn' && /多数自述（4\/5）指向其他模型族/.test(f.message)),
    JSON.stringify(outcome.findings),
  );
  assert.ok(!outcome.findings.some((f) => f.level === 'fail'), JSON.stringify(outcome.findings));
});

test('identity: one sample declares no family → unanimity broken, lands in majority warn (4 mismatch + 1 undeclared)', async () => {
  const results = [
    okResult('我是 Claude，由 Anthropic 开发。'),
    okResult('I am Claude by Anthropic.'),
    okResult('我叫 Claude。'),
    okResult('Model: Claude.'),
    okResult('这个问题我无法回答。'), // 未声明任何族：不计数 mismatch，但打破全体一致 → 保守不判伪造
  ];
  const { client } = stubClient([...results, schemaOk()]);
  const ctx = makeCtx(client, { model: 'gpt-4o' });
  const outcome = await probeIdentity(ctx);
  assert.equal(outcome.status, 'ok');
  assert.ok(!outcome.findings.some((f) => f.level === 'fail'), JSON.stringify(outcome.findings));
  assert.equal(outcome.level, 'warn', '4/5 mismatch 达多数线 → warn（未声明族样本不计入）');
  assert.equal(outcome.score, 60);
});

// ---------- 真实事故回归：全程自述他族不再「假清白」（xianyu1.natapp4.cc 事故） ----------

test('identity: incident regression — glm-5.3-flash endpoint self-describes MiniMax-M3 5 times → falsified fail, families=minimax', async () => {
  // 真实事故：以 glm-5.3-flash 名义请求，5 次自述全部回答 MiniMax-M3（reports/report-2026-10-11T16-00-32-484Z ev-001..003）。
  // 旧逻辑双盲区：MODEL_ALIAS 无 minimax 族（families='none'）+ 未声明族样本被跳过 → falsified 永不触发 → PASS 100。
  const incident = '我是MiniMax-M3模型，由MiniMax开发。';
  const results = [okResult(incident), okResult(incident), okResult(incident), okResult(incident), okResult(incident)];
  const { client } = stubClient([...results, schemaOk()]);
  const ctx = makeCtx(client, { model: 'glm-5.3-flash' });
  const outcome = await probeIdentity(ctx);
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.score, 0);
  assert.equal(outcome.level, 'fail');
  assert.equal(outcome.metrics['families'], 'minimax', 'minimax 已入别名表，families 不再是 none');
  assert.ok(outcome.findings.some((f) => f.level === 'fail' && /每条有效自述都指向其他模型族/.test(f.message)));
});

test('identity: minimax target self-describes MiniMax → pass with families=minimax (no longer none+PASS)', async () => {
  const results = [
    okResult('我是 MiniMax-M3，由 MiniMax 开发。'),
    okResult('MiniMax AI 的 MiniMax-M3 是我。'),
    okResult('I am MiniMax-M3 by MiniMax.'),
    okResult('我叫 MiniMax-M3。'),
    okResult('Model: MiniMax-M3.'),
  ];
  const { client } = stubClient([...results, schemaOk()]);
  const ctx = makeCtx(client, { model: 'minimax-m3' });
  const outcome = await probeIdentity(ctx);
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.score, 100);
  assert.equal(outcome.level, 'pass');
  assert.equal(outcome.metrics['families'], 'minimax');
});

test('identity: samples declare no recognizable family → honest insufficient (no fake PASS)', async () => {
  const results = [
    okResult('我是一个AI助手。'),
    okResult('我是一个AI助手，请问有什么可以帮你？'),
    okResult('I am an AI assistant.'),
    okResult('我是一个 AI 助手。'),
    okResult('As an AI assistant, I can help.'),
  ];
  const { client } = stubClient([...results, schemaOk()]);
  const ctx = makeCtx(client, { model: 'glm-5.3-flash' });
  const outcome = await probeIdentity(ctx);
  assert.equal(outcome.status, 'insufficient');
  assert.equal(outcome.score, null);
  assert.equal(outcome.level, 'unknown');
  assert.match(outcome.headline, /自述未声明可识别模型族/);
  assert.equal(outcome.metrics['families'], 'none');
  assert.ok(outcome.findings.some((f) => f.level === 'info' && /自述未声明可识别模型族/.test(f.message)));
});

test('identity: target family not in alias table → honest insufficient with declared-family info', async () => {
  const { client } = stubClient([...gptSelfResults(), schemaOk()]);
  const ctx = makeCtx(client, { model: 'my-custom-llm' });
  const outcome = await probeIdentity(ctx);
  assert.equal(outcome.status, 'insufficient');
  assert.equal(outcome.score, null);
  assert.equal(outcome.level, 'unknown');
  assert.match(outcome.headline, /目标模型族不在已知别名表内/);
  const info = outcome.findings.find((f) => f.level === 'info' && /不在已知别名表内/.test(f.message));
  assert.ok(info, JSON.stringify(outcome.findings));
  assert.match(info!.message, /自述声明族：gpt/);
});

test('identity: target family unknown + model echo mismatch → warn (insufficient) discloses shell clue', async () => {
  // 目标族不可识别时仍必须披露上游回显不一致：回显是独立机器证据，不能被「无法核验自述」掩盖。
  const echo = (results: ChatResult[], model: string): ChatResult[] => results.map((r) => ({ ...r, model }));
  const { client } = stubClient(echo([...gptSelfResults(), schemaOk()], 'deepseek-chat'));
  const outcome = await probeIdentity(makeCtx(client, { model: 'my-custom-llm' }));
  assert.equal(outcome.status, 'insufficient');
  assert.equal(outcome.score, null);
  assert.equal(outcome.level, 'warn');
  assert.match(outcome.headline, /上游回显模型与请求不一致/);
  assert.ok(
    outcome.findings.some((f) => f.level === 'warn' && /上游回显/.test(f.message)),
    JSON.stringify(outcome.findings),
  );
});

test('identity: undeclared family + model echo mismatch → warn (no family evidence does not hide echo)', async () => {
  const echo = (results: ChatResult[], model: string): ChatResult[] => results.map((r) => ({ ...r, model }));
  const generic = [
    okResult('我是一个AI助手。'),
    okResult('我是一个AI助手，请问有什么可以帮你？'),
    okResult('I am an AI assistant.'),
    okResult('我是一个 AI 助手。'),
    okResult('As an AI assistant, I can help.'),
  ];
  const { client } = stubClient(echo([...generic, schemaOk()], 'deepseek-chat'));
  const outcome = await probeIdentity(makeCtx(client, { model: 'glm-5.3-flash' }));
  assert.equal(outcome.status, 'insufficient');
  assert.equal(outcome.score, null);
  assert.equal(outcome.level, 'warn');
  assert.match(outcome.headline, /自述未声明可识别模型族.*上游回显模型与请求不一致/);
  assert.ok(
    outcome.findings.some((f) => f.level === 'warn' && /上游回显/.test(f.message)),
    JSON.stringify(outcome.findings),
  );
});

test('identity: noise tolerance — 1 mismatch in 5 → pass with no mismatch warning', async () => {
  const results = [
    okResult('我是 Claude，由 Anthropic 开发。'),
    okResult('I am gpt-4o by OpenAI.'),
    okResult('我是 gpt-4o，由 OpenAI 开发。'),
    okResult("I'm the gpt-4o model."),
    okResult('我来自 OpenAI 的 gpt-4o。'),
  ];
  const { client } = stubClient([...results, schemaOk()]);
  const ctx = makeCtx(client, { model: 'gpt-4o' });
  const outcome = await probeIdentity(ctx);
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.level, 'pass');
  assert.equal(outcome.score, 100);
  assert.ok(!outcome.findings.some((f) => /多数自述/.test(f.message)), JSON.stringify(outcome.findings));
  assert.ok(!outcome.findings.some((f) => f.level === 'warn'), JSON.stringify(outcome.findings));
});

// ---------- families 契约（guard/fingerprint.ts 依赖）保持不变 ----------

test('identity: families metric contract unchanged (union of declared families)', async () => {
  const { client } = stubClient([...gptSelfResults(), okResult(COMPLETE_SCHEMA_JSON)]);
  const ctx = makeCtx(client);
  const outcome = await probeIdentity(ctx);
  assert.equal(outcome.metrics['families'], 'gpt');
});

// ---------- detectPersonaBrands（F2，v0.2.2 起）----------

test('detectPersonaBrands: positives across EN/ZH patterns and dotted/spaced brands', () => {
  assert.deepEqual(detectPersonaBrands('I am NovaRelay assistant.'), ['NovaRelay']);
  assert.ok(detectPersonaBrands("I'm an assistant called NovaRelay.").includes('NovaRelay'));
  assert.ok(detectPersonaBrands('I am NovaRelay, an AI assistant.').includes('NovaRelay'));
  assert.ok(detectPersonaBrands('我是 NovaRelay 助手').includes('NovaRelay'));
  // 裁决必修项：点号/空格品牌不崩溃且命中（候选只做归一化字符串比较，绝不构造正则）
  assert.deepEqual(detectPersonaBrands('I am Nova.Relay assistant.'), ['Nova.Relay']);
  assert.deepEqual(detectPersonaBrands('I am Nova Relay assistant.'), ['Nova Relay']);
  assert.deepEqual(detectPersonaBrands('this is AcmeBot assistant'), ['AcmeBot']);
  assert.deepEqual(detectPersonaBrands('我叫 RelayX 助理'), ['RelayX']);
  // 去重：同一文本多次命中同一品牌只回报一次（保留首次展示形态）
  assert.deepEqual(detectPersonaBrands('I am NovaRelay assistant. I am NovaRelay assistant.'), ['NovaRelay']);
});

test('detectPersonaBrands: negatives — generic words, family names, quoted context', () => {
  assert.deepEqual(detectPersonaBrands('I am an AI assistant.'), []);
  assert.deepEqual(detectPersonaBrands('I am a helpful assistant.'), []);
  assert.deepEqual(detectPersonaBrands('I am your assistant.'), []);
  assert.deepEqual(detectPersonaBrands('我是你的助手。'), []);
  assert.deepEqual(detectPersonaBrands('I am DeepSeek assistant.'), []);
  // 句首锚定：引用/报道句不误报（多数样本自述是正常叙事，不是人格声明）
  assert.deepEqual(detectPersonaBrands('The user asked if I am NovaRelay assistant.'), []);
  assert.deepEqual(detectPersonaBrands(''), []);
  // 大小写/空白归一后去重（同一品牌不因形态差异重复计数）
  assert.deepEqual(detectPersonaBrands('I am NovaRelay assistant. I am NOVARELAY assistant.'), ['NovaRelay']);
});

// ---------- F2 探针级集成：人格命中在正常与降级分支都必须披露 ----------

test('identity F2: persona brand + target-family self-ID → warn, score capped 80, hits recorded', async () => {
  const { client } = stubClient([
    okResult('I am gpt-4o. I am NovaRelay assistant.'),
    okResult('I am gpt-4o, made by OpenAI.'),
    okResult('I am gpt-4o. I am NovaRelay assistant.'),
    okResult('gpt-4o is my model name.'),
    okResult('我是 gpt-4o。'),
    okResult(COMPLETE_SCHEMA_JSON),
  ]);
  const outcome = await probeIdentity(makeCtx(client));
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.level, 'warn');
  assert.equal(outcome.score, 80, '人格注入是弱证据：压分到 80、降 warn，不单独定罪');
  assert.equal(outcome.metrics['persona_hits'], 'NovaRelay×2');
  assert.ok(
    outcome.findings.some(
      (f) => f.level === 'warn' && /自述出现非模型族人格名：NovaRelay（合计 2 处命中，目标族为 gpt-4o）/.test(f.message),
    ),
    JSON.stringify(outcome.findings),
  );
  assert.doesNotMatch(outcome.headline, /未见异常/, 'warn 时不得保留「未见异常」headline');
});

test('identity F2: persona disclosed in degraded branch (no family evidence, no score)', async () => {
  const { client } = stubClient([
    okResult('I am NovaRelay assistant.'),
    okResult('I am a helpful assistant.'),
    okResult('Hello, how can I help?'),
    okResult('I am NovaRelay assistant.'),
    okResult('I am an AI assistant.'),
    okResult(COMPLETE_SCHEMA_JSON),
  ]);
  const outcome = await probeIdentity(makeCtx(client));
  assert.equal(outcome.status, 'insufficient');
  assert.equal(outcome.score, null);
  assert.equal(outcome.metrics['persona_hits'], 'NovaRelay×2');
  assert.ok(
    outcome.findings.some((f) => f.level === 'warn' && /自述出现非模型族人格名：NovaRelay/.test(f.message)),
    '降级分支不得丢失人格信号：' + JSON.stringify(outcome.findings),
  );
});

test('identity F2: persona hit coexists with falsified verdict without softening it (fail 0 stays)', async () => {
  // 全体自述指向他族（falsified 定罪）+ 人格品牌：fail 0 不得被 persona 的 80 封顶规则拉回
  const { client } = stubClient([
    okResult('I am a DeepSeek assistant named NovaRelay.'),
    okResult('I am DeepSeek.'),
    okResult('我是 DeepSeek 的助手。'),
    okResult('DeepSeek is my model.'),
    okResult('I am DeepSeek assistant.'),
    okResult(COMPLETE_SCHEMA_JSON),
  ]);
  const outcome = await probeIdentity(makeCtx(client));
  assert.equal(outcome.level, 'fail');
  assert.equal(outcome.score, 0, 'persona 的 80 封顶不得把 falsified 的 0 分拉回');
  assert.match(outcome.headline, /身份矛盾/);
  assert.equal(outcome.metrics['persona_hits'], 'NovaRelay×1');
  assert.ok(outcome.findings.some((f) => f.level === 'warn' && /自述出现非模型族人格名：NovaRelay/.test(f.message)));
});

test('identity: falsified + upstream echo mismatch keeps fail verdict (echo must not soften fail)', async () => {
  // 真机 2026-10-19：5 条自述全部指向 DeepSeek，且 6/6 回显 deepseek-flash；
  // falsified 已构成 fail 0，回显告警只能追加证据，不能把 level 改回 warn（否则报告自相矛盾）。
  const echo = (results: ChatResult[]): ChatResult[] => results.map((r) => ({ ...r, model: 'deepseek-flash' }));
  const { client } = stubClient(
    echo([
      okResult('I am DeepSeek.'),
      okResult('我是 DeepSeek 的助手。'),
      okResult('DeepSeek is my model.'),
      okResult('I am DeepSeek assistant.'),
      okResult('我由深度求索开发。'),
      schemaOk(),
    ]),
  );
  const outcome = await probeIdentity(makeCtx(client, { model: 'glm-5.3-flash' }));
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.level, 'fail', outcome.headline);
  assert.equal(outcome.score, 0);
  assert.match(outcome.headline, /身份矛盾/);
  assert.ok(
    outcome.findings.some((f) => f.level === 'warn' && /上游回显/.test(f.message)),
    JSON.stringify(outcome.findings),
  );
});

test('identity F2: unknown target family → persona scan skipped (no baseline to compare against)', async () => {
  const personaOnly = Array.from({ length: 5 }, () => okResult('I am NovaRelay assistant.'));
  const { client } = stubClient([...personaOnly, okResult(COMPLETE_SCHEMA_JSON)]);
  const outcome = await probeIdentity(makeCtx(client, { model: 'acme-9000' }));
  assert.equal(outcome.status, 'insufficient');
  assert.match(outcome.headline, /不在已知别名表/);
  assert.equal(outcome.metrics['persona_hits'], 'none');
  assert.ok(!outcome.findings.some((f) => /人格名/.test(f.message)), JSON.stringify(outcome.findings));
});

// ---------- 2026-10-18 审计缺陷 ④：否定语境（"I am Claude, not OpenAI." 不得同时声明 openai） ----------

test('familiesIn: 否定句中被否定的别名不构成声明', () => {
  // 前缀否定（英文 not）
  assert.deepEqual([...familiesIn('I am Claude, not OpenAI.')].sort(), ['claude']);
  assert.deepEqual([...familiesIn('I am GPT-4o, not Claude.')].sort(), ['gpt']);
  // 后缀否定（X is not me）
  assert.deepEqual([...familiesIn('OpenAI is not me; I am Claude.')].sort(), ['claude']);
  // 中文否定
  assert.deepEqual([...familiesIn('我不是 OpenAI 的模型，我是 GLM。')].sort(), ['glm']);
  // 未否定时照常声明（防误杀）
  assert.deepEqual([...familiesIn('I am GPT-4o, made by OpenAI.')].sort(), ['gpt']);
  assert.deepEqual([...familiesIn('I am Claude by Anthropic.')].sort(), ['claude']);
  // 「not only / not just / 不只 / 不仅」是强调不是否认：仍声明该族（防过度否定漏判）
  assert.deepEqual([...familiesIn('I am not only OpenAI; I am GPT-4o.')].sort(), ['gpt']);
  assert.deepEqual([...familiesIn("I'm not just OpenAI, I'm also Claude.")].sort(), ['claude', 'gpt']);
  assert.deepEqual([...familiesIn('我不只是 OpenAI 的用户，我是 Claude。')].sort(), ['claude', 'gpt']);
});

function qwenSelfResults(): ChatResult[] {
  return [
    okResult('I am qwen2.5-72b-instruct, made by Alibaba.'),
    okResult('我是 qwen2.5-72b-instruct，由阿里巴巴开发。'),
    okResult("I'm the qwen2.5-72b-instruct model."),
    okResult('我来自阿里巴巴的 qwen2.5-72b-instruct。'),
    okResult('qwen2.5-72b-instruct is my model name.'),
  ];
}

test('identity: 目标 gpt 的端点 5 条 "I am Claude, not OpenAI." → 只声明 claude → falsified fail 0', async () => {
  // 红队实证：不识别否定时该句会同时声明 {claude, gpt}，与期望族 gpt 有交集 → 换壳检测失效、假通过。
  const sentence = 'I am Claude, not OpenAI.';
  const { client } = stubClient([...Array.from({ length: 5 }, () => okResult(sentence)), schemaOk()]);
  const ctx = makeCtx(client, { model: 'gpt-4o' });
  const outcome = await probeIdentity(ctx);
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.level, 'fail', outcome.headline);
  assert.equal(outcome.score, 0);
  assert.equal(outcome.metrics['families'], 'claude', '被否定的 openai 不得进入声明族集合');
  assert.ok(outcome.findings.some((f) => f.level === 'fail' && /每条有效自述都指向其他模型族/.test(f.message)));
});

test('identity: 目标 gpt-4o 的端点 "I am GPT-4o, not Claude."（否定 claude）→ pass 100（不误伤）', async () => {
  // 句式多样化：5 条逐字一致会另触发「逐字一致」模板嫌疑（与否定语义无关），干扰本用例目标
  const results = [
    okResult('I am GPT-4o, not Claude.'),
    okResult("I'm GPT-4o, definitely not Claude."),
    okResult('我是 GPT-4o，不是 Claude。'),
    okResult('Model: GPT-4o (not Claude).'),
    okResult('I am GPT-4o, and Claude is not me.'),
    schemaOk(),
  ];
  const { client } = stubClient(results);
  const ctx = makeCtx(client, { model: 'gpt-4o' });
  const outcome = await probeIdentity(ctx);
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.level, 'pass', outcome.headline);
  assert.equal(outcome.score, 100);
  assert.equal(outcome.metrics['families'], 'gpt');
});

// ---------- 2026-10-18 审计缺陷 ⑤：回显删节（裁掉非日期/非官方别名后缀 = 只认领了更小变体） ----------

test('identity: 请求 qwen2.5-72b-instruct、回显 qwen2.5 → suspicious（warn 60，不得当一致）', async () => {
  // 真机实证（2026-10-18）：上游把 72b-instruct 规范化掉后回显 qwen2.5——裁掉的是能力变体而非日期钉版。
  const echo = (results: ChatResult[], model: string): ChatResult[] => results.map((r) => ({ ...r, model }));
  const { client } = stubClient(echo([...qwenSelfResults(), schemaOk()], 'qwen2.5'));
  const ctx = makeCtx(client, { model: 'qwen2.5-72b-instruct' });
  const outcome = await probeIdentity(ctx);
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.level, 'warn', outcome.headline);
  assert.equal(outcome.score, 60);
  assert.equal(outcome.metrics['model_echo'], '0/6');
  assert.equal(outcome.metrics['model_echo_values'], 'qwen2.5');
  assert.ok(outcome.findings.some((f) => f.level === 'warn' && /上游回显/.test(f.message)), JSON.stringify(outcome.findings));
});

test('identity: 请求 glm-5.3-flash、回显 glm-5.3 → suspicious（warn 60）', async () => {
  const echo = (results: ChatResult[], model: string): ChatResult[] => results.map((r) => ({ ...r, model }));
  const { client } = stubClient(echo([...glmNoVersionSelfResults(), schemaOk()], 'glm-5.3'));
  const ctx = makeCtx(client, { model: 'glm-5.3-flash' });
  const outcome = await probeIdentity(ctx);
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.level, 'warn', outcome.headline);
  assert.equal(outcome.score, 60);
  assert.equal(outcome.metrics['model_echo'], '0/6');
  assert.equal(outcome.metrics['model_echo_values'], 'glm-5.3');
});

test('identity: 所有自述请求 503 → insufficient 且标题带端点/网关归因（不再只说「全部失败」）', async () => {
  // xianyu1 实测：13s 过载窗口内 6 笔自述全 503 → 旧标题「自述请求全部失败」没说清是谁的问题；
  // 新口径由 failureDigest 归因为「端点/网关拒绝」并给出原始错误详情。
  const client: OpenAIClient = {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(): Promise<ChatResult> {
      return {
        ok: false,
        status: 503,
        finishReason: null,
        model: null,
        text: '',
        reasoning: null,
        usage: null,
        usageRejected: null,
        attempts: 2,
        toolCalls: [],
        ttftMs: null,
        durationMs: 1,
        error: 'HTTP 503: system cpu overloaded (current: 100.0%, threshold: 90%)',
        raw: '',
      };
    },
  };
  const outcome = await probeIdentity(makeCtx(client));
  assert.equal(outcome.status, 'insufficient');
  assert.equal(outcome.score, null);
  assert.equal(outcome.level, 'unknown');
  assert.match(outcome.headline, /端点\/网关拒绝（\d+\/\d+ 笔）：HTTP 503: system cpu overloaded/);
  assert.ok(!/自述请求全部失败/.test(outcome.headline), `headline=${outcome.headline}`);
});
