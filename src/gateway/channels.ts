// src/gateway/channels.ts — 多渠道路由表（纯内存；上游 key 只驻留本进程内存，绝不落盘/回显/日志）。
// 路由语义：model 别名 → 恰好一个渠道，不做回退/重试/熔断；别名冲突在录入时即拒绝。
import { randomUUID } from 'node:crypto';
import { validateUpstreamBaseUrl } from './ssrf.js';
import type { ModelPrice } from './pricing.js';

export interface ChannelStats {
  requests: number;
  ok: number;
  errors: number;
  lastStatus: number | null;
  lastErrorAt: number | null;
}

/** 渠道上游协议：unified=统一中转站（按客户端请求格式透传：chat/responses/messages 均支持）；openai=仅 OpenAI 兼容（chat/responses）；anthropic=仅 Anthropic Messages。 */
export type ChannelProtocol = 'unified' | 'openai' | 'anthropic';

export interface ChannelRecord {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  modelMap: Record<string, string>;
  /** 逐模型价格（USD/百万 tokens；未录价 = 无此键，账本金额恒 NULL，绝不显示误导性的 $0）；键必须 ∈ models。 */
  modelPrices: Record<string, ModelPrice>;
  protocol: ChannelProtocol;
  enabled: boolean;
  /** 渠道级 opt-in：允许上游为本机/内网 IPv4 字面量（默认 false；域名仍必须解析到公网）。 */
  allowPrivateUpstream: boolean;
  createdAt: number;
  updatedAt: number;
  stats: ChannelStats;
}

/** 对外视图：绝不包含 apiKey（hasKey 恒为 true，仅表示已配置）。 */
export interface ChannelView {
  id: string;
  label: string;
  baseUrl: string;
  models: string[];
  modelMap: Record<string, string>;
  modelPrices: Record<string, ModelPrice>;
  protocol: ChannelProtocol;
  enabled: boolean;
  allowPrivateUpstream: boolean;
  hasKey: true;
  createdAt: number;
  updatedAt: number;
  stats: ChannelStats;
}

export class ChannelError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ChannelError';
  }
}

const MODEL_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MAX_MODELS = 50;
const MAX_KEY_CHARS = 512;

function bad(message: string): ChannelError {
  return new ChannelError(400, message);
}

function validateApiKey(raw: unknown, required: boolean): string | null {
  if (raw === undefined || raw === null) {
    if (required) {
      throw bad(`apiKey 必填：收到值 ${JSON.stringify(raw ?? null)}。示例：sk-xxx（仅存于本机内存，绝不回显/落盘）`);
    }
    return null;
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw bad(`apiKey 必须为非空字符串：收到值 ${JSON.stringify(raw)}。示例：sk-xxx`);
  }
  const value = raw.trim();
  if (value.length > MAX_KEY_CHARS) {
    throw bad(`apiKey 过长（上限 ${MAX_KEY_CHARS} 字符）：收到 ${value.length} 字符。示例：sk-xxx`);
  }
  if (/[\0-\x1f\x7f]/.test(value)) {
    throw bad('apiKey 含控制字符，已拒绝。请检查复制时是否混入换行/转义字符。示例：sk-xxx');
  }
  return value;
}

function validateModels(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw bad(`models 必须为非空数组（客户端可见的 model 别名）：收到值 ${JSON.stringify(raw ?? null)}。示例：["gpt-4o","deepseek-chat"]`);
  }
  if (raw.length > MAX_MODELS) {
    throw bad(`models 最多 ${MAX_MODELS} 个：收到 ${raw.length} 个。示例：["gpt-4o","deepseek-chat"]`);
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw bad(`models 元素必须为非空字符串：收到值 ${JSON.stringify(item ?? null)}。示例：["gpt-4o","deepseek-chat"]`);
    }
    const alias = item.trim();
    if (!MODEL_ALIAS_PATTERN.test(alias)) {
      throw bad(`model 别名非法（仅允许字母/数字开头，后接字母数字与 . _ : / -，最长 128）：收到值 ${JSON.stringify(alias)}。示例：gpt-4o`);
    }
    if (out.includes(alias)) {
      throw bad(`models 存在重复别名：${JSON.stringify(alias)}。请去重后重试。示例：["gpt-4o","deepseek-chat"]`);
    }
    out.push(alias);
  }
  return out;
}

