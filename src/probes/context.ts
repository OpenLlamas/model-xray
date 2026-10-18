import type { ChatMessage, ChatResult, Finding, ProbeCtx, ProbeOutcome } from '../types.js';
import { buildEchoQuestion, buildFiller, buildNeedle, buildNeedleQuestion } from '../assets.js';
import { isStarved, isBlankAnswer, chatWithStarveRetry, PROBE_BUDGETS } from './starve.js';

const DEPTHS = [0.25, 0.5, 0.75, 0.9];

/**
 * 400 响应体中指向「非输入过大」的归因关键词：欠费/额度/限流/鉴权/模型不存在/内容策略。
 * 部分中转站把余额不足、模型名拼错、内容风控一律回成 400（实测 new-api 系即如此），
 * 若一律当「端点显式拒绝输入过大」就会把欠费误判成「标称窗口不实」——诬告。
 * 只在这些归因明确命中时降级为「不可判定」；响应体为空/泛化（Bad Request）仍按尺寸证据处理，
 * 以免丢失真实超长检测能力。
 */
const NON_SIZE_REJECT =
  /insufficient[_\s-]?(balance|quota|credit)|quota[_\s-]?(exhaust|exceeded)|exceeded your current quota|rate[_\s-]?limit|too many requests|余额|欠费|额度|计费|unauthori[sz]ed|invalid[_\s-]?api[_\s-]?key|authentication|permission[_\s-]?denied|model[_\s-]?(not[_\s-]?(found|exist|support))|does not exist|unsupported model|content[_\s-]?(policy|moderation|filter)|sensitive/i;

/** 仅「400 且响应体未指向其他归因」才构成「输入过大被显式拒绝」的证据。 */
function isSizeRejection(result: ChatResult): boolean {
  return !result.ok && result.status === 400 && !NON_SIZE_REJECT.test(result.error ?? '');
}

interface DepthStat {
  hits: number;
  attempted: number;
}

interface DepthRecord {
  depth: number;
  /** 该深度累计命中数 */
  hits: number;
  /** 该深度累计有效样本数（不含 starved/传输故障/400 候选） */
  attempted: number;
  /** 该深度累计 HTTP 400 尺寸类候选样本数 */
  sizeRejects: number;
  /** 该深度累计发出的请求数（含 400/starved/传输故障），用于「整档全部被拒」判定 */
  requested: number;
}

/** 差分对照样本结果（短输入用 ok/hit；长样本复验用 sizeRejected）。 */
type SizeControl = Awaited<ReturnType<typeof differentialSizeProbe>>;

/** 确认性复采结果 */
interface DepthConfirmation {
  depth: number;
  hits: number;
  attempted: number;
  starved: number;
  errored: number;
  empty: number;
  evidenceIds: string[];
  emptyEvidenceIds: string[];
}

/** 确认性复采每档追加样本数：标准 2、--deep 3；仅每档 ≥3 样本的标准档才自动复采（低成本档不复采）。 */
const DEFAULT_CONFIRM_SAMPLES = 2;
const DEEP_CONFIRM_SAMPLES = 3;

interface ContextSignals {
  /** 未加复核门槛的退化信号（只用于触发确认性复采，不可直接定罪） */
  rawDegrade: boolean;
  lowMiss: boolean;
  highMiss: boolean;
  lowAllMiss: boolean;
  highZero: boolean;
  highZeroTiers: number;
  highMissTiersCount: number;
  monotoneDegrade: boolean;
  /** 疑似退化但未达预注册显著性门槛（只用于 warn 提示，不定罪） */
  suspectDegrade: boolean;
  zeroMissDepths: number[];
  missDepths: number[];
  missDepthsHigh: number[];
  lowStat: DepthStat | undefined;
  highStats: HighStat[];
}

/** 高深度档计数（带深度标识，确认性复采按深度判定是否已复核） */
type HighStat = DepthStat & { depth: number };

/**
 * 预注册的显著性门槛（层 3 审查要求：统计定罪必须定义零假设、alpha 与多重比较校正，
 * 否则「低深度 6/6 + 高深度 2/6」这类可能纯属噪声的模式会被当成「窗口不实」的证据）。
 * 零假设：某深度档命中率与基线档（25%）相同；单侧 Fisher 精确检验（超几何分布，小样本
 * 不做正态近似）+ 按检验档数 Bonferroni 校正。未达门槛 → 只报 warn，并建议 --deep
 * 二分扫描用确定性证据定位真实窗口上界。
 */
const ALPHA = 0.01;

const binom = (n: number, k: number): number => {
  if (n < 0 || k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i += 1) r = (r * (n - k + i)) / i;
  return r;
};

/**
 * 单侧 Fisher 精确检验 P(X <= tierHits)，X 为超几何分布：
 * N = 两档样本总数，K = 两档命中总数，n = 该档样本数 → P(X = k) = C(K,k)·C(N-K, n-k) / C(N, n)。
 * 「该档更差」对应命中数落在下尾（观测值 tierHits），故取下尾概率。
 */
function fisherOneSidedP(tierHits: number, tierMisses: number, baseHits: number, baseMisses: number): number {
  const rowHits = tierHits + baseHits;
  const total = tierHits + tierMisses + baseHits + baseMisses;
  const n = tierHits + tierMisses;
  if (rowHits === 0 || n === 0 || total === 0) return 1;
  const denom = binom(total, n);
  if (denom === 0) return 1;
  let p = 0;
  for (let k = 0; k <= Math.min(rowHits, tierHits); k += 1) {
    p += (binom(rowHits, k) * binom(total - rowHits, n - k)) / denom;
  }
  return Math.min(1, Math.max(0, p));
}

/** 该档相对基线是否显著更差（单侧精确检验 + Bonferroni 校正） */
function significantlyWorse(tier: DepthStat, base: DepthStat, testedTiers: number): boolean {
  const p = fisherOneSidedP(tier.hits, tier.attempted - tier.hits, base.hits, base.attempted - base.hits);
  return p * Math.max(1, testedTiers) <= ALPHA;
}

/**
 * 由每档计数推导定论级信号（确认性复采后需重算，故抽成纯函数）。
 * confirmedDepths/deep 的作用：非 --deep 模式下，「整档零命中」这类单样本证据必须
 * 经确认性复采复核才计入 highZeroTiers —— 否则两个未复核的 0/3 就能定罪（层 3 审查项）。
 */
function computeSignals(depthStats: Record<string, DepthStat>, confirmedDepths: Set<number>, deep: boolean): ContextSignals {
  const lowStat = depthStats['0.25'];
  const highDepths = DEPTHS.filter((d) => d >= 0.5);
  const highStats: HighStat[] = highDepths
    .map((d) => depthStats[String(d)])
    .filter((s): s is DepthStat => s !== undefined && s.attempted > 0)
    .map((s) => ({ ...s, depth: highDepths.find((d) => depthStats[String(d)] === s)! }));
  const lowRate = lowStat !== undefined && lowStat.attempted > 0 ? lowStat.hits / lowStat.attempted : 1;
  const highMissTiersCount = highStats.filter((s) => s.hits < s.attempted).length;
  // 已复核（或 --deep）的高深度档合并命中率：单调恶化必须有量级差（< 低深度档的一半），
  // 仅「严格小于」不够 —— 低深度 3/3、高深度 3/6 的组合同样满足严格小于，
  // 但那是注意力噪声而非窗口不实（层 3 审查：「2/3 vs 1/3 只差一个样本即可定罪」）。
  const confirmedHigh = highStats.filter((s) => deep || confirmedDepths.has(s.depth));
  const confirmedHighAttempts = confirmedHigh.reduce((n, s) => n + s.attempted, 0);
  const testedTiers = confirmedHigh.length;
  // 量级门槛 + 预注册显著性门槛（单侧 Fisher 精确检验 + Bonferroni 校正）
  const halfTierCount =
    lowStat !== undefined && lowStat.attempted > 0
      ? confirmedHigh.filter((s) => s.hits / s.attempted < lowRate / 2 && significantlyWorse(s, lowStat, testedTiers)).length
      : 0;
  const significantZeroTiers =
    lowStat !== undefined && lowStat.attempted > 0
      ? highStats.filter((s) => s.hits === 0 && (deep || confirmedDepths.has(s.depth)) && significantlyWorse(s, lowStat, testedTiers)).length
      : 0;
  // 显著性不足时保留「疑似退化」信号，仅用于 warn 提示（不计定罪）
  const suspectDegrade =
    lowStat !== undefined && lowStat.attempted > 0 && highMissTiersCount >= 2 &&
    highStats.every((s) => s.hits / s.attempted < lowRate) && confirmedHighAttempts >= 2 &&
    confirmedHigh.filter((s) => s.hits / s.attempted < lowRate / 2).length >= 2;
  const zeroMissDepths = DEPTHS.filter((d) => {
    const s = depthStats[String(d)];
    return s !== undefined && s.attempted > 0 && s.hits === 0;
  });
  const missDepths = DEPTHS.filter((d) => {
    const s = depthStats[String(d)];
    return s !== undefined && s.attempted > 0 && s.hits < s.attempted;
  });
  return {
    rawDegrade:
      lowStat !== undefined && lowStat.attempted > 0 && highMissTiersCount >= 2 && highStats.every((s) => s.hits / s.attempted < lowRate),
    lowMiss: lowStat !== undefined && lowStat.attempted > 0 && lowStat.hits < lowStat.attempted,
    highMiss: highStats.some((s) => s.hits < s.attempted),
    lowAllMiss: lowStat !== undefined && lowStat.attempted > 0 && lowStat.hits === 0,
    highZero: highStats.some((s) => s.hits === 0),
    highZeroTiers: significantZeroTiers,
    highMissTiersCount,
    monotoneDegrade: halfTierCount >= 2,
    suspectDegrade,
    zeroMissDepths,
    missDepths,
    missDepthsHigh: missDepths.filter((d) => d >= 0.5),
    lowStat,
    highStats,
  };
}

