// test/unit/gateway.test.ts —— 网关切片的安全关键用例：
//   ① SSRF：私网/保留/回环/IPv6/混合解析结果一律拒绝；连接钉定杜绝二次解析；
//   ② 数据面：独立虚拟 key（常量时间比较）、仅两条路由、model 别名改写、渠道删除/停用语义、
//      上游 3xx 不跟随且不外发 Location、413 上限、超时 504；
//   ③ 渠道：纯内存 CRUD、别名唯一、apiKey 绝不回显（view.hasKey 恒 true、无 apiKey 字段）；
//   ④ 管理面（经 serve.mjs）：全端点 token 校验、start/stop/409、渠道 CRUD/删除语义。
// 测试手法：mock 上游真实起在 127.0.0.1 随机端口；baseUrl 用域名（IP 字面量 host 会被
// net.connect 跳过 DNS 直接连真实地址，无法注入）+ lookup/mapSocket 测试注入把
// 「钉定公网 IP」改写到本地 mock——生产路径禁止注入。
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createAliasGateway, type AliasGateway, type GatewayLedger } from '../../src/gateway/server.js';
import { ChannelError, ChannelStore, type ChannelView } from '../../src/gateway/channels.js';
import { isPublicIpv4, validateUpstreamBaseUrl, resolvePinnedUpstream, pinnedLookup } from '../../src/gateway/ssrf.js';
import { Ledger } from '../../src/ledger/ledger.js';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

// —— 基础 HTTP 请求（异步事件回调；同步读取与服务器共存会死锁） ——
interface HttpResponse {
  status: number | undefined;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}
interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}
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
        res.on('end', () => resolvePromise({ status: res.statusCode, body, headers: res.headers }));
        // 超时 destroy 后上游仍写回时响应流可能发 'error'（ECONNRESET）：兜底 reject 防未捕获异常；
        // Promise 已 settled 时 reject 为空操作，不会覆盖已有结果
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('请求超时')));
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

// —— mock 上游（真实 http server，127.0.0.1 随机端口） ——
const MOCK_ECHO_AUTH = 'sk-upstream-real-key';
/** 93.184.216.34 属公网段（example.com 解析段），可充当「公网上游」字面量与钉定 IP。 */
const PUBLIC_IP = '93.184.216.34';
interface MockState {
  lastPath: string | null;
  lastAuth: string | null;
  lastModel: unknown;
  lastContentType: string | null;
}
/** responder 返回 null = 收下请求但永不响应（用于上游挂起 → 504 测试）；truncate=true = 发出 2xx 响应头与部分 body 后断连（模拟传输截断）；sse = 以 text/event-stream 整段回发（模拟流式）。 */
type MockResponder = (parsed: Record<string, unknown>) =>
  | { status: number; payload?: unknown; truncate?: boolean; sse?: string; contentType?: string }
  | null;
class MockUpstream {
  private behavior: MockResponder = (parsed) => ({ status: 200, payload: { echo: true, model: parsed['model'] } });
  private server!: ReturnType<typeof createServer>;
  readonly state: MockState = { lastPath: null, lastAuth: null, lastModel: null, lastContentType: null };
  private constructor(public port: number) {}
  static async start(): Promise<MockUpstream> {
    const holder = new MockUpstream(0);
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          parsed = {};
        }
        holder.state.lastPath = req.url ?? null;
        holder.state.lastAuth = typeof req.headers['authorization'] === 'string' ? req.headers['authorization'] : null;
        holder.state.lastContentType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : null;
        holder.state.lastModel = parsed['model'] ?? null;
        const out = holder.behavior(parsed);
        if (out === null) return; // 收下请求后挂起不响应
        if (out.truncate === true) {
          // 声明大 content-length 后只发部分 body 即断连：模拟上游 2xx 传输截断
          res.writeHead(out.status, { 'content-type': 'application/json; charset=utf-8', 'content-length': '4096' });
          res.write('{"truncated":');
          setTimeout(() => res.destroy(), 30);
          return;
        }
        if (out.sse !== undefined) {
          // 流式响应：text/event-stream 整段回发（tee 观测按帧解析；无 content-length 走 chunked）
          res.writeHead(out.status, { 'content-type': out.contentType ?? 'text/event-stream; charset=utf-8' });
          res.end(out.sse);
          return;
        }
        const body = Buffer.from(JSON.stringify(out.payload ?? {}), 'utf8');
        res.writeHead(out.status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) });
        res.end(body);
      });
    });
    holder.server = server;
    await new Promise<void>((resolveListen) => {
      server.listen(0, '127.0.0.1', () => {
        holder.port = (server.address() as { port: number }).port;
        resolveListen();
      });
    });
    return holder;
  }
  setResponder(responder: MockResponder): void {
    this.behavior = responder;
  }
  reset(): void {
    this.state.lastPath = null;
    this.state.lastAuth = null;
    this.state.lastModel = null;
    this.state.lastContentType = null;
  }
  async close(): Promise<void> {
    if (this.server === undefined) return;
    await new Promise<void>((resolveClose) => {
      this.server.closeAllConnections?.();
      this.server.close(() => resolveClose());
    });
  }
}

// —— 网关堆栈：mock 上游 + createAliasGateway（lookup 返回公网 IP，mapSocket 改写到 mock） ——
type LookupResults = Array<{ address: string; family: number }>;
interface GatewayStack {
  gateway: AliasGateway;
  mock: MockUpstream;
  setDns(results: LookupResults): void;
  cleanup(): Promise<void>;
}
async function startGatewayStack(
  options: {
    upstreamTimeoutMs?: number;
    dns?: LookupResults;
    ledger?: GatewayLedger;
    alertSilenceMs?: number;
    loopLagThresholdMs?: number;
    onLog?: (line: string) => void;
  } = {},
): Promise<GatewayStack> {
  const mock = await MockUpstream.start();
  const dnsResults: LookupResults = options.dns ?? [{ address: PUBLIC_IP, family: 4 }];
  const gateway = await createAliasGateway({
    port: 0,
    upstreamTimeoutMs: options.upstreamTimeoutMs,
    ledger: options.ledger,
    alertSilenceMs: options.alertSilenceMs,
    loopLagThresholdMs: options.loopLagThresholdMs,
    onLog: options.onLog,
    lookup: async () => dnsResults,
    mapSocket: (target) => ({ host: '127.0.0.1', port: mock.port }),
  });
  return {
    gateway,
    mock,
    setDns(results) {
      dnsResults.splice(0, dnsResults.length, ...results);
    },
    async cleanup() {
      await gateway.close();
      await mock.close();
    },
  };
}
/** 默认渠道：baseUrl 用域名 + mock 实端口；解析被 lookup 钉定公网，连接经 mapSocket 改写到 mock。 */
function channelInput(overrides: Record<string, unknown> = {}, mockPort = 65530): Record<string, unknown> {
  return {
    label: '主渠道',
    baseUrl: `http://upstream.test:${mockPort}/v1`,
    apiKey: MOCK_ECHO_AUTH,
    models: ['alias-a', 'alias-b'],
    modelMap: { 'alias-a': 'upstream-real-model' },
    ...overrides,
  };
}
function authHeaders(gateway: AliasGateway): Record<string, string> {
  return { authorization: `Bearer ${gateway.virtualKey}`, 'content-type': 'application/json' };
}