function validateModelMap(raw: unknown, models: string[]): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw bad(`modelMap 必须为对象（别名 → 上游真实模型名）：收到值 ${JSON.stringify(raw)}。示例：{"gpt-4o":"actual-upstream-model"}`);
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > models.length) {
    throw bad(`modelMap 条目数（${entries.length}）不得超过 models 数量（${models.length}）。示例：{"gpt-4o":"actual-upstream-model"}`);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!models.includes(key)) {
      throw bad(`modelMap 键 ${JSON.stringify(key)} 不在本渠道 models 中。示例：{"gpt-4o":"actual-upstream-model"}`);
    }
    if (typeof value !== 'string' || value.trim() === '' || !MODEL_ALIAS_PATTERN.test(value.trim())) {
      throw bad(`modelMap 的值必须为合法上游模型名：收到值 ${JSON.stringify(value ?? null)}。示例：{"gpt-4o":"actual-upstream-model"}`);
    }
    out[key] = value.trim();
  }
  return out;
}

/** modelPrices 允许的字段白名单（与前端 buildModelPrices 同口径；服务端为准）。 */
const MODEL_PRICE_KEYS = ['input', 'output', 'cachedRead', 'threshold', 'input2', 'output2', 'cachedRead2'] as const;
const MODEL_PRICE_EXAMPLE = '{"gpt-4o":{"input":2.5,"output":10}}';
const MODEL_PRICE_TIER_EXAMPLE = '{"gpt-4o":{"input":2.5,"output":10,"threshold":1000000,"input2":5,"output2":20}}';

/**
 * modelPrices 严格校验（单位 USD/百万 tokens；计费选填：不填 = 未录价，金额恒 NULL）：
 * 键必须 ∈ models；值须为对象且只含白名单字段；input/output 成对必填（非负有限数，0 = 免费合法）；
 * cachedRead 可选（非负）；阶梯 threshold/input2/output2 必须同时提供（threshold 为正安全整数 tokens、
 * input2/output2 非负），cachedRead2 仅阶梯存在时可用。所有错误带字段路径 + 收到值 + 示例。
 */
function validateModelPrices(raw: unknown, models: string[]): Record<string, ModelPrice> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw bad(`modelPrices 必须为对象（模型别名 → 价格；单位 USD/百万 tokens）：收到值 ${JSON.stringify(raw)}。示例：${MODEL_PRICE_EXAMPLE}`);
  }
  const out: Record<string, ModelPrice> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!models.includes(key)) {
      throw bad(`modelPrices 键不在本渠道 models 中：收到键 ${JSON.stringify(key)}。示例：${MODEL_PRICE_EXAMPLE}`);
    }
    out[key] = validateOneModelPrice(value, key);
  }
  return out;
}

/** 单个价格数字：缺失（undefined/null）返回 null；其余必须为非负有限数，否则 400（带路径、收到值、示例）。 */
function priceNumber(raw: unknown, path: string, example: string): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    throw bad(`${path} 必须为不小于 0 的数字：收到值 ${JSON.stringify(raw)}。示例：${example}`);
  }
  return raw;
}

