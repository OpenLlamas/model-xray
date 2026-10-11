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
  // starved 无效 → 有效样本 2 个（<3），不触发逐字一致 WARN，starved 记入无效样本。
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
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.score, 100);
  assert.equal(outcome.level, 'pass');
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
  assert.ok(outcome.findings.some((f) => f.level === 'fail' && /每次自述都指向其他模型族/.test(f.message)));
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

// ---------- 真实事故回归：全程自述他族不再「假清白」（某中转站 事故） ----------

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
  assert.ok(outcome.findings.some((f) => f.level === 'fail' && /每次自述都指向其他模型族/.test(f.message)));
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
