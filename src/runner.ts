import { readFileSync } from 'node:fs';
import { createClient } from './client.js';
import { createEvidenceRecorder, recordCall } from './evidence.js';
import { createRng } from './random.js';
import { ASSETS_VERSION, DECOYS, PROBESET_VERSION } from './assets.js';
import { computeTotal } from './scoring.js';
import { buildBaseline, diffBaseline, loadBaseline, type BaselineDiff } from './baseline.js';
import { probeIdentity } from './probes/identity.js';
import { probeContext } from './probes/context.js';
import { probeBilling } from './probes/billing.js';
import { probeCapability } from './probes/capability.js';
import { probeQuality } from './probes/quality.js';
import { probeTtft } from './probes/ttft.js';
import type { AuditReport, Level, ProbeCtx, ProbeId, ProbeOutcome, RunConfig } from './types.js';

export type ProgressFn = (id: string, outcome: ProbeOutcome) => void;

export async function runAudit(cfg: RunConfig, onProgress?: ProgressFn): Promise<AuditReport> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const rng = createRng(cfg.seed);
  const evidence = createEvidenceRecorder();
  const client = createClient({
    baseUrl: normalizeBase(cfg.baseUrl),
    apiKey: cfg.apiKey,
    timeoutMs: cfg.timeoutMs,
    retries: cfg.retries,
  });
  const ctx: ProbeCtx = { client, cfg, rng, evidence };

  const identity = await guard('identity', () => probeIdentity(ctx), onProgress);
  const context = await guard('context', () => probeContext(ctx), onProgress);
  const billing = await guard('billing', () => probeBilling(ctx), onProgress);
  const capability = await guard('capability', () => probeCapability(ctx), onProgress);
  const decoy = await decoyProbe(ctx);
  onProgress?.('decoy', decoy);
  const quality = await guard('quality', () => probeQuality(ctx), onProgress);
  const ttft = await guard('ttft', () => probeTtft(ctx), onProgress);

  const outcomes = [identity, context, billing, capability, decoy, quality, ttft];

  const notes = [
    `seed=${cfg.seed}：同一 seed 与同一端点可复现探针内容；真实模型输出仍可能因服务端非确定性略有波动。`,
    'TTFT 为观测项，不计入总分。',
    '诱饵请求仅记录行为供人工复核。',
  ];

  // 指纹基线：先构建本轮基线，再与输入基线对比；全部在 computeTotal 之前完成
  const currentBaseline = buildBaseline(outcomes, {
    model: cfg.model,
    seed: cfg.seed,
    probesetVersion: PROBESET_VERSION,
    assetsVersion: ASSETS_VERSION,
  });
  if (cfg.baselineIn) {
    try {
      const reference = loadBaseline(cfg.baselineIn);
      const diff = diffBaseline(reference, currentBaseline);
      if (!diff.comparable) {
        notes.push(`基线不可比（${diff.skipReason}），已跳过指纹对比。`);
      } else {
        applyBaselineDiff(outcomes, diff);
        if (diff.items.length > 0) {
          const driftedProbes = [...new Set(diff.items.map((i) => i.probeId))].join('、');
          notes.push(`基线对比：发现 ${diff.items.length} 项指纹漂移（${driftedProbes}），详见对应探针 findings。`);
        } else {
          notes.push(`基线对比：相对 ${cfg.baselineIn} 未发现指纹漂移。`);
        }
        if (reference.seed !== cfg.seed) {
          notes.push(`基线 seed=${reference.seed} 与本次不同，quality 题集不一致，该项漂移对比已跳过。`);
        }
      }
    } catch (error) {
      notes.push(`基线加载失败，已跳过指纹对比：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const decided = computeTotal(outcomes);
  notes.push(...decided.notes);

  const report: AuditReport = {
    meta: {
      tool: readToolVersion(),
      version: PROBESET_VERSION,
      probesetVersion: PROBESET_VERSION,
      assetsVersion: ASSETS_VERSION,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      seed: cfg.seed,
      startedAt,
      durationMs: Date.now() - startedMs,
      nodeVersion: process.version,
      claimedContext: cfg.claimedContext,
    },
    total: decided.total,
    overall: decided.overall,
    scores: decided.scores,
    outcomes,
    evidence: evidence.all(),
    notes,
  };
  return report;
}

async function guard(id: ProbeId, fn: () => Promise<ProbeOutcome>, onProgress?: ProgressFn): Promise<ProbeOutcome> {
  let outcome: ProbeOutcome;
  try {
    outcome = await fn();
  } catch (error) {
    outcome = {
      id,
      status: 'error',
      score: null,
      level: 'unknown',
      headline: `探针执行异常：${error instanceof Error ? error.message : String(error)}`,
      findings: [],
      metrics: {},
    };
  }
  onProgress?.(id, outcome);
  return outcome;
}

async function decoyProbe(ctx: ProbeCtx): Promise<ProbeOutcome> {
  const question = ctx.rng.pick(DECOYS);
  const result = await ctx.client.chat({
    model: ctx.cfg.model,
    messages: [{ role: 'user', content: question }],
    temperature: 0.7,
    max_tokens: 120,
  });
  const evidence = recordCall(ctx.evidence, {
    probe: 'decoy',
    label: 'decoy task',
    request: { model: ctx.cfg.model, stream: false, temperature: 0.7, maxTokens: 120, messages: [{ content: question }] },
    result,
  });
  return {
    id: 'decoy',
    status: 'ok',
    score: null,
    level: 'unknown',
    headline: '诱饵请求已记录（不计分，供人工复核）',
    findings: [
      {
        level: 'info',
        message: `诱饵任务「${question.slice(0, 24)}…」响应 ${result.ok ? '正常' : '失败'}，记录用于对照端点对无关请求的行为。`,
        evidenceIds: [evidence.id],
      },
    ],
    metrics: { response_chars: result.ok ? result.text.length : null },
  };
}

function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
}

const LEVEL_RANK = { unknown: 0, pass: 1, warn: 2, fail: 3 } as const;

function escalateLevel(current: Level, next: Level): Level {
  return LEVEL_RANK[next] > LEVEL_RANK[current] ? next : current;
}

/** 把基线漂移项落到对应 outcome：追加 finding；cap 仅在 score 为 number 时取 min 并按 cap 重算 level。 */
function applyBaselineDiff(outcomes: ProbeOutcome[], diff: BaselineDiff): void {
  for (const item of diff.items) {
    const outcome = outcomes.find((o) => o.id === item.probeId);
    if (!outcome) continue;
    outcome.findings.push({ level: item.level, message: item.message, evidenceIds: [] });
    if (typeof outcome.score !== 'number' || !Number.isFinite(outcome.score) || item.cap === null || !Number.isFinite(item.cap)) continue;
    outcome.score = Math.min(outcome.score, item.cap);
    if (item.cap <= 30) outcome.level = escalateLevel(outcome.level, 'fail');
    else if (item.cap <= 70) outcome.level = escalateLevel(outcome.level, 'warn');
  }
}

function readToolVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
