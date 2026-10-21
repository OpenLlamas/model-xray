import { parseArgs } from 'node:util';
import { strictInt } from '../cli.js';
import { parsePriceFlags } from '../price-flags.js';
import type { ModelPrice } from '../gateway/pricing.js';
import { supportsColor } from '../color.js';
import { FingerprintMonitor } from './fingerprint.js';
import { JournalWriter, type ScoreEntry } from './journal.js';
import { Reconciler } from './reconcile.js';
import { Scoreboard, formatScorecard } from './scoreboard.js';
import { createGuardServer } from './server.js';

const GUARD_HELP = `model-xray guard — 常驻监控：本地透明转发代理，逐请求审计中转站流量

用法:
  model-xray guard --base-url <url> [options]

与 test 的区别：
  model-xray test  一次性审计：主动跑一轮探针请求，产出评分报告后退出。
  model-xray guard 常驻监控：本地透明代理把客户端流量原样转发到真实中转站，
                   逐请求监听（模型一致性 / token 统计 / 余额滚动对账），异常即时 stderr 告警，
                   全部写入 append-only JSONL 审计日志（仅元数据，无对话内容）。

评分卡:
  每 20 个已转发请求输出一次多维实时评分（可用性/计量/身份/时延/成本），退出时无论计数再输出一张终卡；
  滚动窗口为最近 100 个已转发请求（本地 401/403 拒绝的请求不转发，天然不入窗）；
  「观测」列（截断率/缺用量/中止数）仅记录不计总评；成本维度仅在提供价格对且对账结算后出分；
  小样本（窗口内请求很少时）单笔异常即可拉红总评，属正常抖动，请结合窗口规模解读。

参数:
  --base-url <url>            必填。真实中转站地址，例如 https://relay.example.com/v1
  --port <n>                  本地监听端口，[1, 65535] 整数（默认 8621）
  --out <dir>                 审计日志目录（默认 reports/guard；按日轮转 guard-YYYYMMDD.jsonl）
  --price-input <n>           录入输入价（与余额同单位/百万 tokens），与 --price-output 成对出现才启用金额对账
  --price-output <n>          录入输出价（与余额同单位/百万 tokens）
  --price-cached-read <n>     录入缓存读价（与余额同单位/百万 tokens，可不填=按输入价）
  --price-threshold <n>       长上下文阶梯阈值（prompt tokens 正整数；须与二档输入/输出同填）
  --price-input2 <n>          二档输入价（$/M tokens）
  --price-output2 <n>         二档输出价（$/M tokens）
  --price-cached-read2 <n>    二档缓存读价（$/M tokens，可不填=按二档输入价）
  --reconcile-minutes <n>     余额对账周期，[0, 1440] 整数分钟（默认 15；0=关闭；仅在提供价格对后生效）
  --fingerprint-minutes <n>   主动指纹复核周期，[0, 10080] 整数分钟（默认 0=关闭；
                              开启后每周期真实发起 5+1 次对话请求（--deep 档 8+1），会真实计费）
  --help                      显示本帮助

密钥：仅读环境变量 MODEL_XRAY_KEY（guard 不提供 --key 旗标，避免 key 进入命令行历史）。
  PowerShell 示例：$env:MODEL_XRAY_KEY = 'sk-xxx'
  bash 示例：export MODEL_XRAY_KEY=sk-xxx

客户端配置指引（启动后横幅会再次打印）:
  1. 把客户端 base-url 改为 http://127.0.0.1:<port>/v1（--base-url 带不带 /v1 均可：与 --base-url
     完整路径前缀重复的部分自动去重；--base-url 不得带 query/fragment）
  2. 把客户端 API key 设为与 MODEL_XRAY_KEY 相同的值（不一致的请求会被 401 拒绝，不转发）

Exit codes: 0 正常退出 · 1 端口占用/启动失败 · 2 参数/环境错误
`;

/**
 * model-xray guard 子命令入口（由 src/cli.ts 在顶层分流）。
 * 返回进程退出码；进程在 server 关闭、journal flush 完成后才返回。
 * 退出触发：SIGINT/SIGTERM，或 stdin EOF（管道/测试用法）。
 */
