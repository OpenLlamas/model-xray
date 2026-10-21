import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAnswer, generateQuestions, probeQuality, type Question } from '../../src/probes/quality.js';
import { createEvidenceRecorder } from '../../src/evidence.js';
import { createRng } from '../../src/random.js';
import type { ChatRequest, ChatResult, OpenAIClient, ProbeCtx, RunConfig } from '../../src/types.js';

function question(answer: number, exclusive: number[] | null = null): Question {
  return { id: 'q1', prompt: '只回答数字。', answer, exclusive, control: false };
}

test('checkAnswer: thousands-separated answers count as correct (model answers "7,718")', () => {
  // 修复前：-?\d+ 切分把 "7,718" 拆成 7 与 718 两个数，漏判正确答案
  assert.ok(checkAnswer('答案是 7,718。', question(7718)));
  assert.ok(checkAnswer('1,234', question(1234)));
  assert.ok(checkAnswer('12,345,678', question(12345678)));
});

test('checkAnswer: plain digits keep working after comma normalization', () => {
  assert.ok(checkAnswer('7718', question(7718)));
  assert.ok(checkAnswer('答案是 7718', question(7718)));
});

test('checkAnswer: negative numbers unaffected by comma regex', () => {
  assert.ok(checkAnswer('-42', question(-42)));
  assert.ok(checkAnswer('-4,200', question(-4200)));
});

test('checkAnswer: wrong value still rejected (no false positive from comma strip)', () => {
  assert.ok(!checkAnswer('7,719', question(7718)));
  assert.ok(!checkAnswer('718', question(7718)));
  assert.ok(!checkAnswer('无数字', question(7718)));
  // 小数整体解析：整数题答 42.5 不因包含 42 被判对；42.0 等于整数 42，仍算对
  assert.ok(!checkAnswer('42.5', question(42)));
  assert.ok(checkAnswer('42.0', question(42)));
});

test('checkAnswer: exclusive distractor still blocks (comma-aware both sides)', () => {
  assert.ok(!checkAnswer('7,718 或 7,719', question(7718, [7719])));
  assert.ok(checkAnswer('7,718 或 9,999', question(7718, [7719])));
});

// ---------- v0.2.2 复采样抗噪（F1）：脚本化 stub 驱动 probeQuality ----------

const SEED = 4242;

function okResult(text: string, finishReason = 'stop'): ChatResult {
  return {
    ok: true,
    status: 200,
    finishReason,
    model: null,
    text,
    reasoning: null,
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    usageRejected: null,
    attempts: 1,
    toolCalls: [],
    ttftMs: null,
    durationMs: 1,
    error: null,
    raw: '',
  };
}

function starvedResult(text = ''): ChatResult {
  return okResult(text, 'length');
}

function failedResult(text = ''): ChatResult {
  return {
    ok: false,
    status: 500,
    finishReason: null,
    model: null,
    text,
    reasoning: null,
    usage: null,
    usageRejected: null,
    attempts: 1,
    toolCalls: [],
    ttftMs: null,
    durationMs: 1,
    error: 'boom',
    raw: '',
  };
}

const rightAnswer = (q: Question): ChatResult => okResult(String(q.answer));
const wrongAnswer = (q: Question): ChatResult => okResult(String(q.answer + 1));

/**
 * 脚本化 stub：按题面把请求路由回题目对象（probeQuality 用 createRng(seed) 生成题集，
 * 测试用同 seed 复现同一份题集与同一批题面）。script 拿到题目与完整请求，返回响应。
 */
function scriptedQuality(script: (q: Question, req: ChatRequest) => ChatResult): {
  client: OpenAIClient;
  requests: ChatRequest[];
  questions: Question[];
} {
  const questions = generateQuestions(createRng(SEED));
  const byPrompt = new Map(questions.map((q) => [q.prompt, q]));
  const requests: ChatRequest[] = [];
  const client: OpenAIClient = {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(req: ChatRequest): Promise<ChatResult> {
      requests.push(req);
      const prompt = String(req.messages[0]?.content ?? '');
      const q = byPrompt.get(prompt);
      if (!q) throw new Error(`stub client: unknown prompt ${prompt.slice(0, 30)}`);
      return script(q, req);
    },
  };
  return { client, requests, questions };
}

