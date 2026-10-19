import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createMockServer } from './mock-server.js';
import type { JournalEntry, RequestEntry, ReconcileEntry, AnomalyEntry, ScoreEntry } from '../src/guard/journal.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function findRepoRoot(): string {
  let dir = HERE;
  for (let i = 0; i < 6; i += 1) {
    if (readdirSync(dir).includes('scripts') && readdirSync(join(dir, 'scripts')).includes('web-server.mjs')) return dir;
    dir = dirname(dir);
  }
  throw new Error(`找不到仓库根（从 ${HERE} 向上 6 层）`);
}

const REPO_ROOT = findRepoRoot();
const CLI = join(REPO_ROOT, 'dist', 'src', 'cli.js');
const GUARD_KEY = 'sk-guard-e2e-SECRET';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

interface GuardHandle {
  child: ChildProcess;
  stdoutText: () => string;
  stderrText: () => string;
  exited: Promise<number | null>;
  waitReady: (timeoutMs?: number) => Promise<number>;
  shutdown: (timeoutMs?: number) => Promise<number | null>;
}

function startGuard(args: string[], env: NodeJS.ProcessEnv = process.env): GuardHandle {
  const child = spawn(process.execPath, [CLI, ...args], { env: { ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => outChunks.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => errChunks.push(chunk));
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return {
    child,
    stdoutText: () => Buffer.concat(outChunks).toString('utf8'),
    stderrText: () => Buffer.concat(errChunks).toString('utf8'),
    exited,
    async waitReady(timeoutMs = 15000): Promise<number> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const match = /127\.0\.0\.1:(\d+)/.exec(this.stdoutText());
        if (match !== null) return Number(match[1]);
        if (await Promise.race([exited.then(() => true), delay(0).then(() => false)])) {
          throw new Error(`guard 提前退出（code=${await exited}）：\nstdout=${this.stdoutText()}\nstderr=${this.stderrText()}`);
        }
        if (Date.now() > deadline) throw new Error(`guard 启动超时：\nstdout=${this.stdoutText()}\nstderr=${this.stderrText()}`);
        await delay(50);
      }
    },
    async shutdown(timeoutMs = 15000): Promise<number | null> {
      child.stdin?.end();
      const winner = await Promise.race([exited.then((code) => ({ code, timeout: false })), delay(timeoutMs).then(() => ({ code: null, timeout: true }))]);
      if (winner.timeout) {
        child.kill();
        throw new Error(`guard 未在 ${timeoutMs}ms 内退出：\nstdout=${this.stdoutText()}\nstderr=${this.stderrText()}`);
      }
      return winner.code;
    },
  };
}

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  raw: string;
}

function post(port: number, path: string, body: unknown, headers: Record<string, string> = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(payload.length), ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, raw: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/** 建立流式请求，收到上游首个响应块后立即销毁客户端连接（guard 断连审计用） */
function postAbortAfterFirstChunk(port: number, path: string, body: unknown, headers: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(payload.length), ...headers } },
      (res) => {
        res.once('data', () => {
          req.destroy();
          resolve();
        });
        res.on('error', () => undefined);
      },
    );
    req.on('error', () => resolve());
    req.on('close', () => resolve());
    req.end(payload);
    setTimeout(() => reject(new Error('postAbortAfterFirstChunk 超时')), 10000);
  });
}

interface JournalSnapshot {
  text: string;
  entries: JournalEntry[];
  requests: RequestEntry[];
  reconciles: ReconcileEntry[];
  anomalies: AnomalyEntry[];
  scores: ScoreEntry[];
}

function readJournal(dir: string): JournalSnapshot {
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  assert.ok(files.length >= 1, `审计目录应存在至少一个 .jsonl：${dir}`);
  const lines: string[] = [];
  for (const file of files) {
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (line.length > 0) lines.push(line);
    }
  }
  const entries = lines.map((line) => JSON.parse(line) as JournalEntry);
  return {
    text: lines.join('\n'),
    entries,
    requests: entries.filter((e): e is RequestEntry => e.type === 'request'),
    reconciles: entries.filter((e): e is ReconcileEntry => e.type === 'reconcile'),
    anomalies: entries.filter((e): e is AnomalyEntry => e.type === 'anomaly'),
    scores: entries.filter((e): e is ScoreEntry => e.type === 'score'),
  };
}

function pingBody(): Record<string, unknown> {
  // 'ping' 触发 mock 的 pong 回答；SECRETMSGMARKER 用于钉死「对话内容绝不落 journal」
  return { model: 'gpt-4o', messages: [{ role: 'user', content: 'ping SECRETMSGMARKER' }] };
}