/**
 * 确认性复采：在指定深度补 CONFIRM_SAMPLES 个全新 nonce 样本（位置均匀分布），
 * 用于把 n=3 的单样本抖动从定论依据里挤掉。starved/请求失败样本不计入分母。
 */
async function confirmDepth(
  ctx: ProbeCtx,
  claimed: number,
  depth: number,
  confirmSamples: number,
): Promise<DepthConfirmation> {
  const targetTokens = Math.floor(claimed * depth);
  const evidenceIds: string[] = [];
  const emptyEvidenceIds: string[] = [];
  let hits = 0;
  let attempted = 0;
  let starved = 0;
  let errored = 0;
  let empty = 0;
  for (let i = 0; i < confirmSamples; i += 1) {
    const nonce = ctx.rng.nonce(6);
    const filler = buildFiller(ctx.rng, targetTokens);
    const position = Math.floor(filler.length * ((i + 0.5) / confirmSamples));
    const needle = buildNeedle(ctx.rng, nonce);
    const document = `${filler.slice(0, position)}\n\n${needle}\n\n${filler.slice(position)}`;
    const messages: ChatMessage[] = [
      { role: 'system', content: '你将收到一份长文档和一个问题。请只依据文档内容回答，不要编造。' },
      { role: 'user', content: `${document}\n\n${buildNeedleQuestion(nonce, 'zh')}` },
    ];
    const call = await chatWithStarveRetry(ctx, {
      probe: 'context',
      label: `confirm depth=${depth} nonce=${nonce}`,
      buildRequest: (maxTokens) => ({ model: ctx.cfg.model, messages, temperature: 0, max_tokens: maxTokens }),
      budget: PROBE_BUDGETS.context,
      retryBudget: PROBE_BUDGETS.contextRetry,
    });
    evidenceIds.push(...call.evidenceIds);
    if (isStarved(call.result)) {
      starved += 1;
      continue;
    }
    if (!call.result.ok) {
      errored += 1;
      continue;
    }
    if (isBlankAnswer(call.result)) {
      empty += 1;
      emptyEvidenceIds.push(...call.evidenceIds);
      continue;
    }
    attempted += 1;
    if (containsNonce(call.result.text, nonce)) hits += 1;
  }
  return { depth, hits, attempted, starved, errored, empty, evidenceIds, emptyEvidenceIds };
}

