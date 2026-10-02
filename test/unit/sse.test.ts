import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SseParser, parseStreamPayload } from '../../src/sse.js';

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