function qualityCtx(client: OpenAIClient): ProbeCtx {
  const cfg: RunConfig = {
    baseUrl: 'http://127.0.0.1:0/v1',
    apiKey: 'k',
    model: 'gpt-4o',
    claimedContext: null,
    expect: [],
    deep: false,
    seed: SEED,
    timeoutMs: 1000,
    retries: 0,
    streamFallback: false,
    outDir: 'reports',
    html: false,
    yes: true,
    quiet: true,
  };
  return { client, cfg, rng: createRng(SEED), evidence: createEvidenceRecorder() };
}

const isMain = (q: Question): boolean => !q.control;

test('quality: non-stream blank falls back to stream once, recovers answer, and is disclosed', async () => {
  const firstMain = generateQuestions(createRng(SEED)).find(isMain) as Question;
  const { client, requests } = scriptedQuality((q, req) => {
    if (q.id === firstMain.id && req.stream !== true) {
      return { ...okResult(''), finishReason: null, error: 'empty stream' };
    }
    return rightAnswer(q);
  });
  const ctx = qualityCtx(client);
  ctx.cfg.streamFallback = true;
  const outcome = await probeQuality(ctx);
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.score, 100);
  assert.equal(outcome.metrics['blank_retried'], 1);
  assert.equal(outcome.metrics['stream_fallbacks'], 1);
  assert.equal(requests.length, 16);
  assert.equal(requests.filter((r) => r.stream === true).length, 1);
  assert.ok(outcome.findings.some((f) => f.level === 'info' && /流式回退/.test(f.message)), JSON.stringify(outcome.findings));
});

test('quality F1: starved main question → no resample, excluded from denominator (client call count anchor)', async () => {
  const firstMain = generateQuestions(createRng(SEED)).find(isMain) as Question;
  const { client, requests } = scriptedQuality((q, req) => {
    if (q.id === firstMain.id && req.temperature === 0) return starvedResult('');
    return rightAnswer(q);
  });
  const outcome = await probeQuality(qualityCtx(client));
  // 15 题 + 该题升预算重试 1 次 = 16；starved 分支绝不触发复采样（无 temperature 0.7 请求）
  assert.equal(requests.length, 16, `实际 ${requests.length} 次请求`);
  assert.equal(requests.filter((r) => r.temperature === 0.7).length, 0);
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.score, 100);
  assert.equal(outcome.metrics['excluded'], 1);
  assert.equal(outcome.metrics['main'], '11/11');
  assert.equal(outcome.metrics['retried'], undefined, 'starved 不得进复采样计数');
});

test('quality F1: unavailable main question → no resample, excluded from denominator', async () => {
  const firstMain = generateQuestions(createRng(SEED)).find(isMain) as Question;
  const { client, requests } = scriptedQuality((q) => {
    if (q.id === firstMain.id) return failedResult();
    return rightAnswer(q);
  });
  const outcome = await probeQuality(qualityCtx(client));
  assert.equal(requests.length, 15, '请求失败不重试、不复采样');
  assert.equal(requests.filter((r) => r.temperature === 0.7).length, 0);
  assert.equal(outcome.metrics['unavailable'], 1);
  assert.equal(outcome.metrics['main'], '11/11');
  assert.equal(outcome.metrics['retried'], undefined);
});

test('quality F1: failed response with partial answer text still counts unavailable (not correct)', async () => {
  // 上游错误载荷可能残留含答案的残缺正文（client 保留 partial 证据）；但请求未成功
  // 不得据此计为答对，否则端点故障会被残缺证据洗白。
  const firstMain = generateQuestions(createRng(SEED)).find(isMain) as Question;
  const { client, requests } = scriptedQuality((q) => {
    if (q.id === firstMain.id) return failedResult(String(q.answer));
    return rightAnswer(q);
  });
  const outcome = await probeQuality(qualityCtx(client));
  assert.equal(outcome.metrics['unavailable'], 1);
  assert.equal(outcome.metrics['main'], '11/11');
  assert.equal(outcome.score, 100);
  assert.equal(requests.filter((r) => r.temperature === 0.7).length, 0);
});