export async function probeContext(ctx: ProbeCtx): Promise<ProbeOutcome> {
  const claimed = ctx.cfg.claimedContext ?? 0;
  if (claimed <= 0) {
    return {
      id: 'context',
      status: 'insufficient',
      score: null,
      level: 'unknown',
      headline: '未提供 --claimed-context，跳过上下文实测',
      findings: [{ level: 'info', message: '提供标称上下文窗口后本项才会执行。', evidenceIds: [] }],
      metrics: {},
    };
  }

  const findings: Finding[] = [];
  const metrics: Record<string, number | string | null> = { claimed_tokens: claimed };
  // 低成本档（默认）：每档 1 个样本，只做筛查；需要统计定论时用 --context-samples 3 或 --deep。
  // 历史默认 3 样本 + 自动复采 3 样本 = 每档 6 发，1M 标称单轮发送数千万 tokens，成本过高。
  const samplesPerDepth = ctx.cfg.contextSamples ?? (ctx.cfg.deep ? 5 : 1);
  const confirmSamples = ctx.cfg.deep ? DEEP_CONFIRM_SAMPLES : (ctx.cfg.contextConfirmSamples ?? DEFAULT_CONFIRM_SAMPLES);
  let explicitReject = false;
  let anySuccess = false;
  let starvedCount = 0;
  let emptySamples = 0;
  let blankRetriedCount = 0;
  let streamFallbackCount = 0;
  const streamFallbackEvidenceIds: string[] = [];
  const emptyEvidenceIds: string[] = [];
  const coverageGapEvidenceIds: string[] = [];
  let erroredSamples = 0;
  let validNeedleSamples = 0;
  let echoStarved = false;

  const depthResults: Record<string, string> = {};
  const depthMiss: Record<string, boolean> = {};
  /** 每档命中/有效样本数：定论级（fail）证据需要「全档零命中」或「随深度单调恶化」，稀疏样本不作为诬告依据 */
  const depthStats: Record<string, DepthStat> = {};
  /** 逐样本记账（hits/attempted 为该深度累计值）：400 候选样本需在差分验证后再定性 */
  const records: DepthRecord[] = [];
  /** 未命中样本的证据 id（聚合 fail finding 必须能回溯原始请求，兑现「每条 finding 链接证据」承诺） */
  const missEvidenceIds: string[] = [];

  for (const depth of DEPTHS) {
    const targetTokens = Math.floor(claimed * depth);
    let successAtDepth = 0;
    let attempted = 0;
    for (let i = 0; i < samplesPerDepth; i += 1) {
      const nonce = ctx.rng.nonce(6);
      const filler = buildFiller(ctx.rng, targetTokens);
      const fraction = (i + 0.5) / samplesPerDepth;
      const position = Math.floor(filler.length * fraction);
      const needle = buildNeedle(ctx.rng, nonce);
      const document = `${filler.slice(0, position)}\n\n${needle}\n\n${filler.slice(position)}`;
      const lang = ctx.rng.bool(0.5) ? 'zh' : 'en';
      const question = buildNeedleQuestion(nonce, lang);
      const messages: ChatMessage[] = [
        { role: 'system', content: '你将收到一份长文档和一个问题。请只依据文档内容回答，不要编造。' },
        { role: 'user', content: `${document}\n\n${question}` },
      ];
      const call = await chatWithStarveRetry(ctx, {
        probe: 'context',
        label: `needle depth=${depth} nonce=${nonce}`,
        buildRequest: (maxTokens) => ({ model: ctx.cfg.model, messages, temperature: 0, max_tokens: maxTokens }),
        budget: PROBE_BUDGETS.context,
        retryBudget: PROBE_BUDGETS.contextRetry,
      });
      const result = call.result;
      const evidenceIds = call.evidenceIds;
      if (call.blankRetried) blankRetriedCount += 1;
      if (call.streamFallback) {
        streamFallbackCount += 1;
        streamFallbackEvidenceIds.push(...evidenceIds);
      }
      if (call.retried) {
        findings.push({
          level: 'info',
          message: `深度 ${(depth * 100).toFixed(0)}% needle ${nonce}：首查推理占满预算，已升预算重试。`,
          evidenceIds,
        });
      }
      if (isStarved(result)) {
        // thinking 模型推理占满预算：无正文可判命中，该样本不计入截断判定（不得据此指控静默截断）。
        starvedCount += 1;
        coverageGapEvidenceIds.push(...evidenceIds);
        findings.push({
          level: 'info',
          message: `深度 ${(depth * 100).toFixed(0)}%（约 ${targetTokens} tokens）needle ${nonce}：响应为空/截断（推理占满预算），该样本不计入截断判定。`,
          evidenceIds,
        });
        continue;
      }
      if (!result.ok && isSizeRejection(result)) {
        // 400「尺寸类候选」：不进分母、不算未命中、不立即定罪 —— 需先经差分验证
        // （短输入对照样本是否成功）确认「拒绝确实与输入长度相关」。
        // 理由：靠错误文案枚举归因不可靠（网关/参数/WAF 也回 400 且文案千奇百怪），
        // 而「长输入全 400 + 短输入正常」才是与窗口相关的直接证据。
        records.push({ depth, hits: 0, attempted: 0, sizeRejects: 1, requested: 1 });
        coverageGapEvidenceIds.push(...evidenceIds);
        findings.push({
          level: 'info',
          message: `深度 ${(depth * 100).toFixed(0)}%（约 ${targetTokens} tokens）needle ${nonce}：HTTP 400 拒绝（暂不计未命中，待差分验证是否与输入长度相关）。`,
          evidenceIds,
        });
        continue;
      }
      if (!result.ok) {
        // 传输/协议故障（fetch failed、超时、5xx、空响应…）与非尺寸类 400（欠费/限流/模型不存在）：
        // 既不能算命中也不能算未命中。
        // 历史缺陷（2026-10-17 官方 1M 标称实测实证）：glm-5.3-flash 深度 25% 的 1/3 样本
        // 「network：fetch failed」被计入分母 → depth_hits 记 2/3、判定「标称窗口不实（15 分 fail）」，
        // 而排除该样本后 25% 深度为 2/2 全命中、其余深度 3/3 全命中、结尾回显通过 = 无任何截断证据。
        erroredSamples += 1;
        records.push({ depth, hits: 0, attempted: 0, sizeRejects: 0, requested: 1 });
        coverageGapEvidenceIds.push(...evidenceIds);
        findings.push({
          level: 'warn',
          message: `深度 ${(depth * 100).toFixed(0)}%（约 ${targetTokens} tokens）needle ${nonce}：请求失败 ${result.error ?? 'unknown'}（传输/协议或非尺寸类拒绝，不计入截断判定：既非命中也非未命中）。`,
          evidenceIds,
        });
        continue;
      }
      if (isBlankAnswer(result)) {
        // HTTP 200 空文本：没有答案可判，既不能算命中也不能算未命中。
        // 历史缺陷（2026-10-18 真机）：空响应被计为 needle 未命中，12 发全空 → 误判「窗口不实」。
        emptySamples += 1;
        emptyEvidenceIds.push(...evidenceIds);
        coverageGapEvidenceIds.push(...evidenceIds);
        records.push({ depth, hits: successAtDepth, attempted, sizeRejects: 0, requested: 1 });
        continue;
      }
      attempted += 1;
      const hit = containsNonce(result.text, nonce);
      if (hit) {
        successAtDepth += 1;
        anySuccess = true;
      }
      records.push({ depth, hits: successAtDepth, attempted, sizeRejects: 0, requested: 1 });
      findings.push({
        level: hit ? 'info' : 'warn',
        message: `深度 ${(depth * 100).toFixed(0)}%（约 ${targetTokens} tokens）needle ${nonce}：${
          hit ? '命中' : `未命中（响应：${preview(result.text)}）`
        }`,
        evidenceIds,
      });
      if (!hit) missEvidenceIds.push(...evidenceIds);
    }
    validNeedleSamples += attempted;
    depthResults[String(depth)] = attempted > 0 ? `${successAtDepth}/${attempted}` : 'N/A';
    depthMiss[String(depth)] = attempted > 0 && successAtDepth < attempted;
  }

  if (emptySamples > 0) {
    findings.push({
      level: 'warn',
      message: `上下文有 ${emptySamples} 个样本返回空文本（HTTP 200，无 content${blankRetriedCount > 0 ? '，已自动改用流式回退仍为空' : ''}）：已从命中/未命中分母剔除（未获得答案 ≠ 答错/截断）。`,
      evidenceIds: emptyEvidenceIds,
    });
    metrics['empty_samples'] = emptySamples;
  }
  if (blankRetriedCount > 0) metrics['blank_retried'] = blankRetriedCount;
  if (streamFallbackCount > 0) {
    metrics['stream_fallbacks'] = streamFallbackCount;
    findings.push({
      level: 'info',
      message: `上下文有 ${streamFallbackCount} 个样本非流式返回空响应，已自动改用流式回退并取得答案（空响应 ≠ 截断）。`,
      evidenceIds: streamFallbackEvidenceIds,
    });
  }
  if (!ctx.cfg.deep && samplesPerDepth < 3) {
    findings.push({
      level: 'info',
      message: `低成本筛查：每档 ${samplesPerDepth} 个样本；通过/未命中结论的统计置信度低于 3 样本档，定论请用 --context-samples 3 或 --deep。`,
      evidenceIds: [],
    });
  }

  // 差分验证：出现 400 时，用一个短输入对照样本确认「拒绝是否与输入长度相关」。
  // 确认失败（短输入同样 400/失败）→ 400 一律降为不可判定样本，绝不据此指控窗口不实。
  let sizeRejectionConfirmed = false;
  const pendingSizeRejects = records.reduce((sum, r) => sum + r.sizeRejects, 0);
  if (pendingSizeRejects > 0) {
    // 多长度 + 配对长样本复验（层 3 反向审查：单发短样本成功可能是偶发/故障恢复后的巧合）：
    // ① 两发不同长度的短输入都要成功 → 端点确实接受短输入；
    // ② 在「最小被拒深度」补发一发长样本，仍须被拒 → 400 可复现，不是瞬时抖动。
    const rejectedDepths = [...new Set(records.filter((r) => r.sizeRejects > 0).map((r) => r.depth))].sort((a, b) => a - b);
    const smallestRejected = rejectedDepths[0];
    const controls: SizeControl[] = [];
    for (const tokens of [512, 1024]) controls.push(await differentialSizeProbe(ctx, claimed, tokens));
    // 长样本复验必须在「最小被拒深度」的真实长度上发（传深度比例会退化成极短输入，必然被接受）
    const longRetest = smallestRejected !== undefined
      ? await differentialSizeProbe(ctx, claimed, Math.floor(claimed * smallestRejected), true)
      : null;
    const shortOk = controls.every((c) => c.ok);
    const longReproduced = longRetest !== null && longRetest.sizeRejected;
    sizeRejectionConfirmed = shortOk && longReproduced;
    metrics['size_differential'] = controls.map((c) => `${c.tokens}tok:${c.ok ? 'accepted' : 'failed'}`).join(' ') +
      (longRetest !== null ? ` | ${(smallestRejected! * 100).toFixed(0)}%:${longRetest.sizeRejected ? 'rejected' : 'not-rejected'}` : '');
    if (sizeRejectionConfirmed) {
      findings.push({
        level: 'info',
        message: `差分验证通过：${pendingSizeRejects} 个 HTTP 400 样本之外，${controls.map((c) => `${c.tokens} tokens 短输入${c.hit ? '请求成功且可检索命中' : '请求成功'}`).join('、')}，并在最小被拒深度 ${(smallestRejected! * 100).toFixed(0)}% 复验仍被拒 → 拒绝与输入长度相关且可复现，可作为「窗口不实」证据。`,
        evidenceIds: [...controls.flatMap((c) => c.evidenceIds), ...(longRetest?.evidenceIds ?? [])],
      });
    } else {
      const why = !shortOk
        ? `${controls.filter((c) => !c.ok).map((c) => `${c.tokens} tokens 对照失败（${c.error}）`).join('、')}`
        : `最小被拒深度 ${(smallestRejected! * 100).toFixed(0)}% 复验未被拒（400 未复现）`;
      findings.push({
        level: 'warn',
        message: `差分验证未通过：${why} → 无法确认 HTTP 400 与输入长度相关，${pendingSizeRejects} 个 400 样本按证据不足处理（可能为欠费、参数校验或瞬时故障），不作为「窗口不实」证据。`,
        evidenceIds: [...controls.flatMap((c) => c.evidenceIds), ...(longRetest?.evidenceIds ?? [])],
      });
      erroredSamples += pendingSizeRejects;
    }
  }

  // records 里的 hits/attempted 均为「该深度累计值」，同深度后写覆盖先写即得最终计数
  for (const record of records) {
    if (record.attempted === 0) continue;
    depthStats[String(record.depth)] = { hits: record.hits, attempted: record.attempted };
  }
  // 显式拒绝需「差分验证通过 + 某深度（≥50%）整档全部为 400 且零有效样本」
  if (sizeRejectionConfirmed) {
    // 「整档全部被拒」必须构成单调拒绝前沿：所有深度 ≥50% 的档位请求全部为尺寸类 400（层 3 审查）——
    // 中间档偶发成功说明是请求特异性拒绝（如内容策略），不能整体归因为长度。
    // 必须按档聚合该档所有记录：records 为逐样本追加，find 只取首条会把
    // 「首样本 400、后续样本成功」误判成整档拒绝（假阳性定罪）。
    const highDepthsRe = DEPTHS.filter((d) => d >= 0.5);
    const frontierOk = highDepthsRe.every((d) => {
      const tierRecords = records.filter((r) => r.depth === d);
      const requested = tierRecords.reduce((sum, r) => sum + r.requested, 0);
      const sizeRejects = tierRecords.reduce((sum, r) => sum + r.sizeRejects, 0);
      const finalStat = depthStats[String(d)];
      return (
        tierRecords.length > 0 &&
        requested > 0 &&
        sizeRejects === requested &&
        (finalStat?.attempted ?? 0) === 0 &&
        (finalStat?.hits ?? 0) === 0
      );
    });
    explicitReject = frontierOk;
  }

  metrics['depth_hits'] = Object.entries(depthResults).map(([d, v]) => `${d}:${v}`).join(' ');
  metrics['depth_explicit_reject'] = explicitReject ? 1 : 0;
  if (erroredSamples > 0) metrics['errored_samples'] = erroredSamples;

  // 定论级（fail）证据门槛：稀疏样本（每档仅 3 个）下的「1 次未命中」是注意力噪声而非截断，
  // 据此指控「窗口不实」属诬告。fail 分支只接受下列强证据：
  // ① 高深度档全部零命中（≥2 档）；② 高深度档全部零命中且低深度同时有未命中；
  // ③ 低深度档零命中 + 结尾回显通过（头部被裁剪的指纹）；④ 结尾回显与高深度 needle 双控制同时失败；
  // ⑤ 高深度 ≥2 档有未命中且命中率随深度单调低于低深度（真实截断的退化曲线）；
  // ⑥ 边界二分扫描确认（仅 --deep，且扫描无故障，见 scanBoundary）；
  // ⑦ HTTP 400 尺寸类显式拒绝（须通过多长度差分验证，见上）。
  // 其余「零星未命中」一律降为 warn 并附命中计数，供人工复测而非直接定罪。
  const confirmedDepths = new Set<number>(ctx.cfg.deep ? DEPTHS : []);
  let signals = computeSignals(depthStats, confirmedDepths, ctx.cfg.deep);
  metrics['miss_depths'] = signals.missDepths.join(',') || 'none';
  metrics['zero_miss_depths'] = signals.zeroMissDepths.map((d) => `${(d * 100).toFixed(0)}%`).join(',') || 'none';
  if (signals.zeroMissDepths.length > 0 || signals.monotoneDegrade) metrics['miss_pattern'] = signals.monotoneDegrade ? 'monotone_degrade' : 'zero_miss_tiers';

  // 确认性复采（层 3 双向审查一致要求）：n=3 时「整档 0 命中」或「2/3 vs 1/3」只差一个样本即可
  // 触发定论，随机抖动就可能诬告。--deep（n=5）跳过；否则对最多两档高深度可疑档各补
  // CONFIRM_SAMPLES 个新 nonce 样本（低深度档有未命中时额外复核低深度档，因为「低深度更优」
  // 是单调退化的前提），合并后重算信号：退化不复现、或整档零命中未经复核 → 降为 warn 并披露两次计数。
  const needsConfirmation =
    !ctx.cfg.deep && samplesPerDepth >= 3 && (signals.rawDegrade || signals.zeroMissDepths.length > 0);
  if (needsConfirmation) {
    // 复核最深的两个高深度可疑档（深度越大越能区分「窗口不实」与「注意力噪声」）+ 低深度基线档。
    // 基线档必复核：定罪依赖「低深度明显优于高深度」，若基线只是 n=3 的侥幸命中，
    // 两档 2/6 就能与 3/3 凑出量级差（层 3 审查必修项）→ 基线与高深度必须同等样本量。
    const highSuspects = signals.missDepthsHigh.length > 0 ? signals.missDepthsHigh : signals.zeroMissDepths.filter((d) => d >= 0.5);
    const depthsToConfirm = [...new Set([...highSuspects].sort((a, b) => b - a).slice(0, 2).concat(0.25))];
    const confirmations: DepthConfirmation[] = [];
    for (const depth of depthsToConfirm) {
      const confirmation = await confirmDepth(ctx, claimed, depth, confirmSamples);
      confirmations.push(confirmation);
      if (confirmation.attempted === 0) coverageGapEvidenceIds.push(...confirmation.evidenceIds);
      confirmedDepths.add(depth);
      starvedCount += confirmation.starved;
      erroredSamples += confirmation.errored;
      emptySamples += confirmation.empty;
      emptyEvidenceIds.push(...confirmation.emptyEvidenceIds);
    }
    for (const c of confirmations) {
      const key = String(c.depth);
      const base = depthStats[key] ?? { hits: 0, attempted: 0 };
      depthStats[key] = { hits: base.hits + c.hits, attempted: base.attempted + c.attempted };
      depthResults[key] = `${depthStats[key]!.hits}/${depthStats[key]!.attempted}`;
      depthMiss[key] = depthStats[key]!.hits < depthStats[key]!.attempted;
      findings.push({
        level: 'info',
        message: `确认性复采：深度 ${(c.depth * 100).toFixed(0)}% 补 ${confirmSamples} 个新样本，命中 ${c.hits}/${c.attempted}${c.starved > 0 ? `（${c.starved} 个推理占满预算）` : ''}${c.errored > 0 ? `（${c.errored} 个请求失败）` : ''}${c.empty > 0 ? `（${c.empty} 个空响应）` : ''}；合并后该档 ${depthStats[key]!.hits}/${depthStats[key]!.attempted}。`,
        evidenceIds: c.evidenceIds,
      });
    }
    signals = computeSignals(depthStats, confirmedDepths, ctx.cfg.deep);
    validNeedleSamples += confirmations.reduce((sum, c) => sum + c.attempted, 0);
    // 确认样本命中也会构成「可读」证据：旧实现只更新 depthStats、不更新 anySuccess，
    // 导致首轮全空、复采出现命中时仍走「未获得任何命中」的 fail 分支（2026-10-18 真机）。
    anySuccess = anySuccess || Object.values(depthStats).some((s) => s.hits > 0);
    metrics['depth_hits'] = Object.entries(depthResults).map(([d, v]) => `${d}:${v}`).join(' ');
    metrics['zero_miss_depths'] = signals.zeroMissDepths.map((d) => `${(d * 100).toFixed(0)}%`).join(',') || 'none';
    const confirmed = signals.monotoneDegrade || signals.highZeroTiers > 0;
    metrics['miss_pattern'] = signals.monotoneDegrade
      ? 'monotone_degrade_confirmed'
      : signals.highZeroTiers > 0
        ? 'zero_miss_tiers_confirmed'
        : signals.zeroMissDepths.length > 0
          ? 'not_confirmed'
          : 'none';
    const merged = DEPTHS.map((d) => `${(d * 100).toFixed(0)}% ${depthStats[String(d)] ? `${depthStats[String(d)]!.hits}/${depthStats[String(d)]!.attempted}` : 'N/A'}`).join('，');
    findings.push({
      level: confirmed ? 'info' : 'warn',
      message: confirmed
        ? `确认性复采后退化仍成立（合并计数：${merged}），按定论级证据处理。`
        : `确认性复采后退化不复现或未经复核（合并计数：${merged}，复核档位：${confirmations.map((c) => `${(c.depth * 100).toFixed(0)}%`).join('、')}）：首轮零星未命中判为注意力噪声，不作截断定论。`,
      evidenceIds: confirmations.flatMap((c) => c.evidenceIds),
    });
  }

  // 确认性复采也可能遇到空响应：指标取合并后的总数（供报告与降级守卫使用）。
  if (emptySamples > 0) metrics['empty_samples'] = emptySamples;

  const missingDepths = DEPTHS.filter((d) => (depthStats[String(d)]?.attempted ?? 0) === 0);
  if (missingDepths.length > 0) {
    metrics['missing_depths'] = missingDepths.map((d) => `${(d * 100).toFixed(0)}%`).join(',');
  }
  // 通过结论必须建立在「每个深度都有可判样本」之上：部分深度全为空响应/请求失败/推理截断时，
  // 命中计数只覆盖剩余深度，不能据此宣称「标称窗口内 needle 全部命中」。
  // 存在有效未命中时不提前返回：那需要继续走结尾回显与既有的 fail/warn 判定树。
  // --deep 也不在此返回：边界扫描可能补正证据；若回显同样未取得，由下方专门分支判 insufficient。
  if (!ctx.cfg.deep && validNeedleSamples >= 2 && missingDepths.length > 0 && signals.missDepths.length === 0 && !explicitReject) {
    const gapReasons = [
      emptySamples > 0 ? `${emptySamples} 个空响应` : '',
      starvedCount > 0 ? `${starvedCount} 个推理占满预算` : '',
      erroredSamples > 0 ? `${erroredSamples} 个请求失败` : '',
    ]
      .filter((reason) => reason !== '')
      .join('、');
    findings.push({
      level: 'info',
      message: `有效样本覆盖不全：${missingDepths.map((d) => `${(d * 100).toFixed(0)}%`).join('、')} 深度没有可判定的 needle 结果${gapReasons === '' ? '' : `（${gapReasons}）`}。缺失深度无法验证可读性，不能据此给出「窗口属实」的通过结论。`,
      evidenceIds: coverageGapEvidenceIds,
    });
    return {
      id: 'context',
      status: 'insufficient',
      score: null,
      level: 'unknown',
      headline: `上下文探针仅在 ${DEPTHS.length - missingDepths.length}/${DEPTHS.length} 个深度获得有效样本（缺失 ${missingDepths.map((d) => `${(d * 100).toFixed(0)}%`).join('、')}），无法判定标称窗口是否属实`,
      findings,
      metrics,
    };
  }

  const missDepths = signals.missDepths;

  // 没有任何可判样本时，不必再发 90% 标称长度的结尾回显（1M 标称下这一发约 0.9M tokens）：
  // 空响应/请求失败/推理占满预算都不构成「窗口不实」证据，直接诚实不可判定。
  if (validNeedleSamples === 0 && !anySuccess && !sizeRejectionConfirmed) {
    const reasons = [
      emptySamples > 0 ? `${emptySamples} 个空响应` : '',
      starvedCount > 0 ? `${starvedCount} 个推理占满预算` : '',
      erroredSamples > 0 ? `${erroredSamples} 个请求失败` : '',
    ]
      .filter((s) => s !== '')
      .join('、');
    return {
      id: 'context',
      status: 'insufficient',
      score: null,
      level: 'unknown',
      headline: `上下文探针未获得任何有效样本（${reasons || '无有效样本'}），无法判定标称窗口是否属实`,
      findings,
      metrics,
    };
  }

  const echoNonce = ctx.rng.nonce(6);
  const echoFiller = buildFiller(ctx.rng, Math.floor(claimed * 0.9));
  const echoTail = `【结尾核对 ${echoNonce}】最后一句话的校验词是 ${echoNonce}。`;
  const echoDoc = `${echoFiller}\n\n${echoTail}`;
  const echoMessages: ChatMessage[] = [
    { role: 'system', content: '你将收到一份长文档和一个指令。请严格按指令执行。' },
    { role: 'user', content: `${echoDoc}\n\n${buildEchoQuestion()}` },
  ];
  const echoCall = await chatWithStarveRetry(ctx, {
    probe: 'context',
    label: `tail-echo nonce=${echoNonce}`,
    buildRequest: (maxTokens) => ({ model: ctx.cfg.model, messages: echoMessages, temperature: 0, max_tokens: maxTokens }),
    budget: PROBE_BUDGETS.context,
    retryBudget: PROBE_BUDGETS.contextRetry,
  });
  const echoResult = echoCall.result;
  if (echoCall.blankRetried) blankRetriedCount += 1;
  if (echoCall.streamFallback) {
    streamFallbackCount += 1;
    streamFallbackEvidenceIds.push(...echoCall.evidenceIds);
  }
  echoStarved = isStarved(echoResult);
  // 未通过差分验证的 400（含结尾回显）：证据不足，按不可判定处理，不得产出 fail 级指控
  const echoTransportError =
    !echoStarved && !echoResult.ok && (!isSizeRejection(echoResult) || !sizeRejectionConfirmed);
  const echoEmpty = !echoStarved && !echoTransportError && isBlankAnswer(echoResult);
  const echoInconclusive = echoStarved || echoTransportError || echoEmpty;
  const echoHit = !echoInconclusive && echoResult.ok && containsNonce(echoResult.text, echoNonce);
  metrics['tail_echo'] = echoStarved
    ? 'starved'
    : echoTransportError
      ? 'error'
      : echoEmpty
        ? 'empty'
        : echoHit
          ? 'hit'
          : 'miss';
  if (echoEmpty) {
    emptySamples += 1;
    emptyEvidenceIds.push(...echoCall.evidenceIds);
    metrics['empty_samples'] = emptySamples;
  }
  findings.push({
    level: echoStarved || echoTransportError ? 'info' : echoEmpty ? 'warn' : echoHit ? 'info' : 'fail',
    message: echoStarved
      ? '结尾回显：响应为空/截断（推理占满预算），无法判定，不计入失败。'
      : echoTransportError
        ? `结尾回显：请求失败 ${echoResult.error ?? 'unknown'}（传输/协议故障，无法判定，不计入失败）。`
        : echoEmpty
          ? `结尾回显：返回空文本（HTTP 200，无 content${echoCall.blankRetried ? '，已自动改用流式回退仍为空' : ''}），无法判定，不计入失败（空响应 ≠ 结尾不可读）。`
          : echoHit
            ? '结尾回显控制通过：标称长度 90% 处的结尾内容可被读取与复述。'
            : explicitReject
              ? '结尾回显控制失败：标称长度 90% 处的请求被端点显式拒绝 —— 标称窗口与实际接受长度不符（显式拒绝，非静默截断）。'
              : `结尾回显控制失败：标称长度 90% 处插入的结尾标记 ${echoNonce} 无法被复述（高深度 needle 失败=${signals.highMissTiersCount > 0 ? '是' : '否'}）。`,
    evidenceIds: echoCall.evidenceIds,
  });

  let boundaryScanned = false;
  let boundaryTruncated = false;
  if (!explicitReject && anySuccess && ctx.cfg.deep) {
    boundaryScanned = true;
    const scan = await scanBoundary(ctx, claimed);
    metrics['boundary'] = scan.detail;
    if (scan.found) {
      findings.push({
        level: 'fail',
        message: `边界扫描：标称 ${claimed} tokens 的端点在约 ${scan.foundAtTokens} tokens 处开始失败。`,
        evidenceIds: scan.evidenceIds,
      });
      boundaryTruncated = true;
    }
    if (scan.explicitReject) {
      // 与 needle 阶段同口径：400 文案黑名单不足以定罪，必须有差分验证背书
      // （层 3 反向审查：此处原可直接置 explicitReject，绕过差分确认再次定罪）。
      if (sizeRejectionConfirmed) {
        explicitReject = true;
      } else {
        findings.push({
          level: 'info',
          message: `边界扫描遇 ${scan.sizeRejectCount} 个尺寸类 400 拒绝，但差分验证未确认拒绝与输入长度相关：仅用于收敛二分区间，不作为「窗口不实」证据。`,
          evidenceIds: scan.evidenceIds,
        });
      }
    }
    if (scan.starvedSeen) {
      starvedCount += 1;
      findings.push({
        level: 'info',
        message: '边界扫描存在推理占满预算样本：扫描提前终止，不据此判定截断。',
        evidenceIds: scan.evidenceIds,
      });
    }
    if (scan.erroredSeen) {
      erroredSamples += scan.erroredCount;
      findings.push({
        level: 'warn',
        message: `边界扫描有 ${scan.erroredCount} 个样本传输/协议故障：二分区间单调性已破坏，扫描提前终止，不据此判定截断。`,
        evidenceIds: scan.evidenceIds,
      });
    }
  }
  metrics['boundary_scanned'] = boundaryScanned ? 1 : 0;
  if (starvedCount > 0 || echoStarved) metrics['starved_samples'] = starvedCount + (echoStarved ? 1 : 0);

  let score = 100;
  let level: ProbeOutcome['level'] = 'pass';
  let headline = `上下文实测通过：标称 ${claimed} tokens 内 needle 全部命中`;
  let verdictFromExplicitReject = false;

  if (!anySuccess) {
    score = 20;
    level = 'fail';
    headline = `上下文实测未获得任何命中：标称 ${claimed} tokens 不可用`;
  } else if (explicitReject) {
    score = 15;
    level = 'fail';
    verdictFromExplicitReject = true;
    headline = `标称窗口不实：端点对 ${claimed} tokens 标称长度内的输入显式拒绝（非静默截断）`;
  } else if (signals.highZeroTiers >= 2) {
    score = 10;
    level = 'fail';
    headline = `标称窗口不实：标称 ${claimed} tokens，但 50% 以上有 ${signals.highZeroTiers} 档 needle 零命中`;
    findings.push({
      level: 'fail',
      message: `零命中档位：${signals.zeroMissDepths.map((d) => `${(d * 100).toFixed(0)}%（0/${depthStats[String(d)]?.attempted ?? 0}）`).join('、')}。标称窗口内的中高深度出现系统性检索失败（整档全部不可读），与"真实窗口小于标称值"一致。`,
      evidenceIds: [...missEvidenceIds],
    });
  } else if (signals.lowAllMiss && signals.highMiss) {
    score = 10;
    level = 'fail';
    headline = `疑似静默截断：标称 ${claimed} tokens，但低深度（25%）整档零命中且高深度也有内容不可读`;
    findings.push({
      level: 'fail',
      message: `低深度 25%（0/${signals.lowStat?.attempted ?? 0}）整档零命中、高深度同时有未命中：输入中段/开头被丢弃，实际可用窗口小于标称值。`,
      evidenceIds: [...missEvidenceIds],
    });
  } else if (signals.lowAllMiss && echoHit) {
    score = 15;
    level = 'fail';
    headline = `标称窗口不实：标称 ${claimed} tokens，但 25% 深度整档零命中；结尾回显通过说明问题在输入被裁剪`;
    findings.push({
      level: 'fail',
      message:
        '低深度（25%）needle 整档零命中而结尾回显正常：端点保留了输入尾部、丢弃了开头（滑动窗口/裁掉头部），实际窗口小于标称值。',
      evidenceIds: [...missEvidenceIds],
    });
  } else if (signals.monotoneDegrade) {
    score = 10;
    level = 'fail';
    headline = `标称窗口不实：标称 ${claimed} tokens，但命中率随深度单调恶化（低深度 ${signals.lowStat?.hits ?? 0}/${signals.lowStat?.attempted ?? 0}，高深度 ${signals.highStats.map((s) => `${s.hits}/${s.attempted}`).join('、')}）`;
    findings.push({
      level: 'fail',
      message: `未命中档位：${missDepths.map((d) => `${d * 100}%`).join('、')}。所有高深度档命中率均低于低深度档且至少 2 档有未命中：命中概率随输入深度单调下降，与"真实窗口小于标称值"一致（也见结尾回显结果）。`,
      evidenceIds: [...missEvidenceIds],
    });
  } else if (!echoHit && signals.highMissTiersCount >= 1 && !echoInconclusive) {
    score = 10;
    level = 'fail';
    headline = `疑似静默截断：标称 ${claimed} tokens，结尾回显与高深度（75%/90%）needle 两个独立控制同时失败`;
  } else if (boundaryTruncated) {
    score = 10;
    level = 'fail';
    headline = `边界扫描确认截断：实际可用长度约 ${metrics['boundary'] ?? '?'}`;
  } else if (!echoHit && !echoInconclusive) {
    score = 50;
    level = 'warn';
    headline = '结尾回显控制失败但高深度 needle 命中，结论矛盾：可能为单次指令遵循失败，需复测';
  } else if (echoInconclusive && !signals.highMiss && !signals.lowMiss) {
    // --deep 下缺失深度不走上方的提前返回（边界扫描可能提供正证据）；但回显同样未取得时，
    // 缺失深度没有任何可读性证据，仅凭其余深度命中不足以宣称整个标称窗口通过。
    if (missingDepths.length > 0) {
      const echoReason = echoStarved ? '推理占满预算' : echoEmpty ? '空响应' : '传输/协议故障';
      findings.push({
        level: 'info',
        message: `以下深度没有有效 needle 样本（${missingDepths.map((d) => `${(d * 100).toFixed(0)}%`).join('、')}），且结尾回显因${echoReason}未取得：缺失深度无法验证可读性，不能据此给出「窗口属实」的通过结论。`,
        evidenceIds: coverageGapEvidenceIds,
      });
      return {
        id: 'context',
        status: 'insufficient',
        score: null,
        level: 'unknown',
        headline: `缺少 ${missingDepths.length} 个深度的有效样本且结尾回显未取得，无法验证标称窗口`,
        findings,
        metrics,
      };
    }
    // needle 全命中但结尾回显未取得（空响应/截断/传输故障）：结论仍成立（无截断证据），仅披露控制项缺失。
    // 存在 needle 未命中时不落本分支：否则 0.75 档 3/4 也会输出「全部命中」的 pass（标题与证据不一致，
    // 2026-10-17 调试实证）——未命中样本改走下方稀疏 miss 的 warn 通道回吐计数。
    findings.push({
      level: 'warn',
      message: echoEmpty
        ? '结尾回显返回空文本（HTTP 200，无 content）：本次上下文结论仅由 needle 命中支撑，未做端到端控制验证；空响应不代表结尾不可读。'
        : '结尾回显控制因传输/协议故障或推理截断缺失，本次上下文结论仅由 needle 命中支撑，未做端到端控制验证。',
      evidenceIds: echoCall.evidenceIds,
    });
  } else if (signals.suspectDegrade && !signals.monotoneDegrade) {
    // 形态像退化但未通过预注册的显著性门槛（单侧 Fisher 精确检验 + Bonferroni 校正，
    // α=0.01）：按「注意力衰减嫌疑」报 warn，不指控窗口不实，并把重跑方式写进结论。
    score = 55;
    level = 'warn';
    headline = `高深度命中率明显低于低深度但未达定论显著性（低深度 ${signals.lowStat?.hits ?? 0}/${signals.lowStat?.attempted ?? 0}，高深度 ${signals.highStats.map((s) => `${s.hits}/${s.attempted}`).join('、')}）：疑似注意力衰减或窗口缩水，建议 --deep 二分定位真实窗口上界`;
    findings.push({
      level: 'warn',
      message: `退化形态成立但统计证据未达预注册门槛（单侧 Fisher 精确检验 + Bonferroni 校正，α=${ALPHA}）：样本量不足以指控窗口不实，按注意力衰减/窗口缩水嫌疑处理。定论需 --deep（每档 5 样本 + 边界二分扫描的确定性证据）。`,
      evidenceIds: [...missEvidenceIds],
    });
  } else if (signals.lowMiss) {
    score = 55;
    level = 'warn';
    headline = `低深度 needle 部分未命中但结尾回显通过（25% 深度 ${signals.lowStat?.hits ?? 0}/${signals.lowStat?.attempted ?? 0}，高深度无整档零命中）：疑似注意力衰减或代理改写，未构成截断定论`;
    findings.push({
      level: 'warn',
      message: `低深度 25% 命中 ${signals.lowStat?.hits ?? 0}/${signals.lowStat?.attempted ?? 0}（非整档零命中）、无高深度整档零命中、结尾回显通过：样本量不足以指控窗口不实，按注意力衰减/代理改写处理，建议 --deep 复测。`,
      evidenceIds: [...missEvidenceIds],
    });
  } else if (signals.highMiss) {
    score = 55;
    level = 'warn';
    headline = '高深度 needle 部分未命中但结尾回显通过：疑似注意力衰减或代理改写，未构成截断定论';
  }

  // 低成本筛查档（每档 1~2 样本）不足以支撑「窗口不实」的定论：单次未命中可能只是注意力噪声。
  // 保留 fail 的只有确定性证据：显式 400 拒绝（差分验证）与 --deep 边界扫描。其余降为疑似 warn，
  // 并明确给出复测命令，避免为了省 token 而制造诬告。
  if (!ctx.cfg.deep && samplesPerDepth < 3 && level === 'fail' && !verdictFromExplicitReject && !boundaryTruncated) {
    findings.push({
      level: 'warn',
      message: `低成本筛查每档仅 ${samplesPerDepth} 个样本：单次未命中可能来自注意力噪声，不足以指控窗口不实。本次结论降为疑似，定论请用 --context-samples 3（统计档）或 --deep。`,
      evidenceIds: [...missEvidenceIds],
    });
    // 结论已降级：同批产出的 fail 级 finding 也必须降为 warn，否则报告里仍会出现「fail」字样。
    for (const finding of findings) {
      if (finding.level === 'fail') finding.level = 'warn';
    }
    score = 55;
    level = 'warn';
    headline = `初步筛查：${headline}（每档仅 ${samplesPerDepth} 样本，未达定论；请用 --context-samples 3 或 --deep 复测）`;
  }

  // 空响应占比达到 50% 且至少 2 个空响应时，任何「截断类」fail 都不可信：空响应不提供任何可读性证据，
  // 端点可能只是偶发空流。单个空响应不足以推翻其余有效样本的未命中证据。
  // 显式 400 拒绝与 --deep 边界扫描是确定性证据，不受本降级影响。
  const emptyShare = emptySamples / Math.max(1, emptySamples + validNeedleSamples);
  if (emptySamples >= 2 && emptyShare >= 0.5 && level === 'fail' && !verdictFromExplicitReject && !boundaryTruncated) {
    findings.push({
      level: 'info',
      message: `空响应占有效样本 ${(emptyShare * 100).toFixed(0)}%（${emptySamples} 个空响应 / ${validNeedleSamples} 个有效样本）：截断类失败结论证据不足，降为无法判定（空响应 ≠ 窗口不实）。`,
      evidenceIds: emptyEvidenceIds,
    });
    return {
      id: 'context',
      status: 'insufficient',
      score: null,
      level: 'unknown',
      headline: `上下文存在 ${emptySamples} 个空响应（占 ${(emptyShare * 100).toFixed(0)}%），截断类结论证据不足`,
      findings,
      metrics,
    };
  }

  // 存在推理占满预算样本时，基于「正文未命中」的 fail/warn 结论不可信
  // （无法区分「截断丢失」与「预算耗尽未作答」）→ 降为证据不足；
  // 仅依赖 HTTP 400 的显式拒绝结论不受影响（不依赖正文）。
  if ((starvedCount > 0 || echoStarved) && level !== 'pass' && !verdictFromExplicitReject) {
    findings.push({
      level: 'info',
      message: `存在 ${starvedCount + (echoStarved ? 1 : 0)} 个样本因推理占满预算未产出答案，截断/不可读类结论证据不足，本探针降为无法判定。`,
      evidenceIds: [],
    });
    return {
      id: 'context',
      status: 'insufficient',
      score: null,
      level: 'unknown',
      headline: '上下文探针因推理占满预算存在不可判定样本，截断类结论证据不足',
      findings,
      metrics,
    };
  }

  // 最少有效证据门槛（2026-10-18 真机实证）：仅 1 个有效 needle 样本（其余全为空流）时，
  // 「全部命中 pass 100」不构成标称窗口的证据——单样本既可能是偶发命中也可能只是浅档可读。
  // 显式 400 拒绝（差分验证）与 --deep 边界扫描属确定性证据，不受此门槛限制。
  if (validNeedleSamples < 2 && !verdictFromExplicitReject && !boundaryTruncated) {
    findings.push({
      level: 'info',
      message: `有效 needle 样本仅 ${validNeedleSamples} 个（其余为空响应/请求失败/推理占满预算），不足以支撑标称窗口结论，结论不出分。`,
      evidenceIds: [],
    });
    return {
      id: 'context',
      status: 'insufficient',
      score: null,
      level: 'unknown',
      headline: `有效 needle 样本不足（${validNeedleSamples} 个），无法判定标称窗口是否属实`,
      findings,
      metrics,
    };
  }

  return { id: 'context', status: 'ok', score, level, headline, findings, metrics };
}

