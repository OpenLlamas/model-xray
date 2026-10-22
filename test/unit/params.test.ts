import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockServer, type MockMode, type MockOptions } from '../mock-server.js';
import { createClient } from '../../src/client.js';
import { createEvidenceRecorder } from '../../src/evidence.js';
import { createRng } from '../../src/random.js';
import { probeParams } from '../../src/probes/params.js';
import type { EvidenceRecord, ProbeCtx, RunConfig } from '../../src/types.js';

const SEED = 20261022;

function cfg(): RunConfig {
  return {
    baseUrl: 'http://127.0.0.1:0/v1',
    apiKey: 'secret-key-must-not-leak',
    model: 'gpt-4o',
    claimedContext: null,
    expect: [],
    deep: false,
    seed: SEED,
    timeoutMs: 5000,
    retries: 0,
    streamFallback: false,
    outDir: 'reports',
    html: false,
    yes: true,
    quiet: true,
  };
}

async function run(
  mode: MockMode,
  options: Omit<MockOptions, 'mode'> = {},
): Promise<{ outcome: Awaited<ReturnType<typeof probeParams>>; evidence: EvidenceRecord[] }> {
  const mock = await createMockServer({ mode, ...options });
  try {
    const client = createClient({ baseUrl: mock.baseUrl, apiKey: cfg().apiKey, timeoutMs: 5000, retries: 0 });
    const ctx: ProbeCtx = {
      client,
      cfg: cfg(),
      rng: createRng(SEED),
      evidence: createEvidenceRecorder(),
    };
    const outcome = await probeParams(ctx);
    return { outcome, evidence: ctx.evidence.all() };
  } finally {
    mock.server.close();
  }
}

test('params honest: 5 项全部遵守 → pass 100，证据 10 条且无凭证泄漏', async () => {
  const { outcome, evidence } = await run('params-honest');
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.level, 'pass');
  assert.equal(outcome.score, 100);
  assert.equal(outcome.metrics['scored_pass'], 5);
  assert.equal(outcome.metrics['scored_fail'], 0);
  assert.equal(outcome.metrics['seed_state'], 'pass');
  assert.equal(evidence.length, 10, `预期 10 条证据，实际 ${evidence.length}`);
  assert.equal(new Set(evidence.map((record) => record.id)).size, evidence.length);
  assert.ok(evidence.every((record) => record.probe === 'params'));
  assert.ok(outcome.findings.every((finding) => finding.evidenceIds.length > 0), JSON.stringify(outcome.findings));
  assert.equal(outcome.findings.filter((finding) => finding.level === 'fail').length, 0);
  // 证据只记录请求内容，不落 Authorization/API key。
  assert.ok(!JSON.stringify(evidence).includes(cfg().apiKey), 'evidence 不得包含 API key');
  const stopRequest = evidence.find((record) => record.label.startsWith('params stop='))!.request;
  assert.equal(stopRequest.stop?.length, 1);
  assert.ok(stopRequest.stop?.[0]?.startsWith('XRAYSTOP'));
  const nRequest = evidence.find((record) => record.label.startsWith('params n=2'))!.request;
  assert.equal(nRequest.n, 2);
  const logprobsRequest = evidence.find((record) => record.label.startsWith('params logprobs'))!.request;
  assert.equal(logprobsRequest.logprobs, true);
  assert.equal(logprobsRequest.topLogprobs, 3);
  const responseFormatRequest = evidence.find((record) => record.label.startsWith('params response_format='))!.request;
  assert.equal(responseFormatRequest.responseFormat, 'json_object');
  const seedRequest = evidence.find((record) => record.label.startsWith('params seed=12345'))!.request;
  assert.equal(seedRequest.seed, 12345);
  const nRecord = evidence.find((record) => record.label.startsWith('params n=2'))!;
  assert.equal(nRecord.response.choiceCount, 2);
  const logprobsRecord = evidence.find((record) => record.label.startsWith('params logprobs'))!;
  // 第二项 logprob=0，仍应计入有效 token 数（不能把 0 当成缺失）。
  assert.equal(logprobsRecord.response.logprobsTokenCount, 2);
});

