import { basename } from 'node:path';
import type { ChatMessage, Finding, Level, ProbeCtx, ProbeOutcome, RunConfig } from '../types.js';
import { computeCostUsd, type ModelPrice } from '../gateway/pricing.js';
import { estimateMessageTokens } from '../tokens.js';
import { linearRegression, mean } from '../stats.js';
import { failureDigest } from '../diagnostics.js';
import { recordCall } from '../evidence.js';
import { probeBalance, spendBetween, type BalanceReading } from '../balance.js';
import { decideTokenReference, type TokenReferenceDecision } from '../token-reference.js';
import { PROBESET_VERSION } from '../assets.js';

const FILLER_EN =
  'The quick brown fox jumps over the lazy dog while engineers keep measuring latency and correctness in production systems. ';

/** billing 请求的 max_tokens：completion_tokens 超过该值即为与请求上限矛盾的硬异常。 */
const BILLING_MAX_TOKENS = 16;

/**
 * 仅形状证据（线性 + 一致性 + 输出侧核验通过，无绝对对账）时的通过分：
 * 与绝对对账成立的 100 区分，如实反映「等比缩放/常量偏移未被排除」的剩余不确定性；
 * 判定对象是端点自报 usage，形状全过即给出「未发现造假证据」的明确结论（2026-10-19 用户口径），
 * 不得因缺绝对对账悬置为 insufficient。
 */
const SHAPE_ONLY_SCORE = 85;

function resolveClaimedPrice(cfg: RunConfig): { price: ModelPrice | null; error: string | null } {
  const input = cfg.priceInput;
  const output = cfg.priceOutput;
  const optional = [cfg.priceCachedRead, cfg.priceThreshold, cfg.priceInput2, cfg.priceOutput2, cfg.priceCachedRead2];
  if (input == null && output == null) {
    return optional.some((value) => value != null)
      ? { price: null, error: '缓存读价与阶梯价必须配合输入/输出价使用' }
      : { price: null, error: null };
  }
  if (input == null || output == null) return { price: null, error: '输入价与输出价必须成对提供' };
  if (!Number.isFinite(input) || !Number.isFinite(output) || input <= 0 || output <= 0) {
    return { price: null, error: '输入价与输出价必须为大于 0 的有限数字' };
  }
  const price: ModelPrice = { input, output };
  if (cfg.priceCachedRead != null) {
    if (!Number.isFinite(cfg.priceCachedRead) || cfg.priceCachedRead < 0) {
      return { price: null, error: '缓存读价必须为不小于 0 的有限数字' };
    }
    price.cachedRead = cfg.priceCachedRead;
  }
  const tier = [cfg.priceThreshold, cfg.priceInput2, cfg.priceOutput2];
  const tierCount = tier.filter((value) => value != null).length;
  if (tierCount > 0 && tierCount < 3) {
    return { price: null, error: '阶梯阈值、二档输入价、二档输出价必须同时提供' };
  }
  if (cfg.priceCachedRead2 != null && tierCount === 0) {
    return { price: null, error: '二档缓存读价仅在提供阶梯价时可用' };
  }
  if (tierCount === 3) {
    const threshold = cfg.priceThreshold as number;
    const input2 = cfg.priceInput2 as number;
    const output2 = cfg.priceOutput2 as number;
    if (!Number.isSafeInteger(threshold) || threshold <= 0) {
      return { price: null, error: '阶梯阈值必须为正整数 tokens' };
    }
    if (!Number.isFinite(input2) || input2 <= 0 || !Number.isFinite(output2) || output2 <= 0) {
      return { price: null, error: '二档输入价与二档输出价必须为大于 0 的有限数字' };
    }
    if (cfg.priceCachedRead2 != null && (!Number.isFinite(cfg.priceCachedRead2) || cfg.priceCachedRead2 < 0)) {
      return { price: null, error: '二档缓存读价必须为不小于 0 的有限数字' };
    }
    price.threshold = threshold;
    price.input2 = input2;
    price.output2 = output2;
    if (cfg.priceCachedRead2 != null) price.cachedRead2 = cfg.priceCachedRead2;
  }
  return { price, error: null };
}

