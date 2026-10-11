import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAnswer, type Question } from '../../src/probes/quality.js';

function question(answer: number, exclusive: number[] | null = null): Question {
  return { id: 'q1', prompt: '只回答数字。', answer, exclusive, control: false };
}

test('checkAnswer: thousands-separated answers count as correct (model answers "7,718")', () => {
  // 修复前：-?\d+ 切分把 "7,718" 拆成 7 与 718 两个数，漏判正确答案
  assert.ok(checkAnswer('答案是 7,718。', question(7718)));
  assert.ok(checkAnswer('1,234', question(1234)));
  assert.ok(checkAnswer('12,345,678', question(12345678)));
});

test('checkAnswer: plain digits keep working after comma normalization', () => {
  assert.ok(checkAnswer('7718', question(7718)));
  assert.ok(checkAnswer('答案是 7718', question(7718)));
});

test('checkAnswer: negative numbers unaffected by comma regex', () => {
  assert.ok(checkAnswer('-42', question(-42)));
  assert.ok(checkAnswer('-4,200', question(-4200)));
});

test('checkAnswer: wrong value still rejected (no false positive from comma strip)', () => {
  assert.ok(!checkAnswer('7,719', question(7718)));
  assert.ok(!checkAnswer('718', question(7718)));
  assert.ok(!checkAnswer('无数字', question(7718)));
});

test('checkAnswer: exclusive distractor still blocks (comma-aware both sides)', () => {
  assert.ok(!checkAnswer('7,718 或 7,719', question(7718, [7719])));
  assert.ok(checkAnswer('7,718 或 9,999', question(7718, [7719])));
});
