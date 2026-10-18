// src/report/clear-plan.ts — 报告清理规划（纯函数，无文件系统副作用，scripts/serve.mjs 与单测共用）。
// 设计约束：只吃「目录枚举结果」、吐「删什么/留什么」，让删除范围可测、可在 UI 展示、且天然无路径注入面
// （scope 为硬编码枚举，规划器绝不接受来自请求的任意文件名）。
// 口径：
//   · report-*/baseline-* 前缀的根目录文件 = 报告/基线工件（清理对象）；
//   · 子目录（guard/、mock/ 等运行时数据）与非报告文件在 keep-latest/reports-root 下不动，仅在 all 下删除；
//   · keep-latest 保留「最新一套报告」（文件名同时间戳的全部文件，如 report-xxx-2026-10-18_02-27-44.*
//     的时间戳 2026-10-18_02-27-44）与「最新一份基线」——留作日后 seed 复用与对比复测的口径。
import { basename } from 'node:path';

export type ClearScope = 'keep-latest' | 'reports-root' | 'all';

export interface ClearEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
  mtimeMs: number;
}

export interface ClearKeepItem {
  name: string;
  reason: string;
}

export interface ClearPlan {
  delete: Array<{ name: string; type: ClearEntry['type'] }>;
  keep: ClearKeepItem[];
  freedBytes: number;
}

function isArtifactFile(entry: ClearEntry): boolean {
  return entry.type === 'file' && (entry.name.startsWith('report-') || entry.name.startsWith('baseline-'));
}

function nonArtifactKeepItem(entry: ClearEntry): ClearKeepItem {
  return { name: entry.name, reason: entry.type === 'directory' ? '子目录（运行时数据）' : '非报告文件' };
}

/** 同一套报告/基线的共享时间戳（形如 2026-10-18_02-27-44）。 */
const ARTIFACT_STAMP = /-(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\./;

function isClearScope(value: unknown): value is ClearScope {
  return value === 'keep-latest' || value === 'reports-root' || value === 'all';
}

export function planReportsClear(entries: readonly ClearEntry[], scope: ClearScope): ClearPlan {
  if (!isClearScope(scope)) {
    throw new TypeError(`清理范围非法：收到值 ${JSON.stringify(scope ?? null)}（可选 keep-latest / reports-root / all）`);
  }
  const artifacts = entries.filter(isArtifactFile);
  if (scope === 'all') {
    return {
      delete: entries.map((entry) => ({ name: entry.name, type: entry.type })),
      keep: [],
      freedBytes: entries.filter((entry) => entry.type === 'file').reduce((sum, entry) => sum + entry.size, 0),
    };
  }
  if (scope === 'reports-root') {
    return {
      delete: artifacts.map((entry) => ({ name: entry.name, type: entry.type })),
      keep: entries.filter((entry) => !isArtifactFile(entry)).map(nonArtifactKeepItem),
      freedBytes: artifacts.reduce((sum, entry) => sum + entry.size, 0),
    };
  }
  // keep-latest
  const byNewest = [...artifacts].sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  const keepNames = new Set<string>();
  const keep: ClearKeepItem[] = [];
  const newest = byNewest[0] ?? null;
  const stamp = newest === null ? null : (ARTIFACT_STAMP.exec(basename(newest.name))?.[1] ?? null);
  if (newest !== null && stamp !== null) {
    for (const entry of artifacts) {
      if (entry.name.includes(stamp)) {
        keepNames.add(entry.name);
        keep.push({ name: entry.name, reason: '最新一套报告' });
      }
    }
  }
  if (newest !== null && !keepNames.has(newest.name)) {
    keepNames.add(newest.name);
    keep.push({ name: newest.name, reason: '最新报告文件' });
  }
  const newestBaseline =
    artifacts
      .filter((entry) => entry.name.startsWith('baseline-'))
      .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))[0] ?? null;
  if (newestBaseline !== null && !keepNames.has(newestBaseline.name)) {
    keepNames.add(newestBaseline.name);
    keep.push({ name: newestBaseline.name, reason: '最新基线（留作日后对比复测）' });
  }
  const del = artifacts.filter((entry) => !keepNames.has(entry.name));
  return {
    delete: del.map((entry) => ({ name: entry.name, type: entry.type })),
    keep: [...keep, ...entries.filter((entry) => !isArtifactFile(entry)).map(nonArtifactKeepItem)],
    freedBytes: del.reduce((sum, entry) => sum + entry.size, 0),
  };
}