export async function probeBilling(ctx: ProbeCtx): Promise<ProbeOutcome> {
  const findings: Finding[] = [];
  const metrics: Record<string, number | string | null> = {};
  // 默认 5 个长度点（2k/4k/8k/16k/24k）：3 点（2k/8k/24k）虽然便宜约 40%，但中间档异常可完美落在
  // 三点直线上（真机与 mock 均复现），会把「采样点之间非线性」误报为线性正常；可靠性优先于省这点 token。
  // --deep 保留 6 档，用于需要更细回归曲线的定论场景。测试可经 billingLevels 指定自定义档位。
  const levels = ctx.cfg.billingLevels ?? (ctx.cfg.deep ? [2000, 4000, 8000, 16000, 24000, 32000] : [2000, 4000, 8000, 16000, 24000]);
  const langs: Array<'en' | 'zh'> = ['en', 'zh'];

  // 探针内自检价格有效性：不依赖 cli 入口校验（库调用方可绕过 cli）
  const claimed = resolveClaimedPrice(ctx.cfg);
  const priceEnabled = claimed.price !== null;
  const price = claimed.price;
  if (claimed.error !== null) {
    findings.push({ level: 'warn', message: `计费核价配置无效：${claimed.error}。本次不计算实测倍率。`, evidenceIds: [] });
  }
  let expectedCost = 0;
  let ratioSamples = 0;
  // 第一个计费请求之前查 balanceBefore（余额查询不是 chat 调用，不记 evidence）
  const balanceBefore: BalanceReading | null = priceEnabled
    ? await probeBalance(ctx.client.baseUrl, ctx.cfg.apiKey, ctx.cfg.timeoutMs)
    : null;

  interface Track {
    lang: 'en' | 'zh';
    xs: number[];
    ys: number[];
    raws: number[];
    /** 参与回归的样本证据 id（fail 级 finding 必须能回溯原始请求，兑现「每条 finding 链接证据」承诺） */
    evidenceIds: string[];
  }
  const tracks: Track[] = langs.map((lang) => ({ lang, xs: [], ys: [], raws: [], evidenceIds: [] }));
  const allResponses: number[] = [];
  /** token-reference 对比用：通过 usage 校验样本的逐档 prompt_tokens（key `${lang}_${level}`） */
  const refPairs: Record<string, number> = {};
  /** 全部通过 usage 校验的样本证据 id（constantUsage 判定的证据面） */
  const validEvidenceIds: string[] = [];
  /** 失败请求的证据 id（部分失败 finding 的证据面） */
  const failureEvidenceIds: string[] = [];
  let usageMissing = 0;
  let usageInconsistent = 0;
  let usageInvalid = 0;
  let requests = 0;
  // usage details 明细（增值观测，不参与回归与评分）：缓存/推理 token 拆分与上报样本数
  let cachedTokensTotal = 0;
  let reasoningTokensTotal = 0;
  let detailsReported = 0;
  const failures: string[] = [];
  /** 失败请求的原始错误串（供 insufficient 标题归因；failures 带 lang@target 前缀不便分类） */
  const failureErrors: string[] = [];
  /** completion_tokens 与响应正文/请求上限矛盾（prompt 回归无法发现输出侧伪造） */
  let completionZeroWithText = 0;
  let completionOverCap = 0;
  const completionAnomalyEvidenceIds: string[] = [];
  /** 窗口内发生重试的请求（attempts>1，含纯 429/503 网关拒绝后的干净重试）：仅作观测，不单独定罪 */
  let retriedRequests = 0;
  const retryEvidenceIds: string[] = [];
  /**
   * 可能造成重复计费的重试（contaminatingRetry）：200 空正文 / 408/409/500/502/504 / 超时 /
   * 网络错误之后才重试 → 上游可能已对某次尝试计费。429/503（网关层拒绝、未进入推理）后的
   * 重试不计入——它们没有产出，重复请求不重复扣费。
   */
  let contaminatingRetries = 0;
  const contaminatingEvidenceIds: string[] = [];

  for (const lang of langs) {
    for (const targetTokens of levels) {
      const track = tracks.find((t) => t.lang === lang) as Track;
      const nonce = ctx.rng.nonce(5);
      const body =
        lang === 'en'
          ? buildEnglish(targetTokens)
          : buildChinese(targetTokens);
      const prompt = `请逐字复述下面这段文本，不要添加任何其他内容。\n\n${body}\n\n（本段校验编号 ${nonce}）`;
      const messages: ChatMessage[] = [{ role: 'user', content: prompt }];
      const result = await ctx.client.chat({
        model: ctx.cfg.model,
        messages,
        temperature: 0,
        max_tokens: BILLING_MAX_TOKENS,
        // 200 空响应仍带 usage：重发只会重复计 prompt 并令实测倍率 N/A，故不在 client 层重试空正文；
        // HTTP 5xx/429 等状态错误仍按 --retries 正常重试。
        retryEmpty: false,
      });
      const evidence = recordCall(ctx.evidence, {
        probe: 'billing',
        label: `billing ${lang} target=${targetTokens}`,
        request: { model: ctx.cfg.model, stream: false, temperature: 0, maxTokens: 16, messages },
        result,
      });
      requests += 1;
      // 重试观测（attempts>1，全窗口如实计数）与污染口径（contaminatingRetry，仅「可能已
      // 计费」的重试：200 空正文 / 408/409/500/502/504 / 超时后重试；429/503 网关拒绝后的
      // 重试无产出不污染）分开统计。
      if (result.attempts > 1) {
        retriedRequests += 1;
        retryEvidenceIds.push(evidence.id);
      }
      if (result.contaminatingRetry === true) {
        contaminatingRetries += 1;
        contaminatingEvidenceIds.push(evidence.id);
      }
      if (!result.ok) {
        failures.push(`${lang}@${targetTokens}: ${result.error ?? 'error'}`);
        failureErrors.push(result.error ?? 'error');
        failureEvidenceIds.push(evidence.id);
        continue;
      }
      if (!result.usage) {
        usageMissing += 1;
        if (result.usageRejected === 'inconsistent') {
          usageInconsistent += 1;
          findings.push({
            level: 'warn',
            message: `端点自报 total_tokens 与 prompt+completion 不一致（第 ${requests} 笔），疑似计费字段篡改，样本已剔除。`,
            evidenceIds: [evidence.id],
          });
        } else if (result.usageRejected === 'negative') {
          usageInvalid += 1;
          findings.push({
            level: 'warn',
            message: `端点返回负 token 数（第 ${requests} 笔），样本已剔除。`,
            evidenceIds: [evidence.id],
          });
        } else {
          findings.push({
            level: 'warn',
            message: `请求（${lang}，目标 ${targetTokens} tokens）未返回 usage，无法参与回归。`,
            evidenceIds: [evidence.id],
          });
        }
        continue;
      }
      // 输出侧硬矛盾检查：prompt 回归只看输入，completion_tokens 完全可能被独立伪造。
      // 非空正文却报 0，或上报值超过请求的 max_tokens，都是与可观测事实直接冲突的硬异常。
      const completion = result.usage.completion_tokens;
      if (completion === 0 && result.text.trim().length > 0) {
        completionZeroWithText += 1;
        completionAnomalyEvidenceIds.push(evidence.id);
      }
      if (completion > BILLING_MAX_TOKENS) {
        completionOverCap += 1;
        completionAnomalyEvidenceIds.push(evidence.id);
      }
      // 浮点累加误差分析：本处求和至多 n=12 项（deep 档 12 笔计费请求），
      // IEEE754 双精度求和的相对误差上界 ≈ n·2⁻⁵³ ≈ 1.3e-15，
      // 与倍率判定阈值（0.5/0.8/1.1/1.5；相邻最小间隔 0.3）相差 14+ 个数量级，可忽略；
      // 故不需要定点整数化或 Kahan 求和。
      if (priceEnabled) {
        expectedCost += computeCostUsd(result.usage, price as ModelPrice);
        ratioSamples += 1;
      }
      const estimated = estimateMessageTokens(messages);
      track.xs.push(estimated);
      track.ys.push(result.usage.prompt_tokens);
      track.raws.push(result.usage.prompt_tokens);
      track.evidenceIds.push(evidence.id);
      validEvidenceIds.push(evidence.id);
      allResponses.push(result.usage.prompt_tokens);
      metrics[`prompt_tokens_${lang}_${targetTokens}`] = result.usage.prompt_tokens;
      refPairs[`${lang}_${targetTokens}`] = result.usage.prompt_tokens;
      // details 明细累计：仅统计通过校验的样本；!= null 判定保证 cached=0 也计数
      if (result.usage.cached_tokens != null) cachedTokensTotal += result.usage.cached_tokens;
      if (result.usage.reasoning_tokens != null) reasoningTokensTotal += result.usage.reasoning_tokens;
      if (result.usage.cached_tokens != null || result.usage.reasoning_tokens != null) detailsReported += 1;
    }
  }

  // 序列结束后查 balanceAfter
  const balanceAfter: BalanceReading | null = priceEnabled
    ? await probeBalance(ctx.client.baseUrl, ctx.cfg.apiKey, ctx.cfg.timeoutMs)
    : null;
  const spendDelta = balanceBefore !== null && balanceAfter !== null ? spendBetween(balanceBefore, balanceAfter) : null;
  if (priceEnabled) {
    const reading = balanceBefore ?? balanceAfter;
    metrics['price_input'] = price?.input ?? null;
    metrics['price_output'] = price?.output ?? null;
    metrics['price_cached_read'] = price?.cachedRead ?? null;
    metrics['price_threshold'] = price?.threshold ?? null;
    metrics['price_input2'] = price?.input2 ?? null;
    metrics['price_output2'] = price?.output2 ?? null;
    metrics['price_cached_read2'] = price?.cachedRead2 ?? null;
    metrics['balance_endpoint'] = reading ? reading.endpoint : null;
    metrics['balance_unit'] = reading ? reading.unit : null;
    metrics['balance_resolution'] = reading && Number.isFinite(reading.resolution) ? (reading.resolution as number) : null;
    metrics['balance_before'] = balanceBefore ? balanceBefore.value : null;
    metrics['balance_after'] = balanceAfter ? balanceAfter.value : null;
    metrics['spend_delta'] = spendDelta;
    metrics['expected_cost'] = round(expectedCost);
    metrics['ratio_samples'] = ratioSamples;
    metrics['ratio_dropped'] = usageMissing;
  }

  const constantUsage = allResponses.length >= 3 && new Set(allResponses).size === 1;
  // 回归是否真正运行过：合计样本 ≥3 但每条轨道都 <3 时，回归循环会整体跳过（track.xs.length<3 continue），
  // 若不设此门槛会把「零回归证据」误报成 100/pass（线性正常）。constantUsage 分支不受影响（其本身即判据）。
  // 两条轨道都必须 ≥3 个有效样本：只验证 en 轨道就宣称「线性正常」会漏掉中文
  // tokenizer/计数差异（2026-10-18 真机：zh 轨道仅剩 2 个有效样本时曾可出 pass 100）。
  const regressionRan = tracks.every((t) => t.xs.length >= 3);
  metrics['requests'] = requests;
  metrics['usage_missing'] = usageMissing;
  metrics['usage_inconsistent'] = usageInconsistent;
  metrics['usage_invalid'] = usageInvalid;
  metrics['constant_usage'] = constantUsage ? 1 : 0;
  // 缓存/推理明细拆分（对账用：后台可能对缓存输入折价计费）；上游未上报时为 0，reported=0 即全未上报
  metrics['cached_tokens_total'] = cachedTokensTotal;
  metrics['reasoning_tokens_total'] = reasoningTokensTotal;
  metrics['details_reported_count'] = detailsReported;
  metrics['completion_zero_with_text'] = completionZeroWithText;
  metrics['completion_over_cap'] = completionOverCap;
  metrics['retried_requests'] = retriedRequests;
  metrics['contaminating_retries'] = contaminatingRetries;

  const defaultHeadline = 'Token 计数与长度线性关系正常';
  let score = 100;
  let level: ProbeOutcome['level'] = 'pass';
  let headline = defaultHeadline;

  if (failures.length > 0) {
    // 请求失败不是「计费正常」：回归可能仍靠剩余样本运行，但样本面已有缺口，
    // 不能给 pass 100（否则报表会出现 PASS + 部分失败 warn 的自相矛盾）。
    findings.push({ level: 'warn', message: `部分计费探针请求失败：${failures.slice(0, 4).join('；')}`, evidenceIds: failureEvidenceIds });
    score = Math.min(score, 70);
    level = escalate(level, 'warn');
    headline = `部分计费探针请求失败（${failures.length} 笔），计费样本不完整`;
  }

  if (completionZeroWithText + completionOverCap > 0) {
    const parts: string[] = [];
    if (completionZeroWithText > 0) parts.push(`${completionZeroWithText} 笔返回非空正文但 completion_tokens=0`);
    if (completionOverCap > 0) parts.push(`${completionOverCap} 笔 completion_tokens 超过请求上限 ${BILLING_MAX_TOKENS}`);
    findings.push({
      level: 'warn',
      message: `输出侧计费异常：${parts.join('；')}。prompt 回归无法覆盖输出计数，completion_tokens 与可观测事实矛盾，计费数据不可信。`,
      evidenceIds: [...completionAnomalyEvidenceIds],
    });
    score = Math.min(score, 70);
    level = escalate(level, 'warn');
    if (level !== 'fail') headline = 'completion_tokens 与响应正文/请求上限矛盾，输出侧计费异常';
  }

  if (contaminatingRetries > 0) {
    // 仅统计「可能重复计费」的重试：429/503 网关拒绝后的重试没有产出，不构成重复计费风险。
    findings.push({
      level: 'warn',
      message: `审计窗口内有 ${contaminatingRetries} 笔请求在「可能已计费的尝试」之后重试（200 空正文/408/409/500/502/504/超时后重试）；上游可能对多次尝试重复计费，计费样本不能判定为正常。`,
      evidenceIds: [...contaminatingEvidenceIds],
    });
    score = Math.min(score, 70);
    level = escalate(level, 'warn');
    if (level !== 'fail' && headline === defaultHeadline) {
      headline = `审计窗口内存在可能重复计费的重试（${contaminatingRetries} 笔），计费口径不干净`;
    }
  }

  if (usageMissing > 0 && usageMissing < Math.ceil(requests / 2)) {
    findings.push({
      level: 'warn',
      message: `${usageMissing}/${requests} 笔请求缺少 usage，样本不完整；仅凭剩余样本无法给出「计费正常」结论。`,
      evidenceIds: [],
    });
    score = Math.min(score, 70);
    level = escalate(level, 'warn');
    if (level !== 'fail' && headline === defaultHeadline) headline = `部分请求缺少 usage（${usageMissing}/${requests}），计费样本不完整`;
  }

  if (constantUsage) {
    score = 0;
    level = 'fail';
    headline = 'usage 恒定不变：对任意长度的输入返回同一个 token 计数，计费数据不可信';
    findings.push({ level: 'fail', message: '端点对 3+ 个不同长度的请求返回完全相同的 prompt_tokens，这是伪造计费的直接证据。', evidenceIds: [...validEvidenceIds] });
  } else {
    for (const track of tracks) {
      if (track.xs.length < 3) continue;
      const reg = linearRegression(track.xs, track.ys);
      metrics[`slope_${track.lang}`] = round(reg.slope);
      metrics[`r2_${track.lang}`] = round(reg.r2);
      metrics[`intercept_${track.lang}`] = round(reg.intercept);
      if (reg.r2 < 0.9) {
        score = Math.min(score, 40);
        // 与 slope 分支同级定级：R²<0.9 意味着计数严重偏离线性，属 fail 证据；
        // 只 push fail finding 却停在 warn 会让报表出现「FAIL 徽标 + 可疑判定」的自相矛盾。
        level = escalate(level, 'fail');
        headline = `usage 与输入长度非线性（${track.lang} R²=${round(reg.r2)}），存在异常`;
        findings.push({
          level: 'fail',
          message: `${track.lang} 轨道回归 R²=${round(reg.r2)}（<0.9）：token 计数不随输入长度稳定增长，疑似计数造假或按请求硬编码。`,
          evidenceIds: [...track.evidenceIds],
        });
      } else if (reg.r2 < 0.98) {
        // 3 点回归的 R² 对单点 tokenizer 差异/缓存命中很敏感；0.9~0.98 只报疑似，
        // 不把「线性度略低」直接定性为造假（2026-10-18 真机 R²=0.962 误报复盘）。
        score = Math.min(score, 55);
        level = escalate(level, 'warn');
        if (level !== 'fail') {
          headline = `token 计数线性度偏低（${track.lang} R²=${round(reg.r2)}），疑似计数异常，建议复测`;
        }
        findings.push({
          level: 'warn',
          message: `${track.lang} 轨道回归 R²=${round(reg.r2)}（0.9~0.98）：线性度偏低，可能来自 tokenizer 差异或缓存命中；不足以判定「计数造假」，建议用 --deep 或 --token-reference 复测。`,
          evidenceIds: [...track.evidenceIds],
        });
      }
      const ratio = reg.slope;
      if (ratio < 0.05 || ratio > 1.6) {
        score = Math.min(score, 30);
        level = escalate(level, 'fail');
        headline = `usage 斜率异常（${track.lang} slope=${round(ratio)}）`;
        findings.push({
          level: 'fail',
          message: `${track.lang} 轨道斜率 ${round(ratio)} tokens/估算token，超出合理区间 [0.05, 1.6]，疑似虚增或压缩计费。`,
          evidenceIds: [...track.evidenceIds],
        });
      }
    }
    const enTrack = tracks.find((t) => t.lang === 'en') as Track;
    const zhTrack = tracks.find((t) => t.lang === 'zh') as Track;
    if (enTrack.xs.length >= 3 && zhTrack.xs.length >= 3) {
      const enRatio = linearRegression(enTrack.xs, enTrack.ys).slope;
      const zhRatio = linearRegression(zhTrack.xs, zhTrack.ys).slope;
      // en 斜率非正时 Math.max 兜底会制造天文数字比值，属噪声而非证据：记 N/A 不参与判定
      metrics['zh_en_slope_ratio'] = enRatio > 0 ? round(zhRatio / enRatio) : 'N/A';
      if (enRatio > 0 && zhRatio / enRatio > 2.5) {
        findings.push({ level: 'warn', message: '中文轨道计费斜率异常高于英文轨道，可能存在按字符数而非 token 计费的伪装。', evidenceIds: [] });
        score = Math.min(score, 55);
        level = escalate(level, 'warn');
        if (level === 'warn') {
          headline = `中文轨道计量斜率异常高于英文轨道（×${round(zhRatio / enRatio)}），疑似按字符而非 token 计费`;
        }
      }
    }
  }

  // token-reference 判定：与同名模型历史报告的逐档 prompt_tokens 对比——
  // 全量等比虚增（usage-scale）在线性回归/常量检测面前不可见（形状不变），只有跨审计绝对计数对比能识别。
  // 该块先于 insufficient-return 路径执行是安全的：样本不足时 decide 自然 skip（summary 记录可比档数）。
  let referenceDecision: TokenReferenceDecision | null = null;
  const refCfg = ctx.cfg.tokenReference ?? null;
  if (refCfg) {
    referenceDecision = decideTokenReference(refCfg, refPairs, {
      model: ctx.cfg.model,
      probesetVersion: PROBESET_VERSION,
    });
    metrics['reference_source'] = `${basename(refCfg.sourceFile)} | ${refCfg.model} | ${refCfg.startedAt}`;
    for (const lang of ['en', 'zh']) {
      const langSummary = referenceDecision.summary[lang];
      metrics[`reference_ratio_max_${lang}`] = langSummary && langSummary.levels > 0 ? round(langSummary.max) : 'N/A';
      metrics[`reference_ratio_median_${lang}`] = langSummary && langSummary.levels > 0 ? round(langSummary.median) : 'N/A';
    }
    if (referenceDecision.finding) findings.push(referenceDecision.finding);
    if (referenceDecision.cap !== null) {
      score = Math.min(score, referenceDecision.cap);
      if (referenceDecision.verdict === 'fail') {
        level = escalate(level, 'fail');
        headline = `token 计数与参考报告系统偏离（最高 ×${referenceDecision.maxRatio}）`;
      } else if (referenceDecision.verdict === 'warn') {
        level = escalate(level, 'warn');
        if (headline === defaultHeadline) {
          headline = `token 计数与参考报告偏离（最高 ×${referenceDecision.maxRatio}）`;
        }
      }
    }
  }

  // 实测倍率判定：以回归分析后的 level 为准（回归失败时 usage 不可信，判定语义不同）
  const regressionLevel = level;
  // 污染闸（decideRatio 之前）：审计窗口内任一请求尝试次数 >1（服务端可能对多次尝试重复计费），
  // 或存在失败请求（其提示 token 可能已被计费但 usage 未知，expectedCost 分母不完整），
  // Δspend 都不再对应「本次应缴金额」，此时绝不能采信 ratio —— 直接手写 N/A，不调用 decideRatio。
  const contaminationReasons: string[] = [];
  if (contaminatingRetries > 0) {
    contaminationReasons.push(`审计窗口内有 ${contaminatingRetries} 笔请求在「可能已计费的尝试」后重试（服务端可能对多次尝试重复计费）`);
  }
  if (failures.length > 0) {
    contaminationReasons.push(`审计窗口内存在 ${failures.length} 笔失败请求（提示 token 可能已被计费但 usage 未知，应缴金额分母不完整）`);
  }
  let ratioDecision: RatioDecision | null;
  if (priceEnabled && contaminationReasons.length > 0) {
    metrics['ratio_contaminated'] = 1;
    ratioDecision = {
      verdict: 'N/A',
      maskedVerdict: null,
      cap: null,
      ratio: null,
      finding: {
        level: 'info',
        message: `实测倍率判定作废：${contaminationReasons.join('；')}。`,
        evidenceIds: [],
      },
    };
  } else {
    ratioDecision = priceEnabled
      ? decideRatio({
          before: balanceBefore,
          after: balanceAfter,
          spendDelta,
          expectedCost,
          ratioDropped: usageMissing,
          regressionLevel,
        })
      : null;
  }
  if (priceEnabled) {
    metrics['measured_ratio'] = ratioDecision && ratioDecision.ratio !== null ? round(ratioDecision.ratio) : 'N/A';
    metrics['ratio_masked_verdict'] = ratioDecision ? ratioDecision.maskedVerdict : null;
  }

  if (usageMissing >= Math.ceil(requests / 2) && requests > 0) {
    score = 0;
    level = 'fail';
    headline = '多数请求不返回 usage，计费不可核验';
    findings.push({ level: 'fail', message: `全部 ${requests} 次请求中 ${usageMissing} 次缺少 usage 字段。`, evidenceIds: [] });
  } else if (allResponses.length < 3 || (!regressionRan && !constantUsage)) {
    // status=insufficient（score=null）：倍率只出独立 finding，不碰 score/status/level
    if (ratioDecision) findings.push(ratioDecision.finding);
    // 归因：失败是主因时说清是谁的问题（端点拒绝/鉴权/网络），不让用户猜
    const failureDigestText = failureDigest(failureErrors, requests);
    return {
      id: 'billing',
      status: 'insufficient',
      score: null,
      level: 'unknown',
      headline: failureDigestText !== null
        ? `计费探针有效样本不足，无法运行回归；主因：${failureDigestText}`
        : '计费探针有效样本不足（单轨道样本 <3），无法运行回归',
      findings,
      metrics,
    };
  }

  if (ratioDecision) {
    findings.push(ratioDecision.finding);
    const applied = applyRatioDecision(score, level, ratioDecision);
    score = applied.score ?? score;
    level = applied.level;
    // 倍率判定可能把 level 拉到 fail/warn，但 headline 仍停在「线性正常」——必须同步，否则
    // 报表会出现「FAIL 30 + 标题说正常」的自相矛盾（2026-10-18 实测）。
    if (ratioDecision.finding.level === 'fail' || (ratioDecision.finding.level === 'warn' && level === 'warn')) {
      const ratioText = ratioHeadline(ratioDecision, regressionLevel);
      if (ratioText !== null) headline = ratioText;
    }
  }

  const cleanWindow =
    failures.length === 0 &&
    usageMissing === 0 &&
    contaminatingRetries === 0;
  const referenceVerified = referenceDecision?.verdict === 'ok' && cleanWindow;
  const ratioVerified =
    priceEnabled &&
    ratioDecision !== null &&
    ratioDecision.verdict === 'ok' &&
    ratioDecision.maskedVerdict === null &&
    ratioDecision.ratio !== null &&
    ratioDecision.ratio >= 0.8 &&
    ratioDecision.ratio <= 1.1 &&
    cleanWindow &&
    regressionLevel !== 'fail';
  const absoluteVerified = referenceVerified || ratioVerified;
  metrics['reference_verified'] = referenceVerified ? 1 : 0;
  metrics['ratio_verified'] = ratioVerified ? 1 : 0;
  metrics['absolute_reconciliation'] = absoluteVerified ? 1 : 0;
  metrics['evidence_level'] = absoluteVerified ? 'absolute' : 'shape-only';

  if (level === 'pass' && !absoluteVerified) {
    // billing 的核验对象是端点自报 usage：形状（线性）、内部一致性（total=prompt+completion、
    // 非负值）、输出侧（completion 与正文/上限）与恒定检测全部通过，即给出「usage 未发现造假
    // 证据」的明确判定，不因缺绝对对账悬置（2026-10-19 用户口径：本维度只验证 usage）。
    // 证据分级仍如实透出：score 85 < 绝对对账的 100，headline 与 info finding 说明
    // 「扣费金额真实性未验证」——×1.3 全量等比缩放或常量偏移只有 --token-reference /
    // 价格+余额对账能识别。
    findings.push({
      level: 'info',
      message:
        '本轮已核验端点自报 usage 与输入长度线性、内部一致且输出侧无矛盾，未发现造假证据；' +
        '未做绝对对账，扣费金额真实性未验证——全量等比缩放（如 ×1.3）或常量偏移在回归中不可见。' +
        '如需绝对对账：提供 --token-reference（同名模型历史报告），或同时提供宣称价格并确保余额端点可用。',
      evidenceIds: [],
    });
    score = Math.min(score, SHAPE_ONLY_SCORE);
    headline = 'usage 计数核验通过，未发现造假证据（未做绝对对账，扣费金额真实性未验证）';
  } else if (level === 'pass') {
    findings.push({
      level: 'info',
      message: `token 估计为保守估算（非精确 tokenizer）；本轮已通过${referenceVerified ? '参考报告逐档计数' : '价格+余额实测倍率'}做绝对对账，回归仅用于形状核验。`,
      evidenceIds: [],
    });
    headline = referenceVerified
      ? 'Token 计数与长度线性关系正常，且与参考报告一致'
      : 'Token 计数与长度线性关系正常，实测倍率与宣称价格一致';
  }
  return { id: 'billing', status: 'ok', score, level, headline, findings, metrics };
}

