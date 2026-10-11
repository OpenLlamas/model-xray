import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
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
const { buildCommand, renderScorecard, escapeHtml } = webApp;

const BASE = 'https://relay.example.com/v1';

function fullInput() {
  return {
    baseUrl: BASE,
    model: 'gpt-4o',
    claimedContext: '32000',
    expect: ['vision', 'tool'],
    priceInput: '2.5',
    priceOutput: '10',
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
    seed: '',
    timeout: '',
    out: '',
    baseline: '',
    deep: false,
    dryRun: false,
    yes: false,
  };
}

// —— 漂移锚：buildCommand 允许输出的 flag 全集。
// 清单源自 src/cli.ts 的 parseArgs options；CLI 增加 flag 时此处必须同步。
const ALLOWED_FLAGS = [
  '--base-url',
  '--model',
  '--claimed-context',
  '--expect',
  '--price-input',
  '--price-output',
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