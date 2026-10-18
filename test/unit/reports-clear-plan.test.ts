// src/report/clear-plan.ts —— 报告清理规划器回归：
//   · keep-latest 只保留「最新一套报告」（同时间戳全组）与「最新基线」，且不误伤子目录/非报告文件；
//   · reports-root 只删 report-*/baseline-*；all 全清但 freedBytes 只计文件（子目录体积未知，如实不计）；
//   · scope 非法在规划器层即抛错（serve.mjs 路由层另有 400 带收到值+示例的文案钉子）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planReportsClear, type ClearEntry } from '../../src/report/clear-plan.js';

function file(name: string, mtimeMs: number, size = 100): ClearEntry {
  return { name, type: 'file', mtimeMs, size };
}

function dir(name: string): ClearEntry {
  return { name, type: 'directory', mtimeMs: 1, size: 0 };
}

const TYPICAL: ClearEntry[] = [
  file('report-old-2026-10-17_10-00-00.json', 100, 4000),
  file('report-old-2026-10-17_10-00-00.html', 100, 9000),
  file('report-ok-2026-10-18_02-27-44.json', 900, 5000),
  file('report-ok-2026-10-18_02-27-44.html', 905, 11000),
  file('report-ok-2026-10-18_02-27-44.md', 905, 2000),
  file('baseline-ok-2026-10-18_02-27-44.json', 890, 1000),
  file('baseline-old-2026-10-17_09-00-00.json', 50, 900),
  file('README-note.txt', 990, 120),
  dir('guard'),
];

test('keep-latest：保留最新一套（同时间戳）+ 最新基线，删除其余工件，不动子目录/非报告文件', () => {
  const plan = planReportsClear(TYPICAL, 'keep-latest');
  assert.deepEqual(
    plan.delete.map((item) => item.name),
    ['report-old-2026-10-17_10-00-00.json', 'report-old-2026-10-17_10-00-00.html', 'baseline-old-2026-10-17_09-00-00.json'],
  );
  const keepNames = plan.keep.map((item) => item.name);
  for (const kept of ['report-ok-2026-10-18_02-27-44.json', 'report-ok-2026-10-18_02-27-44.html', 'report-ok-2026-10-18_02-27-44.md', 'baseline-ok-2026-10-18_02-27-44.json']) {
    assert.ok(keepNames.includes(kept), `应保留 ${kept}`);
  }
  assert.ok(keepNames.includes('guard') && keepNames.includes('README-note.txt'), '子目录与非报告文件必须保留');
  // freedBytes 只统计被删文件
  assert.equal(plan.freedBytes, 4000 + 9000 + 900);
});

test('keep-latest：最新文件名无时间戳 → 只保留自身 + 最新基线（不连坐误删）', () => {
  const plan = planReportsClear([file('report-weird.json', 900), file('report-older.json', 100), file('baseline-b.json', 80)], 'keep-latest');
  assert.deepEqual(
    plan.delete.map((item) => item.name),
    ['report-older.json'],
  );
  const keepNames = plan.keep.map((item) => item.name);
  assert.ok(keepNames.includes('report-weird.json') && keepNames.includes('baseline-b.json'));
});

test('keep-latest：无可保留工件 → 空删除、空保留？错——无工件时什么都不删且如实为空', () => {
  const plan = planReportsClear([file('notes.txt', 10), dir('mock')], 'keep-latest');
  assert.equal(plan.delete.length, 0);
  assert.equal(plan.freedBytes, 0);
  assert.equal(plan.keep.length, 2);
});

test('reports-root：只删 report-/baseline- 文件，子目录与非报告文件全部保留', () => {
  const plan = planReportsClear(TYPICAL, 'reports-root');
  assert.deepEqual(
    plan.delete.map((item) => item.name),
    TYPICAL.filter((entry) => entry.type === 'file' && (entry.name.startsWith('report-') || entry.name.startsWith('baseline-'))).map((entry) => entry.name),
  );
  const keepNames = plan.keep.map((item) => item.name);
  assert.ok(keepNames.includes('guard') && keepNames.includes('README-note.txt'));
  assert.ok(!keepNames.some((name) => name.startsWith('report-') || name.startsWith('baseline-')), '被删工件不得出现在保留清单');
});

test('all：清空全部条目；freedBytes 只计文件体积（子目录体积未知，如实不计）', () => {
  const plan = planReportsClear(TYPICAL, 'all');
  assert.equal(plan.delete.length, TYPICAL.length);
  assert.equal(plan.keep.length, 0);
  assert.equal(plan.freedBytes, 4000 + 9000 + 5000 + 11000 + 2000 + 1000 + 900 + 120);
});

test('scope 非法：规划器直接抛错（路由层会先挡，这里是纵深）', () => {
  assert.throws(() => planReportsClear(TYPICAL, 'everything' as never), /清理范围非法/);
});

test('空目录：三种 scope 均为 no-op（deleted=0、freedBytes=0）', () => {
  for (const scope of ['keep-latest', 'reports-root', 'all'] as const) {
    const plan = planReportsClear([], scope);
    assert.equal(plan.delete.length, 0, `${scope} 应 no-op`);
    assert.equal(plan.freedBytes, 0, `${scope} 应 no-op`);
  }
});