// web/app.js 的类型声明。
// web/ 不参与 tsc 编译（tsconfig include 只有 src/test），
// 本文件仅供 test/（编译期类型检查，运行时被擦除）与编辑器使用。

/** buildCommand 的表单输入；所有「数值/可选」字段均为字符串，空串表示未填。 */
export interface BuildCommandInput {
  /** 目标终端：posix（默认，PowerShell/bash/zsh 单引号）| cmd（cmd.exe 双引号）。 */
  shell?: 'posix' | 'cmd';
  baseUrl: string;
  model: string;
  claimedContext: string;
  expect: string[];
  priceInput: string;
  priceOutput: string;
  priceCachedRead: string;
  priceThreshold: string;
  priceInput2: string;
  priceOutput2: string;
  priceCachedRead2: string;
  /** 公示倍率锚点与网页兜底页（可选；空串 = 不传，由 CLI 自动探测 /api/pricing）。 */
  expectModelRatio?: string;
  expectCompletionRatio?: string;
  quotaPerUsd?: string;
  declaredPricePage?: string;
  seed: string;
  timeout: string;
  /** 429/5xx 网关拒绝的重试预算（0-6，空串=CLI 默认 2）。 */
  httpRetries?: string;
  out: string;
  baseline: string;
  deep: boolean;
  dryRun: boolean;
  yes: boolean;
}

export interface BuildCommandResult {
  /** 生成的 shell 命令；error 非 null 时为空串（不给半成品命令）。不含 --key。 */
  command: string;
  /** 用环境变量设置 key 的两行提示（bash/zsh 与 PowerShell）。 */
  hints: string[];
  /** 校验错误信息；null 表示成功。 */
  error: string | null;
}

export interface RenderScorecardResult {
  /** 渲染出的 HTML 片段（所有插值已过 escapeHtml）；error 非 null 时为空串。 */
  html: string;
  /** 校验/解析错误信息；null 表示成功（含 outcomes 为空的占位渲染）。 */
  error: string | null;
}

export interface WebApp {
  escapeHtml(s: string): string;
  buildCommand(input: BuildCommandInput): BuildCommandResult;
  renderScorecard(jsonText: string): RenderScorecardResult;
  scrubSecrets(text: string, secrets: string[]): string;
  buildModelPrices(entries: ModelPriceEntry[]): BuildModelPricesResult;
  formatCostUsd(value: unknown): string;
  classifyLogLine(text: string): string;
  /** 归一化页面注入的会话 token（48 位小写十六进制）；形态不符/占位符未替换 → null。 */
  normalizeInjectedToken(raw: unknown): string | null;
  /** 从控制台首页 HTML 中提取服务端当前注入的会话 token；取不到 → null。 */
  extractTokenFromHtml(html: unknown): string | null;
  /** 响应是否为「会话 token 不可用」（403 且 token 相关）→ 允许换 token 重试一次。 */
  isTokenAuthError(status: number, data: unknown): boolean;
}

/** 价格编辑行（字段均为字符串，空串=未填）；alias 行来自模型清单。 */
export interface ModelPriceEntry {
  alias: string;
  input: string;
  output: string;
  cachedRead: string;
  threshold: string;
  input2: string;
  output2: string;
  cachedRead2: string;
}

/** 单个模型的价格（与服务端 ModelPrice 同口径：USD/百万 tokens；threshold 为长上下文整单二档阈值）。 */
export interface ModelPrice {
  input: number;
  output: number;
  cachedRead?: number;
  threshold?: number;
  input2?: number;
  output2?: number;
  cachedRead2?: number;
}

export interface BuildModelPricesResult {
  /** 可直接随渠道 POST 的 modelPrices（全空行已跳过）；error 非 null 时为已收集的部分（不提交）。 */
  modelPrices: Record<string, ModelPrice>;
  /** 校验错误信息（含别名与正确示例）；null 表示成功。 */
  error: string | null;
}
