import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnomalies, composeUpstreamUrl, stripHopHeaders, validateRequestTarget, ByteLineScanner } from '../../src/guard/server.js';
import { validateUsage } from '../../src/sse.js';

function anomalyInput(overrides: Partial<Parameters<typeof buildAnomalies>[0]> = {}): Parameters<typeof buildAnomalies>[0] {
  return {
    modelReq: 'gpt-4o',
    modelResp: 'gpt-4o',
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    usageRejected: null,
    finishReason: 'stop',
    ...overrides,
  };
}

test('guard anomaly：model_resp ≠ model_req → warn（model_mismatch）', () => {
  const anomalies = buildAnomalies(anomalyInput({ modelResp: 'GLM-4' }));
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0]?.code, 'model_mismatch');
  assert.equal(anomalies[0]?.level, 'warn');
  assert.match(anomalies[0]?.message ?? '', /gpt-4o/);
  assert.match(anomalies[0]?.message ?? '', /GLM-4/);
});

test('guard anomaly：模型一致或响应模型未知 → 无异常', () => {
  assert.equal(buildAnomalies(anomalyInput()).length, 0);
  assert.equal(buildAnomalies(anomalyInput({ modelResp: null })).length, 0);
  assert.equal(buildAnomalies(anomalyInput({ modelReq: null, modelResp: 'GLM-4' })).length, 0);
});

test('guard anomaly：validateUsage 三类拒绝 → error 级 usage_invalid', () => {
  const bad: Array<{ usage: unknown; reason: string }> = [
    { usage: { prompt_tokens: 10, total_tokens: 15 }, reason: 'missing' },
    { usage: { prompt_tokens: -10, completion_tokens: 5, total_tokens: -5 }, reason: 'negative' },
    { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 999 }, reason: 'inconsistent' },
  ];
  for (const { usage, reason } of bad) {
    const validated = validateUsage(usage);
    assert.equal(validated.usage, null, `用例 ${reason} 应拒绝 usage`);
    assert.equal(validated.reason, reason);
    const anomalies = buildAnomalies(anomalyInput({ usage: null, usageRejected: validated.reason }));
    assert.equal(anomalies.length, 1, `用例 ${reason} 应产出异常`);
    assert.equal(anomalies[0]?.code, 'usage_invalid');
    assert.equal(anomalies[0]?.level, 'error');
  }
  assert.match(
    buildAnomalies(anomalyInput({ usage: null, usageRejected: 'negative' }))[0]?.message ?? '',
    /负/,
  );
  assert.match(
    buildAnomalies(anomalyInput({ usage: null, usageRejected: 'inconsistent' }))[0]?.message ?? '',
    /total_tokens/,
  );
});

test('guard anomaly：流末无 usage（rejected 也为 null）→ 不产生异常（只计数）', () => {
  const anomalies = buildAnomalies(anomalyInput({ usage: null, usageRejected: null }));
  assert.equal(anomalies.length, 0);
});

test('guard anomaly：finish_reason=length → info 记录；stop → 无', () => {
  const lengthOnes = buildAnomalies(anomalyInput({ finishReason: 'length' }));
  assert.equal(lengthOnes.length, 1);
  assert.equal(lengthOnes[0]?.code, 'finish_length');
  assert.equal(lengthOnes[0]?.level, 'info');
  assert.equal(buildAnomalies(anomalyInput({ finishReason: 'stop' })).length, 0);
});

test('guard anomaly：多异常叠加时逐条产出', () => {
  const anomalies = buildAnomalies(anomalyInput({ modelResp: 'GLM-4', usage: null, usageRejected: 'negative', finishReason: 'length' }));
  assert.deepEqual(
    anomalies.map((a) => a.code),
    ['model_mismatch', 'usage_invalid', 'finish_length'],
  );
  assert.deepEqual(
    anomalies.map((a) => a.level),
    ['warn', 'error', 'info'],
  );
});

test('guard 请求目标校验：相对路径放行，绝对 URI / //host / 穿越 / 坏编码拒绝', () => {
  const ok = validateRequestTarget('/v1/chat/completions?api-version=1');
  assert.ok(ok.ok);
  assert.equal(ok.path, '/v1/chat/completions'); // journal 只记去 query 后的 path

  assert.ok(validateRequestTarget('/').ok);
  assert.ok(validateRequestTarget('/v1/models').ok);
  assert.ok(validateRequestTarget('/v1/embeddings').ok);

  const absolute = validateRequestTarget('http://evil.example.com/v1/chat/completions');
  assert.ok(!absolute.ok);
  assert.equal(absolute.status, 403);

  const protocolRelative = validateRequestTarget('//evil.example.com/v1');
  assert.ok(!protocolRelative.ok);
  assert.equal(protocolRelative.status, 403);

  const noSlash = validateRequestTarget('v1/chat/completions');
  assert.ok(!noSlash.ok);
  assert.equal(noSlash.status, 400);

  const traversal = validateRequestTarget('/v1/../secret');
  assert.ok(!traversal.ok);
  assert.equal(traversal.status, 403);

  const encodedTraversal = validateRequestTarget('/v1/%2e%2e/secret');
  assert.ok(!encodedTraversal.ok);
  assert.equal(encodedTraversal.status, 403);

  const malformed = validateRequestTarget('/v1/%zz');
  assert.ok(!malformed.ok);
  assert.equal(malformed.status, 400);

  // 穿越变体：反斜杠与控制字符（含编码形态）
  const backslash = validateRequestTarget('/v1/a\\b');
  assert.ok(!backslash.ok);
  assert.equal(backslash.status, 400);

  const encodedBackslash = validateRequestTarget('/v1/%5c../secret');
  assert.ok(!encodedBackslash.ok);
  assert.equal(encodedBackslash.status, 400);

  const crlfInjection = validateRequestTarget('/v1/%0d%0aX-Injected');
  assert.ok(!crlfInjection.ok);
  assert.equal(crlfInjection.status, 400);

  const rawControl = validateRequestTarget('/v1/a\tb');
  assert.ok(!rawControl.ok);
  assert.equal(rawControl.status, 400);
});

