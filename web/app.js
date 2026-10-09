// web/app.js — model-xray 纯静态 Web 壳（P1.5）
// 约束（cli-first 决策）：
//   ① 纯函数（escapeHtml / buildCommand / renderScorecard）供 Node 测试直接 import；
//   ② DOM 接线全部收在 `typeof document !== 'undefined'` 守卫内；
//   ③ 零网络请求、零存储（无 localStorage / IndexedDB / cookie）；
//   ④ key 绝不出现在生成的命令里 —— CLI 原生读环境变量 MODEL_XRAY_KEY，
//      页面只在 hints 里给出两行 export / $env 提示。

const EXPECT_ALLOWED = ['vision', 'tool', 'thinking'];

/**
 * HTML 转义。渲染路径所有字符串插值必须过它（本地 XSS 防线）。
 * 转义 & < > " ' 五个字符；额外把 `=` 转成 &#61;，
 * 使 `onerror=` 这类事件处理器字面量无法原样出现在输出里（文本显示不受影响）。
 */
export function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('=', '&#61;');
}

/**
 * shell 引用（posix 模式）：bash 与 PowerShell 的单引号均为字面量（cmd.exe 不支持）。
 * 内部单引号按 '\'' 转义仅为防御性兜底——buildCommand 已拒绝含单引号/控制字符的参数
 * （各 shell 转义规则不一致，宁可拒绝也不产出会被静默损坏或注入元字符的命令）。
 */