/** 轮询等待异步落定（客户端收到响应的时刻与网关 settle 有微竞态；gateway 计数与 ledger 写在同一同步任务内完成）。 */
async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

/** 组装 SSE 流：data: {frame}\n\n ... 以 data: [DONE] 收尾。 */
function sseBody(frames: unknown[]): string {
  return frames.map((frame) => `data: ${JSON.stringify(frame)}`).join('\n\n') + '\n\ndata: [DONE]\n\n';
}

/** 账本测试夹具：临时目录文件库 + 第二只读连接（绕过聚合 API 直查原始行，支持金丝雀全库 dump）。 */
interface LedgerFixture {
  ledger: Ledger;
  dbPath: string;
  requestRows(): Array<Record<string, unknown>>;
  settlementRows(): Array<Record<string, unknown>>;
  dump(): string;
  cleanup(): void;
}
function makeLedgerFixture(): LedgerFixture {
  const dir = mkdtempSync(join(tmpdir(), 'mx-ledger-'));
  const dbPath = join(dir, 'ledger.db');
  const ledger = new Ledger(dbPath);
  const reader = new DatabaseSync(dbPath, { readOnly: true });
  const query = (table: string) => () => reader.prepare(`SELECT * FROM ${table} ORDER BY ts_ms`).all() as Array<Record<string, unknown>>;
  return {
    ledger,
    dbPath,
    requestRows: query('requests'),
    settlementRows: query('settlements'),
    dump() {
      return JSON.stringify({ requests: this.requestRows(), settlements: this.settlementRows() });
    },
    cleanup() {
      // 先关读连接与账本（Windows 下句柄不释放则 rmSync 会 EBUSY）
      try {
        reader.close();
      } catch {
        /* 已关闭 */
      }
      ledger.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

const CLEANUPS: Array<() => Promise<void>> = [];
afterEach(async () => {
  const items = CLEANUPS.splice(0);
  for (const fn of items) await fn();
});

// ===== ① SSRF / ssrf.ts =====

test('ssrf：isPublicIpv4 拒收私网/保留/回环/链路本地/文档段，放行公网', () => {
  for (const ip of ['10.0.0.1', '172.16.0.9', '172.31.255.1', '192.168.1.1', '127.0.0.1', '0.0.0.0', '169.254.3.4', '100.64.0.1', '198.18.0.7', '224.0.0.5', '240.0.0.1', '192.0.2.9', '203.0.113.9', '198.51.100.2']) {
    assert.equal(isPublicIpv4(ip), false, `${ip} 应判为非公网`);
  }
  for (const ip of ['8.8.8.8', '93.184.216.34', '1.2.3.4']) {
    assert.equal(isPublicIpv4(ip), true, `${ip} 应判为公网`);
  }
  assert.equal(isPublicIpv4('999.1.1.1'), false);
  assert.equal(isPublicIpv4('1.2.3.4.5'), false);
  assert.equal(isPublicIpv4('abc'), false);
});

test('ssrf：validateUpstreamBaseUrl 拒绝非 http(s)/凭证/query/fragment/IPv6/私网字面量', () => {
  const reject = (raw: unknown, pattern: RegExp) => {
    const check = validateUpstreamBaseUrl(raw);
    assert.equal(check.ok, false, `${String(raw)} 应拒绝`);
    assert.match(check.message, pattern, `拒绝理由应匹配 ${pattern}：${check.message}`);
  };
  reject(undefined, /非字符串|空/);
  reject('', /非字符串|空/);
  reject('not-a-url', /示例/);
  reject('ftp://relay.example.com/v1', /协议/);
  reject('http://user:pass@relay.example.com/v1', /账号\/密码/);
  reject('https://relay.example.com/v1?key=1', /query/);
  reject('https://relay.example.com/v1#frag', /fragment/);
  reject('http://[::1]:8080/v1', /IPv6/);
  reject('http://10.1.2.3/v1', /SSRF/);
  reject('http://127.0.0.1:8622/v1', /SSRF/);
  const ok = validateUpstreamBaseUrl('https://relay.example.com/v1');
  assert.equal(ok.ok, true);
  assert.equal(ok.url?.hostname, 'relay.example.com');
});

test('ssrf：resolvePinnedUpstream 拒绝 IPv6/私网/空解析，全公网才通过并返回钉定 IP', async () => {
  const reject = async (results: LookupResults, pattern: RegExp) => {
    const out = await resolvePinnedUpstream({ hostname: 'upstream.test', lookup: async () => results });
    assert.equal(out.ok, false, `应拒绝：${JSON.stringify(results)}`);
    assert.match(out.message, pattern, `理由应匹配 ${pattern}：${out.message}`);
    assert.equal(out.ip, null);
  };
  await reject([], /无结果/);
  await reject([{ address: '::1', family: 6 }], /IPv6/);
  await reject([{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }], /IPv6/);
  await reject(
    [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.9', family: 4 },
    ],
    /SSRF|rebinding/,
  );
  const ok = await resolvePinnedUpstream({ hostname: 'upstream.test', lookup: async () => [{ address: PUBLIC_IP, family: 4 }] });
  assert.equal(ok.ok, true);
  assert.equal(ok.ip, PUBLIC_IP);
  // 解析失败同样拒绝并给出原由
  const failed = await resolvePinnedUpstream({
    hostname: 'broken.test',
    lookup: async () => {
      throw new Error('ENOTFOUND 模拟');
    },
  });
  assert.equal(failed.ok, false);
  assert.match(failed.message, /broken\.test/);
  // 字面量私网 IPv4 直接拒绝（不做 DNS）
  const literalPrivate = await resolvePinnedUpstream({ hostname: '192.168.0.9', lookup: async () => [] });
  assert.equal(literalPrivate.ok, false);
  assert.match(literalPrivate.message, /SSRF/);
});

test('ssrf：pinnedLookup 兼容 all/单地址两种回调形态', () => {
  const pinned = pinnedLookup('93.184.216.34');
  let called = 0;
  pinned('upstream.test', { all: true } as never, (error, addresses) => {
    called += 1;
    assert.equal(error, null);
    assert.deepEqual(addresses as unknown, [{ address: '93.184.216.34', family: 4 }]);
  });
  pinned('upstream.test', {} as never, (error, address, family) => {
    called += 1;
    assert.equal(error, null);
    assert.equal(address, '93.184.216.34');
    assert.equal(family, 4);
  });
  assert.equal(called, 2);
});

// ===== ② 渠道 / channels.ts =====

test('channels：缺字段 400 带收到值与示例；别名唯一约束成立；view 绝不回显 apiKey', () => {
  const store = new ChannelStore();
  assert.throws(
    () => store.create({ baseUrl: 'https://relay.example.com/v1' } as never),
    (error: unknown) => {
      assert.ok(error instanceof ChannelError);
      assert.equal((error as ChannelError).status, 400);
      assert.match((error as ChannelError).message, /apiKey 必填/);
      return true;
    },
  );
  const first = store.create(channelInput() as never);
  assert.throws(
    () => store.create(channelInput({ label: '冲突渠道' }) as never),
    /已被渠道|别名/,
  );
  const view = store.view(first);
  assert.equal(view.hasKey, true);
  assert.equal('apiKey' in JSON.parse(JSON.stringify(view)), false);
  // update：省略 apiKey = 不改；停用后 findByAlias 跳过
  const updated = store.update(first.id, { enabled: false });
  assert.equal(updated.enabled, false);
  assert.equal(updated.apiKey, MOCK_ECHO_AUTH);
  assert.equal(store.findByAlias('alias-a'), null);
  // 删除后别名即刻释放可复用
  assert.equal(store.remove(first.id), true);
  assert.equal(store.remove(first.id), false);
  const again = store.create(channelInput() as never);
  assert.equal(store.findByAlias('alias-a')?.id, again.id);
});

test('channels：非法别名/越界 modelMap/坏 label/坏 baseUrl/坏 apiKey 均 400', () => {
  const store = new ChannelStore();
  assert.throws(() => store.create(channelInput({ models: ['@bad'] }) as never), /别名非法/);
  assert.throws(() => store.create(channelInput({ models: [] }) as never), /非空数组/);
  assert.throws(() => store.create(channelInput({ models: ['dup', 'dup'] }) as never), /重复/);
  assert.throws(() => store.create(channelInput({ modelMap: { 'other-alias': 'x' } }) as never), /modelMap 键/);
  assert.throws(() => store.create(channelInput({ label: '' }) as never), /label/);
  assert.throws(() => store.create(channelInput({ baseUrl: 'http://10.0.0.9/v1' }) as never), /SSRF/);
  assert.throws(() => store.create(channelInput({ apiKey: 'a\nb' }) as never), /控制字符/);
  // enabled 严格布尔：字符串 "true" 不得被静默强转成停用
  assert.throws(() => store.create(channelInput({ enabled: 'true' }) as never), /enabled/);
});

// ===== ③ 数据面 / server.ts =====

test('数据面：缺/错 Bearer → 401 invalid_api_key；未知路由 → 404', async () => {
  const stack = await startGatewayStack();
  const { gateway } = stack;
  CLEANUPS.push(() => stack.cleanup());
  const anon = await request(gateway.port, '/v1/models');
  assert.equal(anon.status, 401);
  const wrong = await request(gateway.port, '/v1/models', { headers: { authorization: 'Bearer sk-wrong-key' } });
  assert.equal(wrong.status, 401);
  assert.match(JSON.parse(wrong.body).error.code, /invalid_api_key/);
  const okKey = await request(gateway.port, '/v1/models', { headers: authHeaders(gateway) });
  assert.equal(okKey.status, 200);
  const otherRoute = await request(gateway.port, '/v1/embeddings', { headers: authHeaders(gateway) });
  assert.equal(otherRoute.status, 404);
});

test('数据面：/v1/models 仅列 enabled 渠道别名；rotate 后旧 key 立即失效', async () => {
  const stack = await startGatewayStack();
  const { gateway } = stack;
  CLEANUPS.push(() => stack.cleanup());
  gateway.store.create(channelInput({}, stack.mock.port) as never);
  gateway.store.create(
    channelInput({ label: '停用渠道', models: ['alias-c'], modelMap: { 'alias-c': 'real-c' }, enabled: false }, stack.mock.port) as never,
  );
  const list = JSON.parse((await request(gateway.port, '/v1/models', { headers: authHeaders(gateway) })).body);
  const ids: string[] = list.data.map((entry: { id: string }) => entry.id);
  assert.deepEqual(ids.sort(), ['alias-a', 'alias-b']);
  // 轮换虚拟 key：旧 key 401，新 key 通过
  const oldKey = gateway.virtualKey;
  const newKey = gateway.rotateVirtualKey();
  assert.notEqual(newKey, oldKey);
  const stale = await request(gateway.port, '/v1/models', { headers: { authorization: `Bearer ${oldKey}` } });
  assert.equal(stale.status, 401);
  const fresh = await request(gateway.port, '/v1/models', { headers: { authorization: `Bearer ${newKey}` } });
  assert.equal(fresh.status, 200);
});

test('数据面：POST /v1/chat/completions 改写 model 转发；body 其余字段原样；上游 key 注入而非客户端 key', async () => {
  const stack = await startGatewayStack();
  const { gateway, mock } = stack;
  CLEANUPS.push(() => stack.cleanup());
  gateway.store.create(channelInput({}, stack.mock.port) as never);
  const res = await request(gateway.port, '/v1/chat/completions', {
    method: 'POST',
    headers: authHeaders(gateway),
    body: JSON.stringify({ model: 'alias-a', messages: [{ role: 'user', content: 'ping' }], temperature: 0 }),
  });
  assert.equal(res.status, 200);
  assert.equal(mock.state.lastPath, '/v1/chat/completions');
  assert.equal(mock.state.lastModel, 'upstream-real-model', 'modelMap 别名应改写为上游真实模型名');
  assert.equal(mock.state.lastAuth, `Bearer ${MOCK_ECHO_AUTH}`, '上游鉴权应为渠道 apiKey');
  assert.equal(mock.state.lastContentType, 'application/json');
  const payload = JSON.parse(res.body) as Record<string, unknown>;
  assert.deepEqual(payload, { echo: true, model: 'upstream-real-model' });
  // 未映射别名透传原名
  mock.reset();
  const passthrough = await request(gateway.port, '/v1/chat/completions', {
    method: 'POST',
    headers: authHeaders(gateway),
    body: JSON.stringify({ model: 'alias-b', messages: [] }),
  });
  assert.equal(passthrough.status, 200);
  assert.equal(mock.state.lastModel, 'alias-b');
  // 客户端凭证不外泄：上游收到的 Authorization 不含虚拟 key（sk-mx- 前缀）
  assert.equal(mock.state.lastAuth?.includes('sk-mx-'), false);
});

test('数据面：坏 model 字段 → 400；未知别名 → 404；停用 → 404「已停用」；删除 → 404 别名释放', async () => {
  const stack = await startGatewayStack();
  const { gateway } = stack;
  CLEANUPS.push(() => stack.cleanup());
  const channel = gateway.store.create(channelInput({}, stack.mock.port) as never);
  const bad = await request(gateway.port, '/v1/chat/completions', {
    method: 'POST',
    headers: authHeaders(gateway),
    body: JSON.stringify({ messages: [] }),
  });
  assert.equal(bad.status, 400);
  assert.match(JSON.parse(bad.body).error.code, /invalid_body/);
  assert.match(bad.body, /model/);
  const unknown = await request(gateway.port, '/v1/chat/completions', {
    method: 'POST',
    headers: authHeaders(gateway),
    body: JSON.stringify({ model: 'no-such', messages: [] }),
  });
  assert.equal(unknown.status, 404);
  assert.match(JSON.parse(unknown.body).error.code, /model_not_found/);
  // 停用：404 且消息注明「渠道已停用」；删除：404（别名释放）
  gateway.store.update(channel.id, { enabled: false });
  const disabledRes = await request(gateway.port, '/v1/chat/completions', {
    method: 'POST',
    headers: authHeaders(gateway),
    body: JSON.stringify({ model: 'alias-a', messages: [] }),
  });
  assert.equal(disabledRes.status, 404);
  assert.match(disabledRes.body, /已停用/);
  gateway.store.remove(channel.id);
  const removedRes = await request(gateway.port, '/v1/chat/completions', {
    method: 'POST',
    headers: authHeaders(gateway),
    body: JSON.stringify({ model: 'alias-a', messages: [] }),
  });
  assert.equal(removedRes.status, 404);
});

test('数据面：上游 3xx 不跟随且不外发 Location → 502 upstream_redirect_rejected', async () => {
  const stack = await startGatewayStack();
  const { gateway, mock } = stack;
  CLEANUPS.push(() => stack.cleanup());
  gateway.store.create(channelInput({}, stack.mock.port) as never);
  mock.setResponder(() => ({ status: 302 }));
  const res = await request(gateway.port, '/v1/chat/completions', {
    method: 'POST',
    headers: authHeaders(gateway),
    body: JSON.stringify({ model: 'alias-a', messages: [] }),
  });
  assert.equal(res.status, 502);
  const payload = JSON.parse(res.body) as { error: { code: string; message: string } };
  assert.equal(payload.error.code, 'upstream_redirect_rejected');
  assert.equal(res.headers['location'], undefined, '绝不能把上游 Location 外发给客户端');
});

test('数据面：SSRF 解析结果含私网 → 502 upstream_blocked；渠道统计不计数；恢复后同渠道可转发', async () => {
  const stack = await startGatewayStack();
  const { gateway, mock } = stack;
  CLEANUPS.push(() => stack.cleanup());
  const channel = gateway.store.create(channelInput({}, stack.mock.port) as never);
  mock.setResponder(() => ({ status: 200, payload: { ok: true } }));
  stack.setDns([
    { address: '93.184.216.34', family: 4 },
    { address: '192.168.1.9', family: 4 },
  ]);
  const res = await request(gateway.port, '/v1/chat/completions', {
    method: 'POST',
    headers: authHeaders(gateway),
    body: JSON.stringify({ model: 'alias-a', messages: [] }),
  });
  assert.equal(res.status, 502);
  assert.match(JSON.parse(res.body).error.code, /upstream_blocked/);
  assert.equal(mock.state.lastPath, null, '被拒请求不得实际触达 mock 上游');
  const view = gateway.store.view(channel);
  assert.equal(view.stats.requests, 0, '未实际发往上游的请求不计入渠道统计');
  // 恢复正常解析后同一渠道可转发
  stack.setDns([{ address: '93.184.216.34', family: 4 }]);
  const ok = await request(gateway.port, '/v1/chat/completions', {
    method: 'POST',
    headers: authHeaders(gateway),
    body: JSON.stringify({ model: 'alias-a', messages: [] }),
  });
  assert.equal(ok.status, 200);
  assert.equal(gateway.store.view(channel).stats.requests, 1);
  assert.equal(gateway.store.view(channel).stats.ok, 1);
});

test('数据面：请求体超上限 → 413；请求体非 JSON → 400', async () => {
  const stack = await startGatewayStack();
  const { gateway, mock } = stack;
  CLEANUPS.push(() => stack.cleanup());
  gateway.store.create(channelInput({}, stack.mock.port) as never);
  mock.setResponder(() => ({ status: 200, payload: {} }));
  const huge = JSON.stringify({ model: 'alias-a', messages: [], pad: 'x'.repeat(17 * 1024 * 1024) });
  const tooLarge = await request(gateway.port, '/v1/chat/completions', {
    method: 'POST',
    headers: authHeaders(gateway),
    body: huge,
  });
  assert.equal(tooLarge.status, 413);
  assert.match(JSON.parse(tooLarge.body).error.code, /payload_too_large/);
  const notJson = await request(gateway.port, '/v1/chat/completions', {
    method: 'POST',
    headers: authHeaders(gateway),
    body: 'this is not json',
  });
  assert.equal(notJson.status, 400);
});

test('数据面：上游无响应 → 504 upstream_timeout（网关不重试）', { timeout: 10000 }, async () => {
  const stack = await startGatewayStack({ upstreamTimeoutMs: 300 });
  const { gateway, mock } = stack;
  CLEANUPS.push(() => stack.cleanup());
  gateway.store.create(channelInput({}, stack.mock.port) as never);
  // 上游收下请求但挂起不响应：网关 300ms 超时后应断开并回 504（不重试）
  mock.setResponder(() => null);
  const res = await request(gateway.port, '/v1/chat/completions', {
    method: 'POST',
    headers: authHeaders(gateway),
    body: JSON.stringify({ model: 'alias-a', messages: [] }),
  });
  assert.equal(res.status, 504);
  assert.match(JSON.parse(res.body).error.code, /upstream_timeout/);
});

test('数据面：上游连接被拒 → 502 upstream_unavailable；渠道统计计一次错误', async () => {
  // 先起一个 mock 拿到端口，随即关闭——保证该端口本地拒绝连接
  const dead = await MockUpstream.start();
  const deadPort = dead.port;
  await dead.close();
  const gateway = await createAliasGateway({
    port: 0,
    lookup: async () => [{ address: PUBLIC_IP, family: 4 }],
    mapSocket: () => ({ host: '127.0.0.1', port: deadPort }),
  });
  CLEANUPS.push(async () => {
    await gateway.close();
  });
  const channel = gateway.store.create(channelInput({}, deadPort) as never);
  const res = await request(gateway.port, '/v1/chat/completions', {
    method: 'POST',
    headers: authHeaders(gateway),
    body: JSON.stringify({ model: 'alias-a', messages: [] }),
  });
  assert.equal(res.status, 502);
  assert.match(JSON.parse(res.body).error.code, /upstream_unavailable/);
  const view = gateway.store.view(channel);
  assert.equal(view.stats.requests, 1);
  assert.equal(view.stats.errors, 1);
});

test('数据面：客户端中途断开 → 计一次请求但绝不计为成功（不借上次 lastStatus 假阳性）', async () => {
  const stack = await startGatewayStack({ upstreamTimeoutMs: 30000 });
  const { gateway, mock } = stack;
  CLEANUPS.push(() => stack.cleanup());
  const channel = gateway.store.create(channelInput({}, stack.mock.port) as never);
  mock.setResponder(() => null); // 上游收下请求后挂起，客户端先断开
  await new Promise<void>((resolveAbort) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: gateway.port, path: '/v1/chat/completions', method: 'POST', headers: authHeaders(gateway) },
      () => resolveAbort(),
    );
    req.on('error', () => resolveAbort());
    req.end(JSON.stringify({ model: 'alias-a', messages: [] }));
    setTimeout(() => {
      req.destroy();
      resolveAbort();
    }, 150);
  });
  const deadline = Date.now() + 3000;
  while (gateway.store.view(channel).stats.requests === 0 && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  }
  const stats = gateway.store.view(channel).stats;
  assert.equal(stats.requests, 1);
  assert.equal(stats.ok, 0, '客户端中断的请求不得计入 ok（未知结果按错误保守统计）');
  assert.equal(stats.errors, 1, '客户端中断必须计入 errors（回归防护：漏调 errors++ 必须被捕获）');
});

