// src/pricing-scrape.ts — 站点公示价的网页兜底抓取（无 /api/pricing 时的降级路径）。
// 审计动机：不少中转站不开放价格接口，金额侧只能停在「计费形状可信」。若站点在网页上公示了
// 模型单价，抓下来就能把「无锚点」升级成「有公示锚点」，恢复公示价 vs 宣称价的对比。
// 但网页价只是站点自述，不是实收：它查不出「公示价 ≠ 实际扣费」的暗扣，倍率真值仍须余额实扣对账。
//
// 解析立场：宁可漏报，不可误报。一条错价会在报告里变成对诚实站点的指控，因此只有
// 「币种 + 每百万 tokens」语境同时成立时数字才算价格；币种或输入/输出归属有歧义时字段留 null、
// confidence 降级，绝不猜一个值。网页会改版，抓到的 html 原样返回给调用方落盘作证据。
//
// 安全边界：只请求与 origin 同源的页面；绝不携带 Authorization / Cookie / 任何凭证；
// 不跟随重定向（防止把探测流量导向第三方）；响应体硬限 512KB；超时由 AbortController 控制。

import { deriveOrigin } from './pricing.js';

/** 响应体上限：与 src/pricing.ts 的公示价 JSON 同口径（512KB）。HTML 价目页远小于此，超出视为异常页面。 */
const PRICE_PAGE_BODY_LIMIT_BYTES = 512 * 1024;
/** 返回给报告的条目上限：页面最多 512KB，恶意页可塞上万行；超出只截断 entries，matched 不受影响。 */
const MAX_SCRAPE_ENTRIES = 500;
/** 模型名邻近推断的窗口：价格行向上最多回溯多少个文本行找模型名（只用于 confidence=nearby）。 */
const NEARBY_WINDOW_ROWS = 3;

/**
 * 候选价格页（按探测顺序）。
 * 只放少量常见路径：每次探测都是一次对攻击者主机的真实请求，候选越多越慢、噪声越大。
 *   /pricing          new-api / one-api 系控制台与不少分支默认的价目页
 *   /price            常见别名
 *   /models           模型列表页，部分站点在此附单价
 *   /console/pricing  控制台路由
 * 不做根路径与全站爬取：根页通常是落地页，既重又与审计无关。
 */
export const PRICE_PAGE_CANDIDATES: readonly string[] = ['/pricing', '/price', '/models', '/console/pricing'];

/** 页面里解析出的单条价格证据。 */
export interface ScrapePriceEntry {
  /** 页面原文里的模型名（表格行取模型格原文；邻近推断取页面上的模型 token）。 */
  modelName: string;
  /** 仅当页面明确是 USD 且能解析出输入价时为数字；CNY/歧义一律 null。 */
  inputUsdPerM: number | null;
  /** 仅当页面明确是 USD 且能解析出输出价时为数字；CNY/歧义一律 null。 */
  outputUsdPerM: number | null;
  /** 页面币种：¥/元/RMB/CNY 一律 CNY，绝不换算成 USD；两种币种同行出现时该行不被采信。 */
  currency: 'USD' | 'CNY' | 'unknown';
  /** table = 表格行命中；nearby = 模型名邻近文本推断。 */
  confidence: 'table' | 'nearby';
  /** 命中的原始文本行（表格行以 " | " 连接单元格），供审计复核。 */
  rawLine: string;
}

/** 网页抓价结果。调用方据 state 决定是否把网页价升级为「公示锚点」。 */
export interface ScrapePricingResult {
  /** ok = 抓到页面且至少解析出一条价格；not_applicable = 能力边界；failed = 抓取异常。 */
  state: 'ok' | 'not_applicable' | 'failed';
  /** not_applicable/failed 时必填，ok 时为 null。 */
  reason: string | null;
  /** 实际抓到的页面路径（相对 origin）；未抓到页面时为 null。 */
  page: string | null;
  /** 抓到的原始 HTML（调用方落盘作证据）；无则 null。 */
  html: string | null;
  /** 页面中解析出的价格条目（可能为空数组）。 */
  entries: ScrapePriceEntry[];
  /** 目标模型的命中条目；无则 null（页面有价但目标不在其中同样为 null，不得据此推断价格）。 */
  matched: ScrapePriceEntry | null;
}

