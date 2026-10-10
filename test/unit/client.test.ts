import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createClient } from '../../src/client.js';

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