function buildEnglish(tokens: number): string {
  return FILLER_EN.repeat(Math.max(1, Math.ceil((tokens * 4) / FILLER_EN.length)));
}

function buildChinese(tokens: number): string {
  const unit = '工程实践中必须以测量结果为准绳，而不是依赖直觉或者厂商的自我声明，只有可复现的证据链条才能支撑可靠的结论。';
  return unit.repeat(Math.max(1, Math.ceil(tokens / unit.length)));
}

function round(value: number): number {
  // 大数/非有限直通守卫：Math.round(1e308*1000) 会溢出为 Infinity，把本可读出的量级「洗成」Infinity；
  // 调用方（decideRatio/回归）已各有有限性守卫，此处只负责保真展示。
  if (!Number.isFinite(value)) return value;
  if (Math.abs(value) >= 1e12) return value;
  return Math.round(value * 1000) / 1000;
}

const LEVEL_RANK = { unknown: 0, pass: 1, warn: 2, fail: 3 } as const;

function escalate(current: ProbeOutcome['level'], next: ProbeOutcome['level']): ProbeOutcome['level'] {
  return LEVEL_RANK[next] > LEVEL_RANK[current] ? next : current;
}

export interface RatioArgs {
  before: BalanceReading | null;
  after: BalanceReading | null;
  spendDelta: number | null;
  expectedCost: number;
  ratioDropped: number;
  regressionLevel: Level;
}