test('quality F1: failed control response with partial answer text does not pass controls', async () => {
  const control = generateQuestions(createRng(SEED)).find((q) => q.control) as Question;
  const { client, requests } = scriptedQuality((q) => (q.id === control.id ? failedResult(String(q.answer)) : rightAnswer(q)));
  const outcome = await probeQuality(qualityCtx(client));
  assert.equal(outcome.status, 'insufficient');
  assert.equal(outcome.score, null);
  assert.equal(outcome.metrics['controls'], '2/3');
  assert.match(outcome.headline, /控制题未全对（2\/3）/);
  assert.equal(requests.filter((r) => r.temperature === 0.7).length, 0);
});

test('quality F1: clean wrong first answer + correct resample (temperature 0.7) → pass@1 main, recovered disclosed', async () => {
  const target = generateQuestions(createRng(SEED)).find(isMain) as Question;
  const { client, requests } = scriptedQuality((q, req) => {
    if (q.id === target.id && req.temperature === 0.7) return rightAnswer(q);
    if (q.id === target.id) return wrongAnswer(q);
    return rightAnswer(q);
  });
  const outcome = await probeQuality(qualityCtx(client));
  assert.equal(outcome.status, 'ok');
  // pass@1 主口径：11/12 首答正确 = 0.9167 ≥ 0.9 → pass 92；复采样恢复不改判 pass（由首答自达线）
  assert.equal(outcome.level, 'pass');
  assert.equal(outcome.score, 92);
  assert.equal(outcome.metrics['main'], '11/12', 'metrics.main = pass@1 首答口径');
  assert.equal(outcome.metrics['main_recovered'], '12/12', 'metrics.main_recovered = 两次机会口径');
  assert.equal(outcome.metrics['retried'], 1);
  assert.equal(outcome.metrics['recovered'], 1);
  assert.equal(outcome.metrics['metric_version'], 'pass1');
  const info = outcome.findings.find((f) => f.level === 'info' && /首答错误、复采样/.test(f.message));
  assert.ok(info, JSON.stringify(outcome.findings));
  assert.equal(info?.evidenceIds.length, 2, '证据必须含首答与复采样两条');
  const resample = requests.find((r) => r.temperature === 0.7) as ChatRequest;
  assert.equal(resample.max_tokens, 256, '首答未升预算 → 复采样沿用基础预算');
  assert.equal(resample.messages[0]?.content, target.prompt, '复采样必须同题同 messages');
});

test('quality F1: once a wrong first answer retried at 512 → resample reuses the retry budget', async () => {
  // 首答 starved → 升 512 重试后拿到答案但答错（干净答错）→ 复采样预算应为 512
  const target = generateQuestions(createRng(SEED)).find(isMain) as Question;
  const { client, requests } = scriptedQuality((q, req) => {
    if (q.id !== target.id) return rightAnswer(q);
    if (req.temperature === 0.7) return rightAnswer(q);
    if (req.max_tokens === 256) return starvedResult('');
    return wrongAnswer(q);
  });
  const outcome = await probeQuality(qualityCtx(client));
  const resample = requests.find((r) => r.temperature === 0.7) as ChatRequest;
  assert.equal(resample.max_tokens, 512, '复采样必须沿用首答最终生效预算');
  assert.equal(outcome.metrics['recovered'], 1);
  assert.equal(outcome.metrics['main'], '11/12');
  assert.equal(outcome.metrics['main_recovered'], '12/12');
});

test('quality F1: starved resample whose truncated body already contains the answer still counts correct', async () => {
  const target = generateQuestions(createRng(SEED)).find(isMain) as Question;
  const { client } = scriptedQuality((q, req) => {
    if (q.id !== target.id) return rightAnswer(q);
    if (req.temperature === 0.7) return starvedResult(String(q.answer));
    return wrongAnswer(q);
  });
  const outcome = await probeQuality(qualityCtx(client));
  assert.equal(outcome.metrics['main'], '11/12');
  assert.equal(outcome.metrics['main_recovered'], '12/12');
  assert.equal(outcome.metrics['recovered'], 1);
  assert.ok(outcome.findings.some((f) => f.level === 'info' && /复采样/.test(f.message)));
});

