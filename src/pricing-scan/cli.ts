// src/pricing-scan/cli.ts — 多站点价格/倍率扫描（只读公开价接口，不消耗模型 token）。
//
// 与 test 的区别：test 需要 API key、真实调用模型；pricing-scan 只探测站点公开价格接口，
// 支持一次扫描多个站点，输出每个站点的全部模型倍率与 USD/百万 tokens 价，便于横向比价。
//
// 安全边界：只请求 --base-url 推导出的同源公开接口，绝不携带 API key/Cookie，不跟随跨源重定向，
// 响应体 512KB 硬限。自定义端点也只允许同源。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { strictInt, strictPositiveNumber } from '../cli.js';
import { supportsColor } from '../color.js';
import { isPlausibleQuotaPerUnit, lookupDeclaredModel, normalizeModelName } from '../pricing.js';
import {
  discoverPricing,
  pricingAdapterLabel,
  type PricingDiscoveryResult,
  type PricingProbe,
} from '../pricing-discovery.js';
import type { PricingFormatId } from '../pricing-formats.js';
import type { PublicUsdPrice } from '../pricing-public.js';

const SCAN_HELP = `model-xray pricing-scan — 多站点公示价格/倍率扫描（零模型消耗）

用法:
  model-xray pricing-scan --base-url <url> [--base-url <url> ...] [options]
  model-xray pricing-scan --base-urls <file> [options]

说明:
  对每个站点按 schema 自动探测公开价格接口（不是按站点名硬编码）：
    /api/pricing、/api/ratio_config、/api/v1/models、/v1/model/info、/model/info、
    /public/model-prices、/public/models；也可用 --pricing-endpoint 追加同源自定义端点。
  只做公开数据读取，不携带 API key，不调用模型，不写价格账本。

参数:
  --base-url <url>          站点地址，可重复；例如 https://relay.example.com/v1
  --base-urls <file>        从文件读取站点列表（一行一个，# 开头为注释）
  --model <name>            目标模型：优先选择包含该模型的价表；输出仍保留全表
  --group <name>            站点分组（仅展示/快照口径，不改变换算）
  --quota-per-usd <n>       quota 每美元（正数；覆盖站点 /api/status 公示值）
  --pricing-endpoint <path> 额外同源 JSON 端点，可重复；相对路径或同源绝对 URL
  --timeout <seconds>       单端点请求超时秒数，[1, 300] 整数（默认 30）
  --limit <n>               终端表格最多显示的模型行数，[1, 5000] 整数（默认 200；JSON 不受限）
  --json                    输出完整 JSON（含全部模型、价格与探测轨迹）
  --out <dir>               额外把完整 JSON 写入目录（默认文件名 pricing-scan-*.json）
  --help                    显示本帮助

退出码:
  0 所有站点均成功且（指定 --model 时）找到目标模型
  1 任一站点失败/无可解析价表/未找到目标模型
  2 参数错误

示例:
  model-xray pricing-scan --base-url https://relay-a.com/v1 --base-url https://relay-b.com/v1
  model-xray pricing-scan --base-urls sites.txt --json --out reports
  model-xray pricing-scan --base-url https://relay.example.com/v1 --pricing-endpoint /custom/prices.json
`;

export interface PricingScanRow {
  model: string;
  /** 是否有可用的 token 倍率锚；免费模型/仅公开原始价时为 false。 */
  hasRatio: boolean;
  modelRatio: number;
  completionRatio: number;
  quotaType: number | null;
  modelPrice: number | null;
  inputUsdPerM: number | null;
  outputUsdPerM: number | null;
  cachedUsdPerM: number | null;
  listInputUsdPerM: number | null;
  listOutputUsdPerM: number | null;
  matched: boolean;
}

export interface PricingScanSiteResult {
  baseUrl: string;
  origin: string | null;
  status: 'ok' | 'model_missing' | 'not_applicable' | 'failed';
  reason: string | null;
  adapter: PricingFormatId | null;
  adapterLabel: string;
  path: string | null;
  source: string | null;
  quotaPerUnit: number | null;
  quotaPerUnitSource: string;
  /** quota 未知时，USD 展示价使用的基准是否为内部合成（不写账本）。 */
  quotaPerUnitSynthetic: boolean;
  quotaPerUnitConflict: string | null;
  entries: number;
  models: PricingScanRow[];
  probes: PricingProbe[];
}