export async function runGuard(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: false,
      strict: true,
      options: {
        'base-url': { type: 'string' },
        port: { type: 'string' },
        out: { type: 'string' },
        'price-input': { type: 'string' },
        'price-output': { type: 'string' },
        'price-cached-read': { type: 'string' },
        'price-threshold': { type: 'string' },
        'price-input2': { type: 'string' },
        'price-output2': { type: 'string' },
        'price-cached-read2': { type: 'string' },
        'reconcile-minutes': { type: 'string' },
        'fingerprint-minutes': { type: 'string' },
        help: { type: 'boolean', default: false },
      },
    });
  } catch (error) {
    console.error(`参数错误：${error instanceof Error ? error.message : String(error)}`);
    console.error(GUARD_HELP);
    return 2;
  }
  const values = parsed.values;
  if (values.help) {
    console.log(GUARD_HELP);
    return 0;
  }

  const baseUrl = values['base-url'] ?? '';
  if (baseUrl.length === 0) {
    console.error('缺少必填参数 --base-url。');
    console.error('示例：model-xray guard --base-url https://relay.example.com/v1');
    return 2;
  }
  try {
    const parsedUrl = new URL(baseUrl);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      console.error(`--base-url 协议必须是 http/https。收到：${baseUrl}`);
      console.error('示例：--base-url https://relay.example.com/v1（通常以 /v1 结尾）');
      return 2;
    }
    if (parsedUrl.search !== '' || parsedUrl.hash !== '') {
      console.error(`--base-url 不得携带 query 或 fragment（凭证请走环境变量 MODEL_XRAY_KEY）。收到：${baseUrl}`);
      console.error('示例：--base-url https://relay.example.com/v1');
      return 2;
    }
  } catch {
    console.error(`--base-url 不是合法 URL：${baseUrl}`);
    console.error('示例：--base-url https://relay.example.com/v1（通常以 /v1 结尾）');
    return 2;
  }

  const port = values.port !== undefined ? strictInt(values.port, 1, 65535, 'port', '8621') : 8621;
  if (port === null) return 2;

  const out = values.out ?? 'reports/guard';
  if (out.trim().length === 0) {
    console.error('--out 不能为空白字符串。收到：' + JSON.stringify(out));
    console.error('示例：--out reports/guard');
    return 2;
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
  const prices = priceFlags.price;

  const reconcileMinutes =
    values['reconcile-minutes'] !== undefined ? strictInt(values['reconcile-minutes'], 0, 1440, 'reconcile-minutes', '15') : 15;
  if (reconcileMinutes === null) return 2;
  const fingerprintMinutes =
    values['fingerprint-minutes'] !== undefined
      ? strictInt(values['fingerprint-minutes'], 0, 10080, 'fingerprint-minutes', '60')
      : 0;
  if (fingerprintMinutes === null) return 2;

  // key 仅读环境变量；任何错误输出都不得回显环境变量值
  const key = process.env['MODEL_XRAY_KEY'] ?? '';
  if (key.length === 0) {
    console.error('缺少 API key：guard 仅从环境变量 MODEL_XRAY_KEY 读取（不提供 --key 旗标，避免 key 进入命令行历史）。');
    console.error("示例（PowerShell）：$env:MODEL_XRAY_KEY = 'sk-xxx'    示例（bash）：export MODEL_XRAY_KEY=sk-xxx");
    return 2;
  }

  let journal: JournalWriter;
  try {
    journal = new JournalWriter(out);
  } catch (error) {
    console.error(`审计日志目录不可创建：${error instanceof Error ? error.message : String(error)}`);
    console.error(`下一步：检查 --out 路径（当前：${out}）是否可写，或换一个目录。示例：--out reports/guard`);
    return 2;
  }

  // 多维实时评分卡：窗口 100、每 20 个已转发请求输出一次（构造参数即注入口，测试可调小）。
  // emit 回调两件事——journal 落 score 条目 + 控制台单行卡；必修⑤：各自包 try/catch，审计失败只 stderr 提示不退出。
  const scoreboard = new Scoreboard({
    windowSize: 100,
    emitEvery: 20,
    onEmit: (card) => {
      const entry: ScoreEntry = {
        type: 'score',
        ts: new Date().toISOString(),
        fromId: card.fromId,
        toId: card.toId,
        requests: card.requests,
        dims: card.dims.map((d) => ({ id: d.id, score: d.score, level: d.level })),
        observed: card.observed,
        overall: card.overall,
      };
      try {
        journal.append(entry);
      } catch (error) {
        console.error(`[guard] 评分卡写入审计日志失败：${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        console.log(formatScorecard(card, { color: supportsColor(process.stdout) }));
      } catch (error) {
        console.error(`[guard] 评分卡打印失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

  const reconciler =
    prices !== null && reconcileMinutes > 0
      ? new Reconciler({
          baseUrl,
          apiKey: key,
          prices,
          intervalMs: reconcileMinutes * 60000,
          journal,
          // 对账结算（含 skipped 类）回填评分卡成本维度：多结算取最新
          onSettled: (entry) => scoreboard.setCost({ ratio: entry.ratio, verdict: entry.verdict }),
        })
      : null;
  const fingerprint =
    fingerprintMinutes > 0
      ? new FingerprintMonitor({ baseUrl, apiKey: key, intervalMs: fingerprintMinutes * 60000, journal })
      : null;

  const guard = createGuardServer({ upBaseUrl: baseUrl, key, journal, prices, reconciler, fingerprint, scoreboard });
  let actualPort: number;
  try {
    actualPort = await guard.listen(port);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      const suggestion = port === 65535 ? 8621 : port + 1;
      console.error(`端口 ${port} 被占用，换一个端口：model-xray guard --base-url ${baseUrl} --port ${suggestion}`);
      return 1;
    }
    console.error(`guard 启动失败：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  // 先建立对账基线再打横幅：保证横幅打出后收到的每个请求都落入完整对账窗口
  if (reconciler !== null) await reconciler.initialize();
  reconciler?.start();
  fingerprint?.start();

  printBanner({ port: actualPort, baseUrl, out, prices, reconcileMinutes: reconciler !== null ? reconcileMinutes : 0, fingerprintActive: fingerprint !== null, fingerprintMinutes });

  await new Promise<void>((resolve) => {
    let initiated = false;
    const shutdown = (trigger: string): void => {
      if (initiated) return;
      initiated = true;
      void (async () => {
        try {
          await fingerprint?.stop();
          if (reconciler !== null) {
            reconciler.stop();
            await reconciler.tick(true);
          }
          await guard.close();
          // 退出终卡：无论计数必输出一次（空窗为全 N/A 卡）；必须在 journal.flush 前写入
          try {
            scoreboard.final();
          } catch (error) {
            console.error(`[guard] 评分卡终卡输出失败：${error instanceof Error ? error.message : String(error)}`);
          }
          await journal.flush();
          console.error(`guard 已停止（${trigger}），审计日志已落盘。`);
        } catch (error) {
          console.error(`guard 退出清理失败：${error instanceof Error ? error.message : String(error)}`);
          process.exitCode = 1;
        }
        resolve();
      })();
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    // stdin EOF 触发优雅退出：管道/测试用法（TTY 交互用法走 Ctrl+C 的 SIGINT）
    process.stdin.resume();
    process.stdin.once('end', () =>
      shutdown('stdin 已关闭——管道/测试用法触发；如需服务化常驻，请用能保持 stdin 打开的方式托管'),
    );
  });
  return typeof process.exitCode === 'number' ? process.exitCode : 0;
}

function printBanner(info: {
  port: number;
  baseUrl: string;
  out: string;
  prices: ModelPrice | null;
  reconcileMinutes: number;
  fingerprintActive: boolean;
  fingerprintMinutes: number;
}): void {
  const day = new Date();
  const stamp = `${String(day.getFullYear()).padStart(4, '0')}${String(day.getMonth() + 1).padStart(2, '0')}${String(day.getDate()).padStart(2, '0')}`;
  const reconcileText =
    info.prices === null
      ? '关闭（未提供 --price-input/--price-output，仅统计 tokens 不算金额）'
      : info.reconcileMinutes > 0
        ? `开启（价格 ${info.prices.input}/${info.prices.output} 每百万 tokens${info.prices.cachedRead !== undefined ? `，缓存读 ${info.prices.cachedRead}` : ''}${info.prices.threshold !== undefined ? `；>${info.prices.threshold} tokens 阶梯 ${info.prices.input2}/${info.prices.output2}` : ''}；周期 ${info.reconcileMinutes} 分钟）`
        : '关闭（--reconcile-minutes 0）';
  console.log('model-xray guard 已启动');
  console.log(`  监听        http://127.0.0.1:${info.port}（仅本机回环）`);
  console.log(`  转发上游    ${info.baseUrl}`);
  console.log(`  审计日志    ${info.out}/guard-${stamp}.jsonl（JSONL，仅元数据，无对话内容与密钥）`);
  console.log(`  金额对账    ${reconcileText}`);
  console.log(
    `  指纹复核    ${info.fingerprintActive ? `开启（周期 ${info.fingerprintMinutes} 分钟；注意探针真实计费）` : '关闭（--fingerprint-minutes 0）'}`,
  );
  console.log('  评分卡      每 20 个已转发请求输出一次 + 退出终卡（窗口 100；观测项不计总评；小样本单请求可能拉红总评，属正常抖动）');
  console.log('客户端配置指引：');
  console.log(`  1) 客户端 base-url 改为 http://127.0.0.1:${info.port}/v1`);
  console.log('  2) 客户端 API key 设为与 MODEL_XRAY_KEY 相同的值（不一致的请求会被 401 拒绝，不转发）');
  console.log('Ctrl+C（或关闭 stdin）停止；停止时会结算最后一个对账窗口并 flush 日志。');
}
