// src/gateway/server.ts — 多渠道别名网关（数据面，OpenAI + Anthropic + 统一中转）。
// 覆盖范围（文档化）：GET /v1/models、POST /v1/chat/completions、POST /v1/responses（OpenAI 协议）、
// POST /v1/messages 与 POST /v1/messages/count_tokens（Anthropic Messages 协议）五条路由；其余路径一律 404。
// 渠道协议（protocol）：unified=统一中转（按客户端请求格式透传，五条路由全可用）；openai=仅 OpenAI（chat/responses）；anthropic=仅 Anthropic Messages。
// 安全基线：
//   - 仅监听 127.0.0.1；客户端凭证为独立随机虚拟 key（与任何上游 key 无关），常量时间比较；
//     Anthropic 路由接受 x-api-key: <virtualKey> 或 Authorization: Bearer <virtualKey>，两者任一命中；
//   - 上游目标逐请求重解析并钉定公网 IPv4（见 ssrf.ts）；不跟随重定向；3xx 一律转 502 且不外发 Location；
//   - 上游请求头使用 allowlist，入站 Authorization/hop-by-hop 一律剥离，上游 key 仅在此处注入
//     （OpenAI 请求 chat/responses → Authorization: Bearer <渠道key>；Anthropic 请求 → x-api-key: <渠道key>）；
//   - 无重试、无回退、无熔断声明：一个别名恰好路由到一个渠道，失败即如实返回错误。
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { stripHopHeaders, validateRequestTarget } from '../guard/server.js';
import { sameModelId } from '../guard/model-id.js';
import type {
  LedgerClientStatus,
  LedgerErrorSource,
  LedgerRequestInput,
  LedgerSettlementInput,
  LedgerStats,
  LedgerTokenMissingReason,
} from '../ledger/ledger.js';
import {
  SseParser,
  anthropicContentHasSignal,
  extractText,
  mapAnthropicStopReason,
  mapAnthropicUsage,
  mapResponsesUsage,
  parseAnthropicStreamPayload,
  parseResponsesStreamPayload,
  parseStreamPayload,
  responsesContentHasSignal,
  validateUsage,
  type StreamChunk,
} from '../sse.js';
import type { Usage, UsageRejection } from '../types.js';
import { ChannelError, ChannelStore, noteChannelResult, type ChannelRecord } from './channels.js';
import { computeCostUsd } from './pricing.js';
import { defaultDnsLookup, pinnedLookup, resolvePinnedUpstream, type DnsLookup } from './ssrf.js';

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 300_000;
/** 客户端 → 上游允许携带的请求头（OpenAI 协议 allowlist）；其余（含 Authorization）一律不转发。 */
const CLIENT_HEADER_ALLOWLIST = new Set(['content-type', 'accept']);
/** Anthropic 协议额外允许透传的客户端头（仅 anthropic-version/anthropic-beta 两项，不扩大其他头）。 */
const ANTHROPIC_HEADER_ALLOWLIST = new Set(['content-type', 'accept', 'anthropic-version', 'anthropic-beta']);
/** OpenAI 协议路由：Bearer <虚拟 key> 鉴权。 */
const OPENAI_ROUTES = new Set(['/v1/models', '/v1/chat/completions', '/v1/responses']);
/** Anthropic Messages 协议路由：x-api-key 或 Bearer <虚拟 key> 任一鉴权。 */
const ANTHROPIC_ROUTES = new Set(['/v1/messages', '/v1/messages/count_tokens']);
/** 非 SSE 响应的旁路观测缓冲上限：超出即放弃观测并计数（绝不影响转发，也绝不无限吃内存）。 */
const MAX_OBSERVE_BYTES = 2 * 1024 * 1024;
/** 每渠道观测窗口条数（S3-lite 告警规则只在窗口内评估）。 */
const CHANNEL_WINDOW_SIZE = 100;
/** 告警事件环形缓冲上限（events() 最新在前）。 */
const ALERT_EVENT_CAPACITY = 200;
/** 同一 (渠道, 告警类别) 的冷却期：防同一问题重复轰炸。 */
const ALERT_COOLDOWN_MS = 30 * 60_000;
/** 网关启动后告警静默期（生产默认 5 分钟，防进程重启导致告警风暴；测试可注入 0）。 */
const DEFAULT_ALERT_SILENCE_MS = 5 * 60_000;
/** TTFT 污染防护阈值：事件循环滞后（延迟直方图窗口最大值）≥ 阈值 ms 的样本剔除、不进分位；可经选项注入（测试）。 */
const DEFAULT_LOOP_LAG_THRESHOLD_MS = 50;
/** TTFT（上游口径）样本环形容量与 provisional 阈值：n<20 不披露 p95，仅给 p50 供趋势参考。 */
const TTFT_RING_CAPACITY = 100;
const TTFT_PROVISIONAL_SAMPLES = 20;
/** usage 有效率告警的最小样本量（小样本比率抖动大，不报）。 */
const USAGE_INVALID_MIN_SAMPLES = 10;
/** TTFT 偏高告警（ttft_high）：未污染样本 n≥20 且 p95≥300ms（绝对下限，防低样本抖动与小幅波动）。
 *  与规格原文「TTFT 漂移」的区别：本版只做单窗口绝对下限判定；与历史基线/相邻窗口比较的「漂移」属后续切片，命名如实不叫 drift。 */
const TTFT_HIGH_MIN_SAMPLES = 20;
const TTFT_HIGH_P95_MS = 300;

export interface GatewayStatus {
  port: number;
  uptimeMs: number;
  channelCount: number;
  enabledChannelCount: number;
  requests: { total: number; ok: number; error: number };
  lastError: { at: number; message: string } | null;
  /** 账本健康（degraded 期统计有缺口，UI 必须披露；账本故障 fail-open，绝不影响转发）。 */
  degraded: { writeErrors: number; degraded: boolean; recovered: number };
  /** 告警事件环形缓冲当前条数（事件明细见 events()）。 */
  alertEvents: number;
  /** 旁路观测自身的健康计数（SSE/JSON 解析异常 + 内存统计异常；只计数，绝不影响转发）。 */
  teeErrors: number;
  /** 观测被放弃的次数（如非 SSE 响应体超过观测上限）。 */
  observeSkipped: number;
  /** 告警启动静默期剩余毫秒（>0 期间不评估任何告警——UI 必须披露，防「没告警=没异常」的假安心）。 */
  alertSilenceRemainingMs: number;
  /** 因 30 分钟冷却（同渠道同类别）被抑制的告警次数（这类告警绝不进入 events(); 持续故障只留最早一条）。
   *  口径：只计冷却抑制（规则已触发但被冷却拦下）——静默期内规则根本不评估，不冒充「抑制了告警」。 */
  alertSuppressed: number;
  /** 启动静默期一旦生效即 permanent 置位（静默期结束后仍可见：期间告警从未被评估，不能因 remainingMs 归零就当「检查过没问题」）。 */
  alertSilenceWasActive: boolean;
}

/** 网关内存实时用量行（与账本 usageSummary 同口径；服务重启即清零，账本才是权威账）。 */
export interface GatewayUsageRow {
  channelId: string;
  alias: string;
  requests: number;
  ok: number;
  error: number;
  tokenPrompt: number;
  tokenCompletion: number;
  tokenCached: number;
  tokenReasoning: number;
  /** 本进程累计费用（USD；按请求结算时刻的渠道配置价累加；渠道未录价/已删除 → null，绝不显示误导性的 $0）。 */
  costUsd: number | null;
  usageValid: number;
  usageMissing: number;
  usageInvalid: number;
  /** usageValid / (usageValid + usageMissing + usageInvalid)；无样本为 null。 */
  usageValidRate: number | null;
  truncated: number;
  /** TTFT（上游口径）未污染样本数（进分位的样本）。 */
  ttftSamples: number;
  /** 因事件循环滞后被剔除、不进分位的 TTFT 样本数。 */
  ttftContaminated: number;
  /** 干净样本因环形缓冲溢出被淘汰的累计条数（守恒：samplesSeen = ttftSamples + ttftEvicted + ttftContaminated）。 */
  ttftEvicted: number;
  ttftP50Ms: number | null;
  /** n<20 不披露（样本不足）；n≥20 时为 nearest-rank p95。 */
  ttftP95Ms: number | null;
  /** n<20：样本不足（p95 不出，p50 仅供趋势参考）。 */
  provisional: boolean;
}

export type GatewayAlertKind = 'model_mismatch' | 'error_rate' | 'truncated' | 'usage_invalid' | 'ttft_high';

/** 网关告警事件（S3-lite：窗口规则触发 + 每 (渠道,类别) 30 分钟冷却）。 */
export interface GatewayAlertEvent {
  ts: number;
  channel: string;
  kind: GatewayAlertKind;
  /** 证据请求 id（最多 10 条，可用账本 settlementsOf 下钻核对）。 */
  evidence_request_ids: string[];
  /** 评估窗口内的观测条数（ttft_high 传未污染样本数，其余类别传全窗口条数）。 */
  n: number;
  /** 观测值（比率类为比率，计数类为计数）。 */
  observed: number;
}

