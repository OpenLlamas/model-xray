import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { IDENTITY_QUESTIONS } from '../src/assets.js';

export type MockMode =
  | 'honest'
  | 'relabel'
  | 'const-usage'
  | 'inflated'
  | 'truncate'
  | 'oversize-reject'
  | 'no-vision'
  | 'tool-fail'
  | 'dumb'
  | 'flaky'
  | 'flaky500'
  | 'badusage'
  | 'empty'
  | 'swap-model'
  | 'slow-stream'
  | 'auth-required'
  | 'thinking-starve'
  | 'json-as-sse'
  | 'sse-as-json'
  | 'sse-empty'
  | 'sse-comments'
  | 'error-payload'
  | 'persona-inject'
  | 'usage-scale'
  | 'retry-fix';

export interface MockBehavior {
  mode: MockMode;
  truncateTokens: number;
  identityName: string;
  inflateFactor: number;
  failEvery: number;
  balanceSeries: number[];
  /** badusage：交替注入 inconsistent/negative usage 的计数器 */
  badUsageSeq: number;
  /** flaky500：已注入过 500 的请求体摘要（同体重放即重试 → 返回 200） */
  seen500: Set<string>;
  /** 可编程余额：base + rate × 已消耗成本（guard 对账 e2e 用；rate=null 时按 balanceSeries 走） */
  balanceBase: number;
  balanceRate: number | null;
  /** 成本核算价格（$/M tokens），与 guard 侧 --price-* 对应 */
  priceInput: number;
  priceOutput: number;
  costAccumulated: number;
  /** thinking-starve：max_tokens 低于该阈值时返回推理占满预算响应（content 截断 + finish_reason=length） */
  starveBelow: number;
  /** thinking-starve：starved 响应的正文（''=纯空；也可为 '{"a":' 类非空截断） */
  starveTruncated: string | null;
  /** thinking-starve：命中的问题豁免 starvation（照常作答），用于构造「部分样本被截断」场景 */
  starveExempt: RegExp | null;
  /** usage-scale：prompt/completion 等比缩放倍率（1.3 = 全量虚增 30%，线性回归不可见） */
  usageScale: number;
  /** persona-inject：identity 自述题的计数器（第 2、5 个样本注入品牌人格） */
  personaSeq: number;
  /** retry-fix：允许首答错（+1 扰动）的题面数上限 */
  retryFixPerturb: number;
  /** retry-fix：已扰动过的题面文本（同题面重放即返回正确答案，模拟「复采样答对」） */
  perturbed: Set<string>;
}

export interface MockOptions {
  mode: MockMode;
  truncateTokens?: number;
  identityName?: string;
  inflateFactor?: number;
  failEvery?: number;
  /** GET /dashboard/billing/usage 按查询次数从该序列取值（用尽后取最后一个） */
  balanceSeries?: number[];
  /** 可编程扣费倍率：余额 = balanceBase + balanceRate × Σ(usage 成本)，供对账 ratio=k 的确定性 e2e */
  balanceBase?: number;
  balanceRate?: number;
  priceInput?: number;
  priceOutput?: number;
  /** thinking-starve：starvation 触发阈值（请求 max_tokens < 该值即截断），默认 1024 */
  starveBelow?: number;
  /** thinking-starve：starved 响应正文，默认 ''（空 content）；'{"a":' 类非空截断用于测 isStarved 捕获 */
  starveTruncated?: string;
  /** thinking-starve：豁免 starvation 的问题正则（命中则照常作答），用于构造「部分样本被截断」场景 */
  starveExempt?: RegExp;
  /** usage-scale：prompt/completion 等比缩放倍率，默认 1（忠实复刻 issue 场景：×1.3 线性回归不可见） */
  usageScale?: number;
  /** retry-fix：允许首答错（+1 扰动）的题面数上限，默认 3（首答错、复采样对，两次机会口径下应 100 分） */
  retryFixPerturb?: number;
}

