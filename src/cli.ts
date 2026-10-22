#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { runAudit } from './runner.js';
import { createRng } from './random.js';
import { buildBaseline, loadBaseline } from './baseline.js';
import { loadTokenReference, type TokenReference } from './token-reference.js';
import { writeReports, makeFileStamp } from './report/files.js';
import { renderConsole } from './report/console.js';
import { supportsColor } from './color.js';
import { runGuard } from './guard/cli.js';
import { runPricingWatch } from './pricing-watch/cli.js';
import { runPricingScan } from './pricing-scan/cli.js';
import { parsePriceFlags } from './price-flags.js';
import { redactUrl } from './redact.js';
import { isPlausibleQuotaPerUnit, QUOTA_PER_UNIT_MAX, QUOTA_PER_UNIT_MIN } from './pricing.js';
import type { AuditReport, RunConfig } from './types.js';

const HELP = `model-xray — audit OpenAI-compatible endpoints for fake or watered-down models

Usage:
  model-xray test  --base-url <url> --key <key> --model <model> [options]
      一次性审计：主动跑一轮探针（身份/上下文/计量/能力/质量/TTFT），产出评分报告后退出。
  model-xray guard --base-url <url> [options]
      常驻监控：本地透明转发代理，逐请求监听真实流量（模型一致性/token 统计/余额滚动对账），
      异常即时告警并写 JSONL 审计日志；详见 model-xray guard --help。
  model-xray pricing-watch --base-url <url> [options]
      公示倍率看门狗：只读公开价接口（零模型消耗），按周期比对本地价格账本，
      站点倍率被改动即告警；详见 model-xray pricing-watch --help。
  model-xray pricing-scan --base-url <url> [--base-url <url> ...] [options]
      多站点公示价格/倍率扫描：按 schema 自动探测公开价接口，输出各站全模型倍率与 USD/百万
      tokens 价（零模型消耗）；详见 model-xray pricing-scan --help。

test Options:
  --base-url <url>          Endpoint base URL, e.g. https://relay.example.com/v1
  --key <key>               API key (or env MODEL_XRAY_KEY / OPENAI_API_KEY)
  --model <model>           Model name to audit, e.g. gpt-4o
  --claimed-context <n>     Advertised context window in tokens, integer in [1000, 100000000] (enables context probe)
  --expect <list>           Claimed capabilities, comma-separated from: vision,tool,thinking (or "none"; default: vision,tool)
  --price-input <n>         Claimed input price per 1M tokens, must be > 0 (with --price-output, enables price-based billing check)
  --price-output <n>        Claimed output price per 1M tokens, must be > 0 (must appear with --price-input)
  --price-cached-read <n>   Claimed cache-read price per 1M tokens, must be >= 0 (default: input price)
  --price-threshold <n>     Long-context tier threshold in prompt tokens, positive integer (requires --price-input2/--price-output2)
  --price-input2 <n>        Claimed input price per 1M tokens above the tier threshold, must be > 0
  --price-output2 <n>       Claimed output price per 1M tokens above the tier threshold, must be > 0
  --price-cached-read2 <n>  Claimed cache-read price above the tier threshold, must be >= 0 (default: input2 price)
  --group <name>            Site group name used to display group_ratio from the declared price table, e.g. default
  --expect-model-ratio <n>  Your declared model_ratio (site public value at /api/pricing); mismatch > 5% fails the billing probe
  --expect-completion-ratio <n>  Your declared completion_ratio; mismatch > 5% fails the billing probe
  --quota-per-usd <n>       Quota units per $1 (new-api status.quota_per_unit); overrides /api/status, enables quota-unit reconciliation
  --declared-price-page <path>  Price web page fallback when /api/pricing is unavailable: origin-relative path
                            (e.g. /pricing) or same-origin absolute URL; scraped price is a low-trust hint, warn-only
  --read-balance            Opt-in balance reconciliation: read balance before/after the probe sequence and compute
                            the measured ratio (Δspend ÷ expected cost); requires --price-input/--price-output and
                            the claimed price unit must match the reconciled balance unit (usually USD)
  --retries <n>             Retries per request on 200 empty bodies, integer in [0, 3] (default: 1)
  --http-retries <n>        Retries per request on 408/409/429/5xx gateway rejections (not billed, safe to retry), integer in [0, 6] (default: 2)
                             注意：每次重试都会真实计费；默认重试 1 次以应对瞬时 5xx/空流，重试会令实扣倍率判定作废（防重复计费污染）
  --baseline <path>         Compare fingerprints against a baseline file (seed is reused unless --seed)
  --baseline-out <path>     Where to write this run's baseline (default: reports/baseline-<model>-<YYYY-MM-DD_HH-mm-ss>.json)
  --token-reference <path>  Compare prompt token counts against a prior audit report of the SAME model（识别全量等比虚增：线性回归对此不可见；须为同名模型、同题集版本的本工具 JSON 报告）
  --deep                    More samples (slower, more tokens)
  --context-samples <n>     Context needle samples per depth, integer in [1, 5] (default: 1; --deep: 5;
                            3 = statistical mode with confirmation resampling; higher = more confidence/cost)
  --context-budget-usd <n>  Context probe spend cap in the same unit as --price-input/--price-output (must be > 0, finite;
                            requires both price flags). Soft cap: pre-charges an estimate (input tokens × input price
                            + full output budget × output price) per request and stops sending once exceeded.
  --seed <n>                Random seed, integer in [1, 2147483646] (default: time-based; with --baseline defaults to baseline seed)
  --timeout <seconds>       Per-request timeout in seconds, integer in [1, 3600] (default: 90)
  --out <dir>               Report output directory (default: reports)
  --yes                     Skip the token-cost confirmation on remote endpoints
  --dry-run                 Print the planned requests and token estimate, then exit
  --quiet                   Only print the final verdict
  --help                    Show this help
  --version                 Print version

Notes:
  价格为「每百万 tokens 的录入价」，核心输入/输出必须成对且为正数；缓存读可留空（按输入价），二档阶梯须同时提供阈值/二档输入/二档输出，二档缓存读留空按二档输入价。默认 test 只做同单位比值，币种不限；guard / 余额对账时录入价必须与余额折算后的单位一致（通常是 USD），价目表币种不同时先统一再录入，否则倍率会整体偏移一个汇率。quota 单位余额由工具按 --quota-per-usd（或站点 /api/status 公示的 quota_per_unit）自行折算成计价单位后再与应缴额对账，缺换算率时该项保持 N/A 并给出原因。
  计费审计会额外 GET 同源公开价格接口读取站点公示倍率/价格（免鉴权、绝不携带 API key）：按 schema 自动探测 /api/pricing、/api/ratio_config、OpenRouter /api/v1/models、LiteLLM /model/info 与公开价表；站点未提供可解析接口时，若提供了 --price-* 会尝试抓取 --declared-price-page（或默认候选页）的网页价格作低信任参照（仅 warn 级提示，不产生 fail 判罚）；都不可得时明示「未核验金额/倍率」，不会伪造绝对值结论。
  价格核对默认比较「你录入的价 ÷ 站点当前公示价」，两者一致时为 1×；站内「列表价折扣」（当前公示价÷列表价）是另一个促销口径，只披露，不是计费倍率。
  倍率漂移对照同时使用 --baseline 快照与本地价格账本快照（两者都存在时逐项标注来源）：显著上调或口径断裂告警并封顶 85；明确下调视为更划算，只披露不扣分；无 --baseline 时只对照本地账本。
  账本按「主机+端口」归档：同一上游的反代路径别名（/v1 与 /relay/v1）共享同一账本与漂移历史，对照到不同路径的历史快照时以 info 披露。
  数值参数均按严格整数校验（不接受 "12abc"、前导空白等）；非法输入立即 exit 2 并给出正确示例。
  guard 子命令只读环境变量 MODEL_XRAY_KEY 作为密钥，且不提供 --key 旗标。

Exit codes: 0 pass/warn · 1 fail · 2 error
`;