test('quality F1: resample still wrong (clean) → stays wrong with re-sample copy', async () => {
  const target = generateQuestions(createRng(SEED)).find(isMain) as Question;
  const { client } = scriptedQuality((q, req) => {
    if (q.id === target.id) return wrongAnswer(q);
    return rightAnswer(q);
  });
  const outcome = await probeQuality(qualityCtx(client));
  assert.equal(outcome.metrics['main'], '11/12');
  assert.equal(outcome.metrics['retried'], 1);
  assert.equal(outcome.metrics['recovered'], undefined);
  const warn = outcome.findings.find((f) => f.level === 'warn' && /复采样仍错/.test(f.message));
  assert.ok(warn, JSON.stringify(outcome.findings));
  assert.equal(warn?.evidenceIds.length, 2);
});

test('quality F1: failed/starved resample without usable answer → stays wrong with honest copy', async () => {
  const target = generateQuestions(createRng(SEED)).find(isMain) as Question;
  const { client } = scriptedQuality((q, req) => {
    if (q.id !== target.id) return rightAnswer(q);
    if (req.temperature === 0.7) return failedResult();
    return wrongAnswer(q);
  });
  const outcome = await probeQuality(qualityCtx(client));
  assert.equal(outcome.metrics['main'], '11/12');
  assert.equal(outcome.metrics['retried'], 1);
  assert.equal(outcome.metrics['recovered'], undefined);
  assert.ok(
    outcome.findings.some((f) => f.level === 'warn' && /复采样未产出可用答案/.test(f.message)),
    JSON.stringify(outcome.findings),
  );
});

test('quality F1: failed resample with partial answer text still cannot count as recovered', async () => {
  // 与失败首答同口径：ok=false 的残缺正文即使含答案也不得洗白复采样。
  const target = generateQuestions(createRng(SEED)).find(isMain) as Question;
  const { client } = scriptedQuality((q, req) => {
    if (q.id !== target.id) return rightAnswer(q);
    if (req.temperature === 0.7) return failedResult(String(q.answer));
    return wrongAnswer(q);
  });
  const outcome = await probeQuality(qualityCtx(client));
  assert.equal(outcome.metrics['main'], '11/12');
  assert.equal(outcome.metrics['recovered'], undefined);
  assert.ok(
    outcome.findings.some((f) => f.level === 'warn' && /复采样未产出可用答案/.test(f.message)),
    JSON.stringify(outcome.findings),
  );
});

test('quality F1 pass@1: all 12 mains first-wrong + resample recovered → warn 80（复采洗白封顶），recovery-rate info 保留', async () => {
  const { client } = scriptedQuality((q, req) => {
    if (req.temperature === 0.7) return rightAnswer(q);
    return q.control ? rightAnswer(q) : wrongAnswer(q);
  });
  const outcome = await probeQuality(qualityCtx(client));
  assert.equal(outcome.status, 'ok');
  // pass@1：首答 0/12 < 0.6；两次机会 12/12 ≥ 0.6 → 随机失误不定罪降 warn，但封顶 80
  assert.equal(outcome.level, 'warn', '首答全错不得判 pass');
  assert.equal(outcome.score, 80);
  assert.match(outcome.headline, /首答仅 0\/12，复采样恢复至 12\/12/);
  assert.equal(outcome.metrics['main'], '0/12');
  assert.equal(outcome.metrics['main_recovered'], '12/12');
  assert.equal(outcome.metrics['retried'], 12);
  assert.equal(outcome.metrics['recovered'], 12);
  assert.ok(outcome.findings.some((f) => f.level === 'info' && /恢复率异常高/.test(f.message)));
});

test('quality F1 pass@1 boundary: 5/12 recovered（首答 7/12=0.583<0.6）→ rescued warn 80；首答自达 0.9 线时 recovered 不阻碍 pass', async () => {
  const questions = generateQuestions(createRng(SEED));
  const mainsList = questions.filter(isMain);
  const fiveIds = new Set(mainsList.slice(0, 5).map((q) => q.id));

  // 首答 7/12 = 0.583 < 0.6，复采样 5/5 全恢复（两次机会 12/12 ≥ 0.6）→ rescued warn 封顶 80
  const five = scriptedQuality((q, req) => {
    if (req.temperature === 0.7 || !fiveIds.has(q.id)) return rightAnswer(q);
    return wrongAnswer(q);
  });
  const below = await probeQuality(qualityCtx(five.client));
  assert.equal(below.level, 'warn', below.headline);
  assert.equal(below.score, 80);
  assert.match(below.headline, /首答仅 7\/12，复采样恢复至 12\/12/);
  assert.ok(!below.findings.some((f) => /恢复率异常高/.test(f.message)), 'firstCorrect=7 > 6 → 不触发恢复率 info');

  // 首答 11/12 = 0.9167 ≥ 0.9 且 1 题复采样恢复 → pass（pass 只看首答，恢复仅披露）
  const oneId = new Set(mainsList.slice(0, 1).map((q) => q.id));
  const one = scriptedQuality((q, req) => {
    if (req.temperature === 0.7 || !oneId.has(q.id)) return rightAnswer(q);
    return wrongAnswer(q);
  });
  const above = await probeQuality(qualityCtx(one.client));
  assert.equal(above.level, 'pass', above.headline);
  assert.equal(above.score, 92);
  assert.match(above.headline, /复采样恢复 1 题/);
});

