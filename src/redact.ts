/**
 * URL 脱敏：报告与错误回显里绝不能出现凭据。
 *
 * 中转站 baseUrl 可能被写成 https://user:pass@host/v1 或 https://host/v1?key=xxx，
 * 这些值会原样进入可分享的报告（JSON/MD/HTML）与日志回显——等于把凭据发到群里。
 * 脱敏口径：保留 origin + path（够认出是哪个站点），抹掉 userinfo、query、hash；
 * path 段里形如 sk-xxxxxxxx 的片段按 key 处理（个别中转把 key 放在路径里）。
 * query 整体丢弃（凭据最常藏在 query 里），不靠正则去猜哪个参数是 key。
 *
 * 解析失败（非法 URL）或方案非 special 且带 opaque 部分时 origin 恒为字符串 "null"
 * （mailto:/data:/javascript: 等；ftp:/file: 属 special scheme，origin 正常），
 * 这时退化为「砍掉 ?/# 之后 + 抹掉 user:pass@」，宁可信息少也不外泄。
 */
export function redactUrl(raw: string): string {
  const value = String(raw);
  const fallback = (): string => {
    const cut = value.split(/[?#]/)[0] ?? value;
    return cut.replace(/^([a-zA-Z][\w+.-]*:\/\/)[^/@]*@/, '$1');
  };
  let text: string;
  try {
    const parsed = new URL(value);
    if (parsed.origin === 'null') return fallback();
    // 根路径且无 query/hash 时不补尾斜杠：与用户原样书写的形态一致，避免报告里出现「凭空多出的 /」。
    const path = parsed.pathname === '/' && parsed.search === '' && parsed.hash === '' ? '' : parsed.pathname;
    text = `${parsed.origin}${path}`;
  } catch {
    return fallback();
  }
  return text.replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***');
}
