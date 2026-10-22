import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// web/ 不在 tsconfig include 内（不参与 tsc 编译），运行时产物里没有 dist/web/app.js。
// 因此这里只用 `import type`（编译期擦除，类型来自 web/app.d.ts），
// 值在运行时从本文件位置向上查找仓库里的 web/app.js 动态导入
// （dist/test/unit → dist/test → dist → 仓库根，共三层）。
import type { WebApp } from '../../web/app.js';

function locateWebApp(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, 'web', 'app.js');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('未找到 web/app.js：请在仓库根目录下构建并运行测试。');
}

const webApp = (await import(pathToFileURL(locateWebApp()).href)) as WebApp;
const {
  buildCommand,
  renderScorecard,
  escapeHtml,
  scrubSecrets,
  buildModelPrices,
  formatCostUsd,
  classifyLogLine,
  normalizeInjectedToken,
  extractTokenFromHtml,
  isTokenAuthError,
} = webApp;
const dashboardHtml = readFileSync(join(dirname(locateWebApp()), 'index.html'), 'utf8');

const BASE = 'https://relay.example.com/v1';

function fullInput() {
  return {
    baseUrl: BASE,
    model: 'gpt-4o',
    claimedContext: '32000',
    expect: ['vision', 'tool'],
    priceInput: '2.5',
    priceOutput: '10',
    priceCachedRead: '0.5',
    priceThreshold: '1000000',
    priceInput2: '6',
    priceOutput2: '22.5',
    priceCachedRead2: '0.75',
    expectModelRatio: '1.5',
    expectCompletionRatio: '4',
    quotaPerUsd: '500000',
    declaredPricePage: '/pricing',
    readBalance: true,
    seed: '12345',
    timeout: '60',
    out: 'reports-out',
    baseline: 'reports/baseline-x.json',
    deep: true,
    dryRun: true,
    yes: false,
  };
}

function minimalInput() {
  return {
    baseUrl: BASE,
    model: 'gpt-4o',
    claimedContext: '',
    expect: [],
    priceInput: '',
    priceOutput: '',
    priceCachedRead: '',
    priceThreshold: '',
    priceInput2: '',
    priceOutput2: '',
    priceCachedRead2: '',
    expectModelRatio: '',
    expectCompletionRatio: '',
    quotaPerUsd: '',
    declaredPricePage: '',
    readBalance: false,
    seed: '',
    timeout: '',
    out: '',
    baseline: '',
    deep: false,
    dryRun: false,
    yes: false,
  };
}

test('classifyLogLine：阶段/请求/结果行颜色分类，且 CSS 有对应类', () => {
  assert.equal(classifyLogLine('[RUN] 阶段 identity（身份）开始'), 'log-line log-line-phase-identity log-line-phase-start');
  assert.equal(
    classifyLogLine('[RUN] 阶段 context（上下文）完成 · PASS · 得分 100/100 · 12.3s'),
    'log-line log-line-phase-context log-line-phase-done',
  );
  assert.equal(
    classifyLogLine('[RUN] ttft 请求 #3 开始（第 1 次尝试 · 约 10 输入 tokens；超时上限 60s）'),
    'log-line log-line-request log-line-phase-ttft',
  );
  assert.equal(classifyLogLine('[WARN] identity — 身份探针存在 2 项未达实锤标准的信号'), 'log-line log-line-warn');
  assert.equal(classifyLogLine('[FAIL] identity — 身份矛盾：明显换壳实锤'), 'log-line log-line-fail');
  assert.equal(classifyLogLine('[UNKNOWN] identity — 身份探针无有效回答'), 'log-line log-line-unknown');
  assert.equal(classifyLogLine('[PASS] context — 上下文探针通过'), 'log-line log-line-pass');
  // 「未见异常」是正常结论，不能让关键词兜底把 PASS 行染红。
  assert.equal(classifyLogLine('[PASS] identity 100 身份探针未见异常'), 'log-line log-line-pass');
  assert.equal(
    classifyLogLine('[PASS] billing 85 usage 计数核验通过，已按站点公开价表折算应缴金额'),
    'log-line log-line-pass',
  );
  assert.equal(classifyLogLine('[N/A] context - 未提供 --claimed-context，跳过上下文实测'), 'log-line log-line-unknown');
  assert.equal(classifyLogLine('[INFO] starved sample'), 'log-line log-line-info');
  assert.equal(classifyLogLine('[FAIL] quality — 质量异常'), 'log-line log-line-fail');
  assert.equal(classifyLogLine('plain text'), 'log-line');
  assert.equal(classifyLogLine('无标签但检测到异常'), 'log-line log-line-fail');
  for (const phase of ['identity', 'context', 'billing', 'capability', 'params', 'decoy', 'quality', 'ttft']) {
    assert.match(dashboardHtml, new RegExp(`\\.log-line-phase-${phase}\\s*\\{[^}]*color`), `missing CSS color for ${phase}`);
  }
  assert.match(dashboardHtml, /\.log-line-phase-start\s*\{[^}]*border-top/);
  assert.match(dashboardHtml, /\.log-line-phase-done\s*\{[^}]*font-weight:\s*700/);
  assert.match(dashboardHtml, /\.log-line-unknown\s*\{[^}]*color/);
});

// —— 漂移锚：buildCommand 允许输出的 flag 全集。
// 清单源自 src/cli.ts 的 parseArgs options；CLI 增加 flag 时此处必须同步。
const ALLOWED_FLAGS = [
  '--base-url',
  '--model',
  '--claimed-context',
  '--expect',
  '--price-input',
  '--price-output',
  '--price-cached-read',
  '--price-threshold',
  '--price-input2',
  '--price-output2',
  '--price-cached-read2',
  '--expect-model-ratio',
  '--expect-completion-ratio',
  '--quota-per-usd',
  '--declared-price-page',
  '--read-balance',
  '--seed',
  '--timeout',
  '--out',
  '--baseline',
  '--deep',
  '--dry-run',
  '--yes',
] as const;

function flagsOf(command: string): string[] {
  return command.split(' ').filter((token) => token.startsWith('--'));
}

function sampleOutcome(id: string, extra: Record<string, unknown> = {}) {
  return { id, status: 'ok', score: 95, level: 'pass', headline: `${id} ok`, findings: [], metrics: {}, ...extra };
}