export const COLOR_TABLE: ReadonlyArray<{ name: string; rgb: [number, number, number] }> = [
  { name: 'red', rgb: [220, 30, 30] },
  { name: 'green', rgb: [30, 170, 60] },
  { name: 'blue', rgb: [30, 60, 220] },
  { name: 'purple', rgb: [140, 40, 200] },
  { name: 'pink', rgb: [240, 120, 180] },
  { name: 'orange', rgb: [240, 140, 20] },
  { name: 'brown', rgb: [130, 80, 40] },
  { name: 'gray', rgb: [120, 120, 120] },
];

export interface MockServer {
  server: Server;
  baseUrl: string;
  state: {
    served: number;
    balanceQueries: number;
    /** 每个 chat 请求收到的 Authorization 头原值（guard 凭证注入断言用） */
    authSeen: string[];
    /** 每个 chat 请求收到的 Proxy-Authorization 头原值（凭证剥离断言用） */
    proxyAuthSeen: string[];
    /** 每个 chat 请求实际到达的完整原始 URL（含 query；guard 前缀去重与 query 透明断言用） */
    pathSeen: string[];
  };
}

export function createMockServer(options: MockOptions): Promise<MockServer> {
  const behavior: MockBehavior = {
    mode: options.mode,
    truncateTokens: options.truncateTokens ?? 8000,
    identityName: options.identityName ?? 'GLM-4',
    inflateFactor: options.inflateFactor ?? 4,
    failEvery: options.failEvery ?? 0,
    balanceSeries: options.balanceSeries ?? [100.0, 99.5],
    badUsageSeq: 0,
    seen500: new Set<string>(),
    balanceBase: options.balanceBase ?? 100,
    balanceRate: options.balanceRate === undefined ? null : options.balanceRate,
    priceInput: options.priceInput ?? 2,
    priceOutput: options.priceOutput ?? 8,
    costAccumulated: 0,
    starveBelow: options.starveBelow ?? 1024,
    starveTruncated: options.starveTruncated ?? null,
    starveExempt: options.starveExempt ?? null,
    usageScale: options.usageScale ?? 1,
    personaSeq: 0,
    retryFixPerturb: options.retryFixPerturb ?? 3,
    perturbed: new Set<string>(),
  };
  const state: MockServer['state'] = { served: 0, balanceQueries: 0, authSeen: [], proxyAuthSeen: [], pathSeen: [] };

  const server = createServer(async (req, res) => {
    // auth-required：所有路径统一 401（无效 key 场景，全部探针证据不足）
    if (behavior.mode === 'auth-required') {
      sendJson(res, 401, { error: { message: 'invalid api key', type: 'invalid_request_error', code: 'invalid_api_key' } });
      return;
    }
    if (req.method === 'GET' && req.url !== undefined && req.url.split('?')[0]?.endsWith('/dashboard/billing/usage')) {
      let value: number;
      if (behavior.balanceRate !== null) {
        // 可编程倍率模式：余额跟随已消耗成本（guard 对账 e2e 的确定性数据源）。
        // 注意单位：/dashboard/billing/usage 的 total_usage 按 one-api 语义为「分」（probeBalance 会 ÷100 折算），
        // 故这里乘 100——保证 guard 读到的 USD 值恰为 base + rate×cost。
        value = (behavior.balanceBase + behavior.balanceRate * behavior.costAccumulated) * 100;
      } else {
        const series = behavior.balanceSeries;
        const index = Math.min(state.balanceQueries, series.length - 1);
        value = index >= 0 && series[index] !== undefined ? (series[index] as number) : 0;
      }
      state.balanceQueries += 1;
      sendJson(res, 200, { object: 'list', total_usage: value });
      return;
    }
    // query 透明转发语义：guard 会原样转发 query（真实中转可能需要），mock 路由按去 query 后的 path 匹配
    if (req.method !== 'POST' || !req.url?.split('?')[0]?.endsWith('/chat/completions')) {
      sendJson(res, 404, { error: { message: 'not found' } });
      return;
    }
    state.pathSeen.push(req.url ?? '');
    if (typeof req.headers.authorization === 'string') state.authSeen.push(req.headers.authorization);
    if (typeof req.headers['proxy-authorization'] === 'string') state.proxyAuthSeen.push(req.headers['proxy-authorization']);
    let body: Record<string, unknown>;
    let rawBody = '';
    try {
      rawBody = await readBody(req);
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: { message: 'invalid json' } });
      return;
    }
    state.served += 1;
    if (behavior.mode === 'flaky' && behavior.failEvery > 0 && state.served % behavior.failEvery === 0) {
      sendJson(res, 500, { error: { message: 'injected fault' } });
      return;
    }
    // flaky500：瞬时故障模拟——每个唯一请求体首次返回 500，客户端重试（同请求体）即返回 200；
    // balance 端点不受影响（上方已提前返回）。
    if (behavior.mode === 'flaky500') {
      const digest = createHash('sha1').update(rawBody).digest('hex');
      if (!behavior.seen500.has(digest)) {
        behavior.seen500.add(digest);
        sendJson(res, 500, { error: { message: 'injected transient 500' } });
        return;
      }
    }
    handle(res, behavior, body, state);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no port');
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}/v1`, state });
    });
  });
}

function handle(res: ServerResponse, behavior: MockBehavior, body: Record<string, unknown>, state: { served: number }): void {
  const messages = Array.isArray(body['messages']) ? (body['messages'] as Array<Record<string, unknown>>) : [];
  const last = messages[messages.length - 1] ?? {};
  const userText = textOf(last);
  const allText = messages.map((m) => textOf(m)).join('\n');
  const tools = Array.isArray(body['tools']) ? (body['tools'] as unknown[]) : [];
  const stream = body['stream'] === true;
  const imageUrl = findImageUrl(last);
  const modelName = typeof body['model'] === 'string' ? body['model'] : 'mock-model';

  // slow-stream：先发一个内容 chunk 然后挂住连接不结束（guard 客户端断连 e2e 用）
  if (behavior.mode === 'slow-stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(
      `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model: modelName, choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] })}\n\n`,
    );
    const hold = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
      } catch {
        clearInterval(hold);
      }
    }, 200);
    const release = (): void => clearInterval(hold);
    res.on('close', release);
    res.on('error', release);
    return;
  }

  // empty：所有 chat 请求一律返回 200 + 空 content（模拟限流/截断下端点「成功但无内容」）
  if (behavior.mode === 'empty') {
    sendReply(res, behavior, '', estimate(allText), stream, modelName);
    return;
  }

  // sse-empty：2xx + event-stream 头 + 零字节 body（writeHead 后立即 end，与请求 stream 标志无关；
  // 模拟中转站「空体误标 SSE」，guard 须诚实降级而非伪装成已检）
  if (behavior.mode === 'sse-empty') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.end();
    return;
  }

  // sse-comments：2xx + event-stream 头 + body 恰为 ": keep-alive\n\n"（仅 SSE 注释行，无 data: 行；
  // 模拟 keep-alive 注释流，guard 兜底①整体 JSON 解析必失败 → 诚实降级）
  if (behavior.mode === 'sse-comments') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.end(': keep-alive\n\n');
    return;
  }

  // error-payload：HTTP 200 却回 error 载荷（stream → SSE `data: {"error":...}`；非流式 → JSON），
  // 模拟中转站欠费/限流/上游熔断的经典形态。此前客户端零信号 → ok:true 空正文，
  // 探针据此指控「未发起工具调用」「上下文内容不可读」= 诬告；识别后须按请求失败降级。
  if (behavior.mode === 'error-payload') {
    const payload = JSON.stringify({
      error: { message: 'upstream provider temporarily unavailable, please retry', type: 'upstream_error', code: 'no_available_channel' },
    });
    if (stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.end(`data: ${payload}\n\ndata: [DONE]\n\n`);
    } else {
      sendJson(res, 200, { error: { message: 'upstream provider temporarily unavailable, please retry', type: 'upstream_error', code: 'no_available_channel' } });
    }
    return;
  }

  const toolResultNonce = findToolResultNonce(messages);
  if (toolResultNonce !== null) {
    sendReply(res, behavior, `已收到工具结果，nonce ${toolResultNonce} 确认。`, estimate(allText), stream, modelName);
    return;
  }

  // thinking-starve：模拟 thinking 模型「推理占满 max_tokens 预算」——
  // 预算 < 阈值时 content 为空（或指定截断正文）+ finish_reason=length + usage(completion_tokens==max_tokens)；
  // 预算足够（或问题命中豁免正则）时照常作答 finish_reason=stop。
  if (behavior.mode === 'thinking-starve') {
    const maxTokens = typeof body['max_tokens'] === 'number' ? body['max_tokens'] : 0;
    const exempt = behavior.starveExempt !== null && behavior.starveExempt.test(userText);
    if (maxTokens > 0 && maxTokens < behavior.starveBelow && !exempt) {
      sendStarvedReply(res, behavior, behavior.starveTruncated ?? '', estimate(allText), stream, modelName, maxTokens);
      return;
    }
  }

  if (behavior.mode === 'no-vision' && imageUrl !== null) {
    sendJson(res, 400, { error: { message: 'model does not support image input', type: 'invalid_request_error' } });
    return;
  }

  if (behavior.mode === 'truncate' || behavior.mode === 'oversize-reject') {
    const estimatedTokens = Math.ceil(allText.length / 3.2);
    if (estimatedTokens > behavior.truncateTokens) {
      if (behavior.mode === 'oversize-reject') {
        sendJson(res, 400, {
          error: { message: 'maximum context length exceeded', type: 'invalid_request_error', code: 'context_length_exceeded' },
        });
        return;
      }
      const keepChars = Math.floor(behavior.truncateTokens * 3.2);
      const clipped = allText.slice(-keepChars);
      const clippedUser = userText.length > keepChars ? userText.slice(-keepChars) : userText;
      const reply = applyRetryFix(behavior, clippedUser, solve(clipped, behavior, clippedUser, imageUrl, modelName, state.served));
      sendReply(res, behavior, reply, estimatedTokens, stream, modelName);
      return;
    }
  }

  if (behavior.mode === 'tool-fail' && tools.length > 0) {
    sendReply(res, behavior, '这个请求看起来需要工具，但我不太确定怎么做。', estimate(allText), stream, modelName);
    return;
  }

  const reply = applyRetryFix(behavior, userText, solve(allText, behavior, userText, imageUrl, modelName, state.served));
  sendReply(res, behavior, reply, estimate(allText), stream, modelName);
}

/**
 * retry-fix（F1 e2e）：对「数值答案」题面注入至多 retryFixPerturb 个首答错误（+1 扰动）；
 * 同题面重放（= 复采样）返回原正确答案。效果：默认 3 个主题首答错、复采样对（两次机会口径 100 分；
 * 旧单次口径为 9/12 warn）。控制题（复用 dumb 分支同款正则）不得扰动，防止控制题失败。
 */
function applyRetryFix(behavior: MockBehavior, userText: string, reply: string): string {
  if (behavior.mode !== 'retry-fix') return reply;
  const question =
    userText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .at(-1) ?? '';
  const isControl =
    /一年有几个月/.test(question) ||
    /^\s*\d{1,2}\s*[+＋]\s*\d{1,2}\s*等于/.test(question) ||
    /^\s*\d{1,2}\s*[×x*]\s*\d{1,2}\s*等于/.test(question);
  if (isControl) return reply;
  if (!/^-?\d+(\.\d+)?$/.test(reply.trim())) return reply;
  if (!behavior.perturbed.has(userText) && behavior.perturbed.size < behavior.retryFixPerturb) {
    behavior.perturbed.add(userText);
    return String(Number(reply.trim()) + 1);
  }
  return reply;
}

function solve(
  allText: string,
  behavior: MockBehavior,
  userText: string,
  imageUrl: string | null,
  modelName: string,
  served: number,
): string {
  const question =
    userText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .at(-1) ?? '';

  if (behavior.mode === 'relabel') {
    if (/JSON/i.test(question)) return '{"model_family": "GLM", "language_count": 30}';
    return `我是 ${behavior.identityName}，由智谱 AI 开发。`;
  }

  if (imageUrl !== null) {
    const rgb = decodePngFirstPixel(imageUrl);
    return rgb !== null ? nearestColorName(rgb) : 'red';
  }

  if (/JSON/i.test(question) && /model_family|self_name/.test(question)) {
    if (/model_family/.test(question)) return '{"model_family": "mock-family", "language_count": 12}';
    return '{"self_name": "mock-model", "context_window": 32000}';
  }

  if (/复述|repeat/i.test(question)) {
    const lines = userText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    return lines.at(-2) ?? '';
  }

  if (/口令|passphrase|校验|archive/i.test(question)) {
    const record = allText.match(/(?:档案记录|勘误条目|ARCHIVE RECORD)\s*([A-Z0-9]{6})/);
    if (record && record[1]) return record[1];
  }

  if (/echo_nonce/.test(question) && /工具|调用|tool/i.test(question)) {
    const quoted = question.match(/nonce[^"]*"([A-Z0-9]{4,12})"/);
    const nonce = quoted?.[1] ?? question.match(/\b[A-Z0-9]{6}\b/)?.[0] ?? 'NONCE1';
    return `__tool__${nonce}`;
  }

  if (behavior.mode === 'dumb') {
    const mathish =
      /[×*]|除以|余数|等于|hours|Multiply|JSON|偶数|面积|%|多少个|下一项|更大|包含几个/.test(question);
    const isControl =
      /一年有几个月/.test(question) ||
      /^\s*\d{1,2}\s*[+＋]\s*\d{1,2}\s*等于/.test(question) ||
      /^\s*\d{1,2}\s*[×x*]\s*\d{1,2}\s*等于/.test(question);
    if (mathish && !isControl) {
      if (/偶数/.test(question)) {
        const odd = (question.match(/\d+/g) ?? []).map(Number).find((n) => n % 2 === 1);
        return String(odd ?? '-1');
      }
      const nums = (question.match(/\d+/g) ?? []).map(Number);
      return nums.length > 0 ? String((nums[0] as number) + 1) : '-1';
    }
  }

  const multi = question.match(/(\d+)\s*[×x*]\s*(\d+)\s*\+\s*(\d+)/);
  if (multi) return String(Number(multi[1]) * Number(multi[2]) + Number(multi[3]));

  const mulOnly = question.match(/(\d+)\s*[×x*]\s*(\d+)/);
  if (mulOnly) return String(Number(mulOnly[1]) * Number(mulOnly[2]));

  const crate = question.match(/(\d+)\s*个[^，。]*[，,]\s*(\d+)\s*箱/);
  if (crate) return String(Number(crate[1]) * Number(crate[2]));

  const div = question.match(/(\d+)\s*除以\s*(\d+)/);
  if (div) return String(Number(div[1]) % Number(div[2]));

  const seq = question.match(/数列\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+)/);
  if (seq) {
    const a = Number(seq[1]);
    const b = Number(seq[2]);
    return String(Number(seq[4]) + (b - a));
  }

  const list = question.match(/以下哪个数是偶数[:：]\s*([\d,，\s]+)/);
  if (list) {
    const numbers = (list[1] ?? '').split(/[,，\s]+/).map(Number).filter((n) => Number.isFinite(n));
    const even = numbers.find((n) => n % 2 === 0);
    if (even !== undefined) return String(even);
  }

  const compare = question.match(/(\d+)\s*\+\s*(\d+)\s*与\s*(\d+)\s*\+\s*(\d+)/);
  if (compare) {
    const left = Number(compare[1]) + Number(compare[2]);
    const right = Number(compare[3]) + Number(compare[4]);
    return String(Math.max(left, right));
  }

  const countX = question.match(/"([a-z]+)"/);
  if (countX && /包含几个/.test(question)) {
    const count = [...(countX[1] ?? '')].filter((c) => c === 'x').length;
    return String(count);
  }

  const doubleMatch = question.match(/Multiply\s+(\d+)\s+by\s+2\s+and\s+then\s+subtract\s+7/i);
  if (doubleMatch) return String(Number(doubleMatch[1]) * 2 - 7);

  const days = question.match(/(\d+)\s+days\s+equal\s+how\s+many\s+hours/i);
  if (days) return String(Number(days[1]) * 24);

  const json = question.match(/\{"a":\s*(\d+),\s*"b":\s*(\d+)\}/);
  if (json) return String(Number(json[1]) - Number(json[2]));

  const area = question.match(/长\s*(\d+)\s*宽\s*(\d+)/);
  if (area) return String(Number(area[1]) * Number(area[2]));

  const percent = question.match(/(\d+)\s*的\s*(\d+)%/);
  if (percent) return String((Number(percent[1]) * Number(percent[2])) / 100);

  const plus = question.match(/(\d+)\s*\+\s*(\d+)/);
  if (plus) return String(Number(plus[1]) + Number(plus[2]));

  if (/一年有几个月/.test(question)) return '12';
  if (/127\s*[×x*]\s*31/.test(question)) return '3937';
  if (/pong|ping/i.test(question)) return 'pong';

  // persona-inject（F2 e2e）：端点识别自述题后向 system prompt 注入「品牌人格」——第 2、5 个
  // 自述样本返回非模型族人格自述（'I am NovaRelay assistant...'），其余样本照常走下方 identity 回显分支
  // （照常声明目标族 gpt）。效果：5 样本 2 个 persona → identity warn 封顶 80（精确复刻 issue #1 C2）。
  if (behavior.mode === 'persona-inject' && isIdentityQuestion(userText, question)) {
    behavior.personaSeq += 1;
    if (behavior.personaSeq === 2 || behavior.personaSeq === 5) {
      return 'I am NovaRelay assistant, built by NovaRelay Labs.';
    }
  }

  // v0.2.1：identity 固定版本自述题（完整模型名称/精确版本号）也按端点模型作答，否则 honest 端点会答非所问
  if (/你是什么AI模型|什么模型|真实身份|State your exact model|Which AI model|model name|完整模型名称|精确版本号/i.test(question)) {
    const variants = [`我是 ${modelName}，由 OpenAI 开发。`, `I am ${modelName}, created by OpenAI.`, `I'm the ${modelName} model.`];
    return variants[served % variants.length] as string;
  }

  return '好的，收到。';
}

