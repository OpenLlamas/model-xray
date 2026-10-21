import { parseArgs } from 'node:util';
import { strictInt, strictPositiveNumber } from '../cli.js';
import { supportsColor } from '../color.js';
import { deriveOrigin, type DeclaredPricing } from '../pricing.js';
import { discoverPricing, pricingAdapterLabel } from '../pricing-discovery.js';
import {
  buildLedgerEntry,
  comparePricingSnapshots,
  readLastPricingSnapshot,
  withLedgerLock,
  type PricingDrift,
} from '../pricing-ledger.js';

const WATCH_HELP = `model-xray pricing-watch — 公示倍率看门狗：只读公开价接口，盯住站点倍率有没有被偷偷改

用法:
  model-xray pricing-watch --base-url <url> [options]

与 test 的区别:
  model-xray test           一次性审计：跑完整探针（真实消耗模型 token），产出评分报告。
  model-xray pricing-watch   只请求同源公开价接口（/api/pricing、/api/ratio_config、OpenRouter、LiteLLM、公开价表）：
                             零模型消耗、零计费；按周期把公示价写入本地价格账本并与上一份快照比对，
                             倍率被改动（>5%）即告警。

参数:
  --base-url <url>       必填。站点地址，例如 https://relay.example.com/v1
  --model <name>         只关注该模型（缺省 = 全表：各模型倍率 + 分组倍率 + 模型增删）
  --group <name>         站点分组（写入快照，便于按分组口径追溯）
  --quota-per-usd <n>    quota 每美元（正数；覆盖站点 /api/status 公示值）
  --interval <seconds>   轮询间隔秒数，[30, 86400] 整数（默认 3600）
  --once                 只查一次就退出（不做常驻轮询）
  --out <dir>            价格账本目录（默认 reports；账本文件在 <dir>/pricing/ 下按主机归档）
  --timeout <seconds>    单次请求超时秒数，[1, 300] 整数（默认 30）
  --help                 显示本帮助

安全边界:
  只请求与 --base-url 同源的公开接口，绝不携带 API key，不跟随重定向，响应体 512KB 硬限。
  与 test 一样，账本按「主机+端口」归档：同一上游换路径别名也共享同一份漂移历史。

退出码:
  0 无显著漂移 · 1 检测到显著漂移（>5%）· 2 抓取失败 / 账本不可信 / 参数错误
  常驻模式下 Ctrl-C 退出：出现过漂移记 1，否则记 0；单轮硬错误只打印不影响退出码
  （站点抖动不应让看门狗"失败"，但每轮错误都会显式打印）。
`;

/** 单轮看门狗参数（与 CLI 旗标解耦，便于单测直接驱动）。 */
export interface PricingWatchOptions {
  baseUrl: string;
  model: string | null;
  group: string | null;
  quotaPerUsd: number | null;
  outDir: string;
  timeoutMs: number;
}

/** 单轮看门狗结果。 */
export interface PricingWatchCycleResult {
  status: 'ok' | 'drift' | 'error';
  /** 显著漂移项（status=drift 时非空）。 */
  drifts: PricingDrift[];
  /** 硬错误原因（status=error 时非空）。 */
  error: string | null;
  /** 补充披露（来源、首次建立基线、路径别名等）。 */
  note: string | null;
  origin: string;
  ledgerPath: string;
  /** 本轮是否写入了新快照（账本损坏时为 false）。 */
  wrote: boolean;
  /** 首次建立基线（此前没有可比快照）——此时不判漂移。 */
  baselineCreated: boolean;
}

function errorResult(origin: string, ledgerPath: string, error: string): PricingWatchCycleResult {
  return { status: 'error', drifts: [], error, note: null, origin, ledgerPath, wrote: false, baselineCreated: false };
}

/**
 * 抓站点公示价（自动探测 /api/pricing、/api/ratio_config、OpenRouter、LiteLLM、公开价表），
 * 构造账本条目。所有来源都拿不到时返回错误（不写账本、不判漂移）。
 */
