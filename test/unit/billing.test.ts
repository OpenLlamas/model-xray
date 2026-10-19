import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { applyRatioDecision, decideRatio, probeBilling, type RatioArgs, type RatioDecision } from '../../src/probes/billing.js';
import type { BalanceReading, } from '../../src/balance.js';
import { createEvidenceRecorder } from '../../src/evidence.js';
import { createRng } from '../../src/random.js';
import { estimateMessageTokens } from '../../src/tokens.js';
import { PROBESET_VERSION } from '../../src/assets.js';
import type { TokenReference } from '../../src/token-reference.js';
import type { ChatRequest, ChatResult, OpenAIClient, ProbeCtx, RunConfig } from '../../src/types.js';

function reading(patch: Partial<BalanceReading> = {}): BalanceReading {
  return {
    value: 0,
    kind: 'spent_total',
    unit: 'USD',
    endpoint: '/dashboard/billing/usage',
    currency: null,
    ...patch,
  };
}

function args(patch: Partial<RatioArgs> = {}): RatioArgs {
  return {
    before: reading({ value: 1.0 }),
    after: reading({ value: 2.0 }),
    spendDelta: 1.0,
    expectedCost: 1.0,
    ratioDropped: 0,
    regressionLevel: 'pass',
    ...patch,
  };
}

test('decideRatio N/A: balance endpoint unavailable (before/after null)', () => {
  for (const patch of [{ before: null }, { after: null }]) {
    const decision = decideRatio(args(patch));
    assert.equal(decision?.verdict, 'N/A');
    assert.equal(decision?.cap, null);
    assert.equal(decision?.ratio, null);
    assert.equal(decision?.finding.level, 'info');
  }
  assert.match(decideRatio(args({ before: null }))?.finding.message ?? '', /余额端点不可用/);
});

test('decideRatio N/A: two readings from different sources', () => {
  const decision = decideRatio(args({ spendDelta: null }));
  assert.equal(decision?.verdict, 'N/A');
  assert.match(decision?.finding.message ?? '', /不同源/);
});

test('decideRatio N/A: non-USD balance unit (one-api quota) cannot compare with USD expectedCost', () => {
  // 2026-10-18 真机：/api/user/self 返回 quota 单位余额，quota 差值 ÷ 美元应缴会产出天文倍率误报
  const decision = decideRatio(
    args({
      before: reading({ value: 5_000_000, kind: 'balance', unit: 'quota', endpoint: '/api/user/self' }),
      after: reading({ value: 4_000_000, kind: 'balance', unit: 'quota', endpoint: '/api/user/self' }),
      spendDelta: 1_000_000,
      expectedCost: 0.01,
    }),
  );
  assert.equal(decision?.verdict, 'N/A');
  assert.equal(decision?.ratio, null);
  assert.equal(decision?.cap, null);
  assert.match(decision?.finding.message ?? '', /非美元口径/);
});

test('decideRatio N/A: delta below 3x reading resolution is precision noise', () => {
  const decision = decideRatio(
    args({
      spendDelta: 0.015,
      expectedCost: 0.01,
      before: reading({ value: 1.015, resolution: 0.01 }),
      after: reading({ value: 1.0, resolution: 0.01 }),
    }),
  );
  assert.equal(decision?.verdict, 'N/A');
  assert.equal(decision?.ratio, null);
  assert.match(decision?.finding.message ?? '', /分辨率/);
});

test('decideRatio N/A: expected cost below 3x resolution is unmeasurable (142x real-world false fail)', () => {
  // 2026-10-18 真机：Δ=2.6928 USD 看似远超分辨率，但应缴仅 $0.019，低于 3×$0.01；
  // 账户级抖动/舍入足以把倍率推到 142.975，不能据此判 fail。
  const decision = decideRatio(
    args({
      spendDelta: 2.692814,
      expectedCost: 0.019,
      before: reading({ value: 130.586184, resolution: 0.01 }),
      after: reading({ value: 133.278998, resolution: 0.01 }),
    }),
  );
  assert.equal(decision?.verdict, 'N/A');
  assert.equal(decision?.ratio, null);
  assert.equal(decision?.cap, null);
  assert.match(decision?.finding.message ?? '', /应缴|分辨率|无法可靠/);
});

test('decideRatio: delta well above reading resolution is still judged normally', () => {
  const decision = decideRatio(
    args({
      spendDelta: 0.9,
      expectedCost: 1,
      before: reading({ value: 1.9, resolution: 0.01 }),
      after: reading({ value: 1.0, resolution: 0.01 }),
    }),
  );
  assert.equal(decision?.verdict, 'ok');
  assert.equal(decision?.ratio, 0.9);
});

test('decideRatio: 0.5x-0.8x underpayment is warn, not "consistent with price"', () => {
  // 低报 20%-50% 方向对用户有利，但不能算「与宣称价格一致」：
  // 可能是 usage 少计/单位错配/账户抵扣；必须 warn 阻止 PASS（2026-10-19 复盘）。
  const decision = decideRatio(args({ spendDelta: 0.6, expectedCost: 1 }));
  assert.equal(decision?.verdict, 'warn');
  assert.equal(decision?.ratio, 0.6);
  assert.equal(decision?.cap, null);
  assert.match(decision?.finding.message ?? '', /少计|单位错配|抵扣/);
});

test('decideRatio N/A: zero delta (granularity / delayed billing)', () => {
  const decision = decideRatio(args({ spendDelta: 0, expectedCost: 1 }));
  assert.equal(decision?.verdict, 'N/A');
  assert.match(decision?.finding.message ?? '', /粒度不足或消费延迟入账/);
});

test('decideRatio N/A: negative delta (suspected recharge interference)', () => {
  const decision = decideRatio(args({ spendDelta: -0.5, expectedCost: 1 }));
  assert.equal(decision?.verdict, 'N/A');
  assert.match(decision?.finding.message ?? '', /充值/);
});

test('decideRatio N/A: no usable usage records (expectedCost zero)', () => {
  const decision = decideRatio(args({ expectedCost: 0 }));
  assert.equal(decision?.verdict, 'N/A');
  assert.match(decision?.finding.message ?? '', /无有效 usage/);
});

