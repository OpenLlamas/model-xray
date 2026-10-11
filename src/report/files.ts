import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import type { AuditReport } from '../types.js';
import type { BaselineFile } from '../baseline.js';
import { renderJson } from './json.js';
import { renderMarkdown } from './markdown.js';
import { renderHtml } from './html.js';

export interface WrittenReports {
  markdownPath: string;
  htmlPath: string;
  jsonPath: string;
  baselinePath: string | null;
}

/**
 * 原子写：先写同目录临时文件，再 rename 覆盖目标。
 * - Node 在 Windows 上 rename 走 MOVEFILE_REPLACE_EXISTING，可安全覆盖已存在的 --baseline-out；
 * - 读方（含并发复测）永远不会看到半截 JSON/报告；
 * - finally 兜底：rename 失败时清理残留 tmp，不让 *.tmp 垃圾堆积。
 */
export function atomicWrite(path: string, data: string): void {
  // randomUUID 消除同 pid 同毫秒（worker_threads/高并发写）的 tmp 名碰撞类。
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, data, 'utf8');
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) {
      try {
        unlinkSync(tmp);
      } catch {
        // 清理失败不掩盖原始写入错误
      }
    }
  }
}

/**
 * 生成报告/基线文件名主干：<safeModel>-<YYYY-MM-DD_HH-mm-ss>（本地时间，各段 padStart 补零）。
 * - 模型名清洗：非法字符折叠为 '-'，合并连续 '-'，去首尾 '-'，截断 48 字符；清洗后为空兜底 'unknown'；
 * - 注意：同秒同模型重复运行会覆盖同名文件（审计耗时长，同秒撞名概率极低，可接受）。
 */
export function makeFileStamp(date: Date, model: string): string {
  const safeModel =
    model
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 48)
      .replace(/[-.]+$/, '') || 'unknown';
  const p = (n: number): string => String(n).padStart(2, '0');
  const time = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}-${p(
    date.getMinutes(),
  )}-${p(date.getSeconds())}`;
  return `${safeModel}-${time}`;
}

export function writeReports(
  report: AuditReport,
  outDir: string,
  stamp: string,
  baseline: BaselineFile | null = null,
  baselineOut: string | null = null,
): WrittenReports {
  const dir = resolve(outDir);
  mkdirSync(dir, { recursive: true });
  const markdownPath = join(dir, `report-${stamp}.md`);
  const htmlPath = join(dir, `report-${stamp}.html`);
  const jsonPath = join(dir, `report-${stamp}.json`);
  atomicWrite(markdownPath, renderMarkdown(report));
  atomicWrite(htmlPath, renderHtml(report));
  atomicWrite(jsonPath, renderJson(report));

  let baselinePath: string | null = null;
  if (baseline !== null) {
    baselinePath = baselineOut ? resolve(baselineOut) : join(dir, `baseline-${stamp}.json`);
    mkdirSync(dirname(baselinePath), { recursive: true });
    atomicWrite(baselinePath, JSON.stringify(baseline, null, 2));
  }
  return { markdownPath, htmlPath, jsonPath, baselinePath };
}
