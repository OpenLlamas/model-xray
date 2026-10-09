import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SseParser, parseStreamPayload, validateUsage } from '../../src/sse.js';

test('sse: parses a frame split across chunks', () => {
  const parser = new SseParser();
  assert.deepEqual(parser.feed('data: {"a"'), []);
  const events = parser.feed(':1}\n\n');
  assert.equal(events.length, 1);
  assert.equal(events[0]?.data, '{"a":1}');
});

test('sse: handles CRLF and multi-line data', () => {
  const parser = new SseParser();
  const events = parser.feed('event: delta\r\ndata: line1\r\ndata: line2\r\n\r\n');
  assert.equal(events.length, 1);
  assert.equal(events[0]?.event, 'delta');
  assert.equal(events[0]?.data, 'line1\nline2');
});

test('sse: ignores comments and blank frames', () => {
  const parser = new SseParser();
  const events = parser.feed(': keep-alive\n\ndata: x\n\n');
  assert.equal(events.length, 1);
  assert.equal(events[0]?.data, 'x');
});

test('sse: end() flushes remaining buffer', () => {
  const parser = new SseParser();
  assert.deepEqual(parser.feed('data: tail'), []);
  const events = parser.end();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.data, 'tail');
});

test('parseStreamPayload: content, reasoning, usage, tool deltas', () => {
  const chunk = parseStreamPayload(
    JSON.stringify({
      choices: [{ index: 0, delta: { content: 'hi', reasoning_content: 'think' }, finish_reason: null }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }),
  );
  assert.equal(chunk?.contentDelta, 'hi');
  assert.equal(chunk?.reasoningDelta, 'think');
  assert.equal(chunk?.usage?.total_tokens, 3);

  const toolChunk = parseStreamPayload(
    JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'echo_nonce', arguments: '{"nonce":"A' } }] } }] }),
  );
  assert.equal(toolChunk?.toolCallDeltas[0]?.name, 'echo_nonce');
  assert.equal(toolChunk?.toolCallDeltas[0]?.arguments, '{"nonce":"A');

  assert.equal(parseStreamPayload('[DONE]'), null);
  assert.equal(parseStreamPayload('not json'), null);
});

test('validateUsage: accepts consistent non-negative usage', () => {
  const { usage, reason } = validateUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  assert.deepEqual(usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  assert.equal(reason, null);
});

test('validateUsage: missing / non-numeric field → missing', () => {
  const cases: unknown[] = [
    { prompt_tokens: 10, total_tokens: 15 }, // 缺 completion_tokens
    { prompt_tokens: 10, completion_tokens: 5 }, // 缺 total_tokens
    { prompt_tokens: Number.NaN, completion_tokens: 5, total_tokens: NaN }, // 非有限
    undefined,
    null,
    'oops',
    42,
    [1, 2, 3],
  ];
  for (const value of cases) {
    const { usage, reason } = validateUsage(value);
    assert.equal(usage, null);
    assert.equal(reason, 'missing');
  }
});

test('validateUsage: negative field → negative', () => {
  const { usage, reason } = validateUsage({ prompt_tokens: -10, completion_tokens: 5, total_tokens: -5 });
  assert.equal(usage, null);
  assert.equal(reason, 'negative');
});

test('validateUsage: total !== prompt + completion → inconsistent', () => {
  const { usage, reason } = validateUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 20 });
  assert.equal(usage, null);
  assert.equal(reason, 'inconsistent');
});

test('parseStreamPayload: valid usage passes, inconsistent usage is rejected with reason', () => {
  const good = parseStreamPayload(
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }),
  );
  assert.deepEqual(good?.usage, { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 });
  assert.equal(good?.usageReason, null);

  const bad = parseStreamPayload(
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 99 } }),
  );
  assert.equal(bad?.usage, null);
  assert.equal(bad?.usageReason, 'inconsistent');

  const none = parseStreamPayload(JSON.stringify({ choices: [{ index: 0, delta: { content: 'x' }, finish_reason: null }] }));
  assert.equal(none?.usage, null);
  assert.equal(none?.usageReason, null);
});
