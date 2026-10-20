// src/pricing-ledger.ts — 本地公示倍率账本（append-only JSONL）。
// 审计动机：`--baseline` 是显式携带的历史快照，用户不开基线时站点上调倍率不会被检出。
// 账本按 origin 归档每次成功抓取的公示快照，无需基线即可在下一轮自动对比漂移；
// 只写本地磁盘（reports/pricing/ 子目录），不发起任何网络请求，不含凭证。
//
// 归档键：只取「主机+端口」（无路径）——同一上游反代挂在不同路径前缀（/v1、/relay/v1）时
// 必须命中同一账本文件，否则换路径别名即可规避漂移历史；条目内保留完整 origin，
// 对照到不同路径的历史快照时以 originNote 如实披露。
//
// 并发安全：同一文件的「读→比→追加」必须在同一把文件锁内完成（多审计进程/守护进程场景）；
// 陈旧锁仅在「mtime 超过 60s 且持锁 pid 已不可达（或锁内容不可解析）」时清理——慢写入者
// （如网络盘 fsync 卡顿）持锁超过阈值时不得被夺锁；存活进程持锁则重试到锁超时并如实抛错
//（价格账本被占用），绝不静默跳过（避免写坏/覆盖历史）。
// 锁内容为 {pid, token}：删除陈旧锁前必须两次读锁并校验 token 未变，把「检查后-删除前锁被
// 新主人换掉」的竞态窗口收窄到「第二次读→unlink」的窄缝（受限于 unlink 无条件原子性，该窗口
// 只是收窄不是消除——真正的完全消除需要 compare-and-delete 原语或目录交换）。
// 体积控制：超过 5MB 时保留最近 500 条有效行原子重写（临时文件 + rename）。

import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import type { DeclaredPricingSnapshot, DeclaredPricingSnapshotModel } from './types.js';
import {
  lookupDeclaredModel,
  PRICING_SOURCES,
  type DeclaredModelPricing,
  type DeclaredPricing,
  type PricingSource,
  type QuotaPerUnitSource,
} from './pricing.js';

/** 账本条目 schema 版本：字段语义变化时必须 bump，旧版本条目读取时按损坏跳过。 */
export const PRICING_LEDGER_SCHEMA = 1;

const LEDGER_DIR_NAME = 'pricing';
const LEDGER_EXT = '.jsonl';
const MAX_LEDGER_BYTES = 5 * 1024 * 1024;
const RETAIN_LINES = 500;
const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 5000;
/** 陈旧锁阈值：慢写入者（网络盘 fsync/rotate）可能持锁远超 10s；60s 后才考虑清理。 */
const LOCK_STALE_MS = 60000;
const READ_WINDOW_BYTES = 512 * 1024;
const READ_WINDOW_MAX_BYTES = 4 * 1024 * 1024;

/** 账本条目：结构与 DeclaredPricingSnapshot 一致，外加 schemaVersion 与写入时的模型标识。 */
export interface PricingLedgerEntry {
  schemaVersion: number;
  origin: string;
  capturedAt: string;
  /** 快照来源；旧条目缺省表示来源未知（legacy，不冒充 api）。 */
  source?: PricingSource;
  /** 写入本条目的审计目标模型名（空串 = 未指定模型，如 pricing-watch 全表模式）。 */
  model: string;
  quotaPerUnit: number | null;
  /** quotaPerUnit 的来源；旧条目缺省 = 来源未知（不冒充站点公示）。 */
  quotaPerUnitSource?: QuotaPerUnitSource;
  group: string | null;
  models: Record<string, DeclaredPricingSnapshotModel>;
  groupRatio: Record<string, number>;
}

/** 账本写入结果（runner 注入回调、billing 如实披露；写入失败绝不影响审计本身）。 */
export interface PricingLedgerWriteResult {
  ok: boolean;
  path: string | null;
  error: string | null;
}

export interface LedgerReadResult {
  kind: 'ok' | 'missing' | 'error';
  entry: PricingLedgerEntry | null;
  path: string;
  error: string | null;
  /** 从文件尾部向前扫描时跳过的损坏行数（诊断用）。 */
  corruptLines: number;
  /**
   * 尾部损坏：最新有效条目之后（更新的位置）存在无法解析的行，或文件末尾存在未终止半行。
   * 为 true 时「最新快照」不可信——watch 必须拒绝判定「无变化」并 exit 2；审计侧只 warn 且明示对照基线可能过旧。
   */
  tailCorrupt: boolean;
  /** 条目 origin 与当前 origin 不同（同一主机不同路径前缀）时的披露文案；同路径/无条目为 null。 */
  originNote: string | null;
}

/**
 * 倍率漂移项（comparePricingSnapshots 输出）。
 * - numeric：两侧都有值时字段变化（rel 为相对变化；旧值 0 无法计算百分比时 rel=null）；
 * - presence：字段在一侧存在、另一侧缺失（含模型整条增删；quota_type 两个方向都不升级为显著）；
 * - enum：非数值枚举字段变化（当前只有 quota_type）；
 * - group_numeric：group_ratio 中同名分组倍率变化；
 * - basis：计价口径断裂（计费基准按 token↔按次、换算系数变更）——两侧数值不可比，
 *   只披露口径变化，绝不产出数值漂移结论（否则同一口径变化会被误判成「站点偷改价格」）。
 */
export interface PricingDrift {
  kind: 'numeric' | 'presence' | 'enum' | 'group_numeric' | 'basis';
  field: string;
  model: string | null;
  oldValue: number | null;
  newValue: number | null;
  relativeChange: number | null;
  direction: 'up' | 'down' | 'unknown';
  significant: boolean;
  message: string;
}