export interface RatioDecision {
  verdict: 'N/A' | 'ok' | 'warn' | 'fail';
  /**
   * 保守降级掩蔽掉的底层判定档位：仅 ratioDropped>0 且按「无缺失」重算出 warn/fail 时非 null。
   * 仅供 CI/报告观测（metrics['ratio_masked_verdict']），不参与合分——
   * 缺失使分母偏小、该判定上偏，直接采信会冤枉端点。
   */
  maskedVerdict: 'fail' | 'warn' | null;
  cap: number | null;
  finding: Finding;
  ratio: number | null;
}

/**
 * 实测倍率（余额差值法）判定矩阵，纯函数便于单测。
 * 判定基于「本次扣费 Δspend ÷ 按宣称价格与端点自报 usage 估算的应缴金额 expectedCost」。
 */
export function decideRatio(args: RatioArgs): RatioDecision | null {
  const { before, after, spendDelta, expectedCost, ratioDropped, regressionLevel } = args;
  // 证据不足一律 N/A + info，不加罚
  if (before === null || after === null) {
    return na('余额端点不可用或返回未知 schema（如 /dashboard/billing/usage 的 total_usage 非整数美分）：无法建立可比余额读数，实测倍率无法验证（中转站可通过禁用/改写余额接口规避此项，建议在其后台人工核对）。');
  }
  if (spendDelta === null) {
    return na('两次余额查询不同源（endpoint/kind/unit 不一致，可能被路由到不同后端），无法作差计算实测倍率。');
  }
  if (before.unit !== 'USD' || after.unit !== 'USD') {
    // 非美元口径（如 one-api 的 quota）：expectedCost 按宣称价格折算为美元，quota 差值与美元直接作比
    // 会产出天文/荒谬倍率（quota 粒度通常 1 单位 ≪ 1 USD），必须整体作废而非出 warn。
    return na(
      `余额读数单位为 ${before.unit === after.unit ? before.unit : `${before.unit}/${after.unit}`}（非美元口径），` +
        '无法与按宣称价格折算的美元应缴金额直接作比（工具不换算单位），实测倍率判定作废。',
    );
  }
  if (spendDelta === 0) {
    return na('审计窗口内余额差值 Δ=0：余额粒度不足或消费延迟入账，实测倍率无法计算。');
  }
  if (spendDelta < 0) {
    return na(`审计窗口内余额不降反升（Δ=${round(spendDelta)}）：疑有充值干扰，实测倍率判定作废。`);
  }
  const resolution = Math.max(
    Number.isFinite(before.resolution) ? (before.resolution as number) : 0,
    Number.isFinite(after.resolution) ? (after.resolution as number) : 0,
  );
  if (resolution > 0 && spendDelta < 3 * resolution) {
    // 精度噪声门：Δ 只有零点几个最小刻度时，无法区分「真实小额扣费」与「读数舍入噪声」，
    // 采信会产生离谱倍率（Δ=0.01/res=0.01 → ratio 任意大），必须 N/A。
    return na(
      `审计窗口内余额差值 Δ=${round(spendDelta)} 低于余额读数最小分辨率（${round(resolution)}）的 3 倍，` +
        '无法区分真实扣费与读数精度噪声，实测倍率无法判定（可增大审计窗口或改用 token-reference 对账）。',
    );
  }
  if (expectedCost <= 0) {
    return na('无有效 usage 记录，无法估算应缴金额，实测倍率无法计算。');
  }
  if (resolution > 0 && expectedCost < 3 * resolution) {
    // 应缴金额本身低于 3 个最小刻度时，余额 Δ 的舍入噪声就能把倍率推到任意档位
    //（2026-10-18 真机：应缴 $0.019 < 3×$0.01，却因账户级抖动读出 142.975× 假 fail）。
    return na(
      `本次应缴金额 ${round(expectedCost)} 低于余额读数最小分辨率（${round(resolution)}）的 3 倍：` +
        '即使足额扣费也只能落在 1-3 个最小刻度内，倍率会被舍入噪声支配，无法可靠判定（可增大采样量 --deep 或改用 token-reference 对账）。',
    );
  }
  const ratio = spendDelta / expectedCost;
  if (!Number.isFinite(ratio)) {
    return na(`实测倍率计算结果越界（${String(ratio)}）：余额读数或 usage 数值异常，无法判定。`);
  }
  if (ratioDropped > 0) {
    // 有意设计的保守降级（防误报）：缺失使分母偏小、实测倍率上偏，上偏的 ratio 出 fail 恰会冤枉端点，
    // 故任何缺失都以 info 收场，不进入任何 fail/warn 判定（含下方回归 fail 分支——此时偏差方向不可知）。
    // 但不掩盖事实：按「无缺失」假设重算底层档位，经 maskedVerdict/metrics 透出供 CI 观测。
    const underlying = decideRatio({ before, after, spendDelta, expectedCost, ratioDropped: 0, regressionLevel });
    const masked =
      underlying !== null && (underlying.verdict === 'fail' || underlying.verdict === 'warn')
        ? underlying.verdict
        : (underlying?.maskedVerdict ?? null);
    return {
      verdict: 'ok',
      maskedVerdict: masked,
      cap: null,
      ratio,
      finding: {
        level: 'info',
        message:
          `${ratioDropped} 笔请求 usage 缺失，实测倍率分母偏小、结果上偏，仅作参考不出判定` +
          (masked !== null ? `（按无缺失重算底层档位为 ${masked}，因上偏不采信）。` : '。'),
        evidenceIds: [],
      },
    };
  }
  if (ratio > 10) {
    // 余额差值是账户级口径：10 倍以上更可能是窗口内其他并发消费、充值/退款混入或单位错配，
    // 无法归因到本次审计。保留原始倍率与 maskedVerdict 供复核，但不判 fail（防冤枉端点）。
    return {
      verdict: 'N/A',
      maskedVerdict: 'fail',
      cap: null,
      ratio,
      finding: {
        level: 'warn',
        message:
          `实测倍率 ${round(ratio)} 远超本次应缴金额（Δ=${round(spendDelta)}，应缴=${round(expectedCost)}）：` +
          '余额差值为账户级口径，无法区分真实超高计费与窗口内其他并发消费/余额单位错配，本次不判 fail；' +
          '请确认审计窗口独占、余额单位一致，或人工核对该站账单。',
        evidenceIds: [],
      },
    };
  }
  if (regressionLevel === 'fail') {
    // usage 回归失败 → usage 虚增只会压小 ratio，ratio 是真实倍率的下限
    if (ratio > 1.5) {
      return {
        verdict: 'fail',
        maskedVerdict: null,
        cap: null,
        ratio,
        finding: {
          level: 'fail',
          message: `即便按端点自报 usage 计算，扣费仍超宣称 1.5 倍（实测倍率 ${round(ratio)}）；usage 不可信时真实倍率更高。`,
          evidenceIds: [],
        },
      };
    }
    return {
      verdict: 'ok',
      maskedVerdict: null,
      cap: null,
      ratio,
      finding: {
        level: 'info',
        message: `usage 回归失败（计数不可信），按自报 usage 计算的倍率 ${round(ratio)} 未超 1.5，倍率无法判定。`,
        evidenceIds: [],
      },
    };
  }
  if (ratio > 1.5) {
    return {
      verdict: 'fail',
      maskedVerdict: null,
      cap: 30,
      ratio,
      finding: {
        level: 'fail',
        message: `实测倍率 ${round(ratio)} > 1.5：实际扣费显著高于按宣称价格与自报 usage 的应缴金额，计费虚高。`,
        evidenceIds: [],
      },
    };
  }
  if (ratio > 1.1) {
    return {
      verdict: 'warn',
      maskedVerdict: null,
      cap: 70,
      ratio,
      finding: {
        level: 'warn',
        message: `实测倍率 ${round(ratio)} 落在 (1.1, 1.5]：实际扣费高于宣称价格，存在加价嫌疑。`,
        evidenceIds: [],
      },
    };
  }
  if (ratio >= 0.8) {
    return {
      verdict: 'ok',
      maskedVerdict: null,
      cap: null,
      ratio,
      finding: {
        level: 'info',
        message: `实测倍率 ${round(ratio)} 落在 [0.8, 1.1]：与宣称价格基本一致。`,
        evidenceIds: [],
      },
    };
  }
  if (ratio >= 0.5) {
    // 低报 20%-50% 不能算「一致」：可能是 usage 少计、价格/余额单位错配或账户级抵扣。
    // 不判 fail（方向对用户有利且账户级噪声未知），但必须 warn 阻止 PASS。
    return {
      verdict: 'warn',
      maskedVerdict: null,
      cap: null,
      ratio,
      finding: {
        level: 'warn',
        message: `实测倍率 ${round(ratio)} 落在 [0.5, 0.8)：实际扣费低于按宣称价格与自报 usage 的应缴金额，疑 usage 少计、价格/余额单位错配或账户级抵扣，请人工核对。`,
        evidenceIds: [],
      },
    };
  }
  return {
    verdict: 'warn',
    maskedVerdict: null,
    cap: null,
    ratio,
    finding: {
      level: 'warn',
      message: `实测倍率 ${round(ratio)} < 0.5：疑价格与余额单位错配或余额精度不足，请人工核对单位（工具只算比值，不换算单位）。`,
      evidenceIds: [],
    },
  };
}