function shellQuote(s) {
  return `'${String(s).replaceAll("'", `'\\''`)}'`;
}

/**
 * shell 引用（cmd 模式）：双引号包裹。cmd.exe 双引号内 & | < > ^ 均为字面量，
 * 但 %VAR% 仍会展开、双引号无法转义——这两类字符由 buildCommand 直接拒绝。
 */
function cmdQuote(s) {
  return `"${String(s)}"`;
}

/** 严格正整数（seed/timeout/claimed-context）：纯数字且 ≥ 1。 */
function isPositiveIntStr(raw) {
  return /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) && Number(raw) >= 1;
}

/** 严格正数（价格）：形如数字、Number() 有限且 > 0（0 与负数都是非法值）。 */
function isPositiveNumberStr(raw) {
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(raw)) return false;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0;
}

/**
 * 由表单输入生成可复制的 CLI 命令。
 * @returns {{ command: string, hints: string[], error: string | null }}
 *   error 非 null 时 command 为空串、hints 为空数组（不给半成品命令）。
 */
export function buildCommand(input) {
  // 目标终端：posix（默认，覆盖 PowerShell / bash / zsh，单引号）或 cmd（双引号）。
  const shell = input?.shell === 'cmd' ? 'cmd' : 'posix';
  const quote = shell === 'cmd' ? cmdQuote : shellQuote;
  const fail = (message) => ({ command: '', hints: [], error: message });
  const hints =
    shell === 'cmd'
      ? [
          'cmd.exe:   set MODEL_XRAY_KEY=你的key',
          'PowerShell/bash 用户：请切回默认模式（单引号），命令语义相同。',
          '注意：cmd.exe 模式已用双引号引用，参数中不能包含双引号或 %。',
        ]
      : [
          'bash/zsh:  export MODEL_XRAY_KEY=你的key',
          "PowerShell: $env:MODEL_XRAY_KEY='你的key'",
          '注意：参数以单引号引用，请在 PowerShell 或 bash/zsh 中执行；cmd.exe 请切换到 cmd.exe 模式。',
        ];

  const baseUrl = String(input?.baseUrl ?? '').trim();
  const model = String(input?.model ?? '').trim();
  if (baseUrl === '') {
    return fail('缺少必填参数 --base-url。示例：https://relay.example.com/v1（通常以 /v1 结尾）');
  }
  if (model === '') {
    return fail('缺少必填参数 --model。示例：gpt-4o');
  }

  const dryRun = input?.dryRun === true;
  const yes = input?.yes === true;
  if (dryRun && yes) {
    return fail('--dry-run 与 --yes 互斥：二者只能选其一。');
  }

  const claimedContextRaw = String(input?.claimedContext ?? '').trim();
  if (claimedContextRaw !== '' && !isPositiveIntStr(claimedContextRaw)) {
    return fail(`--claimed-context 必须是正整数。收到：${JSON.stringify(claimedContextRaw)}。示例：--claimed-context 32000`);
  }

  const priceInputRaw = String(input?.priceInput ?? '').trim();
  const priceOutputRaw = String(input?.priceOutput ?? '').trim();
  const hasPriceInput = priceInputRaw !== '';
  const hasPriceOutput = priceOutputRaw !== '';
  // 判空必须用 !== ''（不能用真值判断，否则 '0' 会被误判成「未填」）
  if (hasPriceInput !== hasPriceOutput) {
    return fail('--price-input 与 --price-output 必须成对填写。示例：--price-input 2.5 --price-output 10');
  }
  if (hasPriceInput) {
    if (!isPositiveNumberStr(priceInputRaw)) {
      return fail(`--price-input 必须为正数（每百万 tokens 宣称价格，0 与负数无效）。收到：${JSON.stringify(priceInputRaw)}。示例：--price-input 2.5`);
    }
    if (!isPositiveNumberStr(priceOutputRaw)) {
      return fail(`--price-output 必须为正数（每百万 tokens 宣称价格，0 与负数无效）。收到：${JSON.stringify(priceOutputRaw)}。示例：--price-output 10`);
    }
  }

  const seedRaw = String(input?.seed ?? '').trim();
  if (seedRaw !== '' && !isPositiveIntStr(seedRaw)) {
    return fail(`--seed 必须是正整数。收到：${JSON.stringify(seedRaw)}。示例：--seed 12345`);
  }
  const timeoutRaw = String(input?.timeout ?? '').trim();
  if (timeoutRaw !== '' && !isPositiveIntStr(timeoutRaw)) {
    return fail(`--timeout 必须是正整数（秒）。收到：${JSON.stringify(timeoutRaw)}。示例：--timeout 60`);
  }

  // expect：过滤到合法集合；全不选 → 显式 --expect none（不宣称任何能力）
  const expectSelected = Array.isArray(input?.expect)
    ? input.expect.filter((v) => EXPECT_ALLOWED.includes(v))
    : [];
  const expectValue = expectSelected.length > 0 ? expectSelected.join(',') : 'none';

  const outRaw = String(input?.out ?? '').trim();
  const baselineRaw = String(input?.baseline ?? '').trim();

  // 引用健全性：宁可拒绝，也不产出会被 shell 静默损坏或注入元字符的命令。
  // posix 模式：单引号内一切字面量，但参数含单引号/控制字符时各 shell 规则不一致 → 拒绝。
  // cmd 模式：双引号内 %VAR% 仍展开、双引号无法转义 → 拒绝 " 与 % 及控制字符。
  const badChars = shell === 'cmd' ? /["%\r\n\0]/ : /['\r\n\0]/;
  const badCharsLabel = shell === 'cmd' ? '双引号、% 或换行等控制字符' : '单引号或换行等控制字符';
  for (const [raw, flag, example] of [
    [baseUrl, 'base-url', 'https://relay.example.com/v1'],
    [model, 'model', 'gpt-4o'],
    [outRaw, 'out', 'report.json'],
    [baselineRaw, 'baseline', 'baseline.json'],
  ]) {
    if (badChars.test(raw)) {
      return fail(`--${flag} 含有${badCharsLabel}，无法可靠地在终端中引用。收到：${JSON.stringify(raw)}。示例：--${flag} ${example}`);
    }
  }

  // 数值 flag 不加引号（已通过上面的严格校验）；字符串参数按目标 shell 引用
  const parts = [
    'model-xray',
    'test',
    `--base-url ${quote(baseUrl)}`,
    `--model ${quote(model)}`,
  ];
  if (claimedContextRaw !== '') parts.push(`--claimed-context ${claimedContextRaw}`);
  parts.push(`--expect ${quote(expectValue)}`);
  if (hasPriceInput) {
    parts.push(`--price-input ${priceInputRaw}`);
    parts.push(`--price-output ${priceOutputRaw}`);
  }
  if (seedRaw !== '') parts.push(`--seed ${seedRaw}`);
  if (timeoutRaw !== '') parts.push(`--timeout ${timeoutRaw}`);
  if (outRaw !== '') parts.push(`--out ${quote(outRaw)}`);
  if (baselineRaw !== '') parts.push(`--baseline ${quote(baselineRaw)}`);
  if (input?.deep === true) parts.push('--deep');
  if (dryRun) parts.push('--dry-run');
  if (yes) parts.push('--yes');

  return { command: parts.join(' '), hints, error: null };
}

const OVERALL_LABEL = { pass: '通过', warn: '可疑', fail: '不通过' };

function badgeClass(level) {
  return ['pass', 'warn', 'fail', 'unknown'].includes(level) ? level : 'unknown';
}

function fieldText(record, key) {
  const value = record?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * 解析粘贴的 report-*.json 并渲染评分卡 HTML 片段。
 * 宽松校验：只挡住明确不是报告的输入；单探针缺字段逐项降级（'—' / 缺失），不整体失败。
 * @returns {{ html: string, error: string | null }}
 */
export function renderScorecard(jsonText) {
  let data;
  try {
    data = JSON.parse(String(jsonText));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      html: '',
      error: `不是合法的 JSON：${message}（请粘贴 report-*.json 的完整内容）`,
    };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { html: '', error: '不是有效的报告对象：顶层必须是 JSON 对象（请粘贴 report-*.json 的完整内容）。' };
  }
  // version 宽松处理：现行 CLI 报告的顶层没有 version 字段（版本在 meta.version，为 semver 字符串），
  // 因此「缺省」放行以兼容真实报告；但只要显式给出且 ≠1 就拒绝。
  if (data.version !== undefined && data.version !== 1) {
    return { html: '', error: `报告版本不支持：收到 version ${JSON.stringify(data.version)}，本页仅支持 version 1 的报告。` };
  }
  if (!Array.isArray(data.outcomes)) {
    return { html: '', error: '报告缺少 outcomes 数组：这不是 model-xray 的检测报告（请粘贴 report-*.json 的完整内容）。' };
  }
  if (data.outcomes.length === 0) {
    return {
      html: '<p class="placeholder">该报告的 outcomes 为空（没有探针结果）。请确认粘贴的是完整的 report-*.json。</p>',
      error: null,
    };
  }

  const rows = data.outcomes.map((raw) => {
    const record = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const id = fieldText(record, 'id') ?? '（缺失）';
    const level = fieldText(record, 'level');
    const levelLabel = level ?? '缺失';
    const score = record?.score;
    const scoreLabel = score === null || score === undefined ? '—' : String(score);
    const headline = fieldText(record, 'headline') ?? '—';
    return `        <tr><td>${escapeHtml(id)}</td><td><span class="badge badge-${badgeClass(level ?? '')}">${escapeHtml(levelLabel)}</span></td><td class="score">${escapeHtml(scoreLabel)}</td><td>${escapeHtml(headline)}</td></tr>`;
  });

  const findings = [];
  for (const raw of data.outcomes) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    if (!Array.isArray(raw.findings)) continue;
    for (const item of raw.findings) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
      const message = fieldText(item, 'message');
      if (message === null) continue;
      const level = fieldText(item, 'level') ?? 'info';
      findings.push(`        <li><span class="badge badge-${badgeClass(level)}">${escapeHtml(level)}</span> ${escapeHtml(message)}</li>`);
    }
  }

  const notes = (Array.isArray(data.notes) ? data.notes : [])
    .filter((note) => typeof note === 'string')
    .map((note) => `        <li>${escapeHtml(note)}</li>`);

  const total = typeof data.total === 'number' && Number.isFinite(data.total) ? String(data.total) : '未判定';
  const overall = typeof data.overall === 'string' ? data.overall : '';
  const overallLabel = OVERALL_LABEL[overall] ?? '未判定';

  const html = [
    '<section class="scorecard">',
    `  <div class="scorecard-head"><span class="total">总分：${escapeHtml(total)}</span><span class="badge badge-${badgeClass(overall)}">${escapeHtml(overallLabel)}</span></div>`,
    '  <table class="probes">',
    '    <thead><tr><th>探针</th><th>结论</th><th>得分</th><th>摘要</th></tr></thead>',
    '    <tbody>',
    ...rows,
    '    </tbody>',
    '  </table>',
    `  <h4>findings（${findings.length}）</h4>`,
    ...(findings.length > 0 ? ['  <ul class="findings">', ...findings, '  </ul>'] : ['  <p class="placeholder">无 findings。</p>']),
    `  <h4>notes（${notes.length}）</h4>`,
    ...(notes.length > 0 ? ['  <ul class="notes">', ...notes, '  </ul>'] : ['  <p class="placeholder">无 notes。</p>']),
    '</section>',
  ].join('\n');
  return { html, error: null };
}

// ---------------------------------------------------------------------------
// DOM 接线（仅浏览器执行；Node 测试 import 时 document 为 undefined，直接跳过）
// ---------------------------------------------------------------------------
if (typeof document !== 'undefined') {
  const byId = (id) => document.getElementById(id);
  const inputValue = (id) => byId(id)?.value ?? '';
  const checkedValue = (id) => {
    const el = byId(id);
    return el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : false;
  };

  // —— 双 tab 切换 ——
  const tabs = { cmd: byId('tab-cmd'), report: byId('tab-report') };
  const panels = { cmd: byId('panel-cmd'), report: byId('panel-report') };
  function selectTab(which) {
    for (const key of ['cmd', 'report']) {
      tabs[key]?.setAttribute('aria-selected', key === which ? 'true' : 'false');
      if (panels[key]) panels[key].hidden = key !== which;
    }
  }
  tabs.cmd?.addEventListener('click', () => selectTab('cmd'));
  tabs.report?.addEventListener('click', () => selectTab('report'));

  // —— Tab ①：生成命令 ——
  const cmdError = byId('cmd-error');
  const cmdResult = byId('cmd-result');
  const commandOut = byId('command-out');
  const hintsOut = byId('hints-out');
  const copyStatus = byId('copy-status');
  const copyFallback = byId('copy-fallback');
  const copyFallbackText = byId('copy-fallback-text');

  function collectForm() {
    const shellMode = document.querySelector('input[name="shell-mode"]:checked');
    return {
      shell: shellMode instanceof HTMLInputElement && shellMode.value === 'cmd' ? 'cmd' : 'posix',
      baseUrl: inputValue('f-base-url'),
      model: inputValue('f-model'),
      claimedContext: inputValue('f-claimed-context'),
      expect: EXPECT_ALLOWED.filter((key) => checkedValue(`f-expect-${key}`)),
      priceInput: inputValue('f-price-input'),
      priceOutput: inputValue('f-price-output'),
      seed: inputValue('f-seed'),
      timeout: inputValue('f-timeout'),
      out: inputValue('f-out'),
      baseline: inputValue('f-baseline'),
      deep: checkedValue('f-deep'),
      dryRun: checkedValue('f-dry-run'),
      yes: checkedValue('f-yes'),
    };
  }

  byId('btn-generate')?.addEventListener('click', () => {
    if (!cmdError || !cmdResult || !commandOut || !hintsOut) return;
    const result = buildCommand(collectForm());
    if (result.error !== null) {
      // 就地错误提示：红字显示且不给命令串
      cmdError.textContent = result.error;
      cmdError.hidden = false;
      cmdResult.hidden = true;
      commandOut.textContent = '';
      return;
    }
    cmdError.hidden = true;
    commandOut.textContent = result.command;
    hintsOut.textContent = ['', ...result.hints].join('\n');
    if (copyStatus) {
      copyStatus.hidden = true;
      copyStatus.textContent = '';
    }
    if (copyFallback) copyFallback.hidden = true;
    cmdResult.hidden = false;
  });

  // 复制：优先 clipboard API，失败降级为可全选 textarea（不用已弃用的 execCommand）
  byId('btn-copy')?.addEventListener('click', async () => {
    const text = commandOut?.textContent ?? '';
    if (text === '') return;
    try {
      await navigator.clipboard.writeText(text);
      if (copyStatus) {
        copyStatus.textContent = '已复制到剪贴板。';
        copyStatus.hidden = false;
      }
      if (copyFallback) copyFallback.hidden = true;
    } catch {
      if (copyFallback && copyFallbackText) {
        copyFallbackText.value = text;
        copyFallback.hidden = false;
      }
      if (copyStatus) {
        copyStatus.textContent = '自动复制失败：请点击文本框后手动复制（Ctrl+A 全选 → Ctrl+C）。';
        copyStatus.hidden = false;
      }
    }
  });

  // —— Tab ②：渲染报告 ——
  const reportJson = byId('report-json');
  const reportError = byId('report-error');
  const reportOut = byId('report-out');
  const fileStatus = byId('file-status');

  byId('btn-render')?.addEventListener('click', () => {
    if (!reportError || !reportOut || !reportJson) return;
    const result = renderScorecard(reportJson.value);
    if (result.error !== null) {
      reportError.textContent = result.error;
      reportError.hidden = false;
      reportOut.innerHTML = '';
      return;
    }
    reportError.hidden = true;
    // html 内所有插值都经过 escapeHtml，innerHTML 是安全的
    reportOut.innerHTML = result.html;
  });

  // —— 文件拖拽 / 选择：全程 try/catch，拒非 .json 与 >5MB，多文件取首个并提示 ——
  const MAX_FILE_BYTES = 5 * 1024 * 1024;
  const dropZone = byId('drop-zone');

  function note(message) {
    if (fileStatus) fileStatus.textContent = message;
  }

  function readReportFile(file) {
    try {
      if (!file.name.toLowerCase().endsWith('.json')) {
        note(`已跳过「${file.name}」：仅支持 .json 文件（report-*.json）。`);
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        note(`已跳过「${file.name}」：文件超过 5MB（实际 ${(file.size / 1024 / 1024).toFixed(1)}MB）。`);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          if (reportJson) reportJson.value = String(reader.result ?? '');
          note(`已读取「${file.name}」，点击「渲染评分卡」查看结果。`);
        } catch (error) {
          note(`读取结果处理失败：${error instanceof Error ? error.message : String(error)}`);
        }
      };
      reader.onerror = () => note(`读取「${file.name}」失败：${String(reader.error ?? '未知错误')}`);
      reader.readAsText(file);
    } catch (error) {
      note(`读取文件失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function handleFileList(fileList) {
    try {
      if (!fileList || fileList.length === 0) return;
      if (fileList.length > 1) note('已选择多个文件，仅读取第一个。');
      readReportFile(fileList[0]);
    } catch (error) {
      note(`读取文件失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  dropZone?.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropZone.classList.add('over');
  });
  dropZone?.addEventListener('dragleave', () => dropZone.classList.remove('over'));
  dropZone?.addEventListener('drop', (event) => {
    event.preventDefault();
    dropZone.classList.remove('over');
    handleFileList(event.dataTransfer?.files ?? null);
  });
  byId('report-file')?.addEventListener('change', (event) => {
    const input = event.target;
    if (input instanceof HTMLInputElement) handleFileList(input.files);
  });
}