/**
 * 账本最小接口（Ledger 实现之；测试可注入桩验证 fail-open）。
 * 网关对账本的所有调用都包 try/catch：账本故障绝不影响转发。
 */
export interface GatewayLedger {
  recordRequest(entry: LedgerRequestInput): string | null;
  settle(entry: LedgerSettlementInput): boolean;
  stats(): LedgerStats;
}

export interface AliasGatewayOptions {
  port?: number;
  upstreamTimeoutMs?: number;
  /** 测试注入的 DNS 解析器（生产使用系统解析）；生产路径不得注入。 */
  lookup?: DnsLookup;
  /** 测试注入的物理连接改写（把钉定 IP 指向本地 mock）；生产路径不得注入。 */
  mapSocket?: (target: { host: string; port: number }) => { host: string; port: number };
  /** 账本（可选）：缺省 undefined 时网关行为与不带账本完全一致（内存用量统计照常工作）。 */
  ledger?: GatewayLedger;
  /** 外部注入的持久渠道表（控制台持有）：缺省自建独立 store；注入后数据面与控制台看到同一份渠道（跨启停保留）。 */
  store?: ChannelStore;
  /** 告警启动静默期毫秒（测试注入 0；缺省 5 分钟）。 */
  alertSilenceMs?: number;
  /** TTFT 污染判定阈值毫秒（测试可注入；缺省 50：事件循环滞后 ≥ 阈值的样本剔除、不进分位）。 */
  loopLagThresholdMs?: number;
  onLog?: (line: string) => void;
}

export interface AliasGateway {
  port: number;
  readonly virtualKey: string;
  rotateVirtualKey(): string;
  store: ChannelStore;
  status(): GatewayStatus;
  /** 按 (channelId, alias) 的内存实时用量（服务启动起算；账本是权威账，本值供 UI 实时展示）。 */
  usageSummary(): GatewayUsageRow[];
  /** 告警事件（最新在前）。 */
  events(): GatewayAlertEvent[];
  close(): Promise<void>;
}

/** 结算归因（client_status + error_source）：error_source 分离归因，渠道评分只消费 upstream，绝不冤枉渠道。 */
interface LedgerVerdict {
  clientStatus: LedgerClientStatus;
  errorSource: LedgerErrorSource | null;
  errorClass?: string | null;
}

const VERDICT_OK: LedgerVerdict = { clientStatus: 'ok', errorSource: null };
/** 上游非 2xx / 3xx 拒绝：客户端侧仍完整送达了上游的答复，但归因上游。 */
const VERDICT_UPSTREAM_RELAYED: LedgerVerdict = { clientStatus: 'ok', errorSource: 'upstream' };
const VERDICT_UPSTREAM_TRUNCATED: LedgerVerdict = { clientStatus: 'truncated', errorSource: 'upstream' };
const VERDICT_UPSTREAM_TIMEOUT: LedgerVerdict = { clientStatus: 'timeout', errorSource: 'upstream' };
const VERDICT_CLIENT_ABORT: LedgerVerdict = { clientStatus: 'aborted', errorSource: 'client' };

/** 旁路观测帧解析口径（由请求种类推导，与渠道协议解耦：统一中转渠道的观测不问渠道协议）。 */
type TeeFormat = 'chat' | 'messages' | 'responses';

/** 旁路观测（tee）状态：独立 data 监听器只读旁听，绝不做 backpressure、绝不重写转发路径。 */
interface TeeObservation {
  /** 帧解析口径：chat/responses 各走 OpenAI 系解析器；messages 走 Anthropic 解析器（非流式走对应 JSON 提取）。 */
  format: TeeFormat;
  sse: boolean;
  decoder: StringDecoder | null;
  parser: SseParser | null;
  buffer: Buffer[] | null;
  bufferedBytes: number;
  skipped: boolean;
  ended: boolean;
  usage: Usage | null;
  usageReason: UsageRejection | null;
  usageFrameSeen: boolean;
  model: string | null;
  finishReason: string | null;
  ttftMs: number | null;
  /** 该 TTFT 样本是否因事件循环滞后被污染（剔除判定，不影响评分）。 */
  ttftContaminated: boolean;
  firstContentSeen: boolean;
}

interface UsageCounters {
  requests: number;
  ok: number;
  error: number;
  tokenPrompt: number;
  tokenCompletion: number;
  tokenCached: number;
  tokenReasoning: number;
  /** 按结算时刻渠道配置价逐请求累加的 USD 费用（未录价请求不计入；缺口由 usageMissing/usageInvalid 披露）。 */
  costUsd: number;
  usageValid: number;
  usageMissing: number;
  usageInvalid: number;
  truncated: number;
  ttftSamples: number[];
  ttftContaminated: number;
  ttftEvicted: number;
}

interface ChannelObservation {
  id: string;
  ts: number;
  mismatch: boolean;
  usageInvalid: boolean;
  error: boolean;
  truncated: boolean;
  /** 上游口径原始 TTFT（ms，单调时钟）；无首内容帧为 null。 */
  ttftMs: number | null;
  /** 该 TTFT 样本是否因事件循环滞后被判定污染（剔除分位，但保留原始值）。 */
  ttftContaminated: boolean;
}

function constantTimeEqual(a: string, b: string): boolean {
  // 与 guard 同款：先哈希到定长再比较，杜绝长度不等提前短路泄露凭证长度。
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

function respondJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent || res.destroyed) return;
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

/** OpenAI 兼容错误体；消息中绝不包含任何密钥（上游 key 不进入任何错误路径）。 */
function respondError(res: ServerResponse, status: number, code: string, message: string): void {
  const type =
    status === 401 ? 'authentication_error' : status === 404 || status === 400 || status === 409 || status === 413 ? 'invalid_request_error' : 'api_error';
  respondJson(res, status, { error: { message, code, type } });
}

/** 客户端口径 TTFT 读取器：handleRequest 安装（包裹 res.write/writeHead/end 捕获首写），
 *  forwardUpstreamRequest 在结算时读取——双口径铁律的另一半，跨函数传值不改 res 类型。 */
const clientTtftByResponse = new WeakMap<ServerResponse, () => number | null>();

