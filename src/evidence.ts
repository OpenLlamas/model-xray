import type { ChatResult, EvidenceRecord, EvidenceRecorder, ProbeId } from './types.js';

export function createEvidenceRecorder(): EvidenceRecorder {
  const records: EvidenceRecord[] = [];
  const index = new Map<string, EvidenceRecord>();
  let counter = 0;

  return {
    record(entry: Omit<EvidenceRecord, 'id' | 'ts'>): EvidenceRecord {
      counter += 1;
      const id = `ev-${String(counter).padStart(3, '0')}`;
      const record: EvidenceRecord = { ...entry, id, ts: new Date().toISOString() };
      records.push(record);
      index.set(id, record);
      return record;
    },
    all(): EvidenceRecord[] {
      return [...records];
    },
    byId(id: string): EvidenceRecord | undefined {
      return index.get(id);
    },
    size(): number {
      return records.length;
    },
  };
}

export interface EvidenceInput {
  probe: ProbeId;
  label: string;
  request: {
    model: string;
    stream: boolean;
    temperature?: number | null;
    maxTokens?: number | null;
    messages: Array<{ content: unknown }>;
  };
  result: ChatResult;
}

const PREVIEW_CHARS = 800;
const RAW_LIMIT = 8192;

export function recordCall(recorder: EvidenceRecorder, input: EvidenceInput): EvidenceRecord {
  const { request, result } = input;
  const lastMessage = request.messages[request.messages.length - 1];
  const lastText = renderContent(lastMessage?.content);
  const totalChars = request.messages.reduce((acc, message) => acc + renderContent(message.content).length, 0);
  const raw = result.raw.length <= RAW_LIMIT ? result.raw : `${result.raw.slice(0, RAW_LIMIT)}…`;
  return recorder.record({
    probe: input.probe,
    label: input.label,
    request: {
      model: request.model,
      stream: request.stream,
      temperature: request.temperature ?? null,
      maxTokens: request.maxTokens ?? null,
      messageCount: request.messages.length,
      lastUserPreview: truncate(lastText, PREVIEW_CHARS),
      lastUserChars: lastText.length,
      totalChars,
    },
    response: {
      status: result.status,
      textPreview: truncate(result.text, PREVIEW_CHARS),
      textChars: result.text.length,
      usage: result.usage,
      toolCallCount: result.toolCalls.length,
      error: result.error,
    },
    ttftMs: result.ttftMs,
    durationMs: result.durationMs,
  });
}

function renderContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    let out = '';
    for (const part of content) {
      if (typeof part === 'object' && part !== null) {
        const record = part as Record<string, unknown>;
        if (record['type'] === 'text' && typeof record['text'] === 'string') out += record['text'];
        else if (record['type'] === 'image_url') out += '[image]';
      }
    }
    return out;
  }
  return '';
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
