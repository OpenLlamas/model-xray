import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Scoreboard,
  computeDimensions,
  computeObserved,
  formatScorecard,
  type DimensionScore,
  type ScoreSample,
  type Scorecard,
} from '../../src/guard/scoreboard.js';

function sample(overrides: Partial<ScoreSample> = {}): ScoreSample {
  return {
    status: 200,
    aborted: false,
    modelReq: 'gpt-4o',
    modelResp: 'gpt-4o',
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    usageRejected: null,
    finishReason: 'stop',
    ttftMs: null,
    deepInspect: true,
    ...overrides,
  };
}

function dim(dims: DimensionScore[], id: DimensionScore['id']): DimensionScore {
  const found = dims.find((d) => d.id === id);
  assert.ok(found, `维度 ${id} 应存在`);
  return found as DimensionScore;
}

test('scoreboard：窗口滚动（>100 剔除最旧，requests 恒 ≤100）', () => {
  const sb = new Scoreboard();
  for (let i = 1; i <= 105; i += 1) sb.record(sample(), String(i));
  const card = sb.card();
  assert.equal(card.requests, 100);
  assert.equal(card.fromId, '6', '最旧样本应被剔除（#1-#5 滚出窗口）');
  assert.equal(card.toId, '105');
  assert.equal(sb.size(), 100);
});

test('scoreboard：emit 计数（19 不触发 / 20、40 触发 / 计数不复位继续累计到 60）', () => {
  const emitted: Scorecard[] = [];
  const sb = new Scoreboard({ windowSize: 100, emitEvery: 20, onEmit: (card) => emitted.push(card) });
  for (let i = 1; i <= 19; i += 1) sb.record(sample(), String(i));
  assert.equal(emitted.length, 0, '19 个不应触发');
  sb.record(sample(), '20');
  assert.equal(emitted.length, 1, '第 20 个触发');
  assert.equal(emitted[0]?.toId, '20');
  for (let i = 21; i <= 40; i += 1) sb.record(sample(), String(i));
  assert.equal(emitted.length, 2, '第 40 个触发（计数继续累计而非窗口内重新数）');
  for (let i = 41; i <= 60; i += 1) sb.record(sample(), String(i));
  assert.equal(emitted.length, 3, 'emit 后计数不复位：60=3×20');
});

test('scoreboard：final() 无论计数必 emit 一次（含空窗 → 总评 na）', () => {
  const emitted: Scorecard[] = [];
  const sb = new Scoreboard({ emitEvery: 20, onEmit: (card) => emitted.push(card) });
  sb.final();
  assert.equal(emitted.length, 1, '空窗 final 也输出一张卡');
  assert.equal(emitted[0]?.requests, 0);
  assert.deepEqual(emitted[0]?.overall, { score: null, level: 'na' }, '空窗总评 N/A，不得判 fail');

  const emitted2: Scorecard[] = [];
  const sb2 = new Scoreboard({ emitEvery: 20, onEmit: (card) => emitted2.push(card) });
  sb2.record(sample(), '1');
  sb2.final();
  assert.equal(emitted2.length, 1, 'totalCompleted=1 未到 emit 点，final 仍必输出一次');
  assert.equal(emitted2[0]?.requests, 1);
});

test('scoreboard：可用性（aborted 不入分母只入观测；全 aborted → N/A）', () => {
  const d = computeDimensions([sample({ aborted: true, status: 0 }), sample({ status: 500 }), sample()], null);
  assert.equal(dim(d, 'availability').score, 50, '非 aborted 分母 2（aborted 剔除），2xx 1/2');
  const allAborted = computeDimensions([sample({ aborted: true, status: 0 })], null);
  assert.deepEqual(dim(allAborted, 'availability'), { id: 'availability', score: null, level: 'na' });

  const sb = new Scoreboard({});
  sb.record(sample({ aborted: true, status: 0, usage: null, ttftMs: null }), '1');
  const card = sb.card();
  assert.equal(card.dims.find((x) => x.id === 'availability')?.level, 'na');
  assert.equal(card.observed.aborted, 1, 'aborted 计入观测');
});

test('scoreboard：计量维度（usage 判定缺失 → N/A；rejected 占比扣分）', () => {
  const d = computeDimensions([sample(), sample({ usage: null, usageRejected: 'inconsistent' })], null);
  assert.equal(dim(d, 'billing').score, 50);
  const na = computeDimensions([sample({ usage: null, usageRejected: null })], null);
  assert.deepEqual(dim(na, 'billing'), { id: 'billing', score: null, level: 'na' });
});