export async function createAliasGateway(options: AliasGatewayOptions = {}): Promise<AliasGateway> {
  const portArg = Number(options.port ?? 0);
  const timeoutMs = options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  const lookup = options.lookup ?? defaultDnsLookup;
  const mapSocket = options.mapSocket ?? ((target: { host: string; port: number }) => target);
  const onLog = options.onLog ?? (() => undefined);
  const store = options.store ?? new ChannelStore();
  const startedAt = Date.now();
  const ledger = options.ledger ?? null;
  const silenceArg = Number(options.alertSilenceMs ?? DEFAULT_ALERT_SILENCE_MS);
  const alertSilenceUntil = Date.now() + (Number.isFinite(silenceArg) ? Math.max(0, silenceArg) : DEFAULT_ALERT_SILENCE_MS);
  const lagArg = Number(options.loopLagThresholdMs ?? DEFAULT_LOOP_LAG_THRESHOLD_MS);
  const loopLagThresholdMs = Number.isFinite(lagArg) ? Math.max(0, lagArg) : DEFAULT_LOOP_LAG_THRESHOLD_MS;
  /** TTFT 污染判定用事件循环延迟直方图（纳秒口径）：每定一次 TTFT 读取并清零窗口，窗口=距上一 TTFT 样本。 */
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable(); // 显式启用，勿只依赖默认态
  let virtualKey = makeVirtualKey();
  const counters = { total: 0, ok: 0, error: 0 };
  /** 账本调用抛错次数（record/settle 失败；stats() 不可用时的兜底计数，与 stats().writeErrors 合并披露）。 */
  let ledgerErrors = 0;
  /** 请求行未落账而被跳过的结算次数（防孤儿 settlement 扭曲用量汇总；并入 degraded.writeErrors 披露）。 */
  let ledgerSettleSkipped = 0;
  /** stats() 最近一次读取是否失败（粘性标志：不可读也必须披露降级；幂等，不随轮询膨胀计数）。 */
  let ledgerStatsFailed = false;
  /** 旁路观测自身健康计数（解析异常/超限跳过；只计数，绝不影响转发）。 */
  let teeErrors = 0;
  let observeSkipped = 0;
  const usageCounters = new Map<string, Map<string, UsageCounters>>();
  const channelWindows = new Map<string, ChannelObservation[]>();
  const alertEvents: GatewayAlertEvent[] = [];
  const alertCooldown = new Map<string, number>();
  /** 因冷却被抑制的告警次数（不会出现在 events()——持续故障只留最早一条；UI 必须披露防低估在燃问题）。 */
  let alertSuppressed = 0;
  /** 启动静默期是否曾生效（粘性：结束也保持 true，供 UI 永久披露「静默期覆盖过的请求从未被评估」）。 */
  let alertSilenceWasActive = false;
  let lastError: { at: number; message: string } | null = null;

  function makeVirtualKey(): string {
    return `sk-mx-${randomBytes(24).toString('base64url')}`;
  }
  function noteError(message: string): void {
    lastError = { at: Date.now(), message };
  }

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        respondError(res, 500, 'internal_error', `网关内部错误：${error instanceof Error ? error.message : String(error)}`);
      } else {
        res.destroy();
      }
    });
  });
  server.keepAliveTimeout = 75_000;

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // ⓪ 客户端口径 TTFT 打点（双口径铁律，独立于上游口径）：客户端请求进网关 → 向客户端写出首个字节。
    //    包裹 res.write 一次性捕获首写；错误响应（401/404/502/504）同样产生首字节，也如实计入；
    //    全程无写入（无 body/纯 HEAD 等）才保持 NULL——绝不写 0 冒充。时钟与上游口径同为 performance.now 单调时钟。
    const requestReceivedAtMs = performance.now();
    let clientTtftMs: number | null = null;
    /** 首字节打点三通道：write（首个 body 块）、writeHead（状态行首字节，TTFB 常规口径）、end（隐式头兜底）。
     *  settle 可能发生在响应写出之前（如上游 500 先结算再转发），故同时包住写头，冻结时机不再决定口径真伪。 */
    const rawWrite = res.write.bind(res);
    res.write = ((...args: Array<unknown>) => {
      if (clientTtftMs === null) clientTtftMs = performance.now() - requestReceivedAtMs;
      return (rawWrite as (...inner: Array<unknown>) => boolean)(...args);
    }) as typeof res.write;
    const rawWriteHead = res.writeHead.bind(res);
    res.writeHead = ((...args: Array<unknown>) => {
      if (clientTtftMs === null) clientTtftMs = performance.now() - requestReceivedAtMs;
      return (rawWriteHead as (...inner: Array<unknown>) => ServerResponse)(...args);
    }) as unknown as typeof res.writeHead;
    const rawEnd = res.end.bind(res);
    res.end = ((...args: Array<unknown>) => {
      if (clientTtftMs === null) clientTtftMs = performance.now() - requestReceivedAtMs;
      return (rawEnd as (...inner: Array<unknown>) => ServerResponse)(...args);
    }) as unknown as typeof res.end;
    // 供 forwardUpstreamRequest 结算时读取客户端口径 TTFT（每次写头部/字节时实时更新，结算时刻读最新值）
    clientTtftByResponse.set(res, () => clientTtftMs);
    // ① 请求目标校验（防 SSRF/穿越；复用 guard 的既有防线）
    const target = validateRequestTarget(req.url ?? '/');
    if (!target.ok || target.path === null) {
      respondError(
        res,
        target.status,
        'invalid_request_target',
        `${target.message}。网关仅覆盖 POST /v1/chat/completions、POST /v1/responses、POST /v1/messages、POST /v1/messages/count_tokens 与 GET /v1/models。`,
      );
      req.resume();
      return;
    }
    const path = target.path;

    // 路由白名单：五条（OpenAI 三条 + Anthropic 两条），其余一律 404
    if (!OPENAI_ROUTES.has(path) && !ANTHROPIC_ROUTES.has(path)) {
      respondError(
        res,
        404,
        'not_found',
        '网关仅覆盖 POST /v1/chat/completions、POST /v1/responses、POST /v1/messages、POST /v1/messages/count_tokens 与 GET /v1/models 五条路由（model 字段按别名路由到单一渠道，不做回退）。请勿将其他 OpenAI/Anthropic 端点指向本网关。',
      );
      req.resume();
      return;
    }

    // ② 数据面鉴权（独立随机虚拟 key，与上游 key 无关，常量时间比较）：
    //    OpenAI 路由：必须 Bearer <虚拟 key>；
    //    Anthropic 路由：x-api-key: <虚拟 key> 或 Authorization: Bearer <虚拟 key> 任一命中。
    const authHeader = typeof req.headers['authorization'] === 'string' ? req.headers['authorization'] : '';
    if (OPENAI_ROUTES.has(path)) {
      if (!constantTimeEqual(authHeader, `Bearer ${virtualKey}`)) {
        respondError(
          res,
          401,
          'invalid_api_key',
          '鉴权失败：请把客户端 API key 设置为网关虚拟 key（Authorization: Bearer <virtualKey>）。虚拟 key 与上游渠道 key 无关，可在控制台网关面板查看。',
        );
        req.resume();
        return;
      }
    } else {
      const apiKeyHeader = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : '';
      // 两个比较都执行（不做短路），避免「先命中哪种凭证」产生时序侧信道
      const bearerOk = constantTimeEqual(authHeader, `Bearer ${virtualKey}`);
      const apiKeyOk = constantTimeEqual(apiKeyHeader, virtualKey);
      if (!bearerOk && !apiKeyOk) {
        respondError(
          res,
          401,
          'invalid_api_key',
          '鉴权失败：请携带网关虚拟 key——Anthropic 客户端用 x-api-key: <virtualKey>，或 Authorization: Bearer <virtualKey>。虚拟 key 与上游渠道 key 无关，可在控制台网关面板查看。',
        );
        req.resume();
        return;
      }
    }

    if (path === '/v1/models') {
      if (req.method !== 'GET') {
        respondError(res, 404, 'not_found', '该路径仅支持 GET /v1/models。');
        req.resume();
        return;
      }
      const created = Math.floor(startedAt / 1000);
      const data = store
        .list()
        .filter((channel) => channel.enabled)
        .flatMap((channel) => channel.models.map((alias) => ({ id: alias, object: 'model', created, owned_by: channel.label })));
      counters.total += 1; // /v1/models 只进网关内存计数（规格口径），不写账本
      counters.ok += 1;
      respondJson(res, 200, { object: 'list', data });
      return;
    }

    // ③ POST /v1/messages 与 POST /v1/messages/count_tokens（Anthropic Messages 协议）
    if (ANTHROPIC_ROUTES.has(path)) {
      if (req.method !== 'POST') {
        respondError(res, 404, 'not_found', `该路径仅支持 POST ${path}。`);
        req.resume();
        return;
      }
      let anthropicBody: Record<string, unknown>;
      try {
        anthropicBody = await readJsonBody(req);
      } catch (error) {
        const status = error instanceof BodyTooLargeError ? 413 : 400;
        const code = status === 413 ? 'payload_too_large' : 'invalid_body';
        respondError(res, status, code, error instanceof Error ? error.message : String(error));
        return;
      }
      const anthropicModel = anthropicBody['model'];
      if (typeof anthropicModel !== 'string' || anthropicModel.trim() === '') {
        respondError(
          res,
          400,
          'invalid_body',
          `请求体缺少 model 字段或非字符串：收到值 ${JSON.stringify(anthropicModel ?? null)}。示例：{"model":"claude-x","max_tokens":1024,"messages":[...]}`,
        );
        return;
      }
      const anthropicAlias = anthropicModel.trim();
      if (path === '/v1/messages') {
        // Anthropic Messages 协议要求 max_tokens 必填且为正整数（缺失会让上游 400，网关提前拒绝并给出修法）
        const maxTokens = anthropicBody['max_tokens'];
        if (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens <= 0) {
          respondError(
            res,
            400,
            'invalid_body',
            `max_tokens 必填且必须为正整数：收到值 ${JSON.stringify(maxTokens ?? null)}。示例：{"model":"claude-x","max_tokens":1024,"messages":[...]}`,
          );
          return;
        }
      }
      const anthropicChannel = store.findByAlias(anthropicAlias);
      if (anthropicChannel === null) {
        const owner = store.list().find((entry) => entry.models.includes(anthropicAlias));
        if (owner !== undefined) {
          respondError(res, 404, 'model_not_found', `model 别名 ${JSON.stringify(anthropicAlias)} 所属渠道已停用（enabled=false），网关不做回退。请在控制台启用该渠道或改用其他别名。`);
        } else {
          respondError(res, 404, 'model_not_found', `未知 model 别名 ${JSON.stringify(anthropicAlias)}：请先经控制台 API 添加渠道并在 models 中声明该别名，或改用 GET /v1/models 列出的别名。`);
        }
        return;
      }
      // 协议门禁：Anthropic 路由只服务 anthropic/unified 协议渠道（跨协议必须显式改路由，绝不静默换协议）
      if (anthropicChannel.protocol === 'openai') {
        respondError(
          res,
          409,
          'protocol_mismatch',
          `协议不匹配：model 别名 ${JSON.stringify(anthropicAlias)} 属于 OpenAI 协议渠道 ${JSON.stringify(anthropicChannel.label)}，不能经 POST ${path} 调用。请改用 POST /v1/chat/completions（OpenAI 协议）；若该上游实为统一中转站（同时支持多协议），请把渠道 protocol 改为 "unified"。`,
        );
        return;
      }
      await forwardUpstreamRequest(req, res, {
        body: anthropicBody,
        alias: anthropicAlias,
        channel: anthropicChannel,
        kind: path === '/v1/messages' ? 'messages' : 'count_tokens',
        clientPath: path,
      });
      return;
    }

    // ④ POST /v1/responses（OpenAI Responses 协议；unified 渠道按客户端请求格式透传）
    if (path === '/v1/responses') {
      if (req.method !== 'POST') {
        respondError(res, 404, 'not_found', '该路径仅支持 POST /v1/responses。');
        req.resume();
        return;
      }
      let responsesBody: Record<string, unknown>;
      try {
        responsesBody = await readJsonBody(req);
      } catch (error) {
        const status = error instanceof BodyTooLargeError ? 413 : 400;
        const code = status === 413 ? 'payload_too_large' : 'invalid_body';
        respondError(res, status, code, error instanceof Error ? error.message : String(error));
        return;
      }
      const responsesModel = responsesBody['model'];
      if (typeof responsesModel !== 'string' || responsesModel.trim() === '') {
        respondError(res, 400, 'invalid_body', `请求体缺少 model 字段或非字符串：收到值 ${JSON.stringify(responsesModel ?? null)}。示例：{"model":"gpt-4o","input":"hi"}`);
        return;
      }
      const responsesAlias = responsesModel.trim();
      const responsesChannel = store.findByAlias(responsesAlias);
      if (responsesChannel === null) {
        const owner = store.list().find((entry) => entry.models.includes(responsesAlias));
        if (owner !== undefined) {
          respondError(res, 404, 'model_not_found', `model 别名 ${JSON.stringify(responsesAlias)} 所属渠道已停用（enabled=false），网关不做回退。请在控制台启用该渠道或改用其他别名。`);
        } else {
          respondError(res, 404, 'model_not_found', `未知 model 别名 ${JSON.stringify(responsesAlias)}：请先经控制台 API 添加渠道并在 models 中声明该别名，或改用 GET /v1/models 列出的别名。`);
        }
        return;
      }
      // 协议门禁：Responses 路由只服务 openai/unified 协议渠道（跨协议必须显式改路由，绝不静默换协议）
      if (responsesChannel.protocol === 'anthropic') {
        respondError(
          res,
          409,
          'protocol_mismatch',
          `协议不匹配：model 别名 ${JSON.stringify(responsesAlias)} 属于 Anthropic 协议渠道 ${JSON.stringify(responsesChannel.label)}，不能经 POST /v1/responses 调用。请改用 POST /v1/messages（Anthropic Messages 协议）；若该上游实为统一中转站（同时支持多协议），请把渠道 protocol 改为 "unified"。`,
        );
        return;
      }
      await forwardUpstreamRequest(req, res, { body: responsesBody, alias: responsesAlias, channel: responsesChannel, kind: 'responses', clientPath: '/v1/responses' });
      return;
    }

    // ⑤ POST /v1/chat/completions（OpenAI 协议）
    if (req.method !== 'POST') {
      respondError(res, 404, 'not_found', '该路径仅支持 POST /v1/chat/completions。');
      req.resume();
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      const status = error instanceof BodyTooLargeError ? 413 : 400;
      const code = status === 413 ? 'payload_too_large' : 'invalid_body';
      respondError(res, status, code, error instanceof Error ? error.message : String(error));
      return;
    }
    const model = body['model'];
    if (typeof model !== 'string' || model.trim() === '') {
      respondError(res, 400, 'invalid_body', `请求体缺少 model 字段或非字符串：收到值 ${JSON.stringify(model ?? null)}。示例：{"model":"gpt-4o","messages":[...]}`);
      return;
    }
    const alias = model.trim();
    const channel = store.findByAlias(alias);
    if (channel === null) {
      const owner = store.list().find((entry) => entry.models.includes(alias));
      if (owner !== undefined) {
        respondError(res, 404, 'model_not_found', `model 别名 ${JSON.stringify(alias)} 所属渠道已停用（enabled=false），网关不做回退。请在控制台启用该渠道或改用其他别名。`);
      } else {
        respondError(res, 404, 'model_not_found', `未知 model 别名 ${JSON.stringify(alias)}：请先经控制台 API 添加渠道并在 models 中声明该别名，或改用 GET /v1/models 列出的别名。`);
      }
      return;
    }
    // 协议门禁：OpenAI 路由只服务 openai/unified 协议渠道（跨协议必须显式改路由，绝不静默换协议）
    if (channel.protocol === 'anthropic') {
      respondError(
        res,
        409,
        'protocol_mismatch',
        `协议不匹配：model 别名 ${JSON.stringify(alias)} 属于 Anthropic 协议渠道 ${JSON.stringify(channel.label)}，不能经 POST /v1/chat/completions 调用。请改用 POST /v1/messages（Anthropic Messages 协议）；若该上游实为统一中转站（同时支持多协议），请把渠道 protocol 改为 "unified"。`,
      );
      return;
    }
    await forwardUpstreamRequest(req, res, { body, alias, channel, kind: 'chat', clientPath: '/v1/chat/completions' });
  }

  /** 构建上游请求头：hop-by-hop 剥离 + 按请求协议 allowlist 透传客户端头 + 强制注入渠道 key。
   *  OpenAI 请求（chat/responses）→ Authorization: Bearer <渠道key>；Anthropic 请求 → x-api-key: <渠道key>（缺失时补 anthropic-version 默认值）。
   *  客户端自带的 authorization / x-api-key 一律先剔除再注入，绝不让客户端凭证或旧头透传到上游。 */
  function buildUpstreamHeaders(req: IncomingMessage, channel: ChannelRecord, kind: ForwardKind): Record<string, string> {
    const allowlist = kind === 'chat' || kind === 'responses' ? CLIENT_HEADER_ALLOWLIST : ANTHROPIC_HEADER_ALLOWLIST;
    const headers: Record<string, string> = { 'accept-encoding': 'identity' };
    for (const [name, value] of Object.entries(stripHopHeaders(req.headers))) {
      const lower = name.toLowerCase();
      if (allowlist.has(lower) && value !== '') headers[lower] = value;
    }
    headers['content-type'] = headers['content-type'] ?? 'application/json';
    delete headers['authorization'];
    delete headers['x-api-key'];
    if (kind === 'chat' || kind === 'responses') {
      headers['authorization'] = `Bearer ${channel.apiKey}`;
    } else {
      headers['x-api-key'] = channel.apiKey;
      headers['anthropic-version'] = headers['anthropic-version'] || '2023-06-01';
    }
    return headers;
  }

  /** 单次上游转发的路由种类：chat=OpenAI Chat（/chat/completions + Bearer 渠道 key）；responses=OpenAI Responses（/responses + Bearer）；
   *  messages=Anthropic 主路径（/messages + x-api-key）；count_tokens=Anthropic 轻路径（真实转发，但不写账本/不做 tee/不进 usage 告警窗口）。 */
  type ForwardKind = 'chat' | 'responses' | 'messages' | 'count_tokens';

  /** tee 帧解析口径由请求种类推导（chat/responses=OpenAI 系；messages/count_tokens=Anthropic 系）。 */
  function formatOf(kind: ForwardKind): TeeFormat {
    return kind === 'chat' ? 'chat' : kind === 'responses' ? 'responses' : 'messages';
  }

  interface ForwardAttempt {
    body: Record<string, unknown>;
    alias: string;
    channel: ChannelRecord;
    kind: ForwardKind;
    /** 客户端请求路径（onLog 用）。 */
    clientPath: string;
  }

  /** 转发一次已通过校验的 JSON 请求到渠道上游，并按 kind 落实路由语义、账本与旁路观测。 */
  async function forwardUpstreamRequest(req: IncomingMessage, res: ServerResponse, attempt: ForwardAttempt): Promise<void> {
    const { body, alias, channel, kind, clientPath } = attempt;
    /** 轻路径（count_tokens）：只计网关 counters 与渠道统计；不写账本、不做 tee、不进 usage 告警窗口。 */
    const light = kind === 'count_tokens';

    // 上游目标逐请求重解析 + 公网 IPv4 钉定（防 SSRF/DNS rebinding），失败即拒绝，不回退
    let base: URL;
    try {
      base = new URL(channel.baseUrl);
    } catch {
      respondError(res, 502, 'upstream_blocked', `渠道 ${JSON.stringify(channel.label)} 的 baseUrl 已失效，请更新渠道配置。`);
      return;
    }
    const pinned = await resolvePinnedUpstream({
      hostname: base.hostname,
      lookup,
      allowPrivate: channel.allowPrivateUpstream === true,
    });
    if (!pinned.ok || pinned.ip === null) {
      // 未实际发往上游：只记网关级 lastError，不计入渠道请求/错误统计（渠道统计仅覆盖已转发请求）
      noteError(pinned.message);
      respondError(res, 502, 'upstream_blocked', `上游目标校验未通过：${pinned.message}`);
      return;
    }

    // 转发：model 改写为渠道映射（modelMap[alias] ?? alias），请求体其余字段原样；
    // 请求头 allowlist + 按协议注入上游 key；连接钉定到校验过的 IP，禁用连接复用（每次请求都重校验）。
    const outgoing = { ...body, model: channel.modelMap[alias] ?? alias };
    const payload = Buffer.from(JSON.stringify(outgoing), 'utf8');

    // 账本：请求结构元数据同步入账（正文零持久化；requests 表本无正文列）。
    // 请求 id 由网关预生成：账本写失败（返回 null）或未配置账本时，结算与告警证据链仍可关联。
    // 轻路径（count_tokens）零账本：否则会在用量表制造「有请求无 token」的假缺失。
    const requestId = randomUUID();
    const meta = extractRequestMeta(body, kind);
    const requestRecorded = light
      ? false
      : ledgerRecord({
          id: requestId,
          ts_ms: Date.now(),
          origin: 'user',
          channel_id: channel.id,
          alias,
          model_upstream: channel.modelMap[alias] ?? alias,
          req_bytes: payload.length,
          has_tools: meta.hasTools,
          has_image: meta.hasImage,
          messages_count: meta.messagesCount,
        });
    const headers = buildUpstreamHeaders(req, channel, kind);
    headers['content-length'] = String(payload.length);

    const basePath = base.pathname.replace(/\/+$/, '');
    const basePort = base.port !== '' ? Number(base.port) : base.protocol === 'https:' ? 443 : 80;
    const socketTarget = mapSocket({ host: pinned.ip, port: basePort });
    const secure = base.protocol === 'https:';
    const doRequest = secure ? httpsRequest : httpRequest;
    const upstreamPath =
      kind === 'chat' ? `${basePath}/chat/completions` : kind === 'responses' ? `${basePath}/responses` : kind === 'count_tokens' ? `${basePath}/messages/count_tokens` : `${basePath}/messages`;
    const upstreamReq = doRequest({
      host: base.hostname,
      port: basePort,
      path: upstreamPath,
      method: 'POST',
      headers,
      lookup: pinnedLookup(socketTarget.host),
      agent: false,
      ...(secure && !isIpLiteral(base.hostname) ? { servername: base.hostname } : {}),
    });

    counters.total += 1;
    let counted = false;
    /** 上游故障归因（error/timeout/截断先发生者胜出）；res close 判定复用它，绝不让渠道背客户端断开的锅。 */
    let upstreamFault: LedgerVerdict | null = null;
    let upResRef: IncomingMessage | null = null;
    /** 旁路观测状态：首个响应头到达后按 content-type 重建；无响应（连接失败）时保持空 JSON 模式。 */
    let tee: TeeObservation = teeInit('', formatOf(kind));
    /** TTFT（上游口径）单调时钟打点：请求体发出前一刻。 */
    let sentAtMs = 0;
    /** 一次性结算（幂等）：首次调用同时写网关计数、渠道统计，非轻路径再写账本与内存用量/告警；返回是否由本次调用生效。 */
    const settle = (status: number | null, ok: boolean, verdict: LedgerVerdict): boolean => {
      if (counted) return false;
      counted = true;
      if (ok) counters.ok += 1;
      else counters.error += 1;
      noteChannelResult(channel, status, verdict.errorSource);
      if (light) return true; // 轻路径（count_tokens）到此为止：无账本、无观测、无用量与告警窗口
      // 旁路观测终态固化（幂等；截断/中断时补 flush 已完整的帧）
      teeFinish(tee, sentAtMs);
      const usage = tee.usage;
      const missingReason: LedgerTokenMissingReason | null = usage !== null ? null : (tee.usageReason ?? 'absent');
      /** 金额快照：以本请求路由时刻捕获的渠道价计费（settle 可能晚于渠道改价，价格与 token 必须同一次请求内自洽）。 */
      const price = channel.modelPrices[alias];
      if (requestRecorded) {
        ledgerSettle({
          id: randomUUID(),
          request_id: requestId,
          attempt_no: 1,
          ts_ms: Date.now(),
          channel_id: channel.id,
          alias,
          upstream_status: status,
          client_status: verdict.clientStatus,
          error_source: verdict.errorSource,
          error_class: verdict.errorClass ?? null,
          finish_reason: tee.finishReason,
          ttft_upstream_ms: tee.ttftMs,
          ttft_client_ms: clientTtftByResponse.get(res)?.() ?? null, // 客户端口径独立打点（进网关→首字节写出，含本机排队与网关开销）；无写入为 NULL，绝不写 0 冒充
          ttft_contaminated: tee.ttftMs === null ? null : tee.ttftContaminated ? 1 : 0, // 无样本写 NULL，绝不写 0 冒充
          token_prompt: usage?.prompt_tokens ?? null,
          token_completion: usage?.completion_tokens ?? null,
          token_cached: usage?.cached_tokens ?? null,
          token_reasoning: usage?.reasoning_tokens ?? null,
          token_source: usage === null ? 'none' : 'usage',
          token_missing_reason: missingReason,
          usage_valid: usage === null ? 0 : 1,
          amount: usage !== null && price !== undefined ? computeCostUsd(usage, price) : null, // 未录价渠道恒 NULL（禁止误导性的 $0）
        });
      } else {
        // 请求行未落账（账本瞬时故障）：跳过结算，绝不允许孤儿 settlement 让 usageSummary 的
        // token 总量与 requests 表出现「有 token 无请求」的账面扭曲（宁可缺口、不可错账）。
        ledgerSettleSkipped += 1;
      }
      recordUsage(channel, requestId, alias, ok, status, verdict, tee, usage, missingReason);
      return true;
    };

    upstreamReq.setTimeout(timeoutMs, () => {
      upstreamReq.destroy(new Error(`upstream idle timeout (${Math.round(timeoutMs / 1000)}s)`));
    });
    upstreamReq.on('error', (error: Error) => {
      const isTimeout = /timeout/i.test(error.message);
      // 上游连接错误/超时：归因上游。非超时的连接中断（含 2xx 中途断流）按截断记账。
      const verdict = isTimeout ? VERDICT_UPSTREAM_TIMEOUT : VERDICT_UPSTREAM_TRUNCATED;
      upstreamFault ??= verdict;
      if (res.headersSent) {
        // 上游在响应中途断开：结算已发生或已由收流完成判定（settle 幂等），此处只收尾连接
        res.destroy();
        return;
      }
      // 先写出错误体（client 首字节口径捕获）再结算；写头抛错也不丢结算——settle 幂等，close 兜底
      respondError(
        res,
        isTimeout ? 504 : 502,
        isTimeout ? 'upstream_timeout' : 'upstream_unavailable',
        isTimeout
          ? `上游 ${Math.round(timeoutMs / 1000)}s 无数据，已断开（网关不做重试）。可检查渠道连通性或调大超时。`
          : `上游连接失败：${error.message}（网关不做重试/回退）。请检查渠道 baseUrl 与网络连通性。`,
      );
      if (settle(isTimeout ? 504 : 502, false, verdict)) noteError(`${channel.id}: ${error.message}`);
    });
    upstreamReq.on('response', (upRes) => {
      const status = upRes.statusCode ?? 0;
      upResRef = upRes;
      if (!light) {
        // 旁路观测接入（轻路径 count_tokens 完全不做观测）：独立 data/end 监听器只读旁听（不 await、不 backpressure）；
        // SSE 逐帧解析，非 SSE 缓冲整包 JSON；任何异常只自增 teeErrors。
        tee = teeInit(String(upRes.headers['content-type'] ?? ''), formatOf(kind));
        upRes.on('data', (chunk: Buffer) => teeFeed(tee, chunk, sentAtMs));
        upRes.on('end', () => teeFinish(tee, sentAtMs));
      }
      if (status >= 300 && status < 400) {
        // 不跟随重定向，且绝不把上游 Location 透传给客户端（防开放重定向）
        upRes.destroy();
        respondError(res, 502, 'upstream_redirect_rejected', `上游返回重定向（${status}），网关不跟随重定向；请让渠道 baseUrl 直接指向最终 API 地址（网关不做回退/重试）。`);
        // 先写出错误体（client 首字节口径捕获）再结算
        if (settle(status, false, VERDICT_UPSTREAM_RELAYED)) noteError(`${channel.id}: upstream redirect ${status} rejected`);
        return;
      }
      if (res.headersSent) {
        // 防御性守卫：头已写出则不再改写响应头（结算由 close/pipeline 幂等路径兜底）
        upRes.destroy();
        return;
      }
      const named = new Set(
        String(upRes.headers['connection'] ?? '')
          .split(',')
          .map((name) => name.trim().toLowerCase())
          .filter(Boolean),
      );
      const relay: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(upRes.headers)) {
        if (value === undefined) continue;
        const lower = name.toLowerCase();
        if (['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer'].includes(lower)) continue;
        if (lower.startsWith('proxy-')) continue;
        if (named.has(lower)) continue;
        relay[name] = value;
      }
      res.writeHead(status, relay);
      const successExpected = status >= 200 && status < 300;
      if (!successExpected) {
        // 错误体转发结算：状态行已写出 → client_ttft 捕获错误体首字节（独立口径，不以流式/成功为 gate）
        if (settle(status, false, VERDICT_UPSTREAM_RELAYED) && status >= 400) noteError(`${channel.id}: upstream status ${status}`);
      }
      void pipeline(upRes, res)
        .then(() => {
          // 成功只在响应体完整送达后计数：中途截断/断流的 2xx 绝不记为 ok（防假阳性）
          if (successExpected) settle(status, true, VERDICT_OK);
        })
        .catch(() => {
          upstreamFault ??= VERDICT_UPSTREAM_TRUNCATED;
          upRes.destroy();
          if (successExpected && settle(null, false, VERDICT_UPSTREAM_TRUNCATED)) {
            noteError(`${channel.id}: upstream ${status} response truncated or relay interrupted before completion`);
          }
        });
    });
    res.on('close', () => {
      if (!res.writableEnded) {
        // 客户端中途断开：上游结果未知，按错误保守结算。判定顺序（先判后毁）：
        // 上游已故障（error/timeout/截断）→ 沿用其归因；上游响应已开始且连接被销毁 → 记截断；
        // 否则才是客户端主动中止（client_status='aborted'，error_source='client'）——绝不冤枉渠道。
        const verdict = upstreamFault ?? (upResRef !== null && upResRef.destroyed ? VERDICT_UPSTREAM_TRUNCATED : VERDICT_CLIENT_ABORT);
        upstreamReq.destroy();
        settle(null, false, verdict);
      }
    });
    sentAtMs = performance.now();
    upstreamReq.end(payload);
    onLog(`[gateway] POST ${clientPath} alias=${alias} channel=${channel.id} status=pending`);
  }

  // —— S2 旁路观测（tee）与 S3-lite 告警的内部实现 ——

  /** 创建旁路观测状态；content-type 含 text/event-stream 走 SSE 逐帧解析，否则缓冲整包 JSON；format 决定帧解析口径。 */
  function teeInit(contentType: string, format: TeeFormat): TeeObservation {
    const sse = contentType.toLowerCase().includes('text/event-stream');
    return {
      format,
      sse,
      decoder: sse ? new StringDecoder('utf8') : null,
      parser: sse ? new SseParser() : null,
      buffer: sse ? null : [],
      bufferedBytes: 0,
      skipped: false,
      ended: false,
      usage: null,
      usageReason: null,
      usageFrameSeen: false,
      model: null,
      finishReason: null,
      ttftMs: null,
      ttftContaminated: false,
      firstContentSeen: false,
    };
  }

  function teeFeed(teeState: TeeObservation, chunk: Buffer, sentAt: number): void {
    try {
      if (teeState.ended || teeState.skipped) return;
      if (teeState.sse && teeState.decoder !== null && teeState.parser !== null) {
        const text = teeState.decoder.write(chunk);
        if (text === '') return;
        for (const event of teeState.parser.feed(text)) teeConsume(teeState, event.data, sentAt);
        return;
      }
      if (teeState.buffer !== null) {
        teeState.bufferedBytes += chunk.length;
        if (teeState.bufferedBytes > MAX_OBSERVE_BYTES) {
          teeState.buffer = null;
          teeState.skipped = true;
          observeSkipped += 1;
          return;
        }
        teeState.buffer.push(Buffer.from(chunk));
      }
    } catch {
      teeErrors += 1;
    }
  }

  /** 流式终态处理（upRes end 与 settle 都调用，幂等）：flush 尾部字节与残余帧。 */
  function teeFinish(teeState: TeeObservation, sentAt: number): void {
    if (teeState.ended) return;
    teeState.ended = true;
    try {
      if (teeState.sse && teeState.decoder !== null && teeState.parser !== null) {
        const tail = teeState.decoder.end();
        const pending = tail === '' ? [] : teeState.parser.feed(tail);
        for (const event of [...pending, ...teeState.parser.end()]) teeConsume(teeState, event.data, sentAt);
        return;
      }
      if (teeState.buffer !== null) {
        const text = Buffer.concat(teeState.buffer).toString('utf8');
        teeState.buffer = null;
        teeConsumeJson(teeState, text, sentAt);
      }
    } catch {
      teeErrors += 1;
    }
  }

  /** 消费一个 SSE data 帧：模型自述、finish_reason、usage（含拒收原因）、首内容 TTFT；按请求种类选择解析口径。 */
  function teeConsume(teeState: TeeObservation, data: string, sentAt: number): void {
    const chunk: StreamChunk | null =
      teeState.format === 'messages'
        ? parseAnthropicStreamPayload(data, teeState.usage)
        : teeState.format === 'responses'
          ? parseResponsesStreamPayload(data)
          : parseStreamPayload(data);
    if (chunk === null) return;
    if (teeState.model === null && chunk.model !== null) teeState.model = chunk.model;
    if (chunk.finishReason !== null) teeState.finishReason = chunk.finishReason;
    if (chunk.usage !== null) {
      teeState.usage = chunk.usage;
      teeState.usageReason = null;
      teeState.usageFrameSeen = true;
    } else if (chunk.usageReason !== null) {
      teeState.usageFrameSeen = true;
      if (teeState.usage === null) teeState.usageReason = chunk.usageReason;
    }
    teeNoteFirstContent(
      teeState,
      chunk.contentDelta !== '' || chunk.reasoningDelta !== '' || chunk.toolCallDeltas.length > 0,
      sentAt,
    );
  }

  /** 消费非流式 JSON 整包：与流式同口径提取（模型自述/usage/finish_reason/首内容）。 */
  function teeConsumeJson(teeState: TeeObservation, text: string, sentAt: number): void {
    if (text === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return; // 非 JSON 响应体：放弃观测（不算错误）
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
    const obj = parsed as Record<string, unknown>;
    if (teeState.format === 'messages') {
      // Anthropic 非流式消息：model / stop_reason / usage / content[]，与流式同口径提取
      if (teeState.model === null && typeof obj['model'] === 'string' && obj['model'] !== '') teeState.model = obj['model'] as string;
      const stopReason = mapAnthropicStopReason(obj['stop_reason']);
      if (stopReason !== null) teeState.finishReason = stopReason;
      if ('usage' in obj) {
        teeState.usageFrameSeen = true;
        const mapped = mapAnthropicUsage(obj['usage'], null);
        if (mapped.usage !== null) {
          teeState.usage = mapped.usage;
          teeState.usageReason = null;
        } else if (teeState.usage === null) {
          teeState.usageReason = mapped.reason;
        }
      }
      teeNoteFirstContent(teeState, anthropicContentHasSignal(obj['content']), sentAt);
      return;
    }
    if (teeState.format === 'responses') {
      // OpenAI Responses 非流式：model / status(completed|incomplete|failed) / usage / output[]，与流式同口径提取
      if (teeState.model === null && typeof obj['model'] === 'string' && obj['model'] !== '') teeState.model = obj['model'] as string;
      const status = obj['status'];
      if (status === 'completed') {
        teeState.finishReason = 'stop';
      } else if (status === 'incomplete') {
        const details = typeof obj['incomplete_details'] === 'object' && obj['incomplete_details'] !== null ? (obj['incomplete_details'] as Record<string, unknown>) : null;
        const reason = details === null ? undefined : details['reason'];
        if (reason === 'max_output_tokens') teeState.finishReason = 'length';
        else if (typeof reason === 'string' && reason !== '') teeState.finishReason = reason;
      }
      // status='failed' → finishReason 保持 null（失败语义不借 finish_reason 表达）
      if ('usage' in obj) {
        teeState.usageFrameSeen = true;
        const mapped = mapResponsesUsage(obj['usage']);
        if (mapped.usage !== null) {
          teeState.usage = mapped.usage;
          teeState.usageReason = null;
        } else if (teeState.usage === null) {
          teeState.usageReason = mapped.reason;
        }
      }
      teeNoteFirstContent(teeState, responsesContentHasSignal(obj['output']), sentAt);
      return;
    }
    if (teeState.model === null && typeof obj['model'] === 'string' && obj['model'] !== '') teeState.model = obj['model'] as string;
    const choices = obj['choices'];
    if (Array.isArray(choices) && choices.length > 0 && typeof choices[0] === 'object' && choices[0] !== null) {
      const choice = choices[0] as Record<string, unknown>;
      const reason = choice['finish_reason'];
      if (typeof reason === 'string' && reason !== '') teeState.finishReason = reason;
      teeNoteFirstContent(teeState, jsonMessageHasContent(choice['message']) || jsonMessageHasContent(choice['delta']), sentAt);
    }
    if ('usage' in obj) {
      teeState.usageFrameSeen = true;
      const validated = validateUsage(obj['usage']);
      if (validated.usage !== null) {
        teeState.usage = validated.usage;
        teeState.usageReason = null;
      } else if (teeState.usage === null) {
        teeState.usageReason = validated.reason;
      }
    }
  }

  function jsonMessageHasContent(message: unknown): boolean {
    if (typeof message !== 'object' || message === null) return false;
    const record = message as Record<string, unknown>;
    if (extractText(record['content']) !== '') return true;
    if (extractText(record['reasoning_content']) !== '' || extractText(record['reasoning']) !== '') return true;
    const toolCalls = record['tool_calls'];
    return Array.isArray(toolCalls) && toolCalls.length > 0;
  }

  /** 首个内容增量到达即定 TTFT（上游口径，performance.now 单调时钟），并判定本次窗口事件循环滞后是否污染该样本。 */
  function teeNoteFirstContent(teeState: TeeObservation, hasContent: boolean, sentAt: number): void {
    if (!hasContent || teeState.firstContentSeen) return;
    teeState.firstContentSeen = true;
    if (sentAt > 0) {
      teeState.ttftMs = performance.now() - sentAt;
      // >= 语义：阈值 0 即全剔除（供测试/严格模式）；窗口=距上一 TTFT 样本，并发请求共享窗口属近似
      const lagMs = readLoopLagMs();
      teeState.ttftContaminated = lagMs >= loopLagThresholdMs;
    }
  }

  /** 读取并清零事件循环延迟直方图的窗口最大值（毫秒）；hist.max 为纳秒数，空样本为 0。 */
  function readLoopLagMs(): number {
    try {
      const maxNs = Number(loopDelay.max);
      loopDelay.reset();
      return Number.isFinite(maxNs) && maxNs > 0 ? maxNs / 1e6 : 0;
    } catch {
      teeErrors += 1;
      return 0;
    }
  }

  /** 只读提取请求结构元数据（正文绝不入账）；异常形状保守降级并计数，绝不抛。kind 决定 input/messages 与图片部件的判定域。 */
  function extractRequestMeta(body: Record<string, unknown>, kind: ForwardKind): {
    hasTools: number | null;
    hasImage: number | null;
    messagesCount: number | null;
  } {
    try {
      const tools = body['tools'];
      const hasTools = Array.isArray(tools) && tools.length > 0 ? 1 : 0;
      if (kind === 'responses') {
        // Responses 语义：输入在 input（字符串或条目数组）；图片在条目 type='input_image' 或 content 部件 input_image/image_url
        const input = body['input'];
        let messagesCount: number | null = null;
        if (Array.isArray(input)) messagesCount = input.length;
        else if (typeof input === 'string') messagesCount = 1;
        let hasImage = 0;
        if (Array.isArray(input)) {
          for (const item of input) {
            if (typeof item !== 'object' || item === null) continue;
            const record = item as Record<string, unknown>;
            if (record['type'] === 'input_image') {
              hasImage = 1;
              break;
            }
            const content = record['content'];
            if (
              Array.isArray(content) &&
              content.some((part) => {
                if (typeof part !== 'object' || part === null) return false;
                const type = (part as Record<string, unknown>)['type'];
                return type === 'input_image' || type === 'image_url';
              })
            ) {
              hasImage = 1;
              break;
            }
          }
        }
        return { hasTools, hasImage, messagesCount };
      }
      const messages = body['messages'];
      let hasImage = 0;
      let messagesCount = 0;
      if (Array.isArray(messages)) {
        messagesCount = messages.length;
        for (const message of messages) {
          if (typeof message !== 'object' || message === null) continue;
          const content = (message as Record<string, unknown>)['content'];
          if (
            Array.isArray(content) &&
            content.some((part) => {
              if (typeof part !== 'object' || part === null) return false;
              const type = (part as Record<string, unknown>)['type'];
              // OpenAI：image_url 部件；Anthropic Messages：{"type":"image","source":{...}} 部件
              return type === 'image_url' || type === 'image';
            })
          ) {
            hasImage = 1;
            break;
          }
        }
      }
      return { hasTools, hasImage, messagesCount };
    } catch {
      teeErrors += 1;
      return { hasTools: null, hasImage: null, messagesCount: null };
    }
  }

  function ledgerRecord(entry: LedgerRequestInput): boolean {
    if (ledger === null) return true; // 未配置账本：不存在孤儿 settlement 之虞
    try {
      return ledger.recordRequest(entry) !== null; // null = 写失败（fail-open 语义）
    } catch {
      ledgerErrors += 1; // fail-open：账本故障绝不阻断转发
      return false;
    }
  }

  function ledgerSettle(entry: LedgerSettlementInput): void {
    if (ledger === null) return;
    try {
      ledger.settle(entry);
    } catch {
      ledgerErrors += 1;
    }
  }

  function usageRowFor(channelId: string, aliasName: string): UsageCounters {
    let byAlias = usageCounters.get(channelId);
    if (byAlias === undefined) {
      byAlias = new Map<string, UsageCounters>();
      usageCounters.set(channelId, byAlias);
    }
    let row = byAlias.get(aliasName);
    if (row === undefined) {
      row = {
        requests: 0,
        ok: 0,
        error: 0,
        tokenPrompt: 0,
        tokenCompletion: 0,
        tokenCached: 0,
        tokenReasoning: 0,
        costUsd: 0,
        usageValid: 0,
        usageMissing: 0,
        usageInvalid: 0,
        truncated: 0,
        ttftSamples: [],
        ttftContaminated: 0,
        ttftEvicted: 0,
      };
      byAlias.set(aliasName, row);
    }
    return row;
  }

  /** 内存实时计数与告警窗口（口径与账本一致：只有 2xx 且完整送达/截断的响应才计入 usage 分母）。 */
  function recordUsage(
    target: ChannelRecord,
    requestId: string,
    aliasName: string,
    ok: boolean,
    status: number | null,
    verdict: LedgerVerdict,
    teeState: TeeObservation,
    usage: Usage | null,
    missingReason: LedgerTokenMissingReason | null,
  ): void {
    try {
      const row = usageRowFor(target.id, aliasName);
      row.requests += 1;
      if (ok) row.ok += 1;
      else row.error += 1;
      const is2xx = status !== null && status >= 200 && status < 300;
      const countable = is2xx && (verdict.clientStatus === 'ok' || verdict.clientStatus === 'truncated');
      const usageInvalid = countable && usage === null && missingReason !== null && missingReason !== 'absent';
      if (countable) {
        if (usage !== null) {
          row.usageValid += 1;
          row.tokenPrompt += usage.prompt_tokens;
          row.tokenCompletion += usage.completion_tokens;
          row.tokenCached += usage.cached_tokens ?? 0;
          row.tokenReasoning += usage.reasoning_tokens ?? 0;
          const price = target.modelPrices[aliasName];
          if (price !== undefined) row.costUsd += computeCostUsd(usage, price);
        } else if (usageInvalid) {
          row.usageInvalid += 1;
        } else {
          row.usageMissing += 1;
        }
      }
      if (verdict.clientStatus === 'truncated') row.truncated += 1;
      if (teeState.ttftMs !== null) {
        // 污染样本只计数、不进分位（TTFT 分位口径为「未污染样本」）
        if (teeState.ttftContaminated) {
          row.ttftContaminated += 1;
        } else {
          row.ttftSamples.push(teeState.ttftMs);
          if (row.ttftSamples.length > TTFT_RING_CAPACITY) {
            row.ttftSamples.shift();
            row.ttftEvicted += 1; // 环溢出必须可追溯：samplesSeen = 环内 + evicted + contaminated（守恒披露）
          }
        }
      }
      const expected = target.modelMap[aliasName] ?? aliasName;
      const mismatch = is2xx && teeState.model !== null && !sameModelId(teeState.model, expected);
      let window = channelWindows.get(target.id);
      if (window === undefined) {
        window = [];
        channelWindows.set(target.id, window);
      }
      // 告警窗口的 error 只认上游/网关侧失败：客户端主动断开（error_source=client）与
      // noteChannelResult 同口径——渠道无责，绝不据此推高 error_rate 误伤渠道。
      const channelError = !ok && verdict.errorSource !== 'client';
      window.push({ id: requestId, ts: Date.now(), mismatch, usageInvalid, error: channelError, truncated: verdict.clientStatus === 'truncated', ttftMs: teeState.ttftMs, ttftContaminated: teeState.ttftContaminated });
      if (window.length > CHANNEL_WINDOW_SIZE) window.splice(0, window.length - CHANNEL_WINDOW_SIZE);
      evaluateAlerts(target.id);
    } catch {
      teeErrors += 1; // 内存统计异常同样只计数，绝不反向影响已完成的转发/账本
    }
  }

  /** S3-lite 规则评估（仅当次窗口；保守起点，防误报优先）：触发后进入 (渠道,类别) 冷却。 */
  function evaluateAlerts(channelId: string): void {
    const now = Date.now();
    if (now < alertSilenceUntil) {
      alertSilenceWasActive = true; // 粘性披露：静默期结束仍可见「这段流量从未被评估」
      return;
    }
    const window = channelWindows.get(channelId);
    if (window === undefined || window.length === 0) return;
    const n = window.length;
    const mismatchIds = window.filter((event) => event.mismatch).map((event) => event.id);
    if (mismatchIds.length >= 2) raiseAlert(channelId, 'model_mismatch', mismatchIds, n, mismatchIds.length, now);
    const errorIds = window.filter((event) => event.error).map((event) => event.id);
    if (n >= 5 && errorIds.length / n > 0.5) raiseAlert(channelId, 'error_rate', errorIds, n, errorIds.length / n, now);
    const truncatedIds = window.filter((event) => event.truncated).map((event) => event.id);
    if (n >= 3 && truncatedIds.length >= 1) raiseAlert(channelId, 'truncated', truncatedIds, n, truncatedIds.length, now);
    const invalidIds = window.filter((event) => event.usageInvalid).map((event) => event.id);
    if (n >= USAGE_INVALID_MIN_SAMPLES && invalidIds.length / n > 0.3) {
      raiseAlert(channelId, 'usage_invalid', invalidIds, n, invalidIds.length / n, now);
    }
    // TTFT 偏高（ttft_high）：仅未污染样本、n≥20、p95≥300ms 绝对下限；污染样本剔除=本机卡顿绝不诬告渠道（铁律 6）。
    const cleanTtft = window.filter((event) => event.ttftMs !== null && Number.isFinite(event.ttftMs) && event.ttftMs >= 0 && !event.ttftContaminated);
    if (cleanTtft.length >= TTFT_HIGH_MIN_SAMPLES) {
      const p95 = percentileNearestRank(cleanTtft.map((event) => event.ttftMs as number).sort((a, b) => a - b), 95);
      if (p95 !== null && p95 >= TTFT_HIGH_P95_MS) {
        raiseAlert(channelId, 'ttft_high', cleanTtft.map((event) => event.id).slice(-10), cleanTtft.length, p95, now);
      }
    }
  }

  function raiseAlert(channelId: string, kind: GatewayAlertKind, ids: string[], n: number, observed: number, now: number): void {
    const key = `${channelId}\u0000${kind}`;
    const last = alertCooldown.get(key) ?? 0;
    if (now - last < ALERT_COOLDOWN_MS) {
      alertSuppressed += 1; // 冷却抑制可见性：被抑制的告警只计数不生成事件，防持续故障被「一条旧告警」掩盖
      return;
    }
    alertCooldown.set(key, now);
    alertEvents.push({ ts: now, channel: channelId, kind, evidence_request_ids: ids.slice(-10), n, observed });
    if (alertEvents.length > ALERT_EVENT_CAPACITY) alertEvents.splice(0, alertEvents.length - ALERT_EVENT_CAPACITY);
  }

  function buildUsageRow(channelId: string, aliasName: string, row: UsageCounters): GatewayUsageRow {
    const samples = [...row.ttftSamples].sort((a, b) => a - b);
    const n = samples.length;
    const denominator = row.usageValid + row.usageMissing + row.usageInvalid;
    // 现价判空：渠道已删或该别名价格已移除 → 金额显示 null（历史累计仍在，但以「当前未录价」口径如实披露）
    const priced = store.get(channelId)?.modelPrices[aliasName] !== undefined;
    return {
      channelId,
      alias: aliasName,
      requests: row.requests,
      ok: row.ok,
      error: row.error,
      tokenPrompt: row.tokenPrompt,
      tokenCompletion: row.tokenCompletion,
      tokenCached: row.tokenCached,
      tokenReasoning: row.tokenReasoning,
      costUsd: priced ? row.costUsd : null,
      usageValid: row.usageValid,
      usageMissing: row.usageMissing,
      usageInvalid: row.usageInvalid,
      usageValidRate: denominator === 0 ? null : row.usageValid / denominator,
      truncated: row.truncated,
      ttftSamples: n,
      ttftContaminated: row.ttftContaminated,
      ttftEvicted: row.ttftEvicted,
      ttftP50Ms: percentileNearestRank(samples, 50),
      ttftP95Ms: n >= TTFT_PROVISIONAL_SAMPLES ? percentileNearestRank(samples, 95) : null,
      provisional: n < TTFT_PROVISIONAL_SAMPLES,
    };
  }

  /**
   * nearest-rank 分位数：rank = ceil(p/100 × n)（1 基），取升序第 rank 个样本；n=0 → null。
   * p50 即中位数；p95 仅当样本数 ≥ TTFT_PROVISIONAL_SAMPLES 才披露（不足时上层给出 provisional）。
   */
  function percentileNearestRank(sortedAsc: number[], p: number): number | null {
    if (sortedAsc.length === 0) return null;
    const rank = Math.min(Math.max(Math.ceil((p / 100) * sortedAsc.length), 1), sortedAsc.length);
    return sortedAsc[rank - 1] ?? null;
  }

  /** 账本健康状态：ledger.stats() 与网关侧兜底计数合并；stats() 抛错时用粘性标志披露降级（幂等）。 */
  function degradedState(): { writeErrors: number; degraded: boolean; recovered: number } {
    let stats: LedgerStats | null = null;
    if (ledger !== null) {
      try {
        stats = ledger.stats();
        ledgerStatsFailed = false;
      } catch {
        ledgerStatsFailed = true;
      }
    }
    const writeErrors = (stats?.writeErrors ?? 0) + ledgerErrors + ledgerSettleSkipped;
    return { writeErrors, degraded: writeErrors > 0 || ledgerStatsFailed || stats?.degraded === true, recovered: stats?.recovered ?? 0 };
  }

  function isIpLiteral(host: string): boolean {
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  }

  async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    return await new Promise<Record<string, unknown>>((resolveBody, rejectBody) => {
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          chunks.length = 0;
          res413(req, rejectBody);
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (raw === '') {
          rejectBody(new Error('请求体为空：须为 JSON（含 model 与 messages 字段）。示例：{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'));
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          rejectBody(new Error('请求体不是合法 JSON。示例：{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'));
          return;
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          rejectBody(new Error('请求体必须是 JSON 对象。示例：{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'));
          return;
        }
        resolveBody(parsed as Record<string, unknown>);
      });
      req.on('error', rejectBody);
    });
  }
  function res413(req: IncomingMessage, rejectBody: (reason: Error) => void): void {
    rejectBody(new BodyTooLargeError(`请求体超过 ${MAX_BODY_BYTES} 字节上限，已拒绝转发。请压缩对话历史后重试。`));
    req.resume(); // 丢弃残余请求体，避免连接悬挂
  }

  const port = await new Promise<number>((resolvePort, rejectPort) => {
    server.once('error', rejectPort);
    server.listen(portArg, '127.0.0.1', () => {
      server.off('error', rejectPort);
      const address = server.address();
      resolvePort(address !== null && typeof address === 'object' ? address.port : portArg);
    });
  });

  async function close(): Promise<void> {
    try {
      loopDelay.disable();
    } catch {
      /* 关停兜底 */
    }
    const closed = new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
    });
    const force = server as Server & { closeAllConnections?: () => void };
    force.closeAllConnections?.();
    await closed.catch(() => undefined);
  }

  return {
    port,
    get virtualKey(): string {
      return virtualKey;
    },
    rotateVirtualKey(): string {
      virtualKey = makeVirtualKey();
      onLog('[gateway] virtual key rotated');
      return virtualKey;
    },
    store,
    status(): GatewayStatus {
      const list = store.list();
      return {
        port,
        uptimeMs: Date.now() - startedAt,
        channelCount: list.length,
        enabledChannelCount: list.filter((channel) => channel.enabled).length,
        requests: { ...counters },
        lastError: lastError === null ? null : { ...lastError },
        degraded: degradedState(),
        alertEvents: alertEvents.length,
        alertSilenceRemainingMs: Math.max(0, alertSilenceUntil - Date.now()),
        alertSilenceWasActive: alertSilenceWasActive || alertSilenceUntil > Date.now(),
        alertSuppressed,
        teeErrors,
        observeSkipped,
      };
    },
    usageSummary(): GatewayUsageRow[] {
      const rows: GatewayUsageRow[] = [];
      for (const [channelId, byAlias] of usageCounters) {
        for (const [aliasName, row] of byAlias) rows.push(buildUsageRow(channelId, aliasName, row));
      }
      return rows;
    },
    events(): GatewayAlertEvent[] {
      return [...alertEvents].reverse();
    },
    close,
  };
}

class BodyTooLargeError extends Error {}
