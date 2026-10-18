import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { normalize as posixNormalize } from 'node:path/posix';
import { pipeline } from 'node:stream/promises';
import { validateUsage } from '../sse.js';
import type { ModelPrice } from '../gateway/pricing.js';
import type { Usage, UsageRejection } from '../types.js';
import type { JournalWriter } from './journal.js';
import { sameModelId } from './model-id.js';
import type { Reconciler } from './reconcile.js';
import type { ScoreSample } from './scoreboard.js';

/** 深检端点：对这三类路径做响应 tee 解析（usage/模型/finish_reason），其余路径纯透传。 */
const DEEP_INSPECT_PATH = /\/(chat\/)?completions$|\/embeddings$/i;
/** 请求体捕获上限：超过则放弃请求侧深检（记基础行，仍原样转发）。 */
const MAX_REQUEST_CAPTURE = 16 * 1024 * 1024;
/** 响应 tee 缓冲上限：超过则放弃深检转纯透传（deep_inspect=false）。 */
const MAX_RESPONSE_CAPTURE = 8 * 1024 * 1024;
/** SSE 行缓冲上限：单行超限视为非 SSE 流量，放弃深检。 */
const MAX_LINE_BYTES = 1024 * 1024;

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

export interface AnomalyCandidate {
  code: 'model_mismatch' | 'usage_invalid' | 'finish_length';
  level: 'warn' | 'error' | 'info';
  message: string;
}

/**
 * 被动异常规则（纯函数，便于单测）：
 * - model_resp ≠ model_req（双方已知且非空）→ warn；
 * - usage 携带但被 validateUsage 拒绝（missing/negative/inconsistent 三类）→ error；
 * - 流末无 usage 不在此产生异常（只计数，由对账窗口 usageMissing 体现，不告警）；
 * - finish_reason=length → info（仅记录）。
 */
export function buildAnomalies(input: {
  modelReq: string | null;
  modelResp: string | null;
  usage: Usage | null;
  usageRejected: UsageRejection | null;
  finishReason: string | null;
}): AnomalyCandidate[] {
  const out: AnomalyCandidate[] = [];
    if (input.modelReq !== null && input.modelResp !== null && !sameModelId(input.modelReq, input.modelResp)) {
    out.push({
      code: 'model_mismatch',
      level: 'warn',
      message: `请求模型 ${input.modelReq}，上游返回模型 ${input.modelResp}，疑似换模型/换壳。`,
    });
  }
  if (input.usageRejected !== null) {
    const why =
      input.usageRejected === 'missing'
        ? 'usage 字段缺失/非数字/非整数'
        : input.usageRejected === 'negative'
          ? 'usage 出现负 token 数'
          : 'total_tokens ≠ prompt_tokens + completion_tokens';
    out.push({
      code: 'usage_invalid',
      level: 'error',
      message: `usage 校验失败（${why}），计费数据不可信。`,
    });
  }
  if (input.finishReason === 'length') {
    out.push({
      code: 'finish_length',
      level: 'info',
      message: 'finish_reason=length：输出被截断（仅记录，不告警）。',
    });
  }
  return out;
}

export interface TargetCheck {
  ok: boolean;
  status: number;
  message: string;
  /** 去 query 后的原始 path；校验失败为 null */
  path: string | null;
}

/**
 * 请求目标校验（防 SSRF/穿越）：仅接受单个 / 开头的 origin-form 相对路径；
 * 拒绝绝对 URI 与 //host；含 .. 段（原始或解码后）或规范化后越界 → 403。
 */