test('scoreboard：身份维度（modelReq/modelResp 双双已知才入分母）', () => {
  const d = computeDimensions([sample(), sample({ modelResp: 'GLM-4' })], null);
  assert.equal(dim(d, 'identity').score, 50);
  const na = computeDimensions([sample({ modelReq: null, modelResp: null })], null);
  assert.deepEqual(dim(na, 'identity'), { id: 'identity', score: null, level: 'na' });
});

test('scoreboard：时延 p50 分段边界（2000/2001/5000/5001/8000/8001）与偶数集中位', () => {
  const edges: Array<[number, number]> = [
    [2000, 100],
    [2001, 85],
    [5000, 85],
    [5001, 70],
    [8000, 70],
    [8001, 50],
  ];
  for (const [ttft, expected] of edges) {
    const d = computeDimensions([sample({ ttftMs: ttft })], null);
    assert.equal(dim(d, 'latency').score, expected, `ttft=${ttft}`);
  }
  const even = computeDimensions([sample({ ttftMs: 100 }), sample({ ttftMs: 3000 })], null);
  assert.equal(dim(even, 'latency').score, 100, 'p50=1550 ≤2000');
  assert.equal(dim(even, 'latency').p50Ms, 1550);
  const na = computeDimensions([sample({ ttftMs: null })], null);
  assert.deepEqual(dim(na, 'latency'), { id: 'latency', score: null, level: 'na', p50Ms: null });
});

test('scoreboard：成本维度（ok/warn/fail 映射、skipped 类与未注入 → N/A、多结算取最新）', () => {
  assert.equal(dim(computeDimensions([], { verdict: 'ok' }), 'cost').score, 100);
  assert.equal(dim(computeDimensions([], { verdict: 'warn' }), 'cost').score, 70);
  assert.equal(dim(computeDimensions([], { verdict: 'fail' }), 'cost').score, 40);
  assert.equal(dim(computeDimensions([], { verdict: 'skipped' }), 'cost').level, 'na');
  assert.equal(dim(computeDimensions([], { verdict: 'skipped_recharge' }), 'cost').level, 'na');
  assert.equal(dim(computeDimensions([], null), 'cost').level, 'na', '未注入 setCost → N/A');

  const sb = new Scoreboard({});
  sb.setCost({ ratio: 1.0, verdict: 'ok' });
  sb.setCost({ ratio: null, verdict: 'skipped_recharge' });
  assert.equal(dim(sb.card().dims, 'cost').level, 'na', '最近一次结算生效');
  sb.setCost({ ratio: 1.2, verdict: 'warn' });
  assert.equal(dim(sb.card().dims, 'cost').score, 70);
});

test('scoreboard：分级边界（95 ok / 94 warn / 80 warn / 79 fail）', () => {
  const mk = (okCount: number, total: number): ScoreSample[] =>
    Array.from({ length: total }, (_, i) => sample({ status: i < okCount ? 200 : 500 }));
  assert.equal(dim(computeDimensions(mk(19, 20), null), 'availability').level, 'ok', '95 → ok');
  assert.equal(dim(computeDimensions(mk(94, 100), null), 'availability').level, 'warn', '94 → warn');
  assert.equal(dim(computeDimensions(mk(80, 100), null), 'availability').level, 'warn', '80 → warn');
  assert.equal(dim(computeDimensions(mk(79, 100), null), 'availability').level, 'fail', '79 → fail');
});

test('scoreboard：观测值（截断率分母=有 finish_reason 样本；缺用量；中止）', () => {
  const obs = computeObserved([
    sample({ finishReason: 'length' }),
    sample({ finishReason: 'stop' }),
    sample({ finishReason: null, usage: null, usageRejected: null }),
    sample({ aborted: true, status: 0, usage: null, ttftMs: null, finishReason: null }),
  ]);
  assert.equal(obs.finishLengthRate, 0.5, '1/2（分母=finishReason!=null 数）');
  assert.equal(obs.usageMissing, 2);
  assert.equal(obs.aborted, 1);
  assert.equal(computeObserved([]).finishLengthRate, null, '无样本 → null（展示为 —）');
});

