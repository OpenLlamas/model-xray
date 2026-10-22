import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { applyRatioDecision, composeMoneySide, decideRatio, probeBilling, ratioHeadline, type RatioArgs, type RatioDecision } from '../../src/probes/billing.js';
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

test('decideRatio N/A: quota balance unit without a published conversion rate cannot be compared', () => {
  // 2026-10-18 真机：/api/user/self 返回 quota 单位余额且站点未公示换算率，quota 差值 ÷ 应缴额
  // 会产出天文倍率误报；有 quota_per_unit 时走换算分支（见下方换算用例）。
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
  assert.match(decision?.finding.message ?? '', /与宣称价不是同一单位/);
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
  assert.match(decision?.finding.message ?? '', /少计|不同单位|抵扣/);
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
  assert.match(decision?.finding.message ?? '', /宣称价与余额读数不同单位/);
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
  assert.match(low?.finding.message ?? '', /宣称价与余额读数不同单位/);
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
    // 正文与 completion=16 对齐（'ok'×32 = 64 ASCII 字符 ≈ 16 估算 token）：
    // 否则夹具自身构成「completion vs 正文」灌水形态，污染输出侧灌水比对的判定面。
    text: 'ok'.repeat(32),
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
    // 旧用例覆盖余额对账分支；价格-only 的新默认行为由 publicPricingCtx 显式关闭。
    readBalance: true,
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

test('probeBilling: 不提供价格 → 不算录入价/当前公示价核对，也不读余额', async () => {
  const { client } = billingClient((track, index) => usageResult(2000 + 5000 * index + (track === 'zh' ? 10 : 0)));
  const ctx = billingCtx(client);
  const outcome = await probeBilling(ctx);
  assert.equal(outcome.metrics['claimed_price_ratio_input'], null);
  assert.equal(outcome.metrics['claimed_price_ratio_output'], null);
  assert.ok(!outcome.headline.includes('价格核对'), outcome.headline);
  // 余额对账同样被价格门禁挡住：没有价格就没有应缴金额分母。
  assert.equal(outcome.metrics['measured_ratio'], undefined);
});

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

test('probeBilling: 窗口内存在失败请求 → 实扣倍率作废（不得用不完整分母指控虚高）', async () => {
  const expectedCost = 28292 / 1e6;
  let balanceReads = 0;
  const server = createServer((req, res) => {
    if (req.url === '/v1/dashboard/billing/usage') {
      balanceReads += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ total_usage: balanceReads <= 2 ? 0 : Math.round(expectedCost * 100 * 20) }));
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
        text: 'ok'.repeat(32),
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
    assert.ok(!outcome.findings.some((f) => f.level === 'fail' && /实扣倍率/.test(f.message)), JSON.stringify(outcome.findings));
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
  assert.match(outcome.headline, /未与外部硬证据比对/);
  assert.match(outcome.headline, /补充说明：实际扣款未核对（默认不读余额）；未与外部硬证据比对/, outcome.headline);
  assert.ok(!(outcome.headline.split('；')[0] ?? '').includes('$'), `主句不得含金额：${outcome.headline}`);
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

// ---------- 公开价表兜底（/public/model-prices → 模型级 anchor，2026-10-20） ----------

async function withPublicPricing(
  items: unknown[],
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    if (req.url === '/public/model-prices') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ items }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}/v1`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function publicPricingCtx(baseUrl: string, input: number, output: number): ProbeCtx {
  const client: OpenAIClient = {
    baseUrl,
    async chat(req: ChatRequest): Promise<ChatResult> {
      return usageResult(estimateMessageTokens(req.messages));
    },
  };
  const base = billingCtx(client);
  return { ...base, cfg: { ...base.cfg, priceInput: input, priceOutput: output, readBalance: false } };
}

const PUBLIC_GPT4O = {
  code: 'gpt-4o',
  price_input_usd: '0.2400',
  price_output_usd: '0.8400',
  price_cached_usd: '0.0690',
  price_list_input_usd: '0.8000',
  price_list_output_usd: '2.8000',
};

async function withApiPricing(pricing: unknown, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer((req, res) => {
    if (req.url === '/api/pricing') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(pricing));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}/v1`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function apiPricingCtx(baseUrl: string, input: number, output: number, quotaPerUsd?: number): ProbeCtx {
  const client: OpenAIClient = {
    baseUrl,
    async chat(req: ChatRequest): Promise<ChatResult> {
      return usageResult(estimateMessageTokens(req.messages));
    },
  };
  const base = billingCtx(client);
  return {
    ...base,
    cfg: {
      ...base.cfg,
      priceInput: input,
      priceOutput: output,
      quotaPerUsd: quotaPerUsd ?? null,
      readBalance: false,
    },
  };
}

test('probeBilling: API 倍率表缺 quota_per_unit → 不合成 USD、不做价格核对、不编造应缴额', async () => {
  await withApiPricing(
    {
      data: [{ model_name: 'gpt-4o', model_ratio: 1, completion_ratio: 4 }],
      group_ratio: { default: 1 },
    },
    async (baseUrl) => {
      const outcome = await probeBilling(apiPricingCtx(baseUrl, 2, 8));
      assert.equal(outcome.metrics['pricing_state'], 'ok');
      assert.equal(outcome.metrics['declared_source'], 'api');
      assert.equal(outcome.metrics['declared_model_ratio'], 1);
      assert.equal(outcome.metrics['quota_per_unit'], null);
      assert.equal(outcome.metrics['quota_per_unit_source'], 'none');
      assert.equal(outcome.metrics['quota_per_unit_synthetic'], 1);
      assert.equal(outcome.metrics['claimed_price_ratio_input'], null);
      assert.equal(outcome.metrics['claimed_price_ratio_output'], null);
      assert.equal(outcome.metrics['expected_quota_declared'], null);
      assert.equal(outcome.metrics['expected_cost_usd_declared'], null);
      assert.match(outcome.headline, /价目对比 N\/A（站点未公示 quota_per_unit 换算率）/);
      assert.match(outcome.headline, /站点未公示 quota_per_unit/);
      assert.doesNotMatch(outcome.headline, /你填的单价÷站点现价/);
      assert.doesNotMatch(outcome.headline, /按公示价估算计费探针应缴/);
      assert.ok(
        outcome.findings.some((f) => f.level === 'info' && /未公示 quota_per_unit/.test(f.message)),
        JSON.stringify(outcome.findings),
      );
    },
  );
});

test('probeBilling: 站点 quota 缺失但 CLI 提供换算率 → 仍按真实 quota 做价格核对', async () => {
  await withApiPricing(
    {
      data: [{ model_name: 'gpt-4o', model_ratio: 1, completion_ratio: 4 }],
      group_ratio: { default: 1 },
    },
    async (baseUrl) => {
      const outcome = await probeBilling(apiPricingCtx(baseUrl, 2, 8, 500_000));
      assert.equal(outcome.metrics['quota_per_unit'], 500_000);
      assert.equal(outcome.metrics['quota_per_unit_source'], 'cli');
      assert.equal(outcome.metrics['quota_per_unit_synthetic'], 0);
      assert.equal(outcome.metrics['claimed_price_ratio_input'], 1);
      assert.equal(outcome.metrics['claimed_price_ratio_output'], 1);
      assert.equal(typeof outcome.metrics['expected_quota_declared'], 'number');
      assert.equal(typeof outcome.metrics['expected_cost_usd_declared'], 'number');
      assert.match(outcome.headline, /你填的单价÷站点现价 1×（输入\/输出一致；只比价目，未看实扣）/);
    },
  );
});

test('probeBilling: /api/pricing 404 → 公开价表模型级 anchor；headline 含录入价/当前公示价核对，不读余额', async () => {
  await withPublicPricing([PUBLIC_GPT4O], async (baseUrl) => {
    const outcome = await probeBilling(publicPricingCtx(baseUrl, 0.24, 0.84));
    assert.equal(outcome.status, 'ok');
    assert.equal(outcome.score, 85);
    assert.equal(outcome.level, 'pass');
    assert.equal(outcome.metrics['declared_source'], 'public-json');
    assert.equal(outcome.metrics['pricing_state'], 'not_applicable');
    assert.equal(outcome.metrics['public_price_state'], 'ok');
    assert.equal(outcome.metrics['public_price_page'], '/public/model-prices');
    assert.equal(outcome.metrics['public_price_entries'], 1);
    assert.equal(outcome.metrics['public_price_matched'], 'gpt-4o');
    assert.equal(outcome.metrics['public_price_input_usd_per_m'], 0.24);
    assert.equal(outcome.metrics['public_price_output_usd_per_m'], 0.84);
    assert.equal(outcome.metrics['declared_ratio_synthetic'], 1);
    assert.equal(outcome.metrics['quota_per_unit_synthetic'], 0);
    // 用户录入价 = 官方公示价 → 用户直觉里的价格核对必须是 1×。
    assert.equal(outcome.metrics['claimed_price_ratio_input'], 1);
    assert.equal(outcome.metrics['claimed_price_ratio_output'], 1);
    // 列表价折扣是另一个口径（公示价 ÷ 列表价），仍保留但不抢主位。
    assert.equal(outcome.metrics['public_price_ratio_input'], 0.3);
    assert.equal(outcome.metrics['public_price_ratio_output'], 0.3);
    // 公开价表锚：应缴只以 USD 披露，quota 单位未知（合成 500000 不得冒充站点单位写进报告）
    assert.equal(outcome.metrics['expected_quota_declared'], null);
    const expectedUsd = outcome.metrics['expected_cost_usd_declared'];
    assert.ok(typeof expectedUsd === 'number' && expectedUsd > 0, `应缴 USD 应为正数：${String(expectedUsd)}`);
    assert.equal(outcome.metrics['expected_cost_usd_basis'], 'public_usd');
    assert.equal(outcome.metrics['money_check_state'], 'declared_only');
    assert.equal(outcome.metrics['measured_ratio'], undefined);
    assert.match(outcome.headline, /站点现价：输入 \$0\.24\/百万 · 输出 \$0\.84\/百万/);
    assert.match(outcome.headline, /你填的单价÷站点现价 1×（输入\/输出一致；只比价目，未看实扣）/);
    assert.match(outcome.headline, /按价目应扣 \$[\d.]+（估算，上界）/, outcome.headline);
    assert.match(outcome.headline, /补充说明：站点分组折扣未知，按无折扣（×1）计算/, outcome.headline);
    assert.equal(outcome.headline.split('；')[0], 'token 计数核验通过', '主句只保留实测形状结论');
    assert.ok(!outcome.headline.includes('公示价÷列表价'), outcome.headline);
    assert.match(outcome.headline, /实扣 未测（默认不读余额）/);
    assert.ok(!outcome.headline.includes('实扣倍率无法计算'), outcome.headline);
    assert.ok(!outcome.headline.includes('未与实收对账'), outcome.headline);
    assert.ok(!outcome.headline.includes('仅验证 usage 与输入长度线性'), outcome.headline);
    assert.ok(
      outcome.findings.some(
        (f) => f.level === 'info' && /公开价表无分组概念，按倍率 1 折算，分组口径未核验/.test(f.message),
      ),
      JSON.stringify(outcome.findings),
    );
    assert.ok(
      outcome.findings.some(
        (f) => f.level === 'info' && /公示输入\/输出倍率是按标准基价反推的展示值/.test(f.message),
      ),
      JSON.stringify(outcome.findings),
    );
    assert.ok(
      outcome.findings.some((f) => f.level === 'info' && /站点公开价与宣称价一致，无可归因的加价/.test(f.message)),
      JSON.stringify(outcome.findings),
    );
  });
});

test('probeBilling: 换芯回显 fail 不得污染 regressionLevel——倍率虚高仍要封顶 30（硬红线），score≠70', async () => {
  // 复刻 2026-10-21 真机：站点回显低价模型（echo ratio 30%<50% → fail + cap 70），
  // 同时余额对账测得 ×1.6 虚高。修复前 regressionLevel 在回显 fail 之后才捕获，
  // decideRatio 误走「usage 回归失败」分支（cap=null），billing 停在 70 → 总分 77 不触发硬红线。
  let usedQuota = 5_000_000; // quota；/api/usage/token 的 total_used，5_000_000/500000 = $10 已用
  const COST_PER_UNIT_QUOTA = 500_000; // quota_per_unit（new-api 默认）
  const server = createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0];
    if (url === '/api/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { quota_per_unit: COST_PER_UNIT_QUOTA } }));
      return;
    }
    if (url === '/api/usage/token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { total_granted: 100_000_000, total_used: usedQuota, total_available: 95_000_000 } }));
      return;
    }
    if (url === '/api/pricing') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [
            { model_name: 'gpt-4o', model_ratio: 1, completion_ratio: 4 },
            { model_name: 'gpt-4o-mini', model_ratio: 0.3, completion_ratio: 2 },
          ],
          group_ratio: { default: 1 },
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    // chat 由 mock client 承接：诚实 usage + 回显他族低价模型；扣费按 ×1.6 虚计入余额。
    const client: OpenAIClient = {
      baseUrl,
      async chat(req: ChatRequest): Promise<ChatResult> {
        const promptTokens = estimateMessageTokens(req.messages);
        const result = usageResult(promptTokens);
        result.model = 'gpt-4o-mini'; // 回显换芯：公示倍率 0.3 vs 请求 1 → 30% <50% → fail
        const expectedCost = (promptTokens / 1e6) * 2 + (16 / 1e6) * 8; // 录入价 2/8 的应缴
        usedQuota += expectedCost * 1.6 * COST_PER_UNIT_QUOTA; // 余额按 ×1.6 虚增扣费
        return result;
      },
    };
    const base = billingCtx(client);
    const ctx: ProbeCtx = { ...base, cfg: { ...base.cfg, baseUrl, priceInput: 2, priceOutput: 8, readBalance: true } };
    const outcome = await probeBilling(ctx);
    assert.equal(outcome.status, 'ok');
    // 回显 fail 封顶 70，倍率 fail 再封 30：regressionLevel 只认回归块结果（本夹具 r2=1 回归通过）
    assert.equal(outcome.score, 30, `倍率虚高必须封顶 30：${outcome.score}`);
    assert.equal(outcome.level, 'fail');
    assert.equal(outcome.metrics['echo_model_mismatch'], 10);
    assert.equal(outcome.metrics['measured_ratio'], 1.6);
    assert.ok(
      outcome.findings.some((f) => f.level === 'fail' && /换芯|低价\/弱模型冒充/.test(f.message)),
      JSON.stringify(outcome.findings),
    );
    assert.ok(
      outcome.findings.some((f) => f.level === 'fail' && /实扣倍率 1\.6 > 1\.5/.test(f.message)),
      JSON.stringify(outcome.findings),
    );
    // 回归本身通过（r2=1）→ headline 不得声称「usage 计数亦异常」
    assert.ok(!outcome.headline.includes('token 计数也有问题'), outcome.headline);
    assert.match(outcome.headline, /实际扣费是应缴的 1\.6 倍，计费虚高（判据 >1\.5 倍）/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('probeBilling: 宣称价高于公示价 → 价格核对给出 1.2×/1.4×，不误报为 1×', async () => {
  await withPublicPricing(
    [{ ...PUBLIC_GPT4O, price_input_usd: '0.2000', price_output_usd: '0.6000' }],
    async (baseUrl) => {
      const outcome = await probeBilling(publicPricingCtx(baseUrl, 0.24, 0.84));
      assert.equal(outcome.level, 'pass');
      assert.equal(outcome.metrics['claimed_price_ratio_input'], 1.2);
      assert.equal(outcome.metrics['claimed_price_ratio_output'], 1.4);
      assert.match(outcome.headline, /你填的单价÷站点现价 输入 1\.2× · 输出 1\.4×/);
    },
  );
});

test('probeBilling: 公开价表无列表价 → 仍按录入价/当前公示价给 1×，不编造列表折扣', async () => {
  await withPublicPricing(
    [{ code: 'gpt-4o', price_input_usd: '0.2400', price_output_usd: '0.8400', price_cached_usd: '0.0690' }],
    async (baseUrl) => {
      const outcome = await probeBilling(publicPricingCtx(baseUrl, 0.24, 0.84));
      assert.equal(outcome.status, 'ok');
      assert.equal(outcome.score, 85);
      assert.equal(outcome.metrics['claimed_price_ratio_input'], 1);
      assert.equal(outcome.metrics['claimed_price_ratio_output'], 1);
      assert.equal(outcome.metrics['public_price_ratio_input'], null);
      assert.equal(outcome.metrics['public_price_ratio_output'], null);
      assert.match(outcome.headline, /你填的单价÷站点现价 1×（输入\/输出一致；只比价目，未看实扣）/);
      assert.ok(!outcome.headline.includes('站点现价÷官方列表价'), outcome.headline);
      assert.match(outcome.headline, /实扣 未测（默认不读余额）/);
      assert.ok(!outcome.headline.includes('实扣倍率无法计算'), outcome.headline);
    },
  );
});

test('probeBilling: 列表价为 0 → 不除零、不编造列表折扣，但录入价/当前公示价仍可核对', async () => {
  await withPublicPricing(
    [{ code: 'gpt-4o', price_input_usd: '0.2400', price_output_usd: '0.8400', price_list_input_usd: '0', price_list_output_usd: '0' }],
    async (baseUrl) => {
      const outcome = await probeBilling(publicPricingCtx(baseUrl, 0.24, 0.84));
      assert.equal(outcome.metrics['claimed_price_ratio_input'], 1);
      assert.equal(outcome.metrics['claimed_price_ratio_output'], 1);
      assert.equal(outcome.metrics['public_price_ratio_input'], null);
      assert.equal(outcome.metrics['public_price_ratio_output'], null);
      assert.match(outcome.headline, /你填的单价÷站点现价 1×/);
      assert.ok(!outcome.headline.includes('站点现价÷官方列表价'), outcome.headline);
      assert.match(outcome.headline, /实扣 未测（默认不读余额）/);
    },
  );
});

test('probeBilling: 仅单侧列表价 → 录入价/当前公示价仍两边核对，列表折扣只留可得一侧', async () => {
  await withPublicPricing(
    [{ code: 'gpt-4o', price_input_usd: '0.2400', price_output_usd: '0.8400', price_list_input_usd: '0.8000' }],
    async (baseUrl) => {
      const outcome = await probeBilling(publicPricingCtx(baseUrl, 0.24, 0.84));
      assert.equal(outcome.metrics['claimed_price_ratio_input'], 1);
      assert.equal(outcome.metrics['claimed_price_ratio_output'], 1);
      assert.equal(outcome.metrics['public_price_ratio_input'], 0.3);
      assert.equal(outcome.metrics['public_price_ratio_output'], null);
      assert.match(outcome.headline, /你填的单价÷站点现价 1×（输入\/输出一致；只比价目，未看实扣）/);
      assert.ok(!outcome.headline.includes('0.3×'), outcome.headline);
      assert.match(outcome.headline, /实扣 未测（默认不读余额）/);
    },
  );
});

test('probeBilling: 公开价低于宣称价 → 仅 info，不产生 warn/fail', async () => {
  await withPublicPricing(
    [{ ...PUBLIC_GPT4O, price_input_usd: '0.2000', price_output_usd: '0.6000' }],
    async (baseUrl) => {
      const outcome = await probeBilling(publicPricingCtx(baseUrl, 0.24, 0.84));
      assert.equal(outcome.status, 'ok');
      assert.equal(outcome.score, 85);
      assert.equal(outcome.level, 'pass');
      assert.ok(
        outcome.findings.some((f) => f.level === 'info' && /站点公开价低于宣称价，无可归因的加价/.test(f.message)),
        JSON.stringify(outcome.findings),
      );
      assert.ok(!outcome.findings.some((f) => f.level === 'warn' || f.level === 'fail'), JSON.stringify(outcome.findings));
    },
  );
});

test('probeBilling: 公开价与宣称价约 1000× 量级差 → 仅 info 披露单位口径，不判罚', async () => {
  await withPublicPricing(
    [{ ...PUBLIC_GPT4O, price_input_usd: '240', price_output_usd: '840' }],
    async (baseUrl) => {
      const outcome = await probeBilling(publicPricingCtx(baseUrl, 0.24, 0.84));
      assert.equal(outcome.status, 'ok');
      assert.equal(outcome.score, 85);
      assert.equal(outcome.level, 'pass');
      assert.equal(outcome.metrics['public_price_input_usd_per_m'], 240);
      assert.match(outcome.headline, /站点现价：输入 \$240\/百万 · 输出 \$840\/百万/);
      assert.ok(
        outcome.findings.some(
          (f) => f.level === 'info' && /单位口径不同|相差约 1000×/.test(f.message),
        ),
        JSON.stringify(outcome.findings),
      );
      assert.ok(!outcome.findings.some((f) => f.level === 'warn' || f.level === 'fail'), JSON.stringify(outcome.findings));
    },
  );
});

test('probeBilling: 公开价高于宣称价 >50% → fail 70（方向性加价，不因站更便宜误报）', async () => {
  await withPublicPricing(
    [{ ...PUBLIC_GPT4O, price_input_usd: '0.4800', price_output_usd: '1.6800' }],
    async (baseUrl) => {
      const outcome = await probeBilling(publicPricingCtx(baseUrl, 0.24, 0.84));
      assert.equal(outcome.status, 'ok');
      assert.equal(outcome.score, 70);
      assert.equal(outcome.level, 'fail');
      assert.match(outcome.headline, /虚标价格嫌疑/);
      assert.ok(
        outcome.findings.some((f) => f.level === 'fail' && /公开价表输入价 \$0\.48\/M vs 宣称 \$0\.24\/M/.test(f.message)),
        JSON.stringify(outcome.findings),
      );
    },
  );
});

test('probeBilling: 公开价高于宣称价 20%-50% → warn 且不封顶到 fail', async () => {
  await withPublicPricing(
    [{ ...PUBLIC_GPT4O, price_input_usd: '0.3000', price_output_usd: '1.0500' }],
    async (baseUrl) => {
      const outcome = await probeBilling(publicPricingCtx(baseUrl, 0.24, 0.84));
      assert.equal(outcome.status, 'ok');
      assert.equal(outcome.level, 'warn');
      assert.ok(outcome.score !== null && outcome.score > 70, `warn 不应封顶到 fail 档：${outcome.score}`);
      assert.ok(
        outcome.findings.some((f) => f.level === 'warn' && /公开价高于宣称价，存在加价嫌疑/.test(f.message)),
        JSON.stringify(outcome.findings),
      );
    },
  );
});

test('probeBilling: 公开价不足宣称价一半 → warn 披露「低价表引流」假设，不判 fail', async () => {
  await withPublicPricing(
    [{ ...PUBLIC_GPT4O, price_input_usd: '0.1000', price_output_usd: '0.3500' }],
    async (baseUrl) => {
      const outcome = await probeBilling(publicPricingCtx(baseUrl, 0.24, 0.84));
      assert.equal(outcome.status, 'ok');
      assert.equal(outcome.level, 'warn');
      assert.ok(outcome.score !== null && outcome.score > 0, String(outcome.score));
      assert.ok(
        outcome.findings.some((f) => f.level === 'warn' && /低价表引流、高价结算/.test(f.message)),
        JSON.stringify(outcome.findings),
      );
      assert.ok(!outcome.findings.some((f) => f.level === 'fail'), JSON.stringify(outcome.findings));
    },
  );
});

test('probeBilling: 公开价快照 quotaPerUnit 只写真实源，不落合成 500000', async () => {
  await withPublicPricing([PUBLIC_GPT4O], async (baseUrl) => {
    const base = publicPricingCtx(baseUrl, 0.24, 0.84);
    const captured: Array<{ quotaPerUnit: number | null; source?: string }> = [];
    const withLedger = {
      ...base,
      onPricingSnapshot: (declared: { quotaPerUnit: number | null; source?: string }) => {
        captured.push(declared);
        return { ok: true, path: null, error: null };
      },
    };
    const outcome = await probeBilling(withLedger);
    assert.equal(outcome.metrics['declared_source'], 'public-json');
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.quotaPerUnit, null);
    assert.equal(captured[0]?.source, 'public-json');
  });
});

test('probeBilling: 公开价快照沿用用户声明的真实 quotaPerUnit', async () => {
  await withPublicPricing([PUBLIC_GPT4O], async (baseUrl) => {
    const base = publicPricingCtx(baseUrl, 0.24, 0.84);
    const captured: Array<{ quotaPerUnit: number | null }> = [];
    const outcome = await probeBilling({
      ...base,
      cfg: { ...base.cfg, quotaPerUsd: 123_456 },
      onPricingSnapshot: (declared: { quotaPerUnit: number | null }) => {
        captured.push(declared);
        return { ok: true, path: null, error: null };
      },
    });
    assert.equal(outcome.metrics['declared_source'], 'public-json');
    assert.equal(captured[0]?.quotaPerUnit, 123_456);
  });
});

test('probeBilling: 公开价表 anchor 与 API 基线跨来源 → 跳过漂移并披露', async () => {
  await withPublicPricing([PUBLIC_GPT4O], async (baseUrl) => {
    const base = publicPricingCtx(baseUrl, 0.24, 0.84);
    const outcome = await probeBilling({
      ...base,
      previousPricing: {
        origin: 'https://api.example.com',
        capturedAt: '2026-10-01T00:00:00.000Z',
        source: 'api',
        quotaPerUnit: 500_000,
        group: null,
        models: { 'gpt-4o': { modelRatio: 1, completionRatio: 4 } },
        groupRatio: {},
      },
      previousPricingSource: 'baseline',
    });
    assert.equal(outcome.status, 'ok');
    assert.equal(outcome.level, 'pass');
    assert.equal(outcome.metrics['declared_drift_count'], 0);
    assert.ok(
      outcome.findings.some((f) => f.level === 'info' && /跨来源快照跳过漂移比对/.test(f.message)),
      JSON.stringify(outcome.findings),
    );
    assert.ok(!outcome.findings.some((f) => f.level === 'warn' && /漂移/.test(f.message)), JSON.stringify(outcome.findings));
  });
});

test('probeBilling: 公示价明确下调 → 更划算，不降档、不封顶', async () => {
  await withPublicPricing([PUBLIC_GPT4O], async (baseUrl) => {
    const base = publicPricingCtx(baseUrl, 0.24, 0.84);
    const outcome = await probeBilling({
      ...base,
      previousPricing: {
        origin: 'https://api.example.com',
        capturedAt: '2026-10-01T00:00:00.000Z',
        source: 'public-json',
        quotaPerUnit: null,
        group: null,
        models: { 'gpt-4o': { modelRatio: 0.24, completionRatio: 3.5 } },
        groupRatio: {},
      },
      previousPricingSource: 'baseline',
    });
    assert.equal(outcome.level, 'pass');
    assert.equal(outcome.score, 85);
    assert.equal(outcome.metrics['declared_drift_count'], 0);
    assert.equal(outcome.metrics['declared_drift_down_count'], 1);
    assert.ok(
      outcome.findings.some((f) => f.level === 'info' && /下调，价格更划算.*不降档/.test(f.message)),
      JSON.stringify(outcome.findings),
    );
    assert.ok(!outcome.findings.some((f) => f.level === 'warn' && /下调/.test(f.message)), JSON.stringify(outcome.findings));
  });
});

test('probeBilling: 非空正文但 completion_tokens=0 → warn 70（输出侧计数不可信）', async () => {  // prompt 回归只覆盖输入；输出侧伪造必须由 completion_tokens 与正文/上限的矛盾来抓。
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

// ---------- 暗插固定 token（回归截距）/ 输出侧灌水（completion 合计比对，2026-10-19） ----------

test('probeBilling: 恒定加计 500 tokens（暗插系统提示）→ 回归截距 warn 封顶 70，斜率不误触发', async () => {
  // 等比形状检查的盲区：prompt_tokens = 估算 + 500 对每个长度档恒定加计，
  // 斜率仍为 1.0、R²=1，只有 x=0 外推的截距暴露该项。
  const client: OpenAIClient = {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(req: ChatRequest): Promise<ChatResult> {
      return usageResult(estimateMessageTokens(req.messages) + 500);
    },
  };
  const outcome = await probeBilling(billingCtx(client));
  assert.equal(outcome.level, 'warn');
  assert.ok((outcome.score ?? 100) <= 70, `score=${outcome.score}`);
  assert.match(outcome.headline, /截距/);
  const interceptFinding = outcome.findings.find((f) => /截距/.test(f.message));
  assert.ok(interceptFinding && interceptFinding.level === 'warn', JSON.stringify(outcome.findings));
  assert.ok((interceptFinding?.evidenceIds ?? []).length >= 3, '截距 warn 必须携带回归样本证据');
  assert.ok(!outcome.findings.some((f) => /轨道斜率|按字符数/.test(f.message)), '恒定加计不改变斜率，斜率判定不得误触发');
  assert.ok((outcome.metrics['intercept_en'] as number) > 120, `intercept_en=${outcome.metrics['intercept_en']}`);
});

test('probeBilling: 模板级截距（+20 tokens）不触发暗插判定（诚实中转不误报）', async () => {
  const client: OpenAIClient = {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(req: ChatRequest): Promise<ChatResult> {
      return usageResult(estimateMessageTokens(req.messages) + 20);
    },
  };
  const outcome = await probeBilling(billingCtx(client));
  assert.equal(outcome.level, 'pass');
  assert.equal(outcome.score, 85);
  assert.ok(!outcome.findings.some((f) => /截距/.test(f.message)), JSON.stringify(outcome.findings));
  assert.ok((outcome.metrics['intercept_en'] as number) < 120, `intercept_en=${outcome.metrics['intercept_en']}`);
});

test('probeBilling: en 轨道可见 completion 灌水（15 vs 估算 10，×1.5）→ 输出侧合计 warn 封顶 70', async () => {
  const client: OpenAIClient = {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(req: ChatRequest): Promise<ChatResult> {
      const text = req.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('');
      const isEn = text.includes('quick brown fox');
      // en 可见 completion=15（无推理明细），正文 'ok'×20 的本地估算=10 → 比值 1.5 > 1.35；
      // zh 保持诚实（10 vs 10），只有 en 轨道触发。completion 均不超过 max_tokens=16 硬矛盾线。
      const completion = isEn ? 15 : 10;
      return { ...usageResult(estimateMessageTokens(req.messages), completion), text: 'ok'.repeat(20) };
    },
  };
  const outcome = await probeBilling(billingCtx(client));
  assert.equal(outcome.level, 'warn');
  assert.ok((outcome.score ?? 100) <= 70, `score=${outcome.score}`);
  const inflateFinding = outcome.findings.find((f) => /灌水/.test(f.message));
  assert.ok(inflateFinding && inflateFinding.level === 'warn', JSON.stringify(outcome.findings));
  assert.ok(Math.abs((outcome.metrics['completion_ratio_en'] as number) - 1.5) < 0.01, `ratio=${outcome.metrics['completion_ratio_en']}`);
  assert.ok((inflateFinding?.evidenceIds ?? []).length >= 3, '灌水 warn 必须携带样本证据');
  assert.ok(!outcome.findings.some((f) => /截距|斜率|R²/.test(f.message)), '夹具保持斜率 1/截距 0，其他判定不得误触发');
});

test('probeBilling: 推理份额扣减与 finish=length 排除（thinking 端点不误报）', async () => {
  const counters: Record<'en' | 'zh', number> = { en: 0, zh: 0 };
  const client: OpenAIClient = {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(req: ChatRequest): Promise<ChatResult> {
      const text = req.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('');
      const track: 'en' | 'zh' = text.includes('quick brown fox') ? 'en' : 'zh';
      const index = counters[track];
      counters[track] += 1;
      const prompt = estimateMessageTokens(req.messages);
      const base = { ...usageResult(prompt), text: 'ok'.repeat(20) };
      if (track === 'en') {
        if (index === 0) return { ...base, finishReason: 'length' };
        // completion=16 其中 reasoning=6（真机实证中转对普通复读也报推理明细）：
        // 可见份额 10 与正文估算 10 一致 → 比值 1.0，不得误报灌水。
        return { ...base, usage: { ...base.usage!, completion_tokens: 16, reasoning_tokens: 6 } };
      }
      return { ...base, usage: { ...base.usage!, completion_tokens: 10, reasoning_tokens: 0 } };
    },
  };
  const outcome = await probeBilling(billingCtx(client));
  assert.equal(outcome.level, 'pass');
  assert.equal(outcome.metrics['completion_pair_samples_en'], 4);
  assert.equal(outcome.metrics['completion_excluded_en'], 1);
  assert.ok(Math.abs((outcome.metrics['completion_ratio_en'] as number) - 1) < 0.01, `ratio=${outcome.metrics['completion_ratio_en']}`);
  assert.ok(!outcome.findings.some((f) => /灌水/.test(f.message)), JSON.stringify(outcome.findings));
});

test('probeBilling: 输出侧少报（completion 4 vs 估算 10）→ info 披露不扣分', async () => {
  const client: OpenAIClient = {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(req: ChatRequest): Promise<ChatResult> {
      const text = req.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('');
      const isEn = text.includes('quick brown fox');
      const completion = isEn ? 4 : 10;
      return { ...usageResult(estimateMessageTokens(req.messages), completion), text: 'ok'.repeat(20) };
    },
  };
  const outcome = await probeBilling(billingCtx(client));
  assert.equal(outcome.level, 'pass');
  assert.equal(outcome.score, 85);
  assert.ok(outcome.findings.some((f) => f.level === 'info' && /少报/.test(f.message)), JSON.stringify(outcome.findings));
  assert.ok(!outcome.findings.some((f) => f.level === 'warn' && /灌水/.test(f.message)));
  assert.ok((outcome.metrics['completion_ratio_en'] as number) < 0.6, `ratio=${outcome.metrics['completion_ratio_en']}`);
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
  assert.ok(outcome.findings.some((f) => f.level === 'info' && /未与外部硬证据比对/.test(f.message)), JSON.stringify(outcome.findings));
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
        res.end(JSON.stringify({ total_usage: balanceReads <= 2 ? 0 : Math.round(expectedCost * 100) }));
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
        text: 'ok'.repeat(32),
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
      res.end(JSON.stringify({ total_usage: balanceReads <= 2 ? 0 : Math.round(costAccumulated * 100 * measuredRatio) }));
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
        text: 'ok'.repeat(32),
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
    assert.match(outcome.headline, /说不清是谁多扣的/);
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

test('probeBilling：库调用方传入半组阶梯价 → warn 且不计算实扣倍率', async () => {
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
    // xianyu1 实测形态：上游 503（system cpu overloaded）网关层拒绝未进入推理 → 无产出不重复计费，
    // contaminatingRetry=false；对比组 contaminate=true（200空/5xx/超时后重试）→ warn 封顶 + 倍率作废。
    let expectedCost = 0;
    let balanceReads = 0;
    const server = createServer((req, res) => {
      if (req.url === '/v1/dashboard/billing/usage') {
        balanceReads += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ total_usage: balanceReads <= 2 ? 0 : Math.round(expectedCost * 100) }));
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
          text: 'ok'.repeat(32),
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
  'probeBilling：可能已计费的重试（contaminatingRetry=true）→ warn 封顶且实扣倍率作废',
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


// ---------- 偷调倍率检测链路补缺（2026-10-19 图纸双审必修：pre 稳定化 / top-up / user 级口径） ----------

function userLevelReading(value: number): BalanceReading {
  return {
    value,
    kind: 'spent_total',
    unit: 'USD',
    endpoint: '/api/user/self',
    currency: null,
    resolution: 1 / 500000,
    conversionNote: 'quota_per_unit=500000 (source: /api/status; user-level balance)',
  };
}

test('decideRatio：user 级余额来源（/api/user/self）超 1.5 倍 → 禁出 fail，降为 warn + masked fail 披露', () => {
  const args = {
    before: userLevelReading(0),
    after: userLevelReading(0.02),
    spendDelta: 0.02,
    expectedCost: 0.01,
    ratioDropped: 0,
    regressionLevel: 'pass' as const,
  };
  // 用户级口径：该用户全部 key 共享 Δ，其他 key 的并发消费可把倍率推入 (1.5,10]——
  // >10 不可归因门兜不住（必修 2），定论级 fail 只允许 key 级口径
  const userScope = decideRatio({ ...args, scope: 'user' });
  assert.equal(userScope?.verdict, 'warn');
  assert.equal(userScope?.maskedVerdict, 'fail');
  assert.equal(userScope?.cap, 70);
  assert.match(userScope?.finding.message ?? '', /用户级口径/);

  const keyScope = decideRatio({ ...args, scope: 'key' });
  assert.equal(keyScope?.verdict, 'fail', 'key 级口径出定论 fail');

  const defaultScope = decideRatio(args);
  assert.equal(defaultScope?.verdict, 'fail', '缺省 scope 兼容旧调用方（按 key 级）');

  // regressionLevel=fail 分支同样受 user 级禁 fail 约束
  const userScopeRegFail = decideRatio({ ...args, scope: 'user', regressionLevel: 'fail' });
  assert.equal(userScopeRegFail?.verdict, 'warn');
  assert.equal(userScopeRegFail?.maskedVerdict, 'fail');
});

test('probeBilling：pre 快照未即时稳定（窗口前存在未结算消费）→ 实扣倍率作废，不得诬告', async () => {
  let balanceReads = 0;
  const server = createServer((req, res) => {
    if (req.url === '/v1/dashboard/billing/usage') {
      balanceReads += 1;
      // 读数序列（美分）：0 → 100 → 100 → 100：pre 第二次对比才收敛（polls=3 > 2），
      // 窗口前有异步结算的旧账在 pre 轮询期间入账——起点不可靠，混入会推高倍率
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ total_usage: balanceReads === 1 ? 0 : 100 }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  try {
    const client: OpenAIClient = {
      baseUrl,
      async chat(): Promise<ChatResult> {
        return usageResult(1000);
      },
    };
    const ctx = billingCtx(client);
    ctx.cfg.priceInput = 2;
    ctx.cfg.priceOutput = 8;
    const outcome = await probeBilling(ctx);
    assert.equal(outcome.metrics['ratio_contaminated'], 1);
    assert.equal(outcome.metrics['measured_ratio'], 'N/A');
    assert.equal(outcome.metrics['balance_pre_settled'], 0, '首比不稳 → pre 不认净');
    assert.ok((outcome.metrics['balance_pre_polls'] as number) >= 3);
    assert.ok(
      outcome.findings.some((f) => f.level === 'info' && /未即时稳定/.test(f.message)),
      JSON.stringify(outcome.findings),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** 便宜价 + 整数美分余额 + 可控 usage 的端到端夹具（top-up 判定面）。
 * 前 2 次余额读数 = 窗口前 0（pre 首比即稳），其后按 addSpend 累计的 USD 圆整为整数美分。 */
function startCentBalanceFixture(): Promise<{ baseUrl: string; addSpend: (usd: number) => void; close: () => Promise<void> }> {
  let spentUsd = 0;
  let probeReads = 0;
  const server = createServer((req, res) => {
    if (req.url === '/v1/dashboard/billing/usage') {
      probeReads += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ total_usage: probeReads <= 2 ? 0 : Math.round(spentUsd * 100) }));
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        addSpend: (usd: number) => {
          spentUsd += usd;
        },
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

test('probeBilling：应缴金额低于美分刻度门槛 → 自适应补采抬升 Δ 至可判定区间，倍率可出数', async () => {
  const fixture = await startCentBalanceFixture();
  try {
    const prices = { input: 0.15, output: 0.6 };
    const seenPrompts: number[] = [];
    const client: OpenAIClient = {
      baseUrl: fixture.baseUrl,
      async chat(req: ChatRequest): Promise<ChatResult> {
        const promptTokens = Math.max(100, estimateMessageTokens(req.messages));
        seenPrompts.push(promptTokens);
        fixture.addSpend((promptTokens * prices.input + 16 * prices.output) / 1e6);
        return usageResult(promptTokens);
      },
    };
    const ctx = billingCtx(client);
    ctx.cfg.priceInput = prices.input;
    ctx.cfg.priceOutput = prices.output;
    const outcome = await probeBilling(ctx);
    // 主序列 10 笔 × 小 usage ≈ $0.0016 < 作废门 $0.03：必须触发补采
    const topups = outcome.metrics['billing_topup_requests'] as number;
    assert.ok(topups >= 5, `topups=${topups}`);
    assert.ok(topups <= 8, `topups=${topups}（8 笔封顶）`);
    assert.ok((outcome.metrics['expected_cost'] as number) >= 0.03, `expected=${outcome.metrics['expected_cost']}`);
    assert.ok(typeof outcome.metrics['measured_ratio'] === 'number', `ratio=${outcome.metrics['measured_ratio']}`);
    assert.ok((outcome.metrics['measured_ratio'] as number) > 0.5 && (outcome.metrics['measured_ratio'] as number) < 1.5, `ratio=${outcome.metrics['measured_ratio']}`);
    assert.equal(outcome.metrics['balance_pre_settled'], 1, 'pre 首比即稳');
    // 补采请求 = 大 prompt（≥48000 估算 token 的正文），计入窗口但主序列样本数不变
    assert.ok(seenPrompts.filter((p) => p >= 40000).length === topups, '每笔补采都是最大档正文');
    assert.equal(outcome.metrics['requests'], 10 + topups);
    assert.ok(outcome.findings.some((f) => f.level === 'info' && /补采/.test(f.message)), JSON.stringify(outcome.findings));
  } finally {
    await fixture.close();
  }
});

test('probeBilling：超便宜价 8 笔补采也到不了门槛 → 跳过补采不为注定 N/A 的窗口付费', async () => {
  const fixture = await startCentBalanceFixture();
  try {
    const prices = { input: 0.02, output: 0.08 };
    const client: OpenAIClient = {
      baseUrl: fixture.baseUrl,
      async chat(req: ChatRequest): Promise<ChatResult> {
        const promptTokens = Math.max(100, estimateMessageTokens(req.messages));
        fixture.addSpend((promptTokens * prices.input + 16 * prices.output) / 1e6);
        return usageResult(promptTokens);
      },
    };
    const ctx = billingCtx(client);
    ctx.cfg.priceInput = prices.input;
    ctx.cfg.priceOutput = prices.output;
    const outcome = await probeBilling(ctx);
    assert.equal(outcome.metrics['billing_topup_requests'], 0, '预检不可达 → 一笔不发');
    assert.equal(outcome.metrics['billing_topup_skipped'], 1);
    assert.equal(outcome.metrics['requests'], 10, '主序列 10 笔，无补采');
    assert.equal(outcome.metrics['measured_ratio'], 'N/A');
    assert.ok(outcome.findings.some((f) => f.level === 'info' && /跳过补采/.test(f.message)), JSON.stringify(outcome.findings));
  } finally {
    await fixture.close();
  }
});

test('probeBilling：补采首笔失败 → 立即停并如实污染窗口（不为注定 N/A 的窗口继续付费）', async () => {
  const fixture = await startCentBalanceFixture();
  try {
    const prices = { input: 0.15, output: 0.6 };
    let topupCalls = 0;
    const client: OpenAIClient = {
      baseUrl: fixture.baseUrl,
      async chat(req: ChatRequest): Promise<ChatResult> {
        const promptTokens = Math.max(100, estimateMessageTokens(req.messages));
        if (promptTokens >= 40000) {
          topupCalls += 1;
          return errorResult(); // 首笔补采即失败
        }
        fixture.addSpend((promptTokens * prices.input + 16 * prices.output) / 1e6);
        return usageResult(promptTokens);
      },
    };
    const ctx = billingCtx(client);
    ctx.cfg.priceInput = prices.input;
    ctx.cfg.priceOutput = prices.output;
    const outcome = await probeBilling(ctx);
    assert.equal(outcome.metrics['billing_topup_requests'], 1);
    assert.equal(topupCalls, 1, '失败后立即停，不再发第二笔');
    assert.equal(outcome.metrics['ratio_contaminated'], 1, '失败请求污染窗口');
    assert.equal(outcome.metrics['measured_ratio'], 'N/A');
    assert.ok(outcome.findings.some((f) => f.level === 'warn' && /失败/.test(f.message)), JSON.stringify(outcome.findings));
  } finally {
    await fixture.close();
  }
});

// ---------- 金额侧标准后缀块（口径标签 / 固定顺序 / 补充说明槽） ----------

type MoneyArgs = Parameters<typeof composeMoneySide>[0];

function moneyArgs(patch: Partial<MoneyArgs> = {}): MoneyArgs {
  return {
    priceEnabled: false,
    balanceEnabled: false,
    measuredRatio: null,
    measuredRatioInHeadline: false,
    spendDelta: null,
    balanceUnit: null,
    balanceEndpointUnavailable: false,
    balanceUnstable: false,
    balanceContaminated: false,
    balanceScope: null,
    maskedVerdict: null,
    ratioUnattributable: false,
    calibratedUnit: null,
    calibrationConfidence: null,
    anchorInPerM: null,
    anchorOutPerM: null,
    claimedRatioIn: null,
    claimedRatioOut: null,
    declaredEstimate: null,
    expectedUsd: null,
    expectedQuota: null,
    expectedIsUpperBound: false,
    quotaPerUnitSynthetic: false,
    publicPrice: null,
    publicPriceState: null,
    declaredState: 'not_applicable',
    modelCovered: false,
    groupRatioUnverified: false,
    chargePerRequest: false,
    driftUp: 0,
    driftDown: 0,
    driftInHeadline: false,
    absoluteVerified: false,
    ...patch,
  };
}

const PRICED_ESTIMATE = {
  quota: 100000,
  usd: 0.12,
  inputUsdPerM: 2,
  outputUsdPerM: 8,
  isUpperBound: true,
  isLowerBound: false,
  state: 'priced' as const,
  unverifiedReason: null,
  groupRatioUnverified: false,
  expectedQuota: 100000,
};

test('composeMoneySide：固定顺序且每个数字带口径标签（实测/估算/只比价目）', () => {
  const text = composeMoneySide(
    moneyArgs({
      priceEnabled: true,
      balanceEnabled: true,
      measuredRatio: 1.2,
      spendDelta: 0.12,
      balanceUnit: 'USD',
      anchorInPerM: 2,
      anchorOutPerM: 8,
      claimedRatioIn: 1.2,
      claimedRatioOut: 1.4,
      declaredEstimate: PRICED_ESTIMATE,
      expectedUsd: 0.12,
      expectedIsUpperBound: true,
      modelCovered: true,
    }),
  );
  assert.match(text, /实扣倍率 1\.2×/, text);
  assert.match(text, /实扣（实测）0\.12 USD/, text);
  assert.match(text, /按价目应扣 \$0\.12（估算，上界）/, text);
  assert.match(text, /你填的单价÷站点现价 输入 1\.2× · 输出 1\.4×（只比价目，未看实扣）/, text);
  assert.match(text, /站点现价：输入 \$2\/百万 · 输出 \$8\/百万/, text);
  const order = ['实扣倍率', '按价目应扣', '实扣（实测）', '你填的单价', '站点现价', '补充说明'].map((key) => text.indexOf(key));
  assert.ok(
    order.every((index) => index >= 0) && order.every((index, i) => i === 0 || (order[i - 1] ?? -1) < index),
    `后缀块顺序漂移：${text}`,
  );
  assert.match(text, /补充说明：未与外部硬证据比对/, text);
});

test('composeMoneySide：默认不读余额 → 主结论后仍给出实际扣款未核对与未与外部硬证据比对', () => {
  assert.equal(
    composeMoneySide(moneyArgs()),
    '；补充说明：实际扣款未核对（默认不读余额）；未与外部硬证据比对（实扣倍率、历史用量基准均缺）',
    '金额信息不得因未启用价格/余额而缺失',
  );
});

test('composeMoneySide：校准采信标「推断口径 + 置信档」，用户级口径标永不 fail', () => {
  const text = composeMoneySide(
    moneyArgs({
      balanceEnabled: true,
      measuredRatio: 238.569,
      spendDelta: 12,
      balanceUnit: 'USD',
      balanceScope: 'user',
      maskedVerdict: 'fail',
      ratioUnattributable: true,
      calibratedUnit: 'cents',
      calibrationConfidence: 'high',
    }),
  );
  assert.match(text, /实扣倍率 238\.569×（扣费按 cents 口径换算，置信 high，换算值为估算）/, text);
  assert.match(text, /实扣 12 USD（按 cents 口径换算的估算值，置信 high）/, text);
  assert.match(
    text,
    /补充说明：实扣倍率异常但说不清是谁多扣的（疑并发消费混入或单位错配），本次不判 fail（底层判定 fail 记录于 metrics）；余额为用户级口径（该用户所有 key 共享），无法排除其他 key 的消费，本次不判 fail（底层判定 fail 记录于 metrics）/,
    text,
  );
});

test('composeMoneySide：按次计费/分组未核验进补充说明槽，不用 N/A 占位', () => {
  const text = composeMoneySide(
    moneyArgs({
      priceEnabled: true,
      modelCovered: true,
      chargePerRequest: true,
      groupRatioUnverified: true,
      declaredEstimate: { ...PRICED_ESTIMATE, state: 'unverified', unverifiedReason: '按次计费（quota_type=1），单价单位未核验' },
    }),
  );
  assert.ok(!text.includes('按价目应扣 N/A'), text);
  assert.ok(!text.includes('价目对比 N/A'), text);
  assert.match(text, /实扣 未测（默认不读余额）/, text);
  assert.match(text, /补充说明：按次计费，金额未验证；站点分组折扣未知，按无折扣（×1）计算；未与外部硬证据比对（实扣倍率、历史用量基准均缺）/, text);
});

test('composeMoneySide：主句已带倍率数字时后缀去重，不重复同一测量值', () => {
  const text = composeMoneySide(
    moneyArgs({
      balanceEnabled: true,
      measuredRatio: 2.345,
      measuredRatioInHeadline: true,
      spendDelta: 0.23,
      balanceUnit: 'USD',
    }),
  );
  assert.ok(!/实扣倍率 [\d.]+×/.test(text), `后缀不得重复主句数字：${text}`);
  assert.match(text, /实扣（实测）0\.23 USD/, text);
});

test('ratioHeadline：主句保留原始倍率数字，fail/warn 结论不丢数据也不失真', () => {
  const base = {
    verdict: 'ok' as const,
    maskedVerdict: null,
    cap: null,
    ratio: 2.345,
    finding: { level: 'fail' as const, message: '', evidenceIds: [] },
  };
  assert.match(ratioHeadline(base, 'pass') ?? '', /实际扣费是应缴的 2\.345 倍，计费虚高（判据 >1\.5 倍）/, 'fail 主句必须带实扣倍率数字');
  assert.match(
    ratioHeadline({ ...base, verdict: 'warn', ratio: 0.42, finding: { level: 'warn', message: '', evidenceIds: [] } }, 'pass') ?? '',
    /实际扣费是应缴的 0\.42 倍，异常偏低/,
    'warn 主句必须带实扣倍率数字',
  );
  assert.match(
    ratioHeadline({ ...base, verdict: 'N/A', ratio: 238.569, maskedVerdict: 'fail' }, 'pass') ?? '',
    /实际扣费是应缴的 238\.569 倍，异常但说不清是谁多扣的/,
    '不可归因主句同样保留原始倍率',
  );
});

test('composeMoneySide：N/A 一律带标准原因短语', () => {
  const synthetic = composeMoneySide(moneyArgs({ priceEnabled: true, modelCovered: true, quotaPerUnitSynthetic: true }));
  assert.match(synthetic, /按价目应扣 N\/A（站点未公示 quota_per_unit 换算率）/, synthetic);
  assert.match(synthetic, /价目对比 N\/A（站点未公示 quota_per_unit 换算率）/, synthetic);
  const unavailable = composeMoneySide(moneyArgs({ balanceEnabled: true, balanceEndpointUnavailable: true }));
  assert.match(unavailable, /实扣 N\/A（该站没有可用的余额接口）/, unavailable);
  const contaminated = composeMoneySide(moneyArgs({ balanceEnabled: true, balanceContaminated: true }));
  assert.match(contaminated, /实扣 N\/A（窗口内扣费混入其他消费，无法归因到本次测试）/, contaminated);
});