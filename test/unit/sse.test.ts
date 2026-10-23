import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SseParser,
  anthropicContentHasSignal,
  mapAnthropicStopReason,
  mapAnthropicUsage,
  mapResponsesUsage,
  parseAnthropicStreamPayload,
  parseResponsesStreamPayload,
  parseStreamPayload,
  responsesContentHasSignal,
  validateUsage,
} from '../../src/sse.js';

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
  assert.deepEqual(chunk?.choiceIndices, [0]);

  const multi = parseStreamPayload(
    JSON.stringify({ choices: [{ index: 0, delta: { content: 'a' } }, { index: 1, delta: { content: 'b' } }] }),
  );
  assert.deepEqual(multi?.choiceIndices, [0, 1]);
  assert.deepEqual(multi?.choiceContentIndices, [0, 1]);

  const missingIndex = parseStreamPayload(
    JSON.stringify({ choices: [{ delta: { content: 'a' } }, { delta: { content: 'b' } }] }),
  );
  assert.deepEqual(missingIndex?.choiceIndices, []);
  assert.deepEqual(missingIndex?.choiceContentIndices, []);

  const emptyChoice = parseStreamPayload(
    JSON.stringify({ choices: [{ index: 0, delta: { content: 'a' } }, { index: 1, delta: { content: '' } }] }),
  );
  assert.deepEqual(emptyChoice?.choiceIndices, [0, 1]);
  assert.deepEqual(emptyChoice?.choiceContentIndices, [0]);

  const toolChunk = parseStreamPayload(
    JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'echo_nonce', arguments: '{"nonce":"A' } }] } }] }),
  );
  assert.equal(toolChunk?.toolCallDeltas[0]?.name, 'echo_nonce');
  assert.equal(toolChunk?.toolCallDeltas[0]?.arguments, '{"nonce":"A');

  assert.equal(parseStreamPayload('[DONE]'), null);
  assert.equal(parseStreamPayload('not json'), null);
});

