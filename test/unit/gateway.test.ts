// test/unit/gateway.test.ts —— 网关切片的安全关键用例：
//   ① SSRF：私网/保留/回环/IPv6/混合解析结果一律拒绝；连接钉定杜绝二次解析；
//   ② 数据面：独立虚拟 key（常量时间比较）、五条路由（OpenAI 三条 + Anthropic 两条）、model 别名改写、渠道删除/停用语义、
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
import { ChannelError, ChannelStore, noteChannelResult, type ChannelView } from '../../src/gateway/channels.js';
import { computeCostUsd } from '../../src/gateway/pricing.js';
import { isAllowedPrivateIpv4, isPublicIpv4, validateUpstreamBaseUrl, resolvePinnedUpstream, pinnedLookup } from '../../src/gateway/ssrf.js';
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
  lastXApiKey: string | null;
  lastAnthropicVersion: string | null;
  lastAnthropicBeta: string | null;
}
/** responder 返回 null = 收下请求但永不响应（用于上游挂起 → 504 测试）；truncate=true = 发出 2xx 响应头与部分 body 后断连（模拟传输截断）；sse = 以 text/event-stream 整段回发（模拟流式）；delayMs = 先挂起再回发（制造上游 TTFT；对 sse/JSON 均生效）。 */
type MockResponder = (parsed: Record<string, unknown>) =>
  | { status: number; payload?: unknown; truncate?: boolean; sse?: string; contentType?: string; delayMs?: number }
  | null;
class MockUpstream {
  private behavior: MockResponder = (parsed) => ({ status: 200, payload: { echo: true, model: parsed['model'] } });
  private server!: ReturnType<typeof createServer>;
  readonly state: MockState = { lastPath: null, lastAuth: null, lastModel: null, lastContentType: null, lastXApiKey: null, lastAnthropicVersion: null, lastAnthropicBeta: null };
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
        holder.state.lastXApiKey = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : null;
        holder.state.lastAnthropicVersion = typeof req.headers['anthropic-version'] === 'string' ? req.headers['anthropic-version'] : null;
        holder.state.lastAnthropicBeta = typeof req.headers['anthropic-beta'] === 'string' ? req.headers['anthropic-beta'] : null;
        holder.state.lastModel = parsed['model'] ?? null;
        const out = holder.behavior(parsed);
        if (out === null) return; // 收下请求后挂起不响应
        if (out.truncate === true) {
          // 声明大 content-length 后只发部分 body 即断连：模拟上游 2xx 传输截断
          const doTruncate = () => {
            res.writeHead(out.status, { 'content-type': 'application/json; charset=utf-8', 'content-length': '4096' });
            res.write('{"truncated":');
            setTimeout(() => res.destroy(), 30);
          };
          if (out.delayMs === undefined) {
            doTruncate();
          } else {
            setTimeout(doTruncate, out.delayMs);
          }
          return;
        }
        if (out.sse !== undefined) {
          // 流式响应：text/event-stream 整段回发（tee 观测按帧解析；无 content-length 走 chunked）
          const sendSse = () => {
            res.writeHead(out.status, { 'content-type': out.contentType ?? 'text/event-stream; charset=utf-8' });
            res.end(out.sse);
          };
          if (out.delayMs === undefined) {
            sendSse();
          } else {
            setTimeout(sendSse, out.delayMs);
          }
          return;
        }
        const body = Buffer.from(JSON.stringify(out.payload ?? {}), 'utf8');
        const sendJson = () => {
          res.writeHead(out.status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) });
          res.end(body);
        };
        if (out.delayMs === undefined) {
          sendJson();
        } else {
          setTimeout(sendJson, out.delayMs);
        }
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
    this.state.lastXApiKey = null;
    this.state.lastAnthropicVersion = null;
    this.state.lastAnthropicBeta = null;
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

/** 组装 Anthropic Messages SSE 流：event/data 成对帧（与真实上游帧型一致，帧间空行分隔，无 [DONE] 哨兵）。 */
function anthropicSseBody(frames: Array<Record<string, unknown>>): string {
  return (
    frames
      .map((frame) => `event: ${typeof frame['type'] === 'string' ? (frame['type'] as string) : 'message'}\ndata: ${JSON.stringify(frame)}`)
      .join('\n\n') + '\n\n'
  );
}

/** Anthropic 路由鉴权头：默认 x-api-key 携带虚拟 key（Anthropic SDK 默认方式）。 */
function anthropicAuthHeaders(gateway: AliasGateway, extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-api-key': gateway.virtualKey, 'content-type': 'application/json', ...extra };
}