export interface PricingScanReport {
  generatedAt: string;
  model: string | null;
  group: string | null;
  quotaPerUsd: number | null;
  sites: PricingScanSiteResult[];
}

function formatNumber(value: number | null, digits = 6): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const rounded = value.toFixed(digits).replace(/\.?0+$/, '');
  return rounded === '' || rounded === '-0' ? '0' : rounded;
}

function rowsFor(discovered: PricingDiscoveryResult, model: string | null): PricingScanRow[] {
  if (discovered.pricing === null) return [];
  const prices = discovered.prices ?? {};
  const priceKey =
    model !== null
      ? Object.keys(prices).find((key) => normalizeModelName(key) === normalizeModelName(model)) ?? null
      : null;
  const matchedKey = model !== null ? (lookupDeclaredModel(discovered.pricing, model)?.key ?? priceKey) : null;
  // 并集：免费模型可能只有原始 USD 价、没有可反推的倍率锚（pricing.models 里没有它）。
  const names = new Set([...Object.keys(discovered.pricing.models), ...Object.keys(prices)]);
  return [...names]
    .map((name) => {
      const entry = discovered.pricing?.models[name];
      const price: PublicUsdPrice | undefined = prices[name];
      return {
        model: name,
        hasRatio: entry !== undefined,
        modelRatio: entry?.modelRatio ?? 0,
        completionRatio: entry?.completionRatio ?? 0,
        quotaType: entry?.quotaType ?? null,
        modelPrice: entry?.modelPrice ?? null,
        inputUsdPerM: price?.inputUsdPerM ?? null,
        outputUsdPerM: price?.outputUsdPerM ?? null,
        cachedUsdPerM: price?.cachedUsdPerM ?? null,
        listInputUsdPerM: price?.listInputUsdPerM ?? null,
        listOutputUsdPerM: price?.listOutputUsdPerM ?? null,
        matched: matchedKey !== null && matchedKey === name,
      };
    })
    .sort((a, b) => a.model.localeCompare(b.model));
}

function toSiteResult(baseUrl: string, discovered: PricingDiscoveryResult, model: string | null): PricingScanSiteResult {
  const rows = rowsFor(discovered, model);
  const matched = model === null || rows.some((row) => row.matched);
  const status: PricingScanSiteResult['status'] =
    discovered.state !== 'ok'
      ? discovered.state
      : matched
        ? 'ok'
        : 'model_missing';
  const okProbe = discovered.probes.find((probe) => probe.state === 'ok' && probe.path === discovered.path);
  return {
    baseUrl,
    origin: discovered.origin,
    status,
    reason: discovered.reason,
    adapter: discovered.adapter,
    adapterLabel: pricingAdapterLabel(discovered.adapter),
    path: discovered.path,
    source: discovered.pricing?.source ?? null,
    quotaPerUnit: discovered.quotaPerUnit,
    quotaPerUnitSource: discovered.quotaPerUnitSource,
    quotaPerUnitSynthetic: discovered.quotaPerUnitSynthetic,
    quotaPerUnitConflict: discovered.quotaPerUnitConflict,
    entries: okProbe?.entries ?? rows.length,
    models: rows,
    probes: discovered.probes,
  };
}

function failedSiteResult(baseUrl: string, error: unknown): PricingScanSiteResult {
  return {
    baseUrl,
    origin: null,
    status: 'failed',
    reason: error instanceof Error ? error.message : String(error),
    adapter: null,
    adapterLabel: pricingAdapterLabel(null),
    path: null,
    source: null,
    quotaPerUnit: null,
    quotaPerUnitSource: 'none',
    quotaPerUnitSynthetic: false,
    quotaPerUnitConflict: null,
    entries: 0,
    models: [],
    probes: [],
  };
}