async function fetchWatchPricing(options: PricingWatchOptions): Promise<{
  pricing: DeclaredPricing | null;
  note: string | null;
  error: string | null;
}> {
  const discovered = await discoverPricing(options.baseUrl, {
    timeoutMs: options.timeoutMs,
    quotaPerUsd: options.quotaPerUsd,
    group: options.group,
    model: options.model,
  });
  if (discovered.state === 'ok' && discovered.pricing !== null) {
    const source = pricingAdapterLabel(discovered.adapter);
    const path = discovered.path ?? '(未知路径)';
    return { pricing: discovered.pricing, note: `来源：${source} ${path}`, error: null };
  }
  return {
    pricing: null,
    note: null,
    error: `站点未提供可解析的公示价：${discovered.reason ?? '未知原因'}`,
  };
}

/**
 * 单轮看门狗：抓公示价 → 在账本锁内读上一份快照 → 比对 → 写入新快照。
 * 读→比→写全程在同一把锁内（withLedgerLock），多进程并发不会交错丢历史或重复判漂移。
 */
export async function runPricingWatchCycle(options: PricingWatchOptions): Promise<PricingWatchCycleResult> {
  let origin: string;
  try {
    origin = deriveOrigin(options.baseUrl);
  } catch {
    return errorResult('', '', `baseUrl 无法解析为 URL：${options.baseUrl}`);
  }
  const fetched = await fetchWatchPricing(options);
  if (fetched.pricing === null) {
    return errorResult(origin, '', fetched.error ?? '公示价不可用');
  }
  const pricing = fetched.pricing;
  const entry = buildLedgerEntry(pricing, options.model ?? '');
  let ledgerPath = '';
  try {
    return withLedgerLock(options.outDir, origin, (appendLocked) => {
      const latest = readLastPricingSnapshot(options.outDir, origin);
      ledgerPath = latest.path;
      if (latest.kind === 'error') {
        return errorResult(origin, latest.path, `价格账本读取失败：${latest.error ?? '未知原因'}`);
      }
      // 尾部损坏：最新有效条目之后还有坏行/半行 —— 「最新快照」不可信，
      // 既不能判「无变化」，也不能继续追加（盲写会把新行粘在半行后一起损坏）。
      if (latest.tailCorrupt) {
        return errorResult(
          origin,
          latest.path,
          '价格账本尾部损坏（存在无法解析的坏行或未终止半行）：拒绝判定「无变化」，本轮未写入；请先检查账本文件',
        );
      }
      const previous = latest.entry;
      const notes: string[] = [];
      if (fetched.note !== null) notes.push(fetched.note);
      if (latest.originNote !== null) notes.push(latest.originNote);
      if (previous === null) {
        // 首次建基线：没有可比快照，不判漂移（否则第一次跑就会报「全表新增」）。
        const path = appendLocked(entry);
        notes.push('首次建立公示价基线（此前无可比快照）');
        return {
          status: 'ok',
          drifts: [],
          error: null,
          note: notes.join('；'),
          origin,
          ledgerPath: path,
          wrote: true,
          baselineCreated: true,
        };
      }
      // 来源切换：两侧口径不可互换（API 倍率 vs 公开价表 vs 网页抓价），比对结果没有意义。
      // 不判「无变化」，如实披露并让调用方按错误处理。
      const previousSource = previous.source;
      const currentSource = pricing.source;
      if (previousSource !== currentSource) {
        return errorResult(
          origin,
          latest.path,
          `公示价来源切换（${previousSource ?? '未知'} → ${currentSource ?? '未知'}）：两侧口径不可互换，本轮不判定漂移`,
        );
      }
      const drifts = comparePricingSnapshots(previous, pricing, { model: options.model });
      const significant = drifts.filter((drift) => drift.significant);
      const path = appendLocked(entry);
      const changed = drifts.length > 0 ? `共 ${drifts.length} 项变化（显著 ${significant.length} 项）` : '无变化';
      notes.push(`对照 ${previous.capturedAt} 快照：${changed}`);
      return {
        status: significant.length > 0 ? 'drift' : 'ok',
        drifts: significant,
        error: null,
        note: notes.join('；'),
        origin,
        ledgerPath: path,
        wrote: true,
        baselineCreated: false,
      };
    });
  } catch (error) {
    return errorResult(origin, ledgerPath, error instanceof Error ? error.message : String(error));
  }
}

function formatDrift(drift: PricingDrift): string {
  const scope = drift.model === null ? drift.field : `${drift.model}.${drift.field}`;
  return `  - ${scope}：${drift.message}`;
}