test('params cheat: max_tokens/stop/response_format/n/logprobs 全被忽略 → fail 0 分，seed warn', async () => {
  const { outcome } = await run('params-cheat');
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.level, 'fail');
  assert.equal(outcome.score, 0);
  assert.equal(outcome.metrics['scored_fail'], 5);
  assert.equal(outcome.metrics['seed_state'], 'warn');
  const failures = outcome.findings.filter((finding) => finding.level === 'fail');
  assert.equal(failures.length, 5, JSON.stringify(outcome.findings));
  assert.deepEqual(
    failures.map((finding) => finding.message.split(' ')[0]).sort(),
    ['logprobs', 'max_tokens', 'n', 'response_format', 'stop'],
  );
  assert.ok(failures.every((finding) => finding.evidenceIds.length === 1));
});

test('params unsupported(n): 400 点名参数 → na，不判 fail，其余 4 项仍给分', async () => {
  const { outcome } = await run('params-honest', { paramReject: ['n'] });
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.level, 'pass');
  assert.equal(outcome.score, 100);
  assert.equal(outcome.metrics['n_state'], 'na');
  assert.equal(outcome.metrics['scored_pass'], 4);
  assert.equal(outcome.metrics['scored_na'], 1);
  assert.equal(outcome.findings.filter((finding) => finding.level === 'fail').length, 0);
  assert.ok(outcome.findings.some((finding) => finding.level === 'info' && /n 未判定/.test(finding.message)));
});

test('params all unsupported: 全部 400 → insufficient/unknown，不出分且无 fail', async () => {
  const { outcome } = await run('params-honest', {
    paramReject: ['max_tokens', 'stop', 'response_format', 'n', 'logprobs', 'seed'],
  });
  assert.equal(outcome.status, 'insufficient');
  assert.equal(outcome.level, 'unknown');
  assert.equal(outcome.score, null);
  assert.equal(outcome.metrics['scored_pass'], 0);
  assert.equal(outcome.metrics['scored_fail'], 0);
  assert.equal(outcome.metrics['scored_na'], 5);
  assert.equal(outcome.findings.filter((finding) => finding.level === 'fail').length, 0);
});

test('params coverage gate: 仅 2 项有效（3 项 na）→ 不出分，避免单点有效即判 100', async () => {
  const { outcome } = await run('params-honest', { paramReject: ['stop', 'n', 'logprobs'] });
  assert.equal(outcome.status, 'insufficient');
  assert.equal(outcome.level, 'unknown');
  assert.equal(outcome.score, null);
  assert.equal(outcome.metrics['scored_pass'], 2);
  assert.equal(outcome.metrics['scored_na'], 3);
});

test('params force SSE: n 按 chunk index 计数可判定，logprobs 仍降级为 na', async () => {
  const { outcome } = await run('params-honest', { paramForceSse: true });
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.level, 'pass');
  assert.equal(outcome.score, 100);
  assert.equal(outcome.metrics['n_state'], 'pass');
  assert.equal(outcome.metrics['logprobs_state'], 'na');
  assert.equal(outcome.metrics['scored_pass'], 4);
  assert.equal(outcome.metrics['scored_na'], 1);
  assert.equal(outcome.findings.filter((finding) => finding.level === 'fail').length, 0);
});

test('params response_format: ```json 围栏按合法 JSON 处理', async () => {
  const { outcome } = await run('params-honest', { paramFenceJson: true });
  assert.equal(outcome.metrics['response_format_state'], 'pass');
  assert.equal(outcome.level, 'pass');
});

test('params max_tokens: completion=1 但 finish_reason=stop → na，不判假 pass', async () => {
  const { outcome } = await run('params-honest', { paramNaturalStop: true });
  assert.equal(outcome.metrics['max_tokens_state'], 'na');
  assert.equal(outcome.metrics['scored_pass'], 4);
  assert.equal(outcome.metrics['scored_na'], 1);
  assert.equal(outcome.findings.filter((finding) => finding.level === 'fail').length, 0);
});