function printSite(site: PricingScanSiteResult, index: number, total: number, limit: number, color: boolean): void {
  const head = `[${index + 1}/${total}] ${site.baseUrl}`;
  console.log(color ? `\x1b[36m${head}\x1b[0m` : head);
  if (site.status !== 'ok') {
    const label =
      site.status === 'model_missing'
        ? '价表可读但未找到目标模型'
        : site.status === 'not_applicable'
          ? '未发现可解析的公开价格接口'
          : '读取失败';
    console.log(`  ${color ? '\x1b[33m' : ''}${label}${color ? '\x1b[0m' : ''}：${site.reason ?? '原因未知'}`);
    if (site.probes.length > 0) {
      console.log(`  探测：${site.probes.map((probe) => `${probe.path} ${probe.state}`).join(' · ')}`);
    }
    console.log('');
    return;
  }

  const quota =
    site.quotaPerUnit === null
      ? site.quotaPerUnitSynthetic
        ? '未知（model_ratio 用标准基价折算，仅供展示）'
        : '未知'
      : `${formatNumber(site.quotaPerUnit, 6)}（${site.quotaPerUnitSource}）`;
  console.log(`  来源：${site.adapterLabel} ${site.path ?? ''} · quota=$1:${quota} · 模型 ${site.models.length}`);
  if (site.quotaPerUnitConflict !== null) console.log(`  注意：${site.quotaPerUnitConflict}`);
  const warnings = site.probes.filter((probe) => probe.state !== 'ok' && probe.state !== 'not_found');
  if (warnings.length > 0) {
    console.log(`  探测告警：${warnings.map((probe) => `${probe.path} ${probe.reason ?? probe.state}`).join(' · ')}`);
  }
  console.log('  模型                          model_ratio  completion  input $/M   output $/M  计费');
  const shown = site.models.slice(0, limit);
  for (const row of shown) {
    const mark = row.matched ? '*' : ' ';
    const billing =
      row.quotaType === 1
        ? `按次 model_price=${formatNumber(row.modelPrice, 6)}`
        : '按 token';
    console.log(
      `${mark} ${row.model.padEnd(30)} ${(row.hasRatio ? formatNumber(row.modelRatio) : '—').padStart(
        11,
      )} ${(row.hasRatio ? formatNumber(row.completionRatio) : '—').padStart(11)} ${formatNumber(
        row.inputUsdPerM,
      ).padStart(11)} ${formatNumber(row.outputUsdPerM).padStart(12)}  ${billing}`,
    );
  }
  if (site.models.length > shown.length) {
    console.log(`  … 省略 ${site.models.length - shown.length} 个模型（--limit 调整终端行数；--json 输出全量）`);
  }
  console.log('');
}

function readUrlFile(path: string): string[] {
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

function validateBaseUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      console.error(`--base-url 协议必须是 http/https。收到：${raw}`);
      return null;
    }
    if (url.username !== '' || url.password !== '') {
      console.error(`--base-url 不得内嵌凭证（user:password@）。收到：${raw}`);
      return null;
    }
    return raw;
  } catch {
    console.error(`--base-url 不是合法 URL：${raw}`);
    return null;
  }
}

function validateEndpoint(raw: string): string | null {
  const value = raw.trim();
  if (value === '') {
    console.error('--pricing-endpoint 不能为空。');
    return null;
  }
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.username !== '' || url.password !== '') {
        console.error(`--pricing-endpoint 不得内嵌凭证：${value}`);
        return null;
      }
      return value;
    } catch {
      console.error(`--pricing-endpoint 不是合法 URL：${value}`);
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    console.error(`--pricing-endpoint 只允许 http(s) 同源地址或相对路径：${value}`);
    return null;
  }
  return value;
}

export function buildScanReport(sites: PricingScanSiteResult[], model: string | null, group: string | null, quotaPerUsd: number | null): PricingScanReport {
  return { generatedAt: new Date().toISOString(), model, group, quotaPerUsd, sites };
}

export interface PricingScanRequest {
  model: string | null;
  group: string | null;
  quotaPerUsd: number | null;
  endpoints: readonly string[];
  timeoutMs: number;
}

/** 扫描多个站点（纯数据，不打印）；CLI 与测试共用同一套探测/降级语义。 */
export async function scanPricingSites(
  baseUrls: readonly string[],
  request: PricingScanRequest,
): Promise<PricingScanSiteResult[]> {
  const sites: PricingScanSiteResult[] = [];
  for (const baseUrl of baseUrls) {
    try {
      const discovered = await discoverPricing(baseUrl, {
        timeoutMs: request.timeoutMs,
        model: request.model,
        group: request.group,
        quotaPerUsd: request.quotaPerUsd,
        endpoints: request.endpoints,
      });
      sites.push(toSiteResult(baseUrl, discovered, request.model));
    } catch (error) {
      sites.push(failedSiteResult(baseUrl, error));
    }
  }
  return sites;
}