test('scoreboard：缺用量观测只计已深检样本（deepInspect=false 的自身局限不归因上游）', () => {
  // ① deepInspect=false（超限/降级/解析失败等自身局限）且 usage 双缺 → 不计缺用量
  const notInspected = computeObserved([
    sample({ deepInspect: false, usage: null, usageRejected: null }),
    sample({ deepInspect: false, usage: null, usageRejected: null, finishReason: null }),
  ]);
  assert.equal(notInspected.usageMissing, 0, '未深检样本的缺用量不得计入（我们自己的局限）');
  // ② deepInspect=true（完成深检）且 usage 双缺 → 计 1（确属上游没给）
  const inspected = computeObserved([sample({ deepInspect: true, usage: null, usageRejected: null })]);
  assert.equal(inspected.usageMissing, 1, '已深检且缺用量 → 计 1');
  // 混合窗口：只有已深检的缺用量进观测
  const mixed = computeObserved([
    sample({ deepInspect: true, usage: null, usageRejected: null }),
    sample({ deepInspect: false, usage: null, usageRejected: null }),
    sample(),
  ]);
  assert.equal(mixed.usageMissing, 1);
  // 分母语义不随 deepInspect 变化：usage 存在即有效证据，billing/identity/latency 照常计分
  const dims = computeDimensions([sample({ deepInspect: false })], null);
  assert.equal(dim(dims, 'billing').score, 100, '有 usage 即有效判定，与深检与否无关');
});

test('scoreboard：全 N/A → 总评 na；有分维度 → 总评取最差', () => {
  const empty = new Scoreboard({});
  assert.deepEqual(empty.card().overall, { score: null, level: 'na' });

  const sb = new Scoreboard({});
  sb.record(sample({ ttftMs: 100, status: 500 }), '1');
  sb.record(sample({ ttftMs: 100, status: 500 }), '2'); // 可用性 0 → 最差
  const card = sb.card();
  assert.equal(card.overall.score, 0);
  assert.equal(card.overall.level, 'fail');
});

test('formatScorecard：color=false 确定性单行（无 ANSI 泄漏）', () => {
  const card: Scorecard = {
    fromId: '41',
    toId: '60',
    requests: 20,
    dims: [
      { id: 'availability', score: 100, level: 'ok' },
      { id: 'billing', score: 100, level: 'ok' },
      { id: 'identity', score: 95, level: 'ok' },
      { id: 'latency', score: 85, level: 'warn', p50Ms: 1500 },
      { id: 'cost', score: null, level: 'na' },
    ],
    observed: { finishLengthRate: 0.12, usageMissing: 2, aborted: 0 },
    overall: { score: 85, level: 'warn' },
  };
  const plain = formatScorecard(card, { color: false });
  assert.equal(
    plain,
    '[guard][评分] #41-#60（20 请求） 可用性 100[OK] · 计量 100[OK] · 身份 95[OK] · 时延 85[WARN](1500ms) · 成本 N/A | 观测(不计总评)：截断 12% 缺用量 2 中止 0 | 总评 WARN(85)',
  );
  assert.ok(!plain.includes('\u001b'), 'color=false 不得含 ANSI 字节');
  assert.ok(!plain.includes('undefined'), '不得有 undefined 泄漏');
});

test('formatScorecard：color=true 含 ANSI 且剥掉后与纯文本一致；空窗卡全 N/A', () => {
  const card: Scorecard = {
    fromId: '1',
    toId: '2',
    requests: 2,
    dims: [
      { id: 'availability', score: 100, level: 'ok' },
      { id: 'billing', score: 79, level: 'fail' },
      { id: 'identity', score: null, level: 'na' },
      { id: 'latency', score: 85, level: 'warn', p50Ms: 3000 },
      { id: 'cost', score: null, level: 'na' },
    ],
    observed: { finishLengthRate: null, usageMissing: 0, aborted: 0 },
    overall: { score: 79, level: 'fail' },
  };
  const plain = formatScorecard(card, { color: false });
  const colored = formatScorecard(card, { color: true });
  assert.ok(colored.includes('\u001b[32m'), 'ok 级应含绿');
  assert.ok(colored.includes('\u001b[33m'), 'warn 级应含黄');
  assert.ok(colored.includes('\u001b[31m'), 'fail 级应含红');
  assert.ok(!plain.includes('\u001b'));
  assert.equal(colored.replace(/\u001b\[\d+m/g, ''), plain, '着色仅装饰，内容与纯文本一致');
  assert.match(plain, /截断 —/, 'finishLengthRate=null 显示 —');

  const empty = formatScorecard(new Scoreboard({}).card(), { color: false });
  assert.match(empty, /\[guard\]\[评分\] #-（0 请求）/);
  assert.match(empty, /总评 N\/A/);
});