test('数据面：上游 2xx 响应体传输截断 → 绝不记为成功（记一次错误）；账本结算=truncated/upstream', async () => {
  const fixture = makeLedgerFixture();
  const stack = await startGatewayStack({ ledger: fixture.ledger });
  const { gateway, mock } = stack;
  CLEANUPS.push(() => stack.cleanup());
  CLEANUPS.push(async () => fixture.cleanup());
  const channel = gateway.store.create(channelInput({}, stack.mock.port) as never);
  mock.setResponder(() => ({ status: 200, truncate: true }));
  await new Promise<void>((resolveDone) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: gateway.port, path: '/v1/chat/completions', method: 'POST', headers: authHeaders(gateway) },
      (res) => {
        res.on('data', () => {});
        res.on('close', () => resolveDone());
        res.on('error', () => resolveDone());
      },
    );
    req.on('error', () => resolveDone());
    req.end(JSON.stringify({ model: 'alias-a', messages: [] }));
  });
  const deadline = Date.now() + 3000;
  while (gateway.store.view(channel).stats.requests === 0 && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  }
  const stats = gateway.store.view(channel).stats;
  assert.equal(stats.requests, 1);
  assert.equal(stats.ok, 0, '截断的 2xx 响应不得计入 ok（只认完整送达）');
  assert.equal(stats.errors, 1, '截断必须计入 errors');
  // 账本：截断如实结算为 truncated 且归因 upstream（绝不双记、绝不冤枉客户端）
  await waitFor(() => fixture.settlementRows().length === 1);
  const rows = fixture.settlementRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!['client_status'], 'truncated');
  assert.equal(rows[0]!['error_source'], 'upstream');
  assert.equal(rows[0]!['token_source'], 'none', '截断响应不得伪造 usage');
});

