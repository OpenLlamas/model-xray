import { readFileSync } from 'node:fs';
import { createClient, QuotaExhaustedError } from './client.js';
import { createEvidenceRecorder, recordCall } from './evidence.js';
import { runFailureDigest } from './diagnostics.js';
import { createRng } from './random.js';
import { ASSETS_VERSION, DECOYS, PROBESET_VERSION } from './assets.js';
import { computeTotal } from './scoring.js';
import { buildBaseline, diffBaseline, loadBaseline, type BaselineDiff, type BaselineFile } from './baseline.js';
import { deriveOrigin } from './pricing.js';
import { redactUrl } from './redact.js';
import { buildLedgerEntry, readLastPricingSnapshot, withLedgerLock } from './pricing-ledger.js';
import { probeIdentity } from './probes/identity.js';
import { probeContext } from './probes/context.js';
import { probeBilling } from './probes/billing.js';
import { probeCapability } from './probes/capability.js';
import { probeQuality } from './probes/quality.js';
import { probeTtft } from './probes/ttft.js';
import { isBlankAnswer, isStarved } from './probes/starve.js';
import type {
  AuditReport,
  ChatResult,
  EvidenceRecord,
  Level,
  ProbeCtx,
  ProbeId,
  ProbeOutcome,
  RequestProgressEvent,
  RunConfig,
} from './types.js';

export type ProgressFn = (id: string, outcome: ProbeOutcome) => void;
/** 细粒度进度（阶段开始 / 每请求开始与结束）；由 CLI 在 WebUI 或显式开启时接到 stderr。 */
export type ActivityFn = (message: string) => void;

const PHASE_LABELS: Record<ProbeId | 'decoy', string> = {
  identity: '身份',
  context: '上下文',
  billing: '计量',
  capability: '能力',
  decoy: '诱饵',
  quality: '质量',
  ttft: '首字时延',
};

function phaseHint(id: ProbeId, cfg: RunConfig): string {
  if (id === 'context') {
    return `（长上下文探针，单请求上限 ${Math.round(cfg.timeoutMs / 1000)}s；深度模式整体可能数分钟至数十分钟）`;
  }
  if (id === 'ttft') return '（串行 + 并发观测）';
  return '';
}

function formatRequestActivity(phase: ProbeId | 'decoy', event: RequestProgressEvent, timeoutMs: number): string {
  const label = `${phase} 请求 #${event.seq}`;
  if (event.kind === 'start') {
    const estimate =
      event.promptTokensEstimate !== null && event.promptTokensEstimate !== undefined
        ? ` · 约 ${event.promptTokensEstimate.toLocaleString('en-US')} 输入 tokens`
        : '';
    return `[RUN] ${label} 开始（第 ${event.attempt} 次尝试${estimate}；超时上限 ${Math.round(timeoutMs / 1000)}s）`;
  }
  const status = event.status === 0 ? '传输失败/超时' : `HTTP ${event.status}`;
  const secs = ((event.durationMs ?? 0) / 1000).toFixed(1);
  const tokens =
    event.promptTokens !== null && event.promptTokens !== undefined
      ? ` · 输入 ${event.promptTokens.toLocaleString('en-US')} tokens`
      : '';
  const reason = (event.error ?? '').replace(/\s+/g, ' ').trim();
  const error = event.ok === true ? '' : ` · ${reason === '' ? '失败' : reason.slice(0, 160)}`;
  return `[RUN] ${label} 完成：${status} · ${secs}s${tokens}${error}`;
}