test('guard e2e：SSE usage 入账、本地鉴权 401、凭证注入/隔离、query 剥离、journal 脱敏', async () => {
  const mock = await createMockServer({ mode: 'honest' });
  const port = await findFreePort();
  const outDir = makeTempDir('guard-e2e-basic-');
  const guard = startGuard(['guard', '--base-url', mock.baseUrl, '--port', String(port), '--out', outDir], {
    ...process.env,
    MODEL_XRAY_KEY: GUARD_KEY,
  });
  try {
    const guardPort = await guard.waitReady();

    // ① 无 key → 401，不转发（提示不含 key 值）
    const noAuth = await post(guardPort, '/v1/chat/completions', pingBody());
    assert.equal(noAuth.status, 401, `无 key 应 401，实际 ${noAuth.status}`);
    assert.match(noAuth.raw, /MODEL_XRAY_KEY/);
    assert.ok(!noAuth.raw.includes(GUARD_KEY), '401 响应不得回显 key');

    // ② 错 key → 401，不转发
    const wrong = await post(guardPort, '/v1/chat/completions', pingBody(), { authorization: 'Bearer wrong-key' });
    assert.equal(wrong.status, 401);

    // ③ 正确 key + 带 query 的路径 + proxy-authorization（应被剥离）→ SSE 透传
    const sse = await post(guardPort, '/v1/chat/completions?plugs=SECRETQUERYVALUE', { ...pingBody(), stream: true }, {
      authorization: `Bearer ${GUARD_KEY}`,
      'proxy-authorization': 'Bearer attacker-cred',
    });
    assert.equal(sse.status, 200, `SSE 应 200，实际 ${sse.status}：${sse.raw.slice(0, 200)}`);
    // mock 将回复按 chunk 切开（'pon'+'g'），需拼装 SSE delta 内容验证透传完整性
    const sseContent = [...sse.raw.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join('');
    assert.equal(sseContent, 'pong', `SSE 内容应透传，实际：${sse.raw.slice(0, 200)}`);
    assert.ok(sse.raw.includes('data: [DONE]'), 'SSE 应以 [DONE] 结束');
    assert.ok(!sse.raw.includes('attacker-cred'), '上游不应收到 proxy-authorization');

    // ④ 非流式 JSON 请求
    const json = await post(guardPort, '/v1/chat/completions', pingBody(), { authorization: `Bearer ${GUARD_KEY}` });
    assert.equal(json.status, 200);
    const parsed = JSON.parse(json.raw) as { model: string; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } };
    assert.equal(parsed.model, 'gpt-4o');
    // guard 字节透传：客户端收到的是 mock 原始嵌套 usage（cached=0、reasoning=min(1,completion)=1）
    assert.deepEqual(parsed.usage, {
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 1 },
    });

    await delay(300); // 等 finalize/写入队列收尾
    const code = await guard.shutdown();
    assert.equal(code, 0, `guard 应优雅退出（0），实际 ${code}；stderr=${guard.stderrText()}`);

    // ⑤ 上游收到的凭证：全部是注入的 env key，且 proxy-authorization 已剥离
    assert.equal(mock.state.served, 2, `mock 应只收到 2 个请求（401 不转发），实际 ${mock.state.served}`);
    assert.equal(mock.state.authSeen.length, 2);
    for (const auth of mock.state.authSeen) assert.equal(auth, `Bearer ${GUARD_KEY}`);
    assert.equal(mock.state.proxyAuthSeen.length, 0, 'proxy-authorization 不得到达上游');
    // mock.baseUrl 本身以 /v1 结尾：上游实收路径必须去重为单个 /v1 前缀（不得 /v1/v1/...），
    // 且 query 原样透传（透明转发红线）
    assert.deepEqual(
      mock.state.pathSeen,
      ['/v1/chat/completions?plugs=SECRETQUERYVALUE', '/v1/chat/completions'],
      '上游实收路径不得出现重复 /v1 前缀，query 须原样保留',
    );

    // ⑥ journal：逐请求行 + SSE usage 三元组 + 深检标记
    const journal = readJournal(outDir);
    assert.equal(journal.requests.length, 4, `应有 4 条请求行（2×401 + 2×200），实际 ${journal.requests.length}`);
    const sseEntry = journal.requests.find((r) => r.stream === true);
    assert.ok(sseEntry, '应存在流式请求行');
    // Usage 契约扩展：SSE 行内路径（honest stream）usage details 闭环——cached=0、reasoning=min(1,completion)=1
    assert.equal(sseEntry?.usage?.cached_tokens, 0);
    assert.equal(sseEntry?.usage?.reasoning_tokens, 1);
    assert.deepEqual(sseEntry?.usage, { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cached_tokens: 0, reasoning_tokens: 1 });
    assert.equal(sseEntry?.usageRejected, null);
    assert.equal(sseEntry?.modelReq, 'gpt-4o');
    assert.equal(sseEntry?.modelResp, 'gpt-4o');
    assert.equal(sseEntry?.deepInspect, true);
    assert.equal(sseEntry?.status, 200);
    assert.equal(sseEntry?.aborted, false);
    assert.equal(sseEntry?.path, '/v1/chat/completions', 'journal 应记去 query 后的 path');
    const denied = journal.requests.filter((r) => r.status === 401);
    assert.equal(denied.length, 2, '401 也要入账');
    for (const entry of denied) assert.deepEqual(entry.usage, null);

    // ⑦ 脱敏钉子：key/上游凭证/query 值/对话内容/任何 authorization 字段/query 问号
    assert.ok(!journal.text.includes(GUARD_KEY), 'journal 不得含 guard key');
    assert.ok(!journal.text.includes('wrong-key'), 'journal 不得含客户端错 key');
    assert.ok(!journal.text.includes('attacker-cred'), 'journal 不得含 proxy 凭证');
    assert.ok(!journal.text.includes('SECRETQUERYVALUE'), 'journal 不得含 query 值');
    assert.ok(!journal.text.includes('SECRETMSGMARKER'), 'journal 不得含对话内容');
    assert.ok(!/authorization/i.test(journal.text), 'journal 不得含 authorization 键');
    assert.ok(!journal.text.includes('?'), 'journal 元数据不得出现 ?（query 已剥）');

    // ⑧ stdout 摘要：一行一请求
    assert.match(guard.stdoutText(), /-> 200/);
    assert.match(guard.stdoutText(), /-> 401/);
  } finally {
    guard.child.kill();
    mock.server.closeAllConnections?.();
    mock.server.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('guard e2e：--base-url 带 /v1 时客户端两种路径形态均去重为单前缀', async () => {
  // mock.baseUrl 以 /v1 结尾（等价真实站点 --base-url https://relay/v1）。
  // 客户端 base-url 指 :port/v1（发 /v1/chat/completions）或 :port 根（发 /chat/completions）
  // 都必须命中上游 /v1/chat/completions——纯串接会拼出 /v1/v1/chat/completions 导致真实站点 404。
  const mock = await createMockServer({ mode: 'honest' });
  const port = await findFreePort();
  const outDir = makeTempDir('guard-e2e-dedup-');
  const guard = startGuard(['guard', '--base-url', mock.baseUrl, '--port', String(port), '--out', outDir], {
    ...process.env,
    MODEL_XRAY_KEY: GUARD_KEY,
  });
  try {
    const guardPort = await guard.waitReady();
    const withPrefix = await post(guardPort, '/v1/chat/completions', pingBody(), { authorization: `Bearer ${GUARD_KEY}` });
    assert.equal(withPrefix.status, 200, `带 /v1 前缀应 200，实际 ${withPrefix.status}：${withPrefix.raw.slice(0, 200)}`);
    const withoutPrefix = await post(guardPort, '/chat/completions', pingBody(), { authorization: `Bearer ${GUARD_KEY}` });
    assert.equal(withoutPrefix.status, 200, `不带 /v1 前缀应 200，实际 ${withoutPrefix.status}：${withoutPrefix.raw.slice(0, 200)}`);
    await delay(300);
    const code = await guard.shutdown();
    assert.equal(code, 0, `stderr=${guard.stderrText()}`);
    assert.equal(mock.state.served, 2, '两个请求都应到达上游 chat 路由');
    assert.deepEqual(
      mock.state.pathSeen,
      ['/v1/chat/completions', '/v1/chat/completions'],
      '上游实收路径必须恰为单个 /v1 前缀（去重）',
    );
  } finally {
    guard.child.kill();
    mock.server.closeAllConnections?.();
    mock.server.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('guard e2e：换模型 → model_mismatch 告警（stderr + journal anomaly）', async () => {
  const mock = await createMockServer({ mode: 'swap-model', identityName: 'GLM-4' });
  const port = await findFreePort();
  const outDir = makeTempDir('guard-e2e-swap-');
  const guard = startGuard(['guard', '--base-url', mock.baseUrl, '--port', String(port), '--out', outDir], {
    ...process.env,
    MODEL_XRAY_KEY: GUARD_KEY,
  });
  try {
    const guardPort = await guard.waitReady();
    const json = await post(guardPort, '/v1/chat/completions', pingBody(), { authorization: `Bearer ${GUARD_KEY}` });
    assert.equal(json.status, 200);
    assert.equal((JSON.parse(json.raw) as { model: string }).model, 'GLM-4', 'swap-model mock 应返回 GLM-4');

    await delay(300);
    const code = await guard.shutdown();
    assert.equal(code, 0);

    assert.match(guard.stderrText(), /model_mismatch/);
    assert.match(guard.stderrText(), /GLM-4/);
    assert.match(guard.stderrText(), /WARN/);

    const journal = readJournal(outDir);
    const anomaly = journal.anomalies.find((a) => a.code === 'model_mismatch');
    assert.ok(anomaly, 'journal 应有 model_mismatch anomaly 行');
    assert.equal(anomaly?.level, 'warn');
    const entry = journal.requests[0];
    assert.ok(entry);
    assert.equal(entry.modelReq, 'gpt-4o');
    assert.equal(entry.modelResp, 'GLM-4');
    assert.equal(anomaly?.requestId, entry.id, 'anomaly 应带 request id 关联');
  } finally {
    guard.child.kill();
    mock.server.closeAllConnections?.();
    mock.server.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('guard e2e：对账 k=1.3（可编程余额倍率）→ ratio≈1.3 verdict=warn', async () => {
  // mock usage 固定 {10,2,12}，价格 4000/5000 → 单请求成本 (10×4000+2×5000)/1e6=0.05，两请求 0.1；
  // balanceRate=1.3 → 余额扣减 0.13 USD（整数美分 13），guard 实测倍率恰为 1.3 → DRIFT warn 档。
  const mock = await createMockServer({ mode: 'honest', balanceBase: 1000, balanceRate: 1.3, priceInput: 4000, priceOutput: 5000 });
  const port = await findFreePort();
  const outDir = makeTempDir('guard-e2e-k13-');
  const guard = startGuard(
    ['guard', '--base-url', mock.baseUrl, '--port', String(port), '--out', outDir, '--price-input', '4000', '--price-output', '5000', '--reconcile-minutes', '15'],
    { ...process.env, MODEL_XRAY_KEY: GUARD_KEY },
  );
  try {
    const guardPort = await guard.waitReady();
    assert.match(guard.stdoutText(), /金额对账\s+开启/);
    for (let i = 0; i < 2; i += 1) {
      const res = await post(guardPort, '/v1/chat/completions', { ...pingBody(), stream: true }, { authorization: `Bearer ${GUARD_KEY}` });
      assert.equal(res.status, 200);
    }
    await delay(300);
    const code = await guard.shutdown();
    assert.equal(code, 0, `stderr=${guard.stderrText()}`);

    const journal = readJournal(outDir);
    assert.equal(journal.reconciles.length, 1, `应恰好 1 条对账行（shutdown 结算），实际 ${journal.reconciles.length}`);
    const reconcile = journal.reconciles[0];
    assert.ok(reconcile);
    assert.equal(reconcile.requests, 2);
    const expectedCost = (2 * (10 * 4000 + 2 * 5000)) / 1e6;
    // journal 数值统一 6 位小数圆整（0.13 → 0.13），容差取 1e-6 富余
    assert.ok(Math.abs((reconcile.cost ?? 0) - expectedCost) < 1e-6, `cost=${reconcile.cost} 期望 ${expectedCost}`);
    assert.ok(Math.abs((reconcile.spendDelta ?? 0) - 1.3 * expectedCost) < 1e-6, `spendDelta=${reconcile.spendDelta}`);
    assert.ok(Math.abs((reconcile.ratio ?? 0) - 1.3) < 1e-9, `ratio=${reconcile.ratio} 期望 1.3`);
    assert.equal(reconcile.verdict, 'warn');

    assert.match(guard.stderrText(), /对账/);
    assert.match(guard.stderrText(), /1\.3/);
    assert.match(guard.stderrText(), /WARN/);
  } finally {
    guard.child.kill();
    mock.server.closeAllConnections?.();
    mock.server.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('guard e2e：客户端断连（流中）→ aborted=true 入账，guard 不崩', async () => {
  const mock = await createMockServer({ mode: 'slow-stream' });
  const port = await findFreePort();
  const outDir = makeTempDir('guard-e2e-abort-');
  const guard = startGuard(['guard', '--base-url', mock.baseUrl, '--port', String(port), '--out', outDir], {
    ...process.env,
    MODEL_XRAY_KEY: GUARD_KEY,
  });
  try {
    const guardPort = await guard.waitReady();
    await postAbortAfterFirstChunk(guardPort, '/v1/chat/completions', { ...pingBody(), stream: true }, {
      authorization: `Bearer ${GUARD_KEY}`,
    });
    await delay(500);
    const code = await guard.shutdown();
    assert.equal(code, 0, `guard 应正常退出，stderr=${guard.stderrText()}`);

    const journal = readJournal(outDir);
    const entry = journal.requests[0];
    assert.ok(entry, '断连请求也应入账');
    assert.equal(entry.aborted, true);
    assert.equal(entry.status, 200);
    assert.equal(entry.stream, true);
    assert.deepEqual(entry.usage, null);
  } finally {
    guard.child.kill();
    mock.server.closeAllConnections?.();
    mock.server.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('guard e2e：评分卡——每 20 个已转发请求输出一次 + 退出终卡；本地 401/403 不入窗', async () => {
  const mock = await createMockServer({ mode: 'honest' });
  const port = await findFreePort();
  const outDir = makeTempDir('guard-e2e-score-');
  const guard = startGuard(['guard', '--base-url', mock.baseUrl, '--port', String(port), '--out', outDir], {
    ...process.env,
    MODEL_XRAY_KEY: GUARD_KEY,
  });
  try {
    const guardPort = await guard.waitReady();

    // 本地拒绝两笔（seq 1=错 key 401；seq 2=目标校验 403）——都不得进入评分窗口
    const wrong = await post(guardPort, '/v1/chat/completions', pingBody(), { authorization: 'Bearer wrong-key' });
    assert.equal(wrong.status, 401);
    const forbidden = await post(guardPort, '/..%2Fetc/passwd', pingBody(), { authorization: `Bearer ${GUARD_KEY}` });
    assert.equal(forbidden.status, 403, `目标校验应 403，实际 ${forbidden.status}：${forbidden.raw.slice(0, 120)}`);

    // 20 笔成功请求（seq 3..22）→ 第 20 笔完成触发周期评分卡
    for (let i = 0; i < 20; i += 1) {
      const res = await post(guardPort, '/v1/chat/completions', pingBody(), { authorization: `Bearer ${GUARD_KEY}` });
      assert.equal(res.status, 200, `第 ${i + 1} 笔应 200，实际 ${res.status}`);
    }
    await delay(300);
    const code = await guard.shutdown();
    assert.equal(code, 0, `stderr=${guard.stderrText()}`);

    // ① stdout 出现评分卡行（周期卡 + 终卡）
    assert.match(guard.stdoutText(), /\[guard\]\[评分\]/);

    // ② journal 出现 type='score' 完整条目；窗口只含 20 个已转发请求（401/403 不入窗）
    const journal = readJournal(outDir);
    assert.equal(journal.scores.length, 2, `应有周期卡 + 终卡两条 score 条目，实际 ${journal.scores.length}`);
    for (const score of journal.scores) {
      assert.equal(score.type, 'score');
      assert.equal(score.requests, 20, '窗口须恰为 20 个已转发请求');
      assert.equal(score.fromId, '3', '最旧样本应为 20 笔成功请求的第一笔（seq 3）');
      assert.equal(score.toId, '22', '最新样本应为最后一笔成功请求（seq 22）');
      assert.deepEqual(
        score.dims.map((d) => d.id).sort(),
        ['availability', 'billing', 'cost', 'identity', 'latency'],
        'dims 五个维度齐全',
      );
      assert.equal(typeof score.observed.usageMissing, 'number');
      assert.equal(typeof score.observed.aborted, 'number');
      assert.ok(score.observed.finishLengthRate === null || typeof score.observed.finishLengthRate === 'number');
      assert.ok(['ok', 'warn', 'fail', 'na'].includes(score.overall.level));
      const identity = score.dims.find((d) => d.id === 'identity');
      assert.equal(identity?.score, 100, 'honest mock 回显请求模型 → 身份应满分');
    }
    assert.equal(mock.state.served, 20, '401/403 不转发，上游只应收 20 笔');
  } finally {
    guard.child.kill();
    mock.server.closeAllConnections?.();
    mock.server.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('guard e2e：端口被占用 → exit 1 并提示换端口', async () => {
  const blocker = createTcpServer();
  const occupied = await new Promise<number>((resolve, reject) => {
    blocker.listen(0, '127.0.0.1', () => resolve((blocker.address() as AddressInfo).port));
    blocker.on('error', reject);
  });
  try {
    const guard = startGuard(['guard', '--base-url', 'http://127.0.0.1:9/v1', '--port', String(occupied)], {
      ...process.env,
      MODEL_XRAY_KEY: GUARD_KEY,
    });
    const code = await guard.exited;
    assert.equal(code, 1, `端口占用应 exit 1，实际 ${code}`);
    assert.match(guard.stderrText(), /被占用/);
    assert.match(guard.stderrText(), /--port/);
  } finally {
    blocker.close();
  }
});

test('guard e2e：参数校验（缺 key / 坏 --port / 价格不成对）与双模式 --help', async () => {
  // ① 缺 MODEL_XRAY_KEY → exit 2
  const envNoKey: NodeJS.ProcessEnv = { ...process.env };
  delete envNoKey['MODEL_XRAY_KEY'];
  {
    const guard = startGuard(['guard', '--base-url', 'http://127.0.0.1:9/v1'], envNoKey);
    assert.equal(await guard.exited, 2, '缺 MODEL_XRAY_KEY 应 exit 2');
    assert.match(guard.stderrText(), /MODEL_XRAY_KEY/);
  }
  // ② --port abc → exit 2（guard 子命令有自己的参数解析，不被顶层 strict 解析误伤）
  {
    const guard = startGuard(['guard', '--base-url', 'http://127.0.0.1:9/v1', '--port', 'abc'], { ...process.env, MODEL_XRAY_KEY: GUARD_KEY });
    assert.equal(await guard.exited, 2);
    assert.match(guard.stderrText(), /--port/);
  }
  // ③ 价格只给一半 → exit 2
  {
    const guard = startGuard(['guard', '--base-url', 'http://127.0.0.1:9/v1', '--price-input', '2'], { ...process.env, MODEL_XRAY_KEY: GUARD_KEY });
    assert.equal(await guard.exited, 2);
    assert.match(guard.stderrText(), /--price-output/);
  }
  // ③b --base-url 带 query → exit 2（防路径被塞进 query 段的坏 URL 配置）
  {
    const guard = startGuard(['guard', '--base-url', 'http://127.0.0.1:9/v1?k=1'], { ...process.env, MODEL_XRAY_KEY: GUARD_KEY });
    assert.equal(await guard.exited, 2);
    assert.match(guard.stderrText(), /query/);
  }
  // ④ guard --help → exit 0，列全参数
  {
    const guard = startGuard(['guard', '--help'], envNoKey);
    assert.equal(await guard.exited, 0);
    assert.match(guard.stdoutText(), /--price-input/);
    assert.match(guard.stdoutText(), /MODEL_XRAY_KEY/);
    assert.match(guard.stdoutText(), /--reconcile-minutes/);
  }
  // ⑤ 顶层 --help：双模式说明
  {
    const guard = startGuard(['--help'], envNoKey);
    assert.equal(await guard.exited, 0);
    assert.match(guard.stdoutText(), /model-xray test/);
    assert.match(guard.stdoutText(), /model-xray guard/);
  }
});

test('guard e2e：content-type 误标（非流式 JSON 标成 event-stream）→ JSON 整体兜底恢复 usage/model', async () => {
  // 真机实证场景：中转站把非流式 JSON 响应的 content-type 标成 text/event-stream，
  // guard 若只按头部派发走 SSE 扫描器，单行 JSON 无 data: 行 → usage/model 全丢。
  const mock = await createMockServer({ mode: 'json-as-sse' });
  const port = await findFreePort();
  const outDir = makeTempDir('guard-e2e-json-as-sse-');
  const guard = startGuard(['guard', '--base-url', mock.baseUrl, '--port', String(port), '--out', outDir], {
    ...process.env,
    MODEL_XRAY_KEY: GUARD_KEY,
  });
  try {
    const guardPort = await guard.waitReady();
    for (let i = 0; i < 3; i += 1) {
      const res = await post(guardPort, '/v1/chat/completions', pingBody(), { authorization: `Bearer ${GUARD_KEY}` });
      assert.equal(res.status, 200, `第 ${i + 1} 笔应 200，实际 ${res.status}`);
      // 响应头原样转发（误标不修正，字节透传零改动）
      assert.match(String(res.headers['content-type'] ?? ''), /text\/event-stream/, '误标头必须原样转发');
      // 客户端收到的 body 与 honest 完全一致：单行 JSON（含 usage、model 回显）
      const parsed = JSON.parse(res.raw) as { model: string; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } };
      assert.equal(parsed.model, 'gpt-4o');
      // guard 字节透传（误标不修正）：客户端收到的是 mock 原始嵌套 usage
      assert.deepEqual(parsed.usage, {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 1 },
      });
    }

    await delay(300);
    const code = await guard.shutdown();
    assert.equal(code, 0, `stderr=${guard.stderrText()}`);
    assert.equal(mock.state.served, 3);

    // journal：误标 JSON 的 usage/model/finish_reason 全部恢复，deepInspect 保持 true
    const journal = readJournal(outDir);
    assert.equal(journal.requests.length, 3, `应有 3 条请求行，实际 ${journal.requests.length}`);
    for (const entry of journal.requests) {
      assert.equal(entry.deepInspect, true, 'JSON 整体兜底成功 → deepInspect 不得降级为 false');
      // Usage 契约扩展：整体 JSON 路径（json-as-sse）usage details 闭环——cached=0、reasoning=min(1,completion)=1
      assert.equal(entry.usage?.cached_tokens, 0);
      assert.equal(entry.usage?.reasoning_tokens, 1);
      assert.deepEqual(entry.usage, { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cached_tokens: 0, reasoning_tokens: 1 }, '误标 JSON 的 usage 必须恢复');
      assert.equal(entry.usageRejected, null);
      assert.equal(entry.modelReq, 'gpt-4o');
      assert.equal(entry.modelResp, 'gpt-4o', 'modelResp 必须从误标 body 捕获');
      assert.equal(entry.finishReason, 'stop');
      assert.equal(entry.aborted, false);
    }
    assert.equal(journal.anomalies.length, 0, '无异常（模型一致、usage 合法）');

    // 评分卡终卡：计量维度必须出分且满分（修复前 usage 全丢 → 计量 N/A）
    assert.equal(journal.scores.length, 1, `3 笔请求只应有退出终卡，实际 ${journal.scores.length}`);
    const final = journal.scores[0];
    assert.ok(final, '终卡应存在');
    assert.equal(final.requests, 3);
    const billing = final.dims.find((d) => d.id === 'billing');
    assert.equal(billing?.score, 100, `计量维度应 100（非 N/A），实际 ${JSON.stringify(billing)}`);
    assert.equal(billing?.level, 'ok');
    const identity = final.dims.find((d) => d.id === 'identity');
    assert.equal(identity?.score, 100, '身份维度应 100（modelResp 已恢复）');
    assert.equal(final.observed.usageMissing, 0, '缺用量观测必须为 0');
  } finally {
    guard.child.kill();
    mock.server.closeAllConnections?.();
    mock.server.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('guard e2e：content-type 误标（SSE body 标成 json）→ data 行兜底恢复 usage', async () => {
  // 反向误标：真实 SSE 格式 body（data: 行 + usage 尾行 + [DONE]）+ content-type: application/json，
  // guard 的 JSON 整体解析必失败，须按行兜底扫描 data: 行恢复 usage。
  const mock = await createMockServer({ mode: 'sse-as-json' });
  const port = await findFreePort();
  const outDir = makeTempDir('guard-e2e-sse-as-json-');
  const guard = startGuard(['guard', '--base-url', mock.baseUrl, '--port', String(port), '--out', outDir], {
    ...process.env,
    MODEL_XRAY_KEY: GUARD_KEY,
  });
  try {
    const guardPort = await guard.waitReady();

    // ① 流式请求：SSE body + application/json 误标头
    const streamRes = await post(guardPort, '/v1/chat/completions', { ...pingBody(), stream: true }, {
      authorization: `Bearer ${GUARD_KEY}`,
    });
    assert.equal(streamRes.status, 200);
    assert.match(String(streamRes.headers['content-type'] ?? ''), /application\/json/, '误标头必须原样转发');
    assert.ok(streamRes.raw.includes('data: [DONE]'), 'body 应为真实 SSE 格式');
    const streamContent = [...streamRes.raw.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join('');
    assert.equal(streamContent, 'pong', `SSE 内容应透传，实际：${streamRes.raw.slice(0, 200)}`);

    // ② 非流式请求：mock 仍回 SSE 格式 body（误标与请求形态无关）
    const jsonRes = await post(guardPort, '/v1/chat/completions', pingBody(), { authorization: `Bearer ${GUARD_KEY}` });
    assert.equal(jsonRes.status, 200);
    assert.match(String(jsonRes.headers['content-type'] ?? ''), /application\/json/);
    assert.ok(jsonRes.raw.includes('data: [DONE]'));

    await delay(300);
    const code = await guard.shutdown();
    assert.equal(code, 0, `stderr=${guard.stderrText()}`);

    // journal：两笔都按行兜底恢复 usage/model/finish_reason
    const journal = readJournal(outDir);
    assert.equal(journal.requests.length, 2);
    const streamed = journal.requests.find((r) => r.stream === true);
    const unstreamed = journal.requests.find((r) => r.stream === false);
    assert.ok(streamed && unstreamed, '应含一笔流式 + 一笔非流式');
    for (const entry of [streamed, unstreamed]) {
      assert.ok(entry);
      assert.equal(entry.deepInspect, true, 'data 行兜底生效 → deepInspect 保持 true');
      assert.deepEqual(entry.usage, { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cached_tokens: 0, reasoning_tokens: 1 }, 'SSE body 的 usage 必须按行恢复');
      assert.equal(entry.usageRejected, null);
      assert.equal(entry.modelResp, 'gpt-4o');
      assert.equal(entry.finishReason, 'stop');
    }
    assert.equal(journal.anomalies.length, 0);

    // 终卡计量维度满分（usage 全部恢复）
    const final = journal.scores.at(-1);
    assert.ok(final, '终卡应存在');
    const billing = final?.dims.find((d) => d.id === 'billing');
    assert.equal(billing?.score, 100, `计量维度应 100（非 N/A），实际 ${JSON.stringify(billing)}`);
    assert.equal(final?.observed.usageMissing, 0);
  } finally {
    guard.child.kill();
    mock.server.closeAllConnections?.();
    mock.server.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('guard e2e：SSE 头 + 空 body → 诚实降级（deepInspect=false），缺用量不归因上游', async () => {
  // 目标场景：中转站返回 2xx + text/event-stream 头 + 空 body（流式与非流式都可能）。
  // guard 无 data: 行且无兜底材料 → deepInspect 降级 false；usage/model 全缺属「未能深检」，
  // 不得伪装成已检，也不得计入「已深检缺用量」观测（改动三语义）。
  const mock = await createMockServer({ mode: 'sse-empty' });
  const port = await findFreePort();
  const outDir = makeTempDir('guard-e2e-sse-empty-');
  const guard = startGuard(['guard', '--base-url', mock.baseUrl, '--port', String(port), '--out', outDir], {
    ...process.env,
    MODEL_XRAY_KEY: GUARD_KEY,
  });
  try {
    const guardPort = await guard.waitReady();

    // ① 流式请求：空 body + event-stream 头
    const streamRes = await post(guardPort, '/v1/chat/completions', { ...pingBody(), stream: true }, {
      authorization: `Bearer ${GUARD_KEY}`,
    });
    assert.equal(streamRes.status, 200);
    assert.equal(streamRes.raw, '', '空 body 必须字节级透传');
    assert.match(String(streamRes.headers['content-type'] ?? ''), /text\/event-stream/, '头必须原样转发');

    // ② 非流式请求：同样空 body（与请求 stream 标志无关）
    const jsonRes = await post(guardPort, '/v1/chat/completions', pingBody(), { authorization: `Bearer ${GUARD_KEY}` });
    assert.equal(jsonRes.status, 200);
    assert.equal(jsonRes.raw, '', '空 body 必须字节级透传');
    assert.match(String(jsonRes.headers['content-type'] ?? ''), /text\/event-stream/, '头必须原样转发');

    await delay(300);
    const code = await guard.shutdown();
    assert.equal(code, 0, `stderr=${guard.stderrText()}`);
    assert.equal(mock.state.served, 2);

    // journal：两笔均诚实降级（无 data: 行且无兜底材料）
    const journal = readJournal(outDir);
    assert.equal(journal.requests.length, 2, `应有 2 条请求行，实际 ${journal.requests.length}`);
    const streamed = journal.requests.find((r) => r.stream === true);
    const unstreamed = journal.requests.find((r) => r.stream === false);
    assert.ok(streamed && unstreamed, '应含一笔流式 + 一笔非流式');
    for (const entry of [streamed, unstreamed]) {
      assert.ok(entry);
      assert.equal(entry.deepInspect, false, '无 data: 行且无兜底材料 → 诚实降级，勿伪装成已检');
      assert.equal(entry.usage, null);
      assert.equal(entry.modelResp, null);
    }

    // 终卡：judged=0 → 计量 N/A；可用性满分；未深检的缺用量不计观测
    assert.equal(journal.scores.length, 1, `2 笔请求只应有退出终卡，实际 ${journal.scores.length}`);
    const final = journal.scores[0];
    assert.ok(final, '终卡应存在');
    assert.equal(final.requests, 2);
    const billing = final.dims.find((d) => d.id === 'billing');
    assert.equal(billing?.score, null, `judged=0 → 计量 N/A，实际 ${JSON.stringify(billing)}`);
    assert.equal(billing?.level, 'na');
    const availability = final.dims.find((d) => d.id === 'availability');
    assert.equal(availability?.score, 100, `可用性应 100，实际 ${JSON.stringify(availability)}`);
    assert.equal(final.observed.usageMissing, 0, 'deepInspect=false 的缺用量不得计入观测（改动三生效）');
  } finally {
    guard.child.kill();
    mock.server.closeAllConnections?.();
    mock.server.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('guard e2e：SSE 头 + 仅注释行 body → 兜底解析失败诚实降级，注释逐字节透传', async () => {
  // keep-alive 注释流：body 恰为 ": keep-alive\n\n"（仅注释行，无 data: 行）。
  // guard 头标 SSE → 走扫描器，全程无 data: 行 → 兜底①整体 JSON 解析失败 → 诚实降级。
  const mock = await createMockServer({ mode: 'sse-comments' });
  const port = await findFreePort();
  const outDir = makeTempDir('guard-e2e-sse-comments-');
  const guard = startGuard(['guard', '--base-url', mock.baseUrl, '--port', String(port), '--out', outDir], {
    ...process.env,
    MODEL_XRAY_KEY: GUARD_KEY,
  });
  try {
    const guardPort = await guard.waitReady();

    const res = await post(guardPort, '/v1/chat/completions', pingBody(), { authorization: `Bearer ${GUARD_KEY}` });
    assert.equal(res.status, 200);
    assert.equal(res.raw, ': keep-alive\n\n', '注释 body 必须逐字节透传');
    assert.match(String(res.headers['content-type'] ?? ''), /text\/event-stream/, '头必须原样转发');

    await delay(300);
    const code = await guard.shutdown();
    assert.equal(code, 0, `stderr=${guard.stderrText()}`);
    assert.equal(mock.state.served, 1);

    const journal = readJournal(outDir);
    assert.equal(journal.requests.length, 1, `应有 1 条请求行，实际 ${journal.requests.length}`);
    const entry = journal.requests[0];
    assert.ok(entry, '请求行应存在');
    assert.equal(entry.deepInspect, false, '注释流 → 兜底①解析失败 → 诚实降级');
    assert.equal(entry.usage, null);
    assert.equal(entry.modelResp, null);

    assert.equal(journal.scores.length, 1, `1 笔请求只应有退出终卡，实际 ${journal.scores.length}`);
    const final = journal.scores[0];
    assert.ok(final, '终卡应存在');
    assert.equal(final.observed.usageMissing, 0, 'deepInspect=false 的缺用量不得计入观测（改动三生效）');
  } finally {
    guard.child.kill();
    mock.server.closeAllConnections?.();
    mock.server.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});
