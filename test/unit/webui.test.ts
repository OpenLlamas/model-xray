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
const { buildCommand, renderScorecard, escapeHtml, scrubSecrets, buildModelPrices, formatCostUsd, classifyLogLine } =
  webApp;
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
  assert.equal(classifyLogLine('[WARN] identity — 身份探针存在 2 项可疑信号'), 'log-line log-line-warn');
  assert.equal(classifyLogLine('[UNKNOWN] identity — 身份探针无有效回答'), 'log-line log-line-unknown');
  assert.equal(classifyLogLine('[PASS] context — 上下文探针通过'), 'log-line log-line-pass');
  assert.equal(classifyLogLine('[INFO] starved sample'), 'log-line log-line-info');
  assert.equal(classifyLogLine('[FAIL] quality — 质量异常'), 'log-line log-line-fail');
  assert.equal(classifyLogLine('plain text'), 'log-line');
  for (const phase of ['identity', 'context', 'billing', 'capability', 'decoy', 'quality', 'ttft']) {
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
      sampleOutcome('quality'),
      sampleOutcome('ttft'),
      sampleOutcome('extra'),
    ],
  });
  const result = renderScorecard(JSON.stringify(report));
  assert.equal(result.error, null);
  assert.ok(result.html.includes('可信度总分：87'), result.html);
  assert.ok(result.html.includes('通过'));
  for (const id of ['identity', 'context', 'billing', 'capability', 'quality', 'ttft', 'extra']) {
    assert.ok(result.html.includes(id), `缺少探针 ${id}`);
  }
  assert.ok(result.html.includes('warn 线索'));
  assert.ok(result.html.includes('note 一'));
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