/**
 * 差分对照样本：用一个短输入（默认 ≤1024 tokens）验证「长输入的 400 是否与长度相关」。
 * 短输入成功 → 拒绝与长度相关（可作为「标称窗口不实」证据）；短输入同样失败 →
 * 拒绝另有原因（欠费/参数/网关限制），400 样本一律降级为证据不足。
 * 阈值取绝对小尺寸而非标称值比例：标称 1M 而真实窗口 8k 时，5% 对照（50k）同样会被拒。
 * asLongSample=true 时用于「最小被拒深度」的配对复验：期望仍被拒（sizeRejected）。
 */
async function differentialSizeProbe(
  ctx: ProbeCtx,
  claimed: number,
  overrideTokens?: number,
  asLongSample = false,
): Promise<{ ok: boolean; tokens: number; error: string | null; hit: boolean; sizeRejected: boolean; evidenceIds: string[] }> {
  const tokens = overrideTokens ?? Math.min(1024, Math.max(256, Math.floor(claimed * 0.02)));
  const nonce = ctx.rng.nonce(6);
  const filler = buildFiller(ctx.rng, tokens);
  const document = `${filler}\n\n${buildNeedle(ctx.rng, nonce)}`;
  const messages: ChatMessage[] = [
    { role: 'system', content: '你将收到一份文档和问题，只依据文档回答。' },
    { role: 'user', content: `${document}\n\n${buildNeedleQuestion(nonce, 'zh')}` },
  ];
  const call = await chatWithStarveRetry(ctx, {
    probe: 'context',
    label: `size-differential control (${tokens} tokens)${asLongSample ? ' long-retest' : ''}`,
    buildRequest: (maxTokens) => ({ model: ctx.cfg.model, messages, temperature: 0, max_tokens: maxTokens }),
    budget: PROBE_BUDGETS.context,
    retryBudget: PROBE_BUDGETS.contextRetry,
  });
  const result = call.result;
  const starved = isStarved(result);
  const ok = result.ok && !starved;
  return {
    ok,
    tokens,
    error: ok ? null : starved ? '推理占满预算未作答' : (result.error ?? 'unknown'),
    hit: ok && containsNonce(result.text, nonce),
    sizeRejected: !result.ok && isSizeRejection(result),
    evidenceIds: call.evidenceIds,
  };
}

