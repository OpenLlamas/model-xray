import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { inflateSync } from 'node:zlib';

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
  | 'flaky';

export interface MockBehavior {
  mode: MockMode;
  truncateTokens: number;
  identityName: string;
  inflateFactor: number;
  failEvery: number;
}

export interface MockOptions {
  mode: MockMode;
  truncateTokens?: number;
  identityName?: string;
  inflateFactor?: number;
  failEvery?: number;
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
  state: { served: number };
}

export function createMockServer(options: MockOptions): Promise<MockServer> {
  const behavior: MockBehavior = {
    mode: options.mode,
    truncateTokens: options.truncateTokens ?? 8000,
    identityName: options.identityName ?? 'GLM-4',
    inflateFactor: options.inflateFactor ?? 4,
    failEvery: options.failEvery ?? 0,
  };
  const state = { served: 0 };

  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      sendJson(res, 404, { error: { message: 'not found' } });
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: { message: 'invalid json' } });
      return;
    }
    state.served += 1;
    if (behavior.mode === 'flaky' && behavior.failEvery > 0 && state.served % behavior.failEvery === 0) {
      sendJson(res, 500, { error: { message: 'injected fault' } });
      return;
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

  const toolResultNonce = findToolResultNonce(messages);
  if (toolResultNonce !== null) {
    sendReply(res, behavior, `已收到工具结果，nonce ${toolResultNonce} 确认。`, estimate(allText), stream);
    return;
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
      const reply = solve(clipped, behavior, clippedUser, imageUrl, modelName, state.served);
      sendReply(res, behavior, reply, estimatedTokens, stream);
      return;
    }
  }

  if (behavior.mode === 'tool-fail' && tools.length > 0) {
    sendReply(res, behavior, '这个请求看起来需要工具，但我不太确定怎么做。', estimate(allText), stream);
    return;
  }

  const reply = solve(allText, behavior, userText, imageUrl, modelName, state.served);
  sendReply(res, behavior, reply, estimate(allText), stream);
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

  if (/你是什么AI模型|什么模型|真实身份|State your exact model|Which AI model|model name/i.test(question)) {
    const variants = [`我是 ${modelName}，由 OpenAI 开发。`, `I am ${modelName}, created by OpenAI.`, `I'm the ${modelName} model.`];
    return variants[served % variants.length] as string;
  }

  return '好的，收到。';
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

function sendReply(res: ServerResponse, behavior: MockBehavior, reply: string, estimatedTokens: number, stream: boolean): void {
  const usage = computeUsage(behavior, estimatedTokens, reply);
  if (reply.startsWith('__tool__')) {
    sendToolCall(res, reply.slice('__tool__'.length), usage, stream);
    return;
  }
  if (!stream) {
    sendJson(res, 200, {
      id: 'mock',
      object: 'chat.completion',
      model: 'mock',
      choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
      usage,
    });
    return;
  }

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  for (const piece of splitIntoPieces(reply)) {
    res.write(
      `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`,
    );
  }
  res.write(
    `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\n`,
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

function splitIntoPieces(text: string): string[] {
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += 3) pieces.push(text.slice(i, i + 3));
  return pieces.length > 0 ? pieces : [''];
}

function sendToolCall(res: ServerResponse, nonce: string, usage: Record<string, number>, stream: boolean): void {
  const args = JSON.stringify({ nonce });
  if (!stream) {
    sendJson(res, 200, {
      id: 'mock',
      object: 'chat.completion',
      model: 'mock',
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
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function computeUsage(behavior: MockBehavior, estimatedTokens: number, reply: string): Record<string, number> {
  if (behavior.mode === 'const-usage') {
    return { prompt_tokens: 500, completion_tokens: 50, total_tokens: 550 };
  }
  const completion = Math.max(1, Math.ceil(reply.length / 3.2));
  let prompt = Math.max(10, estimatedTokens);
  if (behavior.mode === 'inflated') prompt = Math.round(prompt * behavior.inflateFactor);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
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
