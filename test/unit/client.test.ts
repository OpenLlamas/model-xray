import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createClient } from '../../src/client.js';
import type { RequestProgressEvent } from '../../src/types.js';

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no port'));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}/v1`);
    });
  });
}

test('client stream: empty content + finish_reason=length is ok (not "empty stream") with finishReason passthrough', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: '思考中' }, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
        usage: { prompt_tokens: 10, completion_tokens: 64, total_tokens: 74 },
      })}\n\n`,
    );
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const baseUrl = await listen(server);
  try {
    const client = createClient({ baseUrl, apiKey: 'k', timeoutMs: 5000, retries: 0 });
    const result = await client.chat({
      model: 'thinking-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      max_tokens: 64,
    });
    // thinking 模型推理占满预算：合法响应，绝不能报 empty stream
    assert.equal(result.ok, true);
    assert.equal(result.error, null);
    assert.equal(result.text, '');
    assert.equal(result.finishReason, 'length');
    assert.ok(result.usage !== null && result.usage.completion_tokens === 64);
    // reasoning delta 也必须触发 TTFT（thinking 模型首包往往是推理 token）
    assert.ok(result.ttftMs !== null, 'reasoning delta must trigger ttftMs');
  } finally {
    server.close();
  }
});

test('client stream: pure reasoning deltas with missing finish_reason are still not "empty stream"', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: '推导中……' }, finish_reason: null }] })}\n\n`,
    );
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const baseUrl = await listen(server);
  try {
    const client = createClient({ baseUrl, apiKey: 'k', timeoutMs: 5000, retries: 0 });
    const result = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true });
    assert.equal(result.ok, true);
    assert.equal(result.error, null, 'reasoning-only stream must not be reported as empty stream');
    assert.equal(result.finishReason, null);
    assert.ok(result.reasoning !== null && result.reasoning.length > 0);
  } finally {
    server.close();
  }
});

test('client stream: text then clean close without finish_reason or [DONE] → ok:false (truncated)', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(
      `data: ${JSON.stringify({ model: 'm', choices: [{ index: 0, delta: { content: 'pong' }, finish_reason: null }] })}\n\n`,
    );
    res.end();
  });
  const baseUrl = await listen(server);
  try {
    const client = createClient({ baseUrl, apiKey: 'k', timeoutMs: 5000, retries: 0 });
    const result = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /without finish_reason or \[DONE\]/);
    assert.equal(result.text, 'pong', '已收正文仍须保留作 partial 证据');
    assert.equal(result.ttftMs, null, '截断流不得计为有效 TTFT 样本');
  } finally {
    server.close();
  }
});