async function main(argv: string[]): Promise<number> {
  // guard 子命令顶层分流：guard 有专属参数集（--port 等），用独立 parseArgs，避免顶层严格解析误伤
  if (argv[0] === 'guard') {
    return runGuard(argv.slice(1));
  }
  // pricing-watch 同样有专属参数集（--interval 等），独立解析。
  if (argv[0] === 'pricing-watch') {
    return runPricingWatch(argv.slice(1));
  }
  // pricing-scan 支持多站点与自定义端点，独立解析。
  if (argv[0] === 'pricing-scan') {
    return runPricingScan(argv.slice(1));
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        'base-url': { type: 'string' },
        key: { type: 'string' },
        model: { type: 'string' },
        'claimed-context': { type: 'string' },
        'context-samples': { type: 'string' },
        'context-budget-usd': { type: 'string' },
        expect: { type: 'string' },
        'price-input': { type: 'string' },
        'price-output': { type: 'string' },
        'price-cached-read': { type: 'string' },
        'price-threshold': { type: 'string' },
        'price-input2': { type: 'string' },
        'price-output2': { type: 'string' },
        'price-cached-read2': { type: 'string' },
        group: { type: 'string' },
        'expect-model-ratio': { type: 'string' },
        'expect-completion-ratio': { type: 'string' },
        'quota-per-usd': { type: 'string' },
        'declared-price-page': { type: 'string' },
        'read-balance': { type: 'boolean', default: false },
        baseline: { type: 'string' },
        'baseline-out': { type: 'string' },
        'token-reference': { type: 'string' },
        deep: { type: 'boolean', default: false },
        seed: { type: 'string' },
        timeout: { type: 'string' },
        retries: { type: 'string' },
        'http-retries': { type: 'string' },
        out: { type: 'string', default: 'reports' },
        yes: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        quiet: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
        version: { type: 'boolean', default: false },
      },
    });
  } catch (error) {
    console.error(`参数错误：${error instanceof Error ? error.message : String(error)}`);
    console.error(HELP);
    return 2;
  }

  const { values, positionals } = parsed;
  if (values.help || positionals[0] === 'help') {
    console.log(HELP);
    return 0;
  }
  if (values.version) {
    console.log(readVersion());
    return 0;
  }
  if (positionals[0] !== 'test') {
    console.error(
      `未知命令：${positionals[0] ?? '(无)'}。使用 "model-xray test ..."（一次性审计）、"model-xray guard ..."（常驻监控）、"model-xray pricing-watch ..."（公示倍率看门狗）或 "model-xray pricing-scan ..."（多站点价格扫描），或 --help。`,
    );
    return 2;
  }

  const baseUrl = values['base-url'] ?? '';
  const model = values.model ?? '';
  const apiKey = values.key ?? process.env['MODEL_XRAY_KEY'] ?? process.env['OPENAI_API_KEY'] ?? '';
  if (!baseUrl || !model) {
    console.error('缺少必填参数 --base-url 与 --model。');
    console.error('示例：model-xray test --base-url https://relay.example.com/v1 --key sk-xxx --model gpt-4o');
    console.error(HELP);
    return 2;
  }
  try {
    new URL(baseUrl);
  } catch {
    // 回显前脱敏：非法 URL 里也可能有 user:pass@，直接打印等于把凭据写进终端日志。
    console.error(`--base-url 不是合法 URL：${redactUrl(baseUrl)}`);
    console.error('示例：--base-url https://relay.example.com/v1（通常以 /v1 结尾）');
    return 2;
  }
  if (!apiKey && !values['dry-run']) {
    console.error('缺少 API key：--key 或环境变量 MODEL_XRAY_KEY / OPENAI_API_KEY。');
    console.error('示例：--key sk-xxx，或先执行 export MODEL_XRAY_KEY=sk-xxx');
    return 2;
  }

  let claimedContext: number | null = null;
  if (values['claimed-context'] !== undefined) {
    claimedContext = strictInt(values['claimed-context'], 1000, 100000000, 'claimed-context', '32000');
    if (claimedContext === null) return 2;
  }

  let contextSamples: number | undefined;
  if (values['context-samples'] !== undefined) {
    const parsed = strictInt(values['context-samples'], 1, 5, 'context-samples', '1');
    if (parsed === null) return 2;
    contextSamples = parsed;
  }

  const expectAllowed = ['vision', 'tool', 'thinking'] as const;
  const expectRaw = (values.expect ?? 'vision,tool').trim();
  let expect: string[] = [];
  if (expectRaw !== '' && expectRaw !== 'none') {
    const tokens = expectRaw.split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = tokens.filter((t) => !(expectAllowed as readonly string[]).includes(t));
    if (unknown.length > 0) {
      console.error(`--expect 含未知能力声明：${unknown.join(', ')}。合法值：${expectAllowed.join(', ')}（或 none 表示不宣称任何能力）。`);
      console.error('示例：--expect vision,tool');
      return 2;
    }
    expect = [...new Set(tokens)];
  }

  const priceFlags = parsePriceFlags({
    'price-input': values['price-input'],
    'price-output': values['price-output'],
    'price-cached-read': values['price-cached-read'],
    'price-threshold': values['price-threshold'],
    'price-input2': values['price-input2'],
    'price-output2': values['price-output2'],
    'price-cached-read2': values['price-cached-read2'],
  });
  if (priceFlags.error !== null) {
    console.error(priceFlags.error);
    return 2;
  }
  const price = priceFlags.price;
  // --read-balance fail-fast：应缴分母来自录入价，缺价格时余额对账静默失效，必须拦下而不是「跑了但测不出」。
  if (values['read-balance'] === true && price === null) {
    console.error('--read-balance 必须与 --price-input/--price-output 成对使用：实扣倍率 = 实际扣费 ÷（录入价×自报 usage），没有录入价就算不出应缴分母。');
    console.error('示例：model-xray test --base-url https://relay.example.com/v1 --model gpt-4o --price-input 2.5 --price-output 10 --read-balance');
    return 2;
  }

  // --group：站点分组名（new-api group 参数），仅用于挑选公示价格表里的 group_ratio 做展示对比
  const group = values.group !== undefined ? values.group.trim() : null;
  if (group !== null && group === '') {
    console.error('--group 不能为空字符串。示例：--group default');
    return 2;
  }
  let expectModelRatio: number | null = null;
  if (values['expect-model-ratio'] !== undefined) {
    expectModelRatio = strictPositiveNumber(values['expect-model-ratio'], 'expect-model-ratio', '1.5');
    if (expectModelRatio === null) return 2;
  }
  let expectCompletionRatio: number | null = null;
  if (values['expect-completion-ratio'] !== undefined) {
    expectCompletionRatio = strictPositiveNumber(values['expect-completion-ratio'], 'expect-completion-ratio', '4');
    if (expectCompletionRatio === null) return 2;
  }
  let quotaPerUsd: number | null = null;
  if (values['quota-per-usd'] !== undefined) {
    quotaPerUsd = strictPositiveNumber(values['quota-per-usd'], 'quota-per-usd', '500000');
    if (quotaPerUsd === null) return 2;
    // 与站点公示口径同一有效域（1~1e12）：用户覆盖值若落在域外，会与「站点公示值被作废」产生两种结论。
    if (!isPlausibleQuotaPerUnit(quotaPerUsd)) {
      console.error(
        `--quota-per-usd 必须是 ${QUOTA_PER_UNIT_MIN}~${QUOTA_PER_UNIT_MAX} 之间的数（每 1 美元对应的 quota 单位数）。收到：${quotaPerUsd}。示例：--quota-per-usd 500000`,
      );
      return 2;
    }
  }
  // --declared-price-page：/api/pricing 不可用时的网页价格兜底页（同源相对路径或同源绝对 URL）；
  // 同源与协议校验在 pricing-scrape 内 fail-closed（不符契约报 not_applicable，不会带 key 发请求）。
  const declaredPricePageRaw = values['declared-price-page'];
  let declaredPricePage: string | null = null;
  if (declaredPricePageRaw !== undefined) {
    declaredPricePage = declaredPricePageRaw.trim();
    if (declaredPricePage === '') {
      console.error('--declared-price-page 不能为空字符串。示例：--declared-price-page /pricing');
      return 2;
    }
  }

  // --context-budget-usd fail-fast：须为有限正数，且必须与 --price-input/--price-output 成对提供
  // （预算单位与价格一致，逐请求按「估算输入×输入价+输出预算×输出价」预扣）。
  let contextBudgetUsd: number | undefined;
  if (values['context-budget-usd'] !== undefined) {
    const raw = values['context-budget-usd'];
    const fail = (why: string): number => {
      console.error(`--context-budget-usd ${why}。收到：${JSON.stringify(raw)}。`);
      console.error('示例：--context-budget-usd 0.5 --price-input 2 --price-output 8');
      return 2;
    };
    if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(raw)) return fail('必须是大于 0 的有限数字');
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0 || value > 1e9) return fail('必须是大于 0 且不超过 1e9 的有限数字');
    if (price === null || price.input === null || price.output === null) {
      console.error(`--context-budget-usd 必须与 --price-input/--price-output 成对提供（预算单位与价格一致）。收到：${JSON.stringify(raw)}。`);
      console.error('示例：--context-budget-usd 0.5 --price-input 2 --price-output 8');
      return 2;
    }
    contextBudgetUsd = value;
  }

  // --baseline fail-fast：文件不存在 / 基线畸形都立即 exit 2，不发起任何请求（runner 内的 catch 降级仅供库调用方）
  let baselineData: ReturnType<typeof loadBaseline> | null = null;
  if (values.baseline !== undefined) {
    let readable = false;
    try {
      readable = statSync(values.baseline).isFile();
    } catch {
      readable = false;
    }
    if (!readable) {
      console.error(`--baseline 文件不存在或不可读：${values.baseline}`);
      console.error('下一步：先跑一次审计（--baseline-out 会生成基线文件），或核对路径拼写。示例：--baseline reports/baseline-gpt-4o-2026-01-01_00-00-00.json');
      return 2;
    }
    try {
      baselineData = loadBaseline(values.baseline);
    } catch (error) {
      console.error(`--baseline 基线文件非法：${error instanceof Error ? error.message : String(error)}`);
      console.error('下一步：用对应 --baseline-out 重新生成基线，或修正文件内容后重试。');
      return 2;
    }
  }

  // --token-reference fail-fast：文件不存在 / 参考报告非法都立即 exit 2，不发起任何请求
  let tokenReference: TokenReference | null = null;
  if (values['token-reference'] !== undefined) {
    let readable = false;
    try {
      readable = statSync(values['token-reference']).isFile();
    } catch {
      readable = false;
    }
    if (!readable) {
      console.error(`--token-reference 文件不存在或不可读：${values['token-reference']}`);
      console.error('示例：--token-reference reports/report-2026-01-01T00-00-00-000Z.json');
      return 2;
    }
    try {
      tokenReference = loadTokenReference(values['token-reference']);
    } catch (error) {
      console.error(`--token-reference 参考报告非法：${error instanceof Error ? error.message : String(error)}`);
      console.error('下一步：用本工具生成的报告 JSON（含 meta 与 billing outcomes），或重新生成参考后重试。');
      return 2;
    }
  }

  // seed 沿用：提供 --baseline 且未显式 --seed 时，用基线文件的 seed（保证题集可比）；显式 --seed 优先。
  let seed: number;
  if (values.seed !== undefined) {
    const parsedSeed = strictInt(values.seed, 1, 2147483646, 'seed', '12345');
    if (parsedSeed === null) return 2;
    seed = parsedSeed;
  } else if (baselineData !== null && Number.isFinite(baselineData.seed)) {
    seed = baselineData.seed;
  } else {
    seed = (Date.now() % 2147483646) + 1;
  }
  const timeoutSeconds = values.timeout !== undefined ? strictInt(values.timeout, 1, 3600, 'timeout', '90') : 90;
  if (timeoutSeconds === null) return 2;
  const retries = values.retries !== undefined ? strictInt(values.retries, 0, 3, 'retries', '1') : 1;
  if (retries === null) return 2;
  const httpRetries = values['http-retries'] !== undefined ? strictInt(values['http-retries'], 0, 6, 'http-retries', '2') : 2;
  if (httpRetries === null) return 2;

  const cfg: RunConfig = {
    baseUrl,
    apiKey,
    model,
    claimedContext,
    expect,
    deep: values.deep === true,
    contextSamples,
    contextBudgetUsd,
    seed,
    timeoutMs: timeoutSeconds * 1000,
    retries,
    httpRetries,
    outDir: values.out ?? 'reports',
    html: true,
    yes: values.yes === true,
    quiet: values.quiet === true,
    priceInput: price?.input ?? null,
    priceOutput: price?.output ?? null,
    priceCachedRead: price?.cachedRead ?? null,
    priceThreshold: price?.threshold ?? null,
    priceInput2: price?.input2 ?? null,
    priceOutput2: price?.output2 ?? null,
    priceCachedRead2: price?.cachedRead2 ?? null,
    readBalance: values['read-balance'] === true,
    group,
    expectModelRatio,
    expectCompletionRatio,
    quotaPerUsd,
    declaredPricePage,
    baselineIn: values.baseline ?? null,
    baselineOut: values['baseline-out'] ?? null,
    tokenReference,
  };

  const cost = estimateCost(cfg);
  console.error(
    `预估：约 ${cost.calls} 次请求 / ~${cost.inputTokens.toLocaleString('en-US')} 输入 tokens（不含输出与重试；seed=${seed}）。`,
  );
  if (cost.inputTokens >= 500000) {
    console.error('提示：本轮预估输入 tokens 较大；低成本筛查可先用默认档（或 --claimed-context 32000），定论再用 --deep。');
  }

  if (values['dry-run']) {
    console.error('dry-run：未发送任何请求。');
    return 0;
  }

  if (!isLocalEndpoint(baseUrl) && !cfg.yes) {
    if (!process.stdin.isTTY) {
      console.error('远程端点需确认成本。下一步：加 --yes 跳过确认，或先跑 --dry-run 查看预估。');
      return 2;
    }
    const confirmed = await confirm(
      `将对远程端点发起真实请求（预估 ~${cost.inputTokens.toLocaleString('en-US')} tokens 输入）。继续？[y/N] `,
    );
    if (!confirmed) {
      console.error('已取消。下一步：确认成本后重跑，加 --yes 可跳过确认；先 --dry-run 可预览请求量。');
      return 2;
    }
  }

  let report: AuditReport;
  // WebUI 由 serve.mjs 注入 MODEL_XRAY_PROGRESS=1：输出阶段与每请求进度，避免长上下文探针看起来「卡死」。
  // 直接跑 CLI 时保持原有简洁输出；需要进度可自行设置该环境变量。
  const onActivity =
    process.env.MODEL_XRAY_PROGRESS === '1' && !cfg.quiet
      ? (message: string) => {
          console.error(message);
        }
      : undefined;
  try {
    report = await runAudit(
      cfg,
      (id, outcome) => {
        if (!cfg.quiet) console.error(`[${outcome.level.toUpperCase()}] ${id} — ${outcome.headline}`);
      },
      // 复用 fail-fast 阶段已校验的基线：探针执行后不再重读磁盘（文件中途损坏不至于静默丢指纹对比）
      baselineData ?? undefined,
      onActivity,
    );
  } catch (error) {
    console.error(`审计失败：${error instanceof Error ? error.message : String(error)}`);
    console.error('下一步：检查端点可达性与 --base-url 拼写（通常以 /v1 结尾），或加大 --timeout 后重试。');
    return 2;
  }

  // 文件名主干 = <safeModel>-<本地时间戳>；report 与 baseline 共用同一 stamp（现状保持）
  const stamp = makeFileStamp(new Date(), cfg.model);
  let written;
  try {
    // 每轮审计默认落盘指纹基线（可用 --baseline-out 指定路径），供后续 --baseline 复测对比。
    // 零可评分项（配额耗尽/端点全挂）不写基线：空指纹会被后续 --baseline 当成有效参照，产生假漂移。
    const hasScorableOutcome = report.outcomes.some((outcome) => outcome.score !== null);
    const baseline = hasScorableOutcome
      ? buildBaseline(report.outcomes, {
          model: report.meta.model,
          seed: report.meta.seed,
          probesetVersion: report.meta.probesetVersion,
          assetsVersion: report.meta.assetsVersion,
          createdAt: report.meta.startedAt,
        })
      : null;
    written = writeReports(report, cfg.outDir, stamp, baseline, cfg.baselineOut);
  } catch (error) {
    console.error(`报告写入失败：${error instanceof Error ? error.message : String(error)}`);
    console.error(`下一步：检查 --out 目录（当前：${cfg.outDir}）是否可写，或换一个输出目录重试。示例：--out reports`);
    return 2;
  }

  console.log(renderConsole(report, { color: supportsColor(process.stdout) }));
  console.error('');
  console.error(`报告已写入：`);
  console.error(`  ${written.markdownPath}`);
  console.error(`  ${written.htmlPath}`);
  console.error(`  ${written.jsonPath}`);
  if (written.baselinePath) console.error(`  ${written.baselinePath}`);

  if (report.overall === 'fail') return 1;
  // total=null 表示没有任何足够的可评分证据——按契约属于「未得出结论」，
  // 退出码必须是 2，避免配额耗尽/端点全挂的一轮被脚本误当成正常完成。
  // billing 仅有形状证据时不再悬置为 insufficient（本维度核验对象是 usage，形状全过给判定 85），
  // 因此 total null 只会来自真实样本不足。
  if (report.total === null || report.overall === 'unknown') {
    console.error('审计未能得出结论（可评分项不足）。请核对 API key、端点可达性与模型名后重试；详见报告 notes。');
    return 2;
  }
  return 0;
}