function na(message: string): RatioDecision {
  return { verdict: 'N/A', maskedVerdict: null, cap: null, ratio: null, finding: { level: 'info', message, evidenceIds: [] } };
}

/**
 * 把倍率判定合成回 score/level 的唯一入口：
 * - score 为 null（insufficient）时不合成（严禁 Math.min(null, cap)，JS 里得 0）；
 * - cap 非 null 时取 min，并按 cap 重算 level（cap<=30→fail，cap<=70→至少 warn）。
 */
export function applyRatioDecision(
  score: number | null,
  level: Level,
  decision: RatioDecision | null,
): { score: number | null; level: Level } {
  if (decision === null || typeof score !== 'number' || !Number.isFinite(score)) return { score, level };
  let nextLevel = level;
  if (decision.finding.level === 'fail') nextLevel = escalate(nextLevel, 'fail');
  else if (decision.finding.level === 'warn') nextLevel = escalate(nextLevel, 'warn');
  if (decision.cap === null || !Number.isFinite(decision.cap)) return { score, level: nextLevel };
  return { score: Math.min(score, decision.cap), level: nextLevel };
}

/**
 * 实测倍率对应的 headline（与 finding 同级）：
 * fail 必须说明「扣费高于应缴」，warn 必须说明偏高/偏低方向；info/ok 返回 null（不覆盖回归结论）。
 */
function ratioHeadline(decision: RatioDecision, regressionLevel: Level): string | null {
  if (decision.ratio === null) return null;
  if (decision.verdict === 'N/A') {
    return `实测倍率 ${round(decision.ratio)} 异常但无法归因（疑账户级并发或余额单位错配），本次不作 fail 判定`;
  }
  if (decision.finding.level === 'fail') {
    const suffix = regressionLevel === 'fail' ? '；usage 计数亦异常' : '';
    return `实测扣费为应缴的 ${round(decision.ratio)} 倍（>1.5），计费虚高${suffix}`;
  }
  if (decision.finding.level === 'warn') {
    return decision.ratio < 0.5
      ? `实测倍率 ${round(decision.ratio)} 异常偏低（<0.5），疑价格/余额单位错配`
      : `实测倍率 ${round(decision.ratio)} 偏高（>1.1），存在加价嫌疑`;
  }
  return null;
}

export function meanY(ys: readonly number[]): number {
  return mean(ys);
}
