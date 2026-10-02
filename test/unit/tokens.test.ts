import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateMessageTokens, estimateTokens } from '../../src/tokens.js';

test('empty text estimates zero', () => {
  assert.equal(estimateTokens(''), 0);
});

test('ascii words cost about one token per four chars', () => {
  const text = 'The quick brown fox jumps over the lazy dog';
  const tokens = estimateTokens(text);
  assert.ok(tokens >= 9 && tokens <= 13, `got ${tokens}`);
});

test('cjk costs about one token per character', () => {
  const text = '工程师用测量代替猜测来做决策';
  const tokens = estimateTokens(text);
  assert.ok(tokens >= 12 && tokens <= 14, `got ${tokens}`);
});

test('estimateMessageTokens adds per-message overhead and image parts', () => {
  const textOnly = estimateMessageTokens([{ role: 'user', content: 'hello world' }]);
  const withImage = estimateMessageTokens([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'hello world' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    },
  ]);
  assert.ok(withImage > textOnly + 50);
});

test('mixed ascii runs do not undercount across non-ascii boundaries', () => {
  const mixed = estimateTokens('abcdefgh\u4e2d\u6587abcdefgh');
  const pure = estimateTokens('abcdefgh') * 2 + estimateTokens('\u4e2d\u6587');
  assert.equal(mixed, pure);
});

test('estimates grow monotonically with text length', () => {
  const short = estimateTokens('a'.repeat(100));
  const long = estimateTokens('a'.repeat(400));
  assert.ok(long > short);
});