export async function runPricingScan(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        'base-url': { type: 'string', multiple: true },
        'base-urls': { type: 'string' },
        model: { type: 'string' },
        group: { type: 'string' },
        'quota-per-usd': { type: 'string' },
        'pricing-endpoint': { type: 'string', multiple: true },
        timeout: { type: 'string' },
        limit: { type: 'string' },
        json: { type: 'boolean', default: false },
        out: { type: 'string' },
        help: { type: 'boolean', default: false },
      },
    });
  } catch (error) {
    console.error(`参数错误：${error instanceof Error ? error.message : String(error)}`);
    console.error(SCAN_HELP);
    return 2;
  }

  const values = parsed.values;
  if (values.help) {
    console.log(SCAN_HELP);
    return 0;
  }

  const urls: string[] = [];
  for (const raw of values['base-url'] ?? []) {
    const validated = validateBaseUrl(raw);
    if (validated === null) return 2;
    urls.push(validated);
  }
  if (values['base-urls'] !== undefined) {
    let fileUrls: string[];
    try {
      fileUrls = readUrlFile(resolve(values['base-urls']));
    } catch (error) {
      console.error(
        `无法读取 --base-urls 文件：${error instanceof Error ? error.message : String(error)}`,
      );
      return 2;
    }
    for (const raw of fileUrls) {
      const validated = validateBaseUrl(raw);
      if (validated === null) return 2;
      urls.push(validated);
    }
  }
  const uniqueUrls = [...new Set(urls)];
  if (uniqueUrls.length === 0) {
    console.error('缺少必填参数 --base-url 或 --base-urls。');
    console.error('示例：model-xray pricing-scan --base-url https://relay.example.com/v1');
    return 2;
  }

  const endpoints: string[] = [];
  for (const raw of values['pricing-endpoint'] ?? []) {
    const validated = validateEndpoint(raw);
    if (validated === null) return 2;
    endpoints.push(validated);
  }

  const quotaPerUsd =
    values['quota-per-usd'] === undefined
      ? null
      : strictPositiveNumber(values['quota-per-usd'], 'quota-per-usd', '500000');
  if (values['quota-per-usd'] !== undefined) {
    if (quotaPerUsd === null) return 2;
    if (!isPlausibleQuotaPerUnit(quotaPerUsd)) {
      console.error('--quota-per-usd 必须在 [1, 1e12] 内。');
      return 2;
    }
  }
  const timeout = values.timeout === undefined ? 30 : strictInt(values.timeout, 1, 300, 'timeout', '30');
  if (timeout === null) return 2;
  const limit = values.limit === undefined ? 200 : strictInt(values.limit, 1, 5000, 'limit', '200');
  if (limit === null) return 2;

  const model = values.model?.trim() ?? '';
  const group = values.group?.trim() ?? '';
  const sites = await scanPricingSites(uniqueUrls, {
    model: model === '' ? null : model,
    group: group === '' ? null : group,
    quotaPerUsd,
    endpoints,
    timeoutMs: timeout * 1000,
  });
  const color = supportsColor(process.stdout);
  if (!values.json) {
    for (const [index, site] of sites.entries()) printSite(site, index, sites.length, limit, color);
  }

  const report = buildScanReport(sites, model === '' ? null : model, group === '' ? null : group, quotaPerUsd);
  if (values.out !== undefined) {
    const dir = resolve(values.out);
    try {
      mkdirSync(dir, { recursive: true });
      const stamp = report.generatedAt.replace(/[:.]/g, '-');
      const path = join(dir, `pricing-scan-${stamp}.json`);
      writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      if (!values.json) console.log(`完整结果已写入：${path}`);
      else console.error(`完整结果已写入：${path}`);
    } catch (error) {
      console.error(`写入 --out 失败：${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  if (values.json) console.log(JSON.stringify(report, null, 2));

  const allOk = sites.every((site) => site.status === 'ok');
  return allOk ? 0 : 1;
}