export interface ScrapeOptions {
  /** 单次 GET 超时（公示价页面不重试）。 */
  timeoutMs: number;
  /** 用户显式指定：相对 origin 的路径或同源绝对 URL；跨源一律拒绝。 */
  pricePage?: string | null;
}

/** "SPA shell" 的固定说明：网页价需要 JS 渲染时只能承认能力边界，不能假装读到了价格。 */
const JS_RENDER_REASON =
  '页面疑似前端渲染（SPA shell）：抓到的 HTML 不含价格文本，需启用 JS 渲染才能读取公示价（本工具不做 JS 渲染）';

/**
 * 币种标记。CNY 的「元」只认紧跟在数字后的价格写法（"14 元"），避免把「计费单元」「元数据」
 * 误判成 CNY；「美元」中的「元」也因此天然排除。
 */
const USD_MARKER = /\$|\bUSD\b|美元/i;
const CNY_MARKER = /[¥￥]|\bRMB\b|\bCNY\b|人民币|\d\s*元/i;

/**
 * 每百万 tokens 口径。只认明确写法：/M、/1M、per 1M、1M tokens、每百万、百万tokens。
 * 刻意不认 /1K、/千 tokens、per 1K：单位差 1000 倍，认错就是灾难性误报。
 */
const PER_MILLION_HINT = /\/\s*1?\s*m\b|\bper\s*1\s*m\b|\b1\s*m\s*tokens?\b|每百万|百万\s*tokens?/i;
/** 每千 tokens 口径：与每百万同时出现说明页面混排单位，整行放弃（不做 ×1000 猜测）。 */
const PER_THOUSAND_HINT = /\/\s*1?\s*k\b|\bper\s*1\s*k\b|\b1\s*k\s*tokens?\b|每千/i;

/** 折扣/按次/范围等价格写法：出现时不得把「两个数字」当成输入/输出两列。 */
const PAIRING_HAZARD = /原价|优惠|折扣|折后|促销|按次|\bsave\b|\bwas\b|\boff\b|\bdiscount\b|\bper\s*(?:request|call|image)\b|\/\s*(?:request|call|image|次)/i;
/** 两个数字之间只有范围连接符（"$2.5 - $10"）时是区间，不是两列价格。 */
const RANGE_BETWEEN = /^\s*(?:[-–—~～]|至|到)\s*$/;

interface PricePattern {
  currency: 'USD' | 'CNY';
  re: RegExp;
}

/** 价格必须与币种符号/代码相邻；裸数字永远不采信（可能是上下文长度、日期、并发数）。 */
const PRICE_PATTERNS: readonly PricePattern[] = [
  { currency: 'USD', re: /\$\s*(\d+(?:\.\d+)?)/g },
  { currency: 'USD', re: /\bUSD\s*(\d+(?:\.\d+)?)/gi },
  { currency: 'USD', re: /(\d+(?:\.\d+)?)\s*(?:USD|美元)/gi },
  { currency: 'CNY', re: /[¥￥]\s*(\d+(?:\.\d+)?)/g },
  { currency: 'CNY', re: /\b(?:RMB|CNY)\s*(\d+(?:\.\d+)?)/gi },
  { currency: 'CNY', re: /人民币\s*(\d+(?:\.\d+)?)/g },
  { currency: 'CNY', re: /(\d+(?:\.\d+)?)\s*(?:元|人民币|RMB|CNY)/gi },
];

type PriceField = 'input' | 'output' | 'cache';

/** 输入/输出标签。缓存单独归类：缓存价既不是输入价也不是输出价，必须排除而不是就近误挂。 */
const LABEL_PATTERNS: readonly { field: PriceField; re: RegExp }[] = [
  { field: 'cache', re: /缓存|\bcache\b/gi },
  { field: 'input', re: /输入|\binput\b|\bprompt\b/gi },
  { field: 'output', re: /输出|\boutput\b|\bcompletion\b|生成/g },
];

