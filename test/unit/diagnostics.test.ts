import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  categorizeFailure,
  failureDigest,
  runFailureDigest,
  sanitizeErrorSnippet,
  summarizeFailures,
} from '../../src/diagnostics.js';

test('diagnostics: categorizeFailure 覆盖网关拒绝/鉴权/路径/网络/错误载荷/其他', () => {
  assert.equal(categorizeFailure('HTTP 503: system cpu overloaded'), 'gateway');
  assert.equal(categorizeFailure('HTTP 429: rate limited'), 'gateway');
  assert.equal(categorizeFailure('HTTP 502: bad gateway'), 'gateway');
  assert.equal(categorizeFailure('HTTP 401: invalid api key'), 'auth');
  assert.equal(categorizeFailure('HTTP 403: quota exceeded'), 'auth');
  assert.equal(categorizeFailure('HTTP 404: model not found'), 'not-found');
  assert.equal(categorizeFailure('timeout after 5000ms'), 'network');
  assert.equal(categorizeFailure('network error: ECONNREFUSED'), 'network');
  assert.equal(categorizeFailure('upstream error payload: {"error":{}}'), 'endpoint-error');
  assert.equal(categorizeFailure('stream ended before start'), 'endpoint-error');
  assert.equal(categorizeFailure('invalid JSON in response'), 'endpoint-error');
  assert.equal(categorizeFailure('empty stream'), 'endpoint-error');
  assert.equal(categorizeFailure('response has no body'), 'endpoint-error');
  assert.equal(categorizeFailure('boom'), 'other');
  assert.equal(categorizeFailure(null), 'other');
  assert.equal(categorizeFailure(''), 'other');
});

test('diagnostics: 5xx 非网关白名单（如 500）不归入 gateway，避免把端点错误栽给网关', () => {
  assert.equal(categorizeFailure('HTTP 500: internal server error'), 'other');
  assert.equal(categorizeFailure('HTTP 400: bad request'), 'other');
});

test('diagnostics: sanitizeErrorSnippet 去控制字符/ANSI、折叠空白并截断', () => {
  // ESC 本体被替换为空格（防终端注入），后续 '[31m' 文本按普通字符保留——这是白名单化口径
  assert.equal(sanitizeErrorSnippet('a\u001b[31mred\u001b[0m  b\nc'), 'a [31mred [0m b c');
  assert.equal(sanitizeErrorSnippet('plain'), 'plain');
  const long = 'x'.repeat(120);
  const out = sanitizeErrorSnippet(long);
  assert.equal(out.length, 91);
  assert.ok(out.endsWith('…'));
  assert.equal(sanitizeErrorSnippet('x'.repeat(90)), 'x'.repeat(90));
});

test('diagnostics: summarizeFailures 选主导类别（并列取先出现），failureDigest 产出计数与详情', () => {
  const summary = summarizeFailures([
    'HTTP 503: a',
    'HTTP 503: b',
    'boom',
    'HTTP 503: c',
  ]);
  assert.equal(summary?.category, 'gateway');
  assert.equal(summary?.count, 3);
  assert.equal(summary?.detail, 'HTTP 503: a');
  assert.equal(summarizeFailures([]), null);
  assert.equal(summarizeFailures([null, '']), null);
  const digest = failureDigest(['HTTP 503: system cpu overloaded', 'HTTP 503: x', 'boom'], 3);
  assert.equal(digest, '端点/网关拒绝（2/3 笔）：HTTP 503: system cpu overloaded');
  assert.equal(failureDigest([], 5), null);
});

test('diagnostics: runFailureDigest 全成功返回 null，失败给出主因+建议，无详情走诚实分支', () => {
  const ok = [
    { response: { status: 200, error: null } },
    { response: { status: 200, error: null } },
  ];
  assert.equal(runFailureDigest(ok), null);
  const failed = [
    { response: { status: 200, error: null } },
    { response: { status: 503, error: 'HTTP 503: system cpu overloaded' } },
    { response: { status: 503, error: 'HTTP 503: system cpu overloaded' } },
  ];
  const digest = runFailureDigest(failed);
  assert.ok(digest?.includes('2/3 笔请求失败'));
  assert.ok(digest?.includes('主因：端点/网关拒绝（2/3 笔）：HTTP 503: system cpu overloaded'));
  assert.ok(digest?.includes('错峰'));
  const noDetail = [
    { response: { status: 500, error: null } },
    { response: { status: 200, error: null } },
  ];
  assert.equal(runFailureDigest(noDetail), '本轮 1/2 笔请求失败（无错误详情），失败样本所在维度可能因此未判定。');
});
