import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supportsColor, colorize } from '../../src/color.js';

/** 临时改环境变量并保证还原（测试间互不污染） */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('supportsColor：非 TTY / 缺流 一律 false', () => {
  assert.equal(supportsColor({ isTTY: false }), false);
  assert.equal(supportsColor({}), false);
  assert.equal(supportsColor(null), false);
  assert.equal(supportsColor(undefined), false);
});

test('supportsColor：TTY 且无关闭信号 → true', () => {
  withEnv({ NO_COLOR: undefined, TERM: 'xterm-256color', CI: undefined }, () => {
    assert.equal(supportsColor({ isTTY: true }), true);
  });
});

test('supportsColor：NO_COLOR / TERM=dumb / CI 任一命中即 false', () => {
  withEnv({ NO_COLOR: '1', TERM: 'xterm', CI: undefined }, () => {
    assert.equal(supportsColor({ isTTY: true }), false);
  });
  withEnv({ NO_COLOR: undefined, TERM: 'dumb', CI: undefined }, () => {
    assert.equal(supportsColor({ isTTY: true }), false);
  });
  withEnv({ NO_COLOR: undefined, TERM: 'xterm', CI: 'true' }, () => {
    assert.equal(supportsColor({ isTTY: true }), false);
  });
});

test('colorize：级别映射（pass/ok 绿、warn 黄、fail 红；unknown/na 与 disabled 均 no-op）', () => {
  assert.equal(colorize('x', 'pass', true), '\u001b[32mx\u001b[0m');
  assert.equal(colorize('x', 'ok', true), '\u001b[32mx\u001b[0m');
  assert.equal(colorize('x', 'warn', true), '\u001b[33mx\u001b[0m');
  assert.equal(colorize('x', 'fail', true), '\u001b[31mx\u001b[0m');
  assert.equal(colorize('x', 'unknown', true), 'x');
  assert.equal(colorize('x', 'na', true), 'x');
  for (const level of ['pass', 'ok', 'warn', 'fail', 'unknown', 'na'] as const) {
    assert.equal(colorize('x', level, false), 'x', `disabled 时 ${level} 不得着色`);
  }
});
