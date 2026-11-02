import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateCost } from '../../src/cli.js';
import type { RunConfig } from '../../src/types.js';

function cfg(overrides: Partial<RunConfig>): RunConfig {
  return {
    deep: false,
    claimedContext: 32000,
    expect: [],
    ...overrides,
  } as RunConfig;
}

test('estimateCost: low-cost default (1 sample/depth, 5 billing levels, 9 TTFT calls)', () => {
  const standard = estimateCost(cfg({}));
  assert.equal(standard.calls, 58);
  assert.equal(standard.inputTokens, 239400);
  // --deep 默认 3 轮质量题集：quality 15→45 题 + 复采样上限 12→36，较旧估算 +54 calls
  assert.equal(estimateCost(cfg({ deep: true })).calls, 151);
  // 显式 --quality-samples 3 覆盖标准档（与 --deep 同轮数，但不带 deep 其余扩样）
  assert.equal(estimateCost(cfg({ qualitySamples: 3 })).calls, 112);
  // 显式 1 轮即便叠加 --deep 也只跑 1 轮质量题集（deep 其余扩样保留）
  assert.equal(estimateCost(cfg({ deep: true, qualitySamples: 1 })).calls, 97);
  assert.equal(estimateCost(cfg({ expect: ['vision', 'tool'] })).calls, 63);
  // 统计定论档（用户显式 --context-samples 3）保留 2 发确认复采
  assert.equal(estimateCost(cfg({ contextSamples: 3 })).calls, 72);
});

test('estimateCost: a full reference endpoint adds 26 calls and 12000 input tokens', () => {
  const withReference = estimateCost(
    cfg({
      referenceBaseUrl: 'https://reference.example.com/v1',
      referenceApiKey: 'ref-key',
      referenceModel: 'gpt-4o',
    }),
  );
  assert.equal(withReference.calls, 84);
  assert.equal(withReference.inputTokens, 251400);
});

test('estimateCost: reference quality pairing scales with question-bank rounds (tokenizer 14 fixed)', () => {
  const reference = {
    referenceBaseUrl: 'https://reference.example.com/v1',
    referenceApiKey: 'ref-key',
    referenceModel: 'gpt-4o',
  };
  // 3 轮题集：reference 质量配对 12→36 calls，输入 tokens 12000→36000；tokenizer 恒 14 calls
  const withReference = estimateCost(cfg({ qualitySamples: 3, ...reference }));
  assert.equal(withReference.calls, 112 + 50);
  assert.equal(withReference.inputTokens, 239400 + 36000);
  const deepWithReference = estimateCost(cfg({ deep: true, ...reference }));
  assert.equal(deepWithReference.calls, 151 + 50);
});