/** model-xray pricing-watch 子命令入口（由 src/cli.ts 顶层分流）。 */
export async function runPricingWatch(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: false,
      strict: true,
      options: {
        'base-url': { type: 'string' },
        model: { type: 'string' },
        group: { type: 'string' },
        'quota-per-usd': { type: 'string' },
        interval: { type: 'string' },
        once: { type: 'boolean', default: false },
        out: { type: 'string', default: 'reports' },
        timeout: { type: 'string' },
        help: { type: 'boolean', default: false },
      },
    });
  } catch (error) {
    console.error(`参数错误：${error instanceof Error ? error.message : String(error)}`);
    console.error(WATCH_HELP);
    return 2;
  }
  const values = parsed.values;
  if (values.help) {
    console.log(WATCH_HELP);
    return 0;
  }
  const baseUrl = values['base-url'] ?? '';
  if (baseUrl.length === 0) {
    console.error('缺少必填参数 --base-url。');
    console.error('示例：model-xray pricing-watch --base-url https://relay.example.com/v1');
    return 2;
  }
  try {
    const parsedUrl = new URL(baseUrl);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      console.error(`--base-url 协议必须是 http/https。收到：${baseUrl}`);
      return 2;
    }
    if (parsedUrl.username !== '' || parsedUrl.password !== '') {
      console.error('--base-url 不得内嵌凭证（user:password@）。');
      return 2;
    }
    if (parsedUrl.search !== '' || parsedUrl.hash !== '') {
      console.error(`--base-url 不得携带 query 或 fragment。收到：${baseUrl}`);
      return 2;
    }
  } catch {
    console.error(`--base-url 不是合法 URL：${baseUrl}`);
    return 2;
  }
  const quotaPerUsd =
    values['quota-per-usd'] === undefined
      ? null
      : strictPositiveNumber(values['quota-per-usd'], 'quota-per-usd', '500000');
  if (values['quota-per-usd'] !== undefined && quotaPerUsd === null) return 2;
  const interval = values.interval === undefined ? 3600 : strictInt(values.interval, 30, 86400, 'interval', '3600');
  if (interval === null) return 2;
  const timeout = values.timeout === undefined ? 30 : strictInt(values.timeout, 1, 300, 'timeout', '30');
  if (timeout === null) return 2;

  const options: PricingWatchOptions = {
    baseUrl,
    model: values.model ?? null,
    group: values.group ?? null,
    quotaPerUsd,
    outDir: values.out,
    timeoutMs: timeout * 1000,
  };

  const color = supportsColor(process.stdout);
  const runOnce = async (): Promise<'ok' | 'drift' | 'error'> => {
    const result = await runPricingWatchCycle(options);
    const stamp = new Date().toISOString();
    if (result.status === 'error') {
      console.error(`[${stamp}] ${color ? '[31m✗[0m' : '✗'} ${result.error}`);
      return 'error';
    }
    if (result.status === 'drift') {
      console.log(`[${stamp}] ${color ? '[33m⚠ 公示倍率漂移[0m' : '⚠ 公示倍率漂移'}：${result.drifts.length} 项显著变化`);
      for (const drift of result.drifts) console.log(formatDrift(drift));
      if (result.note !== null) console.log(`  （${result.note}）`);
      console.log(`  账本：${result.ledgerPath}`);
      return 'drift';
    }
    console.log(`[${stamp}] 无漂移${result.note === null ? '' : `：${result.note}`}`);
    return 'ok';
  };

  if (values.once) {
    const status = await runOnce();
    return status === 'error' ? 2 : status === 'drift' ? 1 : 0;
  }

  // 常驻轮询：Ctrl-C / SIGTERM 退出。漂移只累计不提前退出（要看门狗持续盯）。
  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  let sawDrift = false;
  let sawOk = false;
  while (!stopping) {
    const status = await runOnce();
    if (status === 'drift') sawDrift = true;
    if (status === 'ok') sawOk = true;
    if (stopping) break;
    // 分段睡眠：Ctrl-C 最多等 1s 就能退出（不睡满整个 interval）。
    const deadline = Date.now() + interval * 1000;
    while (!stopping && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (!sawOk && !sawDrift) return 2;
  return sawDrift ? 1 : 0;
}