test('decideRatio N/A: non-finite ratio (overflowing balance/usage readings)', () => {
  const decision = decideRatio(args({ spendDelta: 1e308, expectedCost: 1e-300 }));
  assert.equal(decision?.verdict, 'N/A');
  assert.equal(decision?.cap, null);
  assert.equal(decision?.ratio, null);
  assert.match(decision?.finding.message ?? '', /越界/);
});

test('decideRatio N/A: negative expectedCost (defensive, prices are validated non-negative upstream)', () => {
  const decision = decideRatio(args({ expectedCost: -1 }));
  assert.equal(decision?.verdict, 'N/A');
  assert.match(decision?.finding.message ?? '', /无有效 usage/);
});

test('decideRatio underflow: ratio rounds to 0, pinned to unit-mismatch warn (not N/A)', () => {
  const decision = decideRatio(args({ spendDelta: 1e-308, expectedCost: 1e308 }));
  assert.equal(decision?.verdict, 'warn');
  assert.match(decision?.finding.message ?? '', /单位错配/);
});

test('decideRatio masked dual-code: dropped usage masks an underlying fail, surfaced via maskedVerdict', () => {
  // 偏差推演：2 笔 usage 缺失 → 这些请求的应缴金额未计入 expectedCost → 分母偏小 → ratio 上偏
  //（只能把档位往 fail 方向高判，采信会冤枉端点）。无缺失重算：ratio = 3/1.5 = 2.0 > 1.5
  // 且 regressionLevel='fail' → 底层档位 fail（下限推理仍成立，因为上偏只会更高）。
  // 因此 verdict 保守降为 ok/info，但事实经 maskedVerdict 双码透出，CI 可见不被静默吞掉。
  const decision = decideRatio(args({ spendDelta: 3, expectedCost: 1.5, ratioDropped: 2, regressionLevel: 'fail' }));
  assert.equal(decision?.verdict, 'ok');
  assert.equal(decision?.finding.level, 'info');
  assert.equal(decision?.maskedVerdict, 'fail');
  assert.match(decision?.finding.message ?? '', /usage 缺失/);
  assert.match(decision?.finding.message ?? '', /底层档位为 fail/);
});

test('decideRatio masked dual-code: underlying warn tier also surfaced (ratio in (1.1,1.5])', () => {
  const decision = decideRatio(args({ spendDelta: 1.3, expectedCost: 1, ratioDropped: 1 }));
  assert.equal(decision?.verdict, 'ok');
  assert.equal(decision?.finding.level, 'info');
  assert.equal(decision?.maskedVerdict, 'warn');
  assert.match(decision?.finding.message ?? '', /底层档位为 warn/);
});

test('decideRatio: dropped usage samples yield reference-only info without cap', () => {
  const decision = decideRatio(args({ ratioDropped: 2 }));
  assert.equal(decision?.verdict, 'ok');
  assert.equal(decision?.cap, null);
  assert.equal(decision?.finding.level, 'info');
  assert.equal(decision?.maskedVerdict, null);
  assert.match(decision?.finding.message ?? '', /2 笔请求 usage 缺失/);
  assert.equal(decision?.ratio, 1.0);
});

test('decideRatio four tiers on healthy regression', () => {
  const fail = decideRatio(args({ spendDelta: 3, expectedCost: 1.5 }));
  assert.equal(fail?.verdict, 'fail');
  assert.equal(fail?.cap, 30);
  assert.equal(fail?.finding.level, 'fail');

  const warn = decideRatio(args({ spendDelta: 1.3, expectedCost: 1 }));
  assert.equal(warn?.verdict, 'warn');
  assert.equal(warn?.cap, 70);
  assert.equal(warn?.finding.level, 'warn');

  const ok = decideRatio(args({ spendDelta: 1.0, expectedCost: 1 }));
  assert.equal(ok?.verdict, 'ok');
  assert.equal(ok?.cap, null);
  assert.equal(ok?.finding.level, 'info');

  const low = decideRatio(args({ spendDelta: 0.4, expectedCost: 1 }));
  assert.equal(low?.verdict, 'warn');
  assert.equal(low?.cap, null);
  assert.equal(low?.finding.level, 'warn');
  assert.match(low?.finding.message ?? '', /单位错配/);
});

test('decideRatio tier boundaries: 1.5 stays warn, 1.1/0.8 stay ok, 0.79 warn', () => {
  assert.equal(decideRatio(args({ spendDelta: 1.5, expectedCost: 1 }))?.verdict, 'warn');
  assert.equal(decideRatio(args({ spendDelta: 1.1, expectedCost: 1 }))?.verdict, 'ok');
  assert.equal(decideRatio(args({ spendDelta: 0.8, expectedCost: 1 }))?.verdict, 'ok');
  assert.equal(decideRatio(args({ spendDelta: 0.79, expectedCost: 1 }))?.verdict, 'warn');
});

test('decideRatio: ratio > 10 is unattributable → N/A + masked fail + warn (no false fail)', () => {
  // 账户级余额差值无法区分「真实 238× 计费」与「窗口内其他并发消费/单位错配」；
  // 保留原始倍率与底层 fail 档位供复核，但本次不判 fail。
  const decision = decideRatio(
    args({
      spendDelta: 67.5,
      expectedCost: 0.28292,
      before: reading({ value: 100, resolution: 0.01 }),
      after: reading({ value: 167.5, resolution: 0.01 }),
    }),
  );
  assert.equal(decision?.verdict, 'N/A');
  assert.equal(decision?.cap, null);
  assert.equal(decision?.finding.level, 'warn');
  assert.equal(decision?.maskedVerdict, 'fail');
  assert.ok((decision?.ratio ?? 0) > 200, `ratio=${decision?.ratio}`);
  assert.match(decision?.finding.message ?? '', /无法归因|账户级/);
  assert.match(decision?.finding.message ?? '', /不判 fail/);
});

