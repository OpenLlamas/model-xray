import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AuditReport } from '../types.js';
import { renderMarkdown } from './markdown.js';
import { renderHtml } from './html.js';

export interface WrittenReports {
  markdownPath: string;
  htmlPath: string;
  jsonPath: string;
}

export function writeReports(report: AuditReport, outDir: string, stamp: string): WrittenReports {
  const dir = resolve(outDir);
  mkdirSync(dir, { recursive: true });
  const markdownPath = join(dir, `report-${stamp}.md`);
  const htmlPath = join(dir, `report-${stamp}.html`);
  const jsonPath = join(dir, `report-${stamp}.json`);
  writeFileSync(markdownPath, renderMarkdown(report), 'utf8');
  writeFileSync(htmlPath, renderHtml(report), 'utf8');
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  return { markdownPath, htmlPath, jsonPath };
}