export function validateRequestTarget(raw: string): TargetCheck {
  const fail = (status: number, message: string): TargetCheck => ({ ok: false, status, message, path: null });
  if (raw.length === 0) return { ok: true, status: 200, message: '', path: '/' };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    return fail(403, '拒绝绝对 URI 请求目标（guard 仅接受以 / 开头的相对路径）');
  }
  if (raw.startsWith('//')) {
    return fail(403, '拒绝协议相对路径（//host，防 SSRF）');
  }
  if (!raw.startsWith('/')) {
    return fail(400, '请求目标必须以 / 开头');
  }
  if (/[\0-\x1f\x7f]/.test(raw)) {
    return fail(400, '请求目标含控制字符');
  }
  if (raw.includes('\\')) {
    return fail(400, '请求目标含反斜杠（疑似路径穿越变体）');
  }
  const queryIndex = raw.indexOf('?');
  const rawPath = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return fail(400, '请求路径含非法百分号编码');
  }
  if (/[\0-\x1f\x7f]/.test(decoded) || decoded.includes('\\')) {
    return fail(400, '请求路径解码后含控制字符或反斜杠（疑似穿越变体，如 %5c/%0d%0a）');
  }
  for (const candidate of [rawPath, decoded]) {
    if (candidate.split('/').some((segment) => segment === '..')) {
      return fail(403, '路径含 .. 段，疑似目录穿越');
    }
  }
  const normalized = posixNormalize(decoded);
  if (!normalized.startsWith('/') || normalized.startsWith('//')) {
    return fail(403, '路径规范化后越界');
  }
  return { ok: true, status: 200, message: '', path: rawPath };
}

/** 剥离 hop-by-hop 头；connection 头点名的附加头一并剥离（RFC 7230 §6.1）。 */
export function stripHopHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  const namedByConnection = new Set(
    typeof headers['connection'] === 'string'
      ? headers['connection']
          .split(',')
          .map((name) => name.trim().toLowerCase())
          .filter(Boolean)
      : [],
  );
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (namedByConnection.has(lower)) continue;
    if (lower.startsWith('proxy-')) continue;
    if (value === undefined) continue;
    out[lower] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

/**
 * 上游 URL 拼接：请求路径原样拼到 --base-url 的 origin+pathname 之后；若 --base-url 自带路径
 * （如 /v1）且请求路径重复该完整前缀，则去重一次，避免拼出 /v1/v1/...。
 * - base 的 query/fragment 不参与拼接（凭证走 Authorization 头；CLI 层已拒绝带 query 的 base-url，
 *   此处重组 origin+pathname 是纵深防御：路径永远不会被塞进 query 段）；
 * - 绝对形式请求目标按防御降级取其 pathname+search（正常管线已被 validateRequestTarget 403 拦截）；
 * - query 原样保留（透明转发语义）；
 * - 去重按 base.pathname 完整路径前缀精确匹配（大小写敏感；非 ASCII 因 URL 编码差异不匹配时
 *   退化为直接拼接，仍产出可用 URL）。
 * 例：base https://x/v1 + /v1/chat/completions → https://x/v1/chat/completions；
 *     base https://x/v1 + /chat/completions    → https://x/v1/chat/completions；
 *     base https://x      + /v1/chat/completions → https://x/v1/chat/completions。
 */
export function composeUpstreamUrl(upBaseUrl: string, rawUrl: string): string {
  let parsedBase: URL;
  try {
    parsedBase = new URL(upBaseUrl);
  } catch {
    return `${upBaseUrl.replace(/\/+$/, '')}${rawUrl}`;
  }
  const basePath = parsedBase.pathname.replace(/\/+$/, '');
  const base = `${parsedBase.origin}${basePath}`;
  let target = rawUrl;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    try {
      const absolute = new URL(target);
      target = `${absolute.pathname}${absolute.search}`;
    } catch {
      target = '/';
    }
  }
  const queryIndex = target.indexOf('?');
  const rawPath = queryIndex === -1 ? target : target.slice(0, queryIndex);
  const suffix = queryIndex === -1 ? '' : target.slice(queryIndex);
  if (basePath.length > 0 && (rawPath === basePath || rawPath.startsWith(`${basePath}/`))) {
    const rest = rawPath.slice(basePath.length);
    return `${base}${rest.length > 0 ? rest : '/'}${suffix}`;
  }
  return `${base}${target}`;
}

