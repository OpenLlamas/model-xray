import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLogprobPrompts,
  compareLogprobVectors,
  extractFirstTokenLogprob,
  type LogprobVector,
} from '../../src/probes/logprob.js';
import { createRng } from '../../src/random.js';

function openAiPayload(token: string, logprob: number, top: Array<{ token: string; logprob: number }>): unknown {
  return { content: [{ token, logprob, top_logprobs: top }] };
}

function vector(id: string, token: string, logprob: number, topTokens: string[] = [token, 'other']): LogprobVector {
  return {
    promptId: id,
    position: {
      token,
      logprob,
      top: topTokens.map((entry, index) => ({ token: entry, logprob: index === 0 ? logprob : logprob - 2 - index })),
    },
    trusted: true,
    reason: null,
    evidenceId: `ev-${id}`,
  };
}

test('logprob: 每轮 6 条 prompt 均随机化且 id 唯一', () => {
  const prompts = buildLogprobPrompts(createRng(7), 2);
  assert.equal(prompts.length, 6);
  assert.equal(new Set(prompts.map((prompt) => prompt.id)).size, 6);
  assert.match(prompts[4]?.prompt ?? '', /^The capital city of (France|Japan|Italy|Germany|Spain|Canada) is$/);
});

test('logprob: 跳过前导空白 token，取首个非空白 content token', () => {
  const extracted = extractFirstTokenLogprob({
    content: [
      { token: ' ', logprob: -0.01, top_logprobs: [{ token: ' ', logprob: -0.01 }] },
      {
        token: '42',
        logprob: -0.2,
        top_logprobs: [
          { token: '42', logprob: -0.2 },
          { token: '41', logprob: -2.1 },
        ],
      },
    ],
  });
  assert.equal(extracted.trusted, true);
  assert.equal(extracted.position?.token, '42');
});

test('logprob: top_logprobs 概率和 > 1 标记不可信（防伪造）', () => {
  const extracted = extractFirstTokenLogprob({
    content: [
      {
        token: 'A',
        logprob: -0.1,
        top_logprobs: [
          { token: 'A', logprob: -0.1 },
          { token: 'B', logprob: -0.1 },
          { token: 'C', logprob: -0.1 },
          { token: 'D', logprob: -0.1 },
        ],
      },
    ],
  });
  assert.equal(extracted.trusted, false);
  assert.equal(extracted.reason, 'probability_mass');
});

test('logprob: top1 不在 top_logprobs 中标记不可信', () => {
  const extracted = extractFirstTokenLogprob({
    content: [
      {
        token: 'A',
        logprob: -0.1,
        top_logprobs: [
          { token: 'B', logprob: -0.1 },
          { token: 'C', logprob: -2.0 },
        ],
      },
    ],
  });
  assert.equal(extracted.trusted, false);
  assert.equal(extracted.reason, 'top1_missing');
});

test('logprob: 兼容旧版 tokens/token_logprobs/top_logprobs 形态', () => {
  const extracted = extractFirstTokenLogprob({
    tokens: ['he', 'llo'],
    token_logprobs: [-0.5, -0.1],
    top_logprobs: [{ he: -0.5, hi: -1.5 }, { llo: -0.1, llo2: -3.0 }],
  });
  assert.equal(extracted.trusted, true);
  assert.equal(extracted.position?.token, 'he');
});

test('logprob: 缺失/空 logprobs 返回 null 而不是猜测', () => {
  assert.equal(extractFirstTokenLogprob(null).position, null);
  assert.equal(extractFirstTokenLogprob({ content: [] }).position, null);
  assert.equal(extractFirstTokenLogprob({}).position, null);
});

test('logprob: 同 token 且 logprob 接近 → 不判不一致', () => {
  const main = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, index) => vector(id, '42', -0.1 - index * 0.01));
  const reference = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, index) => vector(id, '42', -0.12 - index * 0.01));
  const result = compareLogprobVectors(main, reference);
  assert.equal(result.comparable, 6);
  assert.equal(result.agreement, 1);
  assert.equal(result.suspicious, false);
});

test('logprob: 首 token 一致率 ≤ 50% → 可疑（两轮确认由调用方负责）', () => {
  const main = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => vector(id, '42', -0.1));
  const reference = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => vector(id, '43', -0.1));
  const result = compareLogprobVectors(main, reference);
  assert.equal(result.agreement, 0);
  assert.equal(result.suspicious, true);
});

test('logprob: 同 token 但 logprob 系统性差 > 0.6 且 top5 重合低 → 可疑', () => {
  const main = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => vector(id, '42', -0.1, ['42', 'x1', 'x2', 'x3', 'x4']));
  const reference = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) =>
    vector(id, '42', -1.2, ['42', 'y1', 'y2', 'y3', 'y4']),
  );
  const result = compareLogprobVectors(main, reference);
  assert.equal(result.sameTokenCount, 6);
  assert.ok((result.mae ?? 0) > 0.6);
  assert.equal(result.suspicious, true);
});

test('logprob: 可比样本少于 4 条不判可疑（证据不足）', () => {
  const main = ['a', 'b', 'c'].map((id) => vector(id, '42', -0.1));
  const reference = ['a', 'b', 'c'].map((id) => vector(id, '43', -0.1));
  const result = compareLogprobVectors(main, reference);
  assert.equal(result.comparable, 3);
  assert.equal(result.suspicious, false);
});

test('logprob: 不同 prompt 返回完全相同 top5 向量 → 记录回放计数', () => {
  const main = ['a', 'b'].map((id) => vector(id, '42', -0.1, ['42', 'x']));
  const reference = ['a', 'b'].map((id) => vector(id, '42', -0.1, ['42', 'x']));
  const result = compareLogprobVectors(main, reference);
  assert.equal(result.replayVectors, 1);
});

test('logprob: OpenAI 形态中 token 的 logprob 为正数 → 不可信', () => {
  const extracted = extractFirstTokenLogprob(openAiPayload('A', 0.5, [{ token: 'A', logprob: 0.5 }]));
  assert.equal(extracted.trusted, false);
  assert.equal(extracted.position, null);
});