interface PriceOccurrence {
  value: number;
  currency: 'USD' | 'CNY';
  start: number;
  end: number;
}

interface LabelHit {
  field: PriceField;
  index: number;
}

interface RawRow {
  kind: 'table' | 'line';
  text: string;
  cells: string[];
  /** 表格序号（同一 <table> 内一致，用于表头口径的作用域隔离）；文本行为 null。 */
  tableId: number | null;
}

interface PricedRow {
  kind: 'table' | 'line';
  /** 在原始行序列中的位置，用于模型名邻近回溯。 */
  rowIndex: number;
  rawLine: string;
  modelName: string;
  input: number | null;
  output: number | null;
  currency: 'USD' | 'CNY';
}

interface PageAnalysis {
  entries: ScrapePriceEntry[];
  matched: ScrapePriceEntry | null;
}

type ScrapeFetch =
  | { kind: 'ok'; html: string }
  | { kind: 'not_found' }
  | { kind: 'redirect'; status: number }
  | { kind: 'http_error'; status: number }
  | { kind: 'timeout' }
  | { kind: 'too_large'; bytes: number }
  | { kind: 'network'; message: string };

interface BaseInfo {
  /** 同源判定基准（scheme + host + port）。 */
  origin: string;
  /** 实际拼接基准：保留反向代理前缀（deriveOrigin 可能带 /foo）。 */
  baseUrl: string;
}

type ResolvedPage =
  | { kind: 'ok'; url: string }
  | { kind: 'cross_origin' }
  | { kind: 'invalid' };

class BodyTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`响应体 ${bytes} 字节超过上限 ${PRICE_PAGE_BODY_LIMIT_BYTES}`);
    this.name = 'BodyTooLargeError';
  }
}

function parseBase(origin: string): BaseInfo | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  // 站点根口径：与 pricing.ts / balance.ts 同一套 deriveOrigin（剥掉末尾的 API 版本段 /v1 等）。
  // baseUrl 形如 https://host/v1 时，价目页在站点根 https://host/pricing——不剥就会去请求
  // https://host/v1/pricing（真实站点 404），网页价兜底在真实 baseUrl 下永远失效。
  let root: string;
  try {
    root = deriveOrigin(url.toString());
  } catch {
    root = url.origin;
  }
  const rootUrl = new URL(root);
  const prefix = rootUrl.pathname.replace(/\/+$/, '');
  return { origin: rootUrl.origin, baseUrl: `${rootUrl.origin}${prefix}` };
}

/** 解析用户显式指定的价格页：绝对 URL 只在同源时接受，跨源直接拒绝（不发起任何请求）。 */
function resolveExplicitPage(base: BaseInfo, raw: string): ResolvedPage {
  let url: URL;
  try {
    url = new URL(raw, `${base.baseUrl}/`);
  } catch {
    return { kind: 'invalid' };
  }
  if (url.username !== '' || url.password !== '') return { kind: 'invalid' };
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { kind: 'invalid' };
  if (url.origin !== base.origin) return { kind: 'cross_origin' };
  url.hash = '';
  return { kind: 'ok', url: url.toString() };
}

function pagePath(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

/** 镜像 src/pricing.ts 的 readLimitedBody：content-length 预检 + 流式读取超限即 cancel。 */
async function readLimitedBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > PRICE_PAGE_BODY_LIMIT_BYTES) {
    throw new BodyTooLargeError(declaredLength);
  }
  const body = response.body;
  if (body === null) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > PRICE_PAGE_BODY_LIMIT_BYTES) {
      await reader.cancel();
      throw new BodyTooLargeError(total);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 同源 GET：只声明 accept: text/html，不带任何凭证，不跟随重定向；失败折叠成可判定分类。 */
async function getHtml(url: string, timeoutMs: number): Promise<ScrapeFetch> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'text/html' },
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => undefined);
      return { kind: 'redirect', status: response.status };
    }
    if (response.status === 404) {
      void response.body?.cancel().catch(() => undefined);
      return { kind: 'not_found' };
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return { kind: 'http_error', status: response.status };
    }
    return { kind: 'ok', html: await readLimitedBody(response) };
  } catch (error) {
    if (controller.signal.aborted) return { kind: 'timeout' };
    if (error instanceof BodyTooLargeError) return { kind: 'too_large', bytes: error.bytes };
    const message = error instanceof Error ? error.message : String(error);
    return { kind: 'network', message };
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole: string, body: string) => {
    const lower = body.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === '#39' || lower === 'apos') return "'";
    if (lower === 'nbsp') return ' ';
    if (lower.startsWith('#x')) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (lower.startsWith('#')) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