/** identity 题识别（persona-inject 用）：IDENTITY_QUESTIONS 全文命中或既有回显关键词命中。 */
function isIdentityQuestion(userText: string, question: string): boolean {
  if (IDENTITY_QUESTIONS.some((q) => userText.includes(q))) return true;
  return /你是什么AI模型|什么模型|真实身份|State your exact model|Which AI model|model name|完整模型名称|精确版本号/i.test(question);
}

function findToolResultNonce(messages: Array<Record<string, unknown>>): string | null {
  const last = messages[messages.length - 1];
  if (!last || last['role'] !== 'tool') return null;
  for (const message of messages) {
    const calls = message['tool_calls'];
    if (!Array.isArray(calls) || calls.length === 0) continue;
    const first = calls[0] as Record<string, unknown>;
    const fn = first['function'];
    if (typeof fn !== 'object' || fn === null) continue;
    const args = (fn as Record<string, unknown>)['arguments'];
    if (typeof args !== 'string') continue;
    try {
      const parsed = JSON.parse(args) as Record<string, unknown>;
      if (typeof parsed['nonce'] === 'string') return parsed['nonce'];
    } catch {
      continue;
    }
  }
  return null;
}

function estimate(text: string): number {
  return Math.max(1, Math.ceil(text.length / 3.2));
}