test('parseStreamPayload: full completion object inside SSE data frame (message instead of delta)', () => {
  // 部分中转站把完整 chat.completion 对象塞进 data 帧：正文在 message.content，不是 delta.content。
  const full = parseStreamPayload(
    JSON.stringify({
      model: 'glm-5.3-flash',
      choices: [{ index: 0, message: { role: 'assistant', content: 'I am GLM-5.3.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
    }),
  );
  assert.equal(full?.contentDelta, 'I am GLM-5.3.');
  assert.equal(full?.finishReason, 'stop');
  assert.equal(full?.model, 'glm-5.3-flash');
  assert.equal(full?.usage?.total_tokens, 16);

  const legacy = parseStreamPayload(JSON.stringify({ choices: [{ index: 0, text: 'hi', finish_reason: 'stop' }] }));
  assert.equal(legacy?.contentDelta, 'hi');
  assert.equal(legacy?.finishReason, 'stop');
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

test('validateUsage: fractional token counts → missing（token 计数必须是整数，小数计费不可信）', () => {
  for (const value of [
    { prompt_tokens: 1.5, completion_tokens: 2.5, total_tokens: 4 },
    { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15.5 },
    { prompt_tokens: 10.5, completion_tokens: 5, total_tokens: 15.5 },
  ]) {
    const { usage, reason } = validateUsage(value);
    assert.equal(usage, null, JSON.stringify(value));
    assert.equal(reason, 'missing');
  }
});

// --- Anthropic Messages 协议：frame 解析与 usage/stop_reason 映射 ---

test('mapAnthropicStopReason: 归一映射（max_tokens→length、end_turn/stop_sequence→stop、tool_use→tool_calls、其余原样）', () => {
  assert.equal(mapAnthropicStopReason('max_tokens'), 'length');
  assert.equal(mapAnthropicStopReason('end_turn'), 'stop');
  assert.equal(mapAnthropicStopReason('stop_sequence'), 'stop');
  assert.equal(mapAnthropicStopReason('tool_use'), 'tool_calls');
  assert.equal(mapAnthropicStopReason('pause_turn'), 'pause_turn');
  assert.equal(mapAnthropicStopReason(''), null);
  assert.equal(mapAnthropicStopReason(null), null);
  assert.equal(mapAnthropicStopReason(42), null);
});

test('mapAnthropicUsage: input/output/cache_read → 统一四字段；cached 缺省 0，reasoning 恒 0', () => {
  const { usage, reason } = mapAnthropicUsage({ input_tokens: 25, output_tokens: 5, cache_read_input_tokens: 5 });
  assert.equal(reason, null);
  assert.deepEqual(usage, {
    prompt_tokens: 25,
    completion_tokens: 5,
    total_tokens: 30,
    cached_tokens: 5,
    reasoning_tokens: 0,
  });
  const noCache = mapAnthropicUsage({ input_tokens: 10, output_tokens: 2 });
  assert.equal(noCache.reason, null);
  assert.equal(noCache.usage?.cached_tokens, 0, 'Anthropic 语义：未上报缓存视为无命中（0），不是 null');
});

test('mapAnthropicUsage: message_delta 帧缺 input → 沿用 priorUsage 的输入与缓存值', () => {
  const prior = { prompt_tokens: 25, completion_tokens: 0, total_tokens: 25, cached_tokens: 7, reasoning_tokens: 0 };
  const { usage, reason } = mapAnthropicUsage({ output_tokens: 30 }, prior);
  assert.equal(reason, null);
  assert.deepEqual(usage, {
    prompt_tokens: 25,
    completion_tokens: 30,
    total_tokens: 55,
    cached_tokens: 7,
    reasoning_tokens: 0,
  });
});

test('mapAnthropicUsage: 缺 input 且无 prior → missing；负值 → negative；非对象 → missing', () => {
  assert.deepEqual(mapAnthropicUsage({ output_tokens: 5 }), { usage: null, reason: 'missing' });
  assert.deepEqual(mapAnthropicUsage({ input_tokens: 10 }), { usage: null, reason: 'missing' });
  assert.deepEqual(mapAnthropicUsage({ input_tokens: -1, output_tokens: 5 }), { usage: null, reason: 'negative' });
  assert.deepEqual(mapAnthropicUsage({ input_tokens: 10, output_tokens: -5 }), { usage: null, reason: 'negative' });
  assert.deepEqual(mapAnthropicUsage({ input_tokens: 10.5, output_tokens: 5 }), { usage: null, reason: 'missing' });
  assert.deepEqual(mapAnthropicUsage(null), { usage: null, reason: 'missing' });
  assert.deepEqual(mapAnthropicUsage([1]), { usage: null, reason: 'missing' });
});

test('mapAnthropicUsage: cache_read 畸形（负值）只降级 cached=null，核心三字段照常通过', () => {
  const { usage, reason } = mapAnthropicUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: -1 });
  assert.equal(reason, null);
  assert.equal(usage?.cached_tokens, null);
  assert.equal(usage?.total_tokens, 15);
});

test('parseAnthropicStreamPayload: message_start 取 model 与 usage', () => {
  const chunk = parseAnthropicStreamPayload(
    JSON.stringify({
      type: 'message_start',
      message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 25, output_tokens: 5, cache_read_input_tokens: 5 } },
    }),
  );
  assert.equal(chunk?.model, 'claude-sonnet-4-6');
  assert.deepEqual(chunk?.usage, {
    prompt_tokens: 25,
    completion_tokens: 5,
    total_tokens: 30,
    cached_tokens: 5,
    reasoning_tokens: 0,
  });
  assert.equal(chunk?.usageReason, null);
  assert.equal(chunk?.finishReason, null);
});

test('parseAnthropicStreamPayload: content_block_start 空 text 不算内容、非空 text/thinking 计入、tool_use 块开始必计数', () => {
  const empty = parseAnthropicStreamPayload(
    JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  );
  assert.equal(empty?.contentDelta, '', '空 text 块开始不算内容信号');

  const text = parseAnthropicStreamPayload(
    JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Hi' } }),
  );
  assert.equal(text?.contentDelta, 'Hi');

  const thinking = parseAnthropicStreamPayload(
    JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'hmm' } }),
  );
  assert.equal(thinking?.reasoningDelta, 'hmm');

  const tool = parseAnthropicStreamPayload(
    JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} } }),
  );
  assert.deepEqual(tool?.toolCallDeltas, [{ index: 1, id: 'toolu_1', name: 'get_weather' }]);

  assert.equal(
    parseAnthropicStreamPayload(JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'image', source: {} } })),
    null,
    '未知块型（image）无观测信号',
  );
});