export async function runAudit(
  cfg: RunConfig,
  onProgress?: ProgressFn,
  /** 已由调用方（CLI fail-fast）加载校验过的基线；缺省时 runner 自行加载（库调用方兼容）。
   *  必须在探针执行前确定：先烧钱再重读磁盘文件，若文件中途损坏会静默丢掉指纹对比。 */
  baselineRef?: BaselineFile,
  /** 每阶段/每请求进度（可选；回调异常不得影响审计）。 */
  onActivity?: ActivityFn,
): Promise<AuditReport> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const rng = createRng(cfg.seed);
  const evidence = createEvidenceRecorder();
  let currentPhase: ProbeId | 'decoy' = 'identity';
  const quotaSkipped: ProbeId[] = [];
  const activity: ActivityFn | undefined =
    onActivity === undefined
      ? undefined
      : (message) => {
          try {
            onActivity(message);
          } catch {
            // 进度展示失败不得影响审计
          }
        };
  const client = createClient({
    baseUrl: normalizeBase(cfg.baseUrl),
    apiKey: cfg.apiKey,
    timeoutMs: cfg.timeoutMs,
    retries: cfg.retries,
    httpRetries: cfg.httpRetries,
    abortOnQuota: true,
    onRequest:
      activity === undefined
        ? undefined
        : (event) => {
            activity(formatRequestActivity(currentPhase, event, cfg.timeoutMs));
          },
  });
  // 基线必须在探针执行前确定（注释见 baselineRef 参数说明）：billing 的公示倍率漂移检测也需要历史快照，
  // 先烧钱再重读磁盘会静默丢掉倍率对比；加载失败在此记下原因，探针照跑、对比环节如实披露。
  let baselineForRun: BaselineFile | null = null;
  let baselineLoadError: string | null = null;
  if (cfg.baselineIn) {
    try {
      baselineForRun = baselineRef ?? loadBaseline(cfg.baselineIn);
    } catch (error) {
      baselineLoadError = error instanceof Error ? error.message : String(error);
    }
  }
  // 历史公示快照：显式基线与本地价格账本都读取——两者同时存在时都参与 billing 漂移对照，
  // 否则显式 --baseline 会遮蔽账本中更新的跳变（基线时间与现在之间的上涨被漏检）。
  // 主源优先 baseline，账本作为 previousPricingAlt；没有基线时账本即主源（无需 --baseline 也能自动检测）。
  // 账本读取在锁内进行：并发追加者写一半时裸读会把半行误计为损坏（喂给尾部损坏告警路径）；
  // 锁等待超时（价格账本被占用）等失败一律降级为如实披露（pricingLedgerError），审计绝不因本地归档锁而失败。
  // 账本归档键需要站点 origin；baseUrl 非法时不能让整个审计崩掉（库调用方可能绕过 CLI 校验），
  // 退化为「无账本对照」并如实披露，探针照跑。
  let origin: string;
  try {
    origin = deriveOrigin(cfg.baseUrl);
  } catch (error) {
    origin = '';
  }
  const baselinePricing = baselineForRun?.pricing ?? null;
  let ledgerPricing: ReturnType<typeof readLastPricingSnapshot>['entry'] = null;
  let pricingLedgerError: string | null = null;
  let pricingLedgerPath: string | null = null;
  let pricingLedgerCorruptLines: number | null = null;
  let pricingLedgerTailCorrupt: boolean | null = null;
  let pricingLedgerOriginNote: string | null = null;
  if (origin === '') {
    pricingLedgerError = `baseUrl 无法解析为 URL（${redactUrl(cfg.baseUrl)}）：本轮未对比本地价格账本`;
  } else {
    try {
      const read = withLedgerLock(cfg.outDir, origin, () => readLastPricingSnapshot(cfg.outDir, origin));
      pricingLedgerPath = read.path;
      if (read.kind === 'ok') {
        ledgerPricing = read.entry;
        pricingLedgerCorruptLines = read.corruptLines;
        pricingLedgerTailCorrupt = read.tailCorrupt;
        pricingLedgerOriginNote = read.originNote;
      } else if (read.kind === 'error') {
        pricingLedgerError = read.error ?? '价格账本读取失败';
      }
    } catch (error) {
      pricingLedgerError = error instanceof Error ? error.message : String(error);
    }
  }
  const previousPricing = baselinePricing ?? ledgerPricing;
  const previousPricingSource = baselinePricing !== null ? ('baseline' as const) : ledgerPricing !== null ? ('ledger' as const) : null;
  const previousPricingAlt = baselinePricing !== null && ledgerPricing !== null ? ledgerPricing : null;
  const previousPricingAltSource = previousPricingAlt !== null ? ('ledger' as const) : null;
  const ctx: ProbeCtx = {
    client,
    cfg,
    rng,
    evidence,
    previousPricing,
    previousPricingSource,
    previousPricingAlt,
    previousPricingAltSource,
    pricingLedgerError,
    pricingLedgerCorruptLines,
    pricingLedgerTailCorrupt,
    pricingLedgerPath,
    pricingLedgerOriginNote,
    // 账本写入回调：billing 抓到公示快照后落盘；失败折叠成结果对象披露，绝不抛出打断审计。
    // 写入同样在文件锁内完成（与 watch/其他审计进程互斥），并在锁内重读尾部：
    // 尾部损坏（坏行/未终止半行）时拒绝追加——盲写会让新行粘在半行后一起损坏，账本永远无法恢复。
    onPricingSnapshot: (declared) => {
      try {
        const entry = buildLedgerEntry(declared, cfg.model);
        return withLedgerLock(cfg.outDir, entry.origin, (appendLocked) => {
          const latest = readLastPricingSnapshot(cfg.outDir, entry.origin);
          if (latest.kind === 'error') {
            return { ok: false, path: null, error: `${latest.error ?? '价格账本读取失败'}（本轮未写入）` };
          }
          if (latest.tailCorrupt) {
            return {
              ok: false,
              path: null,
              error: '价格账本尾部损坏（存在无法解析的坏行或未终止半行），本轮未写入；请先检查账本文件',
            };
          }
          return { ok: true, path: appendLocked(entry), error: null };
        });
      } catch (error) {
        return { ok: false, path: null, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };

  const runPhase = async (id: ProbeId, fn: () => Promise<ProbeOutcome>): Promise<ProbeOutcome> => {
    currentPhase = id;
    if (client.quotaExhausted?.() === true) {
      const outcome: ProbeOutcome = {
        id,
        status: 'insufficient',
        score: null,
        level: 'unknown',
        headline: 'API key 配额耗尽，已跳过该维度（未发送请求）',
        findings: [
          {
            level: 'info',
            message: `首个配额耗尽错误：${client.quotaMessage?.() ?? 'quota exceeded'}。为避免继续空发请求，本维度及后续维度不再执行；请充值或更换 key 后复测。`,
            evidenceIds: [],
          },
        ],
        metrics: { skipped: 1 },
      };
      quotaSkipped.push(id);
      activity?.(`[RUN] 阶段 ${id}（${PHASE_LABELS[id]}）跳过：API key 配额耗尽`);
      onProgress?.(id, outcome);
      return outcome;
    }
    const phaseStartedMs = Date.now();
    activity?.(`[RUN] 阶段 ${id}（${PHASE_LABELS[id]}）开始${phaseHint(id, cfg)}`);
    const outcome = await guard(id, fn);
    const elapsedSec = ((Date.now() - phaseStartedMs) / 1000).toFixed(1);
    const score = outcome.score === null ? '—' : `${outcome.score}/100`;
    activity?.(`[RUN] 阶段 ${id}（${PHASE_LABELS[id]}）完成 · ${outcome.level.toUpperCase()} · 得分 ${score} · ${elapsedSec}s`);
    onProgress?.(id, outcome);
    return outcome;
  };

  const identity = await runPhase('identity', () => probeIdentity(ctx));
  const context = await runPhase('context', () => probeContext(ctx));
  const billing = await runPhase('billing', () => probeBilling(ctx));
  const capability = await runPhase('capability', () => probeCapability(ctx));
  const decoy = await runPhase('decoy', () => decoyProbe(ctx));
  const quality = await runPhase('quality', () => probeQuality(ctx));
  const ttft = await runPhase('ttft', () => probeTtft(ctx));

  const outcomes = [identity, context, billing, capability, decoy, quality, ttft];

  const notes = [
    `seed=${cfg.seed}：同一 seed 与同一端点可复现探针内容；真实模型输出仍可能因服务端非确定性略有波动。`,
    'TTFT 为观测项，不计入总分。',
    '诱饵请求仅记录行为供人工复核。',
  ];
  if (client.quotaExhausted?.() === true) {
    notes.push(
      `API key 配额耗尽（${client.quotaMessage?.() ?? 'quota exceeded'}）：审计已提前熔断${quotaSkipped.length > 0 ? `，跳过 ${quotaSkipped.length} 个维度（${quotaSkipped.join('、')}）` : ''}；已执行维度仅代表配额耗尽前的样本，请充值或更换 key 后复测。`,
    );
  }
  notes.push(...gatewayDiagnosisNotes(outcomes, evidence.all(), cfg.model));
  // 运行级失败归因：N/M 笔请求被端点/网关拒绝等，让「为什么这么多未判定」一眼可读
  const runFailureNote = runFailureDigest(evidence.all());
  if (runFailureNote !== null) notes.push(runFailureNote);

  // 指纹基线：先构建本轮基线，再与输入基线对比；全部在 computeTotal 之前完成
  const currentBaseline = buildBaseline(outcomes, {
    model: cfg.model,
    seed: cfg.seed,
    probesetVersion: PROBESET_VERSION,
    assetsVersion: ASSETS_VERSION,
  });
  if (cfg.baselineIn) {
    if (baselineForRun === null) {
      notes.push(`基线加载失败，已跳过指纹对比：${baselineLoadError ?? '原因未知'}`);
    } else {
      const reference = baselineForRun;
      const diff = diffBaseline(reference, currentBaseline);
      if (!diff.comparable) {
        notes.push(`基线不可比（${diff.skipReason}），已跳过指纹对比。`);
      } else {
        applyBaselineDiff(outcomes, diff);
        for (const disclosure of diff.notes) notes.push(disclosure);
        if (diff.items.length > 0) {
          const driftedProbes = [...new Set(diff.items.map((i) => i.probeId))].join('、');
          notes.push(`基线对比：发现 ${diff.items.length} 项指纹漂移（${driftedProbes}），详见对应探针 findings。`);
        } else if (diff.notes.length === 0) {
          notes.push(`基线对比：相对 ${cfg.baselineIn} 未发现指纹漂移。`);
        }
        if (reference.seed !== cfg.seed) {
          notes.push(`基线 seed=${reference.seed} 与本次不同，quality 题集不一致，该项漂移对比已跳过。`);
        }
      }
    }
  } else {
    // 无基线提示：如实披露本次审计的检测边界（同族换壳/静默降级不可检测）
    notes.push('未加载指纹基线：无法对比历史指纹，同族换壳/静默降级不可检测。建议固定基线后用 --baseline 复测。');
  }

  const decided = computeTotal(outcomes, {
    claimedContext: cfg.claimedContext !== null,
    expectedCapabilities: cfg.expect,
  });
  notes.push(...decided.notes);

  const report: AuditReport = {
    meta: {
      tool: readToolVersion(),
      version: PROBESET_VERSION,
      probesetVersion: PROBESET_VERSION,
      assetsVersion: ASSETS_VERSION,
      model: cfg.model,
      // 报告是可分享产物：baseUrl 里的 userinfo/query 可能夹带凭据，回显前先脱敏。
      baseUrl: redactUrl(cfg.baseUrl),
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
    if (error instanceof QuotaExhaustedError) {
      // 配额耗尽不是探针异常：本维度已执行部分保留，剩余请求未发送——明确标为证据不足而非执行错误。
      outcome = {
        id,
        status: 'insufficient',
        score: null,
        level: 'unknown',
        headline: 'API key 配额耗尽，本维度提前中止（后续请求未发送）',
        findings: [{ level: 'warn', message: `配额耗尽：${error.detail}`, evidenceIds: [] }],
        metrics: { quotaAborted: 1 },
      };
    } else {
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
  }
  onProgress?.(id, outcome);
  return outcome;
}

export function describeDecoyResponse(result: ChatResult): string {
  if (isStarved(result)) return '为空/截断（推理占满预算）';
  if (isBlankAnswer(result)) return '为空（HTTP 200，无 content）';
  if (!result.ok) return `失败（${result.error ?? 'unknown'}）`;
  return '正常';
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
  // 诱饵是行为观测：响应为空/截断（推理占满预算）绝不是「成功抵御」之类的正面结论，文案必须如实。
  return {
    id: 'decoy',
    status: 'ok',
    score: null,
    level: 'unknown',
    headline: '诱饵请求已记录（不计分，供人工复核）',
    findings: [
      {
        level: 'info',
        message: `诱饵任务「${question.slice(0, 24)}…」响应 ${describeDecoyResponse(result)}，记录用于对照端点对无关请求的行为。`,
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

/** 把基线漂移项落到对应 outcome：追加 finding；cap 仅在 score 为 number 时取 min 并按 cap 重算 level（导出供单测）。
 *  分项不可评分（score 非有限数）时 cap 无从落点，但漂移结论必须提升该分项 level——
 *  overall 由各分项 level 派生（computeTotal 的 anyFail/anyWarn），否则会出现
 *  「FAIL 级「疑似模型被更换」finding 之下 overall=warn/exit 0」的矛盾判定。 */
export function applyBaselineDiff(outcomes: ProbeOutcome[], diff: BaselineDiff): void {
  for (const item of diff.items) {
    const outcome = outcomes.find((o) => o.id === item.probeId);
    if (!outcome) continue;
    outcome.findings.push({ level: item.level, message: item.message, evidenceIds: [] });
    if (typeof outcome.score !== 'number' || !Number.isFinite(outcome.score) || item.cap === null || !Number.isFinite(item.cap)) {
      outcome.level = escalateLevel(outcome.level, item.level);
      continue;
    }
    outcome.score = Math.min(outcome.score, item.cap);
    if (item.cap <= 30) outcome.level = escalateLevel(outcome.level, 'fail');
    else if (item.cap <= 70) outcome.level = escalateLevel(outcome.level, 'warn');
    // headline 同步标注封顶，避免「标题说题集通过、分数却是 30」的矛盾呈现
    outcome.headline = `${outcome.headline}（基线漂移封顶 ${item.cap}：${item.message}）`;
  }
}

/**
 * 端点级诊断：把「大量 200 空正文」「回显模型与请求不一致」从分散的探针 finding 提升为报告级说明，
 * 直接回答「是我配置错了吗还是网关问题」。只依据 evidence 的客观字段，不做模型真伪断言。
 */
function gatewayDiagnosisNotes(outcomes: ProbeOutcome[], evidence: EvidenceRecord[], model: string): string[] {
  const notes: string[] = [];
  if (evidence.length === 0) return notes;
  const isEmptyResponse = (record: EvidenceRecord): boolean => {
    const response = record.response;
    if (response.status !== 200 || response.finishReason === 'length') return false;
    return response.textChars === 0 && response.toolCallCount === 0;
  };
  const empty = evidence.filter(isEmptyResponse);
  const firstEmpty = empty.filter((record) => !record.label.includes('(stream-retry@'));
  const fallbackAttempts = evidence.filter((record) => record.label.includes('(stream-retry@'));
  const fallbackUsable = fallbackAttempts.filter(
    (record) => record.response.textChars > 0 || record.response.toolCallCount > 0,
  );
  if (firstEmpty.length >= 2) {
    const recovery =
      fallbackAttempts.length > 0
        ? `；自动流式回退 ${fallbackAttempts.length} 条，成功 ${fallbackUsable.length} 条${
            fallbackAttempts.length > fallbackUsable.length
              ? `、仍无可用正文 ${fallbackAttempts.length - fallbackUsable.length} 条`
              : ''
          }`
        : '';
    const conclusion =
      fallbackUsable.length > 0
        ? '同一模型流式可用，说明 API key 与本地配置基本无误；问题集中在该中转的非流式路由，相关维度已按流式回退结果评分并披露。建议让中转站修复非流式路由，或改用流式调用。'
        : '更像是上游中转/网关没有产出内容；请先核对该模型名在该渠道是否受支持，再查看中转日志。';
    notes.push(
      `网关诊断：首查有 ${firstEmpty.length}/${evidence.length} 条 HTTP 200 空正文（无 content/tool_calls）${recovery}。${conclusion}`,
    );
  }
  const billingEmpty = empty.filter((record) => record.probe === 'billing').length;
  if (billingEmpty > 0) {
    notes.push(
      `计量维度有 ${billingEmpty} 条 200 空正文但携带 usage：按 usage 计分，未重试空正文（避免重复计费污染实测倍率）；倍率结论请结合该披露复核。`,
    );
  }
  const identity = outcomes.find((outcome) => outcome.id === 'identity');
  const echo = identity?.metrics['model_echo'];
  const echoValues = identity?.metrics['model_echo_values'];
  if (
    typeof echo === 'string' &&
    /^\d+\/\d+$/.test(echo) &&
    typeof echoValues === 'string' &&
    echoValues !== 'none'
  ) {
    const [matchText, totalText] = echo.split('/');
    const match = Number(matchText);
    const total = Number(totalText);
    if (Number.isFinite(match) && Number.isFinite(total) && total > 0 && match < total) {
      notes.push(
        `网关路由诊断：请求模型 ${model}，上游回显 ${echoValues}（${echo} 次一致）。回显不一致通常意味着网关路由到了其他模型/渠道，不是本地配置问题；请核对中转站渠道映射。`,
      );
    }
  }
  return notes;
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