test('params max_tokens: completion=0 且 finish_reason=length → na，不判假 pass', async () => {
  const { outcome } = await run('params-honest', { paramZeroLength: true });
  assert.equal(outcome.metrics['max_tokens_state'], 'na');
  assert.equal(outcome.metrics['scored_pass'], 4);
  assert.equal(outcome.metrics['scored_na'], 1);
  assert.equal(outcome.findings.filter((finding) => finding.level === 'fail').length, 0);
});

test('params stop: 空正文 + finish_reason=length → na，不判假 pass', async () => {
  const { outcome } = await run('params-honest', { paramStopBlank: true });
  assert.equal(outcome.metrics['stop_state'], 'na');
  assert.equal(outcome.metrics['scored_pass'], 4);
  assert.equal(outcome.metrics['scored_na'], 1);
  assert.equal(outcome.findings.filter((finding) => finding.level === 'fail').length, 0);
});

test('params stop: 不含哨兵但 finish_reason=null → na，不把自然结束判成 stop 生效', async () => {
  const { outcome } = await run('params-honest', { paramStopNoFinish: true });
  assert.equal(outcome.metrics['stop_state'], 'na');
  assert.equal(outcome.metrics['scored_pass'], 4);
  assert.equal(outcome.metrics['scored_na'], 1);
  assert.equal(outcome.findings.filter((finding) => finding.level === 'fail').length, 0);
});

test('params n: 两个 choices 共用 index 0 → fail，重复索引不算独立候选', async () => {
  const { outcome } = await run('params-honest', { paramDuplicateN: true });
  assert.equal(outcome.metrics['n_state'], 'fail');
  assert.equal(outcome.metrics['scored_fail'], 1);
  assert.equal(outcome.metrics['scored_pass'], 4);
  assert.ok(outcome.findings.some((finding) => /n 参数被静默忽略/.test(finding.message)));
});

test('params logprobs: 条目缺少有限 logprob → fail，不把空对象当生效', async () => {
  const { outcome } = await run('params-honest', { paramLogprobsInvalid: true });
  assert.equal(outcome.metrics['logprobs_state'], 'fail');
  assert.equal(outcome.metrics['scored_fail'], 1);
  assert.equal(outcome.metrics['scored_pass'], 4);
  assert.equal(outcome.findings.filter((finding) => finding.level === 'fail').length, 1);
});

test('params 200 空 choices 数组：归为请求失败，不误判空正文', async () => {
  const { outcome } = await run('empty-choices');
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.score, null);
  assert.equal(outcome.findings.filter((finding) => finding.level === 'fail').length, 0);
});

test('params 200 error 信封：解析为请求失败，不把 response_format 误判 fail', async () => {
  const { outcome } = await run('error-payload');
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.score, null);
  assert.equal(outcome.findings.filter((finding) => finding.level === 'fail').length, 0);
});

test('params 200 无 choices 无 error：归为请求失败，不误判空正文', async () => {
  const { outcome } = await run('invalid-payload');
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.score, null);
  assert.equal(outcome.findings.filter((finding) => finding.level === 'fail').length, 0);
});

test('params auth-required: 401 归 error，不出分且不诬告', async () => {
  const { outcome } = await run('auth-required');
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.score, null);
  assert.equal(outcome.findings.filter((finding) => finding.level === 'fail').length, 0);
});

test('params error 落盘脱敏：API key 不进入 evidence', async () => {
  const key = 'sk-abcdefghijklmnop';
  const { evidence } = await run('params-honest', { paramReject: ['n'], errorEcho: key });
  const serialized = JSON.stringify(evidence);
  assert.ok(!serialized.includes(key), 'evidence 不得包含 API key');
  assert.ok(serialized.includes('sk-***'), '脱敏占位符应出现在错误文本中');
});
