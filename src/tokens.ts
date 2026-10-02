import type { ChatMessage } from './types.js';

/**
 * Conservative token estimator, no external tokenizer data.
 * ASCII words: ~4 chars/token. CJK: 1 char/token. Other non-space: ~1 char/token.
 * Used for regression and depth targeting, never presented as exact.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let total = 0;
  let asciiRun = 0;

  const settleAscii = (): void => {
    if (asciiRun > 0) {
      total += Math.ceil(asciiRun / 4);
      asciiRun = 0;
    }
  };

  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') {
      total += 0.25;
      continue;
    }
    if (code >= 0x2e80 && code <= 0x9fff) {
      settleAscii();
      total += 1;
      continue;
    }
    if (code < 0x80) {
      asciiRun += 1;
      continue;
    }
    settleAscii();
    total += 1;
  }
  settleAscii();
  return Math.ceil(total);
}

export function estimateMessageTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += 4;
    if (typeof message.content === 'string') {
      total += estimateTokens(message.content);
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'text') total += estimateTokens(part.text);
        else total += 85;
      }
    }
    if (message.tool_calls) {
      for (const call of message.tool_calls) total += estimateTokens(call.function.arguments) + 12;
    }
  }
  return total;
}