/** honest 端点回显请求模型；swap-model 返回 identityName（≠请求模型，guard 换模型告警用）。 */
function responseModelOf(behavior: MockBehavior, modelName: string): string {
  return behavior.mode === 'swap-model' ? behavior.identityName : modelName;
}

function sendReply(
  res: ServerResponse,
  behavior: MockBehavior,
  reply: string,
  estimatedTokens: number,
  stream: boolean,
  modelName: string,
): void {
  const usage = computeUsage(behavior, estimatedTokens, reply);
  const model = responseModelOf(behavior, modelName);
  if (reply.startsWith('__tool__')) {
    sendToolCall(res, reply.slice('__tool__'.length), usage, stream, model);
    return;
  }
  // sse-as-json：无论客户端是否请求流式，一律回真实 SSE 格式 body（data: 行 + usage 尾行 + [DONE]），
  // 但 content-type 误标为 application/json（中转站误标场景，guard 须按行兜底恢复）。
  const replyStream = stream || behavior.mode === 'sse-as-json';
  const payload = {
    id: 'mock',
    object: 'chat.completion',
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
    usage,
  };
  if (!replyStream) {
    if (behavior.mode === 'json-as-sse') {
      // json-as-sse：与 honest 相同的单行 JSON body（含 usage、model 回显），但 content-type 误标为
      // text/event-stream；单行无尾部换行、一次 write 后 end（无 chunked 分片），guard 须整体 JSON 兜底。
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.end(JSON.stringify(payload));
      return;
    }
    sendJson(res, 200, payload);
    return;
  }

  res.writeHead(200, {
    'content-type': behavior.mode === 'sse-as-json' ? 'application/json' : 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  for (const piece of splitIntoPieces(reply)) {
    res.write(
      `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`,
    );
  }
  res.write(
    `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\n`,
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

function splitIntoPieces(text: string): string[] {
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += 3) pieces.push(text.slice(i, i + 3));
  return pieces.length > 0 ? pieces : [''];
}

/** thinking-starve 专用响应：预算全部耗尽（明文 reasoning_tokens 计入 completion），finish_reason=length。 */
function sendStarvedReply(
  res: ServerResponse,
  behavior: MockBehavior,
  content: string,
  estimatedTokens: number,
  stream: boolean,
  modelName: string,
  maxTokens: number,
): void {
  const prompt = Math.max(10, estimatedTokens);
  // completion_tokens == 请求的 max_tokens：预算全部耗尽；reasoning_tokens 明文计入其中（OpenAI usage 扩展字段形状）
  const completion = Math.max(1, maxTokens);
  const usage = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    completion_tokens_details: { reasoning_tokens: completion },
  };
  behavior.costAccumulated += (prompt * behavior.priceInput + completion * behavior.priceOutput) / 1e6;
  const model = responseModelOf(behavior, modelName);
  if (!stream) {
    sendJson(res, 200, {
      id: 'mock',
      object: 'chat.completion',
      model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'length' }],
      usage,
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  for (const piece of splitIntoPieces(content)) {
    res.write(
      `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`,
    );
  }
  res.write(
    `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'length' }], usage })}\n\n`,
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

function sendToolCall(res: ServerResponse, nonce: string, usage: MockUsage, stream: boolean, model: string): void {
  const args = JSON.stringify({ nonce });
  if (!stream) {
    sendJson(res, 200, {
      id: 'mock',
      object: 'chat.completion',
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'echo_nonce', arguments: args } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage,
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'echo_nonce', arguments: args } }] }, finish_reason: null }] })}\n\n`,
  );
  res.write(`data: ${JSON.stringify({ model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

interface MockUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details: { cached_tokens: number };
  completion_tokens_details: { reasoning_tokens: number };
}

function computeUsage(behavior: MockBehavior, estimatedTokens: number, reply: string): MockUsage {
  let prompt: number;
  let completion: number;
  let total: number;
  if (behavior.mode === 'const-usage') {
    prompt = 500;
    completion = 50;
    total = 550;
  } else if (behavior.mode === 'badusage') {
    // badusage：奇数笔 total≠分项和（inconsistent）、偶数笔 prompt_tokens 为负（negative），交替注入
    behavior.badUsageSeq += 1;
    completion = Math.max(1, Math.ceil(reply.length / 3.2));
    prompt = Math.max(10, estimatedTokens);
    if (behavior.badUsageSeq % 2 === 1) {
      total = prompt + completion + 7;
    } else {
      prompt = -prompt;
      total = prompt + completion;
    }
  } else {
    completion = Math.max(1, Math.ceil(reply.length / 3.2));
    // 0.8 校准：本 mock 的 len/3.2 估算 vs 工具 estimateTokens（英文 ≈len/4）存在 1.25× 系统差，
    // 不校准则回归斜率虚高 1.25×——usage-scale 1.3 会被 [0.05,1.6] 带宽误伤，而非「对回归不可见」。
    // 校准后 honest 斜率≈1.0，usage-scale 的纯倍率才是回归的盲区（F3 参照对比的存在前提）。
    prompt = Math.max(10, Math.round(estimatedTokens * 0.8));
    if (behavior.mode === 'inflated') prompt = Math.round(prompt * behavior.inflateFactor);
    total = prompt + completion;
  }
  // usage-scale：全量等比虚增（prompt 与 completion 同倍率，total 重算）——线性回归/常量检测不可见，
  // 只有与同名模型历史报告的 prompt_tokens 对比才能识别（--token-reference 的存在理由）。
  if (behavior.mode === 'usage-scale') {
    prompt = Math.round(prompt * behavior.usageScale);
    completion = Math.round(completion * behavior.usageScale);
    total = prompt + completion;
  }
  // 可编程余额模式：按本笔 usage 累加成本（$/M 价格核算，与 guard 侧 --price-* 同式）
  behavior.costAccumulated += (prompt * behavior.priceInput + completion * behavior.priceOutput) / 1e6;
  // 真机实证（glm-5.3-flash）：中转会上报缓存/推理明细（completion_tokens 含推理）。
  // cached=0（未命中缓存）；reasoning=min(1, completion) 防止 completion=0 时 reasoning>completion 违反子集不变量。
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: Math.min(1, completion) },
  };
}