/** 边界二分单点采样：needle 放文档指定位置（'head'=文档开头 / 'tail'=文档结尾），命中 = 回复能找回该 needle 的存档口令。
 *  单位置对截断类型有盲区（2026-10-17 实证三轮）：
 *  - needle 放结尾：保留尾部型截断（丢头部、留尾部）永远保住 needle，二分永远命中、找不到边界
 *    （e2e truncate+deep 实证：boundary lo=28000 hi=32000 found=n/a）；
 *  - needle 放中部：能否落在「被丢弃区间」取决于 filler 的 chars/token 抖动——16000/24000 档
 *    时而命中时而未命中（rng 流一变检出就翻转），不是稳定证据；
 *  - 起点 needle 对保留尾部/丢头部型截断是确定性信号（头部永远先被丢弃，c/t≥1 时
 *    只要 doc 字符数超过 keepChars 必被裁掉）；终点 needle 对保留头部/丢尾部型截断同理。
 *  两个位置并行探测（每个点各一发），方向保守：命中要求两个位置都各自可读。
 */
async function boundaryShot(
  ctx: ProbeCtx,
  mid: number,
  label: string,
  pos: 'head' | 'tail',
): Promise<{ result: ChatResult; nonce: string; evidenceIds: string[] }> {
  const nonce = ctx.rng.nonce(6);
  const filler = buildFiller(ctx.rng, mid);
  const needle = buildNeedle(ctx.rng, nonce);
  const document = pos === 'head' ? `${needle}\n\n${filler}` : `${filler}\n\n${needle}`;
  const messages: ChatMessage[] = [
    { role: 'system', content: '你将收到一份文档和问题，只依据文档回答。' },
    { role: 'user', content: `${document}\n\n${buildNeedleQuestion(nonce, 'zh')}` },
  ];
  const call = await chatWithStarveRetry(ctx, {
    probe: 'context',
    label,
    buildRequest: (maxTokens) => ({ model: ctx.cfg.model, messages, temperature: 0, max_tokens: maxTokens }),
    budget: PROBE_BUDGETS.context,
    retryBudget: PROBE_BUDGETS.contextRetry,
  });
  return { result: call.result, nonce, evidenceIds: call.evidenceIds };
}