test('decideRatio on failed regression: ratio>1.5 still fails without cap, else info only', () => {
  const fail = decideRatio(args({ spendDelta: 3, expectedCost: 1.5, regressionLevel: 'fail' }));
  assert.equal(fail?.verdict, 'fail');
  assert.equal(fail?.cap, null);
  assert.equal(fail?.finding.level, 'fail');
  assert.match(fail?.finding.message ?? '', /端点自报 usage/);

  const info = decideRatio(args({ spendDelta: 1.0, expectedCost: 1, regressionLevel: 'fail' }));
  assert.equal(info?.verdict, 'ok');
  assert.equal(info?.cap, null);
  assert.equal(info?.finding.level, 'info');
  assert.match(info?.finding.message ?? '', /倍率无法判定/);
});

test('decideRatio round guard: huge ratios keep magnitude, never degrade to Infinity', () => {
  const huge = decideRatio(args({ spendDelta: 1e300, expectedCost: 1, regressionLevel: 'pass' }));
  assert.equal(huge?.verdict, 'N/A');
  assert.equal(huge?.maskedVerdict, 'fail');
  assert.equal(huge?.finding.level, 'warn');
  assert.match(huge?.finding.message ?? '', /1e\+300/);
  assert.ok(!(huge?.finding.message ?? '').includes('Infinity'), huge?.finding.message);

  // 1e308 * 1000 会溢出为 Infinity：无守卫时消息里会出现 "Infinity"
  const overflow = decideRatio(args({ spendDelta: 1e308, expectedCost: 1, regressionLevel: 'pass' }));
  assert.equal(overflow?.verdict, 'N/A');
  assert.equal(overflow?.maskedVerdict, 'fail');
  assert.match(overflow?.finding.message ?? '', /1e\+308/);
  assert.ok(!(overflow?.finding.message ?? '').includes('Infinity'), overflow?.finding.message);
});

test('applyRatioDecision never composes into a null score', () => {
  const failDecision = decideRatio(args({ spendDelta: 3, expectedCost: 1.5 }))!;
  const kept = applyRatioDecision(null, 'unknown', failDecision);
  assert.equal(kept.score, null);
  assert.equal(kept.level, 'unknown');

  const noDecision = applyRatioDecision(null, 'unknown', null);
  assert.equal(noDecision.score, null);
  assert.equal(noDecision.level, 'unknown');
});

test('applyRatioDecision caps numeric scores and re-derives level', () => {
  const failDecision = decideRatio(args({ spendDelta: 3, expectedCost: 1.5 }))!; // cap 30
  const failed = applyRatioDecision(100, 'pass', failDecision);
  assert.equal(failed.score, 30);
  assert.equal(failed.level, 'fail');

  const warnCapped = applyRatioDecision(100, 'pass', decideRatio(args({ spendDelta: 1.3, expectedCost: 1 }))!);
  assert.equal(warnCapped.score, 70);
  assert.equal(warnCapped.level, 'warn');

  const warnNoCap = applyRatioDecision(100, 'pass', decideRatio(args({ spendDelta: 0.4, expectedCost: 1 }))!);
  assert.equal(warnNoCap.score, 100);
  assert.equal(warnNoCap.level, 'warn');

  const info = applyRatioDecision(100, 'pass', decideRatio(args({ spendDelta: 1.0, expectedCost: 1 }))!);
  assert.equal(info.score, 100);
  assert.equal(info.level, 'pass');

  // cap 只往下压，不抬高
  const alreadyLow = applyRatioDecision(20, 'fail', failDecision);
  assert.equal(alreadyLow.score, 20);
  assert.equal(alreadyLow.level, 'fail');
});

test('applyRatioDecision guards: non-finite score/cap bypass cap math', () => {
  const failDecision = decideRatio(args({ spendDelta: 3, expectedCost: 1.5 }))!; // cap 30

  // score 非有限（防御分支）：整体不合成，level 原样返回，NaN 不被 Math.min 污染成 cap 值
  const nanScore = applyRatioDecision(Number.NaN, 'pass', failDecision);
  assert.ok(Number.isNaN(nanScore.score));
  assert.equal(nanScore.level, 'pass');

  // score Infinity 同样被有限性守卫拦下：不进 Math.min，不把异常输入「洗白」成有限分
  //（管道内 score 恒为有限值：起点 100、只被有限 cap 下压，此处纯防御）
  const infiniteScore = applyRatioDecision(Number.POSITIVE_INFINITY, 'pass', failDecision);
  assert.equal(infiniteScore.score, Number.POSITIVE_INFINITY);
  assert.equal(infiniteScore.level, 'pass');

  // cap NaN / cap Infinity：跳过封顶但 finding.level 仍然升档
  const capNaN: RatioDecision = {
    verdict: 'fail',
    maskedVerdict: null,
    cap: Number.NaN,
    ratio: 2,
    finding: { level: 'fail', message: '', evidenceIds: [] },
  };
  const keptNaN = applyRatioDecision(100, 'pass', capNaN);
  assert.equal(keptNaN.score, 100);
  assert.equal(keptNaN.level, 'fail');

  const capInfinity: RatioDecision = { ...capNaN, cap: Number.POSITIVE_INFINITY };
  const keptInfinity = applyRatioDecision(100, 'pass', capInfinity);
  assert.equal(keptInfinity.score, 100);
  assert.equal(keptInfinity.level, 'fail');
});

// ---------- probeBilling 端到端（mock client，无价格 → 不触发余额查询） ----------

function usageResult(promptTokens: number, completionTokens = 16): ChatResult {
  return {
    ok: true,
    status: 200,
    finishReason: 'stop',
    model: null,
    text: 'ok',
    reasoning: null,
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
    usageRejected: null,
    attempts: 1,
    toolCalls: [],
    ttftMs: null,
    durationMs: 1,
    error: null,
    raw: '',
  };
}

function errorResult(): ChatResult {
  return {
    ok: false,
    status: 500,
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
    error: 'boom',
    raw: '',
  };
}

