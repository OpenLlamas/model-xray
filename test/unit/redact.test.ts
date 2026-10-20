import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactUrl } from '../../src/redact.js';

test('redactUrl：抹掉 userinfo 与 query/hash，保留 origin + path', () => {
  assert.equal(redactUrl('https://relay.example.com/v1'), 'https://relay.example.com/v1');
  assert.equal(redactUrl('https://user:pass@relay.example.com/v1'), 'https://relay.example.com/v1');
  assert.equal(redactUrl('https://relay.example.com/v1?key=sk-secret#frag'), 'https://relay.example.com/v1');
  assert.equal(redactUrl('https://relay.example.com'), 'https://relay.example.com', '根路径不应凭空多出尾斜杠');
  assert.equal(redactUrl('http://127.0.0.1:8080/v1'), 'http://127.0.0.1:8080/v1');
  // 非法 URL：退化为「砍掉 ?/# 之后」，仍不得回显凭据
  assert.equal(redactUrl('not-a-url?key=sk-secret'), 'not-a-url');
  assert.ok(!redactUrl('https://user:pass@relay.example.com/v1').includes('pass'));
  assert.ok(!redactUrl('https://relay.example.com/v1?key=sk-secret').includes('sk-secret'));
});

test('redactUrl：path 段里的 key 片段必须遮蔽（部分中转把 key 放在路径里）', () => {
  assert.equal(redactUrl('https://relay.example.com/sk-abcdef123456/v1'), 'https://relay.example.com/sk-***/v1');
  // 短片段不是 key：不动（避免把正常模型名/路径改掉）
  assert.equal(redactUrl('https://relay.example.com/v1/sk-abc'), 'https://relay.example.com/v1/sk-abc');
});

test('redactUrl：非 http(s) 方案（origin 恒为 "null"）不得输出 "null/path"', () => {
  // file: 与 mailto: 是 non-special scheme，URL.origin 恒为字符串 "null"，直接拼接会得到 "null/C:/x"。
  // ftp:/file: 里的 ftp 属 special scheme，origin 正常，不走这条分支。
  assert.equal(redactUrl('file:///C:/secrets/key.txt'), 'file:///C:/secrets/key.txt');
  assert.ok(!redactUrl('file:///C:/x').startsWith('null'));
  assert.equal(redactUrl('mailto:ops@relay.example.com?subject=sk-secret'), 'mailto:ops@relay.example.com');
  assert.equal(redactUrl('ftp://user:pass@files.example.com/x?y=1'), 'ftp://files.example.com/x');
});

test('redactUrl：userinfo 的各种形态都被抹掉（只有用户名／空密码）', () => {
  assert.equal(redactUrl('https://user@relay.example.com/v1'), 'https://relay.example.com/v1');
  assert.equal(redactUrl('https://user:@relay.example.com/v1'), 'https://relay.example.com/v1');
  assert.equal(redactUrl('https://:pass@relay.example.com/v1'), 'https://relay.example.com/v1');
  assert.equal(redactUrl('https://u:p@relay.example.com:8443/v1?k=sk-abcdef123456'), 'https://relay.example.com:8443/v1');
});

test('redactUrl：query 里的凭据整段丢弃（不靠猜哪个参数是 key）', () => {
  assert.equal(redactUrl('https://relay.example.com/v1?key=sk-abcdef123456'), 'https://relay.example.com/v1');
  assert.equal(redactUrl('https://relay.example.com/v1?token=abcdef123456&x=1'), 'https://relay.example.com/v1');
  assert.ok(!redactUrl('https://relay.example.com/v1?token=abcdef123456').includes('abcdef123456'));
  // 不可解析的串同样砍掉 ?/# 之后（query 里的凭据不留）
  assert.equal(redactUrl('weird host/v1?token=abcdef123456'), 'weird host/v1');
});