/** 漂移显著阈值：相对变化 >5%（恰好 5% 按「未超过」处理，与基线阈值容忍口径一致）。 */
const DRIFT_REL_THRESHOLD = 0.05;
const DRIFT_EPS = 1e-9;

/** 归一化 origin：剥凭证/query/hash 与末尾斜杠，仅接受 http/https。 */
export function normalizeLedgerOrigin(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`价格账本仅支持 http/https 站点 origin：${origin}`);
  }
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  const pathname = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${pathname}`;
}

/** 文件名安全化：小写后非 [a-z0-9.-] 一律替换为下划线；结果不含字母数字时回退 'origin'。 */
export function sanitizeHost(hostPart: string): string {
  let sanitized = hostPart.toLowerCase();
  sanitized = sanitized.replace(/[^a-z0-9.-]/g, '_');
  sanitized = sanitized.replace(/_+/g, '_');
  sanitized = sanitized.replace(/\.{2,}/g, '_');
  sanitized = sanitized.replace(/^[.-]+/, '');
  if (sanitized.length > 60) sanitized = sanitized.slice(0, 60);
  return /[a-z0-9]/.test(sanitized) ? sanitized : 'origin';
}

/**
 * 账本归档键：`protocol//host:port`（小写主机、默认端口省略、丢弃路径/query/凭证）。
 * 同一上游的反代路径别名（/v1、/relay/v1）必须共享同一账本文件——否则改路径别名即可规避漂移历史。
 */
export function ledgerOriginKey(origin: string): string {
  const url = new URL(normalizeLedgerOrigin(origin));
  return `${url.protocol}//${url.host}`;
}

/** 账本文件路径：<outDir>/pricing/<safeHost>-<sha256(ledgerOriginKey).slice(0,12)>.jsonl（同主机同文件）。 */
export function ledgerPath(outDir: string, origin: string): string {
  const key = ledgerOriginKey(origin);
  const url = new URL(key);
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 12);
  return join(outDir, LEDGER_DIR_NAME, `${sanitizeHost(url.host)}-${hash}${LEDGER_EXT}`);
}

/** 条目 origin 与当前 origin 归一化不等（同主机不同路径）时的披露文案。 */
function originNoteFor(entryOrigin: string, currentOrigin: string): string | null {
  const normalize = (value: string): string => {
    try {
      return normalizeLedgerOrigin(value);
    } catch {
      return value;
    }
  };
  if (normalize(entryOrigin) === normalize(currentOrigin)) return null;
  return `对照快照抓取自同主机不同路径（${entryOrigin}）`;
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function statOrNull(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/** 创建（或校验）账本目录；符号链接/同名文件一律拒绝——账本路径被抢占时不静默写入别处。 */
function ensureLedgerDir(outDir: string): string {
  const dir = join(outDir, LEDGER_DIR_NAME);
  let existing = lstatOrNull(dir);
  if (existing === null) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    existing = lstatOrNull(dir);
  }
  if (existing === null || !existing.isDirectory()) {
    throw new Error(`价格账本目录不可用（非目录或符号链接）：${dir}`);
  }
  return dir;
}

/** 账本文件安全断言：已存在但非普通文件（符号链接/目录/FIFO 等）时拒绝写入。 */
function assertLedgerFileSafe(path: string): void {
  const stats = lstatOrNull(path);
  if (stats !== null && !stats.isFile()) {
    throw new Error(`价格账本路径不是普通文件（符号链接/目录等）：${path}`);
  }
}

function optionalFiniteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 解析一行账本 JSON；schema 不符/字段畸形一律返回 null（由调用方计入 corruptLines 或跳过）。 */
function parseLedgerLine(line: string): PricingLedgerEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record['schemaVersion'] !== PRICING_LEDGER_SCHEMA) return null;
  const origin = record['origin'];
  const capturedAt = record['capturedAt'];
  const model = record['model'];
  if (typeof origin !== 'string' || origin === '') return null;
  if (typeof capturedAt !== 'string' || capturedAt === '') return null;
  if (typeof model !== 'string') return null;

  const modelsRaw = record['models'];
  if (typeof modelsRaw !== 'object' || modelsRaw === null || Array.isArray(modelsRaw)) return null;
  const models: Record<string, DeclaredPricingSnapshotModel> = {};
  for (const [name, value] of Object.entries(modelsRaw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const modelRatio = entry['modelRatio'];
    const completionRatio = entry['completionRatio'];
    if (typeof modelRatio !== 'number' || !Number.isFinite(modelRatio) || modelRatio < 0) continue;
    if (typeof completionRatio !== 'number' || !Number.isFinite(completionRatio) || completionRatio < 0) continue;
    models[name] = {
      modelRatio,
      completionRatio,
      cacheRatio: optionalFiniteOrNull(entry['cacheRatio']),
      modelPrice: optionalFiniteOrNull(entry['modelPrice']),
      quotaType: optionalFiniteOrNull(entry['quotaType']),
    };
  }

  const groupRatio: Record<string, number> = {};
  const groupRatioRaw = record['groupRatio'];
  if (typeof groupRatioRaw === 'object' && groupRatioRaw !== null && !Array.isArray(groupRatioRaw)) {
    for (const [group, ratio] of Object.entries(groupRatioRaw as Record<string, unknown>)) {
      const parsedRatio = optionalFiniteOrNull(ratio);
      if (parsedRatio !== null && parsedRatio > 0) groupRatio[group] = parsedRatio;
    }
  }

  const quotaParsed = optionalFiniteOrNull(record['quotaPerUnit']);
  const groupRaw = record['group'];
  const sourceRaw = record['source'];
  const source =
    typeof sourceRaw === 'string' && (PRICING_SOURCES as readonly string[]).includes(sourceRaw)
      ? (sourceRaw as PricingSource)
      : undefined;
  const quotaSourceRaw = record['quotaPerUnitSource'];
  const quotaPerUnitSource =
    quotaSourceRaw === 'site' || quotaSourceRaw === 'cli' || quotaSourceRaw === 'none' ? quotaSourceRaw : undefined;
  return {
    schemaVersion: PRICING_LEDGER_SCHEMA,
    origin,
    capturedAt,
    ...(source !== undefined ? { source } : {}),
    model,
    quotaPerUnit: quotaParsed !== null && quotaParsed > 0 ? quotaParsed : null,
    ...(quotaPerUnitSource !== undefined ? { quotaPerUnitSource } : {}),
    group: typeof groupRaw === 'string' && groupRaw !== '' ? groupRaw : null,
    models,
    groupRatio,
  };
}