function billingCtx(client: OpenAIClient): ProbeCtx {
  const cfg: RunConfig = {
    baseUrl: 'http://127.0.0.1:0/v1',
    apiKey: 'k',
    model: 'gpt-4o',
    claimedContext: null,
    expect: [],
    deep: false,
    billingLevels: [2000, 4000, 8000, 16000, 24000],
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

/** en 请求含英文正文（quick brown fox），zh 请求含中文正文；按轨道与序号给 usage。 */
function billingClient(onCall: (track: 'en' | 'zh', index: number) => ChatResult): { client: OpenAIClient; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const counters: Record<'en' | 'zh', number> = { en: 0, zh: 0 };
  return {
    requests,
    client: {
      baseUrl: 'http://127.0.0.1:0/v1',
      async chat(req: ChatRequest): Promise<ChatResult> {
        requests.push(req);
        const text = req.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('');
        const track: 'en' | 'zh' = text.includes('quick brown fox') ? 'en' : 'zh';
        const index = counters[track];
        counters[track] += 1;
        return onCall(track, index);
      },
    },
  };
}

test('probeBilling: total samples >=3 but every track <3 → insufficient (zero-regression evidence is not a 100/pass)', async () => {
  // en 5 档中前 2 档成功，zh 仅第 1 档成功：合计 3 个有效样本，但无任何轨道 ≥3
  const { client } = billingClient((track, index) => {
    if (track === 'en') return index < 2 ? usageResult(100 + 100 * index) : errorResult();
    return index === 0 ? usageResult(300) : errorResult();
  });
  const ctx = billingCtx(client);
  const outcome = await probeBilling(ctx);
  assert.equal(outcome.status, 'insufficient');
  assert.equal(outcome.score, null);
  assert.equal(outcome.level, 'unknown');
  assert.match(outcome.headline, /有效样本不足/);
  assert.equal(outcome.metrics['requests'], 10);
  // 不应携带「线性关系正常」的满分结论
  assert.ok(!outcome.findings.some((f) => /线性关系正常/.test(f.message)));
});

test('probeBilling: 仅一条轨道 ≥3 个有效样本 → insufficient（不得凭单轨道 pass 100）', async () => {
  // en 5 档全成功，zh 仅前 2 档成功：旧实现 some() 只跑 en 回归并给出「线性正常」pass 100，
  // 但中文轨道的 tokenizer/计数差异完全未验证。
  const { client } = billingClient((track, index) => {
    if (track === 'en') return usageResult(100 + 100 * index);
    return index < 2 ? usageResult(300 + 300 * index) : errorResult();
  });
  const ctx = billingCtx(client);
  const outcome = await probeBilling(ctx);
  assert.equal(outcome.status, 'insufficient');
  assert.equal(outcome.score, null);
  assert.equal(outcome.level, 'unknown');
  // 新口径：失败是样本不足主因时，标题带主导错误归因（3/10 笔失败）
  assert.match(outcome.headline, /有效样本不足/);
  assert.match(outcome.headline, /其他错误（3\/10 笔）：/);
});

test('probeBilling: non-positive english slope → zh_en_slope_ratio is N/A (no astronomical fake ratio)', async () => {
  // en 斜率为负（usage 随长度递减）：旧实现 Math.max(enRatio,0.001) 会造出天文数字比值
  const { client } = billingClient((track, index) =>
    track === 'en' ? usageResult(900 - 100 * index) : usageResult(1000 + 1000 * index),
  );
  const ctx = billingCtx(client);
  const outcome = await probeBilling(ctx);
  assert.equal(outcome.metrics['zh_en_slope_ratio'], 'N/A');
  // en 斜率异常本身仍出 fail finding（<0.05 区间），不被 ratio 修复吞掉
  assert.ok(outcome.findings.some((f) => f.level === 'fail' && /斜率/.test(f.message)), JSON.stringify(outcome.findings));
});

test('probeBilling: R²<0.9 → fail 分项判定（finding 与 level 一致，证据可回溯）', async () => {
  // ys 尾部大离群：slope≈0.76 在合理区间内、R²≈0.78 <0.9——旧实现只 escalate warn，
  // 却 push fail finding（报表出现 FAIL 徽标 + 可疑判定的自相矛盾），且 fail 分支不可达
  const { client } = billingClient((track, index) =>
    track === 'en' ? usageResult([5000, 6000, 7000, 8000, 24000][Math.min(index, 4)]!) : usageResult(1000 + 1000 * index),
  );
  const ctx = billingCtx(client);
  const outcome = await probeBilling(ctx);
  const r2Finding = outcome.findings.find((f) => f.level === 'fail' && /非线性|R²/.test(f.message));
  assert.ok(r2Finding, JSON.stringify(outcome.findings));
  assert.ok((r2Finding.evidenceIds ?? []).length >= 3, 'fail finding 必须携带回归样本证据 id');
  assert.equal(outcome.level, 'fail');
  assert.ok((outcome.score ?? 100) <= 40, `score=${outcome.score}`);
});

test('probeBilling: R² 在 0.9~0.98 之间 → warn 55（不把轻微非线性定性为计数造假）', async () => {
  // 2026-10-18 真机复盘：3 点回归 R²=0.962 曾被判 fail 40 + 「疑似计数造假」；
  // 单点 tokenizer/缓存差异即可造成该量级的偏离，应只报疑似并建议复测。
  const multipliers: Record<'en' | 'zh', number[]> = { en: [0.91, 0.91, 0.91], zh: [0.83, 0.85, 0.53] };
  const counters: Record<'en' | 'zh', number> = { en: 0, zh: 0 };
  const client: OpenAIClient = {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(req: ChatRequest): Promise<ChatResult> {
      const text = req.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('');
      const track: 'en' | 'zh' = text.includes('quick brown fox') ? 'en' : 'zh';
      const index = Math.min(counters[track], multipliers[track].length - 1);
      counters[track] += 1;
      return usageResult(Math.round(estimateMessageTokens(req.messages) * multipliers[track][index]!));
    },
  };
  const ctx = billingCtx(client);
  ctx.cfg.billingLevels = [2000, 8000, 24000];
  const outcome = await probeBilling(ctx);
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.level, 'warn');
  assert.ok((outcome.score ?? 100) <= 55, `score=${outcome.score}`);
  assert.match(outcome.headline, /线性度偏低/);
  const warnFinding = outcome.findings.find((f) => f.level === 'warn' && /R²/.test(f.message));
  assert.ok(warnFinding, JSON.stringify(outcome.findings));
  assert.ok(!outcome.findings.some((f) => f.level === 'fail' && /R²|非线性/.test(f.message)));
});

test('probeBilling: 默认 5 档覆盖 4k/16k，采样点之间的非线性不得报「线性正常」（3 档会漏）', async () => {
  // 3 档（2k/8k/24k）时，异常可以只落在未采样的 4k/16k 上：三点完美共线 → pass 100。
  // 默认恢复 5 档后必须把中间档纳入回归，否则「全部正常」可能是采样盲区而非端点诚实。
  const multipliers = [0.8, 1.2, 0.8, 1.2, 0.8];
  const counters: Record<'en' | 'zh', number> = { en: 0, zh: 0 };
  const client: OpenAIClient = {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(req: ChatRequest): Promise<ChatResult> {
      const text = req.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('');
      const track: 'en' | 'zh' = text.includes('quick brown fox') ? 'en' : 'zh';
      const index = Math.min(counters[track], multipliers.length - 1);
      counters[track] += 1;
      return usageResult(Math.round(estimateMessageTokens(req.messages) * multipliers[index]!));
    },
  };
  const ctx = billingCtx(client);
  ctx.cfg.billingLevels = undefined;
  const outcome = await probeBilling(ctx);
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.level, 'fail', `score=${outcome.score} headline=${outcome.headline}`);
  assert.ok((outcome.score ?? 100) <= 40, `score=${outcome.score}`);
  assert.ok(!outcome.headline.includes('线性关系正常'), outcome.headline);
  assert.ok(outcome.metrics['prompt_tokens_en_4000'] != null, '默认档位必须包含 4k');
  assert.ok(outcome.metrics['prompt_tokens_en_16000'] != null, '默认档位必须包含 16k');
});