/** 边界采样的可读性结果：'read'=needle 可找回 / 'miss'=正文可用但找不回 needle / 'reject'=尺寸类 400。 */
async function readBoundaryShot(
  ctx: ProbeCtx,
  mid: number,
  label: string,
  pos: 'head' | 'tail',
): Promise<{ verdict: 'read' | 'miss' | 'reject' | 'errored' | 'starved'; evidenceIds: string[] }> {
  const shot = await boundaryShot(ctx, mid, label, pos);
  if (isStarved(shot.result)) return { verdict: 'starved', evidenceIds: shot.evidenceIds };
  if (isSizeRejection(shot.result)) return { verdict: 'reject', evidenceIds: shot.evidenceIds };
  if (!shot.result.ok) return { verdict: 'errored', evidenceIds: shot.evidenceIds };
  return { verdict: containsNonce(shot.result.text, shot.nonce) ? 'read' : 'miss', evidenceIds: shot.evidenceIds };
}

/**
 * 边界二分：从 [0, claimed] 找「开始不可读」的最小尺寸。每步同尺寸并行探测 head/tail 两个位置：
 * 两个位置都各自可读 → 该尺寸可读（lo=mid）；未读侧须同位复采 2 发（fresh nonce），
 * 三点一致 miss 才定界（双审必修项 1：防注意力衰减单样本误定罪）；任一确认命中按噪声处理。
 * 传输/协议故障破坏二分单调性前提 → 立即终止并清空结论（绝不记「开始失败」）；
 * 尺寸类 400 只用于收敛区间与披露，不入定罪链（定罪走 needle 阶段差分验证口径）。
 */