function textOf(message: Record<string, unknown>): string {
  const content = message['content'];
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    let out = '';
    for (const part of content) {
      if (typeof part === 'object' && part !== null) {
        const record = part as Record<string, unknown>;
        if (record['type'] === 'text' && typeof record['text'] === 'string') out += record['text'];
        if (record['type'] === 'image_url') out += '[image]';
      }
    }
    return out;
  }
  return '';
}

function findImageUrl(message: Record<string, unknown>): string | null {
  const content = message['content'];
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (typeof part === 'object' && part !== null) {
      const record = part as Record<string, unknown>;
      const image = record['image_url'];
      if (record['type'] === 'image_url' && typeof image === 'object' && image !== null) {
        const url = (image as Record<string, unknown>)['url'];
        if (typeof url === 'string') return url;
      }
    }
  }
  return null;
}

function decodePngFirstPixel(dataUrl: string): [number, number, number] | null {
  try {
    const comma = dataUrl.indexOf(',');
    if (comma === -1) return null;
    const buf = Buffer.from(dataUrl.slice(comma + 1), 'base64');
    if (buf.length < 8) return null;
    let pos = 8;
    const idat: Buffer[] = [];
    let width = 0;
    let bitDepth = 0;
    let colorType = 0;
    while (pos + 8 <= buf.length) {
      const len = buf.readUInt32BE(pos);
      const type = buf.toString('ascii', pos + 4, pos + 8);
      const data = buf.subarray(pos + 8, pos + 8 + len);
      if (type === 'IHDR') {
        width = data.readUInt32BE(0);
        bitDepth = data[8] ?? 0;
        colorType = data[9] ?? 0;
      } else if (type === 'IDAT') {
        idat.push(Buffer.from(data));
      } else if (type === 'IEND') {
        break;
      }
      pos += 12 + len;
    }
    if (colorType !== 2 || bitDepth !== 8 || width <= 0) return null;
    const raw = inflateSync(Buffer.concat(idat));
    const filter = raw[0] ?? 0;
    if (filter !== 0) return null;
    const r = raw[1];
    const g = raw[2];
    const b = raw[3];
    if (r === undefined || g === undefined || b === undefined) return null;
    return [r, g, b];
  } catch {
    return null;
  }
}

function nearestColorName(rgb: [number, number, number]): string {
  let best = COLOR_TABLE[0] as { name: string; rgb: [number, number, number] };
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const entry of COLOR_TABLE) {
    const d =
      (entry.rgb[0] - rgb[0]) * (entry.rgb[0] - rgb[0]) +
      (entry.rgb[1] - rgb[1]) * (entry.rgb[1] - rgb[1]) +
      (entry.rgb[2] - rgb[2]) * (entry.rgb[2] - rgb[2]);
    if (d < bestDistance) {
      bestDistance = d;
      best = entry;
    }
  }
  return best.name;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