/** 先剥 script/style 内容再做文本化：JS 字符串里的价格不是站点公示价，绝不采信。 */
function stripScriptsAndStyles(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*$/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*$/gi, ' ');
}

function htmlToText(fragment: string): string {
  const withBreaks = fragment
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|ul|ol|h[1-6]|section|article|header|footer|tr|table)\s*>/gi, '\n');
  return decodeEntities(withBreaks.replace(/<[^>]*>/g, ' '))
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n');
}

function linesFrom(fragment: string): RawRow[] {
  const rows: RawRow[] = [];
  for (const line of htmlToText(fragment).split('\n')) {
    const text = line.trim();
    if (text !== '') rows.push({ kind: 'line', text, cells: [], tableId: null });
  }
  return rows;
}

function tableRows(tableHtml: string, tableId: number): RawRow[] {
  const rows: RawRow[] = [];
  for (const rowMatch of tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
    const rowHtml = rowMatch[1] ?? '';
    const cells: string[] = [];
    for (const cellMatch of rowHtml.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi)) {
      cells.push(htmlToText(cellMatch[1] ?? '').replace(/\s+/g, ' ').trim());
    }
    const text = cells.length > 0 ? cells.join(' | ') : htmlToText(rowHtml).replace(/\s+/g, ' ').trim();
    if (text !== '') rows.push({ kind: 'table', text, cells, tableId });
  }
  return rows;
}

/** 按文档顺序展开为行序列：表格外文本逐行、表格内逐 <tr>，保证邻近推断与证据顺序一致。 */
function extractRows(html: string): RawRow[] {
  const cleaned = stripScriptsAndStyles(html);
  const rows: RawRow[] = [];
  let cursor = 0;
  let tableId = 0;
  for (const tableMatch of cleaned.matchAll(/<table\b[^>]*>[\s\S]*?<\/table\s*>/gi)) {
    const start = tableMatch.index ?? 0;
    rows.push(...linesFrom(cleaned.slice(cursor, start)));
    rows.push(...tableRows(tableMatch[0], tableId));
    tableId += 1;
    cursor = start + tableMatch[0].length;
  }
  rows.push(...linesFrom(cleaned.slice(cursor)));
  return rows;
}

/** 提取行内的价格出现位置；重叠匹配（如 "$2.5 USD"）只保留一条。 */
function parsePriceOccurrences(text: string): PriceOccurrence[] {
  const found: PriceOccurrence[] = [];
  for (const pattern of PRICE_PATTERNS) {
    for (const match of text.matchAll(pattern.re)) {
      const raw = match[1];
      if (raw === undefined) continue;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) continue;
      const start = match.index ?? 0;
      found.push({ value, currency: pattern.currency, start, end: start + match[0].length });
    }
  }
  found.sort((a, b) => a.start - b.start || a.end - b.end);
  const kept: PriceOccurrence[] = [];
  for (const occurrence of found) {
    const previous = kept[kept.length - 1];
    if (previous !== undefined && occurrence.start < previous.end) continue;
    kept.push(occurrence);
  }
  return kept;
}

function findLabels(text: string): LabelHit[] {
  const hits: LabelHit[] = [];
  for (const pattern of LABEL_PATTERNS) {
    for (const match of text.matchAll(pattern.re)) {
      hits.push({ field: pattern.field, index: match.index ?? 0 });
    }
  }
  hits.sort((a, b) => a.index - b.index);
  return hits;
}