export function isLocalEndpoint(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

export function estimateCost(cfg: RunConfig): { calls: number; inputTokens: number } {
  const contextSamples = cfg.contextSamples ?? (cfg.deep ? 5 : 1);
  const claimed = cfg.claimedContext ?? 32000;
  // context：samples × 4 深度 + 结尾回显 1。标准低成本档不复采；3 样本统计档最多复核
  // 3 档 × 2 样本；deep 边界扫描最多 18 发。按各深度实际比例累加，不再用 0.41 的低估系数。
  const confirmSamples = cfg.deep ? 3 : (cfg.contextConfirmSamples ?? 2);
  const confirmCalls = cfg.deep ? 18 : contextSamples >= 3 ? 3 * confirmSamples : 0;
  const contextCalls = contextSamples * 4 + 1 + confirmCalls;
  const contextUnits = contextSamples * 2.4 + 0.9 + (cfg.deep ? 18 * 0.55 : contextSamples >= 3 ? 3 * confirmSamples * 0.65 : 0);
  const contextTokens = Math.round(contextUnits * claimed);
  // billing：2 语言 × 目标长度档位，逐档累加（标准 5 档 2k/4k/8k/16k/24k；deep 6 档含 32k）
  const billingLevels = cfg.billingLevels ?? (cfg.deep ? [2000, 4000, 8000, 16000, 24000, 32000] : [2000, 4000, 8000, 16000, 24000]);
  const billingCalls = 2 * billingLevels.length;
  const billingInputTokens = Math.round(2 * billingLevels.reduce((sum, n) => sum + n, 0) * 1.1);
  const calls =
    contextCalls +
    billingCalls +
    // identity 自述 5 次（deep 8 次）+ 1 次格式合规 + 1 次诱饵
    (cfg.deep ? 10 : 7) +
    (cfg.expect.includes('vision') ? 3 : 0) +
    (cfg.expect.includes('tool') ? 2 : 0) +
    15 + // quality 题集（与模式无关，恒 15 题）
    // quality 主问题复采样上限（仅干净答错时触发；最坏 +12）
    12 +
    9; // ttft 观测：5 串行 + 1 轮 4 并发（重试不计入）
  const inputTokens = contextTokens + billingInputTokens + 15000 + (cfg.expect.includes('vision') ? 1200 : 0);
  return { calls, inputTokens };
}

async function confirm(question: string): Promise<boolean> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

function readVersion(): string {
  try {
    const pkgPath = new URL('../../package.json', import.meta.url);
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * 严格整数解析：/^[+-]?\d+$/ + Number.isSafeInteger + 范围校验。
 * 非法时向 stderr 输出含范围、实际值与正确示例的中文错误，返回 null（调用方 return 2）。
 * 取代 Number.parseInt —— parseInt('12abc')===12 会静默吞掉尾部垃圾字符。
 */
export function strictInt(raw: string, min: number, max: number, name: string, example: string): number | null {
  const fail = (): null => {
    console.error(`--${name} 必须是 [${min}, ${max}] 的整数。收到：${JSON.stringify(raw)}。`);
    console.error(`示例：--${name} ${example}`);
    return null;
  };
  if (!/^[+-]?\d+$/.test(raw)) return fail();
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) return fail();
  return value;
}

/** 严格正数解析（倍率 / quota 换算率，允许小数与科学计数）：拒绝 NaN、0、负数与尾部垃圾字符。 */
export function strictPositiveNumber(raw: string, name: string, example: string): number | null {
  const fail = (): null => {
    console.error(`--${name} 必须为正数。收到：${JSON.stringify(raw)}。`);
    console.error(`示例：--${name} ${example}`);
    return null;
  };
  if (!/^\+?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(raw)) return fail();
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fail();
  return value;
}

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].replace(/\\/g, '/').endsWith('/cli.js');
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
      scheduleExitGuard(code);
    })
    .catch((error) => {
      console.error(`未捕获错误：${error instanceof Error ? error.stack : String(error)}`);
      console.error('下一步：带上完整命令与该堆栈反馈问题；重跑时可先 --dry-run 验证参数。');
      process.exitCode = 2;
      scheduleExitGuard(2);
    });
}

/**
 * F4 退出兜底：main 已返回、报告已同步写盘，但未知句柄（socket keep-alive/连接池等）可能挂住事件循环，
 * 令进程迟迟不退出、退出码契约失守。10s 后仍存活即强制 exit(code)。
 * timer.unref()：健康路径不等这个定时器（进程自然退出），只有被挂住时它才生效。
 */
export function scheduleExitGuard(code: number, delayMs = 10_000): void {
  const timer = setTimeout(() => {
    process.exit(code);
  }, delayMs);
  timer.unref();
}

export { main };
export { createRng };