async function scanBoundary(
  ctx: ProbeCtx,
  claimed: number,
): Promise<{
  found: boolean;
  foundAtTokens: number | null;
  explicitReject: boolean;
  starvedSeen: boolean;
  erroredSeen: boolean;
  erroredCount: number;
  sizeRejectCount: number;
  detail: string;
  evidenceIds: string[];
}> {
  const evidenceIds: string[] = [];
  let lo = 0;
  let hi = claimed;
  let foundAtTokens: number | null = null;
  let explicitReject = false;
  let starvedSeen = false;
  let erroredCount = 0;
  let sizeRejectCount = 0;
  for (let step = 0; step < 3; step += 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (mid <= 0) break;
    // —— head/tail 并行探测；任一 shot 星级事件直接终止扫描 ——
    const shots: Array<{ pos: 'head' | 'tail'; verdict: 'read' | 'miss' | 'reject' | 'errored' | 'starved' }> = [];
    let abort: 'errored' | 'starved' | 'reject' | null = null;
    for (const pos of ['head', 'tail'] as const) {
      const shot = await readBoundaryShot(ctx, mid, `boundary ${pos} mid=${mid}`, pos);
      evidenceIds.push(...shot.evidenceIds);
      if (shot.verdict === 'starved' || shot.verdict === 'errored' || shot.verdict === 'reject') {
        abort = shot.verdict;
        break;
      }
      shots.push({ pos, verdict: shot.verdict });
    }
    if (abort === 'starved') {
      // 推理占满预算：该点无正文可判，二分单调性已中断；已得边界也必须作废，
      // 否则「前一步定界 + 后一步 starved」会输出未经完整二分确认的截断定论。
      starvedSeen = true;
      foundAtTokens = null;
      break;
    }
    if (abort === 'errored') {
      // 传输/协议故障（含欠费/限流等非尺寸类 4xx）：该点既不能算命中也不能算未命中，
      // 二分区间的单调性前提已被破坏 → 立即终止扫描，绝不记为「开始失败」。
      // 同时清空此前已得的 foundAtTokens：一次故障足以让整条二分结论失效。
      erroredCount += 1;
      foundAtTokens = null;
      break;
    }
    if (abort === 'reject') {
      // 尺寸类 400：只用于收敛区间与披露，与「正文未命中」不得混构定论（定罪须差分验证）。
      explicitReject = true;
      sizeRejectCount += 1;
      hi = mid;
      foundAtTokens = null;
      continue;
    }
    const unreadable = shots.filter((s) => s.verdict === 'miss');
    if (unreadable.length === 0) {
      lo = mid;
      continue;
    }
    // —— 未读侧确认链：同位再补 2 发（fresh nonce），任一命中 → 噪声（不定界）——
    let confirmed = false;
    let noiseHit = false;
    let rejectSeen = false;
    let aborted = false;
    for (const side of unreadable) {
      for (let i = 0; i < 2; i += 1) {
        const shot = await readBoundaryShot(
          ctx,
          mid,
          `boundary ${side.pos} confirm${i + 1} mid=${mid}`,
          side.pos,
        );
        evidenceIds.push(...shot.evidenceIds);
        if (shot.verdict === 'starved' || shot.verdict === 'errored' || shot.verdict === 'reject') {
          if (shot.verdict === 'starved') starvedSeen = true;
          else if (shot.verdict === 'reject') rejectSeen = true;
          else erroredCount += 1;
          aborted = true;
          break;
        }
        if (shot.verdict === 'read') {
          // 确认样本命中 → 主样本为注意力噪声，该侧未读不成立
          noiseHit = true;
          aborted = true;
          break;
        }
      }
      if (aborted) break;
      // 该侧三点一致 miss → 同尺寸不可读成立
      confirmed = true;
    }
    if (aborted) {
      if (erroredCount > 0) {
        // 确认链遇传输/协议故障：单调性前提被破坏——清空并终止，不定罪。
        foundAtTokens = null;
        break;
      }
      if (starvedSeen) {
        // 确认链遇推理占满预算：同样无完整二分证据，已得边界作废。
        foundAtTokens = null;
        break;
      }
      if (noiseHit) {
        // 噪声命中 → 该尺寸其实可读，区间上移
        lo = mid;
      } else if (rejectSeen) {
        // 确认样本尺寸类 400：不确定事件，只收敛区间、不定界（须差分验证的拒绝走 needle 阶段口径）
        hi = mid;
        foundAtTokens = null;
      }
      continue;
    }
    if (confirmed) {
      hi = mid;
      foundAtTokens = mid;
    } else {
      lo = mid;
    }
  }
  if (sizeRejectCount > 0) explicitReject = true;
  const found = erroredCount === 0 && foundAtTokens !== null && foundAtTokens <= claimed * 0.9;
  return {
    found,
    foundAtTokens,
    explicitReject,
    starvedSeen,
    erroredSeen: erroredCount > 0,
    erroredCount,
    sizeRejectCount,
    detail: `lo=${lo} hi=${hi} found=${foundAtTokens ?? 'n/a'} explicitReject=${explicitReject} starved=${starvedSeen} errored=${erroredCount} sizeReject=${sizeRejectCount}`,
    evidenceIds,
  };
}

function containsNonce(text: string, nonce: string): boolean {
  return text.toUpperCase().includes(nonce.toUpperCase());
}

function preview(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
}