test('parseAnthropicStreamPayload: content_block_delta 三类增量与 signature_delta', () => {
  const text = parseAnthropicStreamPayload(
    JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }),
  );
  assert.equal(text?.contentDelta, 'Hello');

  const thinking = parseAnthropicStreamPayload(
    JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '...' } }),
  );
  assert.equal(thinking?.reasoningDelta, '...');

  const tool = parseAnthropicStreamPayload(
    JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"a":' } }),
  );
  assert.deepEqual(tool?.toolCallDeltas, [{ index: 1, arguments: '{"a":' }]);

  assert.equal(
    parseAnthropicStreamPayload(JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'x' } })),
    null,
    'signature_delta 无内容信号',
  );
});

test('parseAnthropicStreamPayload: message_delta 终值 usage 与 priorUsage 合并（input 沿用先到的 message_start）', () => {
  const prior = { prompt_tokens: 25, completion_tokens: 5, total_tokens: 30, cached_tokens: 5, reasoning_tokens: 0 };
  const chunk = parseAnthropicStreamPayload(
    JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { output_tokens: 30 } }),
    prior,
  );
  assert.equal(chunk?.finishReason, 'length');
  assert.deepEqual(chunk?.usage, {
    prompt_tokens: 25,
    completion_tokens: 30,
    total_tokens: 55,
    cached_tokens: 5,
    reasoning_tokens: 0,
  });
  assert.equal(chunk?.usageReason, null);

  const orphan = parseAnthropicStreamPayload(
    JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 30 } }),
  );
  assert.equal(orphan?.usage, null, '无 prior 且帧内无 input → 拒收');
  assert.equal(orphan?.usageReason, 'missing');
  assert.equal(orphan?.finishReason, 'stop');
});

test('parseAnthropicStreamPayload: message_delta 的 usage 拒收路径（负值/缺 output）', () => {
  const negative = parseAnthropicStreamPayload(
    JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 10, output_tokens: -1 } }),
  );
  assert.equal(negative?.usage, null);
  assert.equal(negative?.usageReason, 'negative');

  const missingOutput = parseAnthropicStreamPayload(
    JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 10 } }),
  );
  assert.equal(missingOutput?.usage, null);
  assert.equal(missingOutput?.usageReason, 'missing');
});

test('parseAnthropicStreamPayload: input_tokens 存在但非法时拒收，不用 priorUsage 掩盖；缺省才沿用', () => {
  const prior = { prompt_tokens: 25, completion_tokens: 5, total_tokens: 30, cached_tokens: 5, reasoning_tokens: 0 };
  const negativeInput = parseAnthropicStreamPayload(
    JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: -3, output_tokens: 30 } }),
    prior,
  );
  assert.equal(negativeInput?.usage, null);
  assert.equal(negativeInput?.usageReason, 'negative');

  const fractionalInput = parseAnthropicStreamPayload(
    JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 10.5, output_tokens: 30 } }),
    prior,
  );
  assert.equal(fractionalInput?.usage, null);
  assert.equal(fractionalInput?.usageReason, 'missing');

  const absentInput = parseAnthropicStreamPayload(
    JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 30 } }),
    prior,
  );
  assert.equal(absentInput?.usage?.prompt_tokens, 25, '缺省 input 仍沿用 priorUsage');
});

test('parseAnthropicStreamPayload: error 帧带出上游错误消息；ping/message_stop/content_block_stop/未知/坏 JSON → null', () => {
  const error = parseAnthropicStreamPayload(
    JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
  );
  assert.equal(error?.errorMessage, 'Overloaded | overloaded_error');

  assert.equal(parseAnthropicStreamPayload(JSON.stringify({ type: 'ping' })), null);
  assert.equal(parseAnthropicStreamPayload(JSON.stringify({ type: 'message_stop' })), null);
  assert.equal(parseAnthropicStreamPayload(JSON.stringify({ type: 'content_block_stop', index: 0 })), null);
  assert.equal(parseAnthropicStreamPayload(JSON.stringify({ type: 'weird_new_frame' })), null);
  assert.equal(parseAnthropicStreamPayload('[DONE]'), null);
  assert.equal(parseAnthropicStreamPayload('not json'), null);
  assert.equal(parseAnthropicStreamPayload('"str"'), null);
});