test('quality F1: control question wrong → insufficient, no resample triggered for controls', async () => {
  const control = generateQuestions(createRng(SEED)).find((q) => q.control) as Question;
  const { client, requests } = scriptedQuality((q) => {
    if (q.id === control.id) return wrongAnswer(q);
    return rightAnswer(q);
  });
  const outcome = await probeQuality(qualityCtx(client));
  assert.equal(requests.filter((r) => r.temperature === 0.7).length, 0, '控制题不得触发复采样');
  assert.equal(outcome.status, 'insufficient');
  assert.equal(outcome.score, null);
  assert.match(outcome.headline, /控制题未全对/);
});

// ---------- 评分档位 / 剔除分支补齐（每个出口都有断言） ----------

const mains = (): Question[] => generateQuestions(createRng(SEED)).filter(isMain);

test('quality scoring: all 12 mains clean-wrong and resample wrong → fail 0 with 疑似降智 headline', async () => {
  const { client, requests } = scriptedQuality((q) => (q.control ? rightAnswer(q) : wrongAnswer(q)));
  const outcome = await probeQuality(qualityCtx(client));
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.level, 'fail');
  assert.equal(outcome.score, 0);
  assert.match(outcome.headline, /疑似降智/);
  assert.equal(outcome.metrics['controls'], '3/3');
  assert.equal(requests.length, 27, '12 主问题 ×(首答+复采样) + 3 控制题');
});

test('quality scoring: 8/12 correct → warn 67 with wrong-topic list', async () => {
  const wrongIds = new Set(mains().slice(0, 4).map((q) => q.id));
  const { client } = scriptedQuality((q) => (q.control || !wrongIds.has(q.id) ? rightAnswer(q) : wrongAnswer(q)));
  const outcome = await probeQuality(qualityCtx(client));
  assert.equal(outcome.level, 'warn');
  assert.equal(outcome.score, 67);
  assert.match(outcome.headline, /质量未达通过线：首答 8\/12，错误集中在/);
});

test('quality scoring: accuracy carries a 95% Wilson CI disclosure (metrics + info finding, thresholds unchanged)', async () => {
  const wrongIds = new Set(mains().slice(0, 4).map((q) => q.id));
  const { client } = scriptedQuality((q) => (q.control || !wrongIds.has(q.id) ? rightAnswer(q) : wrongAnswer(q)));
  const outcome = await probeQuality(qualityCtx(client));
  // 0.9/0.6 判定阈值口径不变：8/12 ≈ 0.667 仍是 warn 67
  assert.equal(outcome.level, 'warn');
  assert.equal(outcome.score, 67);
  const low = outcome.metrics['accuracy_ci95_low'] as number;
  const high = outcome.metrics['accuracy_ci95_high'] as number;
  assert.ok(Number.isFinite(low) && Number.isFinite(high), `CI metrics=[${low}, ${high}]`);
  assert.ok(low >= 0 && high <= 1 && low < high, `CI=[${low}, ${high}] 必须为有序 [0,1] 区间`);
  assert.ok(low < 8 / 12 && 8 / 12 < high, `CI=[${low}, ${high}] 必须覆盖点估计 8/12`);
  // 12 题样本的区间必然较宽 → 披露 finding 须提示置信度有限
  const ciFinding = outcome.findings.find((f) => f.level === 'info' && /置信区间/.test(f.message));
  assert.ok(ciFinding, JSON.stringify(outcome.findings));
  assert.match(ciFinding?.message ?? '', /样本量偏小|置信度有限/);
});