/** 单个模型价格条目校验；返回仅含显式提供字段的对象（缺省可选字段不落键，线协议保持最小）。 */
function validateOneModelPrice(raw: unknown, alias: string): ModelPrice {
  const path = `modelPrices[${JSON.stringify(alias)}]`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw bad(`${path} 必须为对象：收到值 ${JSON.stringify(raw ?? null)}。示例：${MODEL_PRICE_EXAMPLE}`);
  }
  const rec = raw as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (!(MODEL_PRICE_KEYS as readonly string[]).includes(key)) {
      throw bad(`${path} 含未知字段：收到值 ${JSON.stringify(key)}（仅支持 ${MODEL_PRICE_KEYS.join('/')}）。示例：${MODEL_PRICE_EXAMPLE}`);
    }
  }
  const input = priceNumber(rec['input'], `${path}.input`, MODEL_PRICE_EXAMPLE);
  const output = priceNumber(rec['output'], `${path}.output`, MODEL_PRICE_EXAMPLE);
  if (input === null || output === null) {
    throw bad(`${path} 的 input 与 output 必须成对填写（0 = 免费）：收到值 ${JSON.stringify(rec)}。示例：${MODEL_PRICE_EXAMPLE}`);
  }
  const hasThreshold = rec['threshold'] !== undefined && rec['threshold'] !== null;
  const hasInput2 = rec['input2'] !== undefined && rec['input2'] !== null;
  const hasOutput2 = rec['output2'] !== undefined && rec['output2'] !== null;
  const hasCachedRead2 = rec['cachedRead2'] !== undefined && rec['cachedRead2'] !== null;
  const tierCount = [hasThreshold, hasInput2, hasOutput2].filter(Boolean).length;
  if (tierCount !== 0 && tierCount !== 3) {
    throw bad(`${path} 的阶梯价必须 threshold/input2/output2 同时提供：收到值 ${JSON.stringify(rec)}。示例：${MODEL_PRICE_TIER_EXAMPLE}`);
  }
  if (hasCachedRead2 && tierCount !== 3) {
    throw bad(`${path}.cachedRead2 仅在提供阶梯价（threshold/input2/output2）时可用：收到值 ${JSON.stringify(rec)}。示例：${MODEL_PRICE_TIER_EXAMPLE}`);
  }
  const price: ModelPrice = { input, output };
  const cachedRead = priceNumber(rec['cachedRead'], `${path}.cachedRead`, MODEL_PRICE_EXAMPLE);
  if (cachedRead !== null) price.cachedRead = cachedRead;
  if (tierCount === 3) {
    const threshold = rec['threshold'];
    if (typeof threshold !== 'number' || !Number.isSafeInteger(threshold) || threshold <= 0) {
      throw bad(`${path}.threshold 必须为正整数（tokens）：收到值 ${JSON.stringify(threshold ?? null)}。示例：${MODEL_PRICE_TIER_EXAMPLE}`);
    }
    const input2 = priceNumber(rec['input2'], `${path}.input2`, MODEL_PRICE_TIER_EXAMPLE);
    const output2 = priceNumber(rec['output2'], `${path}.output2`, MODEL_PRICE_TIER_EXAMPLE);
    if (input2 === null || output2 === null) {
      throw bad(`${path} 的阶梯价必须 threshold/input2/output2 同时提供：收到值 ${JSON.stringify(rec)}。示例：${MODEL_PRICE_TIER_EXAMPLE}`);
    }
    price.threshold = threshold;
    price.input2 = input2;
    price.output2 = output2;
    const cachedRead2 = priceNumber(rec['cachedRead2'], `${path}.cachedRead2`, MODEL_PRICE_TIER_EXAMPLE);
    if (cachedRead2 !== null) price.cachedRead2 = cachedRead2;
  }
  return price;
}

function validateLabel(raw: unknown, fallback: string): string {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw bad(`label 必须为非空字符串：收到值 ${JSON.stringify(raw)}。示例：主渠道`);
  }
  const value = raw.trim();
  if (value.length > 64 || /[\0-\x1f\x7f]/.test(value)) {
    throw bad(`label 非法（最长 64 字符、无控制字符）：收到值 ${JSON.stringify(value)}。示例：主渠道`);
  }
  return value;
}

function defaultLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return 'channel';
  }
}

