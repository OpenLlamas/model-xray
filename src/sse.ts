export interface SseEvent {
  data: string;
  event: string | null;
}

/**
 * Incremental Server-Sent Events parser for OpenAI-compatible streams.
 * Handles CRLF, multi-line data fields, partial frames across chunks.
 */
export class SseParser {
  private buffer = '';
  private dataLines: string[] = [];
  private eventName: string | null = null;

  feed(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      const event = this.consumeLine(line);
      if (event) events.push(event);
      newlineIndex = this.buffer.indexOf('\n');
    }
    return events;
  }

  /** Flush trailing buffered line at end of stream. */
  end(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.buffer.length > 0) {
      let line = this.buffer;
      if (line.endsWith('\r')) line = line.slice(0, -1);
      const event = this.consumeLine(line);
      if (event) events.push(event);
      this.buffer = '';
    }
    const last = this.flushEvent();
    if (last) events.push(last);
    return events;
  }

  private consumeLine(line: string): SseEvent | null {
    if (line === '') return this.flushEvent();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      this.dataLines.push(value);
      return null;
    }
    if (field === 'event') {
      this.eventName = value;
      return null;
    }
    return null;
  }

  private flushEvent(): SseEvent | null {
    if (this.dataLines.length === 0) {
      this.eventName = null;
      return null;
    }
    const data = this.dataLines.join('\n');
    const event: SseEvent = { data, event: this.eventName };
    this.dataLines = [];
    this.eventName = null;
    return event;
  }
}

export interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

export interface StreamChunk {
  contentDelta: string;
  reasoningDelta: string;
  toolCallDeltas: ToolCallDelta[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
  finishReason: string | null;
}

/** Parse one SSE data payload into a normalized chunk. Returns null for non-JSON or [DONE]. */
export function parseStreamPayload(data: string): StreamChunk | null {
  if (data === '[DONE]') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const choice = Array.isArray(obj['choices']) ? (obj['choices'][0] as Record<string, unknown> | undefined) : undefined;
  const delta = choice && typeof choice['delta'] === 'object' && choice['delta'] !== null
    ? (choice['delta'] as Record<string, unknown>)
    : {};

  const content = extractText(delta['content']);
  const reasoning = extractText(delta['reasoning_content']) + extractText(delta['reasoning']);
  const toolCalls: ToolCallDelta[] = [];
  if (Array.isArray(delta['tool_calls'])) {
    for (const tc of delta['tool_calls'] as Array<Record<string, unknown>>) {
      const fn = typeof tc['function'] === 'object' && tc['function'] !== null
        ? (tc['function'] as Record<string, unknown>)
        : {};
      toolCalls.push({
        index: typeof tc['index'] === 'number' ? tc['index'] : 0,
        id: typeof tc['id'] === 'string' ? tc['id'] : undefined,
        name: typeof fn['name'] === 'string' ? fn['name'] : undefined,
        arguments: typeof fn['arguments'] === 'string' ? fn['arguments'] : undefined,
      });
    }
  }

  let usage: StreamChunk['usage'] = null;
  if (typeof obj['usage'] === 'object' && obj['usage'] !== null) {
    const u = obj['usage'] as Record<string, unknown>;
    if (
      typeof u['prompt_tokens'] === 'number' &&
      typeof u['completion_tokens'] === 'number' &&
      typeof u['total_tokens'] === 'number'
    ) {
      usage = {
        prompt_tokens: u['prompt_tokens'],
        completion_tokens: u['completion_tokens'],
        total_tokens: u['total_tokens'],
      };
    }
  }

  const finishReason = choice && typeof choice['finish_reason'] === 'string' ? (choice['finish_reason'] as string) : null;
  return { contentDelta: content, reasoningDelta: reasoning, toolCallDeltas: toolCalls, usage, finishReason };
}

export function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    let out = '';
    for (const part of value) {
      if (typeof part === 'object' && part !== null && typeof (part as Record<string, unknown>)['text'] === 'string') {
        out += (part as Record<string, unknown>)['text'] as string;
      }
    }
    return out;
  }
  return '';
}
