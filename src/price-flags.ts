import type { ModelPrice } from './gateway/pricing.js';

export const PRICE_FLAG_NAMES = [
  'price-input',
  'price-output',
  'price-cached-read',
  'price-threshold',
  'price-input2',
  'price-output2',
  'price-cached-read2',
] as const;

export type PriceFlagName = (typeof PRICE_FLAG_NAMES)[number];
export type PriceFlagValues = Partial<Record<PriceFlagName, string | undefined>>;

export interface PriceFlagsResult {
  price: ModelPrice | null;
  error: string | null;
}

const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

function invalid(name: PriceFlagName, raw: string, rule: string, example: string): PriceFlagsResult {
  return { price: null, error: `--${name} ${rule}。收到：${JSON.stringify(raw)}。示例：--${name} ${example}` };
}

function parsePositive(values: PriceFlagValues, name: PriceFlagName, example: string): { value: number | null; error: string | null } {
  const raw = values[name];
  if (raw === undefined) return { value: null, error: null };
  if (!DECIMAL.test(raw)) {
    return { value: null, error: invalid(name, raw, '必须为正数（每百万 tokens 宣称价格，0 与负数无效）', example).error };
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return { value: null, error: invalid(name, raw, '必须为正数（每百万 tokens 宣称价格，0 与负数无效）', example).error };
  }
  return { value, error: null };
}

function parseNonNegative(values: PriceFlagValues, name: PriceFlagName, example: string): { value: number | null; error: string | null } {
  const raw = values[name];
  if (raw === undefined) return { value: null, error: null };
  if (!DECIMAL.test(raw)) {
    return { value: null, error: invalid(name, raw, '必须为不小于 0 的数字（每百万 tokens 单价）', example).error };
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    return { value: null, error: invalid(name, raw, '必须为不小于 0 的数字（每百万 tokens 单价）', example).error };
  }
  return { value, error: null };
}

/** 解析 test 的一次性计费核价 flag（缓存读 + 可选二档阶梯），核心输入/输出必须成对。 */
export function parsePriceFlags(values: PriceFlagValues): PriceFlagsResult {
  const corePresent = values['price-input'] !== undefined || values['price-output'] !== undefined;
  const optionalPresent = PRICE_FLAG_NAMES.some((name) => name !== 'price-input' && name !== 'price-output' && values[name] !== undefined);
  if (!corePresent) {
    if (!optionalPresent) return { price: null, error: null };
    return {
      price: null,
      error: '--price-input 与 --price-output 必须成对出现（缓存读与阶梯价为可选补充）。示例：--price-input 2.5 --price-output 10',
    };
  }
  if (values['price-input'] === undefined || values['price-output'] === undefined) {
    return {
      price: null,
      error: '--price-input 与 --price-output 必须成对出现。示例：--price-input 2.5 --price-output 10',
    };
  }

  const input = parsePositive(values, 'price-input', '2.5');
  if (input.error !== null) return { price: null, error: input.error };
  const output = parsePositive(values, 'price-output', '10');
  if (output.error !== null) return { price: null, error: output.error };
  const cachedRead = parseNonNegative(values, 'price-cached-read', '0.5');
  if (cachedRead.error !== null) return { price: null, error: cachedRead.error };

  const tierNames: PriceFlagName[] = ['price-threshold', 'price-input2', 'price-output2'];
  const tierPresent = tierNames.filter((name) => values[name] !== undefined);
  const cachedRead2Raw = values['price-cached-read2'];
  if (tierPresent.length > 0 && tierPresent.length !== tierNames.length) {
    return {
      price: null,
      error:
        '--price-threshold、--price-input2、--price-output2 必须成组出现。示例：--price-threshold 1000000 --price-input2 6 --price-output2 22.5',
    };
  }
  if (tierPresent.length === 0 && cachedRead2Raw !== undefined) {
    return {
      price: null,
      error: '--price-cached-read2 仅在提供阶梯价（--price-threshold/--price-input2/--price-output2）时可用。示例：--price-threshold 1000000 --price-input2 6 --price-output2 22.5 --price-cached-read2 0.75',
    };
  }

  const price: ModelPrice = { input: input.value as number, output: output.value as number };
  if (cachedRead.value !== null) price.cachedRead = cachedRead.value;
  if (tierPresent.length === tierNames.length) {
    const thresholdRaw = values['price-threshold'] as string;
    if (!/^\d+$/.test(thresholdRaw)) {
      return { price: null, error: invalid('price-threshold', thresholdRaw, '必须为正整数 tokens', '1000000').error };
    }
    const threshold = Number(thresholdRaw);
    if (!Number.isSafeInteger(threshold) || threshold <= 0) {
      return { price: null, error: invalid('price-threshold', thresholdRaw, '必须为正整数 tokens', '1000000').error };
    }
    const input2 = parsePositive(values, 'price-input2', '6');
    if (input2.error !== null) return { price: null, error: input2.error };
    const output2 = parsePositive(values, 'price-output2', '22.5');
    if (output2.error !== null) return { price: null, error: output2.error };
    const cachedRead2 = parseNonNegative(values, 'price-cached-read2', '0.75');
    if (cachedRead2.error !== null) return { price: null, error: cachedRead2.error };
    price.threshold = threshold;
    price.input2 = input2.value as number;
    price.output2 = output2.value as number;
    if (cachedRead2.value !== null) price.cachedRead2 = cachedRead2.value;
  }

  return { price, error: null };
}
