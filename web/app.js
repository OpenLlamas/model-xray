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
  const tabs = { test: byId('tab-test'), guard: byId('tab-guard'), gateway: byId('tab-gateway'), reports: byId('tab-reports') };
  const panels = { test: byId('panel-test'), guard: byId('panel-guard'), gateway: byId('panel-gateway'), reports: byId('panel-reports') };
  function selectTab(which) {
    for (const key of ['test', 'guard', 'gateway', 'reports']) {
      tabs[key]?.setAttribute('aria-selected', key === which ? 'true' : 'false');
      if (panels[key]) panels[key].hidden = key !== which;
    }
  }
  tabs.test?.addEventListener('click', () => selectTab('test'));
  tabs.guard?.addEventListener('click', () => selectTab('guard'));
  tabs.gateway?.addEventListener('click', () => {
    selectTab('gateway');
    void refreshGateway();
  });
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
    runBanner.className = `banner ${kind === 'fail' ? 'banner-fail' : kind === 'warn' ? 'banner-warn' : kind === 'pass' ? 'banner-pass' : 'banner-offline'}`;
    runBanner.textContent = detail === '' ? title : `${title} — ${detail}`;
    runBanner.removeAttribute('hidden');
  }
  async function renderReportResult(reportPaths, exitCode, jobStatus) {
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
    // 判定优先取报告 JSON 的 overall（warn 只有这里能拿到），读不到再按退出码兜底
    let overall = null;
    if (out !== null && reportPaths.jsonPath !== null) {
      const res = await fetch(`/api/reports/file?name=${encodeURIComponent(reportPaths.jsonPath)}`);
      if (res.ok) {
        const text = await res.text();
        const result = renderScorecard(text);
        out.innerHTML = result.error !== null ? `<p class="error">${escapeHtml(result.error)}</p>` : result.html;
        try {
          const parsed = JSON.parse(text);
          if (typeof parsed.overall === 'string') overall = parsed.overall;
        } catch {
          /* overall 兜底走退出码 */
        }
      }
    }
    wrap.removeAttribute('hidden');
    if (jobStatus === 'error') showRunBanner('fail', '⚠ 任务异常终止（子进程失败）：请查看日志');
    else if (overall === 'fail') showRunBanner('fail', '⚠ 检测不通过：存在异常，请查看下方评分卡与 findings');
    else if (overall === 'warn') showRunBanner('warn', '⚠ 可疑：存在可疑迹象但未实锤，请查看评分卡与 findings');
    else if (overall === 'pass') showRunBanner('pass', '✔ 检测通过：本轮未发现掺假/缩水证据');
    else if (exitCode === 1) showRunBanner('fail', '⚠ 检测不通过（exit 1）：请查看日志与报告');
    else if (exitCode === 2) showRunBanner('fail', '任务出错或未得出结论（exit 2）：请核对参数/key/端点后重试，详见日志');
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
        await renderReportResult(reportPaths, exitCode, log.status);
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
    guardStateEl.dataset.running = st?.running === true ? 'true' : 'false';
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

  // —— Tab ③：多渠道 OpenAI API 聚合入口（上游凭证仅驻留本机服务内存） ——
  const gatewayError = byId('gateway-error');
  const channelForm = byId('channel-form');
  const channelList = byId('channel-list');
  const gatewayState = byId('gateway-status');
  const gatewayBaseUrl = byId('gateway-base-url');
  const gatewayKeyState = byId('gateway-client-key-state');
  const gatewayClientKey = byId('f-gateway-client-key');
  const gatewayCopyUrl = byId('gateway-copy-url');
  const ledgerBanner = byId('ledger-degraded-banner');
  /** 渠道 id → 渠道名（用量表的渠道列用名称展示，缺失时兜底 id）。 */
  const channelLabels = new Map();
  let gatewayRunning = false;

  function showGatewayError(message = '') {
    if (gatewayError === null) return;
    gatewayError.textContent = message;
    gatewayError.toggleAttribute('hidden', message === '');
  }
  function setChannelForm(channel = null) {
    if (!(channelForm instanceof HTMLFormElement)) return;
    channelForm.reset();
    const editing = channel !== null;
    byId('f-channel-id').value = editing ? String(channel.id) : '';
    byId('f-channel-label').value = editing ? String(channel.label) : '';
    byId('f-channel-base-url').value = editing ? String(channel.baseUrl) : '';
    byId('f-channel-key').value = '';
    byId('f-channel-key').required = !editing;
    byId('channel-key-help').textContent = editing ? '（留空保持原密钥不变）' : '*';
    const modelMap = editing && channel.modelMap !== null && typeof channel.modelMap === 'object' ? channel.modelMap : {};
    const models = editing ? channel.models : [];
    byId('f-channel-models').value = Array.isArray(models) ? models.join(', ') : '';
    byId('f-channel-map').value = Object.entries(modelMap).map(([alias, model]) => `${alias}=${String(model)}`).join('\n');
    channelForm.hidden = false;
    byId('f-channel-label')?.focus();
  }
  function channelModelTags(channel) {
    const models = Array.isArray(channel?.models) ? channel.models : [];
    return models.map((model) => `<span class="channel-model">${escapeHtml(model)}</span>`).join('');
  }
  function renderChannels(channels) {
    if (channelList === null) return;
    channelList.textContent = '';
    channelLabels.clear();
    if (!Array.isArray(channels) || channels.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'note';
      empty.textContent = '尚未添加 API 渠道。添加端点后，可以选择启动聚合网关。';
      channelList.appendChild(empty);
      return;
    }
    for (const channel of channels) {
      const card = document.createElement('article');
      card.className = 'channel-card';
      const indicator = document.createElement('span');
      indicator.className = 'channel-indicator';
      indicator.dataset.enabled = String(channel.enabled === true);
      const main = document.createElement('div');
      main.className = 'channel-main';
      const title = document.createElement('div');
      title.className = 'channel-title';
      title.textContent = `${String(channel.label)}${channel.enabled === true ? '' : ' · 已停用'}`;
      const endpoint = document.createElement('div');
      endpoint.className = 'channel-endpoint';
      endpoint.textContent = String(channel.baseUrl);
      const models = document.createElement('div');
      models.className = 'channel-models';
      models.innerHTML = channelModelTags(channel);
      main.append(title, endpoint, models);
      const actions = document.createElement('div');
      actions.className = 'channel-actions';
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'secondary';
      toggle.textContent = channel.enabled === true ? '停用' : '启用';
      toggle.addEventListener('click', () => void updateChannel(channel, { enabled: channel.enabled !== true }));
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'secondary';
      edit.textContent = '编辑';
      edit.addEventListener('click', () => setChannelForm(channel));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'secondary';
      remove.textContent = '移除';
      remove.addEventListener('click', async () => {
        const response = await api(`/api/gateway/channels/${encodeURIComponent(String(channel.id))}/delete`, { method: 'POST', body: '{}' });
        if (!response.ok) showGatewayError(String(response.data?.error ?? `HTTP ${response.status}`));
        else { showGatewayError(); await refreshGateway(); }
      });
      actions.append(toggle, edit, remove);
      card.append(indicator, main, actions);
      channelList.appendChild(card);
      channelLabels.set(String(channel.id), String(channel.label));
    }
  }
  async function updateChannel(channel, patch) {
    const response = await api(`/api/gateway/channels/${encodeURIComponent(String(channel.id))}`, {
      method: 'POST', body: JSON.stringify(patch),
    });
    if (!response.ok) showGatewayError(String(response.data?.error ?? `HTTP ${response.status}`));
    else { showGatewayError(); await refreshGateway(); }
  }
  async function refreshGateway() {
    if (isOffline()) return;
    try {
      const [statusResponse, channelResponse] = await Promise.all([
        api('/api/gateway/status'),
        api('/api/gateway/channels'),
      ]);
      if (!statusResponse.ok || !channelResponse.ok) {
        const problem = statusResponse.ok ? channelResponse : statusResponse;
        showGatewayError(String(problem.data?.error ?? `HTTP ${problem.status}`));
        return;
      }
      const status = statusResponse.data;
      gatewayRunning = status?.running === true;
      // 账本降级横幅（页面顶部）：写入失败必须显式披露数据缺口，绝不静默；转发不受影响（fail-open）
      const degraded = gatewayRunning && status !== null && typeof status === 'object' ? status.degraded : null;
      const writeErrors = Number(degraded?.writeErrors ?? 0);
      const showDegraded = gatewayRunning && (degraded?.degraded === true || writeErrors > 0);
      if (ledgerBanner) {
        ledgerBanner.textContent = showDegraded
          ? `账本降级：写入失败 ${writeErrors} 次（数据缺口，统计不含被丢弃请求）`
          : '';
        ledgerBanner.toggleAttribute('hidden', !showDegraded);
      }
      if (gatewayState) {
        gatewayState.textContent = gatewayRunning
          ? `运行中 · ${Number(status.enabledChannelCount ?? 0)} 个模型 · 请求 ${Number(status.requests?.total ?? 0)} 次（错 ${Number(status.requests?.error ?? 0)}）`
          : '未启动';
        gatewayState.title =
          gatewayRunning && status.lastError ? `最近一次上游错误：${String(status.lastError.message)}` : '';
      }
      const base = gatewayRunning ? `http://127.0.0.1:${String(status.port)}/v1` : '等待启动';
      if (gatewayBaseUrl) gatewayBaseUrl.textContent = base;
      if (gatewayCopyUrl) gatewayCopyUrl.textContent = base;
      if (gatewayClientKey && gatewayRunning && gatewayClientKey.value === '') {
        const keyResponse = await api('/api/gateway/virtual-key');
        if (keyResponse.ok) gatewayClientKey.value = String(keyResponse.data?.virtualKey ?? '');
      }
      if (!gatewayRunning && gatewayClientKey) gatewayClientKey.value = '';
      if (gatewayKeyState) gatewayKeyState.textContent = gatewayRunning ? '会话密钥' : '未生成';
      renderChannels(channelResponse.data?.channels);
      if (!gatewayRunning) {
        // 网关停止：实时面板清空（内存计数随实例销毁；账本才是权威历史）
        renderUsage([]);
        renderAlerts([]);
      }
      showGatewayError();
    } catch (error) {
      showGatewayError(error instanceof Error ? error.message : String(error));
    }
  }
  byId('btn-channel-new')?.addEventListener('click', () => setChannelForm());
  byId('btn-channel-cancel')?.addEventListener('click', () => { if (channelForm) channelForm.hidden = true; });
  channelForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = inputValue('f-channel-id');
    const models = inputValue('f-channel-models').split(',').map((item) => item.trim()).filter(Boolean);
    const modelMap = {};
    for (const line of inputValue('f-channel-map').split(/\r?\n/)) {
      if (line.trim() === '') continue;
      const split = line.indexOf('=');
      if (split < 1 || line.slice(split + 1).trim() === '') {
        showGatewayError(`模型映射格式无效：${JSON.stringify(line)}。示例：fast-model=gpt-4o-mini`);
        return;
      }
      modelMap[line.slice(0, split).trim()] = line.slice(split + 1).trim();
    }
    const body = {
      label: inputValue('f-channel-label'), baseUrl: inputValue('f-channel-base-url'),
      apiKey: inputValue('f-channel-key'), models, modelMap,
    };
    if (id !== '') delete body.apiKey; // 编辑时空 key 表示保留；非空 key 显式轮换
    if (id !== '' && inputValue('f-channel-key') !== '') body.apiKey = inputValue('f-channel-key');
    const response = await api(id === '' ? '/api/gateway/channels' : `/api/gateway/channels/${encodeURIComponent(id)}`, {
      method: 'POST', body: JSON.stringify(body),
    });
    if (!response.ok) { showGatewayError(String(response.data?.error ?? `HTTP ${response.status}`)); return; }
    channelForm.hidden = true;
    showGatewayError();
    await refreshGateway();
  });
  byId('btn-gateway-start')?.addEventListener('click', async () => {
    showGatewayError();
    const port = inputValue('f-gateway-port').trim();
    const response = await api('/api/gateway/start', { method: 'POST', body: JSON.stringify(port === '' ? {} : { port }) });
    if (!response.ok) { showGatewayError(String(response.data?.error ?? `HTTP ${response.status}`)); return; }
    gatewayRunning = true;
    if (gatewayClientKey) gatewayClientKey.value = String(response.data?.virtualKey ?? '');
    await refreshGateway();
  });
  byId('btn-gateway-rotate')?.addEventListener('click', async () => {
    const response = await api('/api/gateway/virtual-key/rotate', { method: 'POST', body: '{}' });
    if (!response.ok) { showGatewayError(String(response.data?.error ?? `HTTP ${response.status}`)); return; }
    if (gatewayClientKey) gatewayClientKey.value = String(response.data?.virtualKey ?? '');
    await refreshGateway();
  });
  byId('btn-gateway-stop')?.addEventListener('click', async () => {
    const response = await api('/api/gateway/stop', { method: 'POST', body: '{}' });
    if (!response.ok) showGatewayError(String(response.data?.error ?? `HTTP ${response.status}`));
    else await refreshGateway();
  });
  byId('f-gateway-client-key')?.addEventListener('focus', (event) => event.currentTarget.select());

  // —— 用量与异常面板（S2/S3 实时口径）：3 秒轮询，仅当网关运行中且本标签可见 ——
  const usageBody = byId('gateway-usage-body');
  const alertsList = byId('gateway-alerts');
  const ALERT_KIND_LABELS = {
    model_mismatch: '模型自述不符',
    error_rate: '错误率异常',
    truncated: '响应截断',
    usage_invalid: 'usage 异常',
  };
  function formatLatency(value) {
    const ms = Number(value);
    if (!Number.isFinite(ms)) return '—';
    return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
  }
  function renderUsage(usage) {
    if (!(usageBody instanceof HTMLTableSectionElement)) return;
    usageBody.textContent = '';
    const rows = Array.isArray(usage) ? usage : [];
    if (rows.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 10;
      td.className = 'placeholder';
      td.textContent = '暂无实时用量（网关未运行或尚无已结算请求）。';
      tr.appendChild(td);
      usageBody.appendChild(tr);
      return;
    }
    for (const row of rows) {
      const cells = [
        String(row.alias),
        channelLabels.get(String(row.channelId)) ?? String(row.channelId),
        String(Number(row.requests ?? 0)),
        String(Number(row.ok ?? 0)),
        String(Number(row.error ?? 0)),
        String(Number(row.tokenPrompt ?? 0)),
        String(Number(row.tokenCompletion ?? 0)),
        row.ttftP50Ms === null || row.ttftP50Ms === undefined ? '—' : formatLatency(row.ttftP50Ms),
        row.provisional === true
          ? `样本不足 n=${Number(row.ttftSamples ?? 0)}`
          : row.ttftP95Ms === null || row.ttftP95Ms === undefined ? '—' : formatLatency(row.ttftP95Ms),
        row.usageValidRate === null || row.usageValidRate === undefined ? '—' : `${(Number(row.usageValidRate) * 100).toFixed(1)}%`,
      ];
      const tr = document.createElement('tr');
      for (const text of cells) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      }
      usageBody.appendChild(tr);
    }
  }
  function renderAlerts(events) {
    if (alertsList === null) return;
    alertsList.textContent = '';
    const list = Array.isArray(events) ? events : [];
    if (list.length === 0) {
      const li = document.createElement('li');
      li.className = 'placeholder';
      li.textContent = '暂无告警（网关未运行或窗口未达阈值）。';
      alertsList.appendChild(li);
      return;
    }
    for (const event of list) {
      const kind = String(event.kind ?? '');
      const label = ALERT_KIND_LABELS[kind] ?? kind;
      const observed =
        kind === 'model_mismatch' || kind === 'truncated'
          ? `${Number(event.observed ?? 0)} 次`
          : `${(Number(event.observed ?? 0) * 100).toFixed(0)}%`;
      const evidenceCount = Array.isArray(event.evidence_request_ids) ? event.evidence_request_ids.length : 0;
      const li = document.createElement('li');
      li.textContent =
        `${new Date(Number(event.ts)).toLocaleTimeString()} · ${channelLabels.get(String(event.channel)) ?? String(event.channel)}` +
        ` · ${label} · 窗口 ${Number(event.n ?? 0)} 条 / 观测 ${observed} · 证据请求 ${evidenceCount} 条（账本可下钻）`;
      alertsList.appendChild(li);
    }
  }
  async function refreshGatewayLedger() {
    if (isOffline() || !gatewayRunning) return;
    try {
      const [usageResponse, eventsResponse] = await Promise.all([api('/api/gateway/usage'), api('/api/gateway/events')]);
      if (usageResponse.ok) renderUsage(usageResponse.data?.usage);
      if (eventsResponse.ok) renderAlerts(eventsResponse.data?.events);
    } catch {
      /* 面板局部失败静默：主刷新已负责错误提示 */
    }
  }
  window.setInterval(() => {
    if (tabs.gateway?.getAttribute('aria-selected') === 'true') void refreshGatewayLedger();
  }, 3000);
  renderUsage([]);
  renderAlerts([]);

  void refreshGateway();
  window.setInterval(() => {
    if (tabs.gateway?.getAttribute('aria-selected') === 'true') void refreshGateway();
  }, 2500);

  // —— Tab ④：历史报告 ——
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