test('probeBilling: 窗口内存在失败请求 → 实测倍率作废（不得用不完整分母指控虚高）', async () => {
  const expectedCost = 28292 / 1e6;
  let balanceReads = 0;
  const server = createServer((req, res) => {
    if (req.url === '/v1/dashboard/billing/usage') {
      balanceReads += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ total_usage: balanceReads >= 2 ? Math.round(expectedCost * 100 * 20) : 0 }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const counters: Record<'en' | 'zh', number> = { en: 0, zh: 0 };
  const client: OpenAIClient = {
    baseUrl,
    async chat(req: ChatRequest): Promise<ChatResult> {
      const text = req.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('');
      const track: 'en' | 'zh' = text.includes('quick brown fox') ? 'en' : 'zh';
      const index = counters[track];
      counters[track] += 1;
      // zh 第 2 档失败：该请求可能已被上游计费，但 usage 缺失使 expectedCost 分母不完整
      if (track === 'zh' && index === 1) return errorResult();
      const prompt = 1000 + index * 100;
      return {
        ok: true,
        status: 200,
        finishReason: 'stop',
        model: null,
        text: 'ok',
        reasoning: null,
        usage: { prompt_tokens: prompt, completion_tokens: 16, total_tokens: prompt + 16, cached_tokens: 300 },
        usageRejected: null,
        attempts: 1,
        toolCalls: [],
        ttftMs: null,
        durationMs: 1,
        error: null,
        raw: '',
      };
    },
  };
  try {
    const ctx = billingCtx(client);
    ctx.cfg.priceInput = 2;
    ctx.cfg.priceOutput = 8;
    ctx.cfg.priceCachedRead = 0.5;
    const outcome = await probeBilling(ctx);
    assert.equal(outcome.metrics['ratio_contaminated'], 1);
    assert.equal(outcome.metrics['measured_ratio'], 'N/A');
    // 样本面已有缺口：不得仍报 PASS 100（否则 PASS 徽标与「部分请求失败」warn 自相矛盾）
    assert.notEqual(outcome.level, 'pass');
    assert.ok((outcome.score ?? 100) <= 70, `score=${outcome.score}`);
    assert.ok(outcome.findings.some((f) => f.level === 'warn' && /部分计费探针请求失败/.test(f.message)), JSON.stringify(outcome.findings));
    assert.ok(!outcome.findings.some((f) => f.level === 'fail' && /实测倍率/.test(f.message)), JSON.stringify(outcome.findings));
    assert.ok(outcome.findings.some((f) => f.level === 'info' && /失败请求/.test(f.message)), JSON.stringify(outcome.findings));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('probeBilling: 线性形状正常但无绝对对账 → usage 判定通过（85）+ 如实披露证据分级', async () => {
  // billing 核验对象是端点自报 usage：形状/一致性/输出侧全过即给「未发现造假证据」的明确判定，
  // 不因缺绝对对账悬置；证据分级仍如实透出（85 < 绝对对账 100，×1.3 等比缩放未排除）。
  const client: OpenAIClient = {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(req: ChatRequest): Promise<ChatResult> {
      return usageResult(estimateMessageTokens(req.messages));
    },
  };
  const outcome = await probeBilling(billingCtx(client));
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.score, 85);
  assert.equal(outcome.level, 'pass');
  assert.match(outcome.headline, /未发现造假证据/);
  assert.match(outcome.headline, /未做绝对对账/);
  assert.ok(!outcome.headline.includes('仅验证 usage 与输入长度线性'), outcome.headline);
  assert.equal(outcome.metrics['reference_verified'], 0);
  assert.equal(outcome.metrics['ratio_verified'], 0);
  assert.equal(outcome.metrics['absolute_reconciliation'], 0);
  assert.equal(outcome.metrics['evidence_level'], 'shape-only');
  assert.ok(
    outcome.findings.some((f) => f.level === 'info' && /全量等比缩放/.test(f.message)),
    JSON.stringify(outcome.findings),
  );
});

test('probeBilling: 非空正文但 completion_tokens=0 → warn 70（输出侧计数不可信）', async () => {
  // prompt 回归只覆盖输入；输出侧伪造必须由 completion_tokens 与正文/上限的矛盾来抓。
  const client: OpenAIClient = {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(req: ChatRequest): Promise<ChatResult> {
      return usageResult(estimateMessageTokens(req.messages), 0);
    },
  };
  const outcome = await probeBilling(billingCtx(client));
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.level, 'warn');
  assert.equal(outcome.score, 70);
  assert.equal(outcome.metrics['completion_zero_with_text'], 10);
  assert.match(outcome.headline, /completion_tokens/);
  assert.ok(
    outcome.findings.some((f) => f.level === 'warn' && /completion_tokens=0/.test(f.message)),
    JSON.stringify(outcome.findings),
  );
});

test('probeBilling: completion_tokens 超过请求 max_tokens → warn 70（硬矛盾）', async () => {
  const client: OpenAIClient = {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(req: ChatRequest): Promise<ChatResult> {
      return usageResult(estimateMessageTokens(req.messages), 99);
    },
  };
  const outcome = await probeBilling(billingCtx(client));
  assert.equal(outcome.level, 'warn');
  assert.equal(outcome.score, 70);
  assert.equal(outcome.metrics['completion_over_cap'], 10);
  assert.match(outcome.headline, /输出侧计费异常|completion_tokens/);
});

test('probeBilling: 少量请求缺 usage → warn 70，不得凭剩余样本 PASS', async () => {
  const counters: Record<'en' | 'zh', number> = { en: 0, zh: 0 };
  const client: OpenAIClient = {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(req: ChatRequest): Promise<ChatResult> {
      const text = req.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('');
      const track: 'en' | 'zh' = text.includes('quick brown fox') ? 'en' : 'zh';
      const index = counters[track];
      counters[track] += 1;
      if (track === 'en' && index === 0) {
        return { ...usageResult(1000), usage: null };
      }
      return usageResult(estimateMessageTokens(req.messages));
    },
  };
  const outcome = await probeBilling(billingCtx(client));
  assert.equal(outcome.level, 'warn');
  assert.equal(outcome.score, 70);
  assert.equal(outcome.metrics['usage_missing'], 1);
  assert.ok(
    outcome.findings.some((f) => f.level === 'warn' && /缺少 usage/.test(f.message)),
    JSON.stringify(outcome.findings),
  );
});

// ---------- F3 token-reference 集成（probeBilling 级） ----------

/**
 * 参考计数 client：按 (轨道, 档位序号) 返回 honest×ratio 的 usage，并同步把 honest 值
 * 写进 tokenReference.promptTokens（key 与 billing 的 `${lang}_${level}` 同形状）。
 * ratio=1.0 即「与历史报告完全一致」，ratio=1.3 即「全量等比虚增 30%（回归不可见）」。
 */
function referenceClient(
  ratio: number,
  opts: { model?: string; probesetVersion?: string } = {},
): { client: OpenAIClient; tokenReference: TokenReference } {
  const levels = [2000, 4000, 8000, 16000, 24000];
  const promptTokens: Record<string, number> = {};
  const counters: Record<'en' | 'zh', number> = { en: 0, zh: 0 };
  const tokenReference: TokenReference = {
    sourceFile: 'reports/ref.json',
    model: opts.model ?? 'gpt-4o',
    probesetVersion: opts.probesetVersion ?? PROBESET_VERSION,
    baseUrl: 'https://relay.example.com/v1',
    startedAt: '2026-01-01T00:00:00.000Z',
    promptTokens,
  };
  const client: OpenAIClient = {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(req: ChatRequest): Promise<ChatResult> {
      const text = req.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('');
      const track: 'en' | 'zh' = text.includes('quick brown fox') ? 'en' : 'zh';
      const index = Math.min(counters[track], levels.length - 1);
      counters[track] += 1;
      const level = levels[index] as number;
      const honest = estimateMessageTokens(req.messages);
      promptTokens[`${track}_${level}`] = honest;
      return usageResult(Math.round(honest * ratio));
    },
  };
  return { client, tokenReference };
}

async function auditWithReference(
  ratio: number,
  opts: { model?: string; probesetVersion?: string } = {},
): Promise<Awaited<ReturnType<typeof probeBilling>>> {
  const { client, tokenReference } = referenceClient(ratio, opts);
  const ctx = billingCtx(client);
  ctx.cfg.tokenReference = tokenReference;
  return probeBilling(ctx);
}

test('probeBilling + token-reference: uniform ×1.3 inflation → fail, score capped 30, reference headline', async () => {
  const outcome = await auditWithReference(1.3);
  assert.equal(outcome.level, 'fail');
  assert.equal(outcome.score, 30);
  assert.match(outcome.headline, /token 计数与参考报告系统偏离/);
  assert.equal(outcome.metrics['reference_ratio_max_en'], 1.3);
  assert.equal(outcome.metrics['reference_ratio_max_zh'], 1.3);
  assert.match(String(outcome.metrics['reference_source']), /ref\.json \| gpt-4o \|/);
  assert.ok(outcome.findings.some((f) => f.level === 'fail' && /参考报告/.test(f.message)), JSON.stringify(outcome.findings));
});

test('probeBilling + token-reference: ×1.15 → warn capped 70 with reference headline', async () => {
  const outcome = await auditWithReference(1.15);
  assert.equal(outcome.level, 'warn');
  assert.equal(outcome.score, 70);
  assert.match(outcome.headline, /token 计数与参考报告偏离（最高 ×1\.15）/);
  assert.ok(outcome.findings.some((f) => f.level === 'warn' && /参考报告偏离/.test(f.message)));
});

test('probeBilling + token-reference: matching counts → pass 100 with consistency info', async () => {
  const outcome = await auditWithReference(1.0);
  assert.equal(outcome.level, 'pass');
  assert.equal(outcome.score, 100);
  assert.equal(outcome.metrics['reference_ratio_max_en'], 1);
  assert.equal(outcome.metrics['reference_verified'], 1);
  assert.equal(outcome.metrics['absolute_reconciliation'], 1);
  assert.equal(outcome.metrics['evidence_level'], 'absolute');
  assert.ok(outcome.findings.some((f) => f.level === 'info' && /参考报告一致/.test(f.message)));
});

test('probeBilling + token-reference: model mismatch → comparison skipped, N/A metrics, usage 判定 85', async () => {
  const outcome = await auditWithReference(1.3, { model: 'glm-4.6' });
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.level, 'pass');
  assert.equal(outcome.score, 85);
  assert.equal(outcome.metrics['reference_ratio_max_en'], 'N/A');
  assert.equal(outcome.metrics['reference_verified'], 0);
  assert.equal(outcome.metrics['evidence_level'], 'shape-only');
  assert.ok(outcome.findings.some((f) => f.level === 'info' && /不一致，跳过 token 计数对比/.test(f.message)));
  assert.ok(outcome.findings.some((f) => f.level === 'info' && /未做绝对对账/.test(f.message)), JSON.stringify(outcome.findings));
});

test('probeBilling + token-reference: probeset version mismatch → comparison skipped, usage 判定 85', async () => {
  const outcome = await auditWithReference(1.3, { probesetVersion: 'v0.0.1-old' });
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.level, 'pass');
  assert.equal(outcome.score, 85);
  assert.equal(outcome.metrics['reference_ratio_median_en'], 'N/A');
  assert.equal(outcome.metrics['reference_verified'], 0);
  assert.ok(outcome.findings.some((f) => f.level === 'info' && /题集版本（v0\.0\.1-old）与本次/.test(f.message)));
});

test('probeBilling：缓存读 + 二档阶梯价按 computeCostUsd 累计并如实披露', async () => {
  // 10 笔请求（5 档 × en/zh），prompt 1000..1400；阈值 1000 严格「大于」才切二档：
  // 1000 仍按一档（700×2 + 300×0.5 + 16×8 = 1678），1100..1400 走二档
  // （(p-300)×3 + 300×0.25 + 16×12 = 3p-633）。两轨合计 2×14146 = 28292。
  // 价格 ×10（input 20/output 80/cached 5；二档 30/120/2.5）：expectedCost = 0.28292 ≥ 3×0.01，
  // 高于余额读数分辨率噪声门（<3×resolution 的差值按精度噪声 N/A，见 decideRatio 单测）。
  const expectedCost = 282920 / 1e6;
  const balanceDelta = Math.round(expectedCost * 100) / 100;
  let balanceReads = 0;
  const server = createServer((req, res) => {
    if (req.url === '/v1/dashboard/billing/usage') {
      balanceReads += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      // 真实 balance 接口为整数美分；0.28292 USD 只能读出 28 分（0.28 USD），倍率约 0.99。
      res.end(JSON.stringify({ total_usage: balanceReads >= 2 ? Math.round(expectedCost * 100) : 0 }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const counters: Record<'en' | 'zh', number> = { en: 0, zh: 0 };
  const client: OpenAIClient = {
    baseUrl,
    async chat(req: ChatRequest): Promise<ChatResult> {
      const text = req.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('');
      const track: 'en' | 'zh' = text.includes('quick brown fox') ? 'en' : 'zh';
      const prompt = 1000 + counters[track] * 100;
      counters[track] += 1;
      return {
        ok: true,
        status: 200,
        finishReason: 'stop',
        model: null,
        text: 'ok',
        reasoning: null,
        usage: { prompt_tokens: prompt, completion_tokens: 16, total_tokens: prompt + 16, cached_tokens: 300 },
        usageRejected: null,
        attempts: 1,
        toolCalls: [],
        ttftMs: null,
        durationMs: 1,
        error: null,
        raw: '',
      };
    },
  };
  try {
    const ctx = billingCtx(client);
    ctx.cfg.priceInput = 20;
    ctx.cfg.priceOutput = 80;
    ctx.cfg.priceCachedRead = 5;
    ctx.cfg.priceThreshold = 1000;
    ctx.cfg.priceInput2 = 30;
    ctx.cfg.priceOutput2 = 120;
    ctx.cfg.priceCachedRead2 = 2.5;
    const outcome = await probeBilling(ctx);
    assert.equal(outcome.metrics['price_input2'], 30);
    assert.equal(outcome.metrics['price_cached_read2'], 2.5);
    assert.equal(outcome.metrics['ratio_samples'], 10);
    assert.ok(Math.abs((outcome.metrics['spend_delta'] as number) - balanceDelta) < 1e-12);
    assert.ok(Math.abs((outcome.metrics['expected_cost'] as number) - 0.283) < 1e-12, `expected_cost=${outcome.metrics['expected_cost']}`);
    assert.ok(Math.abs((outcome.metrics['measured_ratio'] as number) - 1) < 0.05, `measured_ratio=${outcome.metrics['measured_ratio']}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('probeBilling：极高倍率（>10×）不再假 fail，改为 warn + masked fail 归因提示', async () => {
  // 回归本身正常（usage 与输入长度成比例），仅余额差值放大到 238.569 倍：
  // 账户级口径无法归因到本次审计，必须保留原始倍率与底层 fail 档位（masked），但不判 fail、不封顶 30。
  const measuredRatio = 238.569;
  let balanceReads = 0;
  let costAccumulated = 0;
  const server = createServer((req, res) => {
    if (req.url === '/v1/dashboard/billing/usage') {
      balanceReads += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ total_usage: balanceReads >= 2 ? Math.round(costAccumulated * 100 * measuredRatio) : 0 }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const client: OpenAIClient = {
    baseUrl,
    async chat(req: ChatRequest): Promise<ChatResult> {
      const prompt = Math.max(1000, estimateMessageTokens(req.messages));
      costAccumulated += ((prompt - 300) * 20 + 300 * 5 + 16 * 80) / 1e6;
      return {
        ok: true,
        status: 200,
        finishReason: 'stop',
        model: null,
        text: 'ok',
        reasoning: null,
        usage: { prompt_tokens: prompt, completion_tokens: 16, total_tokens: prompt + 16, cached_tokens: 300 },
        usageRejected: null,
        attempts: 1,
        toolCalls: [],
        ttftMs: null,
        durationMs: 1,
        error: null,
        raw: '',
      };
    },
  };
  try {
    const ctx = billingCtx(client);
    ctx.cfg.priceInput = 20;
    ctx.cfg.priceOutput = 80;
    ctx.cfg.priceCachedRead = 5;
    const outcome = await probeBilling(ctx);
    assert.equal(
      outcome.level,
      'warn',
      JSON.stringify({ score: outcome.score, headline: outcome.headline, metrics: outcome.metrics, findings: outcome.findings }),
    );
    assert.equal(outcome.score, 100);
    assert.ok((outcome.metrics['measured_ratio'] as number) > 200, `measured_ratio=${outcome.metrics['measured_ratio']}`);
    assert.equal(outcome.metrics['ratio_masked_verdict'], 'fail');
    assert.match(outcome.headline, /无法归因/);
    assert.ok(!outcome.headline.includes('计费虚高'), outcome.headline);
    assert.ok(!outcome.headline.includes('线性关系正常'), outcome.headline);
    assert.ok(
      outcome.findings.some((f) => f.level === 'warn' && /账户级口径|无法归因/.test(f.message)),
      JSON.stringify(outcome.findings),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('probeBilling：库调用方传入半组阶梯价 → warn 且不计算实测倍率', async () => {
  const { client } = billingClient(() => usageResult(1000));
  const ctx = billingCtx(client);
  ctx.cfg.priceInput = 2;
  ctx.cfg.priceOutput = 8;
  ctx.cfg.priceThreshold = 1000000;
  // 缺 priceInput2/priceOutput2：CLI 入口会拒收，库调用方必须被探针自检拦下
  const outcome = await probeBilling(ctx);
  assert.equal(outcome.metrics['expected_cost'], undefined);
  assert.equal(outcome.metrics['measured_ratio'], undefined);
  assert.ok(outcome.findings.some((f) => f.level === 'warn' && /阶梯阈值、二档输入价、二档输出价必须同时提供/.test(f.message)));
});

function contaminatedRetryBillingTest(testName: string, contaminating: boolean, extraAssertions: (outcome: ProbeOutcomeLike) => void): void {
  test(testName, async () => {
    // 某中转站实测形态：上游 503（system cpu overloaded）网关层拒绝未进入推理 → 无产出不重复计费，
    // contaminatingRetry=false；对比组 contaminate=true（200空/5xx/超时后重试）→ warn 封顶 + 倍率作废。
    let expectedCost = 0;
    let balanceReads = 0;
    const server = createServer((req, res) => {
      if (req.url === '/v1/dashboard/billing/usage') {
        balanceReads += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ total_usage: balanceReads >= 2 ? Math.round(expectedCost * 100) : 0 }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const counters: Record<'en' | 'zh', number> = { en: 0, zh: 0 };
    const client: OpenAIClient = {
      baseUrl,
      async chat(req: ChatRequest): Promise<ChatResult> {
        const text = req.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('');
        const track: 'en' | 'zh' = text.includes('quick brown fox') ? 'en' : 'zh';
        const firstOfEn = track === 'en' && counters.en === 0;
        counters[track] += 1;
        // usage 与本地估算一致（斜率 1、R²≈1），倍率结论只取决于污染口径
        const promptTokens = estimateMessageTokens(req.messages);
        expectedCost += (promptTokens * 2 + 16 * 8) / 1e6;
        return {
          ok: true,
          status: 200,
          finishReason: 'stop',
          model: null,
          text: 'ok',
          reasoning: null,
          usage: { prompt_tokens: promptTokens, completion_tokens: 16, total_tokens: promptTokens + 16 },
          usageRejected: null,
          attempts: firstOfEn ? 2 : 1,
          contaminatingRetry: firstOfEn && contaminating,
          toolCalls: [],
          ttftMs: null,
          durationMs: 1,
          error: null,
          raw: '',
        };
      },
    };
    try {
      const ctx = billingCtx(client);
      ctx.cfg.priceInput = 2;
      ctx.cfg.priceOutput = 8;
      const outcome = await probeBilling(ctx);
      extraAssertions(outcome);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

type ProbeOutcomeLike = Awaited<ReturnType<typeof probeBilling>>;

contaminatedRetryBillingTest(
  'probeBilling：503 后重试成功不算计费污染（网关拒绝无产出），窗口保持干净',
  false,
  (outcome) => {
    assert.equal(outcome.metrics['retried_requests'], 1, 'attempts>1 的观测计数如实保留');
    assert.equal(outcome.metrics['contaminating_retries'], 0, '503 后的重试无产出，不算污染');
    assert.notEqual(outcome.metrics['ratio_contaminated'], 1);
    assert.equal(outcome.metrics['ratio_verified'], 1, '窗口干净 + 倍率一致 → 绝对对账成立');
    assert.equal(outcome.metrics['absolute_reconciliation'], 1);
    assert.equal(outcome.status, 'ok');
    assert.equal(outcome.level, 'pass');
    assert.ok(!outcome.findings.some((f) => /重复计费/.test(f.message)), JSON.stringify(outcome.findings));
  },
);

contaminatedRetryBillingTest(
  'probeBilling：可能已计费的重试（contaminatingRetry=true）→ warn 封顶且实测倍率作废',
  true,
  (outcome) => {
    assert.equal(outcome.metrics['contaminating_retries'], 1);
    assert.equal(outcome.metrics['ratio_contaminated'], 1);
    assert.equal(outcome.metrics['measured_ratio'], 'N/A');
    assert.equal(outcome.level, 'warn', `headline=${outcome.headline}`);
    assert.ok((outcome.score ?? 100) <= 70, `score=${outcome.score}`);
    assert.ok(outcome.findings.some((f) => f.level === 'warn' && /重复计费/.test(f.message)), JSON.stringify(outcome.findings));
  },
);