/** enabled 严格布尔：字符串 "true"/"false" 一律 400（静默强转会让用户以为启用实际停用）。 */
function validateEnabled(raw: unknown, fallback: boolean): boolean {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'boolean') {
    throw bad(`enabled 必须为布尔值 true/false（缺省 = ${fallback ? '启用' : '保持当前'}）：收到值 ${JSON.stringify(raw)}。示例：true`);
  }
  return raw;
}

/** allowPrivateUpstream 严格布尔：字符串 "true"/1 一律 400（静默强转会让用户误判上游是否被放行）。 */
function validateAllowPrivateUpstream(raw: unknown, fallback: boolean): boolean {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'boolean') {
    throw bad(`allowPrivateUpstream 必须为布尔值 true/false（缺省 = ${fallback ? '保持允许本机/内网上游' : '不允许本机/内网上游'}）：收到值 ${JSON.stringify(raw)}。示例：true`);
  }
  return raw;
}

/** protocol 严格枚举：null/缺省取 fallback；其余非 "unified"/"openai"/"anthropic" 一律 400（静默强转会把协议走错路由）。 */
function validateProtocol(raw: unknown, fallback: ChannelProtocol): ChannelProtocol {
  if (raw === undefined || raw === null) return fallback;
  if (raw !== 'unified' && raw !== 'openai' && raw !== 'anthropic') {
    throw bad(
      `protocol 必须为 "unified"、"openai" 或 "anthropic"（缺省 = ${fallback}；unified 为统一中转：按客户端请求格式透传）：收到值 ${JSON.stringify(raw)}。示例："unified" 或 "openai" 或 "anthropic"`,
    );
  }
  return raw;
}

export interface ChannelCreateInput {
  label?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  models?: unknown;
  modelMap?: unknown;
  modelPrices?: unknown;
  protocol?: unknown;
  enabled?: unknown;
  allowPrivateUpstream?: unknown;
}

export type ChannelUpdateInput = ChannelCreateInput;

export class ChannelStore {
  private readonly channels = new Map<string, ChannelRecord>();