/** 默认 Anthropic 渠道输入：protocol=anthropic；baseUrl 用域名 + mock 实端口（与 channelInput 同手法）。 */
function anthropicInput(overrides: Record<string, unknown> = {}, mockPort = 65530): Record<string, unknown> {
  return {
    label: 'Anthropic 渠道',
    baseUrl: `http://upstream.test:${mockPort}/v1`,
    apiKey: MOCK_ECHO_AUTH,
    models: ['claude-alias'],
    protocol: 'anthropic',
    ...overrides,
  };
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

// ===== ②b 私网上游 opt-in（allowPrivateUpstream；默认安全姿态不动） =====

/** opt-in 用例的渠道输入：单别名 + 空 modelMap，与 channelInput 默认别名解耦（别名唯一约束）。 */
function optInInput(baseUrl: string, alias: string, allowPrivateUpstream?: unknown): Record<string, unknown> {
  return { label: 'opt-in 渠道', baseUrl, apiKey: MOCK_ECHO_AUTH, models: [alias], modelMap: {}, allowPrivateUpstream };
}

test('ssrf：isAllowedPrivateIpv4 仅认回环+RFC1918；validateUpstreamBaseUrl 默认拒私网、opt-in 放行字面量', () => {
  for (const ip of ['127.0.0.1', '10.255.1.2', '172.31.255.254', '192.168.255.254']) {
    assert.equal(isAllowedPrivateIpv4(ip), true, `${ip} 应在 opt-in 白名单内`);
  }
  for (const ip of ['172.32.0.1', '11.0.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '8.8.8.8', 'not-ip']) {
    assert.equal(isAllowedPrivateIpv4(ip), false, `${ip} 不应在 opt-in 白名单内`);
  }
  // 默认拒绝：文案含收到值、SSRF 与示例（既有安全姿态不放松）
  const rejected = validateUpstreamBaseUrl('http://127.0.0.1:8622/v1');
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /SSRF/);
  assert.match(rejected.message, /示例/);
  assert.match(rejected.message, /127\.0\.0\.1/);
  // opt-in 放行回环字面量；公网字面量两种模式都放行（放行方向不误伤）
  assert.equal(validateUpstreamBaseUrl('http://127.0.0.1:8622/v1', { allowPrivate: true }).ok, true);
  assert.equal(validateUpstreamBaseUrl(`https://${PUBLIC_IP}/v1`, { allowPrivate: true }).ok, true);
  // opt-in 也拒白名单外的非公网字面量（云元数据；文案含收到值+示例）
  const metadata = validateUpstreamBaseUrl('http://169.254.169.254/v1', { allowPrivate: true });
  assert.equal(metadata.ok, false);
  assert.match(metadata.message, /169\.254\.169\.254/);
  assert.match(metadata.message, /示例/);
});

test('ssrf：域名解析到私网时 allowPrivate=true 仍拒（防用域名绕过）；字面量按 opt-in 判定', async () => {
  const rebound = await resolvePinnedUpstream({
    hostname: 'rebind.test',
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    allowPrivate: true,
  });
  assert.equal(rebound.ok, false);
  assert.match(rebound.message, /非公网|rebinding/);
  assert.match(rebound.message, /字面量 IP/);
  const loopLiteral = await resolvePinnedUpstream({ hostname: '127.0.0.1', lookup: async () => [], allowPrivate: true });
  assert.equal(loopLiteral.ok, true);
  assert.equal(loopLiteral.ip, '127.0.0.1');
  const publicLiteral = await resolvePinnedUpstream({ hostname: PUBLIC_IP, lookup: async () => [], allowPrivate: true });
  assert.equal(publicLiteral.ok, true);
  assert.equal(publicLiteral.ip, PUBLIC_IP);
  for (const host of ['169.254.169.254', '100.64.0.1', '0.0.0.0']) {
    const bad = await resolvePinnedUpstream({ hostname: host, lookup: async () => [], allowPrivate: true });
    assert.equal(bad.ok, false, `${host} 不应被 opt-in 放行`);
  }
  const v6 = await resolvePinnedUpstream({ hostname: '[::1]', lookup: async () => [], allowPrivate: true });
  assert.equal(v6.ok, false);
});

test('channels：allowPrivateUpstream 严格布尔（字符串/数字 400 带收到值+示例）；update 缺省保留、显式 false 收紧；view 回显布尔不含 key', () => {
  const store = new ChannelStore();
  for (const raw of ['true', 1]) {
    assert.throws(
      () => store.create(optInInput('https://relay.example.com/v1', 'alias-bool', raw) as never),
      (error: unknown) => {
        assert.ok(error instanceof ChannelError);
        assert.equal((error as ChannelError).status, 400);
        assert.match((error as ChannelError).message, /allowPrivateUpstream 必须为布尔值/);
        assert.match((error as ChannelError).message, /收到值/);
        assert.match((error as ChannelError).message, /示例/);
        return true;
      },
      JSON.stringify(raw),
    );
  }
  const created = store.create(optInInput('http://127.0.0.1:8622/v1', 'alias-toggle', true) as never);
  assert.equal(created.allowPrivateUpstream, true);
  const kept = store.update(created.id, { label: '仅改名' });
  assert.equal(kept.allowPrivateUpstream, true, '未给字段必须保留原值');
  const tightened = store.update(created.id, { allowPrivateUpstream: false });
  assert.equal(tightened.allowPrivateUpstream, false, '显式 false 必须收紧');
  // 收紧后再改 baseUrl 回到私网字面量应 400（update 按当前 opt-in 状态校验）
  assert.throws(() => store.update(created.id, { baseUrl: 'http://10.9.9.9/v1' }), /SSRF/);
  const view = store.view(tightened);
  assert.equal(view.allowPrivateUpstream, false);
  assert.equal('apiKey' in view, false);
  assert.ok(!JSON.stringify(view).includes(MOCK_ECHO_AUTH), 'view 不得含 apiKey 明文');
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

test('数据面：allowPrivate 渠道可指向 127.0.0.1 字面量并用渠道 key 转发；默认渠道同址域名解析回环 → 502', { timeout: 20000 }, async () => {
  const stack = await startGatewayStack();
  const { gateway, mock } = stack;
  CLEANUPS.push(() => stack.cleanup());
  // 默认渠道（缺省 allowPrivate=false）：域名被解析到回环 → 每请求重校验拒绝，502 upstream_blocked
  gateway.store.create(optInInput(`http://upstream.test:${mock.port}/v1`, 'alias-plain') as never);
  stack.setDns([{ address: '127.0.0.1', family: 4 }]);
  const blocked = await request(gateway.port, '/v1/chat/completions', {
    method: 'POST',
    headers: authHeaders(gateway),
    body: JSON.stringify({ model: 'alias-plain', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(blocked.status, 502);
  assert.match(JSON.parse(blocked.body).error.code, /upstream_blocked/);
  assert.equal(mock.state.lastPath, null, '被拒请求不得实际触达 mock 上游');
  // opt-in 渠道：字面量回环 baseUrl（mock 实端口），data plane 正常转发且注入的是渠道 key（非客户端 key）
  const local = gateway.store.create(optInInput(`http://127.0.0.1:${mock.port}/v1`, 'alias-local', true) as never);
  assert.equal(local.allowPrivateUpstream, true);
  const forwarded = await request(gateway.port, '/v1/chat/completions', {
    method: 'POST',
    headers: authHeaders(gateway),
    body: JSON.stringify({ model: 'alias-local', messages: [{ role: 'user', content: '你好' }] }),
  });
  assert.equal(forwarded.status, 200);
  assert.equal(mock.state.lastPath, '/v1/chat/completions');
  assert.equal(mock.state.lastAuth, `Bearer ${MOCK_ECHO_AUTH}`);
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

test('数据面：客户端中途断开 → 计一次请求但绝不计为成功，也绝不让渠道背锅（error_source=client 不计错误/告警）', async () => {
  const stack = await startGatewayStack({ upstreamTimeoutMs: 30000 });
  const { gateway, mock } = stack;
  CLEANUPS.push(() => stack.cleanup());
  const channel = gateway.store.create(channelInput({}, stack.mock.port) as never);
  mock.setResponder(() => null); // 上游收下请求后挂起，客户端先断开
  // 连续 5 次客户端断开：窗口达到 error_rate 的 n>=5 阈值，但 0 条渠道错误 → 绝不触发告警。
  for (let i = 1; i <= 5; i += 1) {
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
    while (gateway.store.view(channel).stats.requests < i && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 30));
    }
  }
  const stats = gateway.store.view(channel).stats;
  assert.equal(stats.requests, 5);
  assert.equal(stats.ok, 0, '客户端中断的请求不得计入 ok（未知结果绝不记成功）');
  assert.equal(stats.errors, 0, '客户端主动断开与账本 error_source=client 同口径：渠道无责，不计错误/不更新 lastErrorAt');
  assert.equal(stats.lastStatus, null, 'status=null 不借旧值冒充 lastStatus');
  assert.equal(gateway.events().filter((event) => event.kind === 'error_rate').length, 0, '客户端断开不得推高渠道 error_rate 告警');
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
  createConsoleServer(options: { port: number; repoRoot: string; gatewayEnabled?: boolean }): Promise<{
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

test('管理面：API 聚合默认停用（后需迭代上线）——携合法 token 亦回 503，token 校验仍先于停用判定', async () => {
  const server = await serveModule.createConsoleServer({ port: 0, repoRoot: REPO_ROOT });
  CLEANUPS.push(async () => {
    await server.close().catch(() => undefined);
  });
  const disabled = await request(server.port, '/api/gateway/status', { headers: manageHeaders(server.token) });
  assert.equal(disabled.status, 503);
  assert.match(disabled.body, /后需迭代上线/);
  const disabledStart = await request(server.port, '/api/gateway/start', {
    method: 'POST',
    headers: manageHeaders(server.token),
    body: '{}',
  });
  assert.equal(disabledStart.status, 503, 'POST 端点同样停用，不得绕过开关启动网关');
});

test('管理面：start（随机回环端口）→ running；重复 start → 409；渠道 CRUD/删除/停用语义成立', { timeout: 20000 }, async () => {
  const server = await serveModule.createConsoleServer({ port: 0, repoRoot: REPO_ROOT, gatewayEnabled: true });
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

test('管理面：未运行时渠道端点仍可用（持久 store 预配置），虚拟 key 端点 400 引导启动（非 500 崩溃）', async () => {
  const server = await serveModule.createConsoleServer({ port: 0, repoRoot: REPO_ROOT, gatewayEnabled: true });
  CLEANUPS.push(async () => {
    await server.close().catch(() => undefined);
  });
  const token = server.token;
  const channels = await request(server.port, '/api/gateway/channels', {
    method: 'POST',
    headers: manageHeaders(token),
    body: JSON.stringify({ baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-x', models: ['alias-a'] }),
  });
  assert.equal(channels.status, 200, '渠道挂在控制台持久 store：网关未启动也应能预配置/列出');
  assert.ok(!channels.body.includes('sk-x'), '渠道视图不得回显上游 key');
  assert.equal(JSON.parse(channels.body).channel.models[0], 'alias-a');
  const virtualKey = await request(server.port, '/api/gateway/virtual-key', { headers: manageHeaders(token) });
  assert.equal(virtualKey.status, 400, '虚拟 key 随网关启动生成：未运行时 400 引导而非 500 崩溃');
});

test('管理面：启动前预配置渠道 → 启动后数据面 /v1/models 即可见（store 注入回归），停止再启动仍保留', { timeout: 20000 }, async () => {
  const server = await serveModule.createConsoleServer({ port: 0, repoRoot: REPO_ROOT, gatewayEnabled: true });
  CLEANUPS.push(async () => {
    await server.close().catch(() => undefined);
  });
  const token = server.token;
  const header = manageHeaders(token);
  const created = await request(server.port, '/api/gateway/channels', {
    method: 'POST',
    headers: header,
    body: JSON.stringify({ label: '预配置', baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-pre-1111', models: ['alias-pre'] }),
  });
  assert.equal(created.status, 200, `启动前创建渠道应 200：${created.body}`);
  const started = JSON.parse(
    (await request(server.port, '/api/gateway/start', { method: 'POST', headers: header, body: '{}' })).body,
  ) as { port: number; virtualKey: string };
  const first = await request(started.port, '/v1/models', { headers: { authorization: `Bearer ${started.virtualKey}` } });
  assert.equal(first.status, 200);
  const firstIds = (JSON.parse(first.body) as { data: Array<{ id: string }> }).data.map((item) => item.id);
  assert.ok(firstIds.includes('alias-pre'), `启动前配置的别名必须对数据面可见（持久 store 注入回归）：${first.body}`);
  // 停止 → 启动前配置的渠道保留 → 再启动（新虚拟 key）仍可见
  await request(server.port, '/api/gateway/stop', { method: 'POST', headers: header, body: '{}' });
  const restarted = JSON.parse(
    (await request(server.port, '/api/gateway/start', { method: 'POST', headers: header, body: '{}' })).body,
  ) as { port: number; virtualKey: string };
  const second = await request(restarted.port, '/v1/models', { headers: { authorization: `Bearer ${restarted.virtualKey}` } });
  assert.equal(second.status, 200);
  const secondIds = (JSON.parse(second.body) as { data: Array<{ id: string }> }).data.map((item) => item.id);
  assert.ok(secondIds.includes('alias-pre'), '渠道必须跨网关启停保留（持久 store）');
});

test('管理面：并发 start 只允许一个成功（另一个 409，不泄漏第二个监听实例）', { timeout: 20000 }, async () => {
  const server = await serveModule.createConsoleServer({ port: 0, repoRoot: REPO_ROOT, gatewayEnabled: true });
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
  const server = await serveModule.createConsoleServer({ port: 0, repoRoot: REPO_ROOT, gatewayEnabled: true });
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
  const server = await serveModule.createConsoleServer({ port: 0, repoRoot: tempRoot, gatewayEnabled: true });
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
  const clientTtftMs = row['ttft_client_ms'];
  assert.ok(typeof clientTtftMs === 'number' && Number.isFinite(clientTtftMs) && clientTtftMs > 0, `client_ttft 应为非 NULL 独立样本（收到 ${String(clientTtftMs)}）`);
  // tz 口径：requests+settlements 的 ts_ms 必须是落库时刻 ±1s 内的 epoch 毫秒
  for (const entry of [req, row]) {
    const tsMs = Number(entry['ts_ms']);
    assert.ok(Number.isInteger(tsMs) && tsMs > Date.now() - 60_000 && tsMs <= Date.now() + 1000, `ts_ms 应为 epoch 毫秒（收到 ${String(tsMs)}）`);
  }
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

// ===== TTFT 告警（ttft_high）与双口径 client_ttft =====

/** 延迟回发的带 usage SSE：上游 TTFT ≈ delayMs（写头与整段 body 均延后）。 */
function delayedTtftSse(delayMs: number): { status: number; sse: string; delayMs: number } {
  return { ...ttftSseResponder(), delayMs };
}

test('TTFT 告警⑭：默认阈值边界——19 样本不报；第 20 样本恰 1 条 ttft_high（observed=p95≥300）；冷却抑制只见计数；client_ttft 独立口径落库', { timeout: 25000 }, async () => {
  const fixture = makeLedgerFixture();
  const stack = await startGatewayStack({ ledger: fixture.ledger, alertSilenceMs: 0 });
  const { gateway, mock } = stack;
  CLEANUPS.push(() => stack.cleanup());
  CLEANUPS.push(async () => fixture.cleanup());
  gateway.store.create(channelInput({}, stack.mock.port) as never);
  mock.setResponder(() => delayedTtftSse(320));
  await sendStreamChat(gateway, 19);
  await waitFor(() => fixture.settlementRows().length === 19);
  assert.equal(gateway.events().filter((alert) => alert.kind === 'ttft_high').length, 0, 'n<20 绝不告警（低样本抖动防误报）');
  await sendStreamChat(gateway, 1);
  await waitFor(() => fixture.settlementRows().length === 20);
  const alerts = gateway.events();
  assert.equal(alerts.length, 1, '第 20 个未污染样本恰触发一条 ttft_high');
  assert.equal(alerts[0]!.kind, 'ttft_high');
  assert.equal(alerts[0]!.n, 20);
  assert.ok(alerts[0]!.observed >= 300, `observed 应为 p95≥300ms（收到 ${String(alerts[0]!.observed)}）`);
  assert.equal(alerts[0]!.evidence_request_ids.length, 10, '证据 id 应为窗口内最近 10 条请求');
  for (const id of alerts[0]!.evidence_request_ids) assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(gateway.status().alertSuppressed, 0, '告警首次触发不得算作被抑制');
  assert.equal(gateway.status().alertSilenceWasActive, false, 'silence=0 时不得谎称静默期生效');
  // 冷却抑制披露：窗口继续累积高样本 → 规则再触发只计数，不生成第二条事件
  await sendStreamChat(gateway, 3);
  await waitFor(() => fixture.settlementRows().length === 23);
  assert.equal(gateway.events().length, 1, '冷却期内不重复生成 ttft_high 事件');
  assert.ok(gateway.status().alertSuppressed >= 1, '冷却抑制必须计数披露（持续故障不得被一条旧告警掩盖）');
  // 双口径：client_ttft 是「进网关→响应首字节（含状态行）」，upstream_ttft 是「发出上游请求→首个内容帧」；
  // 状态行可能先于上游内容帧到达，故两者不保证大小顺序，只校验都反映同一段 ≥300ms 延迟。
  for (const row of fixture.settlementRows()) {
    const client = row['ttft_client_ms'];
    const upstream = row['ttft_upstream_ms'];
    assert.ok(typeof client === 'number' && Number.isFinite(client) && client >= 300, `client_ttft 必须落库且反映延迟（收到 ${String(client)}）`);
    assert.ok(typeof upstream === 'number' && upstream >= 300, `upstream_ttft 应为延迟回发的 ≥300ms 样本（收到 ${String(upstream)}）`);
  }
});

test('TTFT 告警⑮：样本充足（n=20）但 p95<300ms → 不告警（绝对下限防小幅波动）', { timeout: 15000 }, async () => {
  const stack = await startGatewayStack({ alertSilenceMs: 0 });
  const { gateway, mock } = stack;
  CLEANUPS.push(() => stack.cleanup());
  gateway.store.create(channelInput({}, stack.mock.port) as never);
  mock.setResponder(() => ttftSseResponder());
  await sendStreamChat(gateway, 20);
  await waitFor(() => (gateway.usageSummary()[0]?.requests ?? 0) === 20);
  assert.equal(gateway.events().filter((alert) => alert.kind === 'ttft_high').length, 0, 'p95 低于绝对下限不得诬告渠道');
});

test('TTFT 双口径⑯：上游 500 错误体转发 → ttft_upstream 为 NULL（无 SSE 帧）而 ttft_client_ms 独立落库（client 口径不以 upstream 为 gate）', { timeout: 15000 }, async () => {
  const fixture = makeLedgerFixture();
  const stack = await startGatewayStack({ ledger: fixture.ledger, alertSilenceMs: 0 });
  const { gateway, mock } = stack;
  CLEANUPS.push(() => stack.cleanup());
  CLEANUPS.push(async () => fixture.cleanup());
  gateway.store.create(channelInput({}, stack.mock.port) as never);
  mock.setResponder(() => ({ status: 500, payload: { error: { code: 'boom' } } }));
  const res = await request(gateway.port, '/v1/chat/completions', {
    method: 'POST',
    headers: authHeaders(gateway),
    body: JSON.stringify({ model: 'alias-a', messages: [] }),
  });
  assert.equal(res.status, 500);
  await waitFor(() => fixture.settlementRows().length === 1);
  const row = fixture.settlementRows()[0]!;
  assert.equal(row['upstream_status'], 500);
  assert.equal(row['client_status'], 'ok', '上游错误体完整转发给客户端（client 侧送达语义不变）');
  assert.equal(row['error_source'], 'upstream');
  assert.equal(row['ttft_upstream_ms'], null, '非流式无内容帧 → upstream 口径为 NULL（绝不写 0 冒充）');
  const client = row['ttft_client_ms'];
  assert.ok(typeof client === 'number' && Number.isFinite(client) && client > 0, `错误体转发产生了首字节写出 → client_ttft 必须独立落库（收到 ${String(client)}）`);
});

test('计数口径⑰：/v1/models 只进网关内存计数（不入账本）；401 拒绝不计入 total', { timeout: 15000 }, async () => {
  const fixture = makeLedgerFixture();
  const stack = await startGatewayStack({ ledger: fixture.ledger, alertSilenceMs: 0 });
  const { gateway, mock } = stack;
  CLEANUPS.push(() => stack.cleanup());
  CLEANUPS.push(async () => fixture.cleanup());
  gateway.store.create(channelInput({}, stack.mock.port) as never);
  assert.equal(gateway.status().requests.total, 0);
  const anon = await request(gateway.port, '/v1/models', { headers: { authorization: 'Bearer sk-wrong' } });
  assert.equal(anon.status, 401);
  assert.equal(gateway.status().requests.total, 0, '鉴权拒绝发生在路由计数之前，不计入 total');
  await request(gateway.port, '/v1/models', { headers: authHeaders(gateway) });
  await request(gateway.port, '/v1/models', { headers: authHeaders(gateway) });
  const status = gateway.status();
  assert.equal(status.requests.total, 2);
  assert.equal(status.requests.ok, 2);
  assert.equal(status.requests.error, 0);
  assert.equal(fixture.requestRows().length, 0, '/v1/models 不写账本（仅网关计数口径）');
});

test('告警⑱：启动静默期——期间不评估不生成事件（更不得计入 alertSuppressed 冒充冷却抑制）；粘性披露 alertSilenceWasActive', { timeout: 15000 }, async () => {
  const stack = await startGatewayStack({ alertSilenceMs: 1500 });
  const { gateway, mock } = stack;
  CLEANUPS.push(() => stack.cleanup());
  gateway.store.create(channelInput({ models: ['alias-a'] }, stack.mock.port) as never);
  mock.setResponder(() => ({
    status: 200,
    sse: sseBody([{ model: 'other-model', choices: [{ index: 0, delta: { content: 'a' }, finish_reason: null }] }]),
  }));
  const before = gateway.status();
  assert.ok(before.alertSilenceRemainingMs > 0, '启动静默期必须披露剩余毫秒');
  assert.equal(before.alertSilenceWasActive, true, '静默期生效中 → wasActive 如实为 true');
  const sendChat = async () => {
    const res = await request(gateway.port, '/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders(gateway),
      body: JSON.stringify({ model: 'alias-a', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
  };
  await sendChat();
  await sendChat();
  const settled = () => gateway.usageSummary()[0]?.requests ?? 0;
  await waitFor(() => settled() === 2);
  assert.equal(gateway.events().length, 0, '静默期内不评估告警（防重启告警风暴）');
  const during = gateway.status();
  assert.equal(during.alertSilenceWasActive, true, '静默期一旦生效必须粘性披露（期间告警从未被评估）');
  assert.equal(during.alertSuppressed, 0, '静默期早退不许计入 alertSuppressed 冒充「抑制了 N 条告警」');
  // 粘性：静默期过期后 remaining 归零，但 wasActive 必须保持 true（防「检查过没问题」的假安心）
  await new Promise((resolveWait) => setTimeout(resolveWait, 1600));
  const after = gateway.status();
  assert.equal(after.alertSilenceRemainingMs, 0);
  assert.equal(after.alertSilenceWasActive, true, '剩余毫秒归零后 wasActive 必须保持 true（粘性披露）');
});

test('noteChannelResult：error_source=client 不计渠道错误（客户端断开绝不冤枉渠道）', () => {
  const store = new ChannelStore();
  const channel = store.create(channelInput() as never);
  noteChannelResult(channel, null, 'client');
  assert.equal(channel.stats.errors, 0, '客户端断开不计错误');
  assert.equal(channel.stats.lastErrorAt, null);
  assert.equal(channel.stats.lastStatus, null, 'status=null 不落 lastStatus');
  noteChannelResult(channel, null, 'upstream');
  assert.equal(channel.stats.errors, 1, '上游故障照常计错误');
  assert.ok((channel.stats.lastErrorAt ?? 0) > 0);
});

// ===== ⑥ Anthropic Messages 协议（数据面） =====

test('渠道：protocol 校验（缺省 unified；非法值 400 带收到值与示例；更新可切换协议）', () => {
  const store = new ChannelStore();
  const opened = store.create(channelInput() as never);
  assert.equal(store.view(opened).protocol, 'unified', '缺省协议为 unified（统一中转）');
  const anthropic = store.create(channelInput({ protocol: 'anthropic', models: ['claude-alias'], modelMap: {} }) as never);
  assert.equal(store.view(anthropic).protocol, 'anthropic');
  const unified = store.create(channelInput({ protocol: 'unified', models: ['u-alias'], modelMap: {} }) as never);
  assert.equal(store.view(unified).protocol, 'unified');
  assert.throws(
    () => store.create(channelInput({ protocol: 'gemini', models: ['x-alias'], modelMap: {} }) as never),
    (error: unknown) =>
      error instanceof ChannelError &&
      /收到值/.test((error as Error).message) &&
      /示例/.test((error as Error).message) &&
      /unified/.test((error as Error).message) &&
      /统一/.test((error as Error).message),
  );
  assert.equal(store.update(anthropic.id, { protocol: 'openai' } as never).protocol, 'openai', '更新可切换协议');
  assert.equal(store.update(opened.id, { label: '改标签' } as never).protocol, 'unified', '未传 protocol 时保持现值');
});

test('Anthropic①：POST /v1/messages SSE 端到端（x-api-key 注入上游、anthropic-version/beta 透传、账本 stop_reason 与 token 四字段）', { timeout: 15000 }, async () => {
  const fixture = makeLedgerFixture();
  const logs: string[] = [];
  const stack = await startGatewayStack({ ledger: fixture.ledger, onLog: (line) => logs.push(line) });
  const { gateway, mock } = stack;
  CLEANUPS.push(() => stack.cleanup());
  CLEANUPS.push(async () => fixture.cleanup());
  gateway.store.create(
    channelInput({ protocol: 'anthropic', models: ['claude-alias'], apiKey: CANARY_KEY, modelMap: { 'claude-alias': 'claude-upstream-1' } }, stack.mock.port) as never,
  );
  mock.setResponder(() => ({
    status: 200,
    sse: anthropicSseBody([
      { type: 'message_start', message: { id: 'msg_1', model: 'claude-upstream-1', usage: { input_tokens: 25, output_tokens: 5, cache_read_input_tokens: 5 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '思考' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { output_tokens: 30 } },
      { type: 'message_stop' },
    ]),
  }));
  const res = await request(gateway.port, '/v1/messages', {
    method: 'POST',
    headers: anthropicAuthHeaders(gateway, { 'anthropic-version': '2024-06-01', 'anthropic-beta': 'prompt-caching-2024-07-31' }),
    body: JSON.stringify({ model: 'claude-alias', max_tokens: 1024, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 200);
  assert.match(String(res.headers['content-type']), /text\/event-stream/);
  assert.match(res.body, /message_start/);
  // 上游收到的关键事实：路径、model 改写、x-api-key 注入、版本头透传、Authorization 不落地
  assert.equal(mock.state.lastPath, '/v1/messages');
  assert.equal(mock.state.lastModel, 'claude-upstream-1');
  assert.equal(mock.state.lastXApiKey, CANARY_KEY);
  assert.equal(mock.state.lastAnthropicVersion, '2024-06-01');
  assert.equal(mock.state.lastAnthropicBeta, 'prompt-caching-2024-07-31');
  assert.equal(mock.state.lastAuth, null, 'Anthropic 上游不得收到 Authorization 头');
  await waitFor(() => fixture.settlementRows().length === 1);
  const row = fixture.settlementRows()[0]!;
  assert.equal(row['client_status'], 'ok');
  assert.equal(row['error_source'], null);
  assert.equal(row['finish_reason'], 'length', 'max_tokens 映射为 length（与连接截断语义无关）');
  assert.equal(row['token_prompt'], 25);
  assert.equal(row['token_completion'], 30, 'message_delta 累计 output 覆盖 message_start 的初值');
  assert.equal(row['token_cached'], 5);
  assert.equal(row['token_reasoning'], 0);
  assert.equal(row['token_source'], 'usage');
  assert.equal(row['usage_valid'], 1);
  assert.ok(row['ttft_upstream_ms'] !== null, '首个 text_delta 到达应有 TTFT 样本');
  assert.equal(fixture.dump().includes(CANARY_KEY), false, '渠道 apiKey 绝不出现在账本');
  assert.equal(logs.some((line) => line.includes(CANARY_KEY)), false, '渠道 apiKey 绝不出现在网关日志');
});

test('Anthropic②：鉴权（x-api-key 或 Bearer 均可；错误 key 401 且带两种携带引导；OpenAI 路由（chat/responses）仍只认 Bearer）', { timeout: 15000 }, async () => {
  const stack = await startGatewayStack();
  const { gateway, mock } = stack;
  CLEANUPS.push(() => stack.cleanup());
  gateway.store.create(anthropicInput({}, stack.mock.port) as never);
  mock.setResponder(() => ({ status: 200, payload: { ok: true } }));
  const body = JSON.stringify({ model: 'claude-alias', max_tokens: 16, messages: [] });
  const byKey = await request(gateway.port, '/v1/messages', { method: 'POST', headers: { 'x-api-key': gateway.virtualKey, 'content-type': 'application/json' }, body });
  assert.equal(byKey.status, 200, 'x-api-key 命中虚拟 key 放行');
  const byBearer = await request(gateway.port, '/v1/messages', {
    method: 'POST',
    headers: { authorization: `Bearer ${gateway.virtualKey}`, 'content-type': 'application/json' },
    body,
  });
  assert.equal(byBearer.status, 200, 'Bearer 亦接受');
  const wrong = await request(gateway.port, '/v1/messages', { method: 'POST', headers: { 'x-api-key': 'sk-wrong-key', 'content-type': 'application/json' }, body });
  assert.equal(wrong.status, 401);
  assert.match(wrong.body, /x-api-key/, '401 文案给两种携带方式引导');
  assert.match(wrong.body, /Bearer/);
  const openaiRoute = await request(gateway.port, '/v1/chat/completions', {
    method: 'POST',
    headers: { 'x-api-key': gateway.virtualKey, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-alias', messages: [] }),
  });
  assert.equal(openaiRoute.status, 401, 'OpenAI 路由不接受 x-api-key（仍只认 Authorization: Bearer）');
  const responsesByKeyOnly = await request(gateway.port, '/v1/responses', {
    method: 'POST',
    headers: { 'x-api-key': gateway.virtualKey, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-alias', input: 'hi' }),
  });
  assert.equal(responsesByKeyOnly.status, 401, '/v1/responses 同为 OpenAI 系路由，只认 Bearer');
});

test('Anthropic③：协议门禁 409 双向（别名跨协议调用必须显式改路由；绝不打上游）', { timeout: 15000 }, async () => {
  const stack = await startGatewayStack();
  const { gateway, mock } = stack;
  CLEANUPS.push(() => stack.cleanup());
  gateway.store.create(channelInput({ protocol: 'openai', models: ['alias-a'] }, stack.mock.port) as never); // 显式 openai 协议（缺省已为 unified）
  gateway.store.create(anthropicInput({}, stack.mock.port) as never); // Anthropic 协议
  mock.setResponder(() => ({ status: 200, payload: { unreachable: true } }));
  const chatToAnthropic = await request(gateway.port, '/v1/chat/completions', {
    method: 'POST',
    headers: authHeaders(gateway),
    body: JSON.stringify({ model: 'claude-alias', messages: [] }),
  });
  assert.equal(chatToAnthropic.status, 409);
  assert.match(chatToAnthropic.body, /protocol_mismatch/);
  assert.match(chatToAnthropic.body, /\/v1\/messages/, 'OpenAI 路由命中 Anthropic 渠道 → 引导改到 /v1/messages');
  assert.match(chatToAnthropic.body, /统一/, '409 文案引导 unified 统一中转');
  assert.equal(JSON.parse(chatToAnthropic.body).error.type, 'invalid_request_error', '409 归 invalid_request_error');
  const messagesToOpenai = await request(gateway.port, '/v1/messages', {
    method: 'POST',
    headers: anthropicAuthHeaders(gateway),
    body: JSON.stringify({ model: 'alias-a', max_tokens: 16, messages: [] }),
  });
  assert.equal(messagesToOpenai.status, 409);
  assert.match(messagesToOpenai.body, /\/v1\/chat\/completions/, 'Anthropic 路由命中 OpenAI 渠道 → 引导改到 /v1/chat/completions');
  const responsesToAnthropic = await request(gateway.port, '/v1/responses', {
    method: 'POST',
    headers: authHeaders(gateway),
    body: JSON.stringify({ model: 'claude-alias', input: 'hi' }),
  });
  assert.equal(responsesToAnthropic.status, 409);
  assert.match(responsesToAnthropic.body, /protocol_mismatch/);
  assert.match(responsesToAnthropic.body, /\/v1\/messages/, 'Responses 路由命中 Anthropic 渠道 → 引导改到 /v1/messages');
  assert.match(responsesToAnthropic.body, /统一/);
  assert.equal(mock.state.lastPath, null, '协议不匹配绝不触达上游');
});

test('Anthropic④：count_tokens 轻路径（真实转发到 /messages/count_tokens；零账本、不进用量窗口、计网关 counters）', { timeout: 15000 }, async () => {
  const fixture = makeLedgerFixture();
  const stack = await startGatewayStack({ ledger: fixture.ledger });
  const { gateway, mock } = stack;
  CLEANUPS.push(() => stack.cleanup());
  CLEANUPS.push(async () => fixture.cleanup());
  gateway.store.create(channelInput({ protocol: 'anthropic', models: ['claude-alias'], modelMap: { 'claude-alias': 'claude-upstream-1' } }, stack.mock.port) as never);
  mock.setResponder(() => ({ status: 200, payload: { input_tokens: 42 } }));
  const before = gateway.status().requests.total;
  const res = await request(gateway.port, '/v1/messages/count_tokens', {
    method: 'POST',
    headers: anthropicAuthHeaders(gateway),
    body: JSON.stringify({ model: 'claude-alias', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 200, 'count_tokens 不要求 max_tokens');
  assert.deepEqual(JSON.parse(res.body), { input_tokens: 42 });
  assert.equal(mock.state.lastPath, '/v1/messages/count_tokens', '真实转发到 count_tokens 端点');
  assert.equal(mock.state.lastModel, 'claude-upstream-1');
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  assert.equal(fixture.requestRows().length, 0, 'count_tokens 零账本（防「有请求无 token」假缺失）');
  assert.equal(fixture.settlementRows().length, 0);
  assert.equal(gateway.usageSummary().length, 0, 'count_tokens 不进用量/告警窗口');
  assert.equal(gateway.status().requests.total, before + 1, '网关 counters 照常计数');
});

test('Anthropic⑤：非流式 JSON 落账（stop_reason/usage/content 与流式同口径提取）', { timeout: 15000 }, async () => {
  const fixture = makeLedgerFixture();
  const stack = await startGatewayStack({ ledger: fixture.ledger, alertSilenceMs: 0 });
  const { gateway, mock } = stack;
  CLEANUPS.push(() => stack.cleanup());
  CLEANUPS.push(async () => fixture.cleanup());
  gateway.store.create(anthropicInput({}, stack.mock.port) as never);
  mock.setResponder(() => ({
    status: 200,
    payload: {
      id: 'msg_2',
      type: 'message',
      role: 'assistant',
      model: 'claude-upstream-x',
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 2 },
    },
  }));
  const res = await request(gateway.port, '/v1/messages', {
    method: 'POST',
    headers: anthropicAuthHeaders(gateway),
    body: JSON.stringify({ model: 'claude-alias', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 200);
  await waitFor(() => fixture.settlementRows().length === 1);
  const row = fixture.settlementRows()[0]!;
  assert.equal(row['client_status'], 'ok');
  assert.equal(row['finish_reason'], 'stop', 'end_turn 映射为 stop');
  assert.equal(row['token_prompt'], 12);
  assert.equal(row['token_completion'], 3);
  assert.equal(row['token_cached'], 2);
  assert.equal(row['token_reasoning'], 0);
  assert.equal(row['usage_valid'], 1);
  assert.ok(row['ttft_upstream_ms'] !== null, '非流式整包到达也算首内容');
});

test('Anthropic⑥：/v1/messages 体校验（缺 max_tokens / 缺 model → 400 带示例；未知别名 404）', { timeout: 15000 }, async () => {
  const stack = await startGatewayStack();
  const { gateway, mock } = stack;
  CLEANUPS.push(() => stack.cleanup());
  gateway.store.create(anthropicInput({}, stack.mock.port) as never);
  mock.setResponder(() => ({ status: 200, payload: { ok: true } }));
  const headers = anthropicAuthHeaders(gateway);
  const noMax = await request(gateway.port, '/v1/messages', { method: 'POST', headers, body: JSON.stringify({ model: 'claude-alias', messages: [] }) });
  assert.equal(noMax.status, 400);
  assert.match(noMax.body, /max_tokens/);
  assert.match(noMax.body, /收到值/);
  assert.match(noMax.body, /示例/);
  const badMax = await request(gateway.port, '/v1/messages', { method: 'POST', headers, body: JSON.stringify({ model: 'claude-alias', max_tokens: 0, messages: [] }) });
  assert.equal(badMax.status, 400);
  const noModel = await request(gateway.port, '/v1/messages', { method: 'POST', headers, body: JSON.stringify({ max_tokens: 16, messages: [] }) });
  assert.equal(noModel.status, 400);
  assert.match(noModel.body, /示例/);
  const unknown = await request(gateway.port, '/v1/messages', { method: 'POST', headers, body: JSON.stringify({ model: 'nope-alias', max_tokens: 16, messages: [] }) });
  assert.equal(unknown.status, 404);
  assert.match(unknown.body, /未知 model 别名/);
  assert.equal(mock.state.lastPath, null, '校验失败绝不打上游');
});

test('渠道：modelPrices 校验与往返（键∈models/成对/白名单/阶梯三元组/负值 400；未传保持、显式 {} 清空、models 变更重校验）', () => {
  const store = new ChannelStore();
  const created = store.create(
    channelInput({
      modelPrices: {
        'alias-a': { input: 2.5, output: 10, cachedRead: 0.5 },
        'alias-b': { input: 1, output: 2, threshold: 1000000, input2: 3, output2: 4, cachedRead2: 0.25 },
      },
    }) as never,
  );
  assert.deepEqual(store.view(created).modelPrices, {
    'alias-a': { input: 2.5, output: 10, cachedRead: 0.5 },
    'alias-b': { input: 1, output: 2, threshold: 1000000, input2: 3, output2: 4, cachedRead2: 0.25 },
  });
  assert.deepEqual(
    store.view(store.create(channelInput({ models: ['m-only'], modelMap: {} }) as never)).modelPrices,
    {},
    '未录价 = 空对象（而非 null）',
  );
  const reject = (modelPrices: unknown, pattern: RegExp) => {
    assert.throws(
      () => store.create(channelInput({ models: ['m1'], modelMap: {}, modelPrices }) as never),
      (error: unknown) =>
        error instanceof ChannelError && pattern.test((error as Error).message) && /收到值|收到键/.test((error as Error).message) && /示例/.test((error as Error).message),
    );
  };
  reject({ ghost: { input: 1, output: 1 } }, /不在本渠道 models/);
  reject({ m1: { input: 1 } }, /成对/);
  reject({ m1: { input: 1, output: 1, unknownKey: 2 } }, /未知字段/);
  reject({ m1: { input: -1, output: 1 } }, /不小于 0/);
  reject({ m1: { input: 1, output: 1, threshold: 100 } }, /同时提供/);
  reject({ m1: { input: 1, output: 1, cachedRead2: 0.1 } }, /仅在提供阶梯价/);
  reject({ m1: { input: 1, output: 1, threshold: 0, input2: 1, output2: 1 } }, /正整数/);
  reject({ m1: { input: 1, output: 1, threshold: 1.5, input2: 1, output2: 1 } }, /正整数/);
  // 未传 modelPrices → 保持现值（不被误清空）
  const relabeled = store.update(created.id, { label: '改标签' } as never);
  assert.deepEqual(store.view(relabeled).modelPrices, {
    'alias-a': { input: 2.5, output: 10, cachedRead: 0.5 },
    'alias-b': { input: 1, output: 2, threshold: 1000000, input2: 3, output2: 4, cachedRead2: 0.25 },
  });
  // models 变更后旧 modelPrices 键必须仍在 models 内（显式 400，绝不静默清空/失效）
  assert.throws(
    () => store.update(created.id, { models: ['alias-a'] } as never),
    (error: unknown) => error instanceof ChannelError && /不在本渠道 models/.test((error as Error).message),
  );
  // 显式 {} 清空后，models 收缩不再被旧价阻塞
  const cleared = store.update(created.id, { modelPrices: {} } as never);
  assert.deepEqual(store.view(cleared).modelPrices, {});
  assert.deepEqual(store.update(created.id, { models: ['alias-a'] } as never).models, ['alias-a']);
  // 更新路径同样严格校验
  assert.throws(
    () => store.update(created.id, { modelPrices: { ghost: { input: 1, output: 1 } } } as never),
    (error: unknown) => error instanceof ChannelError && /不在本渠道 models/.test((error as Error).message),
  );
});

test('pricing：computeCostUsd 缓存分量与整单阶梯（threshold 严格大于；cached>prompt 钳 0）', () => {
  const near = (a: number, b: number, label: string) => assert.ok(Math.abs(a - b) < 1e-12, `${label}：${a} vs ${b}`);
  near(computeCostUsd({ prompt_tokens: 14, completion_tokens: 3, cached_tokens: 4 }, { input: 2, output: 10, cachedRead: 0.5 }), (10 * 2 + 4 * 0.5 + 3 * 10) / 1e6, '缓存分量：未缓存 10×2 + 缓存 4×0.5 + 完成 3×10');
  near(computeCostUsd({ prompt_tokens: 10, completion_tokens: 1 }, { input: 2, output: 10 }), (10 * 2 + 1 * 10) / 1e6, '未上报 cached 视 0');
  near(computeCostUsd({ prompt_tokens: 5, completion_tokens: 1, cached_tokens: 9 }, { input: 2, output: 10, cachedRead: 0.5 }), (9 * 0.5 + 1 * 10) / 1e6, 'cached>prompt 钳 0，绝不产生负输入');
  const tier = { input: 2, output: 10, threshold: 10, input2: 100, output2: 200 };
  near(computeCostUsd({ prompt_tokens: 14, completion_tokens: 3 }, tier), (14 * 100 + 3 * 200) / 1e6, 'prompt>threshold → 整单二档');
  near(computeCostUsd({ prompt_tokens: 10, completion_tokens: 3 }, tier), (10 * 2 + 3 * 10) / 1e6, 'prompt==threshold 不进二档（严格大于）');
  near(computeCostUsd({ prompt_tokens: 14, completion_tokens: 3, cached_tokens: 4 }, { ...tier, cachedRead2: 5 }), (10 * 100 + 4 * 5 + 3 * 200) / 1e6, '二档缓存：未缓存 10×input2 + 缓存 4×cachedRead2 + 完成 3×output2');
  near(computeCostUsd({ prompt_tokens: 14, completion_tokens: 3, cached_tokens: 4 }, tier), (10 * 100 + 4 * 100 + 3 * 200) / 1e6, '二档未配 cachedRead2 → 缓存按二档输入价');
});

// ===== ⑦ OpenAI Responses 协议与 unified 统一中转（数据面） =====

test('Responses①：POST /v1/responses SSE 端到端（Bearer 注入、模型改写、账本 usage 四字段与 TTFT；只认 Bearer）', { timeout: 15000 }, async () => {
  const fixture = makeLedgerFixture();
  const stack = await startGatewayStack({ ledger: fixture.ledger, alertSilenceMs: 0 });
  const { gateway, mock } = stack;
  CLEANUPS.push(() => stack.cleanup());
  CLEANUPS.push(async () => fixture.cleanup());
  gateway.store.create(
    channelInput({ protocol: 'openai', models: ['resp-alias'], apiKey: CANARY_KEY, modelMap: { 'resp-alias': 'gpt-upstream-1' } }, stack.mock.port) as never,
  );
  mock.setResponder(() => ({
    status: 200,
    sse: sseBody([
      { type: 'response.created', response: { id: 'resp_1', model: 'gpt-upstream-1', status: 'in_progress' } },
      { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, delta: '你好' },
      { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, delta: '！' },
      {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          model: 'gpt-upstream-1',
          status: 'completed',
          usage: { input_tokens: 14, output_tokens: 3, total_tokens: 17, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 1 } },
        },
      },
    ]),
  }));
  const byKeyOnly = await request(gateway.port, '/v1/responses', {
    method: 'POST',
    headers: { 'x-api-key': gateway.virtualKey, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'resp-alias', input: 'hi' }),
  });
  assert.equal(byKeyOnly.status, 401, '/v1/responses 只认 Authorization: Bearer');
  const res = await request(gateway.port, '/v1/responses', {
    method: 'POST',
    headers: authHeaders(gateway),
    body: JSON.stringify({ model: 'resp-alias', input: 'hi', stream: true }),
  });
  assert.equal(res.status, 200);
  assert.match(String(res.headers['content-type']), /text\/event-stream/);
  assert.match(res.body, /response\.created/);
  assert.equal(mock.state.lastPath, '/v1/responses', '真实转发到 /v1/responses');
  assert.equal(mock.state.lastModel, 'gpt-upstream-1', 'model 别名改写');
  assert.equal(mock.state.lastAuth, `Bearer ${CANARY_KEY}`, 'OpenAI 系请求注入 Bearer 渠道 key');
  assert.equal(mock.state.lastXApiKey, null, 'Responses 上游不得收到 x-api-key');
  await waitFor(() => fixture.settlementRows().length === 1);
  const row = fixture.settlementRows()[0]!;
  assert.equal(row['client_status'], 'ok');
  assert.equal(row['finish_reason'], 'stop', 'response.completed 映射为 stop');
  assert.equal(row['token_prompt'], 14);
  assert.equal(row['token_completion'], 3);
  assert.equal(row['token_cached'], 4, 'input_tokens_details.cached_tokens 透传');
  assert.equal(row['token_reasoning'], 1, 'output_tokens_details.reasoning_tokens 透传');
  assert.equal(row['usage_valid'], 1);
  assert.ok(row['ttft_upstream_ms'] !== null, '首个 output_text.delta 到达应有 TTFT 样本');
});

test('Responses②：非流式 JSON 落账（completed→stop；incomplete+max_output_tokens→length；体校验 400/404）', { timeout: 15000 }, async () => {
  const fixture = makeLedgerFixture();
  const stack = await startGatewayStack({ ledger: fixture.ledger, alertSilenceMs: 0 });
  const { gateway, mock } = stack;
  CLEANUPS.push(() => stack.cleanup());
  CLEANUPS.push(async () => fixture.cleanup());
  gateway.store.create(channelInput({ models: ['resp-alias'], modelMap: { 'resp-alias': 'gpt-upstream-1' } }, stack.mock.port) as never);
  mock.setResponder(() => ({
    status: 200,
    payload: {
      id: 'resp_2',
      model: 'gpt-upstream-1',
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }],
      usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
    },
  }));
  const done = await request(gateway.port, '/v1/responses', {
    method: 'POST',
    headers: authHeaders(gateway),
    body: JSON.stringify({ model: 'resp-alias', input: 'hi' }),
  });
  assert.equal(done.status, 200);
  await waitFor(() => fixture.settlementRows().length === 1);
  const okRow = fixture.settlementRows()[0]!;
  assert.equal(okRow['finish_reason'], 'stop');
  assert.equal(okRow['token_prompt'], 5);
  assert.equal(okRow['token_completion'], 1);
  assert.ok(okRow['ttft_upstream_ms'] !== null, '非流式 output[] 含非空 output_text 也算内容信号');
  mock.setResponder(() => ({
    status: 200,
    payload: { id: 'resp_3', model: 'gpt-upstream-1', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [], usage: { input_tokens: 2, output_tokens: 16, total_tokens: 18 } },
  }));
  const truncated = await request(gateway.port, '/v1/responses', {
    method: 'POST',
    headers: authHeaders(gateway),
    body: JSON.stringify({ model: 'resp-alias', input: 'hi' }),
  });
  assert.equal(truncated.status, 200);
  await waitFor(() => fixture.settlementRows().length === 2);
  const cutRow = fixture.settlementRows().find((entry) => entry['token_prompt'] === 2)!;
  assert.equal(cutRow['finish_reason'], 'length', 'max_output_tokens 映射为 length');
  assert.equal(cutRow['ttft_upstream_ms'], null, '空 output[] 无内容信号，TTFT 必须 NULL 而非 0');
  const noModel = await request(gateway.port, '/v1/responses', { method: 'POST', headers: authHeaders(gateway), body: JSON.stringify({ input: 'hi' }) });
  assert.equal(noModel.status, 400);
  assert.match(noModel.body, /收到值/);
  assert.match(noModel.body, /示例/);
  const unknown = await request(gateway.port, '/v1/responses', { method: 'POST', headers: authHeaders(gateway), body: JSON.stringify({ model: 'nope-alias', input: 'hi' }) });
  assert.equal(unknown.status, 404);
  assert.match(unknown.body, /未知 model 别名/);
  assert.equal(mock.state.lastPath, '/v1/responses', '校验失败请求未触达上游（lastPath 仍为上一次成功转发）');
});

test('unified：统一中转渠道按客户端请求格式透传（messages→x-api-key；chat/responses→Bearer）', { timeout: 15000 }, async () => {
  const stack = await startGatewayStack();
  const { gateway, mock } = stack;
  CLEANUPS.push(() => stack.cleanup());
  gateway.store.create(
    channelInput({ protocol: 'unified', models: ['uni-alias'], apiKey: CANARY_KEY, modelMap: { 'uni-alias': 'uni-upstream' } }, stack.mock.port) as never,
  );
  mock.setResponder(() => ({ status: 200, payload: { ok: true } }));
  const chat = await request(gateway.port, '/v1/chat/completions', {
    method: 'POST',
    headers: authHeaders(gateway),
    body: JSON.stringify({ model: 'uni-alias', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(chat.status, 200);
  assert.equal(mock.state.lastPath, '/v1/chat/completions');
  assert.equal(mock.state.lastAuth, `Bearer ${CANARY_KEY}`, 'chat → Bearer');
  assert.equal(mock.state.lastXApiKey, null);
  const messages = await request(gateway.port, '/v1/messages', {
    method: 'POST',
    headers: anthropicAuthHeaders(gateway, { 'anthropic-version': '2024-06-01' }),
    body: JSON.stringify({ model: 'uni-alias', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(messages.status, 200);
  assert.equal(mock.state.lastPath, '/v1/messages');
  assert.equal(mock.state.lastXApiKey, CANARY_KEY, 'messages → x-api-key');
  assert.equal(mock.state.lastAuth, null, 'Anthropic 系请求不得携带 Authorization');
  assert.equal(mock.state.lastAnthropicVersion, '2024-06-01');
  const responses = await request(gateway.port, '/v1/responses', {
    method: 'POST',
    headers: authHeaders(gateway),
    body: JSON.stringify({ model: 'uni-alias', input: 'hi' }),
  });
  assert.equal(responses.status, 200);
  assert.equal(mock.state.lastPath, '/v1/responses');
  assert.equal(mock.state.lastAuth, `Bearer ${CANARY_KEY}`, 'responses → Bearer');
  assert.equal(mock.state.lastXApiKey, null);
});

test('费用：modelPrices 结算（缓存分量 + 整单阶梯；amount/costUsd 精确；未录价渠道恒 NULL）', { timeout: 15000 }, async () => {
  const fixture = makeLedgerFixture();
  const stack = await startGatewayStack({ ledger: fixture.ledger, alertSilenceMs: 0 });
  const { gateway, mock } = stack;
  CLEANUPS.push(() => stack.cleanup());
  CLEANUPS.push(async () => fixture.cleanup());
  gateway.store.create(
    channelInput(
      { models: ['pay-alias'], modelMap: { 'pay-alias': 'gpt-upstream-1' }, modelPrices: { 'pay-alias': { input: 2, output: 10, cachedRead: 0.5 } } },
      stack.mock.port,
    ) as never,
  );
  gateway.store.create(
    channelInput(
      { models: ['tier-alias'], modelMap: { 'tier-alias': 'gpt-upstream-1' }, modelPrices: { 'tier-alias': { input: 2, output: 10, threshold: 10, input2: 100, output2: 200, cachedRead2: 5 } } },
      stack.mock.port,
    ) as never,
  );
  gateway.store.create(channelInput({ models: ['free-alias'], modelMap: { 'free-alias': 'gpt-upstream-1' } }, stack.mock.port) as never);
  const usageFrame = (promptTokens: number, completionTokens: number, cachedTokens?: number) =>
    sseBody([
      {
        model: 'gpt-upstream-1',
        choices: [{ index: 0, delta: { content: 'a' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
          ...(cachedTokens === undefined ? {} : { prompt_tokens_details: { cached_tokens: cachedTokens } }),
        },
      },
    ]);
  const send = (alias: string) =>
    request(gateway.port, '/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders(gateway),
      body: JSON.stringify({ model: alias, messages: [{ role: 'user', content: 'hi' }] }),
    });
  mock.setResponder(() => ({ status: 200, sse: usageFrame(14, 3, 4) }));
  assert.equal((await send('pay-alias')).status, 200);
  mock.setResponder(() => ({ status: 200, sse: usageFrame(21, 4) }));
  assert.equal((await send('pay-alias')).status, 200);
  mock.setResponder(() => ({ status: 200, sse: usageFrame(14, 3, 4) }));
  assert.equal((await send('tier-alias')).status, 200);
  mock.setResponder(() => ({ status: 200, sse: usageFrame(10, 1) }));
  assert.equal((await send('free-alias')).status, 200);
  await waitFor(() => fixture.settlementRows().length === 4);
  const rows = fixture.settlementRows();
  const near = (a: unknown, b: number, label: string) => assert.ok(typeof a === 'number' && Math.abs(a - b) < 1e-12, `${label}：收到 ${String(a)}，期望 ${b}`);
  const pay1 = rows.find((entry) => entry['alias'] === 'pay-alias' && entry['token_prompt'] === 14)!;
  const pay2 = rows.find((entry) => entry['alias'] === 'pay-alias' && entry['token_prompt'] === 21)!;
  near(pay1['amount'], (10 * 2 + 4 * 0.5 + 3 * 10) / 1e6, '缓存分量计费 r1（未缓存 10×2 + 缓存 4×0.5 + 完成 3×10）');
  near(pay2['amount'], (21 * 2 + 4 * 10) / 1e6, '无缓存上报 r2（21×2 + 4×10）');
  const tierRow = rows.find((entry) => entry['alias'] === 'tier-alias')!;
  near(tierRow['amount'], (10 * 100 + 4 * 5 + 3 * 200) / 1e6, 'prompt 14 > threshold 10 → 整单二档，缓存按 cachedRead2');
  const freeRow = rows.find((entry) => entry['alias'] === 'free-alias')!;
  assert.equal(freeRow['amount'], null, '未录价渠道 amount 恒 NULL，绝不写 0');
  const summary = gateway.usageSummary();
  near(summary.find((row) => row.alias === 'pay-alias')?.costUsd, ((10 * 2 + 4 * 0.5 + 3 * 10) + (21 * 2 + 4 * 10)) / 1e6, '内存汇总按结算价累加');
  near(summary.find((row) => row.alias === 'tier-alias')?.costUsd, (10 * 100 + 4 * 5 + 3 * 200) / 1e6, '阶梯按整单二档汇总，缓存按 cachedRead2');
  assert.equal(summary.find((row) => row.alias === 'free-alias')?.costUsd, null, '未录价 → costUsd null（绝不显示 $0）');
});
