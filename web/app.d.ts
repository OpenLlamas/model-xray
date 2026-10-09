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
  seed: string;
  timeout: string;
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
}
