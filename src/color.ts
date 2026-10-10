/**
 * 终端颜色支持检测与 ANSI 着色（零依赖）。
 *
 * supportsColor：仅在「交互式 TTY 且无显式关闭信号」时启用颜色。
 * - Windows 10+ 现代终端（Windows Terminal / ConPTY）经 libuv 自动启用 VT 序列，无需额外处理；
 * - 不支持的环境（重定向管道、NO_COLOR、TERM=dumb、CI）自动回退纯文本——所有渲染函数
 *   都把 color 当作纯装饰开关：关掉时输出不含任何转义字节，测试可做「无 ANSI 泄漏」断言。
 */
export interface TtyLike {
  isTTY?: boolean | undefined;
}

const ANSI_RESET = '\u001b[0m';

/** level → ANSI 前缀；null 表示不着色（unknown/na 保持默认前景色）。 */
const LEVEL_CODES: Readonly<Record<string, string | null>> = {
  ok: '\u001b[32m', // 绿
  pass: '\u001b[32m', // 绿
  warn: '\u001b[33m', // 黄
  fail: '\u001b[31m', // 红
  unknown: null,
  na: null,
};

export function supportsColor(stream: TtyLike | null | undefined): boolean {
  if (!stream || !stream.isTTY) return false;
  if (process.env['NO_COLOR']) return false;
  if (process.env['TERM'] === 'dumb') return false;
  if (process.env['CI']) return false;
  return true;
}

/** 按语义级别着色；enabled=false 或 unknown/na 时原样返回（无 ANSI 字节）。 */
export function colorize(text: string, level: 'ok' | 'pass' | 'warn' | 'fail' | 'unknown' | 'na', enabled: boolean): string {
  if (!enabled) return text;
  const code = LEVEL_CODES[level] ?? null;
  if (code === null) return text;
  return `${code}${text}${ANSI_RESET}`;
}