function appendLedgerLine(path: string, entry: PricingLedgerEntry): void {
  const line = `${JSON.stringify(entry)}\n`;
  const fd = openSync(path, 'a', 0o600);
  try {
    writeSync(fd, line);
    try {
      fsyncSync(fd);
    } catch {
      // 某些平台/卷不支持 fsync：失败不致命，OS 仍会按常规落盘节奏写出
    }
  } finally {
    closeSync(fd);
  }
}

/** 超过体积上限时保留最近 RETAIN_LINES 条有效行原子重写（临时文件 + rename，同目录保证原子性）。 */
function rotateLedgerIfNeeded(path: string): void {
  const stats = statOrNull(path);
  if (stats === null || stats.size <= MAX_LEDGER_BYTES) return;
  const lines = readFileSync(path, 'utf8').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  // 只保留 schema 有效的行：损坏行没有保留价值，也不应挤占重写后的行程
  const kept = lines.filter((line) => line !== '' && parseLedgerLine(line) !== null).slice(-RETAIN_LINES);
  const tmp = `${path}.${process.pid}-${Date.now()}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    if (kept.length > 0) writeSync(fd, `${kept.join('\n')}\n`);
    try {
      fsyncSync(fd);
    } catch {
      // 同 appendLedgerLine：fsync 能力缺失不阻塞重写
    }
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // 临时文件清理失败不掩盖原始错误
    }
    throw error;
  }
}

/**
 * 把一条快照追加到账本（单进程安全版本；读-比-追加的跨进程互斥请用 withLedgerLock）。
 * 返回写入的文件路径。
 */
export function appendPricingSnapshot(outDir: string, entry: PricingLedgerEntry): string {
  ensureLedgerDir(outDir);
  const path = ledgerPath(outDir, entry.origin);
  assertLedgerFileSafe(path);
  rotateLedgerIfNeeded(path);
  appendLedgerLine(path, entry);
  rotateLedgerIfNeeded(path);
  return path;
}

function readWindow(path: string, start: number, end: number): string {
  const fd = openSync(path, 'r');
  try {
    const length = Math.max(0, end - start);
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * 读取账本中最新一条有效条目。
 * - missing：文件不存在（首次运行，正常）；
 * - error：路径被非普通文件占用 / 空文件 / 尾部窗口与全文件内均无有效行；
 * - ok：尾部窗口内按时间倒序找到的第一条 schema 有效行；
 *   corruptLines = 窗口内所有无法解析的非空行总数（含比条目更新的与更旧的中段行，仅诊断披露用）；
 *   tailCorrupt = 比条目更新的损坏行 >0，或文件末尾存在未终止半行——此时最新快照不可作为「无变化」的充分依据；
 *   entry.origin 与当前 origin 不同（同主机不同路径）时给出 originNote 供调用方披露。
 */
export function readLastPricingSnapshot(outDir: string, origin: string): LedgerReadResult {
  const path = ledgerPath(outDir, origin);
  const stats = lstatOrNull(path);
  if (stats === null) return { kind: 'missing', entry: null, path, error: null, corruptLines: 0, tailCorrupt: false, originNote: null };
  if (!stats.isFile()) {
    return {
      kind: 'error',
      entry: null,
      path,
      error: '价格账本路径不是普通文件（符号链接/目录等）',
      corruptLines: 0,
      tailCorrupt: false,
      originNote: null,
    };
  }
  if (stats.size === 0) {
    return { kind: 'error', entry: null, path, error: '价格账本为空文件', corruptLines: 0, tailCorrupt: false, originNote: null };
  }

  let windowBytes = Math.min(READ_WINDOW_BYTES, stats.size);
  for (;;) {
    const start = Math.max(0, stats.size - windowBytes);
    const text = readWindow(path, start, stats.size);
    if (text.length === 0) {
      return {
        kind: 'error',
        entry: null,
        path,
        error: '价格账本无有效条目（尾部窗口为空）',
        corruptLines: 0,
        tailCorrupt: false,
        originNote: null,
      };
    }
    const lines = text.split('\n');
    // 窗口头部可能截断一行（start>0 时首行不完整）：与尾部损坏无关，直接丢弃。
    // 末尾无换行的残段（写入中断的半行）：整段丢弃并记为尾部损坏——无法确认是完整追加还是崩溃半行。
    if (start > 0) lines.shift();
    const terminated = text.endsWith('\n');
    let halfLine = false;
    if (terminated) {
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    } else {
      const tail = lines.pop();
      halfLine = tail !== undefined && tail !== '';
    }

    let entry: PricingLedgerEntry | null = null;
    let corruptNewer = 0;
    let corruptOlder = 0;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (line === undefined || line === '') continue;
      const parsed = parseLedgerLine(line);
      if (parsed === null) {
        if (entry === null) corruptNewer += 1;
        else corruptOlder += 1;
        continue;
      }
      if (entry === null) entry = parsed;
      // 找到条目后继续向前扫：中段（更旧）损坏行计入 corruptLines 仅作披露
    }
    if (entry !== null) {
      return {
        kind: 'ok',
        entry,
        path,
        error: null,
        corruptLines: corruptNewer + corruptOlder,
        tailCorrupt: corruptNewer > 0 || halfLine,
        originNote: originNoteFor(entry.origin, origin),
      };
    }
    const corrupt = corruptNewer + corruptOlder + (halfLine ? 1 : 0);
    if (start === 0 || windowBytes >= stats.size) {
      return {
        kind: 'error',
        entry: null,
        path,
        error: '价格账本无有效条目（文件损坏或 schema 不符）',
        corruptLines: corrupt,
        tailCorrupt: false,
        originNote: null,
      };
    }
    if (windowBytes >= READ_WINDOW_MAX_BYTES) {
      return {
        kind: 'error',
        entry: null,
        path,
        error: '价格账本尾部窗口内无有效条目（条目过大或窗口不完整）',
        corruptLines: corrupt,
        tailCorrupt: false,
        originNote: null,
      };
    }
    windowBytes = Math.min(stats.size, windowBytes * 2);
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 锁记录：pid 判存活 + 随机 token 判「锁文件是否仍是同一把」。 */
interface LockRecord {
  pid: number;
  token: string;
}

const LOCK_TOKEN_RE = /^[0-9a-f]{32}$/;

/** 解析锁内容：新格式 `{"pid":N,"token":"<32hex>"}`；旧格式纯 pid 视为 token=''（升级兼容）。 */
function parseLockRecord(content: string): LockRecord | null {
  const trimmed = content.trim();
  if (trimmed === '') return null;
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { pid?: unknown; token?: unknown };
      if (
        typeof parsed.pid === 'number' &&
        Number.isInteger(parsed.pid) &&
        parsed.pid > 0 &&
        typeof parsed.token === 'string' &&
        LOCK_TOKEN_RE.test(parsed.token)
      ) {
        return { pid: parsed.pid, token: parsed.token };
      }
    } catch {
      // 非 JSON：落入旧格式解析
    }
    return null;
  }
  const pid = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { pid, token: '' };
}

/** 读取锁内容；读取失败（竞态下已释放/权限）返回 null。 */
function readLockContentOrNull(lockPath: string): string | null {
  try {
    return readFileSync(lockPath, 'utf8');
  } catch {
    return null;
  }
}

/** pid 可达性探测：ESRCH 等语义明确的错误 → 不可达；EPERM 等（进程存在但无权限）→ 可达。 */
function pidReachable(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return !(code === 'ESRCH' || code === 'ERR_PROCESS_NOT_FOUND' || code === 'ERR_OUT_OF_RANGE' || code === 'EINVAL');
  }
}

/** 本进程当前持有的锁（token 级）；删除陈旧锁前比对自己持有的锁，绝不自删。 */
let heldLock: { path: string; token: string } | null = null;

/**
 * 陈旧锁删除判定（可注入 readFn 以便单测模拟两次读之间 token 被换掉的竞态）：
 * - delete：mtime 超过 LOCK_STALE_MS、持锁 pid 不可达（或内容不可解析），且两次读取间 token 未变；
 * - keep：锁新鲜 / 持锁 pid 存活 / 锁是本进程自己持有的；
 * - retry：读取竞态失败，或两次读取间 token 已变（新主人已接管）——调用方不得删除，回到 acquire 循环重试。
 * 说明：两次读→unlink 之间仍存在窄窗口（unlink 无 compare-and-delete 语义），属收窄而非消除。
 */
export function shouldRemoveStaleLock(
  lockPath: string,
  now: number,
  readFn: (path: string) => string | null = readLockContentOrNull,
): 'delete' | 'keep' | 'retry' {
  if (heldLock !== null && heldLock.path === lockPath) return 'keep';
  const before = readFn(lockPath);
  if (before === null) return 'retry';
  const stats = statOrNull(lockPath);
  if (stats === null) return 'retry';
  if (now - stats.mtimeMs <= LOCK_STALE_MS) return 'keep';
  const record = parseLockRecord(before);
  if (record !== null && pidReachable(record.pid)) return 'keep';
  const after = readFn(lockPath);
  if (after === null) return 'retry';
  const afterRecord = parseLockRecord(after);
  // 全记录身份比较：pid+token 都未变才算同一把锁。旧式纯 pid 锁 token 统一为空串，
  // 若只比 token，「两次读间被换成另一把旧式锁（含持活 pid 的）」会被误判同一把而误删活锁；
  // after 侧再做一次 pid 可达性复检，兜住同号 pid 被复用为活进程的场景。
  if (record !== null && afterRecord !== null) {
    if (record.pid !== afterRecord.pid || record.token !== afterRecord.token) return 'retry';
    return pidReachable(afterRecord.pid) ? 'keep' : 'delete';
  }
  // 内容不可解析（半写/外域写入）：无从解析 pid/token，退化为原始内容相等比较。
  // 残余风险（登记在案）：持锁者为 60s+ 的不可解析锁写入方时仍可能被清，自身写入方恒为可解析 JSON。
  return before === after ? 'delete' : 'retry';
}

/**
 * 抢占式文件锁（O_EXCL 创建），锁内容为 {pid, token}。
 * 陈旧清理严格化：仅当「mtime 超过 LOCK_STALE_MS」且「锁内 pid 不可达/内容不可解析」且
 * 「两次读的 token 一致」时才删除；持锁 pid 仍存活时绝不夺锁（慢写入者如网络盘 fsync 卡顿
 * 持锁超阈值也不会被双写），而是重试到 LOCK_TIMEOUT_MS 后如实抛「价格账本被占用」。
 */
function acquireLock(lockPath: string): string {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const token = randomBytes(16).toString('hex');
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      writeSync(fd, `${JSON.stringify({ pid: process.pid, token })}\n`);
      closeSync(fd);
      heldLock = { path: lockPath, token };
      return token;
    } catch {
      // 锁已被占用：先查持锁者是否存活/陈旧，再按节奏重试
    }
    if (shouldRemoveStaleLock(lockPath, Date.now()) === 'delete') {
      try {
        unlinkSync(lockPath);
      } catch {
        // 竞争下未抢到删除：下轮 open 重试即可
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`价格账本被占用（锁等待超时 ${LOCK_TIMEOUT_MS}ms）：${lockPath}`);
    }
    sleepSync(LOCK_RETRY_MS);
  }
}

/** 释放锁：仅当锁文件仍是本进程获取的那把（token 一致）才删除，并清空模块态。 */
function releaseLock(lockPath: string, token: string): void {
  if (heldLock === null || heldLock.path !== lockPath || heldLock.token !== token) return;
  heldLock = null;
  try {
    unlinkSync(lockPath);
  } catch {
    // 锁文件已被陈旧清理或其他进程释放：无害
  }
}

/**
 * 在同一把文件锁内执行 fn；fn 收到的 appendLocked 在锁保护下完成「旋转 + 追加」。
 * 目的：pricing-watch 等「读→比→写」序列在多进程并发时不得交错（否则可能丢历史或重复判漂移）。
 */
export function withLedgerLock<T>(outDir: string, origin: string, fn: (appendLocked: (entry: PricingLedgerEntry) => string) => T): T {
  ensureLedgerDir(outDir);
  const path = ledgerPath(outDir, origin);
  const lockPath = `${path}.lock`;
  const token = acquireLock(lockPath);
  try {
    const appendLocked = (entry: PricingLedgerEntry): string => {
      assertLedgerFileSafe(path);
      rotateLedgerIfNeeded(path);
      appendLedgerLine(path, entry);
      rotateLedgerIfNeeded(path);
      return path;
    };
    return fn(appendLocked);
  } finally {
    releaseLock(lockPath, token);
  }
}

function toSnapshotModels(models: Record<string, DeclaredModelPricing>): Record<string, DeclaredPricingSnapshotModel> {
  const out: Record<string, DeclaredPricingSnapshotModel> = {};
  for (const [name, model] of Object.entries(models)) {
    out[name] = {
      modelRatio: model.modelRatio,
      completionRatio: model.completionRatio,
      cacheRatio: model.cacheRatio ?? null,
      modelPrice: model.modelPrice ?? null,
      quotaType: model.quotaType ?? null,
    };
  }
  return out;
}

/** 本轮抓取的 DeclaredPricing → 基线形状快照（含模型增删对比所需的完整表）。 */
export function snapshotFromDeclared(declared: DeclaredPricing): DeclaredPricingSnapshot {
  return {
    origin: declared.origin,
    capturedAt: declared.capturedAt,
    ...(declared.source !== undefined ? { source: declared.source } : {}),
    quotaPerUnit: declared.quotaPerUnit,
    ...(declared.quotaPerUnitSource !== undefined ? { quotaPerUnitSource: declared.quotaPerUnitSource } : {}),
    group: declared.group,
    models: toSnapshotModels(declared.models),
    groupRatio: { ...declared.groupRatio },
  };
}

/** 本轮抓取 + 目标模型标识 → 账本条目。 */
export function buildLedgerEntry(declared: DeclaredPricing, model: string): PricingLedgerEntry {
  return { schemaVersion: PRICING_LEDGER_SCHEMA, model, ...snapshotFromDeclared(declared) };
}

function readNumber(record: object | undefined, key: string): number | null {
  if (record === undefined) return null;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numericDrift(field: string, model: string | null, oldValue: number, newValue: number): PricingDrift {
  const relativeChange = oldValue !== 0 ? (newValue - oldValue) / Math.abs(oldValue) : null;
  const significant = relativeChange !== null && Math.abs(relativeChange) > DRIFT_REL_THRESHOLD + DRIFT_EPS;
  const direction: PricingDrift['direction'] =
    relativeChange === null ? 'unknown' : relativeChange > 0 ? 'up' : relativeChange < 0 ? 'down' : 'unknown';
  const message =
    relativeChange === null
      ? `由 ${oldValue} 变为 ${newValue}（旧值为 0 / 字段缺失，无法计算百分比）`
      : relativeChange > 0
        ? `由 ${oldValue} 上调至 ${newValue}（+${(relativeChange * 100).toFixed(1)}%）`
        : `由 ${oldValue} 下调至 ${newValue}（-${(Math.abs(relativeChange) * 100).toFixed(1)}%）`;
  return { kind: 'numeric', field, model, oldValue, newValue, relativeChange, direction, significant, message };
}

function groupNumericDrift(field: string, oldValue: number, newValue: number): PricingDrift {
  return { ...numericDrift(field, null, oldValue, newValue), kind: 'group_numeric' };
}

function presenceDrift(
  field: string,
  model: string | null,
  oldValue: number | null,
  newValue: number | null,
  significant: boolean,
): PricingDrift {
  const added = oldValue === null;
  const message = added ? `由（字段缺失）变为 ${newValue}` : `由 ${oldValue} 变为（字段缺失）`;
  return {
    kind: 'presence',
    field,
    model,
    oldValue,
    newValue,
    relativeChange: null,
    // presence 没有「上调/下调」语义（字段出现或消失 ≠ 数值方向）：统一按 unknown 透出，
    // 报告侧一律写「发生变化」，避免把模型增删渲染成「上调」。
    direction: 'unknown',
    significant,
    message,
  };
}

/**
 * 模型计费基准：quota_type=1 = 按次计费；0 = 按 token；无法确认 = unknown（不得臆断）。
 * 'unknown' 的存在很关键：旧条目/旧基线可能根本没有 quota_type 字段（存储口径演进），
 * 「没有这一列」不等于「当时是按 token 计费」——把它当成 per-token 就会把
 * 「站点改成按次计费」误报成假漂移，或把「旧条目缺列」误报成换基准。
 */
type ModelBasis = 'per-token' | 'per-call' | 'unknown';

/** 单侧计费证据：口径、是否显式公示、是否带有效倍率（决定各字段可不可信）。 */
interface BasisEvidence {
  basis: ModelBasis;
  /** quota_type 明确公示为 0/1：只有两侧都明确且不同，才敢断言「站点换了计费方式」。 */
  explicit: boolean;
  /** 有有效倍率（>0）：按 token 计费的正向证据，同时也是「model_price 只是遗留/装饰值」的证据。 */
  hasRatio: boolean;
}

/**
 * 单侧计费证据判定（矛盾证据不臆断）：
 * - quota_type 明确为 1 → 按次；明确为 0 → 按 token；
 * - quota_type 是站点自定义枚举 → 口径未知（不得当成按 token 的证据）；
 * - quota_type 未公示：公示了任一倍率（model_ratio 或 completion_ratio > 0）→ 按 token
 *   （站点公示了倍率就说明它按 token 计价；只看 model_ratio 会让「只公示 completion_ratio」的
 *   模型掉进按次分支，其 model_price 反而被当成可信单价 —— 同一类脏价假阳性的窄缝）；
 *   无倍率却有单价 → 按次（new-api 对按次计费的模型 model_ratio 恰为 0，计费依据是 model_price）；
 *   两者都没有 → 口径未知。
 */
function basisEvidence(
  quotaType: number | null | undefined,
  modelPrice: number | null | undefined,
  modelRatio: number | null | undefined,
  completionRatio: number | null | undefined,
): BasisEvidence {
  const explicit = quotaType === 0 || quotaType === 1;
  const positive = (value: number | null | undefined): boolean =>
    typeof value === 'number' && Number.isFinite(value) && value > 0;
  const hasRatio = positive(modelRatio) || positive(completionRatio);
  const hasPrice = positive(modelPrice);
  let basis: ModelBasis;
  if (quotaType === 1) basis = 'per-call';
  else if (quotaType === 0) basis = 'per-token';
  else if (quotaType !== null && quotaType !== undefined) basis = 'unknown';
  else if (hasRatio) basis = 'per-token';
  else if (hasPrice) basis = 'per-call';
  else basis = 'unknown';
  return { basis, explicit, hasRatio };
}

/** 倍率类字段是否可信：该侧没有被判为「按次计价」（按次口径下倍率不参与实收）。 */
function ratioTrusted(evidence: BasisEvidence): boolean {
  return evidence.basis !== 'per-call';
}

/**
 * 单价字段是否可信：必须没有被判为「按 token 计价」，且
 * 「未公示 quota_type 却同时有有效倍率」的矛盾组合下不可信——那个 model_price 是遗留/装饰值，
 * 拿它做显著比价就是本项修复针对的假阳性。
 */
function priceTrusted(evidence: BasisEvidence): boolean {
  if (evidence.basis === 'per-token') return false;
  return evidence.explicit || !evidence.hasRatio;
}

function basisLabel(basis: ModelBasis): string {
  if (basis === 'per-call') return '按次计费';
  if (basis === 'per-token') return '按 token 计费';
  return '计费基准未知';
}

/** 单侧口径的可读描述（披露用：区分「公示的」与「推定的」，别把推定说成事实）。 */
function basisDescription(evidence: BasisEvidence, side: '旧侧' | '新侧'): string {
  if (evidence.explicit) return `${side}公示为${basisLabel(evidence.basis)}`;
  if (evidence.basis === 'unknown') return `${side}未公示计费基准`;
  return `${side}未公示 quota_type（按${evidence.basis === 'per-call' ? '单价' : '倍率'}推定为${basisLabel(evidence.basis)}）`;
}

/** 口径断裂项：只披露「口径变了」，不产出任何数值比较结论（relativeChange 恒为 null）。 */
function basisDrift(
  field: string,
  model: string | null,
  oldValue: number | null,
  newValue: number | null,
  message: string,
  significant: boolean,
): PricingDrift {
  return {
    kind: 'basis',
    field,
    model,
    oldValue,
    newValue,
    relativeChange: null,
    direction: 'unknown',
    significant,
    message,
  };
}

function compareModelFields(
  previous: DeclaredPricingSnapshotModel | undefined,
  current: DeclaredPricingSnapshotModel | undefined,
  model: string,
  quotaUnitComparable: boolean,
): PricingDrift[] {
  const drifts: PricingDrift[] = [];
  const oldQuotaType = readNumber(previous, 'quotaType');
  const newQuotaType = readNumber(current, 'quotaType');
  const oldEvidence = basisEvidence(
    oldQuotaType,
    readNumber(previous, 'modelPrice'),
    readNumber(previous, 'modelRatio'),
    readNumber(previous, 'completionRatio'),
  );
  const newEvidence = basisEvidence(
    newQuotaType,
    readNumber(current, 'modelPrice'),
    readNumber(current, 'modelRatio'),
    readNumber(current, 'completionRatio'),
  );
  // 两侧都显式公示 quota_type 且不同 → 站点确实换了计费方式（必然影响金额）：
  // 只披露基准变更，不做任何数值比较（否则同一次换价会被拆成「倍率被偷改」的假漂移）。
  if (oldEvidence.explicit && newEvidence.explicit && oldEvidence.basis !== newEvidence.basis) {
    drifts.push(
      basisDrift(
        'quota_type',
        model,
        oldQuotaType,
        newQuotaType,
        `计费基准变更（${basisLabel(oldEvidence.basis)} → ${basisLabel(newEvidence.basis)}）：两侧计价口径不可比，本模型数值不比价`,
        true,
      ),
    );
    return drifts;
  }
  // 只要有一侧口径无法确认（或只是推定）：不得断言换基准，按可信一侧比价，
  // 跨到不可信一侧的字段一律降为非显著披露（见 ratioTrusted / priceTrusted）。
  // 口径选取优先级：显式公示 > 推定 > 缺省。显式证据必须压过推定证据——
  // 否则「旧侧公示按次、新侧只公示了倍率（推定按 token）」会被推定的按 token 盖住，
  // 按次单价的真实变化就被降级掉了。
  const explicitBasis = (evidence: BasisEvidence): 'per-token' | 'per-call' | null =>
    evidence.explicit && evidence.basis !== 'unknown'
      ? evidence.basis === 'per-call'
        ? 'per-call'
        : 'per-token'
      : null;
  const newExplicit = explicitBasis(newEvidence);
  const oldExplicit = explicitBasis(oldEvidence);
  const effectiveBasis: 'per-token' | 'per-call' =
    newExplicit ??
    oldExplicit ??
    (newEvidence.basis !== 'unknown'
      ? newEvidence.basis
      : oldEvidence.basis !== 'unknown'
        ? oldEvidence.basis
        : 'per-token');
  if (oldEvidence.basis !== newEvidence.basis || !oldEvidence.explicit || !newEvidence.explicit) {
    drifts.push(
      basisDrift(
        'quota_type',
        model,
        oldQuotaType,
        newQuotaType,
        `计费基准待确认（${basisDescription(oldEvidence, '旧侧')}，${basisDescription(newEvidence, '新侧')}）：按${
          effectiveBasis === 'per-call' ? '次计费' : ' token 计费'
        }口径比价，口径存疑的字段只作披露`,
        false,
      ),
    );
  }
  // 按次计费下金额只看 model_price，model_ratio/completion_ratio 不参与计价，比它们只是噪声；
  // 按 token 计费下 model_price 通常缺省，但 one-api 类框架按 token 计费时同样以 price 字段为准，
  // 所以仍要比它——只是不判显著（new-api 对按 token 模型也回 0/遗留值，判显著等于造假告警）。
  const perCall = effectiveBasis === 'per-call';
  const ratioOk = ratioTrusted(oldEvidence) && ratioTrusted(newEvidence);
  const priceOk = priceTrusted(oldEvidence) && priceTrusted(newEvidence);
  const pairs: Array<{ field: string; key: string; significant: boolean; caveat: string | null }> = perCall
    ? [
        {
          field: 'model_price',
          key: 'modelPrice',
          significant: priceOk,
          caveat: '该侧未公示 quota_type 却同时有有效倍率，其 model_price 是遗留/装饰值，不可作按次单价比对',
        },
      ]
    : [
        { field: 'model_ratio', key: 'modelRatio', significant: ratioOk, caveat: '存在按次计费的一侧，其倍率不参与实收' },
        { field: 'completion_ratio', key: 'completionRatio', significant: ratioOk, caveat: '存在按次计费的一侧，其倍率不参与实收' },
        { field: 'cache_ratio', key: 'cacheRatio', significant: ratioOk, caveat: '存在按次计费的一侧，其倍率不参与实收' },
        { field: 'model_price', key: 'modelPrice', significant: false, caveat: '按 token 计费口径下的附带字段' },
      ];
  for (const { field, key, significant, caveat } of pairs) {
    const oldValue = readNumber(previous, key);
    const newValue = readNumber(current, key);
    if (oldValue === null && newValue === null) continue;
    if (oldValue === null) {
      // 旧侧缺字段（旧条目/旧基线没有该列）：属账本 schema 演进的升级噪声，一律不判显著
      const item = presenceDrift(field, model, null, newValue, false);
      drifts.push({ ...item, message: `${item.message}（不判显著：旧侧缺该字段，属账本 schema 演进噪声）` });
      continue;
    }
    if (newValue === null) {
      drifts.push(presenceDrift(field, model, oldValue, null, significant));
      continue;
    }
    // 按次单价以 quota 计价：换算系数不一致时同一个数字对应不同金额，数值不可比。
    if (key === 'modelPrice' && !quotaUnitComparable) {
      drifts.push(
        basisDrift(
          'model_price',
          model,
          oldValue,
          newValue,
          '按次单价的 quota 换算系数两侧不一致：金额口径不可比，数值不比价',
          false,
        ),
      );
      continue;
    }
    if (oldValue === newValue) continue;
    const item = numericDrift(field, model, oldValue, newValue);
    if (significant) {
      drifts.push(item);
      continue;
    }
    // 被降级为披露的数值项必须写清降级理由，否则读者会把它当成「已排除的正常变化」。
    drifts.push({ ...item, significant: false, message: `${item.message}（不判显著：${caveat ?? '口径存疑'}）` });
  }
  return drifts;
}

/**
 * 对比历史快照与本次公示价，产出漂移项。
 * - scope.model 提供时：只对比该模型（两侧都按 lookupDeclaredModel 的归并规则解析；任一侧缺失 → 单条 presence 漂移）；
 * - 未提供时：按模型名精确匹配的全集对比（含模型增删）+ groupRatio 精确键对比。
 */
export function comparePricingSnapshots(
  previous: DeclaredPricingSnapshot,
  current: DeclaredPricing,
  scope: { model?: string | null } = {},
): PricingDrift[] {
  // 来源不同（含一侧缺省的 legacy 快照）不比较数值：API 倍率、公开价表、网页抓价的单位/口径不可互换。
  const previousSource = previous.source;
  const currentSource = current.source;
  const sameSource =
    (previousSource === undefined && currentSource === undefined) ||
    (previousSource !== undefined && currentSource !== undefined && previousSource === currentSource);
  if (!sameSource) return [];

  const drifts: PricingDrift[] = [];
  // 表级口径：quota 换算系数（$1 = N quota）决定「同一个数字对应多少钱」。
  // 系数变了 → 倍率不动也会改变实收金额（站点可能在不改倍率的情况下涨价）；
  // 系数来源不可比（CLI 覆盖 / 旧条目无来源）→ 只披露，不判站点漂移。
  const previousQpu = previous.quotaPerUnit;
  const currentQpu = current.quotaPerUnit;
  const previousQpuSource = previous.quotaPerUnitSource ?? 'none';
  const currentQpuSource = current.quotaPerUnitSource ?? 'none';
  if (previousQpu !== null && currentQpu !== null && previousQpu !== currentQpu) {
    const bothSite = previousQpuSource === 'site' && currentQpuSource === 'site';
    drifts.push(
      basisDrift(
        'quota_per_unit',
        null,
        previousQpu,
        currentQpu,
        bothSite
          ? `站点公示的 quota 每美元换算系数由 ${previousQpu} 变为 ${currentQpu}：倍率不变也会改变实收金额`
          : `quota 每美元换算系数由 ${previousQpu} 变为 ${currentQpu}（来源：${previousQpuSource} → ${currentQpuSource}）：金额口径不可比，只披露不比价`,
        bothSite,
      ),
    );
  } else if ((previousQpu === null) !== (currentQpu === null)) {
    // 只有一侧看得见换算系数：另一侧的数字对应多少钱无从对齐 → 只披露，不据此判漂移。
    drifts.push(
      basisDrift(
        'quota_per_unit',
        null,
        previousQpu,
        currentQpu,
        `quota 每美元换算系数仅${previousQpu === null ? '新' : '旧'}侧可见（${previousQpu ?? currentQpu}）：金额口径无法对齐，只披露不比价`,
        false,
      ),
    );
  }
  // 金额口径是否可比：两侧都没有系数（同一未知单位）或两侧系数相等 → 可比；
  // 只有「一侧有另一侧无」或「两侧不等」才不可比（按次单价不再做数值比较）。
  const quotaUnitComparable =
    previousQpu === null && currentQpu === null
      ? true
      : previousQpu !== null && currentQpu !== null && previousQpu === currentQpu;

  const scopeModel = scope.model !== undefined && scope.model !== null && scope.model.trim() !== '' ? scope.model : null;

  if (scopeModel !== null) {
    const prevHit = lookupDeclaredModel(previous, scopeModel);
    const curHit = lookupDeclaredModel(current, scopeModel);
    if (prevHit === null && curHit === null) return drifts;
    if (prevHit === null || curHit === null) {
      drifts.push(presenceDrift('model', scopeModel, prevHit === null ? null : 1, curHit === null ? null : 1, true));
      return drifts;
    }
    drifts.push(...compareModelFields(prevHit.model, curHit.model, scopeModel, quotaUnitComparable));
    return drifts;
  }

  const modelKeys = new Set([...Object.keys(previous.models), ...Object.keys(current.models)]);
  for (const key of modelKeys) {
    const prevModel = previous.models[key];
    const curModel = current.models[key];
    if (prevModel === undefined || curModel === undefined) {
      drifts.push(presenceDrift('model', key, prevModel === undefined ? null : 1, curModel === undefined ? null : 1, true));
      continue;
    }
    drifts.push(...compareModelFields(prevModel, curModel, key, quotaUnitComparable));
  }

  const groupKeys = new Set([...Object.keys(previous.groupRatio), ...Object.keys(current.groupRatio)]);
  for (const key of groupKeys) {
    const prevRatio = previous.groupRatio[key];
    const curRatio = current.groupRatio[key];
    if (prevRatio === undefined || curRatio === undefined) {
      drifts.push(
        presenceDrift(`group_ratio:${key}`, null, prevRatio === undefined ? null : prevRatio, curRatio === undefined ? null : curRatio, true),
      );
      continue;
    }
    if (prevRatio === curRatio) continue;
    drifts.push(groupNumericDrift(`group_ratio:${key}`, prevRatio, curRatio));
  }
  return drifts;
}
