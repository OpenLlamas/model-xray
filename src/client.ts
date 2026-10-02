import { SseParser, parseStreamPayload, extractText, type ToolCallDelta } from './sse.js';
import type { ChatRequest, ChatResult, ClientOptions, OpenAIClient, ToolCall, Usage } from './types.js';

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

export function createClient(options: ClientOptions): OpenAIClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const chatUrl = `${baseUrl}/chat/completions`;

  async function chat(req: ChatRequest): Promise<ChatResult> {
    let lastResult: ChatResult | null = null;
    for (let attempt = 0; attempt <= options.retries; attempt += 1) {
      if (attempt > 0) await sleep(backoffMs(attempt));
      lastResult = await attemptChat(chatUrl, options, req);
      if (lastResult.ok || !RETRYABLE_STATUS.has(lastResult.status)) return lastResult;
    }
    return lastResult ?? errorResult('no attempt executed');
  }

  return { baseUrl: options.baseUrl, chat };
}

async function attemptChat(url: string, options: ClientOptions, req: ChatRequest): Promise<ChatResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const body = JSON.stringify({ ...req, stream: req.stream === true });
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.apiKey}`,
        accept: req.stream === true ? 'text/event-stream' : 'application/json',
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await safeReadBody(response);
      return errorResult(`HTTP ${response.status}: ${truncate(errorText, 500)}`, response.status, Date.now() - started);
    }

    if (req.stream === true) {
      return await readStream(response, started);
    }
    return await readJson(response, started);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(message, 0, Date.now() - started);
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response: Response, started: number): Promise<ChatResult> {
  const raw = await response.text();
  const durationMs = Date.now() - started;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const choice = Array.isArray(parsed['choices']) ? (parsed['choices'][0] as Record<string, unknown> | undefined) : undefined;
    const message = choice && typeof choice['message'] === 'object' && choice['message'] !== null
      ? (choice['message'] as Record<string, unknown>)
      : {};
    const text = extractText(message['content']);
    const reasoning = extractText(message['reasoning_content']) + extractText(message['reasoning']);
    return {
      ok: true,
      status: response.status,
      text,
      reasoning: reasoning.length > 0 ? reasoning : null,
      usage: extractUsage(parsed['usage']),
      toolCalls: extractToolCalls(message['tool_calls']),
      ttftMs: null,
      durationMs,
      error: null,
      raw,
    };
  } catch {
    return errorResult(`invalid JSON response: ${truncate(raw, 300)}`, response.status, durationMs);
  }
}

async function readStream(response: Response, started: number): Promise<ChatResult> {
  const reader = response.body?.getReader();
  if (!reader) return errorResult('response has no body', response.status, Date.now() - started);
  const decoder = new TextDecoder();
  const parser = new SseParser();
  let text = '';
  let reasoning = '';
  let ttftMs: number | null = null;
  let usage: Usage | null = null;
  let finishReason: string | null = null;
  const toolAcc = new Map<number, { id: string; name: string; args: string }>();
  const rawParts: string[] = [];
  let rawLen = 0;

  const handle = (events: Array<{ data: string }>): void => {
    for (const event of events) {
      if (event.data === '[DONE]') continue;
      if (rawLen < 16384) {
        rawParts.push(event.data);
        rawLen += event.data.length;
      }
      const chunk = parseStreamPayload(event.data);
      if (!chunk) continue;
      const deltaText = chunk.contentDelta;
      const deltaReasoning = chunk.reasoningDelta;
      const hasToolDelta = chunk.toolCallDeltas.length > 0;
      if (ttftMs === null && (deltaText.length > 0 || deltaReasoning.length > 0 || hasToolDelta)) {
        ttftMs = Date.now() - started;
      }
      text += deltaText;
      reasoning += deltaReasoning;
      if (chunk.usage) usage = chunk.usage;
      if (chunk.finishReason) finishReason = chunk.finishReason;
      for (const delta of chunk.toolCallDeltas) mergeToolDelta(toolAcc, delta);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    handle(parser.feed(decoder.decode(value, { stream: true })));
  }
  handle(parser.end());

  const toolCalls: ToolCall[] = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, acc]) => ({
      id: acc.id || `call_${index}`,
      type: 'function' as const,
      function: { name: acc.name, arguments: acc.args },
    }))
    .filter((call) => call.function.name.length > 0);

  return {
    ok: true,
    status: response.status,
    text,
    reasoning: reasoning.length > 0 ? reasoning : null,
    usage,
    toolCalls,
    ttftMs,
    durationMs: Date.now() - started,
    error: finishReason === null && text.length === 0 && toolCalls.length === 0 ? 'empty stream' : null,
    raw: rawParts.join('\n'),
  };
}

function mergeToolDelta(acc: Map<number, { id: string; name: string; args: string }>, delta: ToolCallDelta): void {
  const existing = acc.get(delta.index) ?? { id: '', name: '', args: '' };
  if (delta.id) existing.id = delta.id;
  if (delta.name) existing.name = delta.name;
  if (delta.arguments) existing.args += delta.arguments;
  acc.set(delta.index, existing);
}

function extractUsage(value: unknown): Usage | null {
  if (typeof value !== 'object' || value === null) return null;
  const u = value as Record<string, unknown>;
  if (
    typeof u['prompt_tokens'] === 'number' &&
    typeof u['completion_tokens'] === 'number' &&
    typeof u['total_tokens'] === 'number'
  ) {
    return {
      prompt_tokens: u['prompt_tokens'],
      completion_tokens: u['completion_tokens'],
      total_tokens: u['total_tokens'],
    };
  }
  return null;
}

function extractToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: ToolCall[] = [];
  for (const tc of value as Array<Record<string, unknown>>) {
    const fn = typeof tc['function'] === 'object' && tc['function'] !== null
      ? (tc['function'] as Record<string, unknown>)
      : {};
    if (typeof fn['name'] !== 'string') continue;
    calls.push({
      id: typeof tc['id'] === 'string' ? tc['id'] : `call_${calls.length}`,
      type: 'function',
      function: {
        name: fn['name'],
        arguments: typeof fn['arguments'] === 'string' ? fn['arguments'] : JSON.stringify(fn['arguments'] ?? {}),
      },
    });
  }
  return calls;
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function errorResult(message: string, status = 0, durationMs = 0): ChatResult {
  return {
    ok: false,
    status,
    text: '',
    reasoning: null,
    usage: null,
    toolCalls: [],
    ttftMs: null,
    durationMs,
    error: message,
    raw: '',
  };
}

function backoffMs(attempt: number): number {
  const base = Math.min(8000, 500 * Math.pow(2, attempt - 1));
  return base + Math.floor(Math.random() * 250);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