test('quality insufficient: all mains starved → 0-usable branch (not a 0-score accusation)', async () => {
  const { client } = scriptedQuality((q) => (q.control ? rightAnswer(q) : starvedResult('')));
  const outcome = await probeQuality(qualityCtx(client));
  assert.equal(outcome.status, 'insufficient');
  assert.equal(outcome.score, null);
  assert.match(outcome.headline, /主问题全部被剔除/);
  assert.equal(outcome.metrics['main'], '0/0');
});

test('quality insufficient: usable 9/12 falls below the 80% denominator threshold', async () => {
  const starvedIds = new Set(mains().slice(0, 3).map((q) => q.id));
  const { client } = scriptedQuality((q) => (starvedIds.has(q.id) ? starvedResult('') : rightAnswer(q)));
  const outcome = await probeQuality(qualityCtx(client));
  assert.equal(outcome.status, 'insufficient');
  assert.equal(outcome.score, null);
  assert.match(outcome.headline, /有效样本不足（9\/12，其余因3 题推理占满预算剔除）/);
});

test('quality insufficient: starved control → dedicated control-starved headline', async () => {
  const control = generateQuestions(createRng(SEED)).find((q) => q.control) as Question;
  const { client } = scriptedQuality((q) => (q.id === control.id ? starvedResult('') : rightAnswer(q)));
  const outcome = await probeQuality(qualityCtx(client));
  assert.equal(outcome.status, 'insufficient');
  assert.match(outcome.headline, /控制题未产出答案（1 题推理占满预算未作答）/);
});

test('quality insufficient: failed control request → unavailable copy with the upstream error', async () => {
  const control = generateQuestions(createRng(SEED)).find((q) => q.control) as Question;
  const { client } = scriptedQuality((q) => (q.id === control.id ? failedResult() : rightAnswer(q)));
  const outcome = await probeQuality(qualityCtx(client));
  assert.equal(outcome.status, 'insufficient');
  assert.match(outcome.headline, /控制题未全对（2\/3）/);
  assert.ok(
    outcome.findings.some((f) => f.level === 'warn' && /请求失败 boom/.test(f.message)),
    JSON.stringify(outcome.findings),
  );
});

test('quality: starved main whose truncated body already contains the answer counts correct, no resample', async () => {
  const target = mains()[0] as Question;
  const { client, requests } = scriptedQuality((q) => (q.id === target.id ? starvedResult(String(q.answer)) : rightAnswer(q)));
  const outcome = await probeQuality(qualityCtx(client));
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.score, 100);
  assert.equal(outcome.metrics['main'], '12/12');
  assert.equal(outcome.metrics['excluded'], 0);
  assert.equal(requests.filter((r) => r.temperature === 0.7).length, 0, '截断正文已含答案 → 不触发复采样');
  assert.equal(outcome.metrics['retried'], undefined);
});

test('quality pass headline discloses starved exclusions when scoring still proceeds', async () => {
  const target = mains()[0] as Question;
  const { client } = scriptedQuality((q) => (q.id === target.id ? starvedResult('') : rightAnswer(q)));
  const outcome = await probeQuality(qualityCtx(client));
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.score, 100);
  assert.match(outcome.headline, /另有 1 题因推理占满预算剔除分母/);
});

test('quality: HTTP 200 blank answers are excluded (not wrong, no resample), controls make result unreliable', async () => {
  // 2026-10-18 真机回归：空响应曾被计入「答错」并触发复采样；空响应没有答案可判。
  const { client, requests } = scriptedQuality(() => okResult(''));
  const outcome = await probeQuality(qualityCtx(client));
  assert.equal(outcome.status, 'insufficient');
  assert.equal(outcome.level, 'unknown');
  assert.equal(outcome.score, null);
  assert.equal(outcome.metrics['empty'], 15);
  assert.equal(outcome.metrics['main'], '0/0');
  assert.equal(outcome.metrics['retried'], undefined, '空响应不得触发复采样');
  assert.equal(requests.filter((r) => r.temperature === 0.7).length, 0, '空响应不得触发复采样');
  assert.match(outcome.headline, /空响应/);
  assert.ok(!outcome.findings.some((f) => f.level === 'fail'), JSON.stringify(outcome.findings));
});