/**
 * 输入/输出归属：优先用行内显式标签（位置对齐或最近标签）；无标签的表格行只接受
 * 「从左到右 = 输入、输出」这一条显式约定（网页价目表惯例），其余一律留 null。
 * 同一字段被赋多个值视为歧义，该字段置 null。
 */
function assignPrices(
  text: string,
  prices: PriceOccurrence[],
  labels: LabelHit[],
  kind: 'table' | 'line',
): { input: number | null; output: number | null } {
  const buckets = new Map<'input' | 'output', number[]>();
  const push = (field: 'input' | 'output', value: number): void => {
    const existing = buckets.get(field);
    if (existing === undefined) buckets.set(field, [value]);
    else existing.push(value);
  };

  if (labels.length > 0) {
    const positional =
      labels.length === prices.length &&
      prices.every((price, index) => {
        const label = labels[index];
        return label !== undefined && label.index < price.start;
      });
    const pairs: { value: number; field: PriceField | null }[] = [];
    if (positional) {
      // "输入 $2.5 输出 $10" 与 "输入 | 输出 | $2.5 | $10" 都按文本顺序一一对应。
      for (let index = 0; index < prices.length; index += 1) {
        const price = prices[index];
        const label = labels[index];
        if (price === undefined) continue;
        pairs.push({ value: price.value, field: label?.field ?? null });
      }
    } else {
      // 非对齐布局：每个价格归属文本位置最近的标签（同距离取更靠前者）。
      for (const price of prices) {
        let best: LabelHit | null = null;
        for (const label of labels) {
          if (best === null) {
            best = label;
            continue;
          }
          const distance = Math.abs(label.index - price.start);
          const bestDistance = Math.abs(best.index - price.start);
          if (distance < bestDistance) best = label;
        }
        pairs.push({ value: price.value, field: best?.field ?? null });
      }
    }
    for (const pair of pairs) {
      if (pair.field === 'input' || pair.field === 'output') push(pair.field, pair.value);
    }
  } else if (kind === 'table' && prices.length === 2) {
    // 约定（审计口径显式声明）：无标签的表格行，同一行从左到右依次为输入价、输出价。
    // 该约定只用于 table 结构化行，且 confidence 记 table；普通文本行不做此假设。
    const first = prices[0];
    const second = prices[1];
    const between = first !== undefined && second !== undefined ? text.slice(first.end, second.start) : '';
    const hazard = PAIRING_HAZARD.test(text) || RANGE_BETWEEN.test(between);
    if (!hazard && first !== undefined && second !== undefined) {
      push('input', first.value);
      push('output', second.value);
    }
  }

  const pick = (field: 'input' | 'output'): number | null => {
    const values = buckets.get(field);
    return values !== undefined && values.length === 1 ? (values[0] ?? null) : null;
  };
  return { input: pick('input'), output: pick('output') };
}

function normalizeMatchText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 模型名匹配：大小写/空白不敏感，要求 token 边界，避免 gpt-4o 误配 gpt-4o-mini
 * （边界字符含 . _ -，两端都不允许它们紧邻目标名）。
 */
function rowMatchesModel(text: string, model: string): boolean {
  const target = normalizeMatchText(model);
  if (target === '') return false;
  const pattern = new RegExp(`(?<![a-z0-9._-])${escapeRegExp(target)}(?![a-z0-9._-])`);
  return pattern.test(normalizeMatchText(text));
}

/** 取页面上目标模型的原文拼写（保留页面大小写/连字符），供 nearby 条目回填 modelName。 */
function pageModelToken(text: string, model: string): string | null {
  const parts = model
    .trim()
    .split(/\s+/)
    .map((part) => escapeRegExp(part))
    .filter((part) => part !== '');
  if (parts.length === 0) return null;
  const pattern = new RegExp(`(?<![A-Za-z0-9._-])${parts.join('\\s*')}(?![A-Za-z0-9._-])`, 'i');
  return text.match(pattern)?.[0] ?? null;
}

