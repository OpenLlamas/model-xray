// web/app.js — model-xray 控制台前端
// 约束（沿袭 P1.5）：
//   ① 纯函数（escapeHtml / buildCommand / renderScorecard）供 Node 测试直接 import；
//   ② DOM 接线全部收在 `typeof document !== 'undefined'` 守卫内；
//   ③ 仅与本地回环服务（scripts/serve.mjs）通信，不访问任何外部地址；
//   ④ key 只提交给本地服务（keySource=page），命令预览里绝不出现 key。

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
    `  <div class="scorecard-head"><span class="total">可信度总分：${escapeHtml(total)}</span><span class="badge badge-${badgeClass(overall)}">${escapeHtml(overallLabel)}</span></div>`,
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

  // —— token / 在线状态：serve.mjs 注入 window.MX_TOKEN；占位符未替换 = 未连上本地服务 ——
  const TOKEN =
    typeof window !== 'undefined' &&
    typeof window.MX_TOKEN === 'string' &&
    window.MX_TOKEN !== '' &&
    !window.MX_TOKEN.includes('__MX_TOKEN__')
      ? window.MX_TOKEN
      : null;
  if (TOKEN === null) byId('offline-banner')?.removeAttribute('hidden');

  async function api(path, options = {}) {
    const headers = { ...(options.headers ?? {}) };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (TOKEN !== null) headers['x-model-xray-token'] = TOKEN;
    const res = await fetch(path, { method: options.method ?? 'GET', headers, body: options.body });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { status: res.status, ok: res.ok, data };
  }
  const isOffline = () => TOKEN === null;

  // —— 三 tab 切换 ——
  const tabs = { test: byId('tab-test'), guard: byId('tab-guard'), reports: byId('tab-reports') };
  const panels = { test: byId('panel-test'), guard: byId('panel-guard'), reports: byId('panel-reports') };
  function selectTab(which) {
    for (const key of ['test', 'guard', 'reports']) {
      tabs[key]?.setAttribute('aria-selected', key === which ? 'true' : 'false');
      if (panels[key]) panels[key].hidden = key !== which;
    }
  }
  tabs.test?.addEventListener('click', () => selectTab('test'));
  tabs.guard?.addEventListener('click', () => selectTab('guard'));
  tabs.reports?.addEventListener('click', () => {
    selectTab('reports');
    void refreshReports();
  });

  // —— key 条：状态读取 / 保存 / 清除（key 只提交给本地服务，响应不含 key 值） ——
  const keyDot = byId('key-dot');
  const keyState = byId('key-state');
  function renderKeyStatus(info) {
    const source = info?.keySource ?? null;
    if (keyDot) keyDot.classList.toggle('on', source !== null);
    if (keyState) {
      keyState.textContent =
        source === 'page'
          ? '已录入（保存在本机服务内存）'
          : source === 'env'
            ? '来自环境变量 MODEL_XRAY_KEY'
            : '未设置（检测前需要录入）';
    }
  }
  async function loadKeyStatus() {
    if (isOffline()) {
      renderKeyStatus({ keySource: null });
      return;
    }
    const res = await api('/api/status');
    renderKeyStatus(res.ok ? res.data : { keySource: null });
  }
  async function saveKey() {
    if (isOffline()) return;
    const key = inputValue('f-key').trim();
    if (key === '') {
      renderKeyStatus({ keySource: null });
      return;
    }
    const res = await api('/api/key', { method: 'POST', body: JSON.stringify({ key }) });
    if (!res.ok) {
      if (keyState) keyState.textContent = `保存失败：${String(res.data?.error ?? res.status)}`;
      return;
    }
    if (byId('f-key')) byId('f-key').value = '';
    renderKeyStatus(res.data);
  }
  byId('btn-key-save')?.addEventListener('click', () => void saveKey());
  byId('f-key')?.addEventListener('keydown', (event) => {
    if (event instanceof KeyboardEvent && event.key === 'Enter') void saveKey();
  });
  byId('btn-key-clear')?.addEventListener('click', async () => {
    if (isOffline()) return;
    const res = await api('/api/key/clear', { method: 'POST', body: '{}' });
    if (res.ok) renderKeyStatus(res.data);
  });
  void loadKeyStatus();

  // —— Tab ①：一次性检测 ——
  function collectForm() {
    return {
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
    };
  }
  function updateCommandPreview() {
    const form = collectForm();
    // Web 运行时服务端自动附带 --yes（跳过交互确认），预览与实际参数保持一致
    const result = buildCommand({ ...form, yes: !form.dryRun });
    const commandOut = byId('command-out');
    const hintsOut = byId('hints-out');
    if (commandOut) commandOut.textContent = result.error !== null ? `（参数尚未合法）${result.error}` : result.command;
    if (hintsOut) hintsOut.textContent = result.error !== null ? '' : ['', ...result.hints].join('\n');
    return result;
  }
  for (const id of [
    'f-base-url', 'f-model', 'f-claimed-context', 'f-price-input', 'f-price-output',
    'f-seed', 'f-timeout', 'f-out', 'f-baseline',
  ]) {
    byId(id)?.addEventListener('input', updateCommandPreview);
  }
  for (const id of ['f-expect-vision', 'f-expect-tool', 'f-expect-thinking', 'f-deep', 'f-dry-run']) {
    byId(id)?.addEventListener('change', updateCommandPreview);
  }
  updateCommandPreview();

  const runError = byId('run-error');
  const runBanner = byId('run-banner');
  const runLog = byId('run-log');
  const btnRun = byId('btn-run');
  let logPollTimer = null;

  function appendLogLines(pre, lines) {
    if (pre === null || !Array.isArray(lines)) return;
    if (pre.classList.contains('placeholder')) {
      pre.classList.remove('placeholder');
      pre.textContent = '';
    }
    for (const line of lines) {
      const div = document.createElement('div');
      const text = typeof line === 'object' && line !== null ? String(line.text ?? '') : String(line);
      if (/\[(FAIL|ERROR)\]|异常|告警/i.test(text)) div.className = 'log-line-fail';
      else if (/\[WARN\]|可疑/i.test(text)) div.className = 'log-line-warn';
      div.textContent = text;
      pre.appendChild(div);
    }
    pre.scrollTop = pre.scrollHeight;
  }
  function showRunBanner(kind, title, detail = '') {
    if (runBanner === null) return;
    runBanner.className = `banner ${kind === 'fail' ? 'banner-fail' : kind === 'pass' ? 'banner-pass' : 'banner-offline'}`;
    runBanner.textContent = detail === '' ? title : `${title} — ${detail}`;
    runBanner.removeAttribute('hidden');
  }
  async function renderReportResult(reportPaths, overall) {
    const wrap = byId('report-result');
    const links = byId('report-links');
    const out = byId('report-out');
    if (wrap === null) return;
    if (reportPaths === null) {
      wrap.setAttribute('hidden', '');
      return;
    }
    if (links !== null) {
      links.textContent = '';
      const items = [
        reportPaths.markdownPath && ['Markdown 报告', reportPaths.markdownPath],
        reportPaths.htmlPath && ['HTML 报告', reportPaths.htmlPath],
        reportPaths.jsonPath && ['JSON 原始数据', reportPaths.jsonPath],
        reportPaths.baselinePath && ['基线文件', reportPaths.baselinePath],
      ].filter(Boolean);
      for (const [label, path] of items) {
        const a = document.createElement('a');
        a.href = `/api/reports/file?name=${encodeURIComponent(path)}`;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = `${label} ↗`;
        links.appendChild(a);
      }
    }
    if (out !== null && reportPaths.jsonPath !== null) {
      const res = await fetch(`/api/reports/file?name=${encodeURIComponent(reportPaths.jsonPath)}`);
      if (res.ok) {
        const result = renderScorecard(await res.text());
        out.innerHTML = result.error !== null ? `<p class="error">${escapeHtml(result.error)}</p>` : result.html;
      }
    }
    wrap.removeAttribute('hidden');
    if (overall === 'fail') showRunBanner('fail', '⚠ 检测不通过：存在异常，请查看下方评分卡与 findings');
    else if (overall === 'pass') showRunBanner('pass', '✔ 检测通过：本轮未发现掺假/缩水证据');
  }
  function stopLogPoll() {
    if (logPollTimer !== null) {
      clearInterval(logPollTimer);
      logPollTimer = null;
    }
    if (btnRun) btnRun.disabled = false;
  }
  function pollJob(id) {
    let after = 0;
    let overall = null;
    logPollTimer = setInterval(async () => {
      try {
        const res = await api(`/api/jobs/${id}/log?after=${after}`);
        if (!res.ok) {
          stopLogPoll();
          showRunBanner('fail', '日志读取失败', String(res.data?.error ?? res.status));
          return;
        }
        const log = res.data;
        appendLogLines(runLog, log.lines);
        after = log.next;
        if (log.status === 'running') return;
        stopLogPoll();
        const detail = await api(`/api/jobs/${id}`);
        const exitCode = detail.ok ? detail.data.exitCode : null;
        const reportPaths = detail.ok ? detail.data.reportPaths : null;
        // 退出码语义：0 pass/warn · 1 fail · 2 error
        if (exitCode === 2) showRunBanner('fail', '任务出错（参数或端点问题）：exit 2，请查看日志');
        else if (exitCode === 1) overall = 'fail';
        if (log.status === 'error') showRunBanner('fail', '任务异常终止（子进程失败）');
        await renderReportResult(reportPaths, overall);
      } catch (error) {
        stopLogPoll();
        showRunBanner('fail', '轮询中断', error instanceof Error ? error.message : String(error));
      }
    }, 800);
  }
  btnRun?.addEventListener('click', async () => {
    if (isOffline()) {
      if (runError) {
        runError.textContent = '未连接本地服务：请在仓库目录运行 npm run ui，并使用打开的页面。';
        runError.removeAttribute('hidden');
      }
      return;
    }
    const form = collectForm();
    const check = buildCommand({ ...form, yes: !form.dryRun });
    if (check.error !== null) {
      if (runError) {
        runError.textContent = check.error;
        runError.removeAttribute('hidden');
      }
      return;
    }
    if (runError) runError.setAttribute('hidden', '');
    if (runBanner) runBanner.setAttribute('hidden', '');
    if (runLog) {
      runLog.classList.remove('placeholder');
      runLog.textContent = '';
    }
    byId('report-result')?.setAttribute('hidden', '');
    btnRun.disabled = true;
    const res = await api('/api/test', { method: 'POST', body: JSON.stringify(form) });
    if (!res.ok) {
      btnRun.disabled = false;
      if (runError) {
        runError.textContent = String(res.data?.error ?? `HTTP ${res.status}`);
        runError.removeAttribute('hidden');
      }
      return;
    }
    pollJob(res.data.id);
  });

  // —— Tab ②：常驻监控 ——
  const guardError = byId('guard-error');
  const guardStateEl = byId('guard-state');
  const guardLog = byId('guard-log');
  let guardPollTimer = null;
  let guardLogNext = 0;
  function renderGuardStatus(st) {
    if (guardStateEl === null) return;
    if (st?.running === true) {
      guardStateEl.textContent = `状态：运行中（本地代理 http://127.0.0.1:${String(st.port)}/v1 → ${String(st.baseUrl)}）`;
    } else if (st?.status === 'exited') {
      guardStateEl.textContent = `状态：已退出（exit ${String(st.exitCode)}）；输出见下方日志。`;
    } else {
      guardStateEl.textContent = '状态：未启动';
    }
  }
  async function pollGuardOnce() {
    try {
      const [statusRes, logRes] = await Promise.all([
        api('/api/guard/status'),
        api(`/api/guard/log?after=${guardLogNext}`),
      ]);
      if (statusRes.ok) renderGuardStatus(statusRes.data);
      if (logRes.ok) {
        appendLogLines(guardLog, logRes.data.lines);
        guardLogNext = logRes.data.next;
      }
    } catch {
      /* 轮询失败静默重试 */
    }
  }
  function ensureGuardPoll() {
    if (guardPollTimer === null) guardPollTimer = setInterval(() => void pollGuardOnce(), 1000);
  }
  byId('btn-guard-start')?.addEventListener('click', async () => {
    if (isOffline()) {
      if (guardError) {
        guardError.textContent = '未连接本地服务：请在仓库目录运行 npm run ui。';
        guardError.removeAttribute('hidden');
      }
      return;
    }
    if (guardError) guardError.setAttribute('hidden', '');
    const body = {
      baseUrl: inputValue('f-guard-base-url'),
      port: inputValue('f-guard-port'),
      priceInput: inputValue('f-guard-price-in'),
      priceOutput: inputValue('f-guard-price-out'),
    };
    const res = await api('/api/guard/start', { method: 'POST', body: JSON.stringify(body) });
    if (!res.ok) {
      if (guardError) {
        guardError.textContent = String(res.data?.error ?? `HTTP ${res.status}`);
        guardError.removeAttribute('hidden');
      }
      return;
    }
    guardLogNext = 0;
    if (guardLog) {
      guardLog.classList.remove('placeholder');
      guardLog.textContent = '';
    }
    void pollGuardOnce();
    ensureGuardPoll();
  });
  byId('btn-guard-stop')?.addEventListener('click', async () => {
    if (isOffline()) return;
    await api('/api/guard/stop', { method: 'POST', body: '{}' });
    await pollGuardOnce();
  });

  // —— Tab ③：历史报告 ——
  const historyError = byId('history-error');
  const historyOut = byId('history-out');
  async function refreshReports() {
    if (isOffline()) {
      if (historyError) {
        historyError.textContent = '未连接本地服务：历史报告列表需要 npm run ui 启动的本地服务。';
        historyError.removeAttribute('hidden');
      }
      return;
    }
    if (historyError) historyError.setAttribute('hidden', '');
    const res = await api('/api/reports');
    if (!res.ok) {
      if (historyError) {
        historyError.textContent = String(res.data?.error ?? `HTTP ${res.status}`);
        historyError.removeAttribute('hidden');
      }
      return;
    }
    const list = byId('report-list');
    if (list === null) return;
    list.textContent = '';
    const reports = Array.isArray(res.data?.reports) ? res.data.reports : [];
    if (reports.length === 0) {
      const li = document.createElement('li');
      li.className = 'placeholder';
      li.textContent = 'reports/ 下暂无报告文件。';
      list.appendChild(li);
      return;
    }
    for (const item of reports) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = String(item.name);
      name.title = '点击查看';
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `${new Date(Number(item.mtimeMs)).toLocaleString()} · ${(Number(item.size) / 1024).toFixed(1)} KB`;
      li.appendChild(name);
      li.appendChild(meta);
      if (String(item.name).endsWith('.json')) {
        name.addEventListener('click', async () => {
          const fileRes = await fetch(`/api/reports/file?name=${encodeURIComponent(String(item.name))}`);
          if (!fileRes.ok || historyOut === null) return;
          const result = renderScorecard(await fileRes.text());
          historyOut.innerHTML =
            result.error !== null
              ? `<p class="error">${escapeHtml(result.error)}</p>`
              : `<h4>${escapeHtml(String(item.name))}</h4>${result.html}`;
        });
      } else {
        const a = document.createElement('a');
        a.href = `/api/reports/file?name=${encodeURIComponent(String(item.name))}`;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = '打开 ↗';
        a.style.color = '#6cb2ff';
        a.style.fontSize = '12px';
        li.appendChild(a);
      }
      list.appendChild(li);
    }
  }
  byId('btn-reports-refresh')?.addEventListener('click', () => void refreshReports());
}
