import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMockServer, type MockServer } from '../mock-server.js';

// 运行时位于 dist/test/unit/，向上回溯到仓库根（以 scripts/serve.mjs 为标记；
// 编译后距仓库根 3 层，不硬编码相对层数，同 webserver.test.ts 的 findRepoRoot）。
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'scripts', 'serve.mjs'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('未找到 scripts/serve.mjs：请在仓库根目录下构建并运行测试。');
}
const REPO_ROOT = findRepoRoot();
// serve.mjs 是纯 ESM .mjs：用「变量 specifier + pathToFileURL」动态导入，
// 绕开 TS 对 .mjs 字面量导入的类型解析（web/app.js 同款手法）。
const SERVE_URL = pathToFileURL(join(REPO_ROOT, 'scripts', 'serve.mjs')).href;

export interface ConsoleServer {
  port: number;
  token: string;
  close(): Promise<void>;
}
const serveModule = (await import(SERVE_URL)) as {
  createConsoleServer(options: { port: number; repoRoot: string }): Promise<ConsoleServer>;
};

interface HttpResponse {
  status: number | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}
interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
// 注意：必须用 async request + 事件回调；spawnSync/同步读取会阻塞父事件循环，与服务器死锁
function request(port: number, path: string, options: RequestOptions = {}): Promise<HttpResponse> {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: options.headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          resolvePromise({ status: res.statusCode, headers: res.headers, body });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('请求超时')));
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}
function postJson(port: number, path: string, body: unknown, token?: string): Promise<HttpResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined) headers['x-model-xray-token'] = token;
  return request(port, path, { method: 'POST', headers, body: JSON.stringify(body) });
}
// 当前测试实例：afterEach 统一关闭（port 0 随机端口，各测试互不冲突）
let current: ConsoleServer | null = null;
async function startServer(): Promise<ConsoleServer> {
  const instance = await serveModule.createConsoleServer({ port: 0, repoRoot: REPO_ROOT });
  current = instance;
  return instance;
}
afterEach(async () => {
  if (current !== null) {
    const closing = current;
    current = null;
    await closing.close();
  }
});
test('serve：GET /api/status 200 且 {keyConfigured, keySource} 形状正确', async () => {
  const server = await startServer();
  const res = await request(server.port, '/api/status');
  assert.equal(res.status, 200);
  const data = JSON.parse(res.body) as Record<string, unknown>;
  assert.equal(typeof data['keyConfigured'], 'boolean', `keyConfigured 应为布尔：${res.body}`);
  assert.ok(
    data['keySource'] === 'page' || data['keySource'] === 'env' || data['keySource'] === null,
    `keySource 应为 page|env|null：${res.body}`,
  );
  assert.equal(data['keyConfigured'], data['keySource'] !== null, 'keyConfigured 应与 keySource 非空一致');
  assert.deepEqual(Object.keys(data).sort(), ['keyConfigured', 'keySource']);
});
test('serve：POST /api/test 缺 token → 403', async () => {
  const server = await startServer();
  const res = await postJson(server.port, '/api/test', { baseUrl: 'http://127.0.0.1:9/v1', model: 'gpt-4o' });
  assert.equal(res.status, 403);
  const data = JSON.parse(res.body) as Record<string, unknown>;
  assert.match(String(data.error ?? ''), /token/i);
});
test('serve：POST /api/test 非法 base-url（带正确 token）→ 400 含中文与示例', async () => {
  const server = await startServer();
  const res = await postJson(server.port, '/api/test', { baseUrl: 'not-a-url', model: 'gpt-4o' }, server.token);
  assert.equal(res.status, 400);
  const data = JSON.parse(res.body) as Record<string, unknown>;
  assert.match(String(data.error ?? ''), /baseUrl/);
  assert.match(String(data.error ?? ''), /示例/);
  assert.match(String(data.error ?? ''), /https:\/\//);
});
test('serve：dry-run 测试任务真实 spawn CLI 跑完 → done / exitCode 0', { timeout: 20000 }, async () => {
  const server = await startServer();
  const res = await postJson(
    server.port,
    '/api/test',
    { dryRun: true, baseUrl: 'http://127.0.0.1:9/v1', model: 'gpt-4o' },
    server.token,
  );
  assert.equal(res.status, 200, `POST /api/test 应 200：${res.body}`);
  const { id } = JSON.parse(res.body) as { id: string };
  assert.equal(typeof id, 'string');
  // 轮询日志端点直到任务结束（async 轮询 200ms，不阻塞事件循环）
  const deadline = Date.now() + 15000;
  let sawStatus = '';
  let lastSeqSeen = -1;
  while (Date.now() < deadline) {
    const logRes = await request(server.port, `/api/jobs/${id}/log?after=0`);
    assert.equal(logRes.status, 200);
    const log = JSON.parse(logRes.body) as { lines: Array<{ text: string }>; status: string; next: number; startedAt: number };
    assert.ok(Array.isArray(log.lines), 'log.lines 应为数组');
    assert.equal(typeof log.startedAt, 'number', 'log.startedAt 应存在（前端已用时间依赖）');
    assert.ok(log.startedAt > 0);
    sawStatus = log.status;
    lastSeqSeen = log.next;
    if (log.status !== 'running') break;
    await delay(200);
  }
  assert.equal(sawStatus, 'done', `任务应在 15s 内完成，实际 status=${sawStatus}`);
  assert.ok(lastSeqSeen > 0, 'dry-run 应产生日志行');
  const detailRes = await request(server.port, `/api/jobs/${id}`);
  assert.equal(detailRes.status, 200);
  const detail = JSON.parse(detailRes.body) as { status: string; exitCode: number; reportPaths: unknown };
  assert.equal(detail.status, 'done');
  assert.equal(detail.exitCode, 0);
  assert.equal(detail.reportPaths, null, 'dry-run 不产出报告，reportPaths 应为 null');
});
test('serve：POST /api/test 半组阶梯价 → 400 成组提示（不发起任务）', async () => {
  const server = await startServer();
  const res = await postJson(
    server.port,
    '/api/test',
    {
      dryRun: true,
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'gpt-4o',
      priceInput: '2',
      priceOutput: '8',
      priceThreshold: '1000000',
      priceInput2: '6',
    },
    server.token,
  );
  assert.equal(res.status, 400, res.body);
  const data = JSON.parse(res.body) as Record<string, unknown>;
  assert.match(String(data.error ?? ''), /成组/);
  assert.match(String(data.error ?? ''), /示例/);
});
test('serve：POST /api/test 缓存读 + 完整二档阶梯价 → dry-run exitCode 0', { timeout: 20000 }, async () => {
  const server = await startServer();
  const res = await postJson(
    server.port,
    '/api/test',
    {
      dryRun: true,
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'gpt-4o',
      priceInput: '2',
      priceOutput: '8',
      priceCachedRead: '0',
      priceThreshold: '1000000',
      priceInput2: '6',
      priceOutput2: '22.5',
      priceCachedRead2: '0.75',
    },
    server.token,
  );
  assert.equal(res.status, 200, `POST /api/test 应 200：${res.body}`);
  const { id } = JSON.parse(res.body) as { id: string };
  const deadline = Date.now() + 15000;
  let status = '';
  while (Date.now() < deadline) {
    const logRes = await request(server.port, `/api/jobs/${id}/log?after=0`);
    assert.equal(logRes.status, 200);
    status = (JSON.parse(logRes.body) as { status: string }).status;
    if (status !== 'running') break;
    await delay(200);
  }
  assert.equal(status, 'done');
  const detail = JSON.parse((await request(server.port, `/api/jobs/${id}`)).body) as { exitCode: number };
  assert.equal(detail.exitCode, 0);
});
test('serve：任务运行中并发第二个 POST /api/test → 409（全局互斥）', { timeout: 20000 }, async () => {
  const server = await startServer();
  const first = await postJson(
    server.port,
    '/api/test',
    { dryRun: true, baseUrl: 'http://127.0.0.1:9/v1', model: 'gpt-4o' },
    server.token,
  );
  assert.equal(first.status, 200);
  // dry-run job 存活约 1s：拿到 id 后立刻发第二个，互斥窗口足够
  const second = await postJson(
    server.port,
    '/api/test',
    { dryRun: true, baseUrl: 'http://127.0.0.1:9/v1', model: 'gpt-4o' },
    server.token,
  );
  assert.equal(second.status, 409, `并发任务应 409，实际 ${String(second.status)}`);
  const data = JSON.parse(second.body) as Record<string, unknown>;
  assert.match(String(data.error ?? ''), /任务/);
  // 等第一个完成再收尾（互斥释放后 close 才干净）
  const { id } = JSON.parse(first.body) as { id: string };
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const detailRes = await request(server.port, `/api/jobs/${id}`);
    const detail = JSON.parse(detailRes.body) as { status: string };
    if (detail.status !== 'running') break;
    await delay(200);
  }
  const detailRes = await request(server.port, `/api/jobs/${id}`);
  const detail = JSON.parse(detailRes.body) as { status: string; exitCode: number };
  assert.equal(detail.status, 'done');
  assert.equal(detail.exitCode, 0);
});
test('serve：报告文件端点拒绝穿越与非法扩展名 → 404', async () => {
  const server = await startServer();
  const traversal = await request(server.port, '/api/reports/file?name=../package.json');
  assert.equal(traversal.status, 404, `穿越路径应 404，实际 ${String(traversal.status)}`);
  const badExt = await request(server.port, '/api/reports/file?name=report-x.exe');
  assert.equal(badExt.status, 404, `非法扩展名应 404，实际 ${String(badExt.status)}`);
});
test('serve：POST /api/test out 越出仓库 → 400（页面渲染读不回报告）', async () => {
  const server = await startServer();
  const res = await postJson(
    server.port,
    '/api/test',
    { dryRun: true, baseUrl: 'http://127.0.0.1:9/v1', model: 'gpt-4o', out: '../outside-reports' },
    server.token,
  );
  assert.equal(res.status, 400, `越界 out 应 400，实际 ${String(res.status)}：${res.body}`);
  const data = JSON.parse(res.body) as Record<string, unknown>;
  assert.match(String(data.error ?? ''), /out/);
  assert.match(String(data.error ?? ''), /仓库/);
});
test('serve：guard 控制台托管已移除 → /api/guard/* 一律 404（未知路径不得谎称「仅支持 POST」）', async () => {
  const server = await startServer();
  const res = await postJson(server.port, '/api/guard/start', { baseUrl: 'http://127.0.0.1:9/v1' }, server.token);
  assert.equal(res.status, 404, `已移除的端点应 404，实际 ${String(res.status)}：${res.body}`);
  const data = JSON.parse(res.body) as Record<string, unknown>;
  assert.match(String(data.error ?? ''), /未知的 API 端点/);
  const legacyGet = await request(server.port, '/api/guard/status');
  assert.equal(legacyGet.status, 404, `未知路径的 GET 应 404，实际 ${String(legacyGet.status)}：${legacyGet.body}`);
  assert.match(String((JSON.parse(legacyGet.body) as Record<string, unknown>).error ?? ''), /未知的 API 端点/);
});
test('serve：非 POST 方法语义——已登记 POST 端点 GET → 405+Allow，未知路径 GET/POST → 404（两者不得混淆）', async () => {
  const server = await startServer();
  const known = await request(server.port, '/api/key');
  assert.equal(known.status, 405, `已登记端点 GET 应 405，实际 ${String(known.status)}：${known.body}`);
  assert.equal(String(known.headers.allow ?? ''), 'POST', `405 必须带 Allow: POST（RFC 9110），实际 ${String(known.headers.allow)}`);
  const unknown = await request(server.port, '/api/does-not-exist');
  assert.equal(unknown.status, 404, `未知路径 GET 应 404，实际 ${String(unknown.status)}：${unknown.body}`);
  const unknownPost = await postJson(server.port, '/api/does-not-exist', {}, server.token);
  assert.equal(unknownPost.status, 404, `未知路径 POST 应 404，实际 ${String(unknownPost.status)}：${unknownPost.body}`);
  const staticPost = await postJson(server.port, '/index.html', {}, server.token);
  assert.equal(staticPost.status, 405, `静态资源 POST 应 405，实际 ${String(staticPost.status)}`);
  assert.equal(String(staticPost.headers.allow ?? ''), 'GET, HEAD', `静态 405 必须带 Allow: GET, HEAD，实际 ${String(staticPost.headers.allow)}`);
  const gatewayPut = await request(server.port, '/api/gateway/status', {
    method: 'PUT',
    headers: { 'x-model-xray-token': server.token },
  });
  assert.equal(gatewayPut.status, 405, `网关端点 PUT 应 405，实际 ${String(gatewayPut.status)}：${gatewayPut.body}`);
  assert.equal(String(gatewayPut.headers.allow ?? ''), 'GET, POST', `网关端点 405 必须带 Allow: GET, POST，实际 ${String(gatewayPut.headers.allow)}`);
});
test('serve：GET / 返回 200、注入 token 字面值且无占位符残留', async () => {
  const server = await startServer();
  const res = await request(server.port, '/');
  assert.equal(res.status, 200);
  assert.ok(res.body.includes(server.token), '页面应包含注入的 token');
  assert.ok(!res.body.includes('__MX_TOKEN__'), '占位符不应残留');
  assert.match(String(res.headers['x-content-type-options'] ?? ''), /nosniff/i);
  const csp = String(res.headers['content-security-policy'] ?? '');
  assert.match(csp, /script-src[^\n]*'unsafe-inline'/, `控制台页面 CSP 需含 script-src 'unsafe-inline'：${csp}`);
});
test('serve：页面录入 key → keySource=page、响应不回显；清除后回落 env|null', async () => {
  const server = await startServer();
  const store = await postJson(server.port, '/api/key', { key: 'sk-page-test-key-123' }, server.token);
  assert.equal(store.status, 200, `POST /api/key 应 200：${store.body}`);
  const storeData = JSON.parse(store.body) as Record<string, unknown>;
  assert.equal(storeData.stored, true);
  assert.equal(storeData.keyConfigured, true);
  assert.equal(storeData.keySource, 'page');
  assert.ok(!store.body.includes('sk-page-test-key-123'), '录入响应不得回显 key 值');
  const status = JSON.parse((await request(server.port, '/api/status')).body) as Record<string, unknown>;
  assert.equal(status.keyConfigured, true);
  assert.equal(status.keySource, 'page');
  const cleared = await postJson(server.port, '/api/key/clear', {}, server.token);
  assert.equal(cleared.status, 200);
  const after = JSON.parse((await request(server.port, '/api/status')).body) as Record<string, unknown>;
  // 测试进程可能自带 env key：清除后回落 env 或无 key，两者都合法
  assert.ok(
    after.keySource === 'env' || after.keySource === null,
    `清除后 keySource 应为 env|null，实际 ${String(after.keySource)}`,
  );
  assert.equal(after.keyConfigured, after.keySource === 'env');
  const bad = await postJson(server.port, '/api/key', { key: 123 }, server.token);
  assert.equal(bad.status, 400, `key 非字符串应 400：${bad.body}`);
  const empty = await postJson(server.port, '/api/key', { key: '   ' }, server.token);
  assert.equal(empty.status, 400, `空白 key 应 400：${empty.body}`);
});
test('serve：/api/test 携带 key 字段（dry-run）→ 注入子进程且日志不回显 key 值', { timeout: 20000 }, async () => {
  const server = await startServer();
  const secret = 'sk-delta-secret-9876';
  const res = await postJson(
    server.port,
    '/api/test',
    { dryRun: true, baseUrl: 'http://127.0.0.1:9/v1', model: 'gpt-4o', key: secret },
    server.token,
  );
  assert.equal(res.status, 200, `POST /api/test 应 200：${res.body}`);
  const { id } = JSON.parse(res.body) as { id: string };
  const deadline = Date.now() + 15000;
  let status = '';
  while (Date.now() < deadline) {
    const logRes = await request(server.port, `/api/jobs/${id}/log?after=0`);
    const log = JSON.parse(logRes.body) as { lines: Array<{ text: string }>; status: string };
    status = log.status;
    for (const line of log.lines) {
      assert.ok(!line.text.includes(secret), '日志行不得回显 key 值');
    }
    if (status !== 'running') break;
    await delay(200);
  }
  assert.equal(status, 'done', `任务应在 15s 内完成，实际 ${String(status)}`);
  // 会话 key 已持久：不带 key 字段再发一个 dry-run 也应成功
  const second = await postJson(
    server.port,
    '/api/test',
    { dryRun: true, baseUrl: 'http://127.0.0.1:9/v1', model: 'gpt-4o' },
    server.token,
  );
  assert.equal(second.status, 200, `会话 key 应复用：${second.body}`);
});
test('serve：非 dry-run 真实审计（mock 上游）→ reportPaths 为绝对路径且可经 /api/reports/file 读取', { timeout: 180000 }, async () => {
  const server = await startServer();
  const mock: MockServer = await createMockServer({ mode: 'honest' });
  const outDir = join(REPO_ROOT, 'reports', 'tmp-serve-e2e');
  try {
    // 页面录入 key（mock 不校验具体值，但 CLI 非 dry-run 要求 key 存在）
    const keyRes = await postJson(server.port, '/api/key', { key: 'test-key' }, server.token);
    assert.equal(keyRes.status, 200, `POST /api/key 应 200：${keyRes.body}`);
    const res = await postJson(
      server.port,
      '/api/test',
      { baseUrl: mock.baseUrl, model: 'gpt-4o', seed: '1234', out: 'reports/tmp-serve-e2e' },
      server.token,
    );
    assert.equal(res.status, 200, `POST /api/test 应 200：${res.body}`);
    const { id } = JSON.parse(res.body) as { id: string };
    const deadline = Date.now() + 150000;
    let status = '';
    let lastError = '';
    while (Date.now() < deadline) {
      const logRes = await request(server.port, `/api/jobs/${id}/log?after=0`);
      const log = JSON.parse(logRes.body) as { lines: Array<{ text: string }>; status: string };
      status = log.status;
      lastError = log.lines.length > 0 ? log.lines[log.lines.length - 1]!.text : '';
      if (status !== 'running') break;
      await delay(300);
    }
    assert.equal(status, 'done', `审计应在 150s 内完成，实际 status=${status}，最后日志：${lastError}`);
    const detailRes = await request(server.port, `/api/jobs/${id}`);
    const detail = JSON.parse(detailRes.body) as {
      status: string;
      exitCode: number;
      reportPaths: { markdownPath: string; htmlPath: string; jsonPath: string; baselinePath: string | null } | null;
    };
    assert.equal(detail.exitCode, 0, `诚实 mock 审计应 exit 0`);
    assert.ok(detail.reportPaths !== null, `非 dry-run 应产出 reportPaths（实际 null；日志尾部：${lastError}）`);
    const paths = detail.reportPaths!;
    // CLI 打印的是绝对路径（writeReports 用 resolve(outDir)+join）；normalize 后统一断言
    const norm = (p: string) => p.replaceAll('\\', '/');
    assert.match(norm(paths.jsonPath), /tmp-serve-e2e\/report-[^/]+\.json$/, `jsonPath 应指向 tmp-serve-e2e 下的 report-*.json：${paths.jsonPath}`);
    // 绝对路径必须能被报告端点读回（query 需 URL 编码：Windows 绝对路径含 ':' 与 '\'）
    const fileRes = await request(server.port, `/api/reports/file?name=${encodeURIComponent(paths.jsonPath)}`);
    assert.equal(fileRes.status, 200, `绝对路径报告应 200：${fileRes.body}`);
    const report = JSON.parse(fileRes.body) as { outcomes?: unknown[] };
    assert.ok(Array.isArray(report.outcomes) && report.outcomes.length > 0, '读回的报告应有非空 outcomes');
    const mdRes = await request(server.port, `/api/reports/file?name=${encodeURIComponent(paths.markdownPath)}`);
    assert.equal(mdRes.status, 200);
    // 回归防线：绝对路径不得成为读取仓库任意文件的后门
    const pkg = await request(server.port, `/api/reports/file?name=${encodeURIComponent(join(REPO_ROOT, 'package.json'))}`);
    assert.equal(pkg.status, 404, `仓库 package.json 应 404，实际 ${String(pkg.status)}`);
    const plan = await request(server.port, `/api/reports/file?name=${encodeURIComponent(join(REPO_ROOT, 'plan.md'))}`);
    assert.equal(plan.status, 404, `仓库 plan.md 应 404，实际 ${String(plan.status)}`);
  } finally {
    mock.server.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});
// —— 网关管理面：渠道挂在控制台持久 store 上（网关启动前即可配置/修改/删除，跨启停保留） ——

test('serve：网关未启动时渠道 CRUD 可用（创建/更新/删除；protocol 校验；key 不回显）', async () => {
  const server = await startServer();
  const create = await postJson(
    server.port,
    '/api/gateway/channels',
    {
      label: '预配置渠道',
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'sk-test-aaaaaaaa1111',
      models: ['m1', 'm2'],
      modelMap: { m1: 'gpt-4o' },
      protocol: 'openai',
    },
    server.token,
  );
  assert.equal(create.status, 200, `网关未启动也应能创建渠道：${create.body}`);
  assert.ok(!create.body.includes('sk-test-aaaaaaaa1111'), '渠道视图不得回显 key');
  const created = JSON.parse(create.body) as { channel: { id: string; protocol: string; models: string[] } };
  assert.equal(created.channel.protocol, 'openai');
  assert.deepEqual(created.channel.models, ['m1', 'm2']);
  const defaulted = await postJson(
    server.port,
    '/api/gateway/channels',
    { label: '缺省协议渠道', baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-test-bbbbbbbb2222', models: ['u1'], modelMap: {} },
    server.token,
  );
  assert.equal(defaulted.status, 200, `缺省 protocol 应可创建：${defaulted.body}`);
  const defaultedView = JSON.parse(defaulted.body) as { channel: { id: string; protocol: string; modelPrices: Record<string, unknown> } };
  assert.equal(defaultedView.channel.protocol, 'unified', '缺省协议为 unified（统一中转）');
  assert.deepEqual(defaultedView.channel.modelPrices, {}, '未录价 = 空对象');
  const priced = await postJson(
    server.port,
    `/api/gateway/channels/${encodeURIComponent(created.channel.id)}`,
    { modelPrices: { m1: { input: 2.5, output: 10, cachedRead: 0.5 }, m2: { input: 1, output: 2, threshold: 1000, input2: 3, output2: 4 } } },
    server.token,
  );
  assert.equal(priced.status, 200, `录价应 200：${priced.body}`);
  assert.deepEqual((JSON.parse(priced.body) as { channel: { modelPrices: unknown } }).channel.modelPrices, {
    m1: { input: 2.5, output: 10, cachedRead: 0.5 },
    m2: { input: 1, output: 2, threshold: 1000, input2: 3, output2: 4 },
  });
  const clearedPrice = await postJson(
    server.port,
    `/api/gateway/channels/${encodeURIComponent(created.channel.id)}`,
    { modelPrices: {} },
    server.token,
  );
  assert.equal(clearedPrice.status, 200);
  assert.deepEqual((JSON.parse(clearedPrice.body) as { channel: { modelPrices: unknown } }).channel.modelPrices, {}, '显式 {} 清空');
  const badPrice = await postJson(
    server.port,
    '/api/gateway/channels',
    { label: 'X', baseUrl: 'https://x.example.com/v1', apiKey: 'sk-xxx111222333444', models: ['m'], modelPrices: { m: { input: -1, output: 1 } } },
    server.token,
  );
  assert.equal(badPrice.status, 400);
  const badPriceError = String((JSON.parse(badPrice.body) as { error: string }).error);
  assert.match(badPriceError, /modelPrices/);
  assert.match(badPriceError, /收到值/);
  assert.match(badPriceError, /示例/);
  const list = await request(server.port, '/api/gateway/channels', { headers: { 'x-model-xray-token': server.token } });
  assert.equal(list.status, 200);
  assert.ok(list.body.includes('预配置渠道'), `列表应含新渠道：${list.body}`);
  const update = await postJson(
    server.port,
    `/api/gateway/channels/${encodeURIComponent(created.channel.id)}`,
    { protocol: 'anthropic' },
    server.token,
  );
  assert.equal(update.status, 200, `更新渠道应 200：${update.body}`);
  const updated = JSON.parse(update.body) as { channel: { protocol: string; models: string[] } };
  assert.equal(updated.channel.protocol, 'anthropic');
  assert.deepEqual(updated.channel.models, ['m1', 'm2'], '未提交的字段应保留');
  const badProtocol = await postJson(
    server.port,
    '/api/gateway/channels',
    { label: 'X', baseUrl: 'https://x.example.com/v1', apiKey: 'sk-xxx111222333444', models: ['m'], protocol: 'gemini' },
    server.token,
  );
  assert.equal(badProtocol.status, 400);
  const badProtocolError = String((JSON.parse(badProtocol.body) as { error: string }).error);
  assert.match(badProtocolError, /protocol/);
  assert.match(badProtocolError, /统一/, '非法协议文案宣传 unified 统一中转');
  const remove = await postJson(
    server.port,
    `/api/gateway/channels/${encodeURIComponent(created.channel.id)}/delete`,
    {},
    server.token,
  );
  assert.equal(remove.status, 200, `删除渠道应 200：${remove.body}`);
});

test('serve：probe-models 服务端代取上游 /models（Bearer 头、SSRF 私网口径、channelId 复用已存 key）', async () => {
  const server = await startServer();
  let authSeen = '';
  let apiKeySeen = '';
  let versionSeen = '';
  const upstream = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      authSeen = String(req.headers.authorization ?? '');
      apiKeySeen = String(req.headers['x-api-key'] ?? '');
      versionSeen = String(req.headers['anthropic-version'] ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-4o' }, { id: 'deepseek-chat' }] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"not found"}}');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
  const address = upstream.address();
  const upstreamPort = address !== null && typeof address === 'object' ? address.port : 0;
  const key = 'sk-probe-test-key-111122223333';
  try {
    const denied = await postJson(
      server.port,
      '/api/gateway/probe-models',
      { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: key, protocol: 'openai' },
      server.token,
    );
    assert.equal(denied.status, 400, `未勾选本机上游应被 SSRF 口径拒绝：${denied.body}`);
    const direct = await postJson(
      server.port,
      '/api/gateway/probe-models',
      { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: key, protocol: 'openai', allowPrivateUpstream: true },
      server.token,
    );
    assert.equal(direct.status, 200, `探测应 200：${direct.body}`);
    assert.deepEqual((JSON.parse(direct.body) as { models: string[] }).models, ['gpt-4o', 'deepseek-chat']);
    assert.ok(!direct.body.includes(key), '探测响应不得回显 key');
    assert.equal(authSeen, `Bearer ${key}`, 'OpenAI 渠道探测须带 Bearer 上游 key');
    const anthropicProbe = await postJson(
      server.port,
      '/api/gateway/probe-models',
      { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: key, protocol: 'anthropic', allowPrivateUpstream: true },
      server.token,
    );
    assert.equal(anthropicProbe.status, 200, `Anthropic 协议探测应 200：${anthropicProbe.body}`);
    assert.equal(apiKeySeen, key, 'Anthropic 渠道探测须带 x-api-key 上游 key（而非 Bearer）');
    assert.equal(versionSeen, '2023-06-01', 'Anthropic 渠道探测须带 anthropic-version 头');
    const unifiedProbe = await postJson(
      server.port,
      '/api/gateway/probe-models',
      { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: key, protocol: 'unified', allowPrivateUpstream: true },
      server.token,
    );
    assert.equal(unifiedProbe.status, 200, `unified 探测应 200：${unifiedProbe.body}`);
    assert.equal(authSeen, `Bearer ${key}`, 'unified 探测须同时携带 Bearer');
    assert.equal(apiKeySeen, key, 'unified 探测须同时携带 x-api-key');
    assert.equal(versionSeen, '2023-06-01', 'unified 探测须同时携带 anthropic-version');
    const badProbeProtocol = await postJson(
      server.port,
      '/api/gateway/probe-models',
      { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: key, protocol: 'gemini', allowPrivateUpstream: true },
      server.token,
    );
    assert.equal(badProbeProtocol.status, 400);
    const badProbeError = String((JSON.parse(badProbeProtocol.body) as { error: string }).error);
    assert.match(badProbeError, /收到值/);
    assert.match(badProbeError, /统一/);
    const create = await postJson(
      server.port,
      '/api/gateway/channels',
      { label: '本机探测渠道', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: key, models: ['gpt-4o'], allowPrivateUpstream: true },
      server.token,
    );
    assert.equal(create.status, 200, `创建渠道应 200：${create.body}`);
    const channelId = (JSON.parse(create.body) as { channel: { id: string } }).channel.id;
    const reuse = await postJson(server.port, '/api/gateway/probe-models', { channelId }, server.token);
    assert.equal(reuse.status, 200, `channelId 复用已存 key 应 200：${reuse.body}`);
    assert.equal(authSeen, `Bearer ${key}`, '缺省协议（reuse 未传 protocol）按 unified 携带三头');
    assert.equal(apiKeySeen, key);
    const createAnthropic = await postJson(
      server.port,
      '/api/gateway/channels',
      { label: '本机 anthropic 渠道', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: key, models: ['claude-3-5-sonnet'], protocol: 'anthropic', allowPrivateUpstream: true },
      server.token,
    );
    assert.equal(createAnthropic.status, 200, `创建 anthropic 渠道应 200：${createAnthropic.body}`);
    const anthropicChannelId = (JSON.parse(createAnthropic.body) as { channel: { id: string } }).channel.id;
    authSeen = '';
    apiKeySeen = '';
    versionSeen = '';
    const reuseAnthropic = await postJson(server.port, '/api/gateway/probe-models', { channelId: anthropicChannelId }, server.token);
    assert.equal(reuseAnthropic.status, 200, `anthropic 渠道复用应 200：${reuseAnthropic.body}`);
    assert.equal(authSeen, '', '缺省 protocol 必须继承已存渠道的 anthropic 协议（不得回落 unified 携带 Bearer）');
    assert.equal(apiKeySeen, key, '继承 anthropic 协议后须携带 x-api-key');
    assert.equal(versionSeen, '2023-06-01', '继承 anthropic 协议后须携带 anthropic-version');
    const missing = await postJson(server.port, '/api/gateway/probe-models', { channelId: 'no-such-channel' }, server.token);
    assert.equal(missing.status, 404);
  } finally {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