function firstSignalIndex(text: string): number | null {
  const prices = parsePriceOccurrences(text);
  const labels = findLabels(text);
  const indexes: number[] = [];
  const firstPrice = prices[0];
  if (firstPrice !== undefined) indexes.push(firstPrice.start);
  const firstLabel = labels[0];
  if (firstLabel !== undefined) indexes.push(firstLabel.index);
  return indexes.length === 0 ? null : Math.min(...indexes);
}

function cleanModelName(value: string): string {
  const base = value
    .replace(/^[\s|:：,，;；·•\-–—]+/, '')
    .replace(/[\s|:：,，;；·•\-–—]+$/, '')
    .trim();
  // 价目卡常见的「价格：」「单价」等纯标题不是模型名；返回空串让邻近推断去承接。
  if (/^(?:价格|价目|单价|定价|费用|收费|prices?|pricing|unit\s*price|model\s*price)$/i.test(base)) return '';
  return base.replace(/(?:\s|的)?(?:价格|定价|价)$/u, '').trim() || base;
}

/** 取行内的模型名：表格优先找不含价格/标签的单元格（目标模型优先），文本行取首个价格/标签之前的部分。 */
function extractModelName(row: RawRow, model: string): string {
  if (row.kind === 'table' && row.cells.length > 0) {
    const plainCells = row.cells.filter(
      (cell) => cell !== '' && parsePriceOccurrences(cell).length === 0 && findLabels(cell).length === 0,
    );
    for (const cell of plainCells) {
      if (rowMatchesModel(cell, model)) return cleanModelName(cell);
    }
    const first = plainCells[0];
    if (first !== undefined) return cleanModelName(first);
  }
  const stopAt = firstSignalIndex(row.text);
  const head = stopAt === null ? row.text : row.text.slice(0, stopAt);
  return cleanModelName(head);
}

/** 向上回溯有限行找目标模型名（只服务 confidence=nearby；找不到就放弃，不猜归属）。 */
function nearbyModelToken(rows: RawRow[], rowIndex: number, model: string): string | null {
  for (let index = rowIndex - 1; index >= 0 && rowIndex - index <= NEARBY_WINDOW_ROWS; index -= 1) {
    const row = rows[index];
    if (row === undefined) continue;
    if (!rowMatchesModel(row.text, model)) continue;
    return pageModelToken(row.text, model);
  }
  return null;
}

/**
 * 页面解析主流程。
 * 表格内出现「每百万」表头时对后续表格行生效（常见写法：表头 "$ / 1M tokens"，单元格只写 "$2.5"），
 * 但币种仍要求出现在数据行本身——裸数字永远不是价格。
 */
function analyzePage(html: string, model: string): PageAnalysis {
  const rows = extractRows(html);
  const priced: PricedRow[] = [];
  let tableHasPerM = false;
  let activeTableId: number | null = null;

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row === undefined) continue;
    if (row.kind === 'line') {
      tableHasPerM = false;
      activeTableId = null;
    } else if (row.tableId !== activeTableId) {
      // 新表格开始：上一张表的价格口径不外溢到下一张表。
      tableHasPerM = false;
      activeTableId = row.tableId;
    }
    const rowHasPerM = PER_MILLION_HINT.test(row.text);
    if (row.kind === 'table' && rowHasPerM) tableHasPerM = true;
    // 同一行混排「每千 / 每百万」价格时单位不可判定，整行放弃（绝不按 ×1000 猜测）。
    if (PER_THOUSAND_HINT.test(row.text)) continue;

    const prices = parsePriceOccurrences(row.text);
    if (prices.length === 0) continue;
    const perMillion = rowHasPerM || (row.kind === 'table' && tableHasPerM);
    if (!perMillion) continue;

    const hasUsd = USD_MARKER.test(row.text);
    const hasCny = CNY_MARKER.test(row.text);
    // 既无币种标记、或同一行同时出现 USD/CNY → 不猜币种，整行跳过。
    if (hasUsd === hasCny) continue;
    const currency: 'USD' | 'CNY' = hasUsd ? 'USD' : 'CNY';

    const assigned = assignPrices(row.text, prices, findLabels(row.text), row.kind);
    priced.push({
      kind: row.kind,
      rowIndex,
      rawLine: row.text,
      modelName: extractModelName(row, model),
      input: assigned.input,
      output: assigned.output,
      currency,
    });
  }

  const entries: ScrapePriceEntry[] = [];
  for (const row of priced) {
    let modelName = row.modelName;
    let confidence: 'table' | 'nearby' = row.kind === 'table' ? 'table' : 'nearby';
    if (modelName === '') {
      const token = nearbyModelToken(rows, row.rowIndex, model);
      if (token === null) continue;
      modelName = token;
      confidence = 'nearby';
    }
    entries.push({
      modelName,
      inputUsdPerM: row.currency === 'USD' ? row.input : null,
      outputUsdPerM: row.currency === 'USD' ? row.output : null,
      currency: row.currency,
      confidence,
      rawLine: row.rawLine,
    });
  }

  const matched =
    entries.find((entry) => rowMatchesModel(entry.rawLine, model) || rowMatchesModel(entry.modelName, model)) ?? null;
  const capped = entries.length > MAX_SCRAPE_ENTRIES ? entries.slice(0, MAX_SCRAPE_ENTRIES) : entries;
  return { entries: capped, matched };
}

