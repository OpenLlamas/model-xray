// web/app.js — model-xray 控制台前端
// 约束（沿袭 P1.5）：
//   ① 纯函数（escapeHtml / buildCommand / renderScorecard / scrubSecrets / buildModelPrices / formatCostUsd）供 Node 测试直接 import；
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

/** 严格非负数（缓存读价可免费）：形如数字、Number() 有限且 >= 0。 */
function isNonNegativeNumberStr(raw) {
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(raw)) return false;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0;
}

/** quota 每美元换算系数的有效域（与 src/pricing.ts 的 QUOTA_PER_UNIT_MIN/MAX 同口径）。 */
function isPlausibleQuotaPerUnitStr(raw) {
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(raw)) return false;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1 && value <= 1e12;
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
  const priceCachedReadRaw = String(input?.priceCachedRead ?? '').trim();
  const priceThresholdRaw = String(input?.priceThreshold ?? '').trim();
  const priceInput2Raw = String(input?.priceInput2 ?? '').trim();
  const priceOutput2Raw = String(input?.priceOutput2 ?? '').trim();
  const priceCachedRead2Raw = String(input?.priceCachedRead2 ?? '').trim();
  const hasPriceInput = priceInputRaw !== '';
  const hasPriceOutput = priceOutputRaw !== '';
  const anyOptionalPrice =
    priceCachedReadRaw !== '' ||
    priceThresholdRaw !== '' ||
    priceInput2Raw !== '' ||
    priceOutput2Raw !== '' ||
    priceCachedRead2Raw !== '';
  // 判空必须用 !== ''（不能用真值判断，否则 '0' 会被误判成「未填」）
  if (!hasPriceInput && !hasPriceOutput) {
    if (anyOptionalPrice) {
      return fail('--price-input 与 --price-output 必须成对填写（缓存读与阶梯价为可选补充）。示例：--price-input 2.5 --price-output 10');
    }
  } else {
    if (!hasPriceInput || !hasPriceOutput) {
      return fail('--price-input 与 --price-output 必须成对填写。示例：--price-input 2.5 --price-output 10');
    }
    if (!isPositiveNumberStr(priceInputRaw)) {
      return fail(`--price-input 必须为正数（每百万 tokens 录入价，0 与负数无效）。收到：${JSON.stringify(priceInputRaw)}。示例：--price-input 2.5`);
    }
    if (!isPositiveNumberStr(priceOutputRaw)) {
      return fail(`--price-output 必须为正数（每百万 tokens 录入价，0 与负数无效）。收到：${JSON.stringify(priceOutputRaw)}。示例：--price-output 10`);
    }
    if (priceCachedReadRaw !== '' && !isNonNegativeNumberStr(priceCachedReadRaw)) {
      return fail(`--price-cached-read 必须为不小于 0 的数字（缓存读命中价，可免费）。收到：${JSON.stringify(priceCachedReadRaw)}。示例：--price-cached-read 0.5`);
    }
    const tierPresent = priceThresholdRaw !== '' || priceInput2Raw !== '' || priceOutput2Raw !== '';
    const tierComplete = priceThresholdRaw !== '' && priceInput2Raw !== '' && priceOutput2Raw !== '';
    if (tierPresent && !tierComplete) {
      return fail('--price-threshold、--price-input2、--price-output2 必须成组填写。示例：--price-threshold 1000000 --price-input2 6 --price-output2 22.5');
    }
    if (!tierComplete && priceCachedRead2Raw !== '') {
      return fail('--price-cached-read2 仅在填写阶梯价（阈值/二档输入/二档输出）时可用。示例：--price-threshold 1000000 --price-input2 6 --price-output2 22.5 --price-cached-read2 0.75');
    }
    if (tierComplete) {
      if (!isPositiveIntStr(priceThresholdRaw)) {
        return fail(`--price-threshold 必须是正整数 tokens。收到：${JSON.stringify(priceThresholdRaw)}。示例：--price-threshold 1000000`);
      }
      if (!isPositiveNumberStr(priceInput2Raw)) {
        return fail(`--price-input2 必须为正数（每百万 tokens 二档输入价）。收到：${JSON.stringify(priceInput2Raw)}。示例：--price-input2 6`);
      }
      if (!isPositiveNumberStr(priceOutput2Raw)) {
        return fail(`--price-output2 必须为正数（每百万 tokens 二档输出价）。收到：${JSON.stringify(priceOutput2Raw)}。示例：--price-output2 22.5`);
      }
      if (priceCachedRead2Raw !== '' && !isNonNegativeNumberStr(priceCachedRead2Raw)) {
        return fail(`--price-cached-read2 必须为不小于 0 的数字（二档缓存读命中价，可免费）。收到：${JSON.stringify(priceCachedRead2Raw)}。示例：--price-cached-read2 0.75`);
      }
    }
  }

  // 公示价 / 倍率锚点（CLI 同口径）：留空 = 全部不传，由 CLI 用缺省与自动探测。
  const expectModelRatioRaw = String(input?.expectModelRatio ?? '').trim();
  if (expectModelRatioRaw !== '' && !isPositiveNumberStr(expectModelRatioRaw)) {
    return fail(`--expect-model-ratio 必须是大于 0 的数字（你所在分组的公示 model_ratio）。收到：${JSON.stringify(expectModelRatioRaw)}。示例：--expect-model-ratio 1.5`);
  }
  const expectCompletionRatioRaw = String(input?.expectCompletionRatio ?? '').trim();
  if (expectCompletionRatioRaw !== '' && !isPositiveNumberStr(expectCompletionRatioRaw)) {
    return fail(`--expect-completion-ratio 必须是大于 0 的数字（你所在分组的公示 completion_ratio）。收到：${JSON.stringify(expectCompletionRatioRaw)}。示例：--expect-completion-ratio 4`);
  }
  const quotaPerUsdRaw = String(input?.quotaPerUsd ?? '').trim();
  // 与站点公示口径同一有效域（1~1e12）：域外值 CLI 会拒，前端提前拦并给同一口径的提示。
  if (quotaPerUsdRaw !== '' && !isPlausibleQuotaPerUnitStr(quotaPerUsdRaw)) {
    return fail(`--quota-per-usd 必须是 1~1e12 之间的数（每 1 美元对应的 quota 单位数，如 new-api 默认 500000）。收到：${JSON.stringify(quotaPerUsdRaw)}。示例：--quota-per-usd 500000`);
  }
  // 网页价格兜底页：同源相对路径或同源绝对 URL；同源/协议校验在 pricing-scrape 内 fail-closed。
  const declaredPricePageRaw = String(input?.declaredPricePage ?? '').trim();
  if (declaredPricePageRaw !== '' && !/^(\/[^\s]*|https?:\/\/[^\s]+)$/.test(declaredPricePageRaw)) {
    return fail(`--declared-price-page 必须是同源相对路径（如 /pricing）或 http(s) 绝对 URL。收到：${JSON.stringify(declaredPricePageRaw)}。示例：--declared-price-page /pricing`);
  }
  const originIssue = declaredPricePageRaw !== '' ? declaredPricePageOriginIssue(baseUrl, declaredPricePageRaw) : null;
  if (originIssue !== null) return fail(originIssue);

  const seedRaw = String(input?.seed ?? '').trim();
  if (seedRaw !== '' && !isPositiveIntStr(seedRaw)) {
    return fail(`--seed 必须是正整数。收到：${JSON.stringify(seedRaw)}。示例：--seed 12345`);
  }
  const timeoutRaw = String(input?.timeout ?? '').trim();
  if (timeoutRaw !== '' && !isPositiveIntStr(timeoutRaw)) {
    return fail(`--timeout 必须是正整数（秒）。收到：${JSON.stringify(timeoutRaw)}。示例：--timeout 60`);
  }
  const httpRetriesRaw = String(input?.httpRetries ?? '').trim();
  if (httpRetriesRaw !== '' && (!/^\d+$/.test(httpRetriesRaw) || Number(httpRetriesRaw) > 6)) {
    return fail(`--http-retries 必须是 0-6 的整数（429/5xx 网关拒绝的重试预算）。收到：${JSON.stringify(httpRetriesRaw)}。示例：--http-retries 2`);
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
  // cmd 模式：双引号内 %VAR% 仍展开、双引号无法转义；! 在启用延迟展开（cmd /v:on，绝大多数启动脚本如此）
  // 时同样展开且双引号不设防 → 与 % 同等对待。
  const badChars = shell === 'cmd' ? /["%!\r\n\0]/ : /['\r\n\0]/;
  const badCharsLabel = shell === 'cmd' ? '双引号、%、! 或换行等控制字符' : '单引号或换行等控制字符';
  for (const [raw, flag, example] of [
    [baseUrl, 'base-url', 'https://relay.example.com/v1'],
    [model, 'model', 'gpt-4o'],
    [outRaw, 'out', 'report.json'],
    [baselineRaw, 'baseline', 'baseline.json'],
    // 价格兜底页同样要进引用健全性检查：它走 quote() 输出，cmd 模式下双引号/"%"/换行会破坏引用甚至注入命令。
    [declaredPricePageRaw, 'declared-price-page', '/pricing'],
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
    if (priceCachedReadRaw !== '') parts.push(`--price-cached-read ${priceCachedReadRaw}`);
    if (priceThresholdRaw !== '') {
      parts.push(`--price-threshold ${priceThresholdRaw}`);
      parts.push(`--price-input2 ${priceInput2Raw}`);
      parts.push(`--price-output2 ${priceOutput2Raw}`);
      if (priceCachedRead2Raw !== '') parts.push(`--price-cached-read2 ${priceCachedRead2Raw}`);
    }
  }
  if (seedRaw !== '') parts.push(`--seed ${seedRaw}`);
  if (expectModelRatioRaw !== '') parts.push(`--expect-model-ratio ${expectModelRatioRaw}`);
  if (expectCompletionRatioRaw !== '') parts.push(`--expect-completion-ratio ${expectCompletionRatioRaw}`);
  if (quotaPerUsdRaw !== '') parts.push(`--quota-per-usd ${quotaPerUsdRaw}`);
  if (declaredPricePageRaw !== '') parts.push(`--declared-price-page ${quote(declaredPricePageRaw)}`);
  if (input?.readBalance === true) {
    if (!hasPriceInput) {
      return { command: '', hints, error: '余额对账需要先填写输入/输出单价：实扣倍率 = 实际扣费 ÷（录入价×自报 usage），没有录入价就算不出应缴分母。' };
    }
    parts.push('--read-balance');
  }
  if (timeoutRaw !== '') parts.push(`--timeout ${timeoutRaw}`);
  if (httpRetriesRaw !== '') parts.push(`--http-retries ${httpRetriesRaw}`);
  if (outRaw !== '') parts.push(`--out ${quote(outRaw)}`);
  if (baselineRaw !== '') parts.push(`--baseline ${quote(baselineRaw)}`);
  if (input?.deep === true) parts.push('--deep');
  if (dryRun) parts.push('--dry-run');
  if (yes) parts.push('--yes');

  return { command: parts.join(' '), hints, error: null };
}

// 总评徽标：仅 fail 有结论词（不通过）；pass/warn/unknown 一律只展示分数（无「可疑/通过」档）
const OVERALL_LABEL = { fail: '不通过' };

function badgeClass(level) {
  return ['pass', 'warn', 'fail', 'unknown'].includes(level) ? level : 'unknown';
}

function fieldText(record, key) {
  const value = record?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

// ---------------------------------------------------------------------------
// 评分卡的倍率/指标渲染（纯函数，供 Node 测试直接 import）
// ---------------------------------------------------------------------------

/**
 * 「计费与倍率」摘要块：中文标签 + 固定展示顺序（公示价 → 抓价 → 实扣倍率 → 金额核验 → 价格 → 证据）。
 * 只渲染报告里实际存在的 key——缺失即不出现，绝不用占位值冒充结论。
 * 与 src/report/markdown.ts 的 BILLING_METRIC_LABELS 同口径（web/ 不参与 tsc 编译，无法直接 import），
 * 两侧一致性由 test/unit/report.test.ts 的漂移钉子守住。
 */
const BILLING_METRIC_LABELS = [
  ['pricing_state', '公示价接口'],
  ['declared_source', '公示价来源类型'],
  ['declared_origin', '公示价来源'],
  ['declared_captured_at', '公示价抓取时刻'],
  ['declared_group', '生效分组'],
  ['declared_group_ratio', '分组折扣倍率'],
  ['group_ratio_verified', '分组倍率可信'],
  ['declared_model_ratio', '公示输入倍率（公开价表为反推值）'],
  ['declared_completion_ratio', '公示输出倍率（公开价表为反推值）'],
  ['cache_ratio', '缓存倍率'],
  ['declared_drift_count', '公示价上调/口径断裂项数'],
  ['declared_drift_down_count', '公示价下调项数（不扣分）'],
  ['declared_drift_fields', '公示价漂移字段'],
  ['public_price_state', '公开价表状态'],
  ['public_price_page', '公开价表页面'],
  ['public_price_reason', '公开价表原因'],
  ['public_price_entries', '公开价表条目数'],
  ['public_price_matched', '公开价表命中模型'],
  ['public_price_input_usd_per_m', '公开价输入价（$/百万）'],
  ['public_price_output_usd_per_m', '公开价输出价（$/百万）'],
  ['public_price_cached_usd_per_m', '公开价缓存价（$/百万）'],
  ['public_price_list_input_usd_per_m', '公开价列表输入价（$/百万）'],
  ['public_price_list_output_usd_per_m', '公开价列表输出价（$/百万）'],
  ['public_price_list_cached_usd_per_m', '公开价列表缓存价（$/百万）'],
  ['claimed_price_ratio_input', '你填的单价÷站点现价（输入；只比价目，未看实扣）'],
  ['claimed_price_ratio_output', '你填的单价÷站点现价（输出；只比价目，未看实扣）'],
  ['public_price_ratio_input', '站点现价÷官方列表价（输入；仅披露）'],
  ['public_price_ratio_output', '站点现价÷官方列表价（输出；仅披露）'],
  ['scraped_price_state', '网页抓价状态'],
  ['scraped_price_reason', '网页抓价原因'],
  ['scraped_price_page', '抓价页面'],
  ['scraped_price_matched', '抓价命中模型'],
  ['scraped_price_input_usd_per_m', '抓价输入价（$/百万）'],
  ['scraped_price_output_usd_per_m', '抓价输出价（$/百万）'],
  ['scraped_price_confidence', '抓价置信度'],
  ['scraped_price_currency', '抓价币种'],
  ['measured_ratio', '实扣倍率（实际扣费÷应缴）'],
  ['ratio_verified', '实扣倍率可信'],
  ['ratio_masked_verdict', '实扣倍率底层判定（用户级口径永不判 fail）'],
  ['ratio_contaminated', '倍率被污染'],
  ['ratio_samples', '倍率样本数'],
  ['ratio_dropped', '丢弃样本数'],
  ['balance_endpoint', '余额端点'],
  ['balance_probe_reason', '余额探测原因'],
  ['balance_unit', '余额读数单位'],
  ['balance_resolution', '余额读数刻度'],
  ['balance_calibrated_unit', '校准后单位（推断口径）'],
  ['balance_calibration_confidence', '单位校准置信度（推断 high/low）'],
  ['balance_scope', '余额口径'],
  ['balance_pre_settled', '前快照已结算'],
  ['balance_post_settled', '后快照已结算'],
  ['balance_before', '请求前余额读数'],
  ['balance_after', '请求后余额读数'],
  ['spend_delta', '本轮实际扣费（实测；单位校准采信后为估算）'],
  ['money_check_state', '金额核验状态'],
  ['money_verified', '金额已核验'],
  ['absolute_reconciliation', '与外部硬证据比对'],
  ['expected_cost_usd_declared', '按价目应扣（USD，估算）'],
  ['expected_cost_usd_basis', '费用来源（public_usd / quota）'],
  ['expected_quota_declared', '按价目应扣（quota，估算）'],
  ['cost_is_upper_bound', '应扣额为上界'],
  ['cost_is_lower_bound', '应扣额为下界'],
  ['calibration_confidence', '单位校准置信度（推断 high/low）'],
  ['reference_source', '令牌基准来源'],
  ['reference_verified', '令牌基准已核验'],
  ['quota_to_usd', 'quota→USD 系数'],
  ['quota_per_unit', '站点 quota 每美元'],
  ['quota_per_unit_synthetic', 'quota 换算使用标准基价（1=是）'],
  ['declared_ratio_synthetic', '公示倍率为公开价表反推（1=是）'],
  ['expected_cost', '本轮应扣（按你填的单价，估算）'],
  ['price_input', '录入输入价（与公示同单位/百万）'],
  ['price_output', '录入输出价（与公示同单位/百万）'],
  ['price_cached_read', '录入缓存读价（与公示同单位/百万）'],
  ['price_threshold', '阶梯阈值（tokens）'],
  ['price_input2', '二档输入价（与公示同单位/百万）'],
  ['price_output2', '二档输出价（与公示同单位/百万）'],
  ['price_cached_read2', '二档缓存读价（与公示同单位/百万）'],
  ['echo_model_mismatch', '回显模型不一致'],
  ['requests', '请求数'],
  ['details_reported_count', '已回报样本数'],
  ['usage_missing', 'usage 缺失数'],
  ['usage_inconsistent', 'usage 不一致数'],
  ['constant_usage', '恒定 usage 数'],
  ['completion_ratio_en', '输出侧倍率（英文题）'],
  ['completion_ratio_zh', '输出侧倍率（中文题）'],
  ['completion_pair_samples_en', '输出侧配对样本（英）'],
  ['completion_pair_samples_zh', '输出侧配对样本（中）'],
  ['slope_en', '输入 token 斜率（英）'],
  ['slope_zh', '输入 token 斜率（中）'],
  ['r2_en', '回归 R²（英）'],
  ['r2_zh', '回归 R²（中）'],
  ['evidence_level', '证据等级（shape-only / absolute）'],
];

/** 大型内部指标：完整倍率表/抓价命中的 JSON 串（数百模型时能刷屏），与 src/report/markdown.ts HIDDEN_METRICS 同口径。 */
function isHiddenMetricKey(key) {
  return key.endsWith('_json');
}

/**
 * 抓价页与端点同源校验（pricing-scrape 内 fail-closed 的提前拦截）：
 * 绝对 URL 必须与 baseUrl 同 origin；相对路径天然同源。baseUrl 本身非法时交回 CLI 报错（不抢答）。
 * @returns {string | null} 错误文案；null 表示无问题。
 */
function declaredPricePageOriginIssue(baseUrl, page) {
  if (!/^https?:\/\//i.test(page)) return null;
  let base;
  let target;
  try {
    base = new URL(baseUrl);
    target = new URL(page);
  } catch {
    return null;
  }
  if (base.origin === target.origin) return null;
  return `--declared-price-page 必须与 --base-url 同源（抓价绝不跨域）：端点 ${base.origin}，抓价页 ${target.origin}。示例：--declared-price-page /pricing（同源路径）`;
}

/** 单探针的非空指标条目；metrics 缺失或非对象（老报告/手改文件）降级为空数组，不整体失败。 */
function metricEntries(record) {
  const metrics = record?.metrics;
  if (metrics === null || typeof metrics !== 'object' || Array.isArray(metrics)) return [];
  return Object.entries(metrics).filter(([key, value]) => value !== null && value !== undefined && !isHiddenMetricKey(key));
}

/** 指标值文本：布尔读作是/否；对象走 JSON；超长字符串截断（完整值仍在下方指标明细表里）。 */
function metricText(value) {
  if (typeof value === 'boolean') return value ? '是' : '否';
  let text;
  if (value !== null && typeof value === 'object') {
    try {
      text = JSON.stringify(value);
    } catch {
      text = '[无法序列化的值]';
    }
  } else {
    text = String(value);
  }
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

/** N/A 原因短语：与 src/probes/billing.ts 的口径标签决策表同名同义，同一缺口只用一种说法。 */
const BILLING_NA_REASON = {
  balanceUnavailable: '该站没有可用的余额接口',
  balanceUnstable: '余额读数不稳定',
  windowUnattributable: '窗口内扣费混入其他消费，无法归因到本次测试',
  balanceNotRead: '实际扣款未核对（默认不读余额）',
  quotaPerUnit: '站点未公示 quota_per_unit 换算率',
  publicRate: '站点未公示价格',
  modelNotListed: '价目表中没有这个模型',
  claimedPrice: '缺录入价或站点现价',
};

/** 某个指标取值为 N/A 时的原因；无法归因到枚举缺口时返回 null（不编造原因）。 */
function billingNaReason(key, byKey) {
  const flag = (metricKey) => String(byKey.get(metricKey) ?? '');
  const balanceReason = () => {
    if (byKey.has('balance_probe_reason')) return BILLING_NA_REASON.balanceUnavailable;
    if (flag('ratio_contaminated') === '1') return BILLING_NA_REASON.windowUnattributable;
    if (flag('balance_pre_settled') === '0' || flag('balance_post_settled') === '0') return BILLING_NA_REASON.balanceUnstable;
    if (!byKey.has('balance_endpoint') && !byKey.has('balance_before') && !byKey.has('balance_after')) {
      return BILLING_NA_REASON.balanceNotRead;
    }
    return BILLING_NA_REASON.windowUnattributable;
  };
  if (key === 'measured_ratio') return balanceReason();
  if (key === 'claimed_price_ratio_input' || key === 'claimed_price_ratio_output') {
    if (flag('quota_per_unit_synthetic') === '1') return BILLING_NA_REASON.quotaPerUnit;
    if (flag('public_price_state') === 'failed' || flag('pricing_state') === 'failed') return BILLING_NA_REASON.publicRate;
    return BILLING_NA_REASON.claimedPrice;
  }
  if (key === 'expected_cost_usd_declared' || key === 'expected_quota_declared' || key === 'expected_cost') {
    if (flag('quota_per_unit_synthetic') === '1') return BILLING_NA_REASON.quotaPerUnit;
    if (flag('public_price_state') === 'failed' || flag('pricing_state') === 'failed') return BILLING_NA_REASON.publicRate;
  }
  return null;
}

/** 计费探针的「倍率与金额」摘要块行；无对应指标（或报告里没有 billing 探针）返回空数组。 */
function renderBillingMetrics(record) {
  const entries = metricEntries(record);
  if (entries.length === 0) return [];
  const byKey = new Map(entries);
  const cells = [];
  for (const [key, label] of BILLING_METRIC_LABELS) {
    if (!byKey.has(key)) continue;
    const raw = metricText(byKey.get(key));
    const naReason = raw === 'N/A' ? billingNaReason(key, byKey) : null;
    const value = naReason === null ? raw : `${raw}（${naReason}）`;
    cells.push(`          <div><span class="k">${escapeHtml(label)}</span><span class="v">${escapeHtml(value)}</span></div>`);
  }
  if (cells.length === 0) return [];
  return ['  <h4>计费与倍率</h4>', '  <div class="metrics-grid">', ...cells, '  </div>'];
}

/** 单探针的完整指标明细（默认折叠）：避免把 40+ 项内部指标直接糊在评分卡上。 */
function renderMetricsDetail(record, label) {
  const entries = metricEntries(record);
  if (entries.length === 0) return [];
  const rows = entries.map(
    ([key, value]) => `            <tr><td>${escapeHtml(key)}</td><td>${escapeHtml(metricText(value))}</td></tr>`,
  );
  return [
    `  <details class="metrics-detail"><summary>${escapeHtml(label)} 指标明细（${entries.length} 项）</summary>`,
    '  <table class="probes">',
    '    <thead><tr><th>指标</th><th>值</th></tr></thead>',
    '    <tbody>',
    ...rows,
    '    </tbody>',
    '  </table>',
    '  </details>',
  ];
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

  // 评分卡行优先用 scores（聚合层实锤封顶后的分项分，与 CLI/Markdown/HTML 报告一致）；
  // scores 为空（老报告）才回退 outcomes 原始分。outcomes 中未被 scores 覆盖的观测项
  // （如 decoy）按原样追加，保持「详情可见、不计分」口径。
  const scoreEntries = Array.isArray(data.scores)
    ? data.scores.filter((raw) => raw !== null && typeof raw === 'object' && !Array.isArray(raw))
    : [];
  const scoreIds = new Set(scoreEntries.map((entry) => fieldText(entry, 'id')));
  const scoreRows = (
    scoreEntries.length > 0
      ? [
          ...scoreEntries,
          ...data.outcomes.filter(
            (raw) => raw !== null && typeof raw === 'object' && !Array.isArray(raw) && !scoreIds.has(fieldText(raw, 'id')),
          ),
        ]
      : data.outcomes
  ).map((record) => {
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
  const overallLabel = OVERALL_LABEL[overall] ?? null;
  const overallBadge = overallLabel === null ? '' : `<span class="badge badge-${badgeClass(overall)}">${escapeHtml(overallLabel)}</span>`;

  const billingOutcome = data.outcomes.find((raw) => fieldText(raw, 'id') === 'billing');
  const billingBlock = renderBillingMetrics(billingOutcome);
  const metricDetails = data.outcomes.flatMap((raw) => renderMetricsDetail(raw, fieldText(raw, 'id') ?? '（缺失）'));

  const html = [
    '<section class="scorecard">',
    `  <div class="scorecard-head"><span class="total">可信度总分：${escapeHtml(total)}</span>${overallBadge}</div>`,
    '  <table class="probes">',
    '    <thead><tr><th>探针</th><th>结论</th><th>得分</th><th>摘要</th></tr></thead>',
    '    <tbody>',
    ...scoreRows,
    '    </tbody>',
    '  </table>',
    ...billingBlock,
    ...metricDetails,
    `  <h4>findings（${findings.length}）</h4>`,
    ...(findings.length > 0 ? ['  <ul class="findings">', ...findings, '  </ul>'] : ['  <p class="placeholder">无 findings。</p>']),
    `  <h4>notes（${notes.length}）</h4>`,
    ...(notes.length > 0 ? ['  <ul class="notes">', ...notes, '  </ul>'] : ['  <p class="placeholder">无 notes。</p>']),
    '</section>',
  ].join('\n');
  return { html, error: null };
}

// ---------------------------------------------------------------------------
// 密钥脱敏：纯函数（Node 可导入，无 DOM 依赖）
// ---------------------------------------------------------------------------

/** 从展示文本中抹掉命中的密钥（控制台错误回显防泄露；另对 sk- 形态做兜底打码）。 */
export function scrubSecrets(text, secrets) {
  let out = String(text);
  for (const secret of Array.isArray(secrets) ? secrets : []) {
    if (typeof secret !== 'string' || secret.length < 6) continue;
    out = out.split(secret).join('***');
  }
  return out.replace(/sk-[A-Za-z0-9_-]{12,}/g, 'sk-***');
}

// ---------------------------------------------------------------------------
// 价格编辑与费用显示：纯函数（Node 可导入，无 DOM 依赖）
// ---------------------------------------------------------------------------

/** 价格字段中文名（报错文案用）。 */
const PRICE_FIELD_LABELS = {
  input: '输入单价',
  output: '输出单价',
  cachedRead: '缓存读单价',
  threshold: '阶梯阈值',
  input2: '二档输入单价',
  output2: '二档输出单价',
  cachedRead2: '二档缓存读单价',
};

/**
 * 价格字段解析：空串 → null（未填）；合法非负有限数 → number；其余 → undefined（非法，调用方报错）。
 * integer=true 用于阶梯阈值：必须为正整数。
 */
function parsePriceField(raw, integer = false) {
  const text = String(raw ?? '').trim();
  if (text === '') return null;
  if (integer) {
    return /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) && Number(text) > 0 ? Number(text) : undefined;
  }
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(text)) return undefined;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * 汇总价格编辑行为服务端 modelPrices 请求体（客户端先验，服务端仍会按同口径复验并给出精确报错）。
 * 别名全空的行跳过；输入/输出必须成对（0 = 免费模型合法）；阶梯「阈值+二档输入+二档输出」成对或缺省。
 * @returns {{ modelPrices: Record<string, object>, error: string | null }}
 */
export function buildModelPrices(entries) {
  const modelPrices = {};
  const list = Array.isArray(entries) ? entries : [];
  for (const entry of list) {
    const alias = String(entry?.alias ?? '').trim();
    const raw = {
      input: entry?.input,
      output: entry?.output,
      cachedRead: entry?.cachedRead,
      threshold: entry?.threshold,
      input2: entry?.input2,
      output2: entry?.output2,
      cachedRead2: entry?.cachedRead2,
    };
    const allBlank = Object.values(raw).every((value) => String(value ?? '').trim() === '');
    if (alias === '') {
      if (allBlank) continue;
      return { modelPrices, error: '价格行缺少模型别名：请先在模型清单中填写别名（或清空该行价格）。' };
    }
    if (allBlank) continue;
    const parsed = {
      input: parsePriceField(raw.input),
      output: parsePriceField(raw.output),
      cachedRead: parsePriceField(raw.cachedRead),
      threshold: parsePriceField(raw.threshold, true),
      input2: parsePriceField(raw.input2),
      output2: parsePriceField(raw.output2),
      cachedRead2: parsePriceField(raw.cachedRead2),
    };
    for (const [field, value] of Object.entries(parsed)) {
      if (value === undefined) {
        return {
          modelPrices,
          error: `模型 ${JSON.stringify(alias)} 的「${PRICE_FIELD_LABELS[field]}」必须是${field === 'threshold' ? '正整数' : '不小于 0 的数字'}。示例：输入 2.5、输出 10、缓存读 0.5、阶梯阈值 1000000。`,
        };
      }
    }
    if (parsed.input === null || parsed.output === null) {
      return {
        modelPrices,
        error: `模型 ${JSON.stringify(alias)}：输入与输出单价必须成对填写（缓存读可留空 = 按输入价计；只想统计 token 请全部留空）。`,
      };
    }
    const tierPresent = parsed.threshold !== null || parsed.input2 !== null || parsed.output2 !== null || parsed.cachedRead2 !== null;
    if (tierPresent && (parsed.threshold === null || parsed.input2 === null || parsed.output2 === null)) {
      return {
        modelPrices,
        error: `模型 ${JSON.stringify(alias)}：阶梯价需同时填写「阶梯阈值 + 二档输入 + 二档输出」（二档缓存读可留空 = 按二档输入价计）。`,
      };
    }
    modelPrices[alias] = {
      input: parsed.input,
      output: parsed.output,
      ...(parsed.cachedRead !== null ? { cachedRead: parsed.cachedRead } : {}),
      ...(tierPresent ? { threshold: parsed.threshold, input2: parsed.input2, output2: parsed.output2 } : {}),
      ...(tierPresent && parsed.cachedRead2 !== null ? { cachedRead2: parsed.cachedRead2 } : {}),
    };
  }
  return { modelPrices, error: null };
}

/**
 * 费用显示：未配置价格（null/undefined/非法）→ '—'（绝不显示误导性的 $0）；0 → '$0'；其余按量级取小数位。
 */
export function formatCostUsd(value) {
  if (value === null || value === undefined) return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  if (number === 0) return '$0';
  if (Math.abs(number) >= 1) return `$${number.toFixed(2)}`;
  if (Math.abs(number) >= 0.01) return `$${number.toFixed(4)}`;
  return `$${number.toFixed(6)}`;
}

/** 运行日志逐行着色：阶段/请求/结果行使用不同的 class，便于在长日志中定位阶段边界。 */
export function classifyLogLine(text) {
  const phaseMatch = text.match(/\[RUN\]\s*阶段\s+([a-z-]+)/i);
  if (phaseMatch !== null) {
    const phase = phaseMatch[1].toLowerCase();
    const done = /完成/.test(text);
    return `log-line log-line-phase-${phase} ${done ? 'log-line-phase-done' : 'log-line-phase-start'}`;
  }
  const requestMatch = text.match(/\[RUN\]\s*([a-z-]+)\s+请求\s+#\d+/i);
  if (requestMatch !== null) {
    return `log-line log-line-request log-line-phase-${requestMatch[1].toLowerCase()}`;
  }
  // 显式状态标签优先于正文关键词：`[PASS] … 未见异常` 里的「异常」是正常结论，
  // 不能把整行染成失败红；只有无标签且确实含异常/告警的行才走关键词兜底。
  if (/\[(FAIL|ERROR)\]/i.test(text)) return 'log-line log-line-fail';
  if (/\[WARN\]/i.test(text)) return 'log-line log-line-warn';
  if (/\[PASS\]/i.test(text)) return 'log-line log-line-pass';
  if (/\[UNKNOWN\]|\[N\/A\]/i.test(text)) return 'log-line log-line-unknown';
  if (/\[INFO\]/i.test(text)) return 'log-line log-line-info';
  if (/异常|告警|实锤/i.test(text)) return 'log-line log-line-fail';
  return 'log-line';
}

/**
 * 归一化页面注入的会话 token：必须是 48 位小写十六进制（服务端 randomBytes(24) 的形态）。
 * 占位符未替换（页面来自静态副本/缓存）、空串、形态不符 → null（= 未连上本地服务）。
 */
export function normalizeInjectedToken(raw) {
  return typeof raw === 'string' && /^[0-9a-f]{48}$/.test(raw) ? raw : null;
}

/**
 * 从控制台首页 HTML 中提取服务端当前注入的会话 token。
 * 服务重启（或 token 文件被替换）后，页面可用它自愈：重新取一次首页 → 拿到新 token → 重试原请求。
 * 取不到（页面不是本服务渲染的）返回 null。
 */
export function extractTokenFromHtml(html) {
  if (typeof html !== 'string') return null;
  const match = /window\.MX_TOKEN\s*=\s*'([0-9a-f]{48})'\s*;/.exec(html);
  return match === null ? null : match[1];
}

/**
 * 判断响应是否为「会话 token 不可用」（缺 token / token 与服务端不一致）。
 * 命中即允许客户端重取一次 token 并重试一次；其余 403（如 Host/Origin 校验失败）不得重试。
 */
export function isTokenAuthError(status, data) {
  if (status !== 403) return false;
  const code = data !== null && typeof data === 'object' ? String(data.code ?? '') : '';
  if (code === 'token_stale' || code === 'token_missing') return true;
  // 兜底：旧版服务端没有 code 字段，只按文案判断（仅限 token 相关文案）。
  const error = data !== null && typeof data === 'object' ? String(data.error ?? '') : '';
  return /x-model-xray-token/i.test(error);
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
  //    token 可变（let）：服务重启后旧页面会通过 resyncToken() 自愈，无需用户手动刷新。
  let token = normalizeInjectedToken(typeof window !== 'undefined' ? window.MX_TOKEN : null);
  if (token === null) byId('offline-banner')?.removeAttribute('hidden');

  // 网络不可达（fetch 抛错）时的诚实回应：不假装成功，把原因原样告诉用户。
  const NETWORK_ERROR = {
    status: 0,
    ok: false,
    data: {
      error: '本地服务不可达：请确认 npm run ui 仍在运行（若刚重启，请刷新本页面后重试）。',
      code: 'network_error',
    },
  };

  /**
   * 重新取一次服务端当前的会话 token（GET / 首页会带上注入后的 token）。
   * 服务重启 / token 文件被替换后，页面据此自愈：拿到新 token 即可继续调用 API。
   * @returns {Promise<boolean>} 是否成功换到新 token。
   */
  async function resyncToken() {
    try {
      const res = await fetch('/', { cache: 'no-store' });
      if (!res.ok) return false;
      const html = await res.text();
      const next = extractTokenFromHtml(html);
      if (next === null || next === token) return false;
      token = next;
      byId('offline-banner')?.setAttribute('hidden', '');
      return true;
    } catch {
      return false;
    }
  }

  async function api(path, options = {}) {
    const send = async (useToken) => {
      const headers = { ...(options.headers ?? {}) };
      if (options.body !== undefined) headers['content-type'] = 'application/json';
      if (useToken !== null) headers['x-model-xray-token'] = useToken;
      let res;
      try {
        res = await fetch(path, { method: options.method ?? 'GET', headers, body: options.body });
      } catch {
        return NETWORK_ERROR;
      }
      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      return { status: res.status, ok: res.ok, data };
    };
    const first = await send(token);
    if (!isTokenAuthError(first.status, first.data)) return first;
    // token 失效：换一次 token 重试。服务端在鉴权失败前不做任何副作用（闸门先于读体与路由），
    // 故重试是安全的（不会重复写入 key / 重复清库）。
    if (!(await resyncToken())) return first;
    return send(token);
  }
  const isOffline = () => token === null;

  // —— 三 tab 切换 ——
  const tabs = { test: byId('tab-test'), gateway: byId('tab-gateway'), reports: byId('tab-reports') };
  const panels = { test: byId('panel-test'), gateway: byId('panel-gateway'), reports: byId('panel-reports') };
  function selectTab(which) {
    for (const key of ['test', 'gateway', 'reports']) {
      tabs[key]?.setAttribute('aria-selected', key === which ? 'true' : 'false');
      if (panels[key]) panels[key].hidden = key !== which;
    }
  }
  tabs.test?.addEventListener('click', () => selectTab('test'));
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
    // 页面没有可用 token（占位符未替换/服务已停）：先自愈一次（重取首页 token），
    // 仍拿不到就如实告知——绝不静默无响应（用户点了却不知道发生了什么）。
    if (isOffline() && !(await resyncToken())) {
      if (keyState) keyState.textContent = '保存失败：本地服务不可达：请确认 npm run ui 仍在运行（若刚重启，请刷新本页面后重试）。';
      return;
    }
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
    if (isOffline() && !(await resyncToken())) {
      if (keyState) keyState.textContent = '清除失败：本地服务不可达：请确认 npm run ui 仍在运行。';
      return;
    }
    const res = await api('/api/key/clear', { method: 'POST', body: '{}' });
    if (res.ok) renderKeyStatus(res.data);
    else if (keyState) keyState.textContent = `清除失败：${String(res.data?.error ?? res.status)}`;
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
      priceCachedRead: inputValue('f-price-cached-read'),
      priceThreshold: inputValue('f-price-threshold'),
      priceInput2: inputValue('f-price-input2'),
      priceOutput2: inputValue('f-price-output2'),
      priceCachedRead2: inputValue('f-price-cached-read2'),
      expectModelRatio: inputValue('f-expect-model-ratio'),
      expectCompletionRatio: inputValue('f-expect-completion-ratio'),
      quotaPerUsd: inputValue('f-quota-per-usd'),
      declaredPricePage: inputValue('f-declared-price-page'),
      readBalance: checkedValue('f-read-balance'),
      seed: inputValue('f-seed'),
      timeout: inputValue('f-timeout'),
      httpRetries: inputValue('f-http-retries'),
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
    'f-price-cached-read', 'f-price-threshold', 'f-price-input2', 'f-price-output2', 'f-price-cached-read2',
    'f-expect-model-ratio', 'f-expect-completion-ratio', 'f-quota-per-usd', 'f-declared-price-page',
    'f-seed', 'f-timeout', 'f-http-retries', 'f-out', 'f-baseline',
  ]) {
    byId(id)?.addEventListener('input', updateCommandPreview);
  }
  for (const id of ['f-expect-vision', 'f-expect-tool', 'f-expect-thinking', 'f-deep', 'f-dry-run', 'f-read-balance']) {
    byId(id)?.addEventListener('change', updateCommandPreview);
  }
  updateCommandPreview();

  const runError = byId('run-error');
  const runBanner = byId('run-banner');
  const runLog = byId('run-log');
  const btnRun = byId('btn-run');
  const runButtonLabel = byId('run-button-label');
  const runStatus = byId('run-status');
  const runStatusText = byId('run-status-text');
  let logPollTimer = null;
  let logPollBusy = false;
  let runStatusTimer = null;
  let runStartedAt = null;
  let lastLogAt = null;
  let currentPhase = '';
  let runTimeoutSec = 60;

  function appendLogLines(pre, lines) {
    if (!Array.isArray(lines) || lines.length === 0) return;
    const texts = lines.map((line) => (typeof line === 'object' && line !== null ? String(line.text ?? '') : String(line)));
    lastLogAt = Date.now();
    for (const text of texts) {
      const phaseMatch = text.match(/\[RUN\]\s*阶段\s+([a-z-]+)/i) ?? text.match(/\[RUN\]\s*([a-z-]+)\s+请求\s+#\d+/i);
      if (phaseMatch !== null) currentPhase = phaseMatch[1];
    }
    if (pre === null) return;
    if (pre.classList.contains('placeholder')) {
      pre.classList.remove('placeholder');
      pre.textContent = '';
    }
    for (const text of texts) {
      const div = document.createElement('div');
      div.className = classifyLogLine(text);
      div.textContent = text;
      pre.appendChild(div);
    }
    pre.scrollTop = pre.scrollHeight;
  }
  function formatElapsed(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }
  function updateRunStatus() {
    if (runStatusText === null) return;
    let text = `检测中… 已用 ${formatElapsed(Date.now() - (runStartedAt ?? Date.now()))}`;
    if (currentPhase !== '') text += ` · 阶段 ${currentPhase}`;
    if (lastLogAt === null) {
      text += ' · 等待首个输出';
    } else {
      const idleSec = Math.max(0, Math.floor((Date.now() - lastLogAt) / 1000));
      text += ` · 最近输出 ${idleSec}s 前`;
      if (idleSec >= 30) {
        text +=
          idleSec >= runTimeoutSec + 5
            ? '（已超过单请求上限，可能在重试或收尾）'
            : `（长请求等待上游响应，单请求上限 ${runTimeoutSec}s）`;
      }
    }
    runStatusText.textContent = text;
  }
  function startRunStatus(timeoutSec) {
    runStartedAt = Date.now();
    lastLogAt = null;
    currentPhase = '';
    runTimeoutSec = Number.isFinite(timeoutSec) && timeoutSec > 0 ? Math.round(timeoutSec) : 60;
    if (runStatus !== null) runStatus.removeAttribute('hidden');
    if (runButtonLabel !== null) runButtonLabel.textContent = '检测中…';
    updateRunStatus();
    if (runStatusTimer !== null) clearInterval(runStatusTimer);
    runStatusTimer = setInterval(updateRunStatus, 500);
  }
  function stopRunStatus() {
    if (runStatusTimer !== null) {
      clearInterval(runStatusTimer);
      runStatusTimer = null;
    }
    if (runStatus !== null) runStatus.setAttribute('hidden', '');
    if (runButtonLabel !== null) runButtonLabel.textContent = '开始检测';
  }
  function showRunBanner(kind, title, detail = '') {
    if (runBanner === null) return;
    runBanner.className = `banner ${kind === 'fail' ? 'banner-fail' : kind === 'warn' ? 'banner-warn' : kind === 'pass' ? 'banner-pass' : 'banner-offline'}`;
    runBanner.textContent = detail === '' ? title : `${title} — ${detail}`;
    runBanner.removeAttribute('hidden');
  }
  async function renderReportResult(reportPaths, exitCode, jobStatus, dryRun = false) {
    const wrap = byId('report-result');
    const links = byId('report-links');
    const out = byId('report-out');
    if (wrap === null) return;
    const isDryRun = jobStatus === 'done' && dryRun === true;
    if (reportPaths === null) {
      wrap.setAttribute('hidden', '');
      if (isDryRun) {
        showRunBanner('pass', '预演完成：未发送任何请求，未生成报告（真实跑批才会产生报告文件）');
      } else if (jobStatus === 'error') {
        showRunBanner('fail', '⚠ 任务异常终止（子进程失败）：请查看日志');
      } else if (exitCode === 1) {
        showRunBanner('fail', '⚠ 检测不通过（exit 1）：请查看日志与报告');
      } else if (exitCode === 2) {
        showRunBanner('fail', '任务出错或未得出结论（exit 2）：请核对参数/key/端点后重试，详见日志');
      }
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
    if (isDryRun) showRunBanner('pass', '预演完成：未发送任何请求（报告文件见上方链接）');
    else if (jobStatus === 'error') showRunBanner('fail', '⚠ 任务异常终止（子进程失败）：请查看日志');
    else if (overall === 'fail') showRunBanner('fail', '⚠ 检测不通过：计费或身份维度存在实锤（乱收费/明显换壳），请查看下方评分卡与 findings');
    else if (overall === 'warn') showRunBanner('warn', '本轮完成：未触发「不通过」（无乱收费/换壳实锤）；可信度总分与分项明细见下方评分卡');
    else if (overall === 'pass') showRunBanner('pass', '✔ 本轮完成：未发现乱收费/换壳实锤，可信度总分与分项明细见下方评分卡');
    else if (exitCode === 1) showRunBanner('fail', '⚠ 检测不通过（exit 1）：请查看日志与报告');
    else if (exitCode === 2) showRunBanner('fail', '任务出错或未得出结论（exit 2）：请核对参数/key/端点后重试，详见日志');
  }
  function stopLogPoll() {
    if (logPollTimer !== null) {
      clearInterval(logPollTimer);
      logPollTimer = null;
    }
    logPollBusy = false;
    stopRunStatus();
    if (btnRun) btnRun.disabled = false;
  }
  function pollJob(id) {
    let after = 0;
    logPollTimer = setInterval(async () => {
      if (logPollBusy) return;
      logPollBusy = true;
      try {
        const res = await api(`/api/jobs/${id}/log?after=${after}`);
        if (!res.ok) {
          stopLogPoll();
          showRunBanner('fail', '日志读取失败', String(res.data?.error ?? res.status));
          return;
        }
        const log = res.data;
        if (typeof log.startedAt === 'number' && Number.isFinite(log.startedAt)) {
          runStartedAt = log.startedAt;
        }
        appendLogLines(runLog, log.lines);
        after = log.next;
        if (log.status === 'running') return;
        stopLogPoll();
        const detail = await api(`/api/jobs/${id}`);
        const exitCode = detail.ok ? detail.data.exitCode : null;
        const reportPaths = detail.ok ? detail.data.reportPaths : null;
        const dryRun = log.dryRun === true || (detail.ok && detail.data.dryRun === true);
        await renderReportResult(reportPaths, exitCode, log.status, dryRun);
      } catch (error) {
        stopLogPoll();
        showRunBanner('fail', '轮询中断', error instanceof Error ? error.message : String(error));
      } finally {
        logPollBusy = false;
      }
    }, 800);
  }
  btnRun?.addEventListener('click', async () => {
    // 离线（页面没有可用 token）：先自愈一次（重取首页 token），仍不可用才如实报错。
    if (isOffline() && !(await resyncToken())) {
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
    // 清掉可能残留的旧轮询/状态（正常 UI 下按钮禁用，此处只防御脚本或异常路径的重复启动）
    stopLogPoll();
    if (runError) runError.setAttribute('hidden', '');
    if (runBanner) runBanner.setAttribute('hidden', '');
    if (runLog) {
      runLog.classList.remove('placeholder');
      runLog.textContent = '';
    }
    byId('report-result')?.setAttribute('hidden', '');
    btnRun.disabled = true;
    startRunStatus(Number(form.timeout));
    // 输入即用：key 栏有值则随请求提交（服务端持久化到本会话），随后清空输入并回读真实状态；响应不含 key 值
    const typedKey = inputValue('f-key').trim();
    const payload = typedKey === '' ? form : { ...form, key: typedKey };
    let res;
    try {
      res = await api('/api/test', { method: 'POST', body: JSON.stringify(payload) });
    } catch (error) {
      stopRunStatus();
      btnRun.disabled = false;
      if (runError) {
        runError.textContent = error instanceof Error ? error.message : String(error);
        runError.removeAttribute('hidden');
      }
      return;
    }
    if (typedKey !== '') {
      if (byId('f-key')) byId('f-key').value = '';
      await loadKeyStatus();
    }
    if (!res.ok) {
      stopRunStatus();
      btnRun.disabled = false;
      if (runError) {
        runError.textContent = String(res.data?.error ?? `HTTP ${res.status}`);
        runError.removeAttribute('hidden');
      }
      return;
    }
    pollJob(res.data.id);
  });

  // —— Tab ②：聚合与实时监控（渠道 + 模型价格；上游凭证仅驻留本机服务内存） ——
  const gatewayError = byId('gateway-error');
  const channelForm = byId('channel-form');
  const channelList = byId('channel-list');
  const gatewayState = byId('gateway-status');
  const gatewayBaseUrl = byId('gateway-base-url');
  const gatewayKeyState = byId('gateway-client-key-state');
  const gatewayClientKey = byId('f-gateway-client-key');
  const gatewayCopyUrl = byId('gateway-copy-url');
  const gatewayCopyRoot = byId('gateway-copy-root');
  const modelRows = byId('channel-model-rows');
  const probeStatus = byId('channel-probe-status');
  const ledgerBanner = byId('ledger-degraded-banner');
  /** 渠道 id → 渠道名（用量表的渠道列用名称展示，缺失时兜底 id）。 */
  const channelLabels = new Map();
  let gatewayRunning = false;

  // 错误来源：后台轮询（refresh）的错误在恢复时自动清除；用户动作的错误不得被并发轮询静默清掉
  // （实测竞态：快速重复点击「启动」时，首次启动成功后的 refreshGateway 完成会清掉 409 提示）。
  let gatewayErrorSource = null;
  function showGatewayError(message = '', source = 'action') {
    if (gatewayError === null) return;
    gatewayError.textContent = message;
    gatewayError.toggleAttribute('hidden', message === '');
    gatewayErrorSource = message === '' ? null : source;
  }
  function setProbeStatus(message = '', isError = false) {
    if (probeStatus === null) return;
    probeStatus.textContent = message;
    probeStatus.classList.toggle('probe-error', isError);
    probeStatus.toggleAttribute('hidden', message === '');
  }
  /** 构建一行「上游模型名 → 对外别名」；别名未被手动改过时跟随上游名。 */
  function buildModelRow(upstream = '', alias = '') {
    const row = document.createElement('div');
    row.className = 'model-row';
    const upstreamInput = document.createElement('input');
    upstreamInput.type = 'text';
    upstreamInput.dataset.role = 'upstream';
    upstreamInput.placeholder = '上游模型名，例如 gpt-4o';
    upstreamInput.value = upstream;
    const arrow = document.createElement('span');
    arrow.className = 'model-arrow';
    arrow.textContent = '→';
    const aliasInput = document.createElement('input');
    aliasInput.type = 'text';
    aliasInput.dataset.role = 'alias';
    aliasInput.placeholder = '对外别名（默认同名）';
    aliasInput.value = alias;
    if (alias !== '' && alias !== upstream) aliasInput.dataset.touched = 'true';
    aliasInput.addEventListener('input', () => { aliasInput.dataset.touched = 'true'; });
    upstreamInput.addEventListener('input', () => {
      if (aliasInput.dataset.touched !== 'true') aliasInput.value = upstreamInput.value.trim();
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'secondary';
    remove.textContent = '移除';
    remove.addEventListener('click', () => row.remove());
    row.append(upstreamInput, arrow, aliasInput, remove);
    return row;
  }
  /** 汇总模型行：{ models, modelMap, error }；两栏全空的行跳过，别名重复/单栏缺失在此拦下。 */
  function collectModelRows() {
    const models = [];
    const modelMap = {};
    const seen = new Set();
    if (modelRows === null) return { models, modelMap, error: '模型清单容器缺失。' };
    for (const row of modelRows.querySelectorAll('.model-row')) {
      const upstream = row.querySelector('input[data-role="upstream"]')?.value.trim() ?? '';
      const alias = row.querySelector('input[data-role="alias"]')?.value.trim() ?? '';
      if (upstream === '' && alias === '') continue;
      if (upstream === '' || alias === '') {
        return { models, modelMap, error: `模型行不完整：上游名 ${JSON.stringify(upstream)}、别名 ${JSON.stringify(alias)}。两栏都需填写（或点「移除」删掉该行）。` };
      }
      if (seen.has(alias)) return { models, modelMap, error: `别名重复：${JSON.stringify(alias)}。每个别名只能出现一次。` };
      seen.add(alias);
      models.push(alias);
      if (alias !== upstream) modelMap[alias] = upstream;
    }
    if (models.length === 0) return { models, modelMap, error: '模型清单为空：请「一键获取模型」或「手动添加一行」。' };
    return { models, modelMap, error: null };
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
    const protocolSelect = byId('f-channel-protocol');
    if (protocolSelect instanceof HTMLSelectElement) {
      const protocol = editing && typeof channel.protocol === 'string' ? channel.protocol : 'unified';
      protocolSelect.value = ['unified', 'openai', 'anthropic'].includes(protocol) ? protocol : 'unified';
    }
    const privateCheck = byId('f-channel-private');
    if (privateCheck instanceof HTMLInputElement) {
      privateCheck.checked = editing && channel.allowPrivateUpstream === true;
    }
    if (modelRows !== null) {
      modelRows.textContent = '';
      const modelMap = editing && channel.modelMap !== null && typeof channel.modelMap === 'object' ? channel.modelMap : {};
      const models = editing && Array.isArray(channel.models) ? channel.models : [];
      for (const alias of models) {
        modelRows.appendChild(buildModelRow(typeof modelMap[alias] === 'string' ? modelMap[alias] : alias, String(alias)));
      }
      if (!editing) modelRows.appendChild(buildModelRow('', ''));
    }
    const storedPrices = editing && channel.modelPrices !== null && typeof channel.modelPrices === 'object' ? channel.modelPrices : null;
    // reset() 只清空价格输入的值、不清理行元素：先清行，避免「空草稿快照」掩盖 seed 导致编辑回填空白（保存还会静默清价）。
    if (priceRows !== null) priceRows.textContent = '';
    syncPriceRows(storedPrices, true);
    if (priceDetails !== null) priceDetails.open = storedPrices !== null && Object.keys(storedPrices).length > 0;
    setProbeStatus('');
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
      const protocolLabel = channel.protocol === 'unified'
        ? '统一'
        : channel.protocol === 'anthropic' || channel.protocol === 'openai' ? channel.protocol : '';
      const protocolTag = protocolLabel === ''
        ? ''
        : `<span class="channel-model channel-tag-protocol">${protocolLabel}</span>`;
      models.innerHTML = protocolTag + channelModelTags(channel);
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
        showGatewayError(String(problem.data?.error ?? `HTTP ${problem.status}`), 'refresh');
        return;
      }
      const status = statusResponse.data;
      gatewayRunning = status?.running === true;
      // 账本降级横幅（页面顶部）：写入失败必须显式披露数据缺口，绝不静默；转发不受影响（fail-open）
      const degraded = gatewayRunning && status !== null && typeof status === 'object' ? status.degraded : null;
      const writeErrors = Number(degraded?.writeErrors ?? 0);
      const recovered = Number(degraded?.recovered ?? 0);
      const showDegraded = gatewayRunning && (degraded?.degraded === true || writeErrors > 0);
      if (ledgerBanner) {
        const bannerParts = [];
        if (showDegraded) bannerParts.push(`账本降级：写入失败 ${writeErrors} 次（数据缺口，统计不含被丢弃请求）`);
        if (recovered > 0) bannerParts.push(`账本恢复：已自动补结 ${recovered} 条中断请求（归因 gateway，结算态 interrupted）`);
        ledgerBanner.textContent = bannerParts.join('；');
        ledgerBanner.toggleAttribute('hidden', bannerParts.length === 0);
      }
      // 告警披露（静默期/冷却抑制）：防「暂无告警 = 无异常」的假安心（S3-lite 诚实条款）
      const silenceMs = gatewayRunning && status !== null && typeof status === 'object' ? Number(status.alertSilenceRemainingMs ?? 0) : 0;
      const suppressedCount = gatewayRunning && status !== null && typeof status === 'object' ? Number(status.alertSuppressed ?? 0) : 0;
      const disclosureParts = [];
      if (silenceMs > 0) {
        disclosureParts.push(
          `启动静默期中（剩余 ${Math.ceil(silenceMs / 1000)} 秒）：此间不评估任何告警，「暂无告警」不代表「无异常」`,
        );
      } else if (gatewayRunning && status?.alertSilenceWasActive === true) {
        disclosureParts.push('启动静默期已结束：静默期间流量从未被评估');
      }
      if (suppressedCount > 0) {
        disclosureParts.push(`已有 ${suppressedCount} 条告警因 30 分钟冷却被抑制未展示（持续异常只保留最早一条）`);
      }
      alertDisclosure = disclosureParts.join('；');
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
      if (gatewayCopyRoot) gatewayCopyRoot.textContent = gatewayRunning ? `http://127.0.0.1:${String(status.port)}` : '等待启动';
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
      if (gatewayErrorSource === 'refresh') showGatewayError();
    } catch (error) {
      showGatewayError(error instanceof Error ? error.message : String(error), 'refresh');
    }
  }
  byId('btn-channel-new')?.addEventListener('click', () => setChannelForm());
  byId('btn-channel-cancel')?.addEventListener('click', () => { if (channelForm) channelForm.hidden = true; });
  channelForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = inputValue('f-channel-id');
    const gathered = collectModelRows();
    if (gathered.error !== null) { showGatewayError(gathered.error); return; }
    const priced = collectModelPrices();
    if (priced.error !== null) { showGatewayError(priced.error); return; }
    const protocolSelect = byId('f-channel-protocol');
    const body = {
      label: inputValue('f-channel-label'), baseUrl: inputValue('f-channel-base-url'),
      protocol: protocolSelect instanceof HTMLSelectElement ? protocolSelect.value : 'unified',
      models: gathered.models, modelMap: gathered.modelMap,
      modelPrices: priced.modelPrices,
      allowPrivateUpstream: checkedValue('f-channel-private'),
    };
    const key = inputValue('f-channel-key');
    if (id === '' || key !== '') body.apiKey = key; // 编辑时空 key 表示保留；非空 key 显式轮换
    const response = await api(id === '' ? '/api/gateway/channels' : `/api/gateway/channels/${encodeURIComponent(id)}`, {
      method: 'POST', body: JSON.stringify(body),
    });
    if (!response.ok) { showGatewayError(String(response.data?.error ?? `HTTP ${response.status}`)); return; }
    channelForm.hidden = true;
    showGatewayError();
    await refreshGateway();
  });
  // —— 一键获取模型：服务端代取该渠道 /models（Key 不出本机；编辑已有渠道可复用已保存的 Key） ——
  byId('btn-channel-probe')?.addEventListener('click', async () => {
    if (modelRows === null) return;
    const baseUrl = inputValue('f-channel-base-url').trim();
    if (baseUrl === '') { setProbeStatus('请先填写上游 API Base URL，再获取模型列表。', true); return; }
    const id = inputValue('f-channel-id');
    const apiKey = inputValue('f-channel-key');
    if (apiKey === '' && id === '') {
      setProbeStatus('请先填写上游 API Key（编辑已有渠道时可留空，改用已保存的 Key）。', true);
      return;
    }
    const protocolSelect = byId('f-channel-protocol');
    const button = byId('btn-channel-probe');
    if (button instanceof HTMLButtonElement) button.disabled = true;
    setProbeStatus('正在请求该渠道的模型列表…');
    try {
      const body = {
        baseUrl,
        protocol: protocolSelect instanceof HTMLSelectElement ? protocolSelect.value : 'unified',
        allowPrivateUpstream: checkedValue('f-channel-private'),
      };
      if (apiKey !== '') body.apiKey = apiKey; else body.channelId = id;
      const response = await api('/api/gateway/probe-models', { method: 'POST', body: JSON.stringify(body) });
      if (!response.ok) { setProbeStatus(scrubSecrets(String(response.data?.error ?? `HTTP ${response.status}`), [apiKey]), true); return; }
      const models = Array.isArray(response.data?.models) ? response.data.models.filter((item) => typeof item === 'string' && item.trim() !== '') : [];
      if (models.length === 0) { setProbeStatus('该渠道 /models 返回空列表：请手动添加模型行。', true); return; }
      const existing = new Set();
      for (const row of modelRows.querySelectorAll('.model-row')) {
        for (const role of ['upstream', 'alias']) {
          const value = row.querySelector(`input[data-role="${role}"]`)?.value.trim() ?? '';
          if (value !== '') existing.add(value);
        }
      }
      let added = 0;
      let skipped = 0;
      for (const item of models) {
        const name = String(item).trim();
        if (existing.has(name)) { skipped += 1; continue; }
        existing.add(name);
        modelRows.appendChild(buildModelRow(name, name));
        added += 1;
      }
      setProbeStatus(`获取成功：共 ${models.length} 个模型，新增 ${added} 行，跳过重复 ${skipped} 个。别名默认同名，可按需修改后保存。`);
      syncPriceRows();
    } catch (error) {
      setProbeStatus(`获取失败：${error instanceof Error ? error.message : String(error)}`, true);
    } finally {
      if (button instanceof HTMLButtonElement) button.disabled = false;
    }
  });
  byId('btn-model-add')?.addEventListener('click', () => { modelRows?.appendChild(buildModelRow('', '')); syncPriceRows(); });

  // —— 模型价格编辑：按别名行渲染（别名集合变化才重建，已填值按别名保留；不填=只统计 token） ——
  const priceDetails = byId('channel-price-details');
  const priceRows = byId('channel-price-rows');
  const PRICE_FIELDS = ['input', 'output', 'cachedRead', 'threshold', 'input2', 'output2', 'cachedRead2'];
  const PRICE_FIELD_TEXTS = {
    input: '输入 $/1M', output: '输出 $/1M', cachedRead: '缓存读 $/1M',
    threshold: '阶梯阈值 tok', input2: '阶梯·输入', output2: '阶梯·输出', cachedRead2: '阶梯·缓存',
  };
  /** 构建一行价格输入；values 为 { field: string }（缺省空串）。 */
  function buildPriceRow(alias, values = {}) {
    const row = document.createElement('div');
    row.className = 'price-row';
    row.dataset.alias = alias;
    const name = document.createElement('code');
    name.className = 'price-alias';
    name.textContent = alias;
    name.title = alias;
    row.appendChild(name);
    for (const field of PRICE_FIELDS) {
      const wrap = document.createElement('label');
      wrap.className = 'price-field';
      wrap.textContent = PRICE_FIELD_TEXTS[field];
      const input = document.createElement('input');
      input.type = 'text';
      input.inputMode = field === 'threshold' ? 'numeric' : 'decimal';
      input.dataset.priceField = field;
      input.placeholder = field === 'cachedRead' || field === 'cachedRead2' ? '= 输入价' : field === 'threshold' ? '1000000' : '';
      input.value = typeof values[field] === 'string' ? values[field] : '';
      wrap.appendChild(input);
      row.appendChild(wrap);
    }
    return row;
  }
  let priceAliasKey = null;
  /**
   * 价格行与模型别名同步：仅在别名集合变化（或 force）时重建；重建前按别名快照已填值回填，
   * 因此增删/改名其他模型行不会丢已填价格。seedPrices 为编辑渠道时的已存价格（modelPrices）。
   */
  function syncPriceRows(seedPrices = null, force = false) {
    if (priceRows === null || modelRows === null) return;
    const aliases = [];
    for (const input of modelRows.querySelectorAll('input[data-role="alias"]')) {
      const alias = input.value.trim();
      if (alias !== '' && !aliases.includes(alias)) aliases.push(alias);
    }
    const key = aliases.join('\u0000');
    if (!force && key === priceAliasKey) return;
    const draft = new Map();
    for (const row of priceRows.querySelectorAll('.price-row')) {
      const fields = {};
      for (const input of row.querySelectorAll('input[data-price-field]')) fields[String(input.dataset.priceField)] = input.value;
      draft.set(String(row.dataset.alias ?? ''), fields);
    }
    const seed = seedPrices !== null && typeof seedPrices === 'object' ? seedPrices : {};
    priceRows.textContent = '';
    for (const alias of aliases) {
      let values = draft.get(alias);
      if (values === undefined) {
        const stored = seed[alias];
        if (stored !== null && typeof stored === 'object') {
          values = {};
          for (const field of PRICE_FIELDS) values[field] = typeof stored[field] === 'number' ? String(stored[field]) : '';
        }
      }
      priceRows.appendChild(buildPriceRow(alias, values ?? {}));
    }
    priceAliasKey = key;
  }
  /** 汇总价格行 → buildModelPrices 的 entries（校验与成对语义在纯函数内完成）。 */
  function collectModelPrices() {
    const entries = [];
    if (priceRows !== null) {
      for (const row of priceRows.querySelectorAll('.price-row')) {
        const entry = { alias: String(row.dataset.alias ?? '') };
        for (const input of row.querySelectorAll('input[data-price-field]')) entry[String(input.dataset.priceField)] = input.value;
        entries.push(entry);
      }
    }
    return buildModelPrices(entries);
  }
  // 模型行增删/别名改动 → 价格行跟随（别名集合未变则不动，输入焦点不丢）
  modelRows?.addEventListener('input', () => syncPriceRows());
  modelRows?.addEventListener('click', () => syncPriceRows());
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
    showGatewayError();
    const response = await api('/api/gateway/virtual-key/rotate', { method: 'POST', body: '{}' });
    if (!response.ok) { showGatewayError(String(response.data?.error ?? `HTTP ${response.status}`)); return; }
    if (gatewayClientKey) gatewayClientKey.value = String(response.data?.virtualKey ?? '');
    await refreshGateway();
  });
  byId('btn-gateway-stop')?.addEventListener('click', async () => {
    showGatewayError();
    const response = await api('/api/gateway/stop', { method: 'POST', body: '{}' });
    if (!response.ok) showGatewayError(String(response.data?.error ?? `HTTP ${response.status}`));
    else await refreshGateway();
  });
  byId('f-gateway-client-key')?.addEventListener('focus', (event) => event.currentTarget.select());
  // —— 接入信息复制：OpenAI Base URL（/v1）、Anthropic 根地址、虚拟 Key（均仅在网关运行时可复制） ——
  function flashButton(button, text) {
    if (!(button instanceof HTMLButtonElement)) return;
    if (button.dataset.originalLabel === undefined) button.dataset.originalLabel = button.textContent ?? '';
    button.textContent = text;
    const original = button.dataset.originalLabel;
    window.setTimeout(() => { button.textContent = original; }, 1500);
  }
  function bindCopyButton(button, read) {
    if (!(button instanceof HTMLButtonElement)) return;
    button.addEventListener('click', async () => {
      const text = read();
      if (text === '') { flashButton(button, '暂无可复制内容'); return; }
      if (navigator.clipboard === undefined) { flashButton(button, '复制不可用，请手动选择'); return; }
      try {
        await navigator.clipboard.writeText(text);
        flashButton(button, '已复制 ✓');
      } catch {
        flashButton(button, '复制失败，请手动选择');
      }
    });
  }
  function runningBaseUrl() {
    const text = gatewayBaseUrl?.textContent ?? '';
    return text.startsWith('http') ? text : '';
  }
  bindCopyButton(byId('btn-gateway-copy-url'), () => runningBaseUrl());
  bindCopyButton(byId('btn-gateway-copy-root'), () => runningBaseUrl().replace(/\/v1$/, ''));
  bindCopyButton(byId('btn-gateway-copy-key'), () => gatewayClientKey?.value ?? '');

  // —— 用量与异常面板（S2/S3 实时口径）：3 秒轮询，仅当网关运行中且本标签可见 ——
  // 告警披露状态：静默期/冷却抑制来自 status（refreshGateway 维护）；轮询失败标记陈旧。
  let alertDisclosure = '';
  let ledgerStaleAt = null;
  let lastAlertEvents = [];
  const usageBody = byId('gateway-usage-body');
  const alertsList = byId('gateway-alerts');
  const ALERT_KIND_LABELS = {
    model_mismatch: '模型自述不符',
    error_rate: '错误率异常',
    truncated: '响应截断',
    usage_invalid: 'usage 异常',
    ttft_high: 'TTFT 偏高',
  };
  /** 告警披露行（静默期/冷却抑制/陈旧）：防「没告警 = 没异常」的假安心；与事件同列表展示。 */
  function alertDisclosureParts() {
    const parts = [];
    if (alertDisclosure !== '') parts.push(alertDisclosure);
    if (ledgerStaleAt !== null) parts.push(`最近一次用量轮询失败于 ${new Date(ledgerStaleAt).toLocaleTimeString()}：以下数据可能陈旧`);
    return parts;
  }
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
      td.colSpan = 14;
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
        String(Number(row.tokenCached ?? 0)),
        formatCostUsd(row.costUsd),
        row.ttftP50Ms === null || row.ttftP50Ms === undefined ? '—' : formatLatency(row.ttftP50Ms),
        row.provisional === true
          ? `样本不足 n=${Number(row.ttftSamples ?? 0)}`
          : row.ttftP95Ms === null || row.ttftP95Ms === undefined ? '—' : formatLatency(row.ttftP95Ms),
        String(Number(row.ttftContaminated ?? 0)),
        row.usageValidRate === null || row.usageValidRate === undefined ? '—' : `${(Number(row.usageValidRate) * 100).toFixed(1)}%`,
        `${Number(row.usageMissing ?? 0)} / ${Number(row.usageInvalid ?? 0)}`,
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
    const disclosure = alertDisclosureParts();
    if (list.length === 0 && disclosure.length === 0) {
      const li = document.createElement('li');
      li.className = 'placeholder';
      li.textContent = '暂无告警（网关未运行或窗口未达阈值）。';
      alertsList.appendChild(li);
      return;
    }
    for (const note of disclosure) {
      const li = document.createElement('li');
      li.className = 'placeholder alert-disclosure';
      li.textContent = note;
      alertsList.appendChild(li);
    }
    for (const event of list) {
      const kind = String(event.kind ?? '');
      const label = ALERT_KIND_LABELS[kind] ?? kind;
      const observed =
        kind === 'model_mismatch' || kind === 'truncated'
          ? `${Number(event.observed ?? 0)} 次`
          : kind === 'ttft_high'
            ? formatLatency(event.observed ?? 0)
            : `${(Number(event.observed ?? 0) * 100).toFixed(0)}%`;
      const ids = Array.isArray(event.evidence_request_ids) ? event.evidence_request_ids.map((id) => String(id)) : [];
      const li = document.createElement('li');
      li.textContent =
        `${new Date(Number(event.ts)).toLocaleTimeString()} · ${channelLabels.get(String(event.channel)) ?? String(event.channel)}` +
        ` · ${label} · 窗口 ${Number(event.n ?? 0)} 条 / 观测 ${observed}` +
        ` · 证据请求 ${ids.length} 条${ids.length > 0 ? `（首条 ${String(ids[0]).slice(0, 8)}…）` : '（账本可下钻）'}`;
      if (ids.length > 0) li.title = `证据请求 id（可用于账本下钻）：\n${ids.join('\n')}`;
      alertsList.appendChild(li);
    }
  }
  async function refreshGatewayLedger() {
    if (isOffline() || !gatewayRunning) return;
    try {
      const [usageResponse, eventsResponse] = await Promise.all([api('/api/gateway/usage'), api('/api/gateway/events')]);
      if (!usageResponse.ok || !eventsResponse.ok) {
        ledgerStaleAt = Date.now();
        renderAlerts(lastAlertEvents);
        return;
      }
      ledgerStaleAt = null;
      lastAlertEvents = Array.isArray(eventsResponse.data?.events) ? eventsResponse.data.events : [];
      renderUsage(usageResponse.data?.usage);
      renderAlerts(lastAlertEvents);
    } catch {
      ledgerStaleAt = Date.now(); // 请求级失败同样标注陈旧，绝不静默假装数据新鲜
      renderAlerts(lastAlertEvents);
    }
  }
  window.setInterval(() => {
    if (tabs.gateway?.getAttribute('aria-selected') === 'true') void refreshGatewayLedger();
  }, 3000);
  renderUsage([]);
  renderAlerts([]);

  if (tabs.gateway?.getAttribute('aria-selected') === 'true') void refreshGateway(); // 聚合页隐藏期间不做无用初始化请求
  window.setInterval(() => {
    if (tabs.gateway?.getAttribute('aria-selected') === 'true') void refreshGateway();
  }, 2500);

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
      // 类型分流：只有 report-*.json 可渲染评分卡；baseline-*/未识别文件只给「打开」链接
      // （否则点基线文件会报「报告缺少 outcomes 数组……」，见 I2 回归）
      const kind = item.kind === 'report' ? 'report' : item.kind === 'baseline' ? 'baseline' : 'other';
      const kindPrefix = kind === 'baseline' ? '基线 · ' : kind === 'other' ? '其他 · ' : '';
      const clickable = kind === 'report' && String(item.name).endsWith('.json');
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = String(item.name);
      if (clickable) name.title = '点击查看';
      else name.style.cursor = 'default';
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `${kindPrefix}${new Date(Number(item.mtimeMs)).toLocaleString()} · ${(Number(item.size) / 1024).toFixed(1)} KB`;
      li.appendChild(name);
      li.appendChild(meta);
      if (clickable) {
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

  const CLEAR_HINT = {
    'keep-latest': '清理历史报告：保留最新一套报告与最新基线，删除其余报告/基线文件（不可撤销）。',
    'reports-root': '删除 reports/ 下全部报告与基线文件（保留子目录与运行时数据；不可撤销）。',
    all: '清空 reports/ 全部内容（含 guard 审计、网关账本等子目录数据；不可撤销）。',
  };
  async function clearReports(scope) {
    if (isOffline()) {
      if (historyError) {
        historyError.textContent = '未连接本地服务：报告清理需要 npm run ui 启动的本地服务。';
        historyError.removeAttribute('hidden');
      }
      return;
    }
    if (historyError) historyError.setAttribute('hidden', '');
    const res = await api('/api/reports/clear', { method: 'POST', body: JSON.stringify({ scope }) });
    if (!res.ok) {
      if (historyError) {
        historyError.textContent = String(res.data?.error ?? `HTTP ${res.status}`);
        historyError.removeAttribute('hidden');
      }
      return;
    }
    if (historyOut !== null) {
      const deleted = Number(res.data?.deleted ?? 0);
      const keep = Array.isArray(res.data?.keep) ? res.data.keep : [];
      const keepText =
        keep.length === 0 ? '' : '；保留：' + keep.map((item) => `${String(item.name)}（${String(item.reason)}）`).join('、');
      historyOut.innerHTML =
        deleted === 0
          ? `<p>无需清理：没有更旧的报告/基线可删（最新一套已保留）${escapeHtml(keepText)}。</p><p class="hint">列表已刷新。</p>`
          : `<p>已删除 ${escapeHtml(String(deleted))} 项，文件体积释放约 ` +
            `${escapeHtml((Number(res.data?.freedBytes ?? 0) / (1024 * 1024)).toFixed(1))} MB` +
            `${escapeHtml(keepText)}。</p><p class="hint">列表已刷新。</p>`;
    }
    await refreshReports();
  }
  // 两步点击确认（替代 window.confirm：内嵌浏览器/webview 会静默吞掉原生对话框，表现为「点击没反应」）。
  // 第一次点击进入待确认态（按钮文字变化 + 提示文案），限时内再点一次执行；点其他位置或超时自动取消。
  const CLEAR_ARM_MS = 5000;
  let armedClear = null;
  function disarmClear() {
    if (armedClear === null) return;
    clearTimeout(armedClear.timer);
    armedClear.button.textContent = armedClear.label;
    armedClear.button.classList.remove('armed');
    armedClear.button.removeAttribute('aria-pressed');
    armedClear = null;
  }
  function armOrRunClear(scope) {
    if (armedClear !== null && armedClear.scope === scope) {
      const confirmedScope = armedClear.scope;
      disarmClear();
      void clearReports(confirmedScope);
      return;
    }
    disarmClear();
    const button = scope === 'all' ? byId('btn-reports-clear-all') : byId('btn-reports-clear-keep');
    if (!button) return;
    const label = button.textContent;
    button.textContent = scope === 'all' ? '再点一次＝清空全部' : '再点一次＝清理';
    button.classList.add('armed');
    button.setAttribute('aria-pressed', 'true');
    const timer = setTimeout(disarmClear, CLEAR_ARM_MS);
    armedClear = { scope, button, label, timer };
    if (historyOut !== null) {
      const buttonName = scope === 'all' ? '清空全部' : '清理（保留最新）';
      historyOut.innerHTML = `<p class="hint">${escapeHtml(CLEAR_HINT[scope] ?? '')}请在 ${CLEAR_ARM_MS / 1000} 秒内再点一次「${escapeHtml(buttonName)}」确认；点其他位置自动取消。</p>`;
    }
  }
  byId('btn-reports-clear-keep')?.addEventListener('click', () => armOrRunClear('keep-latest'));
  byId('btn-reports-clear-all')?.addEventListener('click', () => armOrRunClear('all'));
  document.addEventListener(
    'click',
    (event) => {
      if (armedClear !== null && !armedClear.button.contains(event.target)) disarmClear();
    },
    true,
  );
}