function constantTimeEqual(a: string, b: string): boolean {
  // 先哈希到定长再比较：杜绝「长度不等提前短路」泄露凭证长度信息
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

export interface FingerprintObserver {
  noteModel(model: string): void;
}

export interface GuardServerOptions {
  /** 上游真实中转站 base URL（如 https://relay.example.com/v1） */
  upBaseUrl: string;
  /** MODEL_XRAY_KEY：对内校验客户端凭证、对外注入上游凭证 */
  key: string;
  journal: JournalWriter;
  prices: ModelPrice | null;
  reconciler: Reconciler | null;
  fingerprint: FingerprintObserver | null;
  /** 上游 socket 空闲超时（默认 300s；流式下每收到数据自动重置） */
  upstreamTimeoutMs?: number;
  /**
   * 评分卡窄接口：finalize 仅在「请求已实际发往上游」（upstreamSent）时调用；
   * 本地 401/403/目标校验拒绝路径 upstreamSent=false，天然不入评分窗口。
   */
  scoreboard?: { record(sample: ScoreSample, requestId: string): void };
  onSummary?: (line: string) => void;
  onAlert?: (level: 'warn' | 'error', message: string) => void;
}

export interface GuardHandle {
  server: Server;
  /** 监听端口；EADDRINUSE 等错误以 reject 抛出（CLI 转换为 exit 1 提示换端口） */
  listen(port: number): Promise<number>;
  close(): Promise<void>;
}

interface RequestState {
  id: string;
  method: string;
  path: string;
  startedAt: number;
  deepInspect: boolean;
  stream: boolean | null;
  modelReq: string | null;
  modelResp: string | null;
  usage: Usage | null;
  usageRejected: UsageRejection | null;
  finishReason: string | null;
  ttftMs: number | null;
  bytesUp: number;
  bytesDown: number;
  aborted: boolean;
  status: number;
  /** 上游请求已构造（请求已实际发往上游）；本地 401/403/目标校验拒绝路径恒为 false */
  upstreamSent: boolean;
  errors: Array<{ code: string; status: number }>;
  finalized: boolean;
}

/**
 * guard 本地透明转发代理：
 * - 鉴权：客户端 Authorization 必须为 Bearer <MODEL_XRAY_KEY>，否则 401（防同机其他进程白嫖 key）；
 * - 凭证隔离：剥离全部入站凭证头，上游请求注入 env key；journal/控制台永不记录凭证；
 * - 转发：字节不改（唯一改写：深检端点 Accept-Encoding: identity；凭证头替换；hop-by-hop 剥离）；
 * - 深检：SSE Buffer 级逐行扫描 / JSON 解析，提取 usage、响应 model、finish_reason；
 * - 断连：客户端断开即销毁上游连接，journal 记 aborted=true。
 */
export function createGuardServer(options: GuardServerOptions): GuardHandle {
  const key = options.key;
  const journal = options.journal;
  const onSummary = options.onSummary ?? ((line: string) => console.log(line));
  const onAlert = options.onAlert ?? ((level, message) => console.error(`[guard][${level.toUpperCase()}] ${message}`));
  const timeoutMs = options.upstreamTimeoutMs ?? 300000;
  const upBase = options.upBaseUrl.replace(/\/+$/, '');
  const isHttps = upBase.startsWith('https://');
  const doRequest = isHttps ? httpsRequest : httpRequest;

  let seq = 0;

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((error: unknown) => {
      // 兜底：绝不让单个请求异常击穿进程
      if (!res.headersSent) {
        try {
          respondJson(res, 500, { error: { message: `guard 内部错误：${error instanceof Error ? error.message : String(error)}` } });
        } catch {
          res.destroy();
        }
      } else {
        res.destroy();
      }
    });
  });
  server.keepAliveTimeout = 75000;

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    seq += 1;
    const state: RequestState = {
      id: String(seq),
      method: req.method ?? 'GET',
      path: '/',
      startedAt: Date.now(),
      deepInspect: false,
      stream: null,
      modelReq: null,
      modelResp: null,
      usage: null,
      usageRejected: null,
      finishReason: null,
      ttftMs: null,
      bytesUp: 0,
      bytesDown: 0,
      aborted: false,
      status: 0,
      upstreamSent: false,
      errors: [],
      finalized: false,
    };

    // 1) 请求目标校验（防 SSRF/穿越）
    const target = validateRequestTarget(req.url ?? '/');
    if (!target.ok || target.path === null) {
      // 脱敏红线：journal 的 path 字段按约定「已去 query」，拒绝路径同样不得落原始 query（可能含凭证）
      state.path = (req.url ?? '/').split('?')[0]!.slice(0, 200);
      state.status = target.status;
      state.errors.push({ code: target.status === 403 ? 'target_forbidden' : 'target_invalid', status: target.status });
      respondJson(res, target.status, { error: { message: `${target.message}。收到：${truncate(req.url ?? '', 200)}` } });
      req.resume(); // 丢弃残余请求体，避免连接悬挂
      finalize(state);
      return;
    }
    state.path = target.path;

    // 2) 本地鉴权：客户端凭证必须与 MODEL_XRAY_KEY 一致
    const authHeader = typeof req.headers['authorization'] === 'string' ? (req.headers['authorization'] as string) : '';
    if (!constantTimeEqual(authHeader, `Bearer ${key}`)) {
      state.status = 401;
      state.errors.push({ code: 'unauthorized', status: 401 });
      respondJson(res, 401, {
        error: {
          message:
            '鉴权失败：guard 只转发携带正确凭证的请求。请把客户端 API key 设置为与 MODEL_XRAY_KEY 环境变量相同的值（请求头形如 Authorization: Bearer <MODEL_XRAY_KEY>），改完客户端配置后重试。',
        },
      });
      req.resume(); // 丢弃残余请求体，避免连接悬挂
      finalize(state);
      return;
    }

    // 3) 深检意图：仅深检端点 + 有请求体 + JSON 体
    const deepPath = DEEP_INSPECT_PATH.test(state.path);
    const requestJsonish = headerLooksJson(req.headers['content-type']);
    const deepIntent = deepPath && req.method !== 'GET' && req.method !== 'HEAD' && requestJsonish;
    state.deepInspect = deepIntent;

    // 4) 构造上游请求：凭证隔离 + hop-by-hop 剥离；深检端点强制 Accept-Encoding: identity（唯一允许的改写）
    const headers = stripHopHeaders(req.headers);
    delete headers['authorization'];
    delete headers['host'];
    delete headers['expect'];
    headers['authorization'] = `Bearer ${key}`;
    if (deepIntent) headers['accept-encoding'] = 'identity';

    const upstreamReq = doRequest(composeUpstreamUrl(options.upBaseUrl, req.url ?? '/'), {
      method: req.method ?? 'GET',
      headers,
    });
    // 必修①：此后该请求已实际发往上游——无论结果成败都计入评分窗口（本地拒绝路径走不到这里）
    state.upstreamSent = true;
    upstreamReq.setTimeout(timeoutMs, () => {
      state.errors.push({ code: 'upstream_timeout', status: 504 });
      upstreamReq.destroy(new Error('upstream idle timeout'));
    });

    // 5) 请求体：字节透传 + 上限捕获（供 model/stream 解析；超限放弃深检记基础行）
    const reqChunks: Buffer[] = [];
    let reqCaptured = 0;
    req.on('data', (chunk: Buffer) => {
      state.bytesUp += chunk.length;
      if (deepIntent && reqCaptured <= MAX_REQUEST_CAPTURE) {
        reqCaptured += chunk.length;
        if (reqCaptured > MAX_REQUEST_CAPTURE) {
          reqChunks.length = 0;
          state.deepInspect = false;
        } else {
          reqChunks.push(Buffer.from(chunk));
        }
      }
    });
    req.on('error', () => {
      // 客户端在上游响应前断开
      state.aborted = true;
      upstreamReq.destroy();
    });
    req.on('end', () => {
      if (deepIntent && reqCaptured > 0) {
        const parsed = parseRequestModel(Buffer.concat(reqChunks).toString('utf8'));
        if (parsed === null) {
          state.deepInspect = false; // 非 JSON 请求体：跳过深检
        } else {
          state.modelReq = parsed.model;
          state.stream = parsed.stream;
        }
      }
      reqChunks.length = 0;
    });

    upstreamReq.on('response', (upRes) => {
      state.status = upRes.statusCode ?? 0;
      const ok2xx = state.status >= 200 && state.status < 300;
      const contentType = String(upRes.headers['content-type'] ?? '');
      const isSse = ok2xx && deepIntent && contentType.includes('text/event-stream');
      const isJson = ok2xx && deepIntent && contentType.includes('json');
      if (!ok2xx) state.errors.push({ code: 'http_error', status: state.status });
      if (!isSse && !isJson) state.deepInspect = false;

      // 响应 tee：SSE Buffer 级逐行扫描 / JSON 缓冲解析，字节原样转发（tee 仅旁路观测，透传零改动）。
      // 误标兜底（真机实证：中转站会把非流式 JSON 标成 text/event-stream，反之亦有）：
      // - SSE 路径旁路暂存原始字节，直到出现首个 data: 行才释放；流末仍无 data: 行则按 JSON 整体兜底解析；
      // - JSON 路径整体解析失败时，退回按行扫 data: 兜底。
      let captured = 0;
      let jsonChunks: Buffer[] | null = isJson ? [] : null;
      let rawChunks: Buffer[] | null = [];
      let sawData = false;
      const scanner = isSse
        ? new ByteLineScanner((line) => {
            if (isDataLine(line)) {
              sawData = true;
              rawChunks = null; // 确认真 SSE：误标兜底材料不再需要，立即释放
            }
            handleSseLine(state, line);
          })
        : null;

      upRes.on('data', (chunk: Buffer) => {
        if (state.ttftMs === null) state.ttftMs = Date.now() - state.startedAt;
        state.bytesDown += chunk.length;
        if (scanner !== null) {
          // 观测链隔离：tee 是旁路观测，扫描器/暂存任何异常只降级深检，绝不影响透传（不 rethrow、不碰 res）
          try {
            if (rawChunks !== null && !sawData && state.deepInspect) {
              captured += chunk.length;
              if (captured > MAX_RESPONSE_CAPTURE) {
                rawChunks = null; // 超上限：放弃兜底材料（不影响流式行扫描的深检）
              } else {
                rawChunks.push(Buffer.from(chunk));
              }
            }
            if (state.deepInspect && !scanner.feed(chunk)) {
              state.deepInspect = false;
              rawChunks = null; // 单行超限降级：兜底材料一并释放
            }
          } catch {
            state.deepInspect = false;
            rawChunks = null;
          }
        } else if (jsonChunks !== null) {
          captured += chunk.length;
          if (captured > MAX_RESPONSE_CAPTURE) {
            jsonChunks = null;
            state.deepInspect = false;
          } else {
            jsonChunks.push(Buffer.from(chunk));
          }
        }
      });
      upRes.on('end', () => {
        // 已知残余（裁决保留）：头部既非 event-stream 亦非 json（如 text/plain）不深检；混合 body（SSE 行+JSON 尾）按首个 data: 行定性。
        if (scanner !== null) {
          try {
            scanner.end();
            const raw = rawChunks;
            rawChunks = null; // 兜底材料已取走，提前释放引用
            if (state.deepInspect && !sawData) {
              if (raw !== null && raw.length > 0) {
                // 误标兜底①：头标 SSE 但全程无 data: 行 → 整体按 JSON 解析，恢复 usage/model/finish_reason
                const parsed = parseResponseJson(Buffer.concat(raw).toString('utf8'));
                if (parsed === null) state.deepInspect = false;
                else applyParsed(state, parsed.model, parsed.usage, parsed.usageRejected, parsed.finishReason);
              } else {
                state.deepInspect = false; // 无 data: 行且无兜底材料（空 body / 超限弃料）：诚实降级，勿伪装成已检
              }
            }
          } catch {
            state.deepInspect = false;
            rawChunks = null;
          }
        } else if (jsonChunks !== null && state.deepInspect) {
          try {
            const body = Buffer.concat(jsonChunks);
            jsonChunks = null; // 缓冲已并入 body，提前释放引用
            const parsed = parseResponseJson(body.toString('utf8'));
            if (parsed !== null) {
              applyParsed(state, parsed.model, parsed.usage, parsed.usageRejected, parsed.finishReason);
            } else {
              // 误标兜底②（反向）：头标 json 但 body 实为 SSE data: 行 → 按行扫描恢复
              let applied = 0;
              let start = 0;
              for (;;) {
                const idx = body.indexOf(0x0a, start);
                const line = idx === -1 ? body.subarray(start) : body.subarray(start, idx);
                if (line.length > 0 && isDataLine(line) && handleSseLine(state, line)) applied += 1;
                if (idx === -1) break;
                start = idx + 1;
              }
              if (applied === 0) state.deepInspect = false;
            }
          } catch {
            state.deepInspect = false;
            jsonChunks = null;
          }
        }
      });

      // 透传上游状态码与响应头（剥 hop-by-hop；transfer-encoding 由 Node 重算，故必剥）
      if (!res.headersSent) {
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
          if (lower === 'connection' || lower === 'keep-alive' || lower === 'transfer-encoding' || lower === 'upgrade' || lower === 'te' || lower === 'trailer' || lower.startsWith('proxy-')) {
            continue;
          }
          if (named.has(lower)) continue;
          relay[name] = value;
        }
        res.writeHead(state.status, relay);
      }

      // 双端销毁由 pipeline 管理：任一端出错/提前关闭都会销毁对端
      void pipeline(upRes, res).catch(() => {
        upRes.destroy();
      });
    });

    upstreamReq.on('error', (error: Error) => {
      if (state.finalized) return;
      if (state.aborted || res.destroyed) {
        finalize(state);
        return;
      }
      const isTimeout = state.errors.some((e) => e.code === 'upstream_timeout') || /timeout/i.test(error.message);
      if (res.headersSent) {
        // 响应已开始后上游断流：客户端收到截断响应，按 aborted 记录，不再改写已发出的状态码
        state.aborted = true;
        state.errors.push({ code: 'upstream_interrupted', status: state.status });
        res.destroy();
        finalize(state);
        return;
      }
      const status = isTimeout ? 504 : 502;
      state.status = status;
      if (!isTimeout) state.errors.push({ code: 'upstream_unavailable', status });
      respondJson(res, status, {
        error: {
          message:
            status === 504
              ? `上游空闲超时（${Math.round(timeoutMs / 1000)}s 无数据），guard 已断开。可检查中转站健康度或调大上游超时。`
              : `上游连接失败：${error.message}。请检查 --base-url 与网络连通性。`,
        },
      });
      req.resume();
      finalize(state);
    });

    // 请求收尾统一挂 res 'close'：正常完成（writableEnded）与客户端断连（记 aborted）都在此 finalize，
    // 保证每个请求恰好一条 journal 行（401/403 等本地拒绝路径已在各自分支提前 finalize）
    res.on('close', () => {
      if (state.finalized) return;
      if (!res.writableEnded) {
        state.aborted = true;
        upstreamReq.destroy();
      }
      finalize(state);
    });

    // 请求体管道：流式转发（不整体缓冲），pipeline 负责双端销毁
    void pipeline(req, upstreamReq).catch(() => {
      upstreamReq.destroy();
    });
  }

  /**
   * 处理一条 SSE 行：data: 行携带可解析 JSON 载荷时应用到 state。
   * 返回是否实际应用了一行（误标兜底路径用它判定「至少应用了一行」）。
   */
  function handleSseLine(state: RequestState, lineBytes: Buffer): boolean {
    const payload = sseDataOf(lineBytes);
    if (payload === null) return false;
    const data = payload.trim();
    if (data.length === 0 || data === '[DONE]') return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return false;
    }
    if (typeof parsed !== 'object' || parsed === null) return false;
    applyParsedObject(state, parsed as Record<string, unknown>);
    return true;
  }

  function applyParsedObject(
    state: RequestState,
    obj: Record<string, unknown>,
  ): void {
    const model = typeof obj['model'] === 'string' && obj['model'].length > 0 ? (obj['model'] as string) : null;
    let usage = state.usage;
    let usageRejected = state.usageRejected;
    if ('usage' in obj) {
      const validated = validateUsage(obj['usage']);
      usage = validated.usage;
      usageRejected = validated.reason;
    }
    applyParsed(state, model, usage, usageRejected, finishReasonOf(obj));
  }

  function finalize(state: RequestState): void {
    if (state.finalized) return;
    state.finalized = true;
    const durationMs = Date.now() - state.startedAt;
    journal.append({
      type: 'request',
      ts: new Date().toISOString(),
      id: state.id,
      method: state.method,
      path: state.path,
      status: state.status,
      stream: state.stream === true,
      deepInspect: state.deepInspect,
      modelReq: state.modelReq,
      modelResp: state.modelResp,
      usage: state.usage,
      usageRejected: state.usageRejected,
      finishReason: state.finishReason,
      ttftMs: state.ttftMs,
      durationMs,
      bytesUp: state.bytesUp,
      bytesDown: state.bytesDown,
      aborted: state.aborted,
      errors: state.errors,
    });

    const anomalies = buildAnomalies({
      modelReq: state.modelReq,
      modelResp: state.modelResp,
      usage: state.usage,
      usageRejected: state.usageRejected,
      finishReason: state.finishReason,
    });
    for (const anomaly of anomalies) {
      journal.append({
        type: 'anomaly',
        ts: new Date().toISOString(),
        requestId: state.id,
        path: state.path,
        code: anomaly.code,
        level: anomaly.level,
        message: anomaly.message,
      });
      if (anomaly.level === 'warn' || anomaly.level === 'error') {
        onAlert(anomaly.level, `#${state.id} ${anomaly.code}：${anomaly.message}`);
      }
    }

    if (state.modelReq !== null && options.fingerprint !== null) options.fingerprint.noteModel(state.modelReq);
    // 对账窗口与评分卡同口径：只收「已实际发往上游」的请求——本地 401/403/目标校验拒绝
    // 从未触达上游、不可能产生扣费，计入窗口只会虚增 requests/usageMissing、打破空窗静默
    if (state.upstreamSent) options.reconciler?.recordCompletion(state.usage);

    // 评分卡：仅「已实际发往上游」的请求入窗；必修⑤——record 任何异常只 stderr 一行，绝不打断请求管线
    if (state.upstreamSent && options.scoreboard !== undefined) {
      try {
        options.scoreboard.record(
          {
            status: state.status,
            aborted: state.aborted,
            modelReq: state.modelReq,
            modelResp: state.modelResp,
            usage: state.usage,
            usageRejected: state.usageRejected,
            finishReason: state.finishReason,
            ttftMs: state.ttftMs,
            deepInspect: state.deepInspect,
          },
          state.id,
        );
      } catch (error) {
        console.error(`[guard] 评分卡记录失败（不影响转发）：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const usageText = state.usage !== null ? `${state.usage.prompt_tokens}+${state.usage.completion_tokens}=${state.usage.total_tokens}` : 'none';
    const flags = [
      state.stream === true ? 'stream' : state.stream === false ? 'json' : 'raw',
      state.deepInspect ? 'deep' : null,
      state.aborted ? 'aborted' : null,
    ]
      .filter(Boolean)
      .join(',');
    onSummary(
      `#${state.id} ${state.method} ${state.path} -> ${state.status} [${flags}] usage=${usageText} ` +
        `ttft=${state.ttftMs === null ? '-' : `${state.ttftMs}ms`} total=${durationMs}ms up=${state.bytesUp}B down=${state.bytesDown}B anomalies=${anomalies.length}`,
    );
  }

  async function listen(port: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const onError = (error: Error): void => {
        reject(error);
      };
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError);
        const address = server.address();
        resolve(address !== null && typeof address === 'object' ? address.port : port);
      });
    });
  }

  async function close(): Promise<void> {
    const closed = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error !== undefined) reject(error);
        else resolve();
      });
    });
    const force = server as Server & { closeAllConnections?: () => void };
    force.closeAllConnections?.();
    await closed;
  }

  return { server, listen, close };
}

