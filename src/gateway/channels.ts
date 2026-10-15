// src/gateway/channels.ts — 多渠道路由表（纯内存；上游 key 只驻留本进程内存，绝不落盘/回显/日志）。
// 路由语义：model 别名 → 恰好一个渠道，不做回退/重试/熔断；别名冲突在录入时即拒绝。
import { randomUUID } from 'node:crypto';
import { validateUpstreamBaseUrl } from './ssrf.js';

export interface ChannelStats {
  requests: number;
  ok: number;
  errors: number;
  lastStatus: number | null;
  lastErrorAt: number | null;
}

export interface ChannelRecord {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  modelMap: Record<string, string>;
  enabled: boolean;
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
  enabled: boolean;
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

export interface ChannelCreateInput {
  label?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  models?: unknown;
  modelMap?: unknown;
  enabled?: unknown;
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
    const check = validateUpstreamBaseUrl(input.baseUrl);
    if (!check.ok || check.url === null) throw bad(check.message);
    const baseUrl = check.url.toString();
    const apiKey = validateApiKey(input.apiKey, true);
    const models = validateModels(input.models);
    this.assertAliasesFree(models, null);
    const modelMap = validateModelMap(input.modelMap, models);
    const now = Date.now();
    const record: ChannelRecord = {
      id: randomUUID(),
      label: validateLabel(input.label, defaultLabel(baseUrl)),
      baseUrl,
      apiKey: apiKey ?? '',
      models,
      modelMap,
      enabled: validateEnabled(input.enabled, true),
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
    let baseUrl = current.baseUrl;
    if (input.baseUrl !== undefined) {
      const check = validateUpstreamBaseUrl(input.baseUrl);
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
    const apiKey = validateApiKey(input.apiKey, false) ?? current.apiKey;
    const next: ChannelRecord = {
      ...current,
      label: input.label !== undefined ? validateLabel(input.label, current.label) : current.label,
      baseUrl,
      apiKey,
      models,
      modelMap,
      enabled: validateEnabled(input.enabled, current.enabled),
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
      enabled: channel.enabled,
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

/** 记录一次已实际发往上游的请求结果（供渠道状态展示；无探测、无健康声明）。 */
export function noteChannelResult(channel: ChannelRecord, status: number | null): void {
  channel.stats.requests += 1;
  if (status !== null && status >= 200 && status < 300) {
    channel.stats.ok += 1;
  } else {
    channel.stats.errors += 1;
    channel.stats.lastErrorAt = Date.now();
  }
  if (status !== null) channel.stats.lastStatus = status;
}