test('anthropicContentHasSignal: 非空 text/thinking/tool_use 计入；空 text 与非数组不计入', () => {
  assert.equal(anthropicContentHasSignal([{ type: 'text', text: 'Hi' }]), true);
  assert.equal(anthropicContentHasSignal([{ type: 'text', text: '' }]), false);
  assert.equal(anthropicContentHasSignal([{ type: 'thinking', thinking: 'hmm' }]), true);
  assert.equal(anthropicContentHasSignal([{ type: 'tool_use', id: 't1', name: 'x', input: {} }]), true);
  assert.equal(anthropicContentHasSignal([{ type: 'image', source: {} }, { type: 'text', text: '' }]), false);
  assert.equal(anthropicContentHasSignal([]), false);
  assert.equal(anthropicContentHasSignal('text'), false);
  assert.equal(anthropicContentHasSignal(undefined), false);
});

// --- OpenAI Responses 协议：frame 解析与 usage 映射（旁路观测口径） ---

test('mapResponsesUsage: input/output 映射核心字段，details 透传 cached/reasoning', () => {
  const { usage, reason } = mapResponsesUsage({
    input_tokens: 25,
    output_tokens: 5,
    total_tokens: 30,
    input_tokens_details: { cached_tokens: 4 },
    output_tokens_details: { reasoning_tokens: 5 },
  });
  assert.equal(reason, null);
  assert.deepEqual(usage, {
    prompt_tokens: 25,
    completion_tokens: 5,
    total_tokens: 30,
    cached_tokens: 4,
    reasoning_tokens: 5,
  });
});

test('mapResponsesUsage: total 缺失按 input+output 补足；total≠分项和 → inconsistent', () => {
  const synth = mapResponsesUsage({ input_tokens: 10, output_tokens: 5 });
  assert.equal(synth.reason, null);
  assert.equal(synth.usage?.total_tokens, 15, '缺 total 时按 input+output 合成');
  const bad = mapResponsesUsage({ input_tokens: 10, output_tokens: 5, total_tokens: 99 });
  assert.equal(bad.usage, null);
  assert.equal(bad.reason, 'inconsistent', '上游携带 total 时原样交 validateUsage 校验');
});

test('mapResponsesUsage: 缺失/负值/小数/非对象 → missing 或 negative', () => {
  assert.deepEqual(mapResponsesUsage({ output_tokens: 5 }), { usage: null, reason: 'missing' });
  assert.deepEqual(mapResponsesUsage({ input_tokens: 10 }), { usage: null, reason: 'missing' });
  assert.deepEqual(mapResponsesUsage({ input_tokens: -1, output_tokens: 5 }), { usage: null, reason: 'negative' });
  assert.deepEqual(mapResponsesUsage({ input_tokens: 10, output_tokens: -5 }), { usage: null, reason: 'negative' });
  assert.deepEqual(mapResponsesUsage({ input_tokens: 10.5, output_tokens: 5 }), { usage: null, reason: 'missing' });
  assert.deepEqual(mapResponsesUsage(null), { usage: null, reason: 'missing' });
  assert.deepEqual(mapResponsesUsage([1]), { usage: null, reason: 'missing' });
});

test('mapResponsesUsage: details 畸形/越界只降级 null，核心三字段照常通过', () => {
  const { usage, reason } = mapResponsesUsage({
    input_tokens: 10,
    output_tokens: 5,
    input_tokens_details: { cached_tokens: 11 },
    output_tokens_details: 'oops',
  });
  assert.equal(reason, null);
  assert.equal(usage?.cached_tokens, null, 'cached > prompt 只降级不拒包');
  assert.equal(usage?.reasoning_tokens, null, 'details 形状错位只降级不拒包');
  assert.equal(usage?.total_tokens, 15);
});

test('parseResponsesStreamPayload: created/in_progress/queued 取 model；text 与 reasoning delta', () => {
  const created = parseResponsesStreamPayload(
    JSON.stringify({ type: 'response.created', response: { id: 'resp_1', model: 'gpt-up-1', status: 'in_progress' } }),
  );
  assert.equal(created?.model, 'gpt-up-1');

  const text = parseResponsesStreamPayload(JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, delta: '你好' }));
  assert.equal(text?.contentDelta, '你好');

  const reasoning = parseResponsesStreamPayload(JSON.stringify({ type: 'response.reasoning_summary_text.delta', output_index: 0, delta: '思考' }));
  assert.equal(reasoning?.reasoningDelta, '思考');

  const junkDelta = parseResponsesStreamPayload(JSON.stringify({ type: 'response.output_text.delta', delta: 42 }));
  assert.equal(junkDelta?.contentDelta, '', '非字符串 delta 记空串，绝不伪造内容信号');
});