// ---------- 解析助手 ----------

function headerLooksJson(value: string | string[] | undefined): boolean {
  if (value === undefined) return true; // 无 content-type 时按 JSON 尝试，解析失败自动降级
  const text = Array.isArray(value) ? value.join(',') : value;
  return text.toLowerCase().includes('json');
}

function parseRequestModel(text: string): { model: string; stream: boolean } | null {
  if (text.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj['model'] !== 'string' || obj['model'].length === 0) return null;
  return { model: obj['model'] as string, stream: obj['stream'] === true };
}

interface ParsedResponse {
  model: string | null;
  usage: Usage | null;
  usageRejected: UsageRejection | null;
  finishReason: string | null;
}

function parseResponseJson(text: string): ParsedResponse | null {
  if (text.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const model = typeof obj['model'] === 'string' && obj['model'].length > 0 ? (obj['model'] as string) : null;
  let usage: Usage | null = null;
  let usageRejected: UsageRejection | null = null;
  if ('usage' in obj) {
    const validated = validateUsage(obj['usage']);
    usage = validated.usage;
    usageRejected = validated.reason;
  }
  return { model, usage, usageRejected, finishReason: finishReasonOf(obj) };
}

function applyParsed(
  state: RequestState,
  model: string | null,
  usage: Usage | null,
  usageRejected: UsageRejection | null,
  finishReason: string | null,
): void {
  if (model !== null) state.modelResp = model;
  if (usage !== null) {
    state.usage = usage;
    state.usageRejected = null;
  } else if (usageRejected !== null) {
    state.usage = null;
    state.usageRejected = usageRejected;
  }
  if (finishReason !== null) state.finishReason = finishReason;
}

function finishReasonOf(obj: Record<string, unknown>): string | null {
  const choices = obj['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const choice = choices[0];
  if (typeof choice !== 'object' || choice === null) return null;
  const reason = (choice as Record<string, unknown>)['finish_reason'];
  return typeof reason === 'string' && reason.length > 0 ? reason : null;
}

/**
 * 判定一行是否为 SSE data 行（字节前缀 `data:` = 0x64 0x61 0x74 0x61 0x3a）。
 * 只看前 5 字节，多字节安全；注释行（: x）/ event 行 / 空行 / 纯 JSON 首行（{ 开头）均非 data 行。
 */
export function isDataLine(lineBytes: Buffer): boolean {
  return (
    lineBytes.length >= 5 &&
    lineBytes[0] === 0x64 &&
    lineBytes[1] === 0x61 &&
    lineBytes[2] === 0x74 &&
    lineBytes[3] === 0x61 &&
    lineBytes[4] === 0x3a
  );
}

/** 取 SSE 行的 data 载荷；非 data 行返回 null。入参必须是完整行（换行字节已剥离），多字节安全。 */
function sseDataOf(lineBytes: Buffer): string | null {
  if (!isDataLine(lineBytes)) return null;
  let start = 5;
  if (lineBytes.length > 5 && lineBytes[5] === 0x20) start = 6; // SSE 规定剥一个前导空格
  return lineBytes.toString('utf8', start);
}

/** Buffer 级逐行扫描：只在 0x0A 字节边界切片（UTF-8 多字节序列不含 0x0A），完整行才 string 化。 */
export class ByteLineScanner {
  private pending: Buffer = Buffer.alloc(0);
  private dead = false;

  constructor(private readonly onLine: (line: Buffer) => void) {}

  /**
   * 喂入一个 chunk；返回 false 表示行缓冲超限（放弃深检）。
   */
  feed(chunk: Buffer): boolean {
    if (this.dead) return false;
    let buf = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    let start = 0;
    for (;;) {
      const idx = buf.indexOf(0x0a, start);
      if (idx === -1) break;
      this.onLine(buf.subarray(start, idx));
      start = idx + 1;
    }
    if (start === 0) {
      this.pending = buf;
    } else if (start < buf.length) {
      this.pending = Buffer.from(buf.subarray(start));
    } else {
      this.pending = Buffer.alloc(0);
    }
    if (this.pending.length > MAX_LINE_BYTES) {
      this.dead = true;
      this.pending = Buffer.alloc(0);
      return false;
    }
    return true;
  }

  /** 流结束时冲洗最后一行（无换行结尾的尾行）。 */
  end(): void {
    if (this.dead || this.pending.length === 0) return;
    const last = this.pending;
    this.pending = Buffer.alloc(0);
    this.onLine(last);
  }
}

function respondJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(JSON.stringify(payload))) });
  res.end(JSON.stringify(payload));
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
