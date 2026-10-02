#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { runAudit } from './runner.js';
import { createRng } from './random.js';
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
  --claimed-context <n>     Advertised context window in tokens (enables context probe)
  --expect <list>           Claimed capabilities: vision,tool,thinking or none (default: vision,tool)
  --deep                    More samples (slower, more tokens)
  --seed <n>                Random seed for reproducibility (default: time-based)
  --timeout <seconds>       Per-request timeout (default: 60)
  --out <dir>               Report output directory (default: reports)
  --yes                     Skip the token-cost confirmation on remote endpoints
  --dry-run                 Print the planned requests and token estimate, then exit
  --quiet                   Only print the final verdict
  --help                    Show this help
  --version                 Print version

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
        deep: { type: 'boolean', default: false },
        seed: { type: 'string' },
        timeout: { type: 'string' },
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
    console.error(HELP);
    return 2;
  }
  try {
    new URL(baseUrl);
  } catch {
    console.error(`--base-url 不是合法 URL：${baseUrl}`);
    return 2;
  }
  if (!apiKey && !values['dry-run']) {
    console.error('缺少 API key：--key 或环境变量 MODEL_XRAY_KEY / OPENAI_API_KEY。');
    return 2;
  }

  const claimedContext = values['claimed-context'] ? Number.parseInt(values['claimed-context'], 10) : null;
  if (claimedContext !== null && (!Number.isFinite(claimedContext) || claimedContext <= 0)) {
    console.error('--claimed-context 必须是正整数。');
    return 2;
  }
  const expectRaw = (values.expect ?? 'vision,tool').trim();
  const expect = expectRaw === '' || expectRaw === 'none' ? [] : expectRaw.split(',').map((s) => s.trim()).filter(Boolean);
  const seed = values.seed ? Number.parseInt(values.seed, 10) : Date.now() % 2147483647;
  if (!Number.isFinite(seed)) {
    console.error('--seed 必须是整数。');
    return 2;
  }
  const timeoutSeconds = values.timeout ? Number.parseInt(values.timeout, 10) : 60;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    console.error('--timeout 必须是正整数秒数。');
    return 2;
  }

  const cfg: RunConfig = {
    baseUrl,
    apiKey,
    model,
    claimedContext,
    expect,
    deep: values.deep === true,
    seed,
    timeoutMs: timeoutSeconds * 1000,
    retries: 1,
    outDir: values.out ?? 'reports',
    html: true,
    yes: values.yes === true,
    quiet: values.quiet === true,
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
      console.error('远程端点需确认成本。请加 --yes 跳过确认，或先跑 --dry-run 查看预估。');
      return 2;
    }
    const confirmed = await confirm(
      `将对远程端点发起真实请求（预估 ~${cost.inputTokens.toLocaleString()} tokens 输入）。继续？[y/N] `,
    );
    if (!confirmed) {
      console.error('已取消。');
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
    return 2;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let written;
  try {
    written = writeReports(report, cfg.outDir, stamp);
  } catch (error) {
    console.error(`报告写入失败：${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  console.log(renderConsole(report));
  console.error('');
  console.error(`报告已写入：`);
  console.error(`  ${written.markdownPath}`);
  console.error(`  ${written.htmlPath}`);
  console.error(`  ${written.jsonPath}`);

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

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].replace(/\\/g, '/').endsWith('/cli.js');
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`未捕获错误：${error instanceof Error ? error.stack : String(error)}`);
      process.exitCode = 2;
    });
}

export { main };
export { createRng };