function plainText(html: string): string {
  return htmlToText(stripScriptsAndStyles(html)).replace(/\s+/g, ' ').trim();
}

/** SPA 判定：有前端挂载点/外链脚本 + 几乎没有可见文本 + 无任何价格信号，才认定为需要 JS 渲染。 */
function looksLikeJsShell(html: string, text: string): boolean {
  const hasShellMarker =
    /<div[^>]+id=["'](?:root|app|__next|__nuxt)["']/i.test(html) ||
    /__NEXT_DATA__|__NUXT__/i.test(html) ||
    /<script\b[^>]*\bsrc\s*=/i.test(html);
  if (!hasShellMarker) return false;
  const hasPriceSignal = USD_MARKER.test(text) || CNY_MARKER.test(text) || PER_MILLION_HINT.test(text);
  return !hasPriceSignal && text.length < 400;
}

function hardFailure(raw: Exclude<ScrapeFetch, { kind: 'ok' }>, page: string, timeoutMs: number): ScrapePricingResult {
  let reason: string;
  switch (raw.kind) {
    case 'http_error':
      reason = `${page} 返回 HTTP ${raw.status}（非 404，按抓取失败处理）`;
      break;
    case 'timeout':
      reason = `${page} 请求超时（${timeoutMs}ms）`;
      break;
    case 'too_large':
      reason = `${page} 响应体 ${raw.bytes} 字节超过上限 ${PRICE_PAGE_BODY_LIMIT_BYTES}（512KB）`;
      break;
    case 'network':
      reason = `${page} 网络错误：${raw.message}`;
      break;
    default:
      reason = `${page} 抓取失败`;
      break;
  }
  return { state: 'failed', reason, page, html: null, entries: [], matched: null };
}

function notApplicable(reason: string, page: string | null, html: string | null): ScrapePricingResult {
  return { state: 'not_applicable', reason, page, html, entries: [], matched: null };
}

/**
 * 抓取站点网页公示价并解析目标模型单价。
 * - baseUrl：站点地址（可带 /v1 等 API 版本段，内部按 deriveOrigin 归一到站点根再拼候选页）；
 * - pricePage 显式指定时只抓该页（跨源直接拒绝，不发起请求）；
 * - 否则按 PRICE_PAGE_CANDIDATES 顺序探测，命中目标即返回；有价但目标缺失时保留首个有价页面；
 * - 404 全落空 = 能力边界（not_applicable）；超时/5xx/超限 = failed。
 * 绝不发送 apiKey：价目页是公开页面，发送凭证只会扩大泄露面。
 */
export async function scrapeDeclaredPricing(
  baseUrl: string,
  model: string,
  options: ScrapeOptions,
): Promise<ScrapePricingResult> {
  const base = parseBase(baseUrl);
  if (base === null) {
    return {
      state: 'failed',
      reason: `origin 无法解析为 http(s) URL：${baseUrl}`,
      page: null,
      html: null,
      entries: [],
      matched: null,
    };
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    return {
      state: 'failed',
      reason: `timeoutMs 非法：${String(options.timeoutMs)}`,
      page: null,
      html: null,
      entries: [],
      matched: null,
    };
  }

  const requested = typeof options.pricePage === 'string' ? options.pricePage.trim() : '';

  if (requested !== '') {
    const resolved = resolveExplicitPage(base, requested);
    if (resolved.kind === 'cross_origin') {
      return notApplicable(`跨源（cross-origin）价格页被拒绝（只允许同源 ${base.origin}）：${requested}`, null, null);
    }
    if (resolved.kind === 'invalid') {
      return notApplicable(`价格页地址非法（需为同源 http(s) URL 或相对路径）：${requested}`, null, null);
    }
    const page = pagePath(resolved.url);
    const fetched = await getHtml(resolved.url, options.timeoutMs);
    if (fetched.kind === 'not_found') return notApplicable(`指定价格页 ${page} 返回 404`, null, null);
    if (fetched.kind === 'redirect') {
      return notApplicable(`指定价格页 ${page} 返回重定向（HTTP ${fetched.status}，不跟随）`, null, null);
    }
    if (fetched.kind !== 'ok') return hardFailure(fetched, page, options.timeoutMs);

    const analysis = analyzePage(fetched.html, model);
    if (analysis.entries.length > 0) {
      return {
        state: 'ok',
        reason: null,
        page,
        html: fetched.html,
        entries: analysis.entries,
        matched: analysis.matched,
      };
    }
    const shell = looksLikeJsShell(fetched.html, plainText(fetched.html));
    const reason = shell
      ? JS_RENDER_REASON
      : `指定价格页 ${page} 未解析出「币种 + 每百万 tokens」语境的价格行`;
    return notApplicable(reason, page, fetched.html);
  }

  let pageWithEntries: { page: string; html: string; analysis: PageAnalysis } | null = null;
  let shellPage: { page: string; html: string } | null = null;
  let noPricePage: { page: string; html: string } | null = null;
  let sawRedirect = 0;

  for (const candidate of PRICE_PAGE_CANDIDATES) {
    const url = `${base.baseUrl}${candidate}`;
    const page = pagePath(url);
    const fetched = await getHtml(url, options.timeoutMs);
    if (fetched.kind === 'not_found') continue;
    if (fetched.kind === 'redirect') {
      sawRedirect += 1;
      continue;
    }
    if (fetched.kind !== 'ok') return hardFailure(fetched, page, options.timeoutMs);

    const analysis = analyzePage(fetched.html, model);
    if (analysis.matched !== null) {
      return {
        state: 'ok',
        reason: null,
        page,
        html: fetched.html,
        entries: analysis.entries,
        matched: analysis.matched,
      };
    }
    if (analysis.entries.length > 0) {
      if (pageWithEntries === null) pageWithEntries = { page, html: fetched.html, analysis };
      continue;
    }
    if (looksLikeJsShell(fetched.html, plainText(fetched.html))) {
      if (shellPage === null) shellPage = { page, html: fetched.html };
    } else if (noPricePage === null) {
      noPricePage = { page, html: fetched.html };
    }
  }

  if (pageWithEntries !== null) {
    // 页面有价但目标模型不在其中：state=ok + matched=null，调用方不得据此推断目标价格。
    return {
      state: 'ok',
      reason: null,
      page: pageWithEntries.page,
      html: pageWithEntries.html,
      entries: pageWithEntries.analysis.entries,
      matched: null,
    };
  }
  if (shellPage !== null) return notApplicable(JS_RENDER_REASON, shellPage.page, shellPage.html);
  if (noPricePage !== null) {
    return notApplicable(
      `候选价格页 ${noPricePage.page} 未解析出「币种 + 每百万 tokens」语境的价格行`,
      noPricePage.page,
      noPricePage.html,
    );
  }
  if (sawRedirect > 0) {
    return notApplicable(`候选价格页返回重定向（HTTP 30x，不跟随；已探测 ${sawRedirect} 个）`, null, null);
  }
  return notApplicable('候选价格页均返回 404（站点未提供可读的网页价目表）', null, null);
}
