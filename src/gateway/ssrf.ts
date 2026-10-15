// src/gateway/ssrf.ts — 上游目标 SSRF 防护（网关数据面每个请求都重解析并钉定公网 IPv4）。
// 规则（硬约束）：
//   ① 只允许 http/https，且 baseUrl 不得携带凭证（user:pass）、query、fragment；
//   ② 每次请求重新 DNS 解析，任一结果为 IPv6 一律安全拒绝（IPv6 未完整支持，拒绝优于猜测）；
//   ③ 所有解析出的 IPv4 必须全部为公网地址，任一私网/保留/回环/组播地址即整单拒绝（防解析混入）；
//   ④ 连接钉定到本次校验过的具体 IPv4（lookup 回调直接返回该 IP），杜绝 DNS rebinding 二次解析；
//   ⑤ 不跟随重定向（由调用方对 3xx 上游响应转为错误，且不外发 Location）。
import { promises as dns } from 'node:dns';
import type { LookupFunction } from 'node:net';

export interface ResolvedAddress {
  address: string;
  family: number;
}

/** 测试可注入的解析器（默认系统 dns.lookup all）。生产路径不得注入。 */
export type DnsLookup = (hostname: string) => Promise<ResolvedAddress[]>;

export const defaultDnsLookup: DnsLookup = async (hostname) => {
  const results = await dns.lookup(hostname, { all: true, verbatim: true });
  return results.map((entry) => ({ address: entry.address, family: entry.family }));
};

/** 非公网 IPv4 段（私网/保留/回环/链路本地/评测/文档/组播/6to4 中继等），命中即拒绝。 */
const NON_PUBLIC_IPV4_RANGES: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

export function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

export function isIpv4Literal(host: string): boolean {
  return ipv4ToInt(host) !== null;
}

/** 是否为公网 IPv4（非私网/保留/回环/链路本地/组播/文档/评测地址）。非法字面量返回 false。 */
export function isPublicIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return false;
  for (const [base, bits] of NON_PUBLIC_IPV4_RANGES) {
    const baseValue = ipv4ToInt(base);
    if (baseValue === null) continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((value & mask) >>> 0 === (baseValue & mask) >>> 0) return false;
  }
  return true;
}

export interface UpstreamUrlCheck {
  ok: boolean;
  url: URL | null;
  message: string;
}

/**
 * baseUrl 语法/形状校验（不含 DNS 解析，DNS 在每个请求时重解析）：协议、凭证、query/fragment、
 * IPv6 字面量与私网 IPv4 字面量在此拒绝；域名型主机由请求时重解析再判。
 */
export function validateUpstreamBaseUrl(raw: unknown): UpstreamUrlCheck {
  const fail = (message: string): UpstreamUrlCheck => ({ ok: false, url: null, message });
  if (typeof raw !== 'string' || raw.trim() === '') {
    return fail(`baseUrl 非法：收到值 ${JSON.stringify(raw ?? null)}（空或非字符串）。示例：https://relay.example.com/v1`);
  }
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail(`baseUrl 非法：收到值 ${JSON.stringify(value)}。示例：https://relay.example.com/v1（通常以 /v1 结尾）`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return fail(`baseUrl 协议必须为 http/https：收到值 ${JSON.stringify(value)}。示例：https://relay.example.com/v1`);
  }
  if (url.username !== '' || url.password !== '') {
    return fail(`baseUrl 不得在 URL 中携带账号/密码（会泄漏到日志与错误信息）：收到值 ${JSON.stringify(value)}。示例：https://relay.example.com/v1（凭证走 apiKey 字段）`);
  }
  if (url.search !== '' || url.hash !== '') {
    return fail(`baseUrl 不得携带 query 或 fragment：收到值 ${JSON.stringify(value)}。示例：https://relay.example.com/v1`);
  }
  const host = url.hostname;
  if (host.startsWith('[') || host.includes(':')) {
    return fail(`baseUrl 的 IPv6 上游暂不支持（IPv6 未完整处理，按安全策略拒绝）：收到值 ${JSON.stringify(value)}。示例：https://relay.example.com/v1`);
  }
  if (isIpv4Literal(host) && !isPublicIpv4(host)) {
    return fail(`baseUrl 指向私网/保留/回环 IPv4（防 SSRF 拒绝）：收到值 ${JSON.stringify(value)}。示例：https://relay.example.com/v1`);
  }
  return { ok: true, url, message: '' };
}

export interface PinnedResult {
  ok: boolean;
  ip: string | null;
  message: string;
}

/**
 * 每请求解析并校验：全部结果为公网 IPv4 才通过，返回钉定的具体 IP。
 * IPv6 结果、私网/保留地址、解析空结果或解析失败一律安全拒绝。
 */
export async function resolvePinnedUpstream(input: {
  hostname: string;
  lookup: DnsLookup;
}): Promise<PinnedResult> {
  const host = input.hostname.endsWith('.') ? input.hostname.slice(0, -1) : input.hostname;
  if (host.startsWith('[') || host.includes(':')) {
    return { ok: false, ip: null, message: 'IPv6 上游暂不支持（未完整处理，按安全策略拒绝）' };
  }
  if (isIpv4Literal(host)) {
    return isPublicIpv4(host)
      ? { ok: true, ip: host, message: '' }
      : { ok: false, ip: null, message: `上游主机 ${host} 为私网/保留/回环 IPv4，已拒绝（防 SSRF）` };
  }
  let results: ResolvedAddress[];
  try {
    results = await input.lookup(host);
  } catch (error) {
    return { ok: false, ip: null, message: `上游域名 ${host} 解析失败：${error instanceof Error ? error.message : String(error)}` };
  }
  if (results.length === 0) {
    return { ok: false, ip: null, message: `上游域名 ${host} 解析无结果，已拒绝` };
  }
  for (const entry of results) {
    if (entry.family === 6) {
      return { ok: false, ip: null, message: `上游域名 ${host} 解析到 IPv6 地址 ${entry.address}（未完整处理，按安全策略拒绝）` };
    }
  }
  for (const entry of results) {
    if (entry.family !== 4 || !isPublicIpv4(entry.address)) {
      return { ok: false, ip: null, message: `上游域名 ${host} 解析到非公网/保留地址 ${entry.address}，已拒绝（防 SSRF/DNS rebinding）` };
    }
  }
  const first = results[0];
  if (first === undefined) return { ok: false, ip: null, message: `上游域名 ${host} 解析无结果，已拒绝` };
  return { ok: true, ip: first.address, message: '' };
}

/**
 * 连接钉定：把本次校验过的具体 IP 作为 lookup 结果返回，Node 不会再发起第二次 DNS 查询。
 * 同时兼容 net.connect 的 all:true/false 两种回调形态。
 */
export function pinnedLookup(ip: string): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all === true) {
      callback(null, [{ address: ip, family: 4 }]);
      return;
    }
    callback(null, ip, 4);
  };
}
