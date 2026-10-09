#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { runAudit } from './runner.js';
import { createRng } from './random.js';
import { buildBaseline, loadBaseline } from './baseline.js';
import { writeReports } from './report/files.js';
import { renderConsole } from './report/console.js';
import type { AuditReport, RunConfig } from './types.js';

const HELP = `model-xray — audit OpenAI-compatible endpoints for fake or watered-down models

Usage:
  model-xray test --base-url <url> --key <key> --model <model> [options]

Options:
  --base-url <url>          Endpoint base URL, e.g. https://relay.example.com/v1
  --key <key>               API key (or env MODEL_XRAY_KEY / OPENAI_API_KEY)
  --model <model>           Model name to audit, e.g. gpt-4o
  --claimed-context <n>     Advertised context window in tokens, integer in [1000, 100000000] (enables context probe)
  --expect <list>           Claimed capabilities, comma-separated from: vision,tool,thinking (or "none"; default: vision,tool)
  --price-input <n>         Claimed input price per 1M tokens, must be > 0 (with --price-output, enables measured-rate probe)
  --price-output <n>        Claimed output price per 1M tokens, must be > 0 (must appear with --price-input)
  --retries <n>             Retries per request on 408/409/429/5xx, integer in [0, 3] (default: 0)
                            注意：每次重试都会真实计费，默认不重试；开了重试会令实测倍率判定作废（防重复计费污染）
  --baseline <path>         Compare fingerprints against a baseline file (seed is reused unless --seed)
  --baseline-out <path>     Where to write this run's baseline (default: reports/baseline-<stamp>.json)
  --deep                    More samples (slower, more tokens)
  --seed <n>                Random seed, integer in [1, 2147483646] (default: time-based; with --baseline defaults to baseline seed)
  --timeout <seconds>       Per-request timeout in seconds, integer in [1, 3600] (default: 60)
  --out <dir>               Report output directory (default: reports)
  --yes                     Skip the token-cost confirmation on remote endpoints
  --dry-run                 Print the planned requests and token estimate, then exit
  --quiet                   Only print the final verdict
  --help                    Show this help
  --version                 Print version

Notes:
  价格为「每百万 tokens 的宣称价格」，必须为正数；单位需与该站余额显示单位一致（美元/quota 均可），工具只算比值，不做单位换算。
  数值参数均按严格整数校验（不接受 "12abc"、前导空白等）；非法输入立即 exit 2 并给出正确示例。

Exit codes: 0 pass/warn · 1 fail · 2 error
`;