function sampleReport(overrides: Record<string, unknown> = {}) {
  return {
    meta: { tool: 'model-xray', version: '0.1.0', model: 'gpt-4o', seed: 1 },
    total: 87,
    overall: 'pass',
    scores: [],
    outcomes: [
      sampleOutcome('identity'),
      sampleOutcome('context'),
      sampleOutcome('billing'),
      sampleOutcome('capability'),
      sampleOutcome('quality'),
      sampleOutcome('ttft'),
      sampleOutcome('extra'),
    ],
    evidence: [],
    notes: ['note 一', 'note 二'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildCommand
// ---------------------------------------------------------------------------

test('buildCommand：全参数——含全部 flag，字符串参数单引号包裹，数值 flag 不加引号', () => {
  const result = buildCommand(fullInput());
  assert.equal(result.error, null);
  assert.equal(result.hints.length, 3);
  const command = result.command;
  for (const flag of ALLOWED_FLAGS) {
    if (flag === '--yes') continue; // 全参数样例里 yes=false，不应出现
    assert.ok(command.includes(flag), `缺少 ${flag}：${command}`);
  }
  assert.ok(command.includes(`--base-url '${BASE}'`), command);
  assert.ok(command.includes("--model 'gpt-4o'"), command);
  assert.ok(command.includes("--out 'reports-out'"), command);
  assert.ok(command.includes("--baseline 'reports/baseline-x.json'"), command);
  assert.ok(command.includes("--expect 'vision,tool'"), command);
  // 数值 flag 不带引号
  assert.ok(command.includes('--claimed-context 32000'), command);
  assert.ok(command.includes('--price-input 2.5'), command);
  assert.ok(command.includes('--price-output 10'), command);
  assert.ok(command.includes('--price-cached-read 0.5'), command);
  assert.ok(command.includes('--price-threshold 1000000'), command);
  assert.ok(command.includes('--price-input2 6'), command);
  assert.ok(command.includes('--price-output2 22.5'), command);
  assert.ok(command.includes('--price-cached-read2 0.75'), command);
  assert.ok(command.includes('--seed 12345'), command);
  // 公示价锚点：数值 flag 不加引号，网页兜底页按字符串参数引用
  assert.ok(command.includes('--expect-model-ratio 1.5'), command);
  assert.ok(command.includes('--expect-completion-ratio 4'), command);
  assert.ok(command.includes('--quota-per-usd 500000'), command);
  assert.ok(command.includes("--declared-price-page '/pricing'"), command);
  assert.ok(command.includes('--read-balance'), command);
  assert.ok(command.includes('--timeout 60'), command);
  assert.ok(command.includes('--deep'), command);
  assert.ok(command.includes('--dry-run'), command);
  assert.ok(!command.includes('--yes'), command);
});

test('buildCommand：最小参数——可选 flag 全省略，expect 全不选输出 none', () => {
  const result = buildCommand(minimalInput());
  assert.equal(result.error, null);
  assert.equal(result.command, `model-xray test --base-url '${BASE}' --model 'gpt-4o' --expect 'none'`);
});

test('buildCommand：缺 --base-url → error 且不给命令串', () => {
  const result = buildCommand({ ...minimalInput(), baseUrl: '' });
  assert.ok(result.error !== null && result.error.includes('--base-url'));
  assert.equal(result.command, '');
  assert.deepEqual(result.hints, []);
});

test('buildCommand：缺 --model → error', () => {
  const result = buildCommand({ ...minimalInput(), model: '  ' });
  assert.ok(result.error !== null && result.error.includes('--model'));
  assert.equal(result.command, '');
});

test('buildCommand：余额对账未填价格 → error（实扣倍率分母依赖录入价）；填了价格 → 透传 --read-balance', () => {
  const noPrice = buildCommand({ ...minimalInput(), readBalance: true });
  assert.ok(noPrice.error !== null && noPrice.error.includes('余额对账'), noPrice.error ?? '');
  assert.equal(noPrice.command, '');
  const withPrice = buildCommand({ ...minimalInput(), priceInput: '2.5', priceOutput: '10', readBalance: true });
  assert.equal(withPrice.error, null);
  assert.ok(withPrice.command.includes('--read-balance'), withPrice.command);
});

test('buildCommand：价格只填一个 → 成对提示 error（双向）', () => {
  const onlyInput = buildCommand({ ...minimalInput(), priceInput: '2.5', priceOutput: '' });
  assert.ok(onlyInput.error !== null && onlyInput.error.includes('必须成对填写'));
  const onlyOutput = buildCommand({ ...minimalInput(), priceInput: '', priceOutput: '10' });
  assert.ok(onlyOutput.error !== null && onlyOutput.error.includes('必须成对填写'));
});

test('buildCommand：价格 0 是非法值，且不被空串判断误伤', () => {
  // price-input='0' 与 price-output='10' 都「已填」，应走数值校验而不是成对提示
  const result = buildCommand({ ...minimalInput(), priceInput: '0', priceOutput: '10' });
  assert.ok(result.error !== null, '0 必须被拒');
  assert.ok(result.error.includes('price-input'), result.error);
  assert.ok(!result.error.includes('成对'), '这不是成对问题，是数值非法');
  // 只填 '0'（另一侧空）仍应报成对，证明空串判断用 !== '' 而非真值判断
  const single = buildCommand({ ...minimalInput(), priceInput: '0', priceOutput: '' });
  assert.ok(single.error !== null && single.error.includes('必须成对填写'));
});

test('buildCommand：缓存读与二档阶梯价——完整通过（缓存 0 合法），缺组/孤立二档缓存报错', () => {
  const full = buildCommand({
    ...minimalInput(),
    priceInput: '2.5',
    priceOutput: '10',
    priceCachedRead: '0',
    priceThreshold: '1000000',
    priceInput2: '6',
    priceOutput2: '22.5',
    priceCachedRead2: '0',
  });
  assert.equal(full.error, null, String(full.error));
  assert.ok(full.command.includes('--price-cached-read 0'), full.command);
  assert.ok(full.command.includes('--price-threshold 1000000'), full.command);
  assert.ok(full.command.includes('--price-input2 6'), full.command);
  assert.ok(full.command.includes('--price-output2 22.5'), full.command);
  assert.ok(full.command.includes('--price-cached-read2 0'), full.command);

  const halfTier = buildCommand({ ...minimalInput(), priceInput: '2.5', priceOutput: '10', priceThreshold: '1000000', priceInput2: '6' });
  assert.ok(halfTier.error !== null && halfTier.error.includes('成组'), String(halfTier.error));

  const orphanCache2 = buildCommand({ ...minimalInput(), priceInput: '2.5', priceOutput: '10', priceCachedRead2: '0.75' });
  assert.ok(orphanCache2.error !== null && orphanCache2.error.includes('price-cached-read2'), String(orphanCache2.error));

  const orphanOptional = buildCommand({ ...minimalInput(), priceCachedRead: '0.5' });
  assert.ok(orphanOptional.error !== null && orphanOptional.error.includes('成对'), String(orphanOptional.error));

  const badCache = buildCommand({ ...minimalInput(), priceInput: '2.5', priceOutput: '10', priceCachedRead: '-1' });
  assert.ok(badCache.error !== null && badCache.error.includes('price-cached-read'), String(badCache.error));
});

test('buildCommand：--dry-run 与 --yes 同勾 → 互斥 error', () => {
  const result = buildCommand({ ...fullInput(), dryRun: true, yes: true });
  assert.ok(result.error !== null && result.error.includes('--dry-run 与 --yes 互斥'));
  assert.equal(result.command, '');
});

test('buildCommand：字符串参数含单引号/控制字符 → error（宁可拒绝，不产出会被 shell 损坏的命令）', () => {
  for (const input of [
    { ...minimalInput(), model: "o'brien" },
    { ...minimalInput(), model: 'gpt-4o\ncalc' },
    { ...minimalInput(), baseUrl: "https://x.example.com/a'b" },
    { ...minimalInput(), out: "re'port.json" },
    { ...minimalInput(), baseline: "base'line.json" },
  ]) {
    const result = buildCommand(input);
    assert.ok(result.error !== null, JSON.stringify(input));
    assert.ok(result.error!.includes('无法可靠地在终端中引用'), result.error ?? '');
    assert.equal(result.command, '');
    assert.deepEqual(result.hints, []);
  }
});

test('buildCommand：hints 显式声明 cmd.exe 不支持，且 key 提示不落命令串', () => {
  const result = buildCommand(minimalInput());
  assert.equal(result.error, null);
  assert.ok(result.hints.some((hint) => hint.includes('cmd.exe')), result.hints.join('\n'));
  assert.ok(result.hints.every((hint) => !hint.includes('--key')));
});

test('buildCommand：key 防泄漏钉子——命令串不含 --key 也不含 sk-', () => {
  for (const input of [fullInput(), minimalInput()]) {
    const result = buildCommand(input);
    assert.equal(result.error, null);
    assert.ok(!result.command.includes('--key'), result.command);
    assert.ok(!result.command.includes('sk-'), result.command);
  }
  // hints 用环境变量，不落入命令串
  assert.ok(buildCommand(fullInput()).hints.every((hint) => !hint.includes('--key')));
});

test('buildCommand：expect 全不选 → --expect none', () => {
  const result = buildCommand({ ...minimalInput(), expect: [] });
  assert.ok(result.command.includes("--expect 'none'"), result.command);
});

test('buildCommand：seed / timeout 非正整数 → error', () => {
  assert.ok(buildCommand({ ...minimalInput(), seed: '12abc' }).error !== null);
  assert.ok(buildCommand({ ...minimalInput(), seed: '0' }).error !== null);
  assert.ok(buildCommand({ ...minimalInput(), timeout: '-5' }).error !== null);
  assert.ok(buildCommand({ ...minimalInput(), timeout: '60' }).error === null);
});

test('buildCommand：公示价锚点校验——倍率/quota 系数必须为正数，兜底页必须形似路径或 URL', () => {
  for (const bad of ['0', '-1.5', '1.5x', 'abc', ' ']) {
    const trimmed = bad.trim();
    if (trimmed === '') {
      // 纯空白按「未填」处理：省略该 flag，不报错
      const blank = buildCommand({ ...minimalInput(), expectModelRatio: bad });
      assert.equal(blank.error, null);
      assert.ok(!blank.command.includes('--expect-model-ratio'), blank.command);
      continue;
    }
    assert.ok(
      buildCommand({ ...minimalInput(), expectModelRatio: bad }).error !== null,
      `expect-model-ratio=${bad} 应报错`,
    );
  }
  assert.ok(buildCommand({ ...minimalInput(), expectCompletionRatio: '0' }).error !== null);
  assert.ok(buildCommand({ ...minimalInput(), quotaPerUsd: '-1' }).error !== null);
  // 0 对倍率类是非法值（公示倍率不可能为 0），但必须给出点名 flag 的提示
  const zero = buildCommand({ ...minimalInput(), quotaPerUsd: '0' });
  assert.ok(zero.error !== null && zero.error.includes('--quota-per-usd'), String(zero.error));
  for (const badPage of ['pricing', 'ftp://x/pricing', '/pricing extra', 'https://']) {
    assert.ok(
      buildCommand({ ...minimalInput(), declaredPricePage: badPage }).error !== null,
      `declared-price-page=${badPage} 应报错`,
    );
  }
  for (const okPage of ['/pricing', '/pricing?group=default', 'https://relay.example.com/pricing']) {
    const ok = buildCommand({ ...minimalInput(), declaredPricePage: okPage });
    assert.equal(ok.error, null, `${okPage} 应通过：${String(ok.error)}`);
    assert.ok(ok.command.includes('--declared-price-page'), ok.command);
  }
  // 跨域绝对 URL 提前拒绝（pricing-scrape 会 fail-closed 成 not_applicable，用户看不到原因）
  const crossOrigin = buildCommand({ ...minimalInput(), declaredPricePage: 'https://other.example.net/pricing' });
  assert.equal(crossOrigin.command, '');
  assert.ok(crossOrigin.error !== null && crossOrigin.error.includes('同源'), String(crossOrigin.error));
  assert.ok(crossOrigin.error !== null && crossOrigin.error.includes('other.example.net'), String(crossOrigin.error));
  // baseUrl 非法时不抢答（留给 CLI 报 base-url 错误）
  const badBase = buildCommand({ ...minimalInput(), baseUrl: 'not-a-url', declaredPricePage: 'https://x.example.com/pricing' });
  assert.ok(!String(badBase.error).includes('同源'), String(badBase.error));
  // 最小参数样例不因新增字段变形（旧命令串有精确断言）
  assert.equal(
    buildCommand(minimalInput()).command,
    `model-xray test --base-url '${BASE}' --model 'gpt-4o' --expect 'none'`,
  );
});

test('buildCommand：cmd.exe 模式下兜底页按双引号包裹（与其它字符串参数同口径）', () => {
  const result = buildCommand({ ...minimalInput(), shell: 'cmd', declaredPricePage: '/pricing' });
  assert.equal(result.error, null);
  assert.ok(result.command.includes('--declared-price-page "/pricing"'), result.command);
});

test('buildCommand：cmd.exe 模式下拒绝 !（延迟展开 /v:on 时双引号不设防）', () => {
  for (const bad of ['/pricing!x', '/pri!cing']) {
    const result = buildCommand({ ...minimalInput(), shell: 'cmd', declaredPricePage: bad });
    assert.ok(result.error !== null, `cmd 模式 declaredPricePage=${JSON.stringify(bad)} 应报错`);
    assert.match(String(result.error), /!/);
  }
  // posix 模式下 ! 是普通字面量，不必误伤
  assert.equal(buildCommand({ ...minimalInput(), shell: 'posix', declaredPricePage: '/pricing' }).error, null);
});

test('buildCommand：quota-per-usd 按 1~1e12 有效域校验（与 CLI/站点公示口径同一域）', () => {
  for (const bad of ['0', '0.5', '-1', '1e13', 'abc', '1e400']) {
    const result = buildCommand({ ...minimalInput(), quotaPerUsd: bad });
    assert.ok(result.error !== null, `quotaPerUsd=${bad} 应报错`);
    assert.match(String(result.error), /quota-per-usd/);
  }
  for (const ok of ['1', '500000', '1000000000']) {
    const result = buildCommand({ ...minimalInput(), quotaPerUsd: ok });
    assert.equal(result.error, null, `${ok} 应通过：${String(result.error)}`);
    assert.ok(result.command.includes('--quota-per-usd 500000') || result.command.includes(`--quota-per-usd ${ok}`));
  }
});

test('buildCommand：兜底页与其它字符串参数同口径做引用健全性检查（cmd.exe 闭合引号即可注入命令）', () => {
  for (const bad of ['/pricing"&calc&"', '/pricing%PATH%', '/pricing"']) {
    const result = buildCommand({ ...minimalInput(), shell: 'cmd', declaredPricePage: bad });
    assert.ok(result.error !== null, `cmd 模式 declaredPricePage=${JSON.stringify(bad)} 应报错`);
    assert.equal(result.command, '', '出错时不得产出命令串');
  }
  // posix 模式同样拒绝单引号（各 shell 转义规则不一致，宁可拒绝）
  const posix = buildCommand({ ...minimalInput(), shell: 'posix', declaredPricePage: "/pricing'x" });
  assert.ok(posix.error !== null, "posix 模式含单引号的兜底页应报错");
});

test('buildCommand：claimed-context 非整数 → error；合法则原样输出', () => {
  assert.ok(buildCommand({ ...minimalInput(), claimedContext: '32abc' }).error !== null);
  assert.ok(buildCommand({ ...minimalInput(), claimedContext: '0' }).error !== null);
  const ok = buildCommand({ ...minimalInput(), claimedContext: '32000' });
  assert.equal(ok.error, null);
  assert.ok(ok.command.includes('--claimed-context 32000'));
});

test('buildCommand：cmd.exe 模式——字符串参数双引号包裹，拒双引号与 %（%VAR% 会展开）', () => {
  const ok = buildCommand({ ...minimalInput(), shell: 'cmd' });
  assert.equal(ok.error, null);
  assert.ok(ok.command.includes(`--base-url "${BASE}"`), ok.command);
  assert.ok(ok.command.includes('--model "gpt-4o"'), ok.command);
  assert.ok(ok.command.includes('--expect "none"'), ok.command);
  assert.ok(ok.hints.some((hint) => hint.includes('set MODEL_XRAY_KEY')), ok.hints.join('\n'));
  for (const bad of ['a"b', 'a%b%']) {
    for (const field of ['model', 'baseUrl', 'out', 'baseline'] as const) {
      const input = { ...minimalInput(), shell: 'cmd' as const, [field]: bad };
      const result = buildCommand(input);
      assert.ok(result.error !== null, `${field}=${JSON.stringify(bad)} 应被拒绝`);
      assert.ok(result.error!.includes('双引号、%'), String(result.error));
      assert.equal(result.command, '');
    }
  }
});

test('buildCommand：cmd.exe 模式下单引号合法（与 posix 拒绝策略相反），posix 模式不含双引号包裹', () => {
  const cmd = buildCommand({ ...minimalInput(), model: "o'brien", shell: 'cmd' });
  assert.equal(cmd.error, null);
  assert.ok(cmd.command.includes(`--model "o'brien"`), cmd.command);
  const posix = buildCommand(minimalInput());
  assert.ok(posix.command.includes(`--base-url '${BASE}'`), posix.command);
  assert.ok(!posix.command.includes(`"${BASE}"`), posix.command);
});

test('漂移锚：buildCommand 输出的 flag 全集 ⊆ ALLOWED_FLAGS（清单源自 src/cli.ts parseArgs，CLI 加 flag 时同步）', () => {
  const commands = [
    buildCommand(fullInput()).command,
    buildCommand(minimalInput()).command,
    buildCommand({ ...fullInput(), shell: 'cmd' }).command,
    buildCommand({ ...fullInput(), expect: ['vision', 'tool', 'thinking'] }).command,
    buildCommand({ ...fullInput(), dryRun: false, yes: true }).command,
    buildCommand({ ...minimalInput(), deep: true, out: 'x', baseline: 'y' }).command,
  ];
  const seen = new Set<string>();
  for (const command of commands) {
    for (const flag of flagsOf(command)) seen.add(flag);
  }
  assert.ok(seen.size > 0);
  for (const flag of seen) {
    assert.ok((ALLOWED_FLAGS as readonly string[]).includes(flag), `未登记的 flag：${flag}`);
  }
});

// ---------------------------------------------------------------------------
// renderScorecard
// ---------------------------------------------------------------------------

test('renderScorecard：合法报告渲染可信度总分 / overall / 探针 / findings / notes', () => {
  const report = sampleReport({
    outcomes: [
      sampleOutcome('identity', { findings: [{ level: 'warn', message: 'warn 线索', evidenceIds: [] }] }),
      sampleOutcome('context'),
      sampleOutcome('billing'),
      sampleOutcome('capability'),
      sampleOutcome('params'),
      sampleOutcome('quality'),
      sampleOutcome('ttft'),
      sampleOutcome('extra'),
    ],
  });
  const result = renderScorecard(JSON.stringify(report));
  assert.equal(result.error, null);
  assert.ok(result.html.includes('可信度总分：87'), result.html);
  // pass/warn 轮不再渲染「通过/可疑」结论徽标，只展示分数；fail 才有「不通过」徽标
  assert.ok(!result.html.includes('>通过</span>'), result.html);
  const failResult = renderScorecard(JSON.stringify({ ...sampleReport({}), overall: 'fail' }));
  assert.equal(failResult.error, null);
  assert.ok(failResult.html.includes('>不通过</span>'), failResult.html);
  for (const id of ['identity', 'context', 'billing', 'capability', 'params', 'quality', 'ttft', 'extra']) {
    assert.ok(result.html.includes(id), `缺少探针 ${id}`);
  }
  assert.ok(result.html.includes('warn 线索'));
  assert.ok(result.html.includes('note 一'));
});

test('renderScorecard：scores 优先展示（实锤封顶分与报告一致），未覆盖观测项按原样追加', () => {
  // 实锤封顶语义：报告 JSON 里 scores[].billing=45（封顶后）而 outcomes[].billing=70（探针原始分），
  // 评分卡表必须显示 45；否则与 CLI/Markdown/HTML 详情区矛盾。
  const report = sampleReport({
    total: 45,
    overall: 'fail',
    scores: [{ id: 'billing', weight: 25, score: 45, level: 'fail', headline: '换芯实锤', status: 'ok' }],
    outcomes: [
      sampleOutcome('billing', { score: 70, level: 'fail', headline: '换芯实锤' }),
      sampleOutcome('identity'),
      sampleOutcome('decoy', { score: null, level: 'unknown' }),
    ],
  });
  const result = renderScorecard(JSON.stringify(report));
  assert.equal(result.error, null);
  assert.ok(result.html.includes('<td class="score">45</td>'), result.html);
  assert.ok(!result.html.includes('<td class="score">70</td>'), `评分卡不得显示探针原始分 70：${result.html}`);
  // billing 已被 scores 覆盖不重复；identity 不在 scores → 按原样追加（95）；decoy score null → —
  assert.ok(result.html.includes('<td class="score">95</td>'), result.html);
  assert.ok(result.html.includes('<td class="score">—</td>'), result.html);
});

test('renderScorecard：老报告 scores 为空/缺失 → 回退 outcomes 原始分（兼容不炸）', () => {
  for (const report of [sampleReport({}), sampleReport({ scores: undefined })]) {
    const result = renderScorecard(JSON.stringify(report));
    assert.equal(result.error, null);
    assert.ok(result.html.includes('<td class="score">95</td>'), result.html);
  }
});

test('renderScorecard：计费探针的公示倍率/实扣倍率/金额核验指标必须可见（中文标签 + 原值）', () => {
  const report = sampleReport({
    outcomes: [
      sampleOutcome('identity'),
      sampleOutcome('billing', {
        metrics: {
          pricing_state: 'declared',
          declared_group: 'vip',
          declared_group_ratio: 0.28,
          declared_model_ratio: 2,
          declared_completion_ratio: 8,
          measured_ratio: 0.56,
          ratio_verified: true,
          money_check_state: 'verified',
          quota_to_usd: 500000,
          spend_delta: 0.5,
          balance_unit: 'total_usage_raw',
          balance_calibrated_unit: 'USD',
          expected_cost_usd_declared: 0.42,
          expected_quota_declared: 210000,
          cost_is_upper_bound: 1,
          calibration_confidence: 'high',
          declared_models_json: '{"x":1}',
          declared_group_ratio_json: '{"y":2}',
          scraped_price_matched_json: '{"z":3}',
          unknown_metric: null,
        },
      }),
    ],
  });
  const result = renderScorecard(JSON.stringify(report));
  assert.equal(result.error, null);
  // 公示价与倍率
  assert.ok(result.html.includes('计费与倍率'), result.html);
  assert.ok(result.html.includes('公示输入倍率'), result.html);
  assert.ok(result.html.includes('公示输出倍率'), result.html);
  assert.ok(result.html.includes('实扣倍率'), result.html);
  assert.ok(result.html.includes('分组折扣倍率'), result.html);
  // 金额核验
  assert.ok(result.html.includes('金额核验状态'), result.html);
  assert.ok(result.html.includes('verified'), result.html);
  assert.ok(result.html.includes('balance_unit') || result.html.includes('余额读数单位'), result.html);
  assert.ok(result.html.includes('total_usage_raw'), result.html);
  assert.ok(result.html.includes('500000'), result.html);
  // 公示价应缴额与校准置信度也在摘要块（倍率结论的可复核依据）
  assert.ok(result.html.includes('按价目应扣（USD，估算）'), result.html);
  assert.ok(result.html.includes('按价目应扣（quota，估算）'), result.html);
  assert.ok(result.html.includes('210000'), result.html);
  assert.ok(result.html.includes('单位校准置信度'), result.html);
  // 布尔值读作是/否（不是裸 true）
  assert.ok(result.html.includes('>是<'), result.html);
  assert.ok(!result.html.includes('>true<'), result.html);
  // 大型 *_json 指标只进折叠明细也不能漏转义风险：key 不应出现在摘要块
  const gridRegion = result.html.slice(result.html.indexOf('metrics-grid'), result.html.indexOf('</div>', result.html.indexOf('metrics-grid')));
  assert.ok(!gridRegion.includes('_json'), `摘要块不得渲染大型 JSON 指标：${gridRegion}`);
  // 每个有指标的探针都有可折叠明细
  assert.ok(result.html.includes('指标明细'), result.html);
  assert.ok(result.html.includes('declared_model_ratio'), result.html);
});

test('renderScorecard：指标值里的 HTML 被转义（指标通道不得成为 XSS 入口）', () => {
  const report = sampleReport({
    outcomes: [sampleOutcome('billing', { metrics: { declared_group: '<img src=x onerror=alert(1)>' } })],
  });
  const result = renderScorecard(JSON.stringify(report));
  assert.equal(result.error, null);
  assert.ok(!result.html.includes('<img'), result.html);
  assert.ok(!result.html.includes('onerror='), result.html);
  assert.ok(result.html.includes('&lt;img'), result.html);
});

test('renderScorecard：无 metrics / 无 billing 探针时不渲染倍率块与明细（老报告不炸）', () => {
  const report = sampleReport({ outcomes: [sampleOutcome('identity'), sampleOutcome('quality')] });
  const result = renderScorecard(JSON.stringify(report));
  assert.equal(result.error, null);
  assert.ok(!result.html.includes('计费与倍率'), result.html);
  assert.ok(!result.html.includes('指标明细'), result.html);
  // metrics 字段类型异常（老报告/手改）也只降级不失败
  const broken = sampleReport({ outcomes: [{ id: 'billing', level: 'pass', score: 1, headline: 'x', findings: [], metrics: 'oops' }] });
  const brokenResult = renderScorecard(JSON.stringify(broken));
  assert.equal(brokenResult.error, null);
  assert.ok(!brokenResult.html.includes('计费与倍率'), brokenResult.html);
});

test('renderScorecard：XSS 钉子——headline 注入脚本/事件处理器被转义', () => {
  const report = sampleReport({
    outcomes: [
      { id: 'identity', score: 95, level: 'pass', headline: '<script>alert(1)</script>', findings: [] },
      { id: 'context', score: 95, level: 'pass', headline: '<img src=x onerror=alert(1)>', findings: [] },
    ],
    notes: ['<b>bold</b>'],
  });
  const result = renderScorecard(JSON.stringify(report));
  assert.equal(result.error, null);
  assert.ok(!result.html.includes('<script'), '不得出现未转义 <script');
  assert.ok(!result.html.includes('onerror='), '不得出现未转义 onerror=');
  assert.ok(!result.html.includes('<img'), '不得出现未转义 <img');
  assert.ok(result.html.includes('&lt;script&gt;'), '恶意载荷应以转义文本形式保留');
  assert.ok(result.html.includes('&lt;b&gt;'));
});

test('renderScorecard：坏 JSON → error 含「不是合法的 JSON」', () => {
  const result = renderScorecard('{ oops');
  assert.ok(result.error !== null && result.error.includes('不是合法的 JSON'), String(result.error));
  assert.equal(result.html, '');
});

test('renderScorecard：非对象（数组/字符串）→ error', () => {
  assert.ok(renderScorecard('[1,2,3]').error !== null);
  assert.ok(renderScorecard('"hello"').error !== null);
});

test('renderScorecard：version=2 → error', () => {
  const result = renderScorecard(JSON.stringify(sampleReport({ version: 2 })));
  assert.ok(result.error !== null && result.error.includes('version'), String(result.error));
});

test('renderScorecard：真实 CLI 报告无顶层 version（版本在 meta.version）→ 正常渲染', () => {
  // AuditReport 顶层没有 version 字段，缺省必须放行，否则真实 report-*.json 无法渲染
  const result = renderScorecard(JSON.stringify(sampleReport()));
  assert.equal(result.error, null);
});

test('renderScorecard：outcomes 缺失 → error', () => {
  const { outcomes, ...withoutOutcomes } = sampleReport();
  void outcomes;
  const result = renderScorecard(JSON.stringify(withoutOutcomes));
  assert.ok(result.error !== null && result.error.includes('outcomes'), String(result.error));
});

test('renderScorecard：outcomes 为空数组 → 占位提示且 error 为 null', () => {
  const result = renderScorecard(JSON.stringify(sampleReport({ outcomes: [] })));
  assert.equal(result.error, null);
  assert.ok(result.html.includes('为空'), result.html);
});

test('renderScorecard：单探针缺 score/level/headline → 逐字段占位不整体失败', () => {
  const result = renderScorecard(JSON.stringify(sampleReport({ outcomes: [{ id: 'identity', status: 'insufficient' }] })));
  assert.equal(result.error, null);
  assert.ok(result.html.includes('—'), result.html);
  assert.ok(result.html.includes('缺失'), result.html);
  assert.ok(result.html.includes('identity'));
});

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

test('escapeHtml：全量转义 & < > " \'（并额外中和 = 以杜绝 onerror= 字面量）', () => {
  assert.equal(
    escapeHtml(`<a href="x" data-y='z'> & </a>`),
    '&lt;a href&#61;&quot;x&quot; data-y&#61;&#39;z&#39;&gt; &amp; &lt;/a&gt;',
  );
});

test('桌面工作区：导航项与检测/聚合/报告视图一一对应（guard 控制台托管已移除）', () => {
  for (const section of ['test', 'gateway', 'reports']) {
    assert.match(dashboardHtml, new RegExp(`id="tab-${section}"`));
    assert.match(dashboardHtml, new RegExp(`id="panel-${section}"`));
  }
  assert.ok(!dashboardHtml.includes('tab-guard'), '不得再有「实时监控」独立标签（监控并入 API 聚合页）');
  assert.ok(!dashboardHtml.includes('panel-guard'), '不得再有 guard 面板（透明代理仅保留 CLI）');
  assert.ok(!dashboardHtml.includes('/api/guard/'), '页面不得再调用已移除的 guard 托管端点');
  // API 聚合暂未上线（后需迭代上线）：标签隐藏、侧栏标注提示，面板结构保留待复用
  assert.match(dashboardHtml, /<button id="tab-gateway"[^>]*hidden/, 'API 聚合标签须隐藏（后需迭代上线）');
  assert.match(dashboardHtml, /API 聚合实时监控 · 后需迭代上线/, '侧栏须标注「后需迭代上线」提示');
  assert.match(dashboardHtml, /id="f-channel-key"[^>]*type="password"/);
  assert.match(dashboardHtml, /id="f-gateway-client-key"[^>]*type="password"/);
  assert.match(dashboardHtml, /@media \(max-width: 690px\)/);
  assert.match(dashboardHtml, /prefers-reduced-motion: reduce/);
});

test('桌面工作区：凭证条只存在于「模型检测」面板内（全局凭证条已移除）', () => {
  const testPanelAt = dashboardHtml.indexOf('id="panel-test"');
  const gatewayPanelAt = dashboardHtml.indexOf('id="panel-gateway"');
  const keybarAt = dashboardHtml.indexOf('class="keybar"');
  assert.ok(testPanelAt !== -1 && gatewayPanelAt !== -1 && keybarAt !== -1, '凭证条/面板结构缺失');
  assert.ok(keybarAt > testPanelAt && keybarAt < gatewayPanelAt, '凭证条必须位于 panel-test 内（仅检测页录入 key）');
  for (const id of ['f-key', 'btn-key-save', 'btn-key-clear', 'key-dot', 'key-state']) {
    const at = dashboardHtml.indexOf(`id="${id}"`);
    assert.ok(at > testPanelAt && at < gatewayPanelAt, `${id} 必须在 panel-test 内`);
  }
});

test('桌面工作区：API 聚合页按「渠道 → 启动 → 监控 → 接入」排布，含协议三态与价格配置（一键导入已移除）', () => {
  const gatewayAt = dashboardHtml.indexOf('id="panel-gateway"');
  const reportsAt = dashboardHtml.indexOf('id="panel-reports"');
  assert.ok(gatewayAt !== -1 && reportsAt !== -1, '聚合/报告面板结构缺失');
  const gatewayHtml = dashboardHtml.slice(gatewayAt, reportsAt);
  for (const fragment of [
    '实时监控', 'id="channel-form"', 'id="channel-model-rows"', 'id="btn-channel-probe"', 'id="btn-model-add"',
    'id="f-channel-protocol"', 'value="unified"', 'value="openai"', 'value="anthropic"',
    'id="channel-price-details"', 'id="channel-price-rows"',
    'id="btn-gateway-start"',
    'id="gateway-copy-url"', 'id="gateway-copy-root"', 'id="btn-gateway-copy-url"', 'id="btn-gateway-copy-root"',
    'id="btn-gateway-copy-key"', 'ANTHROPIC_BASE_URL',
  ]) {
    assert.ok(gatewayHtml.includes(fragment), `聚合页缺少 ${fragment}`);
  }
  // 一键导入已移除：入口、表单、结果面板都不允许出现
  for (const fragment of ['btn-channel-import', 'channel-import-form', 'f-import-text', 'import-result']) {
    assert.ok(!gatewayHtml.includes(fragment), `聚合页不得再有导入入口（${fragment}）`);
  }
  // 用量表新增「缓存」「费用」列（费用按渠道内配置的模型价格累计）
  for (const header of ['<th>缓存</th>', '<th>费用</th>']) {
    assert.ok(gatewayHtml.includes(header), `用量表缺少列 ${header}`);
  }
  // 用户流程顺序：① 渠道与模型 → ② 启动本地 API → ③ 实时监控 → ④ 客户端接入
  let last = -1;
  for (const id of ['id="btn-channel-new"', 'id="btn-gateway-start"', 'id="gateway-alerts"', 'id="gateway-copy-root"']) {
    const at = gatewayHtml.indexOf(id);
    assert.ok(at > last, `聚合页顺序不对：${id} 应位于前一区块之后（渠道 → 启动 → 监控 → 接入）`);
    last = at;
  }
  // 启动/轮换/停止三个按钮必须包在同一个 action-row（此前三个按钮紧贴无间距的回归）
  assert.match(gatewayHtml, /<div class="action-row"><button id="btn-gateway-start"/, '启动按钮组须包在 action-row 内');
});

test('桌面工作区：按钮间距修复锚（.action-row flex+gap，行内按钮清零 margin-top）', () => {
  assert.match(dashboardHtml, /\.action-row\s*\{[^}]*display:\s*flex[^}]*gap:/, '.action-row 必须以 flex + gap 提供按钮间距');
  assert.match(
    dashboardHtml,
    /\.action-row button, \.channel-form-actions button, \.copy-row button\s*\{\s*margin-top:\s*0/,
    '行内按钮须清零自身 margin-top（primary 15px / secondary 10px 在同排错位 5px 的回归）',
  );
});

test('报告清理：两步点击确认（不依赖 window.confirm，webview 内嵌浏览器静默吞对话框的回归）', () => {
  const appSource = readFileSync(locateWebApp(), 'utf8');
  assert.ok(!appSource.includes('window.confirm('), '清理确认不得依赖 window.confirm（内嵌浏览器会静默吞掉原生对话框，表现为点击无反应）');
  assert.ok(appSource.includes('function armOrRunClear'), '缺少两步确认实现');
  assert.ok(appSource.includes("byId('btn-reports-clear-keep')"), '「清理（保留最新）」按钮接线缺失');
  assert.ok(appSource.includes("byId('btn-reports-clear-all')"), '「清空全部」按钮接线缺失');
  assert.ok(
    appSource.includes("armOrRunClear('keep-latest')") && appSource.includes("armOrRunClear('all')"),
    '两个清理按钮必须都走两步确认',
  );
  assert.ok(dashboardHtml.includes('button.armed'), '缺少待确认态按钮样式（.armed）');
});

// ---------------------------------------------------------------------------
// buildModelPrices / formatCostUsd / scrubSecrets（价格编辑与密钥脱敏）
// ---------------------------------------------------------------------------

test('buildModelPrices：空行跳过；合法价格成对输出（可选缓存读），全空则返回空对象', () => {
  const blank = buildModelPrices([{ alias: 'gpt-4o', input: '', output: '', cachedRead: '', threshold: '', input2: '', output2: '', cachedRead2: '' }]);
  assert.equal(blank.error, null);
  assert.deepEqual(blank.modelPrices, {});
  const priced = buildModelPrices([
    { alias: 'gpt-4o', input: '2.5', output: '10', cachedRead: '1.25', threshold: '', input2: '', output2: '', cachedRead2: '' },
    { alias: 'glm-5.3-flash', input: '0', output: '0', cachedRead: '', threshold: '', input2: '', output2: '', cachedRead2: '' },
    { alias: '', input: '', output: '', cachedRead: '', threshold: '', input2: '', output2: '', cachedRead2: '' },
  ]);
  assert.equal(priced.error, null);
  assert.deepEqual(priced.modelPrices, {
    'gpt-4o': { input: 2.5, output: 10, cachedRead: 1.25 },
    'glm-5.3-flash': { input: 0, output: 0 },
  });
});

test('buildModelPrices：阶梯价「阈值+二档输入+二档输出」完整才通过，缺一报错', () => {
  const tiered = buildModelPrices([
    { alias: 'm1', input: '2', output: '10', cachedRead: '', threshold: '1000000', input2: '4', output2: '20', cachedRead2: '2' },
  ]);
  assert.equal(tiered.error, null);
  assert.deepEqual(tiered.modelPrices.m1, { input: 2, output: 10, threshold: 1000000, input2: 4, output2: 20, cachedRead2: 2 });
  const missing = buildModelPrices([
    { alias: 'm1', input: '2', output: '10', cachedRead: '', threshold: '1000000', input2: '', output2: '', cachedRead2: '' },
  ]);
  assert.ok(missing.error !== null, '阶梯不完整必须报错');
  assert.match(missing.error, /m1/);
  assert.match(missing.error, /阶梯/);
});

test('buildModelPrices：非法值/不成对/缺别名 → 带别名与示例的明确报错（绝不静默丢价格）', () => {
  const halfPair = buildModelPrices([
    { alias: 'm1', input: '2.5', output: '', cachedRead: '', threshold: '', input2: '', output2: '', cachedRead2: '' },
  ]);
  assert.match(halfPair.error!, /m1/);
  assert.match(halfPair.error!, /成对/);
  const negative = buildModelPrices([
    { alias: 'm2', input: '-1', output: '2', cachedRead: '', threshold: '', input2: '', output2: '', cachedRead2: '' },
  ]);
  assert.match(negative.error!, /m2/);
  assert.match(negative.error!, /输入单价/);
  const badThreshold = buildModelPrices([
    { alias: 'm3', input: '1', output: '2', cachedRead: '', threshold: '999.5', input2: '1', output2: '2', cachedRead2: '' },
  ]);
  assert.match(badThreshold.error!, /阶梯阈值/);
  assert.match(badThreshold.error!, /正整数/);
  const orphanPrice = buildModelPrices([
    { alias: '', input: '9', output: '9', cachedRead: '', threshold: '', input2: '', output2: '', cachedRead2: '' },
  ]);
  assert.match(orphanPrice.error!, /别名/);
});

test('formatCostUsd：未配价 → —（不显示误导性 $0）；0 与分档小数位', () => {
  assert.equal(formatCostUsd(null), '—');
  assert.equal(formatCostUsd(undefined), '—');
  assert.equal(formatCostUsd('abc'), '—');
  assert.equal(formatCostUsd(0), '$0');
  assert.equal(formatCostUsd(0.000025), '$0.000025');
  assert.equal(formatCostUsd(0.0234), '$0.0234');
  assert.equal(formatCostUsd(1.239), '$1.24');
});

test('scrubSecrets：抹掉命中的密钥并对 sk- 形态兜底打码', () => {
  assert.equal(scrubSecrets('上游拒绝：sk-abcdef123456789 无效', ['sk-abcdef123456789']), '上游拒绝：*** 无效');
  assert.equal(scrubSecrets('裸串 sk-zzzz9999yyyy8888x', []), '裸串 sk-***');
  assert.equal(scrubSecrets('无命中 plain text', ['other-secret-key']), '无命中 plain text');
});

test('normalizeInjectedToken：只认 48 位小写 hex，占位符/空/形态不符 → null（= 未连上本地服务）', () => {
  const token = 'a1'.repeat(24);
  assert.equal(normalizeInjectedToken(token), token);
  assert.equal(normalizeInjectedToken('__MX_TOKEN__'), null, '未替换的占位符不得当凭据');
  assert.equal(normalizeInjectedToken(''), null);
  assert.equal(normalizeInjectedToken('A1'.repeat(24)), null, '大写不得接受（服务端只生成小写）');
  assert.equal(normalizeInjectedToken('a'.repeat(47)), null);
  assert.equal(normalizeInjectedToken(null), null);
  assert.equal(normalizeInjectedToken(123), null);
});

test('extractTokenFromHtml：从服务端渲染的首页取 token，静态副本/非字符串 → null', () => {
  const token = 'b2'.repeat(24);
  assert.equal(extractTokenFromHtml(`<script>window.MX_TOKEN = '${token}';</script>`), token);
  assert.equal(extractTokenFromHtml("<script>window.MX_TOKEN = '__MX_TOKEN__';</script>"), null);
  assert.equal(extractTokenFromHtml('<html>无 token</html>'), null);
  assert.equal(extractTokenFromHtml(null), null);
});

test('isTokenAuthError：仅 403 且 token 缺失/过期才允许重试；Host/Origin 等 403 不得重试', () => {
  assert.equal(isTokenAuthError(403, { code: 'token_stale' }), true);
  assert.equal(isTokenAuthError(403, { code: 'token_missing' }), true);
  assert.equal(isTokenAuthError(403, { error: '缺少 x-model-xray-token：请从控制台页面发起请求' }), true, '缺 code 时按文案兜底');
  assert.equal(isTokenAuthError(403, { error: 'Forbidden: Host 不被允许' }), false);
  assert.equal(isTokenAuthError(403, { error: 'Forbidden: Origin 不被允许' }), false);
  assert.equal(isTokenAuthError(400, { code: 'token_stale' }), false);
  assert.equal(isTokenAuthError(403, null), false);
  assert.equal(isTokenAuthError(500, { code: 'token_stale' }), false);
});

test('renderScorecard：倍率摘要块必须给出「公示倍率 / 实扣倍率 / 为什么没有倍率的原因 / 证据等级」', () => {
  const report = sampleReport({
    outcomes: [
      sampleOutcome('billing', {
        metrics: {
          pricing_state: 'ok',
          declared_model_ratio: 2,
          declared_completion_ratio: 5,
          measured_ratio: 'N/A',
          money_check_state: 'not_applicable',
          balance_probe_reason: '候选余额接口均不可用（origin https://relay.example.com）',
          evidence_level: 'shape-only',
        },
      }),
    ],
  });
  const result = renderScorecard(JSON.stringify(report));
  assert.equal(result.error, null);
  const html = result.html ?? '';
  for (const label of ['公示输入倍率', '公示输出倍率', '实扣倍率', '余额探测原因', '金额核验状态', '证据等级']) {
    assert.ok(html.includes(label), `倍率摘要块缺标签「${label}」`);
  }
  assert.ok(html.includes('候选余额接口均不可用'), '倍率摘要块必须带「为什么没有倍率」的原因原文');
  assert.ok(html.includes('shape-only'), '倍率摘要块必须显示证据等级');
});

test('renderScorecard：计费块每个 N/A 连标准原因，比价标「未看实扣」，应缴标「估算」', () => {
  const report = sampleReport({
    outcomes: [
      sampleOutcome('billing', {
        metrics: {
          measured_ratio: 'N/A',
          balance_probe_reason: '候选余额接口均不可用',
          claimed_price_ratio_input: 'N/A',
          claimed_price_ratio_output: 'N/A',
          quota_per_unit_synthetic: 1,
          expected_cost_usd_declared: 0.42,
          spend_delta: 0.5,
          evidence_level: 'shape-only',
        },
      }),
    ],
  });
  const result = renderScorecard(JSON.stringify(report));
  assert.equal(result.error, null);
  const html = result.html ?? '';
  assert.ok(html.includes('N/A（该站没有可用的余额接口）'), `N/A 必须连标准原因：${html}`);
  assert.ok(html.includes('N/A（站点未公示 quota_per_unit 换算率）'), `缺换算率必须连原因：${html}`);
  assert.ok(html.includes('你填的单价÷站点现价（输入；只比价目，未看实扣）'), `比价必须标未看实扣：${html}`);
  assert.ok(html.includes('按价目应扣（USD，估算）'), `应缴必须标估算：${html}`);
  assert.ok(html.includes('实扣（实测；单位校准采信后为估算）'), `实际扣费必须标口径：${html}`);
});