test('parseResponsesStreamPayload: function_call 的 item 开始与参数增量', () => {
  const added = parseResponsesStreamPayload(
    JSON.stringify({ type: 'response.output_item.added', output_index: 1, item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'echo_nonce', arguments: '' } }),
  );
  assert.deepEqual(added?.toolCallDeltas, [{ index: 1, id: 'call_1', name: 'echo_nonce' }]);

  const args = parseResponsesStreamPayload(JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"nonce"' }));
  assert.deepEqual(args?.toolCallDeltas, [{ index: 1, arguments: '{"nonce"' }]);
});

test('parseResponsesStreamPayload: completed/incomplete 的 usage 与 finish_reason 映射', () => {
  const completed = parseResponsesStreamPayload(
    JSON.stringify({
      type: 'response.completed',
      response: {
        model: 'gpt-up-1',
        status: 'completed',
        usage: { input_tokens: 14, output_tokens: 3, total_tokens: 17, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 1 } },
      },
    }),
  );
  assert.equal(completed?.finishReason, 'stop');
  assert.equal(completed?.usage?.prompt_tokens, 14);
  assert.equal(completed?.usage?.total_tokens, 17);
  assert.equal(completed?.usage?.cached_tokens, 4);

  const incomplete = parseResponsesStreamPayload(
    JSON.stringify({ type: 'response.incomplete', response: { model: 'gpt-up-1', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 5, output_tokens: 1 } } }),
  );
  assert.equal(incomplete?.finishReason, 'length', 'max_output_tokens 映射为 length');
  assert.equal(incomplete?.usage?.total_tokens, 6, 'total 缺失按分项和补足');

  const badUsage = parseResponsesStreamPayload(
    JSON.stringify({ type: 'response.completed', response: { model: 'gpt-up-1', usage: { input_tokens: 2, output_tokens: 3, total_tokens: 99 } } }),
  );
  assert.equal(badUsage?.usage, null, 'total≠分项和拒收');
  assert.equal(badUsage?.usageReason, 'inconsistent');
  assert.equal(badUsage?.finishReason, 'stop', 'usage 拒收不影响 finish_reason 提取');
});

test('parseResponsesStreamPayload: failed 带出错误消息；error 帧；其余/坏 JSON → null', () => {
  const failed = parseResponsesStreamPayload(JSON.stringify({ type: 'response.failed', response: { error: { code: 'server_error', message: 'boom' } } }));
  assert.equal(failed?.errorMessage, 'boom');
  assert.equal(failed?.finishReason, null, '失败语义不借 finish_reason 表达');

  const errorFrame = parseResponsesStreamPayload(JSON.stringify({ type: 'error', code: 'rate_limit_exceeded', message: 'slow down' }));
  assert.equal(errorFrame?.errorMessage, 'slow down');

  assert.equal(parseResponsesStreamPayload(JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message' } })), null);
  assert.equal(parseResponsesStreamPayload(JSON.stringify({ type: 'response.weird_frame' })), null);
  assert.equal(parseResponsesStreamPayload(JSON.stringify({ response: { model: 'x' } })), null, 'type 非 string → null');
  assert.equal(parseResponsesStreamPayload('[DONE]'), null);
  assert.equal(parseResponsesStreamPayload('not json'), null);
  assert.equal(parseResponsesStreamPayload('"str"'), null);
});

test('responsesContentHasSignal: 非空 output_text 与 function_call 计入；空文本/其他类型不计入', () => {
  assert.equal(responsesContentHasSignal([{ type: 'message', content: [{ type: 'output_text', text: 'Hi' }] }]), true);
  assert.equal(responsesContentHasSignal([{ type: 'message', content: [{ type: 'output_text', text: '' }] }]), false);
  assert.equal(responsesContentHasSignal([{ type: 'function_call', call_id: 'c1', name: 'x' }]), true);
  assert.equal(responsesContentHasSignal([{ type: 'reasoning', summary: [] }]), false);
  assert.equal(responsesContentHasSignal([]), false);
  assert.equal(responsesContentHasSignal('text'), false);
  assert.equal(responsesContentHasSignal(undefined), false);
});
