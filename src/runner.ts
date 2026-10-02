import { readFileSync } from 'node:fs';
import { createClient } from './client.js';
import { createEvidenceRecorder, recordCall } from './evidence.js';
import { createRng } from './random.js';
import { ASSETS_VERSION, DECOYS, PROBESET_VERSION } from './assets.js';
import { computeTotal } from './scoring.js';
import { probeIdentity } from './probes/identity.js';
import { probeContext } from './probes/context.js';
import { probeBilling } from './probes/billing.js';
import { probeCapability } from './probes/capability.js';
import { probeQuality } from './probes/quality.js';
import { probeTtft } from './probes/ttft.js';
import type { AuditReport, ProbeCtx, ProbeId, ProbeOutcome, RunConfig } from './types.js';

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
  const decided = computeTotal(outcomes);

  const notes = [
    `seed=${cfg.seed}：同一 seed 与同一端点可复现探针内容；真实模型输出仍可能因服务端非确定性略有波动。`,
    'TTFT 为观测项，不计入总分。',
    '诱饵请求仅记录行为供人工复核。',
    ...decided.notes,
  ];

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
