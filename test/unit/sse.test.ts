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
  // 缺省 details → 两明细字段为 null（上游未上报），核心三字段照常通过
  assert.deepEqual(usage, {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    cached_tokens: null,
    reasoning_tokens: null,
  });
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
  assert.deepEqual(good?.usage, {
    prompt_tokens: 2,
    completion_tokens: 3,
    total_tokens: 5,
    cached_tokens: null,
    reasoning_tokens: null,
  });
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

// --- Usage 契约扩展：prompt_tokens_details.cached_tokens / completion_tokens_details.reasoning_tokens ---

test('validateUsage: 合法 details 透传（非负整数且为对应核心字段的子集）', () => {
  const { usage, reason } = validateUsage({
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    prompt_tokens_details: { cached_tokens: 4 },
    completion_tokens_details: { reasoning_tokens: 5 },
  });
  assert.equal(reason, null);
  assert.deepEqual(usage, {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    cached_tokens: 4,
    reasoning_tokens: 5,
  });
});

test('validateUsage: details 边界值（0 与恰等于核心字段）透传', () => {
  const { usage, reason } = validateUsage({
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    prompt_tokens_details: { cached_tokens: 10 },
    completion_tokens_details: { reasoning_tokens: 0 },
  });
  assert.equal(reason, null);
  assert.equal(usage?.cached_tokens, 10);
  assert.equal(usage?.reasoning_tokens, 0);
});

test('validateUsage: 垃圾 details 形状 → 对应字段 null，绝不抛错且核心字段照常通过', () => {
  const good = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  const cases: Array<{ label: string; extra: Record<string, unknown>; field: 'cached_tokens' | 'reasoning_tokens' }> = [
    { label: 'details 为字符串', extra: { prompt_tokens_details: 'oops' }, field: 'cached_tokens' },
    { label: 'details 为数组', extra: { completion_tokens_details: [1] }, field: 'reasoning_tokens' },
    { label: 'details 为 null', extra: { prompt_tokens_details: null }, field: 'cached_tokens' },
    { label: '字段为字符串数字', extra: { completion_tokens_details: { reasoning_tokens: '3' } }, field: 'reasoning_tokens' },
    { label: '负数', extra: { prompt_tokens_details: { cached_tokens: -1 } }, field: 'cached_tokens' },
    { label: 'NaN', extra: { completion_tokens_details: { reasoning_tokens: Number.NaN } }, field: 'reasoning_tokens' },
    { label: 'Infinity', extra: { prompt_tokens_details: { cached_tokens: Number.POSITIVE_INFINITY } }, field: 'cached_tokens' },
    { label: '小数', extra: { completion_tokens_details: { reasoning_tokens: 1.5 } }, field: 'reasoning_tokens' },
    { label: '超过 prompt_tokens', extra: { prompt_tokens_details: { cached_tokens: 11 } }, field: 'cached_tokens' },
    { label: '超过 completion_tokens', extra: { completion_tokens_details: { reasoning_tokens: 6 } }, field: 'reasoning_tokens' },
  ];
  for (const { label, extra, field } of cases) {
    const { usage, reason } = validateUsage({ ...good, ...extra });
    assert.equal(reason, null, label);
    assert.ok(usage, label);
    assert.equal(usage[field], null, `${label} → ${field} 应为 null`);
    assert.equal(usage.prompt_tokens, 10, label);
    assert.equal(usage.completion_tokens, 5, label);
    assert.equal(usage.total_tokens, 15, label);
  }
});

test('parseStreamPayload: SSE usage 尾行携带 details 时照常透传', () => {
  const chunk = parseStreamPayload(
    JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 7,
        completion_tokens: 4,
        total_tokens: 11,
        prompt_tokens_details: { cached_tokens: 2 },
        completion_tokens_details: { reasoning_tokens: 1 },
      },
    }),
  );
  assert.equal(chunk?.usageReason, null);
  assert.equal(chunk?.usage?.cached_tokens, 2);
  assert.equal(chunk?.usage?.reasoning_tokens, 1);
});