// ===== ④ 管理面（经 serve.mjs，全端点 token 校验） =====

// 与 serve.test.ts 同款：运行时位于 dist/test/unit/，回溯仓库根
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'scripts', 'serve.mjs'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('未找到 scripts/serve.mjs：请在仓库根目录构建并运行测试。');
}
const REPO_ROOT = findRepoRoot();
const SERVE_URL = pathToFileURL(join(REPO_ROOT, 'scripts', 'serve.mjs')).href;
const serveModule = (await import(SERVE_URL)) as {
  createConsoleServer(options: { port: number; repoRoot: string }): Promise<{
    port: number;
    token: string;
    close(): Promise<void>;
  }>;
};
function manageHeaders(token: string): Record<string, string> {
  return { 'x-model-xray-token': token, 'content-type': 'application/json' };
}

test('管理面：无 token 一律 403（GET 亦要求 token）', async () => {
  const server = await serveModule.createConsoleServer({ port: 0, repoRoot: REPO_ROOT });
  CLEANUPS.push(async () => {
    await server.close().catch(() => undefined);
  });
  const noToken = await request(server.port, '/api/gateway/status');
  assert.equal(noToken.status, 403);
  const wrongToken = await request(server.port, '/api/gateway/channels', { headers: { 'x-model-xray-token': 'wrong' } });
  assert.equal(wrongToken.status, 403);
  const startNoToken = await request(server.port, '/api/gateway/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(startNoToken.status, 403);
});

test('管理面：start（随机回环端口）→ running；重复 start → 409；渠道 CRUD/删除/停用语义成立', { timeout: 20000 }, async () => {
  const server = await serveModule.createConsoleServer({ port: 0, repoRoot: REPO_ROOT });
  CLEANUPS.push(async () => {
    await server.close().catch(() => undefined);
  });
  const token = server.token;
  const header = manageHeaders(token);
  const initial = JSON.parse((await request(server.port, '/api/gateway/status', { headers: header })).body);
  assert.equal(initial.running, false);
  const start = JSON.parse(
    (await request(server.port, '/api/gateway/start', { method: 'POST', headers: header, body: '{}' })).body,
  );
  assert.ok(start.port > 0 && start.port <= 65535, `应返回随机回环端口：${start.port}`);
  assert.match(String(start.virtualKey), /^sk-mx-/);
  assert.equal(
    (await request(server.port, '/api/gateway/start', { method: 'POST', headers: header, body: '{}' })).status,
    409,
  );
  const status = JSON.parse((await request(server.port, '/api/gateway/status', { headers: header })).body);
  assert.equal(status.running, true);
  assert.equal(status.port, start.port);
  // 渠道 CRUD：私网 baseUrl 400（SSRF 拒绝自录入即拦截）；正常录入视图无 apiKey
  const privateBlocked = await request(server.port, '/api/gateway/channels', {
    method: 'POST',
    headers: header,
    body: JSON.stringify({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-x', models: ['alias-a'] }),
  });
  assert.equal(privateBlocked.status, 400);
  assert.match(privateBlocked.body, /SSRF/);
  const created = JSON.parse(
    (
      await request(server.port, '/api/gateway/channels', {
        method: 'POST',
        headers: header,
        body: JSON.stringify({
          label: '主渠道',
          baseUrl: 'https://relay.example.com/v1',
          apiKey: 'sk-secret-upstream',
          models: ['alias-a'],
        }),
      })
    ).body,
  );
  const view = created.channel as ChannelView;
  assert.equal(view.hasKey, true);
  assert.doesNotMatch(JSON.stringify(created), /apiKey/, '渠道视图绝不回显 apiKey（仅 hasKey）');
  // 更新（停用）→ 删除 → 重复删除 404
  const updated = JSON.parse(
    (
      await request(server.port, `/api/gateway/channels/${view.id}`, {
        method: 'POST',
        headers: header,
        body: JSON.stringify({ enabled: false }),
      })
    ).body,
  );
  assert.equal((updated.channel as ChannelView).enabled, false);
  const removed = JSON.parse(
    (
      await request(server.port, `/api/gateway/channels/${view.id}/delete`, { method: 'POST', headers: header, body: '{}' })
    ).body,
  );
  assert.deepEqual(removed, { deleted: true });
  assert.equal(
    (
      await request(server.port, `/api/gateway/channels/${view.id}/delete`, { method: 'POST', headers: header, body: '{}' })
    ).status,
    404,
  );
  // 虚拟 key GET / rotate
  const keyGet = JSON.parse((await request(server.port, '/api/gateway/virtual-key', { headers: header })).body);
  assert.match(keyGet.virtualKey, /^sk-mx-/);
  const rotated = JSON.parse(
    (await request(server.port, '/api/gateway/virtual-key/rotate', { method: 'POST', headers: header, body: '{}' })).body,
  );
  assert.notEqual(rotated.virtualKey, keyGet.virtualKey);
  // stop → stopped；status 回到 not running
  const stopped = JSON.parse(
    (await request(server.port, '/api/gateway/stop', { method: 'POST', headers: header, body: '{}' })).body,
  );
  assert.equal(stopped.stopped, true);
  const after = JSON.parse((await request(server.port, '/api/gateway/status', { headers: header })).body);
  assert.equal(after.running, false);
});

test('管理面：未运行时渠道/虚拟 key 端点 400 引导启动（非 500 崩溃）', async () => {
  const server = await serveModule.createConsoleServer({ port: 0, repoRoot: REPO_ROOT });
  CLEANUPS.push(async () => {
    await server.close().catch(() => undefined);
  });
  const token = server.token;
  const channels = await request(server.port, '/api/gateway/channels', {
    method: 'POST',
    headers: manageHeaders(token),
    body: JSON.stringify({ baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-x', models: ['alias-a'] }),
  });
  assert.equal(channels.status, 400);
  assert.match(channels.body, /网关未运行|start/);
  const virtualKey = await request(server.port, '/api/gateway/virtual-key', { headers: manageHeaders(token) });
  assert.equal(virtualKey.status, 400);
});

test('管理面：并发 start 只允许一个成功（另一个 409，不泄漏第二个监听实例）', { timeout: 20000 }, async () => {
  const server = await serveModule.createConsoleServer({ port: 0, repoRoot: REPO_ROOT });
  CLEANUPS.push(async () => {
    await server.close().catch(() => undefined);
  });
  const header = manageHeaders(server.token);
  const [first, second] = await Promise.all([
    request(server.port, '/api/gateway/start', { method: 'POST', headers: header, body: '{}' }),
    request(server.port, '/api/gateway/start', { method: 'POST', headers: header, body: '{}' }),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 409]);
  const winner = first.status === 200 ? first : second;
  const status = JSON.parse((await request(server.port, '/api/gateway/status', { headers: header })).body);
  assert.equal(status.running, true);
  assert.equal(status.port, JSON.parse(winner.body).port, '运行中的实例必须是成功返回的那个端口');
});

test('管理面：start 参数非法（400）后 starting 已复位，可立即正常启动（finally 复位回归）', { timeout: 20000 }, async () => {
  const server = await serveModule.createConsoleServer({ port: 0, repoRoot: REPO_ROOT });
  CLEANUPS.push(async () => {
    await server.close().catch(() => undefined);
  });
  const header = manageHeaders(server.token);
  const badPort = await request(server.port, '/api/gateway/start', {
    method: 'POST',
    headers: header,
    body: JSON.stringify({ port: '99999' }),
  });
  assert.equal(badPort.status, 400, '越界端口应 400');
  assert.match(badPort.body, /65535/);
  const started = await request(server.port, '/api/gateway/start', { method: 'POST', headers: header, body: '{}' });
  assert.equal(started.status, 200, '校验失败路径必须复位 starting（try/finally），不得永久 409');
  assert.ok(JSON.parse(started.body).port > 0);
});

test('管理面：未构建 → start 503 引导；复制 dist 后免重启重试成功（加载失败不缓存为永久 null）', { timeout: 20000 }, async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'mx-serve-root-'));
  const server = await serveModule.createConsoleServer({ port: 0, repoRoot: tempRoot });
  CLEANUPS.push(async () => {
    await server.close().catch(() => undefined);
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3 });
  });
  const header = manageHeaders(server.token);
  const notBuilt = await request(server.port, '/api/gateway/start', { method: 'POST', headers: header, body: '{}' });
  assert.equal(notBuilt.status, 503, '未构建时回 503 引导构建');
  assert.match(notBuilt.body, /npm run build/);
  // 模拟「构建完成」：复制真实 dist/src 到临时仓库根，再次 start 必须免重启成功
  cpSync(join(REPO_ROOT, 'dist', 'src'), join(tempRoot, 'dist', 'src'), { recursive: true });
  const started = await request(server.port, '/api/gateway/start', { method: 'POST', headers: header, body: '{}' });
  assert.equal(started.status, 200, '构建完成后重试必须成功（失败不得缓存为永久 null）');
  assert.ok(JSON.parse(started.body).port > 0);
  const status = JSON.parse((await request(server.port, '/api/gateway/status', { headers: header })).body);
  assert.equal(status.running, true);
});

