import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectPricingFormat,
  parseLiteLlmFormat,
  parseNewApiPricingFormat,
  parseNewApiRatioConfigFormat,
  parseOpenRouterFormat,
  parsePublicPriceJsonFormat,
} from '../../src/pricing-formats.js';

function closeTo(actual: number | null | undefined, expected: number, epsilon = 1e-9): boolean {
  return typeof actual === 'number' && Math.abs(actual - expected) <= epsilon;
}

test('parseNewApiPricingFormat：data[] 倍率 → 统一 USD/M 价格与分组倍率', () => {
  const parsed = parseNewApiPricingFormat({
    data: [
      {
        model_name: 'gpt-4o',
        model_ratio: 1,
        completion_ratio: 4,
        cache_ratio: 0.25,
        quota_type: 0,
        enable_groups: ['default'],
      },
    ],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.table.format, 'new-api-pricing');
  assert.equal(parsed.table.source, 'api');
  assert.deepEqual(parsed.table.groupRatio, {});
  const model = parsed.table.models['gpt-4o'];
  assert.ok(model);
  assert.equal(model.modelRatio, 1);
  assert.equal(model.completionRatio, 4);
  assert.equal(model.cacheRatio, 0.25);
  assert.equal(model.quotaType, 0);
  assert.equal(parsed.table.prices['gpt-4o']?.inputUsdPerM, 2);
  assert.equal(parsed.table.prices['gpt-4o']?.outputUsdPerM, 8);
  assert.equal(parsed.table.prices['gpt-4o']?.cachedUsdPerM, 0.5);
});

test('parseNewApiRatioConfigFormat：映射表、按次计费、缺省 completion=1、0 倍率跳过', () => {
  const parsed = parseNewApiRatioConfigFormat({
    success: true,
    data: {
      model_ratio: { 'gpt-4o': 1, free: 0, 'per-call': 0 },
      completion_ratio: { 'gpt-4o': 4 },
      model_price: { 'per-call': 0.02 },
      cache_ratio: { 'gpt-4o': 0.25 },
      group_ratio: { default: 0.8 },
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.table.format, 'new-api-ratio-config');
  assert.equal(parsed.table.source, 'api');
  assert.equal(parsed.table.models['gpt-4o']?.completionRatio, 4);
  assert.equal(parsed.table.models['gpt-4o']?.quotaType, 0);
  assert.equal(parsed.table.models['per-call']?.quotaType, 1);
  assert.equal(parsed.table.models['per-call']?.modelPrice, 0.02);
  assert.equal(parsed.table.models['per-call']?.completionRatio, 1);
  assert.equal(parsed.table.models['free'], undefined);
  assert.equal(parsed.table.unusable, 1);
  assert.deepEqual(parsed.table.groupRatio, { default: 0.8 });
  assert.equal(parsed.table.prices['gpt-4o']?.inputUsdPerM, 2);
  assert.equal(parsed.table.prices['gpt-4o']?.outputUsdPerM, 8);
});

test('parseOpenRouterFormat：USD/token 字符串 → USD/M、倍率；request 价按次；免费模型只展示不计锚', () => {
  const parsed = parseOpenRouterFormat({
    data: [
      {
        id: 'openai/gpt-4o',
        pricing: { prompt: '0.0000025', completion: '0.00001', input_cache_read: '0.00000125' },
      },
      { id: 'free/model', pricing: { prompt: '0', completion: '0' } },
      { id: 'per/request', pricing: { request: '0.001' } },
      { id: 'missing/completion', pricing: { prompt: '0.000001' } },
    ],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.table.format, 'openrouter-models');
  assert.equal(parsed.table.source, 'public-json');
  assert.equal(parsed.table.entries, 3);
  assert.equal(parsed.table.skipped, 1);
  assert.equal(parsed.table.unusable, 1);
  assert.ok(closeTo(parsed.table.models['openai/gpt-4o']?.modelRatio, 1.25));
  assert.ok(closeTo(parsed.table.models['openai/gpt-4o']?.completionRatio, 4));
  assert.ok(closeTo(parsed.table.models['openai/gpt-4o']?.cacheRatio, 0.5));
  assert.equal(parsed.table.prices['openai/gpt-4o']?.inputUsdPerM, 2.5);
  assert.equal(parsed.table.prices['openai/gpt-4o']?.outputUsdPerM, 10);
  assert.equal(parsed.table.models['free/model'], undefined);
  assert.equal(parsed.table.prices['free/model']?.inputUsdPerM, 0);
  assert.equal(parsed.table.models['per/request']?.quotaType, 1);
  assert.equal(parsed.table.models['per/request']?.modelPrice, 0.001);
  assert.equal(parsed.table.models['missing/completion'], undefined);
});

test('parseLiteLlmFormat：per-token 与 per-million 两种字段都支持，嵌套 model_info 也能读', () => {
  const parsed = parseLiteLlmFormat({
    data: [
      {
        model_name: 'claude-3',
        model_info: { input_cost_per_token: 0.000003, output_cost_per_token: 0.000015 },
      },
      {
        model_name: 'gpt-4o',
        litellm_params: {
          model_info: { input_cost_per_million_tokens: 2.5, output_cost_per_million_tokens: 10 },
        },
      },
      { model_name: 'no-price', model_info: {} },
    ],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.table.format, 'litellm-model-info');
  assert.equal(parsed.table.entries, 2);
  assert.equal(parsed.table.skipped, 1);
  assert.ok(closeTo(parsed.table.models['claude-3']?.modelRatio, 1.5));
  assert.ok(closeTo(parsed.table.models['claude-3']?.completionRatio, 5));
  assert.ok(closeTo(parsed.table.models['gpt-4o']?.modelRatio, 1.25));
  assert.equal(parsed.table.prices['claude-3']?.inputUsdPerM, 3);
  assert.equal(parsed.table.prices['claude-3']?.outputUsdPerM, 15);
});

test('parsePublicPriceJsonFormat：公开价表 schema 复用，保留列表价', () => {
  const parsed = parsePublicPriceJsonFormat({
    items: [
      {
        code: 'glm-5.3-flash',
        price_input_usd: '0.2400',
        price_output_usd: '0.8400',
        price_list_input_usd: '0.8000',
        price_list_output_usd: '2.8000',
      },
    ],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.table.format, 'public-price-json');
  assert.equal(parsed.table.source, 'public-json');
  assert.ok(closeTo(parsed.table.models['glm-5.3-flash']?.modelRatio, 0.12));
  assert.equal(parsed.table.prices['glm-5.3-flash']?.listInputUsdPerM, 0.8);
});

test('detectPricingFormat：ratio_config 映射表不会被误判为 /api/pricing 数组格式', () => {
  const parsed = detectPricingFormat({
    success: true,
    data: { model_ratio: { 'gpt-4o': 1 }, completion_ratio: { 'gpt-4o': 4 } },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.table.format, 'new-api-ratio-config');
});

test('detectPricingFormat：未知 schema → 明确失败，不猜价', () => {
  const parsed = detectPricingFormat({ hello: 'world' });
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.reason, /未识别为已知价格格式/);
});