async function main(argv: string[]): Promise<number> {
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
        expect: { type: 'string' },
        'price-input': { type: 'string' },
        'price-output': { type: 'string' },
        baseline: { type: 'string' },
        'baseline-out': { type: 'string' },
        deep: { type: 'boolean', default: false },
        seed: { type: 'string' },
        timeout: { type: 'string' },
        retries: { type: 'string' },
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
    console.error(`未知命令：${positionals[0] ?? '(无)'}。使用 "model-xray test ..." 或 --help。`);
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
    console.error(`--base-url 不是合法 URL：${baseUrl}`);
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

  const priceInputRaw = values['price-input'];
  const priceOutputRaw = values['price-output'];
  let priceInput: number | null = null;
  let priceOutput: number | null = null;
  if (priceInputRaw !== undefined || priceOutputRaw !== undefined) {
    if (priceInputRaw === undefined || priceOutputRaw === undefined) {
      console.error('--price-input 与 --price-output 必须成对出现。');
      console.error('示例：--price-input 2.5 --price-output 10');
      return 2;
    }
    const parsedInput = positiveNumber(priceInputRaw, 'price-input');
    const parsedOutput = positiveNumber(priceOutputRaw, 'price-output');
    if (parsedInput === null || parsedOutput === null) return 2;
    priceInput = parsedInput;
    priceOutput = parsedOutput;
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
      console.error('下一步：先跑一次审计（--baseline-out 会生成基线文件），或核对路径拼写。示例：--baseline reports/baseline-2026-01-01T00-00-00-000Z.json');
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
  const timeoutSeconds = values.timeout !== undefined ? strictInt(values.timeout, 1, 3600, 'timeout', '60') : 60;
  if (timeoutSeconds === null) return 2;
  const retries = values.retries !== undefined ? strictInt(values.retries, 0, 3, 'retries', '1') : 0;
  if (retries === null) return 2;

  const cfg: RunConfig = {
    baseUrl,
    apiKey,
    model,
    claimedContext,
    expect,
    deep: values.deep === true,
    seed,
    timeoutMs: timeoutSeconds * 1000,
    retries,
    outDir: values.out ?? 'reports',
    html: true,
    yes: values.yes === true,
    quiet: values.quiet === true,
    priceInput,
    priceOutput,
    baselineIn: values.baseline ?? null,
    baselineOut: values['baseline-out'] ?? null,
  };

  const cost = estimateCost(cfg);
  console.error(
    `预估：约 ${cost.calls} 次请求 / ~${cost.inputTokens.toLocaleString()} 输入 tokens（不含输出与重试；seed=${seed}）。`,
  );

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
      `将对远程端点发起真实请求（预估 ~${cost.inputTokens.toLocaleString()} tokens 输入）。继续？[y/N] `,
    );
    if (!confirmed) {
      console.error('已取消。下一步：确认成本后重跑，加 --yes 可跳过确认；先 --dry-run 可预览请求量。');
      return 2;
    }
  }

  let report: AuditReport;
  try {
    report = await runAudit(cfg, (id, outcome) => {
      if (!cfg.quiet) console.error(`[${outcome.level.toUpperCase()}] ${id} — ${outcome.headline}`);
    });
  } catch (error) {
    console.error(`审计失败：${error instanceof Error ? error.message : String(error)}`);
    console.error('下一步：检查端点可达性与 --base-url 拼写（通常以 /v1 结尾），或加大 --timeout 后重试。');
    return 2;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let written;
  try {
    // 每轮审计默认落盘指纹基线（可用 --baseline-out 指定路径），供后续 --baseline 复测对比
    const baseline = buildBaseline(report.outcomes, {
      model: report.meta.model,
      seed: report.meta.seed,
      probesetVersion: report.meta.probesetVersion,
      assetsVersion: report.meta.assetsVersion,
      createdAt: report.meta.startedAt,
    });
    written = writeReports(report, cfg.outDir, stamp, baseline, cfg.baselineOut);
  } catch (error) {
    console.error(`报告写入失败：${error instanceof Error ? error.message : String(error)}`);
    console.error(`下一步：检查 --out 目录（当前：${cfg.outDir}）是否可写，或换一个输出目录重试。示例：--out reports`);
    return 2;
  }

  console.log(renderConsole(report));
  console.error('');
  console.error(`报告已写入：`);
  console.error(`  ${written.markdownPath}`);
  console.error(`  ${written.htmlPath}`);
  console.error(`  ${written.jsonPath}`);
  if (written.baselinePath) console.error(`  ${written.baselinePath}`);

  if (report.overall === 'fail') return 1;
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
  const contextSamples = cfg.deep ? 5 : 3;
  const contextDepths = 4;
  const claimed = cfg.claimedContext ?? 32000;
  const contextCalls = contextSamples * contextDepths + 2;
  const contextTokens = Math.round(contextCalls * claimed * 0.41);
  const calls =
    contextCalls +
    (cfg.deep ? 7 : 5) +
    10 +
    (cfg.expect.includes('vision') ? 3 : 0) +
    (cfg.expect.includes('tool') ? 2 : 0) +
    (cfg.deep ? 24 : 16) +
    17;
  const inputTokens = contextTokens + 20000 + (cfg.expect.includes('vision') ? 1200 : 0);
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
function strictInt(raw: string, min: number, max: number, name: string, example: string): number | null {
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

/** 严格正数解析（价格）：必须形如数字、Number() 后有限且 > 0；空串/0/负数/非数字一律报错。 */
function positiveNumber(raw: string, name: string): number | null {
  const fail = (): null => {
    console.error(`--${name} 必须为正数（每百万 tokens 宣称价格）。收到：${JSON.stringify(raw)}。`);
    console.error(`示例：--${name === 'price-input' ? 'price-input 2.5' : 'price-output 10'}（与另一价格 flag 成对使用）`);
    return null;
  };
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(raw)) return fail();
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fail();
  return value;
}

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].replace(/\\/g, '/').endsWith('/cli.js');
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`未捕获错误：${error instanceof Error ? error.stack : String(error)}`);
      console.error('下一步：带上完整命令与该堆栈反馈问题；重跑时可先 --dry-run 验证参数。');
      process.exitCode = 2;
    });
}

export { main };
export { createRng };
