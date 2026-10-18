import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalModelId, sameModelId } from '../../src/guard/model-id.js';
import { buildAnomalies } from '../../src/guard/server.js';
import { computeDimensions, type ScoreSample } from '../../src/guard/scoreboard.js';

test('canonicalModelId：小写化 + 分隔符统一成 -，数字段边界保留', () => {
  assert.equal(canonicalModelId('glm-5.3-flash'), 'glm-5-3-flash');
  assert.equal(canonicalModelId('  GLM-5.3-Flash  '), 'glm-5-3-flash');
  assert.equal(canonicalModelId('glm_5_3__flash'), 'glm-5-3-flash');
  assert.equal(canonicalModelId('deepseek/v4.1 flash'), 'deepseek-v4-1-flash');
  // 红队审查（2026-10-18）：分隔符不可被删掉，否则 glm-3.5 与 glm-35 被误判同一模型 → 漏报换壳
  assert.notEqual(canonicalModelId('glm-3.5'), canonicalModelId('glm-35'));
  assert.notEqual(canonicalModelId('gpt-4-1'), canonicalModelId('gpt41'));
});

test('canonicalModelId：空/空白/非字符串 → null（缺失信息不判成一致）', () => {
  assert.equal(canonicalModelId(''), null);
  assert.equal(canonicalModelId('   '), null);
  assert.equal(canonicalModelId('---'), null);
  assert.equal(canonicalModelId(null), null);
  assert.equal(canonicalModelId(undefined), null);
  assert.equal(canonicalModelId(42), null);
});

test('sameModelId：中转站规范化写法判同一模型，真正换壳判不同', () => {
  // 实测误报：llamas 中转把 glm-5.3-flash 回显为 glm-5-3-flash
  assert.equal(sameModelId('glm-5.3-flash', 'glm-5-3-flash'), true);
  assert.equal(sameModelId('gpt-4o', 'GPT-4O'), true);
  assert.equal(sameModelId('glm-5.3-flash', 'glm-5.3'), false);
  assert.equal(sameModelId('glm-5.3-flash', 'deepseek-v4.1-flash'), false);
  assert.equal(sameModelId('glm-5.3-flash', 'glm-5.3-flash-preview'), false);
  // 数字段塌缩必须仍判不同（换壳漏报防线）
  assert.equal(sameModelId('glm-3.5', 'glm-35'), false);
  assert.equal(sameModelId('gpt-4-1', 'gpt41'), false);
  // 空 id 两侧相同也不算同一模型
  assert.equal(sameModelId('', ''), false);
  assert.equal(sameModelId(null, undefined), false);
});

test('guard anomaly：中转站分隔符规范化 → 不再误报 model_mismatch', () => {
  const anomalies = buildAnomalies({
    modelReq: 'glm-5.3-flash',
    modelResp: 'glm-5-3-flash',
    usage: { prompt_tokens: 19, completion_tokens: 100, total_tokens: 119 },
    usageRejected: null,
    finishReason: 'stop',
  });
  assert.equal(anomalies.length, 0);
});

test('guard anomaly：真换壳（族名不同）仍报 model_mismatch', () => {
  const anomalies = buildAnomalies({
    modelReq: 'glm-5.3-flash',
    modelResp: 'deepseek-v4-1-flash',
    usage: { prompt_tokens: 19, completion_tokens: 100, total_tokens: 119 },
    usageRejected: null,
    finishReason: 'stop',
  });
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0]?.code, 'model_mismatch');
  assert.equal(anomalies[0]?.level, 'warn');
});

test('身份维度：规范化写法不计入 mismatch（3 请求窗口应给 100 而非 67）', () => {
  const samples: ScoreSample[] = [1, 2, 3].map((id) => ({
    id,
    ts: Date.now(),
    status: 200,
    usage: { prompt_tokens: 19, completion_tokens: 100, total_tokens: 119 },
    usageRejected: null,
    modelReq: 'glm-5.3-flash',
    modelResp: 'glm-5-3-flash',
    ttftMs: 2000,
    aborted: false,
    finishReason: 'stop',
    deepInspect: true,
  }));
  const dims = computeDimensions(samples, null);
  const identity = dims.find((d) => d.id === 'identity');
  assert.ok(identity !== undefined, '身份维度缺失');
  assert.equal(identity.score, 100, `身份维度应为 100，实际 ${String(identity.score)}`);
  assert.equal(identity.level, 'ok');
});

test('身份维度：真换壳仍按 mismatch 计入分母（3 请求中 1 条换壳 → 67）', () => {
  const samples: ScoreSample[] = [1, 2, 3].map((id) => ({
    id,
    ts: Date.now(),
    status: 200,
    usage: { prompt_tokens: 19, completion_tokens: 100, total_tokens: 119 },
    usageRejected: null,
    modelReq: 'glm-5.3-flash',
    modelResp: id === 2 ? 'deepseek-v4-1-flash' : 'glm-5-3-flash',
    ttftMs: 2000,
    aborted: false,
    finishReason: 'stop',
    deepInspect: true,
  }));
  const identity = computeDimensions(samples, null).find((d) => d.id === 'identity');
  assert.equal(identity?.score, 67);
  assert.equal(identity?.level, 'fail');
});