  list(): ChannelRecord[] {
    return [...this.channels.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): ChannelRecord | null {
    return this.channels.get(id) ?? null;
  }

  /** 按别名查启用渠道；不做回退——一个别名只映射一个渠道。 */
  findByAlias(alias: string): ChannelRecord | null {
    for (const channel of this.channels.values()) {
      if (channel.enabled && channel.models.includes(alias)) return channel;
    }
    return null;
  }

  create(input: ChannelCreateInput): ChannelRecord {
    const allowPrivateUpstream = validateAllowPrivateUpstream(input.allowPrivateUpstream, false);
    const check = validateUpstreamBaseUrl(input.baseUrl, { allowPrivate: allowPrivateUpstream });
    if (!check.ok || check.url === null) throw bad(check.message);
    const baseUrl = check.url.toString();
    const apiKey = validateApiKey(input.apiKey, true);
    const models = validateModels(input.models);
    this.assertAliasesFree(models, null);
    const modelMap = validateModelMap(input.modelMap, models);
    const modelPrices = validateModelPrices(input.modelPrices, models);
    const now = Date.now();
    const record: ChannelRecord = {
      id: randomUUID(),
      label: validateLabel(input.label, defaultLabel(baseUrl)),
      baseUrl,
      apiKey: apiKey ?? '',
      models,
      modelMap,
      modelPrices,
      protocol: validateProtocol(input.protocol, 'unified'),
      enabled: validateEnabled(input.enabled, true),
      allowPrivateUpstream,
      createdAt: now,
      updatedAt: now,
      stats: { requests: 0, ok: 0, errors: 0, lastStatus: null, lastErrorAt: null },
    };
    this.channels.set(record.id, record);
    return record;
  }

  update(id: string, input: ChannelUpdateInput): ChannelRecord {
    const current = this.channels.get(id);
    if (current === undefined) {
      throw new ChannelError(404, `未找到渠道 ${JSON.stringify(id)}（可能已被删除）。示例：先用 GET /api/gateway/channels 列出有效 id。`);
    }
    const allowPrivateUpstream = validateAllowPrivateUpstream(input.allowPrivateUpstream, current.allowPrivateUpstream);
    let baseUrl = current.baseUrl;
    if (input.baseUrl !== undefined) {
      const check = validateUpstreamBaseUrl(input.baseUrl, { allowPrivate: allowPrivateUpstream });
      if (!check.ok || check.url === null) throw bad(check.message);
      baseUrl = check.url.toString();
    }
    let models = current.models;
    if (input.models !== undefined) {
      models = validateModels(input.models);
      this.assertAliasesFree(models, id);
    }
    let modelMap = current.modelMap;
    if (input.modelMap !== undefined) {
      modelMap = validateModelMap(input.modelMap, models);
    } else if (input.models !== undefined) {
      // models 变更后，旧 modelMap 键必须仍在 models 内，否则静默失效会误导用户
      modelMap = validateModelMap(current.modelMap, models);
    }
    let modelPrices = current.modelPrices;
    if (input.modelPrices !== undefined) {
      modelPrices = validateModelPrices(input.modelPrices, models);
    } else if (input.models !== undefined) {
      // models 变更后，旧 modelPrices 键必须仍在 models 内（显式 400 而不是静默清空/失效）
      modelPrices = validateModelPrices(current.modelPrices, models);
    }
    const apiKey = validateApiKey(input.apiKey, false) ?? current.apiKey;
    const next: ChannelRecord = {
      ...current,
      label: input.label !== undefined ? validateLabel(input.label, current.label) : current.label,
      baseUrl,
      apiKey,
      models,
      modelMap,
      modelPrices,
      protocol: validateProtocol(input.protocol, current.protocol),
      enabled: validateEnabled(input.enabled, current.enabled),
      allowPrivateUpstream,
      updatedAt: Date.now(),
    };
    this.channels.set(id, next);
    return next;
  }

  remove(id: string): boolean {
    return this.channels.delete(id);
  }

  view(channel: ChannelRecord): ChannelView {
    return {
      id: channel.id,
      label: channel.label,
      baseUrl: channel.baseUrl,
      models: [...channel.models],
      modelMap: { ...channel.modelMap },
      modelPrices: { ...channel.modelPrices },
      protocol: channel.protocol,
      enabled: channel.enabled,
      allowPrivateUpstream: channel.allowPrivateUpstream,
      hasKey: true,
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt,
      stats: { ...channel.stats },
    };
  }

  private assertAliasesFree(models: string[], selfId: string | null): void {
    for (const channel of this.channels.values()) {
      if (channel.id === selfId) continue;
      for (const alias of models) {
        if (channel.models.includes(alias)) {
          throw bad(
            `model 别名 ${JSON.stringify(alias)} 已被渠道 ${JSON.stringify(channel.label)}（${channel.id}）使用；` +
              '一个别名只能路由到一个渠道（网关不做回退/负载均衡），请更换别名或先删除该渠道。',
          );
        }
      }
    }
  }
}

/** 记录一次已实际发往上游的请求结果（供渠道状态展示；无探测、无健康声明）。
 *  errorSource='client'（客户端主动断开）不计错误——渠道无责，绝不冤枉渠道（与账本 error_source 归因同口径）。 */
export function noteChannelResult(channel: ChannelRecord, status: number | null, errorSource?: 'upstream' | 'gateway' | 'client' | null): void {
  channel.stats.requests += 1;
  if (status !== null && status >= 200 && status < 300) {
    channel.stats.ok += 1;
  } else if (errorSource === 'client') {
    // 客户端断开：只计数，不计入渠道错误/lastErrorAt
  } else {
    channel.stats.errors += 1;
    channel.stats.lastErrorAt = Date.now();
  }
  if (status !== null) channel.stats.lastStatus = status;
}