test('client stream: SSE error payload after deltas preserves partial text as failed evidence', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'partial answer' }, finish_reason: null }] })}\n\n`,
    );
    res.write(`data: ${JSON.stringify({ error: { message: 'upstream stream failed' } })}\n\n`);
    res.end();
  });
  const baseUrl = await listen(server);
  try {
    const client = createClient({ baseUrl, apiKey: 'k', timeoutMs: 5000, retries: 0 });
    const result = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /upstream stream failed/);
    assert.equal(result.text, 'partial answer');
  } finally {
    server.close();
  }
});

test('client json: finish_reason passthrough; null when missing; length + empty content stays ok', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 5, completion_tokens: 16, total_tokens: 21 },
      }),
    );
  });
  const baseUrl = await listen(server);
  try {
    const client = createClient({ baseUrl, apiKey: 'k', timeoutMs: 5000, retries: 0 });
    const starved = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 });
    assert.equal(starved.ok, true);
    assert.equal(starved.finishReason, 'length');
    assert.equal(starved.error, null);
    assert.equal(starved.text, '');
  } finally {
    server.close();
  }

  const server2 = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
    );
  });
  const baseUrl2 = await listen(server2);
  try {
    const client = createClient({ baseUrl: baseUrl2, apiKey: 'k', timeoutMs: 5000, retries: 0 });
    const missing = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(missing.ok, true);
    assert.equal(missing.finishReason, null);
    assert.equal(missing.text, 'hello');
  } finally {
    server2.close();
  }
});

test('client: 非流式请求被端点错标为 text/event-stream 时，回退 JSON 解析恢复内容与 usage', async () => {
  // 实测端点兼容缺口（2026-10-17，[中转站] 全模型非流式）：响应 content-type 是
  // text/event-stream，但整份 chat.completion JSON 没有 data: 前缀 → SSE 解析器零事件 →
  // 曾误报 'empty stream' 并丢掉全部证据（identity/quality 退化为 N/A、billing 误判缺 usage）。
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      JSON.stringify({
        choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
      }),
    );
  });
  const baseUrl = await listen(server);
  try {
    const client = createClient({ baseUrl, apiKey: 'k', timeoutMs: 5000, retries: 0 });
    const result = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false });
    assert.equal(result.ok, true);
    assert.equal(result.error, null, '错标 content-type 不得退化成 empty stream');
    assert.equal(result.text, 'pong');
    assert.equal(result.finishReason, 'stop');
    assert.ok(result.usage !== null && result.usage.total_tokens === 11);
    assert.equal(result.usageRejected, null);
  } finally {
    server.close();
  }
});

test('client: 真·空 SSE（只有 [DONE]）仍然报 empty stream，不被 JSON 回退误判为有效响应', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: [DONE]\n\n');
  });
  const baseUrl = await listen(server);
  try {
    const client = createClient({ baseUrl, apiKey: 'k', timeoutMs: 5000, retries: 0 });
    const result = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true });
    assert.equal(result.ok, true);
    assert.equal(result.error, 'empty stream');
    assert.equal(result.text, '');
    assert.equal(result.finishReason, null);
  } finally {
    server.close();
  }
});

test('client: 200 空流在 --retries>0 时升档重试，第二次成功则采用成功结果（attempts=2）', async () => {
  // 端点抖动形态（2026-10-18 实测）：上游收下请求却零产出（completion=0/finish=null），
  // 与 503 cpu overloaded 同源；与 reasoning 占满预算（finish=length）是两种故障。
  let calls = 0;
  const server = createServer((req, res) => {
    calls += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (calls === 1) {
      res.end('data: [DONE]\n\n');
      return;
    }
    res.end(
      `data: ${JSON.stringify({ model: 'm', choices: [{ index: 0, delta: { content: 'pong' }, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } })}\n\n` +
        'data: [DONE]\n\n',
    );
  });
  const baseUrl = await listen(server);
  try {
    const client = createClient({ baseUrl, apiKey: 'k', timeoutMs: 5000, retries: 2 });
    const result = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true });
    assert.equal(calls, 2);
    assert.equal(result.ok, true);
    assert.equal(result.error, null);
    assert.equal(result.text, 'pong');
    assert.equal(result.attempts, 2);
  } finally {
    server.close();
  }
});

test('client: JSON 200 空正文（非 SSE）在 --retries>0 时同样重试', async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    calls += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        calls === 1
          ? { model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 } }
          : { model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
      ),
    );
  });
  const baseUrl = await listen(server);
  try {
    const client = createClient({ baseUrl, apiKey: 'k', timeoutMs: 5000, retries: 1 });
    const result = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false });
    assert.equal(calls, 2);
    assert.equal(result.ok, true);
    assert.equal(result.text, 'pong');
    assert.equal(result.attempts, 2);
  } finally {
    server.close();
  }
});

test('client: retryEmpty=false（billing）时 200 空正文不重试，避免重复计费污染倍率', async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    calls += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
      }),
    );
  });
  const baseUrl = await listen(server);
  try {
    const client = createClient({ baseUrl, apiKey: 'k', timeoutMs: 5000, retries: 2 });
    const result = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false, retryEmpty: false });
    assert.equal(calls, 1);
    assert.equal(result.attempts, 1);
    assert.equal(result.usage?.prompt_tokens, 5);
  } finally {
    server.close();
  }
});

test('client: JSON 200 截断（finish_reason=length）不按空正文重试', async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    calls += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 5, completion_tokens: 16, total_tokens: 21 },
      }),
    );
  });
  const baseUrl = await listen(server);
  try {
    const client = createClient({ baseUrl, apiKey: 'k', timeoutMs: 5000, retries: 3 });
    const result = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false });
    assert.equal(calls, 1);
    assert.equal(result.finishReason, 'length');
    assert.equal(result.attempts, 1);
  } finally {
    server.close();
  }
});

test('client: --retries>0 时机敏感错误（非空流/非可重试状态码）仍不重试，首次成功即返回', async () => {
  // guard 口径：400 等明确错误绝不重发（错误重发只会放大计费污染）；重试仅限可重试状态码与 200 空流。
  let calls = 0;
  const server = createServer((req, res) => {
    calls += 1;
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'bad request' } }));
  });
  const baseUrl = await listen(server);
  try {
    const client = createClient({ baseUrl, apiKey: 'k', timeoutMs: 5000, retries: 3 });
    const result = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true });
    assert.equal(calls, 1, '400 不得触发重试');
    assert.equal(result.ok, false);
    assert.equal(result.attempts, 1);
  } finally {
    server.close();
  }
});

test('client: 流式响应被端点错标为 application/json 时，按 SSE 解析恢复内容与 usage', async () => {
  // 与上一条对称的端点兼容缺口：SSE 流标成 application/json → JSON.parse 必然失败，
  // 曾整轮报 'invalid JSON response: data: {...}'，全维度退化为 N/A。
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      `data: ${JSON.stringify({ model: 'm-flash', choices: [{ index: 0, delta: { content: 'pon' }, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ model: 'm-flash', choices: [{ index: 0, delta: { content: 'g' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } })}\n\n` +
        'data: [DONE]\n\n',
    );
  });
  const baseUrl = await listen(server);
  try {
    const client = createClient({ baseUrl, apiKey: 'k', timeoutMs: 5000, retries: 0 });
    const result = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false });
    assert.equal(result.ok, true);
    assert.equal(result.error, null, '错标为 JSON 的 SSE 不得报 invalid JSON');
    assert.equal(result.text, 'pong');
    assert.equal(result.finishReason, 'stop');
    assert.ok(result.usage !== null && result.usage.total_tokens === 9);
    assert.equal(result.model, 'm-flash');
  } finally {
    server.close();
  }
});

test('client: 非 JSON 非 SSE 的响应体仍报 invalid JSON（回退不吞掉真实畸形）', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('<html>gateway error</html>');
  });
  const baseUrl = await listen(server);
  try {
    const client = createClient({ baseUrl, apiKey: 'k', timeoutMs: 5000, retries: 0 });
    const result = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false });
    assert.equal(result.ok, false);
    assert.ok(String(result.error).startsWith('invalid JSON response'), String(result.error));
  } finally {
    server.close();
  }
});

test('client: 非 2xx 的 SSE 形体响应不被 JSON 回退伪装成 ok（保留网关错误分级）', async () => {
  const server = createServer((req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(`data: ${JSON.stringify({ model: 'm', choices: [{ index: 0, delta: { content: 'pong' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  const baseUrl = await listen(server);
  try {
    const client = createClient({ baseUrl, apiKey: 'k', timeoutMs: 5000, retries: 0 });
    const result = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false });
    assert.equal(result.ok, false, '500 响应不得被回退判成成功');
    assert.equal(result.status, 500);
    assert.match(String(result.error), /500/, String(result.error));
  } finally {
    server.close();
  }
});

test('client: 回显 model 字段被捕获（JSON 与 SSE 两条路径）', async () => {
  const json = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'glm-5.3', choices: [{ index: 0, message: { content: 'pong' }, finish_reason: 'stop' }] }));
  });
  const jsonUrl = await listen(json);
  try {
    const client = createClient({ baseUrl: jsonUrl, apiKey: 'k', timeoutMs: 5000, retries: 0 });
    const result = await client.chat({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }], stream: false });
    assert.equal(result.model, 'glm-5.3');
  } finally {
    json.close();
  }
  const sse = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      `data: ${JSON.stringify({ model: 'z-ai/glm-5.3', choices: [{ index: 0, delta: { content: 'pong' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  const sseUrl = await listen(sse);
  try {
    const client = createClient({ baseUrl: sseUrl, apiKey: 'k', timeoutMs: 5000, retries: 0 });
    const result = await client.chat({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }], stream: true });
    assert.equal(result.model, 'z-ai/glm-5.3');
  } finally {
    sse.close();
  }
});

test('client: HTTP 200 + 纯 error 载荷（SSE 与 JSON 两条路径）按请求失败处理，不伪装成功空正文', async () => {
  // 层 3 审查实证的诬告路径：中转站欠费/限流/上游熔断时回 200 + data:{"error":{...}}，
  // 此前零信号 → ok:true + 空正文，探针据此指控「未发起工具调用」「上下文内容不可读」。
  const errorPayload = JSON.stringify({ error: { message: 'insufficient balance', type: 'insufficient_quota', code: '403' } });
  for (const stream of [true, false]) {
    const server = createServer((req, res) => {
      if (stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`data: ${errorPayload}\n\ndata: [DONE]\n\n`);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(errorPayload);
      }
    });
    const baseUrl = await listen(server);
    try {
      const client = createClient({ baseUrl, apiKey: 'k', timeoutMs: 5000, retries: 0 });
      const result = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream });
      assert.equal(result.ok, false, `stream=${stream} 的 200-error 载荷必须报失败`);
      assert.equal(result.status, 200, '保留上游 HTTP 状态码（非 4xx，故探针按传输/协议故障处理）');
      assert.match(result.error ?? '', /insufficient balance/, `stream=${stream} 必须带出上游错误信息`);
      assert.equal(result.text, '');
    } finally {
      server.close();
    }
  }
});

test('client: HTTP 200 + error 载荷且有残缺正文 → 判失败并保留正文作 partial 证据', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { message: 'upstream timeout after partial stream' },
        choices: [{ index: 0, message: { content: 'partial answer' }, finish_reason: 'stop' }],
      }),
    );
  });
  const baseUrl = await listen(server);
  try {
    const client = createClient({ baseUrl, apiKey: 'k', timeoutMs: 5000, retries: 0 });
    const result = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false });
    // 上游错误载荷优先：ok=false 让质量题/检索把该样本剔除分母（残句不是模型答错），
    // 但正文必须保留为 partial 证据，不能连带丢弃。
    assert.equal(result.ok, false, '错误载荷优先于残缺正文');
    assert.match(result.error ?? '', /upstream error payload/);
    assert.equal(result.text, 'partial answer', '残缺正文保留作诊断证据');
  } finally {
    server.close();
  }
});

test('client: 401 and 400 are not retried even with retries=3 (request-count assertion)', async () => {
  for (const status of [401, 400]) {
    let served = 0;
    const server = createServer((req, res) => {
      served += 1;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'rejected' } }));
    });
    const baseUrl = await listen(server);
    try {
      const client = createClient({ baseUrl, apiKey: 'k', timeoutMs: 5000, retries: 3 });
      const result = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(result.ok, false);
      assert.equal(result.status, status);
      assert.equal(result.finishReason, null, 'abort/transport/http-failure path must carry finishReason=null (not undefined)');
      assert.equal(served, 1, `HTTP ${status} must not be retried`);
    } finally {
      server.close();
    }
  }
});

test('client progress: emits start/end per request with seq, status, duration and usage', async () => {
  let received: Record<string, unknown> = {};
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        received = JSON.parse(body) as Record<string, unknown>;
      } catch {
        received = {};
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'm',
          choices: [{ index: 0, message: { content: 'pong' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
        }),
      );
    });
  });
  const baseUrl = await listen(server);
  try {
    const events: RequestProgressEvent[] = [];
    const client = createClient({
      baseUrl,
      apiKey: 'k',
      timeoutMs: 5000,
      retries: 0,
      onRequest: (event) => {
        events.push(event);
      },
    });
    const result = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'ping' }] });
    assert.equal(result.ok, true);
    assert.deepEqual(events.map((event) => event.kind), ['start', 'end']);
    assert.equal(events[0]?.seq, 1);
    assert.equal(events[0]?.attempt, 1);
    assert.ok((events[0]?.promptTokensEstimate ?? 0) > 0, 'start 事件必须携带输入 token 估算');
    assert.equal(events[1]?.status, 200);
    assert.equal(events[1]?.ok, true);
    assert.equal(events[1]?.promptTokens, 12);
    assert.ok((events[1]?.durationMs ?? -1) >= 0);
    assert.equal(events[1]?.error, null);
    assert.ok(!('onRequest' in received), '进度回调不得进入上游请求体');
    assert.ok(!('seq' in received), '进度序号不得进入上游请求体');
    assert.equal(received.stream, false);
  } finally {
    server.close();
  }
});

test('client progress: retries keep seq and expose attempt/status per attempt', { timeout: 10000 }, async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'retry me' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ index: 0, message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 },
      }),
    );
  });
  const baseUrl = await listen(server);
  try {
    const events: RequestProgressEvent[] = [];
    const client = createClient({
      baseUrl,
      apiKey: 'k',
      timeoutMs: 5000,
      retries: 1,
      onRequest: (event) => {
        events.push(event);
      },
    });
    const result = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
    assert.deepEqual(events.map((event) => event.kind), ['start', 'end', 'start', 'end']);
    assert.deepEqual(events.map((event) => event.attempt), [1, 1, 2, 2]);
    assert.ok(events.every((event) => event.seq === 1), '重试必须共用同一请求序号');
    assert.equal(events[1]?.status, 500);
    assert.equal(events[1]?.ok, false);
    assert.match(events[1]?.error ?? '', /retry me/);
    assert.equal(events[3]?.status, 200);
    assert.equal(events[3]?.ok, true);
    assert.equal(events[3]?.promptTokens, 9);
  } finally {
    server.close();
  }
});

test('client progress: throwing callback never breaks the audit', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ index: 0, message: { content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      }),
    );
  });
  const baseUrl = await listen(server);
  try {
    const client = createClient({
      baseUrl,
      apiKey: 'k',
      timeoutMs: 5000,
      retries: 0,
      onRequest: () => {
        throw new Error('progress boom');
      },
    });
    const result = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(result.ok, true);
    assert.equal(result.text, 'pong');
  } finally {
    server.close();
  }
});

test('client: key quota exhausted opens circuit, skips retries, and sends no further requests', async () => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { message: 'key quota exceeded: used 2.113287/2', type: 'upstream_error', code: 'QUOTA_EXCEEDED' },
      }),
    );
  });
  const baseUrl = await listen(server);
  try {
    const client = createClient({ baseUrl, apiKey: 'k', timeoutMs: 5000, retries: 2 });
    const first = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(first.ok, false);
    assert.equal(first.status, 429);
    assert.match(first.error ?? '', /key quota exceeded/);
    assert.equal(first.attempts, 1, '配额耗尽不是抖动：不得消耗重试');
    assert.equal(client.quotaExhausted?.(), true);

    const second = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'again' }] });
    assert.equal(second.ok, false);
    assert.equal(second.status, 429);
    assert.match(second.error ?? '', /quota exhausted（熔断/);
    assert.equal(hits, 1, '熔断后不得再发网络请求');
  } finally {
    server.close();
  }
});

test('client: 503 在 httpRetries 独立预算内重试并采纳 Retry-After，成功后非污染', async () => {
  // 端点过载形态（2026-10-19 某中转站实测）：网关层 503（system cpu overloaded）未进入推理、
  // 通常不计费 → 重试不算计费污染；httpRetries（默认 2）与 retries（200 空正文）分开计预算。
  let calls = 0;
  const server = createServer((req, res) => {
    calls += 1;
    if (calls <= 2) {
      res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '0' });
      res.end(JSON.stringify({ error: { message: 'system cpu overloaded', code: 'system_cpu_overloaded' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
      }),
    );
  });
  const baseUrl = await listen(server);
  try {
    const client = createClient({ baseUrl, apiKey: 'k', timeoutMs: 5000, retries: 0, httpRetries: 2, retryBudget: 8 });
    const result = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false });
    assert.equal(calls, 3, 'retries=0 不应影响 503 的独立预算（httpRetries=2 → 3 次尝试）');
    assert.equal(result.ok, true);
    assert.equal(result.text, 'pong');
    assert.equal(result.attempts, 3);
    assert.equal(result.contaminatingRetry, false, '503 网关拒绝后的重试不得污染计费口径');
  } finally {
    server.close();
  }
});

test('client: 500 重试属可能已执行 → contaminatingRetry 粘性为 true', async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'injected transient 500' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
      }),
    );
  });
  const baseUrl = await listen(server);
  try {
    const client = createClient({ baseUrl, apiKey: 'k', timeoutMs: 5000, retries: 0, httpRetries: 2, retryBudget: 8 });
    const result = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
    assert.equal(result.contaminatingRetry, true, '500 可能服务端已执行并计费，重试必须判污染');
  } finally {
    server.close();
  }
});

test('client: contaminatingRetry 粘性——200 空流触发重试后，即使中途 503 也保持污染', async () => {
  // 层 3 审查必修项：200空→503→200 的交错序列不得被后续 5xx 重置为非污染。
  let calls = 0;
  const server = createServer((req, res) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: [DONE]\n\n');
      return;
    }
    if (calls === 2) {
      res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '0' });
      res.end(JSON.stringify({ error: { message: 'system cpu overloaded' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
      }),
    );
  });
  const baseUrl = await listen(server);
  try {
    const client = createClient({ baseUrl, apiKey: 'k', timeoutMs: 5000, retries: 1, httpRetries: 2, retryBudget: 8 });
    const result = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true });
    assert.equal(calls, 3);
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 3);
    assert.equal(result.contaminatingRetry, true, '第一次尝试已可能按 prompt 计费，粘性污染不得复位');
  } finally {
    server.close();
  }
});

test('client: 运行级 retryBudget 耗尽后不再重试（防端点过载时重试放大）', async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    calls += 1;
    res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '0' });
    res.end(JSON.stringify({ error: { message: 'system cpu overloaded' } }));
  });
  const baseUrl = await listen(server);
  try {
    const client = createClient({ baseUrl, apiKey: 'k', timeoutMs: 5000, retries: 0, httpRetries: 2, retryBudget: 1 });
    const first = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'a' }], stream: false });
    assert.equal(first.attempts, 2, '预算 1 → 只允许 1 次重试（2 次尝试）');
    const second = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'b' }], stream: false });
    assert.equal(second.attempts, 1, '预算耗尽后不再重试，如实返回最后一次结果');
    assert.equal(calls, 3, '总请求数 = 2（首个请求）+ 1（第二个请求不再重试）');
  } finally {
    server.close();
  }
});

// ---------- temperature 参数 400 去参回退（2026-10-19 查漏补缺：chroe §4 推理模型/网关兼容） ----------

test('client: 400 拒绝 temperature → 去参重发成功（attempts=2、temperatureDropped 披露、不污染计费口径）', async () => {
  let calls = 0;
  let sawTemperature: boolean | null = null;
  const server = createServer((req, res) => {
    calls += 1;
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      sawTemperature = 'temperature' in parsed;
      if ('temperature' in parsed) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'temperature is not supported by this model', type: 'invalid_request_error' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        }),
      );
    });
  });
  const baseUrl = await listen(server);
  try {
    const client = createClient({ baseUrl, apiKey: 'k', timeoutMs: 5000, retries: 0 });
    const result = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], temperature: 0.7, max_tokens: 32 });
    assert.equal(result.ok, true, result.error ?? '');
    assert.equal(result.text, 'ok');
    assert.equal(result.attempts, 2, '去参重发计 1 次额外尝试');
    assert.equal(result.temperatureDropped, true, '证据须披露去参回退');
    assert.equal(result.contaminatingRetry, false, '400 参数校验失败不进入推理，不构成计费污染');
    assert.equal(sawTemperature, false, '第二次请求不得再携带 temperature');
    assert.equal(calls, 2);
  } finally {
    server.close();
  }
});

test('client: 400 错误体不含 temperature → 不去参重发（避免掩盖真正的 400 拒绝）', async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    calls += 1;
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'context length exceeded', type: 'invalid_request_error' } }));
  });
  const baseUrl = await listen(server);
  try {
    const client = createClient({ baseUrl, apiKey: 'k', timeoutMs: 5000, retries: 0 });
    const result = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], temperature: 0, max_tokens: 32 });
    assert.equal(result.ok, false);
    assert.equal(result.attempts, 1, '与 temperature 无关的 400 不重发');
    assert.notEqual(result.temperatureDropped, true);
    assert.equal(calls, 1);
  } finally {
    server.close();
  }
});

test('client: 去参重发后仍 400 → 如实失败（只回退一次，不无限去参重试）', async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    calls += 1;
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'temperature is not supported by this model' } }));
  });
  const baseUrl = await listen(server);
  try {
    const client = createClient({ baseUrl, apiKey: 'k', timeoutMs: 5000, retries: 0 });
    const result = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], temperature: 0, max_tokens: 32 });
    assert.equal(result.ok, false);
    assert.equal(result.attempts, 2, '去参重发了一次，仍失败则如实返回');
    assert.equal(calls, 2, '只回退一次，不继续重试');
  } finally {
    server.close();
  }
});

test('client: 无 temperature 的请求遇 400 不触发去参路径', async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    calls += 1;
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'temperature is not supported' } }));
  });
  const baseUrl = await listen(server);
  try {
    const client = createClient({ baseUrl, apiKey: 'k', timeoutMs: 5000, retries: 0 });
    const result = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], max_tokens: 32 });
    assert.equal(result.ok, false);
    assert.equal(result.attempts, 1);
    assert.equal(calls, 1, '本来就没带 temperature，无从去参');
  } finally {
    server.close();
  }
});