// ===== ⑤ 账本（S1）× 旁路观测（S2）× 告警（S3-lite）集成 =====

/** 金丝雀密钥：绝不允许出现在账本落库内容与网关日志流中。 */
const CANARY_KEY = 'sk-canary-9f8e7d6c5b4a';

test('账本⑥：流式请求 → 恰一请求+一结算（ok/usage token/TTFT 如实落库）；渠道密钥不入账本与日志', { timeout: 15000 }, async () => {
  const fixture = makeLedgerFixture();
  const logs: string[] = [];
  const stack = await startGatewayStack({ ledger: fixture.ledger, onLog: (line) => logs.push(line) });
  const { gateway, mock } = stack;
  CLEANUPS.push(() => stack.cleanup());
  CLEANUPS.push(async () => fixture.cleanup());
  gateway.store.create(channelInput({ apiKey: CANARY_KEY }, stack.mock.port) as never);
  mock.setResponder(() => ({
    status: 200,
    sse: sseBody([
      { id: 'c1', model: 'upstream-real-model', choices: [{ index: 0, delta: { role: 'assistant', content: '你' }, finish_reason: null }] },
      { id: 'c1', model: 'upstream-real-model', choices: [{ index: 0, delta: { content: '好' }, finish_reason: null }] },
      {
        id: 'c1',
        model: 'upstream-real-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          total_tokens: 12,
          prompt_tokens_details: { cached_tokens: 3 },
          completion_tokens_details: { reasoning_tokens: 1 },
        },
      },
    ]),
  }));
  const res = await request(gateway.port, '/v1/chat/completions', {
    method: 'POST',
    headers: authHeaders(gateway),
    body: JSON.stringify({ model: 'alias-a', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 200);
  assert.match(String(res.headers['content-type']), /text\/event-stream/);
  assert.match(res.body, /\[DONE\]/);
  // 客户端收到 end 与网关 settle 有微竞态：轮询等待落库
  await waitFor(() => fixture.settlementRows().length === 1);
  const requestRows = fixture.requestRows();
  const settlementRows = fixture.settlementRows();
  assert.equal(requestRows.length, 1, '恰一条请求入账');
  assert.equal(settlementRows.length, 1, '恰一条结算（幂等不双记）');
  const req = requestRows[0]!;
  assert.equal(req['origin'], 'user');
  assert.equal(req['alias'], 'alias-a');
  assert.equal(req['model_upstream'], 'upstream-real-model');
  assert.equal(req['messages_count'], 1);
  assert.equal(req['has_tools'], 0);
  assert.equal(req['has_image'], 0);
  assert.ok(Number(req['req_bytes']) > 0, '请求体字节数应入账');
  const row = settlementRows[0]!;
  assert.equal(row['client_status'], 'ok');
  assert.equal(row['error_source'], null);
  assert.equal(row['upstream_status'], 200);
  assert.equal(row['finish_reason'], 'stop');
  assert.equal(row['token_prompt'], 10);
  assert.equal(row['token_completion'], 2);
  assert.equal(row['token_cached'], 3, 'cached_tokens 明细应入账');
  assert.equal(row['token_reasoning'], 1, 'reasoning_tokens 明细应入账');
  assert.equal(row['token_source'], 'usage');
  assert.equal(row['token_missing_reason'], null);
  assert.equal(row['usage_valid'], 1);
  assert.ok(row['ttft_upstream_ms'] !== null, '首个内容帧到达应有 TTFT 样本');
  // 金丝雀：渠道密钥绝不进入账本全库 dump 与网关日志流
  assert.equal(fixture.dump().includes(CANARY_KEY), false, '渠道 apiKey 绝不出现在账本');
  assert.equal(logs.some((line) => line.includes(CANARY_KEY)), false, '渠道 apiKey 绝不出现在网关日志');
  // 账本聚合与预期一致
  const ledgerRows = fixture.ledger.usageSummary();
  assert.equal(ledgerRows.length, 1);
  assert.equal(ledgerRows[0]!.requests, 1);
  assert.equal(ledgerRows[0]!.ok, 1);
  assert.equal(ledgerRows[0]!.tokenPrompt, 10);
});

test('账本⑧：网关内存 usageSummary 与账本 usageSummary 双口径计数一致（3 条流式请求）', { timeout: 15000 }, async () => {
  const fixture = makeLedgerFixture();
  const stack = await startGatewayStack({ ledger: fixture.ledger, alertSilenceMs: 0 });
  const { gateway, mock } = stack;
  CLEANUPS.push(() => stack.cleanup());
  CLEANUPS.push(async () => fixture.cleanup());
  gateway.store.create(channelInput({}, stack.mock.port) as never);
  mock.setResponder(() => ({
    status: 200,
    sse: sseBody([
      { model: 'upstream-real-model', choices: [{ index: 0, delta: { content: 'x' }, finish_reason: null }] },
      {
        model: 'upstream-real-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          total_tokens: 12,
          prompt_tokens_details: { cached_tokens: 3 },
          completion_tokens_details: { reasoning_tokens: 1 },
        },
      },
    ]),
  }));
  for (let i = 0; i < 3; i += 1) {
    const res = await request(gateway.port, '/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders(gateway),
      body: JSON.stringify({ model: 'alias-a', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
  }
  await waitFor(() => fixture.settlementRows().length === 3);
  const gw = gateway.usageSummary();
  const ledgerRows = fixture.ledger.usageSummary();
  assert.equal(gw.length, 1, '内存口径按 (channel, alias) 一行');
  assert.equal(ledgerRows.length, 1);
  const g = gw[0]!;
  const l = ledgerRows[0]!;
  assert.equal(g.channelId, l.channelId);
  assert.equal(g.alias, l.alias);
  assert.equal(g.requests, l.requests, '请求数双口径一致');
  assert.equal(g.ok, l.ok, 'ok 数双口径一致');
  assert.equal(g.error, l.errors, '错误数双口径一致');
  assert.equal(g.tokenPrompt, l.tokenPrompt, 'prompt token 总额双口径一致');
  assert.equal(g.tokenCompletion, l.tokenCompletion);
  assert.equal(g.tokenCached, l.tokenCached);
  assert.equal(g.tokenReasoning, l.tokenReasoning);
  assert.equal(g.usageValid, 3);
  assert.equal(g.usageValidRate, 1);
  assert.equal(g.ttftSamples + g.ttftContaminated, 3, 'TTFT 样本守恒：进分位 + 因事件循环滞后剔除 = 总样本');
  assert.equal(g.provisional, true, '样本 <20 应标记 provisional');
  assert.equal(g.ttftP95Ms, null, '样本不足不披露 p95');
  if (g.ttftSamples > 0) {
    assert.ok(g.ttftP50Ms !== null, 'p50 应可用于趋势观察');
  } else {
    assert.equal(g.ttftP50Ms, null, '全部样本被剔除时不披露 p50');
  }
});

test('账本⑨：账本全抛错（stub）→ 转发不受影响（fail-open），status().degraded 如实披露且读不膨胀', async () => {
  const throwingLedger: GatewayLedger = {
    recordRequest() {
      throw new Error('ledger record boom');
    },
    settle() {
      throw new Error('ledger settle boom');
    },
    stats() {
      throw new Error('ledger stats boom');
    },
  };
  const stack = await startGatewayStack({ ledger: throwingLedger });
  const { gateway, mock } = stack;
  CLEANUPS.push(() => stack.cleanup());
  gateway.store.create(channelInput({}, stack.mock.port) as never);
  mock.setResponder(() => ({ status: 200, payload: { ok: true } }));
  const res = await request(gateway.port, '/v1/chat/completions', {
    method: 'POST',
    headers: authHeaders(gateway),
    body: JSON.stringify({ model: 'alias-a', messages: [] }),
  });
  assert.equal(res.status, 200, '账本故障绝不影响转发');
  assert.deepEqual(JSON.parse(res.body), { ok: true });
  await waitFor(() => gateway.status().requests.ok === 1);
  const status = gateway.status();
  assert.equal(status.degraded.degraded, true, '账本故障必须披露降级（含 stats() 不可读）');
  assert.ok(status.degraded.writeErrors >= 2, 'record + settle 抛错都应计数');
  const second = gateway.status();
  assert.equal(second.degraded.writeErrors, status.degraded.writeErrors, '反复读 status 不得膨胀 writeErrors（幂等）');
});

test('告警⑩：模型名不一致 ×2 → 恰一条 model_mismatch（证据 id 齐）；冷却内不重复；大小写差异不触发', { timeout: 15000 }, async () => {
  const stack = await startGatewayStack({ alertSilenceMs: 0 });
  const { gateway, mock } = stack;
  CLEANUPS.push(() => stack.cleanup());
  const channel = gateway.store.create(channelInput({ models: ['alias-a'] }, stack.mock.port) as never);
  mock.setResponder(() => ({
    status: 200,
    sse: sseBody([{ model: 'other-model', choices: [{ index: 0, delta: { content: 'a' }, finish_reason: null }] }]),
  }));
  const sendChat = async (model: string) => {
    const res = await request(gateway.port, '/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders(gateway),
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
  };
  const settledCount = (alias: string) => gateway.usageSummary().find((row) => row.alias === alias)?.requests ?? 0;
  await sendChat('alias-a');
  await sendChat('alias-a');
  await waitFor(() => settledCount('alias-a') === 2);
  const alerts = gateway.events();
  assert.equal(alerts.length, 1, '两次不一致应触发一条告警（窗口阈值 2）');
  assert.equal(alerts[0]!.kind, 'model_mismatch');
  assert.equal(alerts[0]!.channel, channel.id);
  assert.equal(alerts[0]!.n, 2);
  assert.equal(alerts[0]!.observed, 2);
  assert.equal(alerts[0]!.evidence_request_ids.length, 2);
  for (const id of alerts[0]!.evidence_request_ids) assert.match(id, /^[0-9a-f-]{36}$/, '证据应为网关请求 id');
  // 冷却期（30 分钟）内继续不一致：不重复告警
  await sendChat('alias-a');
  await sendChat('alias-a');
  await waitFor(() => settledCount('alias-a') === 4);
  assert.equal(gateway.events().length, 1, '冷却期内同一 (渠道,类别) 不重复告警');
  // 对照组：仅大小写不同（ALIAS-B vs alias-b）不算 mismatch → 不发告警
  gateway.store.create(channelInput({ label: '大小写渠道', models: ['alias-b'], modelMap: {} }, stack.mock.port) as never);
  mock.setResponder(() => ({
    status: 200,
    sse: sseBody([{ model: 'ALIAS-B', choices: [{ index: 0, delta: { content: 'a' }, finish_reason: null }] }]),
  }));
  await sendChat('alias-b');
  await sendChat('alias-b');
  await waitFor(() => settledCount('alias-b') === 2);
  assert.equal(gateway.events().length, 1, '大小写仅不同的模型名不得触发 mismatch 误报');
});

// ===== 旁路观测：TTFT 污染剔除（事件循环滞后防护，loopLagThresholdMs） =====

/** 旁路观测⑪-⑬共用：含内容帧 + 终帧 usage 的 SSE（必产生 TTFT 样本）。 */
function ttftSseResponder(): { status: number; sse: string } {
  return {
    status: 200,
    sse: sseBody([
      { model: 'upstream-real-model', choices: [{ index: 0, delta: { content: 'x' }, finish_reason: null }] },
      {
        model: 'upstream-real-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      },
    ]),
  };
}

/** 连发 N 次流式 chat 请求，全部断言 200。 */
async function sendStreamChat(gateway: AliasGateway, times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    const res = await request(gateway.port, '/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders(gateway),
      body: JSON.stringify({ model: 'alias-a', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
  }
}

test('旁路观测⑪：loopLagThresholdMs=0 → 全部 TTFT 样本剔除不进分位；账本如实标记且保留 raw TTFT', { timeout: 15000 }, async () => {
  const fixture = makeLedgerFixture();
  const stack = await startGatewayStack({ ledger: fixture.ledger, alertSilenceMs: 0, loopLagThresholdMs: 0 });
  const { gateway, mock } = stack;
  CLEANUPS.push(() => stack.cleanup());
  CLEANUPS.push(async () => fixture.cleanup());
  gateway.store.create(channelInput({}, stack.mock.port) as never);
  mock.setResponder(() => ttftSseResponder());
  await sendStreamChat(gateway, 2);
  await waitFor(() => fixture.settlementRows().length === 2);
  const gw = gateway.usageSummary()[0]!;
  assert.equal(gw.ttftSamples, 0, '阈值 0（>= 语义）必须剔除全部样本');
  assert.equal(gw.ttftContaminated, 2, '剔除样本必须可观测计数，不得静默消失');
  assert.equal(gw.ttftP50Ms, null, '无未污染样本不得披露 p50（空分位不崩）');
  assert.equal(gw.ttftP95Ms, null);
  assert.equal(gw.provisional, true);
  const rows = fixture.settlementRows();
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row['ttft_contaminated'], 1, '被剔除样本必须如实标记 1');
    assert.ok(row['ttft_upstream_ms'] !== null, 'raw TTFT 必须保留（剔除只影响分位口径，绝不丢数据）');
  }
});

test('旁路观测⑫：阈值极大 → 全部样本保留（污染计数 0，p50 可用；n<20 仍不披露 p95）', { timeout: 15000 }, async () => {
  const stack = await startGatewayStack({ alertSilenceMs: 0, loopLagThresholdMs: Number.MAX_SAFE_INTEGER });
  const { gateway, mock } = stack;
  CLEANUPS.push(() => stack.cleanup());
  gateway.store.create(channelInput({}, stack.mock.port) as never);
  mock.setResponder(() => ttftSseResponder());
  await sendStreamChat(gateway, 3);
  await waitFor(() => (gateway.usageSummary()[0]?.requests ?? 0) === 3);
  const gw = gateway.usageSummary()[0]!;
  assert.equal(gw.ttftSamples, 3, '阈值极大不得剔除任何样本');
  assert.equal(gw.ttftContaminated, 0, '无剔除时污染计数必须为 0');
  assert.ok(gw.ttftP50Ms !== null, '样本保留时必须可披露 p50');
  assert.equal(gw.ttftP95Ms, null, 'n<20 仍不披露 p95（provisional）');
  assert.equal(gw.provisional, true);
});

test('旁路观测⑬：默认阈值不变量——样本守恒；账本逐行 0/1 与内存口径一致', { timeout: 15000 }, async () => {
  const fixture = makeLedgerFixture();
  const stack = await startGatewayStack({ ledger: fixture.ledger, alertSilenceMs: 0 });
  const { gateway, mock } = stack;
  CLEANUPS.push(() => stack.cleanup());
  CLEANUPS.push(async () => fixture.cleanup());
  gateway.store.create(channelInput({}, stack.mock.port) as never);
  mock.setResponder(() => ttftSseResponder());
  await sendStreamChat(gateway, 3);
  await waitFor(() => fixture.settlementRows().length === 3);
  const gw = gateway.usageSummary()[0]!;
  assert.equal(gw.ttftSamples + gw.ttftContaminated, 3, '守恒不变式：进分位 + 剔除 = 总样本');
  let kept = 0;
  let dropped = 0;
  const rows = fixture.settlementRows();
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.ok(row['ttft_upstream_ms'] !== null, '样本存在时 raw TTFT 必须保留');
    const flag = row['ttft_contaminated'];
    assert.ok(flag === 0 || flag === 1, `ttft_contaminated 只允许 0/1（收到 ${String(flag)}）`);
    if (flag === 1) dropped += 1;
    else kept += 1;
  }
  assert.equal(kept, gw.ttftSamples, '账本保留数与内存进分位样本数一致');
  assert.equal(dropped, gw.ttftContaminated, '账本剔除数与内存剔除计数一致');
  if (gw.ttftSamples > 0) {
    assert.ok(gw.ttftP50Ms !== null, '有未污染样本时 p50 应可用');
  } else {
    assert.equal(gw.ttftP50Ms, null, '全被剔除时不披露 p50');
  }
});