test('guard hop-by-hop 头剥离：标准 hop 头、connection 点名头、proxy-* 全剥；端到端头保留', () => {
  const stripped = stripHopHeaders({
    connection: 'keep-alive, x-custom',
    'keep-alive': 'timeout=5',
    'transfer-encoding': 'chunked',
    upgrade: 'websocket',
    te: 'trailers',
    trailer: 'x-sum',
    'proxy-authorization': 'Basic attacker',
    'proxy-connection': 'keep-alive',
    'x-custom': 'hop-named',
    'content-type': 'application/json',
    'content-length': '42',
    authorization: 'Bearer client-key',
  });
  for (const name of ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authorization', 'proxy-connection', 'x-custom']) {
    assert.ok(!(name in stripped), `${name} 应被剥离`);
  }
  assert.equal(stripped['content-type'], 'application/json');
  assert.equal(stripped['content-length'], '42');
  assert.equal(stripped['authorization'], 'Bearer client-key'); // 剥离由服务端显式做，这里只管 hop 集
});

test('guard ByteLineScanner：跨 chunk 逐行切割，多字节字符不被截断 string 化', () => {
  const lines: string[] = [];
  const scanner = new ByteLineScanner((line) => lines.push(line.toString('utf8')));
  const payload = 'data: {"content":"你好世界"}\n\n';
  const raw = Buffer.from(payload, 'utf8');
  // 在多字节字符中间切开（你好 各 3 字节，从字节 1 后切）
  scanner.feed(raw.subarray(0, 14));
  scanner.feed(raw.subarray(14));
  scanner.end();
  assert.deepEqual(lines, ['data: {"content":"你好世界"}', '']);

  // CRLF 行尾：\r 保留在行内容里（由消费方 trim）
  const crlf: string[] = [];
  const scanner2 = new ByteLineScanner((line) => crlf.push(line.toString('utf8')));
  scanner2.feed(Buffer.from('data: a\r\ndata: b\r\n'));
  scanner2.end();
  assert.deepEqual(crlf, ['data: a\r', 'data: b\r']);
});

test('guard ByteLineScanner：无尾换行的末行在 end() 冲洗', () => {
  const lines: string[] = [];
  const scanner = new ByteLineScanner((line) => lines.push(line.toString('utf8')));
  scanner.feed(Buffer.from('data: {"usage":1}'));
  assert.equal(lines.length, 0);
  scanner.end();
  assert.deepEqual(lines, ['data: {"usage":1}']);
});

test('guard composeUpstreamUrl：--base-url 路径与请求路径重复前缀自动去重', () => {
  // base 带 /v1 + 客户端也发 /v1/... → 去重（纯串接会得到 /v1/v1/...，真实站点 404）
  assert.equal(composeUpstreamUrl('https://x.com/v1', '/v1/chat/completions'), 'https://x.com/v1/chat/completions');
  assert.equal(composeUpstreamUrl('https://x.com/v1/', '/v1/chat/completions'), 'https://x.com/v1/chat/completions');
  // base 带 /v1 + 客户端发根相对路径 → 直接拼接
  assert.equal(composeUpstreamUrl('https://x.com/v1', '/chat/completions'), 'https://x.com/v1/chat/completions');
  // base 无路径 → 原样拼接
  assert.equal(composeUpstreamUrl('https://x.com', '/v1/chat/completions'), 'https://x.com/v1/chat/completions');
  assert.equal(composeUpstreamUrl('https://x.com/', '/v1/chat/completions'), 'https://x.com/v1/chat/completions');
  // query 原样保留
  assert.equal(composeUpstreamUrl('https://x.com/v1', '/v1/chat/completions?a=1'), 'https://x.com/v1/chat/completions?a=1');
  // 恰等前缀：去重后落到根
  assert.equal(composeUpstreamUrl('https://x.com/v1', '/v1'), 'https://x.com/v1/');
  // 非重复前缀不误伤：自定义 /api/v1 base 与 /v1 请求路径并存时按原样拼（用户须自行对齐）
  assert.equal(composeUpstreamUrl('https://x.com/api/v1', '/v1/chat/completions'), 'https://x.com/api/v1/v1/chat/completions');
  // base 带 query/fragment：query/fragment 不参与拼接（路径绝不进 query 段；CLI 层已拒绝此类 base-url）
  assert.equal(composeUpstreamUrl('https://x.com/v1?k=1', '/v1/chat/completions'), 'https://x.com/v1/chat/completions');
  assert.equal(composeUpstreamUrl('https://x.com/v1#frag', '/chat'), 'https://x.com/v1/chat');
  // 绝对形式请求目标：防御降级取其 pathname+search（正常管线已被 validateRequestTarget 403 拦截）
  assert.equal(composeUpstreamUrl('https://x.com', 'http://evil.com/a?b=1'), 'https://x.com/a?b=1');
  // 非法 base（无协议）→ 旧串接行为兜底（仅防崩；CLI 校验才是真正闸门）
  assert.equal(composeUpstreamUrl('x.com/v1', '/v1/chat'), 'x.com/v1/v1/chat');
  // 非 ASCII：base pathname 被 URL 编码后与原始请求路径不匹配 → 退化为直接拼接（仍产出可用 URL）
  assert.equal(composeUpstreamUrl('https://x.com/中文', '/中文/a'), 'https://x.com/%E4%B8%AD%E6%96%87/中文/a');
});
