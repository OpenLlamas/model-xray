import { basename } from 'node:path';
import type { ChatMessage, DeclaredPricingSnapshot, Finding, Level, ProbeCtx, ProbeOutcome, RunConfig } from '../types.js';
import { computeCostUsd, type ModelPrice } from '../gateway/pricing.js';
import { estimateMessageTokens, estimateTokens } from '../tokens.js';
import { linearRegression, mean } from '../stats.js';
import { failureDigest } from '../diagnostics.js';
import { recordCall } from '../evidence.js';
import { probeBalanceDetailed, probeBalanceStable, spendBetween, type BalanceReading } from '../balance.js';
import {
  calibrateSpendDelta,
  calibrationLowConfidenceNote,
  firstFinitePositive,
  formatCalibrationCandidates,
  type CalibrationConfidence,
  type CalibrationOutcome,
  type CalibrationUnit,
} from '../calibration.js';
import {
  expectedCostFromDeclared,
  lookupDeclaredModel,
  modelFamily,
  normalizeModelName,
  usdPerMillionPerRatio,
  type DeclaredCostEstimate,
  type DeclaredPricing,
  type QuotaPerUnitSource,
  type UsageTotals,
} from '../pricing.js';
import { discoverPricing, toPublicPricingResult, type PricingDiscoveryResult } from '../pricing-discovery.js';
import { type PublicPricingResult, type PublicUsdPrice } from '../pricing-public.js';
import { comparePricingSnapshots, type PricingDrift } from '../pricing-ledger.js';
import { scrapeDeclaredPricing } from '../pricing-scrape.js';
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

/**
 * 探针侧通过分上限：换芯实锤、倍率虚高、公示价不可得等路径共用（usage 形状核验等
 * 其余检查仍通过的残值）。注意 fail 档位路径（如 L1326 换芯）在聚合层还会被
 * scoring.FAIL_LEVEL_SCORE_CAP(45) 二次封顶——定罪维度不保留及格分，这里的 70
 * 实际只约束 warn/证据缺口路径的残值。
 */
const PRICING_FAILED_SCORE = 70;

/**
 * 公示倍率漂移（对照基线/价格账本历史快照）时的通过分上限：漂移可能直接对应计费上涨，
 * 但「页面变化 ≠ 实收变化」，只降档不判 fail（实收核验由余额对账负责）。
 */
const PRICING_DRIFT_SCORE = 85;

/**
 * 暗插固定 token 判定阈值：回归截距（x=0 外推的恒定项）超过该值即「与输入长度无关的恒定加计」。
 * 依据：本地估算的模板开销 +4/消息，诚实中转/网关的系统提示与模板余量约 10-50 tokens；
 * 120 以上的截距不可能由估算噪声产生（2026-10-19 图纸双审：r2≥0.9 才判，防非线性噪声外推失真）。
 */
const INTERCEPT_WARN_TOKENS = 120;

/** 输出侧灌水判定：仅 en 轨道 Σcompletion_tokens / Σ本地估算 > 1.35 判疑似灌水（容忍 ±35% 估算误差）。 */
const COMPLETION_INFLATE_RATIO = 1.35;
/** 输出侧少报披露线（对用户有利方向仅 info 披露，不扣分）。 */
const COMPLETION_UNDERREPORT_RATIO = 0.6;

/** 自适应补采：单笔回声请求的目标 prompt token 数（比标准最大档大 2 倍，最大化单笔 Δ 抬升）。 */
const TOPUP_PROMPT_TOKENS = 48000;
/** 自适应补采笔数上限：窗口花费的硬性边界（另有按宣称价的美元预算守门）。 */
const TOPUP_MAX_REQUESTS = 8;

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
  // 余额前后对账是显式 opt-in：默认只用公示价/列表价算倍率，不发起任何余额请求。
  const balanceEnabled = priceEnabled && ctx.cfg.readBalance === true;
  const price = claimed.price;
  if (claimed.error !== null) {
    findings.push({ level: 'warn', message: `计费核价配置无效：${claimed.error}。本次不计算实扣倍率。`, evidenceIds: [] });
  }
  // 仅在「有消费者」时抓取公示价：显式价格核验、用户声明的倍率锚、历史基线/账本、或账本写回调。
  // 三者皆无时（纯 usage 形状审计）不发起公示价探测：网络/路由不可达不应把形状结论拖成证据缺口。
  const pricingFeaturesEnabled =
    priceEnabled ||
    ctx.cfg.expectModelRatio != null ||
    ctx.cfg.expectCompletionRatio != null ||
    ctx.previousPricing != null ||
    ctx.previousPricingAlt != null ||
    ctx.onPricingSnapshot !== undefined;
  // 站点公示倍率快照：自动探测 /api/pricing、/api/ratio_config、OpenRouter、LiteLLM、公开价表
  // （同源免鉴权、不计费、不携带凭证）：在首个计费请求前抓取，与余额观测窗口大致同窗。
  // 读取失败绝不 fail 探针本身——降级为显式状态并计入 money_check_state。
  const discovered: PricingDiscoveryResult | null = pricingFeaturesEnabled
    ? await discoverPricing(ctx.client.baseUrl, {
        timeoutMs: ctx.cfg.timeoutMs,
        quotaPerUsd: ctx.cfg.quotaPerUsd ?? null,
        group: ctx.cfg.group ?? null,
        model: ctx.cfg.model,
      })
    : null;
  const discoveredApiPricing =
    discovered !== null && discovered.state === 'ok' && discovered.pricing?.source === 'api'
      ? discovered.pricing
      : null;
  const discoveredQuotaPerUnit =
    discovered === null ? (ctx.cfg.quotaPerUsd ?? null) : discovered.quotaPerUnit;
  const declaredResult = {
    state:
      discoveredApiPricing !== null
        ? ('ok' as const)
        : discovered !== null && discovered.state === 'failed'
          ? ('failed' as const)
          : ('not_applicable' as const),
    origin: discovered?.origin ?? null,
    pricing: discoveredApiPricing,
    quotaPerUnit: discoveredQuotaPerUnit,
    reason:
      discoveredApiPricing !== null
        ? null
        : discovered !== null && discovered.state === 'ok'
          ? '未发现可解析的 API 倍率表（/api/pricing / /api/ratio_config），已回退公开价表'
          : discovered !== null
            ? discovered.reason
            : '未请求价格核验（无 --price-* / --expect-*-ratio / 基线或账本），跳过公示价抓取',
  };
  const declared = declaredResult.pricing;
  const declaredLookup = declared !== null ? lookupDeclaredModel(declared, ctx.cfg.model) : null;
  // 非 new-api 站点：自动探测到的公开价表/OpenRouter/LiteLLM 作为模型级价格锚。
  // 公开价表只做模型级价格锚，不参与余额 quota 换算（quotaPerUnit 仍取真实源）。
  const publicResult: PublicPricingResult | null = discovered !== null ? toPublicPricingResult(discovered) : null;
  const publicLookup =
    publicResult?.state === 'ok' && publicResult.pricing !== null
      ? lookupDeclaredModel(publicResult.pricing, ctx.cfg.model)
      : null;
  const publicPrice =
    publicResult !== null && publicResult.prices !== null && publicLookup !== null
      ? (publicResult.prices[publicLookup.key] ?? null)
      : null;
  const anchorSource: 'api' | 'public-json' | null =
    declaredLookup !== null ? 'api' : publicLookup !== null ? 'public-json' : null;
  const anchorPricing =
    anchorSource === 'api' ? declared : anchorSource === 'public-json' ? (publicResult?.pricing ?? null) : null;
  const declaredModel = declaredLookup?.model ?? publicLookup?.model ?? null;
  // 分组口径：--group 优先；未显式指定且公示表含 default 分组倍率时按 default 计价（与 README/HELP
  // 的「缺省用站点 default 分组」一致）。公开价表无分组概念，固定 null（倍率 1）。
  const effectiveGroup =
    anchorSource === 'api' && declared !== null
      ? (declared.group ?? ctx.cfg.group ?? (declared.groupRatio['default'] !== undefined ? 'default' : null))
      : anchorSource === 'public-json'
        ? null
        : (ctx.cfg.group ?? null);
  const quotaPerUnit = declaredResult.quotaPerUnit ?? ctx.cfg.quotaPerUsd ?? null;
  // 换算系数来源：CLI 覆盖优先，其次站点 /api/status 公示。漂移比对据此区分
  // 「站点改了换算系数」（实收金额随之变化，属漂移证据）与「用户换了覆盖值」（只披露）。
  const quotaPerUnitSource: QuotaPerUnitSource =
    ctx.cfg.quotaPerUsd != null ? 'cli' : declaredResult.quotaPerUnit != null ? 'site' : 'none';
  const quotaPerUnitSynthetic = anchorSource === 'api' && discovered?.quotaPerUnitSynthetic === true;
  // quota → USD 换算率（$1 = N quota ⇒ 1 quota = 1/N USD）；余额读数为 quota 单位时用它换算。
  const quotaToUsd = quotaPerUnit !== null && quotaPerUnit > 0 ? 1 / quotaPerUnit : null;
  // 倍率 → USD/百万 tokens：优先用站点真实 quota；未知时退回标准基价（仅展示）。
  const ratioToUsdPerMillion = usdPerMillionPerRatio(quotaPerUnit);
  // 账本/基线快照：公开价表只保留命中模型，且 quotaPerUnit 使用真实源，避免合成 500000 污染余额口径。
  const snapshotPricing: DeclaredPricing | null =
    anchorPricing === null
      ? null
      : anchorSource === 'public-json' && publicLookup !== null
        ? {
            ...anchorPricing,
            quotaPerUnit,
            quotaPerUnitSource,
            quotaPerUnitConflict: null,
            group: null,
            groupRatio: {},
            models: { [publicLookup.key]: publicLookup.model },
            source: 'public-json',
          }
        : anchorPricing;
  metrics['pricing_state'] = declaredResult.state;
  metrics['declared_source'] = anchorSource;
  metrics['declared_origin'] = anchorPricing?.origin ?? declaredResult.origin;
  metrics['declared_model_ratio'] = declaredModel !== null ? declaredModel.modelRatio : null;
  metrics['declared_completion_ratio'] = declaredModel !== null ? declaredModel.completionRatio : null;
  metrics['cache_ratio'] = declaredModel !== null ? declaredModel.cacheRatio : null;
  metrics['declared_group'] = anchorSource === 'public-json' ? null : effectiveGroup;
  metrics['declared_group_ratio'] =
    anchorSource === 'api' && declared !== null && effectiveGroup !== null ? (declared.groupRatio[effectiveGroup] ?? null) : null;
  // 分组倍率是否能在公示表中核验：null = 无分组口径可评估；0 = 声明了分组但站点未公示该倍率。
  metrics['group_ratio_verified'] =
    anchorSource === 'api' && declared !== null && effectiveGroup !== null
      ? declared.groupRatio[effectiveGroup] !== undefined
        ? 1
        : 0
      : null;
  metrics['quota_per_unit'] = quotaPerUnit;
  metrics['quota_per_unit_source'] = quotaPerUnitSource;
  metrics['quota_per_unit_synthetic'] = quotaPerUnitSynthetic ? 1 : 0;
  metrics['declared_ratio_synthetic'] = anchorSource === 'public-json' ? 1 : anchorSource === 'api' ? 0 : null;
  // 公开价表状态与原始 USD 单价（列表价只披露，不参与判定）。
  metrics['public_price_state'] = publicResult?.state ?? null;
  metrics['public_price_page'] = publicResult?.page ?? null;
  metrics['public_price_reason'] = publicResult?.reason ?? null;
  metrics['public_price_entries'] = publicResult?.entries ?? null;
  metrics['public_price_matched'] = publicLookup?.key ?? null;
  metrics['public_price_input_usd_per_m'] = publicPrice?.inputUsdPerM ?? null;
  metrics['public_price_output_usd_per_m'] = publicPrice?.outputUsdPerM ?? null;
  metrics['public_price_cached_usd_per_m'] = publicPrice?.cachedUsdPerM ?? null;
  metrics['public_price_list_input_usd_per_m'] = publicPrice?.listInputUsdPerM ?? null;
  metrics['public_price_list_output_usd_per_m'] = publicPrice?.listOutputUsdPerM ?? null;
  metrics['public_price_list_cached_usd_per_m'] = publicPrice?.listCachedUsdPerM ?? null;
  // 列表价折扣 = 站点实际公示价 ÷ 站点列表价（同单位比值，不换算币种）。它衡量站点相对「原价」的
  // 折扣/加价，既不是用户宣称价 ÷ 公示价，也不是余额差值实扣倍率（实收 ÷ 应缴）；缺列表价时为 null，不伪造。
  const listRatio = (actual: number | null | undefined, list: number | null | undefined): number | null => {
    if (actual == null || list == null) return null;
    if (!Number.isFinite(actual) || !Number.isFinite(list) || actual <= 0 || list <= 0) return null;
    return actual / list;
  };
  metrics['public_price_ratio_input'] = listRatio(publicPrice?.inputUsdPerM, publicPrice?.listInputUsdPerM);
  metrics['public_price_ratio_output'] = listRatio(publicPrice?.outputUsdPerM, publicPrice?.listOutputUsdPerM);
  // 快照内部字段（供 baseline 复原与漂移检测；报告渲染层会过滤这几个 key，避免表格膨胀）
  metrics['declared_captured_at'] = snapshotPricing !== null ? snapshotPricing.capturedAt : null;
  metrics['declared_models_json'] = snapshotPricing !== null ? serializeDeclaredModels(snapshotPricing) : null;
  metrics['declared_group_ratio_json'] = snapshotPricing !== null ? JSON.stringify(snapshotPricing.groupRatio) : null;
  // 价格账本：抓取成功即把本轮公示快照追加落盘（无需 --baseline 的历史对照来源，跨运行检测漂移）。
  // 写入失败只披露（warn + 指标），本轮判定不受影响；回调缺席（库调用方/测试）时不产生账本指标。
  let ledgerWriteFailed = false;
  const onPricingSnapshot = ctx.onPricingSnapshot;
  if (snapshotPricing !== null && onPricingSnapshot !== undefined) {
    const write = onPricingSnapshot(snapshotPricing);
    metrics['pricing_ledger_write_ok'] = write.ok ? 1 : 0;
    metrics['pricing_ledger_error'] = write.error;
    if (!write.ok) {
      ledgerWriteFailed = true;
      findings.push({
        level: 'warn',
        message: `价格账本写入失败（${write.error ?? '原因未知'}）：本轮已抓取快照但未能持久化，下次运行无法自动检测倍率漂移。`,
        evidenceIds: [],
      });
    } else if (ctx.previousPricing == null) {
      findings.push({
        level: 'info',
        message: `已写入本地价格账本（${write.path ?? '?'}），下次运行将自动对比公示倍率漂移`,
        evidenceIds: [],
      });
    }
  }
  // 漂移对照来源如实透出：baseline=显式基线快照，ledger=本地价格账本，none=无历史对照；
  // alt 为次对照源（--baseline 与账本同时存在时两者都参与对比）。
  metrics['pricing_ledger_previous_source'] = ctx.previousPricing != null ? (ctx.previousPricingSource ?? 'baseline') : 'none';
  metrics['pricing_ledger_alt_source'] = ctx.previousPricingAlt != null ? (ctx.previousPricingAltSource ?? 'ledger') : null;
  metrics['pricing_ledger_read_error'] = ctx.pricingLedgerError ?? null;
  // 账本损坏行：本地 I/O 问题（不是端点计费证据）→ 指标 + warn 披露，但绝不封顶分数/判 fail。
  // 尾部损坏（更新的位置有坏行/半行）时对照基线可能不是最新快照，必须在文案中明示这一点。
  const ledgerCorruptLines = ctx.pricingLedgerCorruptLines ?? 0;
  metrics['pricing_ledger_corrupt_lines'] = ledgerCorruptLines;
  if (ledgerCorruptLines > 0) {
    const tailSuffix = ctx.pricingLedgerTailCorrupt === true ? '；损坏行更新于对照基线，本次对照基线可能不是最新快照' : '';
    findings.push({
      level: 'warn',
      message: `价格账本有 ${ledgerCorruptLines} 行无法解析（可能历史损坏或并发写坏），漂移对照可能缺失最近快照${tailSuffix}：请检查 ${ctx.pricingLedgerPath ?? '本地价格账本文件'}`,
      evidenceIds: [],
    });
  } else if (ctx.pricingLedgerTailCorrupt === true) {
    findings.push({
      level: 'warn',
      message: `价格账本尾部存在未终止的半行：本次对照基线可能不是最新快照，漂移对照结论按此降级理解：请检查 ${ctx.pricingLedgerPath ?? '本地价格账本文件'}`,
      evidenceIds: [],
    });
  }
  metrics['declared_drift_count'] = null;
  metrics['declared_drift_down_count'] = null;
  metrics['declared_drift_fields'] = null;
  if (declaredResult.state === 'not_applicable') {
    // 公开价表可读但未收录目标模型时，交给下面更具体的 finding，避免同时说「公示价不可用」。
    if (
      pricingFeaturesEnabled &&
      anchorSource !== 'public-json' &&
      !(publicResult?.state === 'ok' && publicLookup === null)
    ) {
      const publicNote =
        publicResult?.state === 'not_applicable'
          ? `；公开价表同样不可用（${publicResult.reason ?? '原因未知'}）`
          : publicResult?.state === 'failed'
            ? `；公开价表读取失败（${publicResult.reason ?? '原因未知'}）`
            : '';
      findings.push({
        level: 'info',
        message: `站点公示价不可用（${declaredResult.reason ?? '原因未知'}）${publicNote}：本轮未核验公示倍率与金额，仅核验 usage 形状。`,
        evidenceIds: [],
      });
    }
  } else if (declared !== null) {
    if (declaredModel === null && anchorSource === null) {
      findings.push({
        level: 'info',
        message: `站点公示价表可读，但未找到模型「${ctx.cfg.model}」的条目（已尝试大小写/版本后缀归并），无法换算应缴金额；可用 --expect-model-ratio 手工声明倍率。`,
        evidenceIds: [],
      });
    }
    if (declared.quotaPerUnitConflict !== null) {
      findings.push({ level: 'info', message: declared.quotaPerUnitConflict, evidenceIds: [] });
    }
  }
  if (anchorSource === 'public-json' && publicResult !== null) {
    const why =
      declaredResult.state === 'not_applicable'
        ? `站点未提供可解析的 API 倍率表（${declaredResult.reason ?? '原因未知'}）`
        : declaredResult.state === 'failed'
          ? `站点 API 倍率表读取失败（${declaredResult.reason ?? '原因未知'}）`
          : `站点 API 倍率表未收录模型「${ctx.cfg.model}」`;
    findings.push({
      level: 'info',
      message:
        `已改用站点公开价表 ${publicResult.page ?? '?'}（${publicResult.entries} 条）作为公示价锚：${why}。` +
        '公开价表无分组概念，按倍率 1 折算，分组口径未核验；该价表不参与余额 quota 换算。',
      evidenceIds: [],
    });
  } else if (publicResult?.state === 'failed') {
    findings.push({
      level: 'info',
      message: `站点公开价表读取失败（${publicResult.reason ?? '原因未知'}）：本轮无法取得模型级公示价锚，金额侧仅按宣称价/usage 形状核验。`,
      evidenceIds: [],
    });
  } else if (publicResult?.state === 'ok' && publicLookup === null) {
    findings.push({
      level: 'info',
      message: `站点公开价表 ${publicResult.page ?? '?'} 可读（${publicResult.entries} 条），但未找到模型「${ctx.cfg.model}」：无法换算应缴金额。`,
      evidenceIds: [],
    });
  }
  if (snapshotPricing !== null) {
    if (ctx.previousPricing != null && ctx.previousPricingSource === 'ledger') {
      findings.push({
        level: 'info',
        message: `已从本地价格账本读取上次快照（${ctx.previousPricing.capturedAt}）用于漂移对比`,
        evidenceIds: [],
      });
    }
    // --baseline 与本地账本同时存在：两者都参与对照，明确披露双来源，避免用户误以为只看其一。
    if (ctx.previousPricingAlt != null && ctx.previousPricingAltSource === 'ledger' && ctx.previousPricing != null) {
      findings.push({
        level: 'info',
        message: `漂移对照同时使用 --baseline 快照（${ctx.previousPricing.capturedAt}）与本地价格账本快照（${ctx.previousPricingAlt.capturedAt}）`,
        evidenceIds: [],
      });
    }
    // 账本按主机+端口归档：对照快照抓取自同主机不同路径前缀时如实披露（两份快照可能口径不同）。
    if (
      (ctx.previousPricingSource === 'ledger' || ctx.previousPricingAltSource === 'ledger') &&
      ctx.pricingLedgerOriginNote != null &&
      ctx.pricingLedgerOriginNote !== ''
    ) {
      findings.push({ level: 'info', message: ctx.pricingLedgerOriginNote, evidenceIds: [] });
    }
    if (ctx.previousPricing == null) {
      findings.push({
        level: 'info',
        message:
          '首次记录站点公示倍率快照：本轮会把公示倍率并入基线落盘，下次审计用 --baseline 携带该基线即可检测倍率漂移' +
          '（本轮若无任何可评分维度，基线不落盘，快照需待可评分的一轮留存）。',
        evidenceIds: [],
      });
    }
  }
  // 账本读取失败（路径损坏/不可解析）：如实披露，不阻止审计，也不冒充「首次记录」。
  // 已有 --baseline 时对照不因此缺失，文案必须区分两种情形。
  if (ctx.pricingLedgerError != null && ctx.pricingLedgerError !== '') {
    findings.push({
      level: 'info',
      message:
        ctx.previousPricing != null
          ? `价格账本读取失败（${ctx.pricingLedgerError}）：本轮未对比本地账本历史，已有基线/历史快照对照不受影响。`
          : `价格账本读取失败（${ctx.pricingLedgerError}）：本轮未对比历史公示倍率。`,
      evidenceIds: [],
    });
  }
  // 网页价兜底（低信任参照）：/api/pricing 不可得且用户显式给出 --declared-price-page 时，
  // 抓取站点网页公示价做金额侧参照。网页价是页面自述、无 schema 校验，绝不作为 fail 证据、
  // 绝不写入价格账本（避免 scrape 快照污染 API 快照的漂移历史）。
  const declaredPricePage = typeof ctx.cfg.declaredPricePage === 'string' ? ctx.cfg.declaredPricePage.trim() : '';
  let scrapedReferenceEscalated = false;
  if (declared === null && priceEnabled && declaredPricePage !== '') {
    const scraped = await scrapeDeclaredPricing(ctx.client.baseUrl, ctx.cfg.model, {
      timeoutMs: ctx.cfg.timeoutMs,
      pricePage: declaredPricePage,
    });
    metrics['scraped_price_state'] = scraped.state;
    metrics['scraped_price_page'] = scraped.page;
    metrics['scraped_price_reason'] = scraped.reason;
    metrics['scraped_price_entries'] = scraped.entries.length;
    metrics['scraped_price_matched'] = scraped.matched !== null ? scraped.matched.modelName : null;
    metrics['scraped_price_matched_json'] = scraped.matched !== null ? JSON.stringify(scraped.matched) : null;
    metrics['scraped_price_currency'] = scraped.matched !== null ? scraped.matched.currency : null;
    metrics['scraped_price_input_usd_per_m'] = scraped.matched !== null ? scraped.matched.inputUsdPerM : null;
    metrics['scraped_price_output_usd_per_m'] = scraped.matched !== null ? scraped.matched.outputUsdPerM : null;
    metrics['scraped_price_confidence'] = scraped.matched !== null ? scraped.matched.confidence : null;
    const lowTrust = '网页价为低信任参照（页面自述、无 schema 校验），不作暗扣检测、不写入价格账本。';
    if (scraped.state === 'failed') {
      findings.push({ level: 'info', message: `网页公示价抓取失败（${scraped.reason ?? '原因未知'}）：${lowTrust}`, evidenceIds: [] });
    } else if (scraped.state === 'not_applicable') {
      findings.push({ level: 'info', message: `网页公示价不可用（${scraped.reason ?? '原因未知'}）：${lowTrust}`, evidenceIds: [] });
    } else if (scraped.matched === null) {
      findings.push({
        level: 'info',
        message: `网页价目表 ${scraped.page ?? ''} 可读（${scraped.entries.length} 条价格证据），但未找到模型「${ctx.cfg.model}」：${lowTrust}`,
        evidenceIds: [],
      });
    } else {
      const entry = scraped.matched;
      if (entry.currency === 'USD' && entry.inputUsdPerM !== null && entry.outputUsdPerM !== null && price !== null) {
        const relIn = Math.abs(entry.inputUsdPerM - price.input) / price.input;
        const relOut = Math.abs(entry.outputUsdPerM - price.output) / price.output;
        const rel = Math.max(relIn, relOut);
        if (rel > 0.5) {
          scrapedReferenceEscalated = true;
          findings.push({
            level: 'warn',
            message:
              `网页公示价（${entry.confidence}）为输入 $${round(entry.inputUsdPerM)}/M、输出 $${round(entry.outputUsdPerM)}/M，` +
              `与宣称的 $${price.input}/M、$${price.output}/M 相对差 ${(rel * 100).toFixed(1)}%（>50%）：存在加价嫌疑。${lowTrust}`,
            evidenceIds: [],
          });
        } else if (rel > 0.2) {
          scrapedReferenceEscalated = true;
          findings.push({
            level: 'warn',
            message:
              `网页公示价（${entry.confidence}）为输入 $${round(entry.inputUsdPerM)}/M、输出 $${round(entry.outputUsdPerM)}/M，` +
              `与宣称价相对差 ${(rel * 100).toFixed(1)}%（>20%）：存在加价嫌疑。${lowTrust}`,
            evidenceIds: [],
          });
        } else {
          findings.push({
            level: 'info',
            message:
              `网页公示价（${entry.confidence}）为输入 $${round(entry.inputUsdPerM)}/M、输出 $${round(entry.outputUsdPerM)}/M，` +
              `与宣称价相对差 ${(rel * 100).toFixed(1)}%（≤20%）：${lowTrust}`,
            evidenceIds: [],
          });
        }
      } else {
        findings.push({
          level: 'info',
          message:
            `网页价目表命中模型「${entry.modelName}」，但币种为 ${entry.currency} 或输入/输出归属不明确` +
            `（原文：${entry.rawLine}），不做美元比价；${lowTrust}`,
          evidenceIds: [],
        });
      }
    }
  }
  // money_check_state 尽早落定：探针可能因样本不足提前返回（insufficient），金额侧状态仍必须可见。
  // money_verified 只认余额绝对对账（下方 ratioVerified 后覆盖），token-reference 不含金额。
  metrics['money_verified'] = 0;
  metrics['money_check_state'] =
    anchorSource !== null
      ? 'declared_only'
      : declaredResult.state === 'failed'
        ? 'failed'
        : declaredResult.state === 'not_applicable'
          ? 'not_applicable'
          : 'declared_only';
  let expectedCost = 0;
  let ratioSamples = 0;
  // 第一个计费请求之前查 balanceBefore：pre 快照同样做稳定化轮询，且必须「首比即稳」（polls≤2）。
  // 窗口前未结算的消费在 pre 之后入账会混入 Δ 推高倍率 → 假 fail（post 侧误差方向是漏计、偏向诚实结论，
  // pre 侧是诬告方向，不对称从严）：短窗内读数仍在动即视同起点不可靠，实扣倍率按不可归因作废。
  const balanceBeforeStable = balanceEnabled
    ? await probeBalanceStable(ctx.client.baseUrl, ctx.cfg.apiKey, ctx.cfg.timeoutMs)
    : null;
  let balanceBefore: BillingBalanceReading | null = balanceBeforeStable?.reading ?? null;
  // quota / total_usage_raw 读数注入换算率：单位换算推迟到 decideRatio（校准需要应缴金额作锚），
  // 这里只附带可信元数据，不改动 unit/value，probeBalanceStable 的稳定判定口径不变。
  if (
    balanceBefore !== null &&
    (balanceBefore.unit === 'quota' || balanceBefore.unit === 'total_usage_raw') &&
    quotaToUsd !== null
  ) {
    balanceBefore = { ...balanceBefore, quotaToUsd };
  }
  // 余额稳定快照 = 首查后已结算且轮询次数 ≤2（最多 3 次查询，避免探测本身被计费/限流）。
  const balancePreClean = balanceBeforeStable !== null && balanceBeforeStable.settled && balanceBeforeStable.polls <= 2;
  // 读不到余额时的诊断原因：probeBalanceStable 只返回读数，失败时需要 detailed 探测给出可披露的 reason。
  let balanceProbeReason: string | null = null;
  if (balanceEnabled && balanceBeforeStable === null) {
    balanceProbeReason = (await probeBalanceDetailed(ctx.client.baseUrl, ctx.cfg.apiKey, ctx.cfg.timeoutMs)).reason;
  }

  interface Track {
    lang: 'en' | 'zh';
    xs: number[];
    ys: number[];
    raws: number[];
    /** 参与回归的样本证据 id（fail 级 finding 必须能回溯原始请求，兑现「每条 finding 链接证据」承诺） */
    evidenceIds: string[];
  }
  /** 应缴估算用的 usage 总量（仅通过 usage 校验的样本与自适应补采样本） */
  let promptTotal = 0;
  let completionTotal = 0;
  let usageValidSamples = 0;
  /** 成功响应回显的 model（与请求不一致时为换壳/计价错配线索；携带证据 id 供 finding 回溯） */
  const echoModels: Array<{ model: string; evidenceId: string }> = [];
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
  /** 输出侧灌水比对（Σ可见 completion vs Σ正文本地估算）：仅采「可归因」样本——finish=stop 且
   * 非空正文的样本，其可见 completion 理论上等于正文 token 数；length 截断样本的隐藏份额
   * 不可知，一律排除（宁漏报不误报）；reasoning_tokens 是 completion 子集（真机实证中转对
   * 普通复读也常报 1），按扣减推理份额归因。zh 轨 CJK 估算偏差（1字/token vs 实际 ~0.65）
   * 使基线比值天然偏低，只披露不判定。 */
  const completionSums: Record<'en' | 'zh', { reported: number; local: number; samples: number; excluded: number; evidenceIds: string[] }> = {
    en: { reported: 0, local: 0, samples: 0, excluded: 0, evidenceIds: [] },
    zh: { reported: 0, local: 0, samples: 0, excluded: 0, evidenceIds: [] },
  };
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
        // 200 空响应仍带 usage：重发只会重复计 prompt 并令实扣倍率 N/A，故不在 client 层重试空正文；
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
      // 回显模型收集（与 usage 是否可用无关：只要响应成功就检查计价错配线索）
      if (result.model !== null && result.model.trim() !== '') {
        echoModels.push({ model: result.model.trim(), evidenceId: evidence.id });
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
      // 输出侧灌水比对采集：finish=stop + 非空正文 + completion>0 才计入对（见 completionSums 注释）。
      // 归因口径：reasoning_tokens 是 completion 的子集（真机实证中转对普通复读也常报 1），
      // 直接排除会令检查在真实中转上失明——改为扣减推理份额后比对可见部分。
      {
        const sums = completionSums[lang];
        const reasoning = result.usage.reasoning_tokens ?? 0;
        const visibleReported = completion - reasoning;
        if (result.finishReason === 'stop' && completion > 0 && result.text.trim().length > 0 && visibleReported > 0) {
          sums.reported += visibleReported;
          sums.local += estimateTokens(result.text);
          sums.samples += 1;
          sums.evidenceIds.push(evidence.id);
        } else {
          sums.excluded += 1;
        }
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
      promptTotal += result.usage.prompt_tokens;
      completionTotal += result.usage.completion_tokens;
      usageValidSamples += 1;
      metrics[`prompt_tokens_${lang}_${targetTokens}`] = result.usage.prompt_tokens;
      refPairs[`${lang}_${targetTokens}`] = result.usage.prompt_tokens;
      // details 明细累计：仅统计通过校验的样本；!= null 判定保证 cached=0 也计数
      if (result.usage.cached_tokens != null) cachedTokensTotal += result.usage.cached_tokens;
      if (result.usage.reasoning_tokens != null) reasoningTokensTotal += result.usage.reasoning_tokens;
      if (result.usage.cached_tokens != null || result.usage.reasoning_tokens != null) detailsReported += 1;
    }
  }

  // 自适应补采（top-up）：应缴金额低于余额最小刻度 3 倍时（如整数美分类余额端点 + 便宜模型，
  // 应缴 $0.02 → 精度噪声支配倍率）decideRatio 必然 N/A——余额端点明明可用却测不出倍率。
  // 主序列后、post 快照前追加最大档回声请求抬升 Δ 至可判定区间。守门（2026-10-19 图纸双审必修）：
  // 仅窗口干净（无失败/无污染重试）且 pre 首比即稳、余额刻度可折算为 USD、至少 1 个有效计价样本时才付费；
  // 8 笔封顶 + 硬预算（按宣称价 3× 目标额，已含重试最坏放大）；预估到不了作废门槛则直接跳过
  // （不为注定 N/A 的窗口付费）；补采中一旦出现不可归因事件（失败/污染重试/usage 缺失）立即停。
  // 补采样本不进回归轨道/输出侧比对（固定档重复会破坏 x 分布），只进 Δ 与应缴金额。
  // 刻度折算：USD 直接用；quota 用 quotaToUsd；整数 total_usage_raw 按 OpenAI 美分 schema ×0.01；
  // 非整数 raw 单位未知（校准可能采信任一假设）→ 不补采，避免按错误刻度付费。
  const balanceResolutionUsd =
    balanceBefore === null ||
    !Number.isFinite(balanceBefore.resolution) ||
    (balanceBefore.resolution as number) <= 0
      ? null
      : balanceBefore.unit === 'USD'
        ? (balanceBefore.resolution as number)
        : balanceBefore.unit === 'quota'
          ? quotaToUsd !== null
            ? (balanceBefore.resolution as number) * quotaToUsd
            : null
          : balanceBefore.unit === 'total_usage_raw' && balanceBefore.integerCents === true
            ? (balanceBefore.resolution as number) * 0.01
            : null;
  let topupRequests = 0;
  let topupExpected = 0;
  let topupSkipped = false;
  if (
    priceEnabled &&
    price !== null &&
    ratioSamples > 0 &&
    balanceBefore !== null &&
    balancePreClean &&
    balanceResolutionUsd !== null &&
    failures.length === 0 &&
    contaminatingRetries === 0
  ) {
    const resolution = balanceResolutionUsd;
    const gateFloor = 3 * resolution;
    const target = 5 * resolution;
    const budget = 3 * target;
    if (expectedCost >= gateFloor && expectedCost < target) {
      // 已过作废门只是略噪：不补采（省用户花费），维持现有判定
    } else if (expectedCost < gateFloor) {
      const topupBody = buildEnglish(TOPUP_PROMPT_TOKENS);
      const topupPrompt = `请逐字复述下面这段文本，不要添加任何其他内容。\n\n${topupBody}\n\n（本段校验编号 ${ctx.rng.nonce(5)}）`;
      const topupMessages: ChatMessage[] = [{ role: 'user', content: topupPrompt }];
      const estPrompt = estimateMessageTokens(topupMessages);
      const perReqExpected = computeCostUsd(
        { prompt_tokens: estPrompt, completion_tokens: BILLING_MAX_TOKENS, cached_tokens: null },
        price,
      );
      if (expectedCost + TOPUP_MAX_REQUESTS * perReqExpected < gateFloor) {
        // 预检：8 笔全部有效也到不了作废门槛 → 补采注定无效，如实披露后放弃
        topupSkipped = true;
      } else {
        let stopped = false;
        while (!stopped && topupRequests < TOPUP_MAX_REQUESTS && expectedCost < target) {
          if (topupExpected + 3 * perReqExpected > budget) break; // 硬预算守门（含重试最坏 ×3）
          const result = await ctx.client.chat({
            model: ctx.cfg.model,
            messages: topupMessages,
            temperature: 0,
            max_tokens: BILLING_MAX_TOKENS,
            retryEmpty: false,
          });
          const evidence = recordCall(ctx.evidence, {
            probe: 'billing',
            label: `billing topup ${topupRequests + 1} target=${TOPUP_PROMPT_TOKENS}`,
            request: { model: ctx.cfg.model, stream: false, temperature: 0, maxTokens: BILLING_MAX_TOKENS, messages: topupMessages },
            result,
          });
          topupRequests += 1;
          requests += 1;
          if (result.attempts > 1) {
            retriedRequests += 1;
            retryEvidenceIds.push(evidence.id);
          }
          if (!result.ok) {
            failures.push(`topup@${TOPUP_PROMPT_TOKENS}: ${result.error ?? 'error'}`);
            failureErrors.push(result.error ?? 'error');
            failureEvidenceIds.push(evidence.id);
            stopped = true; // 窗口已被污染，后续补采注定 N/A，立即停
          } else if (result.contaminatingRetry === true) {
            contaminatingRetries += 1;
            contaminatingEvidenceIds.push(evidence.id);
            stopped = true;
          } else if (!result.usage) {
            usageMissing += 1; // ratioDropped → 保守 info，不再为注定降级的窗口付费
            stopped = true;
          } else {
            const cost = computeCostUsd(result.usage, price);
            expectedCost += cost;
            ratioSamples += 1;
            topupExpected += cost;
            // 补采样本同样计入公示价应缴估算（真实扣费的一部分）；仍不进回归/输出侧比对。
            promptTotal += result.usage.prompt_tokens;
            completionTotal += result.usage.completion_tokens;
            usageValidSamples += 1;
          }
        }
      }
    }
  }

  // 序列结束后查 balanceAfter：post 快照做稳定化轮询（异步结算延迟下单次读数会让 Δ 偏小、
  // 把诚实站点误判成低报倍率；连续两次一致才认稳定，仍不稳定则 Δ 判不可归因，见下方污染闸）。
  const balanceAfterStable = balanceEnabled
    ? await probeBalanceStable(ctx.client.baseUrl, ctx.cfg.apiKey, ctx.cfg.timeoutMs)
    : null;
  let balanceAfter: BillingBalanceReading | null = balanceAfterStable?.reading ?? null;
  if (
    balanceAfter !== null &&
    (balanceAfter.unit === 'quota' || balanceAfter.unit === 'total_usage_raw') &&
    quotaToUsd !== null
  ) {
    balanceAfter = { ...balanceAfter, quotaToUsd };
  }
  const balancePostSettled = balanceAfterStable?.settled ?? null;
  if (balanceEnabled && balanceAfterStable === null && balanceProbeReason === null) {
    balanceProbeReason = (await probeBalanceDetailed(ctx.client.baseUrl, ctx.cfg.apiKey, ctx.cfg.timeoutMs)).reason;
  }
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
    metrics['balance_conversion'] = reading?.conversionNote ?? null;
    metrics['balance_before'] = balanceBefore ? balanceBefore.value : null;
    metrics['balance_after'] = balanceAfter ? balanceAfter.value : null;
    metrics['balance_pre_settled'] = balanceBeforeStable ? (balancePreClean ? 1 : 0) : null;
    metrics['balance_pre_polls'] = balanceBeforeStable?.polls ?? null;
    metrics['balance_post_settled'] = balancePostSettled === null ? null : balancePostSettled ? 1 : 0;
    metrics['balance_post_polls'] = balanceAfterStable?.polls ?? null;
    metrics['balance_scope'] = balanceBefore ? (balanceBefore.endpoint === '/api/user/self' ? 'user' : 'key') : null;
    metrics['quota_to_usd'] = quotaToUsd;
    // 余额不可读时的诊断原因（probeBalanceDetailed）：N/A finding 里会一并披露，避免把
    // 「站点禁用余额接口」误读成「工具拿不到数据」。
    metrics['balance_probe_reason'] = balanceProbeReason;
    metrics['billing_topup_requests'] = topupRequests;
    metrics['billing_topup_expected_usd'] = round(topupExpected);
    if (topupSkipped) metrics['billing_topup_skipped'] = 1;
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
  /** 回显他族模型（无法比价）：level/headline 延后到证据分级之后生效，避免跳过 85 封顶。 */
  let familyMismatchHeadline: string | null = null;

  // ———— 公示倍率侧核验（与 usage 回归独立；不因样本不足而跳过） ————
  const usageTotals: UsageTotals = {
    promptTokens: promptTotal,
    completionTokens: completionTotal,
    samples: usageValidSamples,
    droppedSamples: Math.max(0, requests - usageValidSamples),
  };
  // 分组倍率：API 源沿用站点分组口径；公开价表无分组概念，固定倍率 1 并在 finding 披露未核验。
  const groupFactor =
    anchorSource === 'api' && declared !== null && effectiveGroup !== null ? (declared.groupRatio[effectiveGroup] ?? 1) : 1;
  const groupRatioUnverified =
    anchorSource === 'api' && declared !== null && effectiveGroup !== null && declared.groupRatio[effectiveGroup] === undefined;
  const groupPricingNote =
    anchorSource === 'public-json'
      ? '公开价表无分组概念，按倍率 1 折算（分组口径未核验）'
      : effectiveGroup !== null && declared !== null
        ? groupRatioUnverified
          ? `分组「${effectiveGroup}」未在公示表中给出倍率，按倍率 1 参照（未验证）`
          : `按公示分组倍率 ${effectiveGroup}×${groupFactor} 折算`
        : '未指定分组，按倍率 1 折算';
  const anchorInPerM =
    quotaPerUnitSynthetic
      ? null
      : anchorSource === 'public-json' && publicPrice !== null
        ? publicPrice.inputUsdPerM
        : declaredModel !== null
          ? declaredModel.modelRatio * groupFactor * ratioToUsdPerMillion
          : null;
  const anchorOutPerM =
    quotaPerUnitSynthetic
      ? null
      : anchorSource === 'public-json' && publicPrice !== null
        ? publicPrice.outputUsdPerM
        : declaredModel !== null
          ? declaredModel.modelRatio * ratioToUsdPerMillion * declaredModel.completionRatio * groupFactor
          : null;
  // 用户宣称价 ÷ 站点公示价：用户输入与官方价一致时应为 1×，这才是用户直觉里的「价格倍率」。
  // 列表价折扣（公示价 ÷ 列表价）是站内促销口径，单独标注，不能拿来冒充这个比值。
  const claimedRatio = (claimedValue: number, publishedValue: number | null): number | null => {
    if (publishedValue === null) return null;
    if (!Number.isFinite(claimedValue) || !Number.isFinite(publishedValue)) return null;
    if (claimedValue <= 0 || publishedValue <= 0) return null;
    const value = claimedValue / publishedValue;
    // 与现有单位错配门一致：量级差 ≥316× 说明「每千 token / 每百万 token」等口径不同，
    // 这个数字不再是价格倍率，宁可不展示，也不制造 0.001× 之类的误导。
    return Math.abs(Math.log10(value)) < 2.5 ? value : null;
  };
  const claimedRatioIn = price !== null ? claimedRatio(price.input, anchorInPerM) : null;
  const claimedRatioOut = price !== null ? claimedRatio(price.output, anchorOutPerM) : null;
  metrics['claimed_price_ratio_input'] = claimedRatioIn;
  metrics['claimed_price_ratio_output'] = claimedRatioOut;
  const declaredEstimate =
    anchorPricing !== null && declaredModel !== null && usageValidSamples > 0 && !quotaPerUnitSynthetic
      ? expectedCostFromDeclared(
          anchorPricing,
          declaredModel,
          usageTotals,
          anchorSource === 'api' && effectiveGroup !== null ? { group: effectiveGroup } : undefined,
        )
      : null;
  // quota_type=1（按次计费）时 token→quota 换算不成立：金额侧整体按未核验透出（null），不显示 0。
  // 公开价表锚无站点 quota 单位：应缴只以 USD 披露，quota 保持 null，不把标准基价冒充站点单位。
  metrics['expected_quota_declared'] =
    declaredEstimate !== null && declaredEstimate.state === 'priced' && anchorSource !== 'public-json' && !quotaPerUnitSynthetic
      ? round(declaredEstimate.quota)
      : null;
  // 公开价表没有站点 quota 单位，但 USD/百万 tokens 可独立计算应缴 USD；不要因 quota 未知而丢金额。
  const publicDeclaredUsd =
    anchorSource === 'public-json' && publicPrice !== null && declaredEstimate !== null && declaredEstimate.state === 'priced'
      ? (usageTotals.promptTokens / 1_000_000) * publicPrice.inputUsdPerM +
        (usageTotals.completionTokens / 1_000_000) * publicPrice.outputUsdPerM
      : null;
  const declaredUsd = publicDeclaredUsd ?? declaredEstimate?.usd ?? null;
  metrics['expected_cost_usd_declared'] =
    declaredEstimate !== null && declaredEstimate.state === 'priced' && declaredUsd !== null
      ? round(declaredUsd)
      : null;
  // 金额来源必须可审计：公开价表直接给 USD/M；API 倍率路径依赖站点 quota 才有 USD。
  metrics['expected_cost_usd_basis'] =
    declaredUsd === null ? null : publicDeclaredUsd !== null ? 'public_usd' : 'quota';
  metrics['cost_is_upper_bound'] = declaredEstimate !== null && declaredEstimate.state === 'priced' ? (declaredEstimate.isUpperBound ? 1 : 0) : null;
  metrics['cost_is_lower_bound'] = declaredEstimate !== null && declaredEstimate.state === 'priced' ? (declaredEstimate.isLowerBound ? 1 : 0) : null;

  if (quotaPerUnitSynthetic) {
    findings.push({
      level: 'info',
      message:
        '站点已公示 model_ratio/completion_ratio，但未公示 quota_per_unit（每美元 quota 数）：' +
        '本轮不把标准基价当作站点换算率，价目对比与按公示价应缴金额均不计算。' +
        '如需换算，请用 --quota-per-usd 提供站点真实值。',
      evidenceIds: [],
    });
  }
  if (anchorSource === 'public-json') {
    findings.push({
      level: 'info',
      message:
        '公开价表只提供 USD 单价，报告中的公示输入/输出倍率是按标准基价反推的展示值；' +
        '跨站比较时应使用公开 USD 单价，不能把这些反推倍率当作站点原生 model_ratio。',
      evidenceIds: [],
    });
  }

  if (declaredResult.state === 'failed' && anchorSource === null) {
    findings.push({
      level: 'warn',
      message: `站点公示价读取失败（${declaredResult.reason ?? '原因未知'}）：本轮无法核验公示倍率与金额侧，仅能核验 usage 形状。`,
      evidenceIds: [],
    });
    score = Math.min(score, PRICING_FAILED_SCORE);
    level = escalate(level, 'warn');
    if (headline === defaultHeadline) headline = '站点公示价读取失败，公示倍率与金额侧证据缺失';
  }

  // ———— 公示倍率漂移（对照 --baseline / 本地价格账本） ————
  if (snapshotPricing !== null) {
    const driftSources: Array<{ source: 'baseline' | 'ledger'; snapshot: DeclaredPricingSnapshot }> = [];
    if (ctx.previousPricing != null) {
      driftSources.push({ source: ctx.previousPricingSource ?? 'baseline', snapshot: ctx.previousPricing });
    }
    if (ctx.previousPricingAlt != null) {
      driftSources.push({ source: ctx.previousPricingAltSource ?? 'ledger', snapshot: ctx.previousPricingAlt });
    }
    const driftLabel = (source: 'baseline' | 'ledger', capturedAt: string): string =>
      source === 'ledger' ? `对照本地价格账本快照 ${capturedAt}` : `对照 --baseline 快照 ${capturedAt}`;
    const seenKeys = new Set<string>();
    const merged: Array<{ drift: PricingDrift; label: string }> = [];
    const crossSourceSkipped: string[] = [];
    for (const { source, snapshot: previous } of driftSources) {
      const previousSource = previous.source;
      const currentSource = snapshotPricing.source;
      const sameSource =
        (previousSource === undefined && currentSource === undefined) ||
        (previousSource !== undefined && currentSource !== undefined && previousSource === currentSource);
      if (!sameSource) {
        crossSourceSkipped.push(
          `${driftLabel(source, previous.capturedAt)}（上次来源 ${previousSource ?? '未知（legacy）'}，本轮来源 ${currentSource ?? '未知（legacy）'}）`,
        );
        continue;
      }
      for (const drift of comparePricingSnapshots(previous, snapshotPricing, { model: ctx.cfg.model })) {
        const key = JSON.stringify([drift.field, drift.model ?? null, drift.oldValue ?? null, drift.newValue ?? null]);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        merged.push({ drift, label: driftLabel(source, previous.capturedAt) });
      }
    }
    if (crossSourceSkipped.length > 0) {
      findings.push({
        level: 'info',
        message: `跨来源快照跳过漂移比对：${crossSourceSkipped.join('；')}。不同来源（/api/pricing、公开价表、网页抓价）的计价口径不可互换。`,
        evidenceIds: [],
      });
    }
    if (driftSources.length > 0) {
      // 「显著」口径与价格账本/基线一致（pricing-ledger 的 significant，相对变化 >5%）；
      // 其余只披露、不封顶，避免把定价页排版/注释微调误判成「偷改价格」。
      const significant = merged.filter((item) => item.drift.significant);
      // 只有「变贵/口径断裂/方向未知」才降档；明确下调是更划算，不得按偷改价格扣分。
      const adverse = significant.filter((item) => item.drift.direction !== 'down');
      const cheaper = significant.filter((item) => item.drift.direction === 'down');
      const directionText = (direction: PricingDrift['direction']): string =>
        direction === 'down' ? '下调' : direction === 'up' ? '上调' : '发生变化';
      metrics['declared_drift_count'] = adverse.length;
      metrics['declared_drift_down_count'] = cheaper.length;
      metrics['declared_drift_fields'] = merged.length > 0 ? merged.map((item) => `${item.drift.kind}:${item.drift.field}`).join(',') : 'none';
      if (adverse.length > 0) {
        score = Math.min(score, PRICING_DRIFT_SCORE);
        level = escalate(level, 'warn');
        const first = adverse[0];
        if (first !== undefined) {
          headline = `站点公示倍率与历史快照相比已变化：${driftSubjectText(first.drift)} ${first.drift.message}（${directionText(first.drift.direction)}）`;
        }
        for (const { drift, label } of adverse.slice(0, 10)) {
          findings.push({
            level: 'warn',
            message: `${label}：${driftSubjectText(drift)} ${drift.message}（${directionText(drift.direction)}）。`,
            evidenceIds: [],
          });
        }
      }
      if (cheaper.length > 0) {
        for (const { drift, label } of cheaper.slice(0, 10)) {
          findings.push({
            level: 'info',
            message: `${label}：${driftSubjectText(drift)} ${drift.message}（下调，价格更划算），不降档。`,
            evidenceIds: [],
          });
        }
      }
      if (merged.length > significant.length) {
        findings.push({
          level: 'info',
          message: `另有 ${merged.length - significant.length} 项公示价排版/字段变化（相对变化 ≤5%），不计入漂移降档`,
          evidenceIds: [],
        });
      } else if (significant.length === 0 && merged.length > 0) {
        findings.push({
          level: 'info',
          message: `公示倍率与历史快照存在 ${merged.length} 项非显著变化（相对变化 ≤5%），不计入漂移降档`,
          evidenceIds: [],
        });
      }
    }
  }

  // ———— 用户声明倍率 vs 站点公示倍率（带 --expect-model-ratio/--expect-completion-ratio 时） ————
  // 相对差 >5% → fail：直接比对「同一模型」的两个倍率字段，与宣称价格口径相互独立，
  // 不依赖 usage 样本，故样本不足时也能给出金额侧结论。
  const expectModelRatio = ctx.cfg.expectModelRatio ?? null;
  const expectCompletionRatio = ctx.cfg.expectCompletionRatio ?? null;
  if (declaredModel !== null) {
    const expectChecks: Array<{ flag: string; expected: number; actual: number }> = [];
    if (expectModelRatio !== null) {
      expectChecks.push({ flag: 'expect-model-ratio', expected: expectModelRatio, actual: declaredModel.modelRatio });
    }
    if (expectCompletionRatio !== null) {
      expectChecks.push({ flag: 'expect-completion-ratio', expected: expectCompletionRatio, actual: declaredModel.completionRatio });
    }
    for (const check of expectChecks) {
      if (!Number.isFinite(check.expected) || check.expected <= 0) continue;
      const rel = Math.abs(check.actual - check.expected) / check.expected;
      if (rel > 0.05) {
        const directionText = check.actual > check.expected ? '实际高于声明' : '实际低于声明';
        score = Math.min(score, PRICING_FAILED_SCORE);
        level = escalate(level, 'fail');
        headline = `${check.flag} 与站点公示倍率不符：声明 ${check.expected}，公示 ${check.actual}（相对差 ${(rel * 100).toFixed(1)}%，${directionText}）`;
        findings.push({
          level: 'fail',
          message: `用户声明 ${check.flag}=${check.expected}，站点公示倍率 ${check.actual}（相对差 ${(rel * 100).toFixed(1)}%，${directionText}）：站点计价口径与声明不一致，存在虚标倍率嫌疑。`,
          evidenceIds: [],
        });
      }
    }
  } else if (expectModelRatio !== null || expectCompletionRatio !== null) {
    // 锚定失败：用户声明了倍率但站点公示表不可读/未收录该模型 → 证据缺口按 warn 收口，不伪造 fail。
    const flags = [expectModelRatio !== null ? '--expect-model-ratio' : null, expectCompletionRatio !== null ? '--expect-completion-ratio' : null]
      .filter((item): item is string => item !== null)
      .join('/');
    findings.push({
      level: 'warn',
      message: `已声明 ${flags}，但站点公示价表中未找到模型「${ctx.cfg.model}」（或 /api/pricing 不可得）：声明倍率无法与公示值锚定，本次不判 fail，仅按证据缺口降档。`,
      evidenceIds: [],
    });
    score = Math.min(score, PRICING_FAILED_SCORE);
    level = escalate(level, 'warn');
    if (headline === defaultHeadline) headline = '声明的倍率无法与站点公示值锚定，金额侧证据不完整';
  }

  // ———— 公示价 vs 宣称价（同一报价口径的绝对核对；>50% 才 fail） ————
  if (priceEnabled && declaredModel !== null && price !== null && anchorPricing !== null && declaredModel.modelRatio > 0) {
    const declaredIn = declaredModel.modelRatio * groupFactor * ratioToUsdPerMillion;
    const declaredOut = declaredModel.modelRatio * declaredModel.completionRatio * groupFactor * ratioToUsdPerMillion;
    if (anchorSource === 'public-json') {
      // 方向性依据：claimed（宣称价/用户被报价）是成交价基准；published 高于 claimed 才可能是站点加价，
      // published 更低说明站点比宣称更便宜，无可归因于站点的加价（不判罚，避免「站更便宜反被判虚标」）。
      // 这与 new-api 源的对称比价刻意不同：那是站点自己公示的倍率与用户宣称的绝对差，任一侧偏离都值得披露。
      const publishedIn = publicPrice?.inputUsdPerM ?? declaredIn;
      const publishedOut = publicPrice?.outputUsdPerM ?? declaredOut;
      const disclosure: string[] = [];
      if (publicPrice?.listInputUsdPerM != null || publicPrice?.listOutputUsdPerM != null) {
        const ratioIn = listRatio(publicPrice?.inputUsdPerM, publicPrice?.listInputUsdPerM);
        const ratioOut = listRatio(publicPrice?.outputUsdPerM, publicPrice?.listOutputUsdPerM);
        const ratioText =
          ratioIn !== null || ratioOut !== null
            ? `（列表价折扣 输入 ${ratioIn !== null ? `${round(ratioIn)}×` : 'N/A'}、输出 ${ratioOut !== null ? `${round(ratioOut)}×` : 'N/A'}）`
            : '';
        disclosure.push(
          `列表价输入 $${publicPrice?.listInputUsdPerM != null ? round(publicPrice.listInputUsdPerM) : 'N/A'}/M、输出 ` +
            `$${publicPrice?.listOutputUsdPerM != null ? round(publicPrice.listOutputUsdPerM) : 'N/A'}/M${ratioText}`,
        );
      }
      if (publicPrice?.cachedUsdPerM != null) {
        disclosure.push(`缓存读价 $${round(publicPrice.cachedUsdPerM)}/M`);
      }
      const listNote =
        disclosure.length > 0 ? `；${disclosure.join('、')}（仅披露，不参与判定，不代表实收扣费）` : '';
      const ratios = [publishedIn / price.input, publishedOut / price.output].filter(
        (ratio) => Number.isFinite(ratio) && ratio > 0,
      );
      const unitMismatch = ratios.some((ratio) => Math.abs(Math.log10(ratio)) >= 2.5);
      if (unitMismatch) {
        const magnitude =
          ratios.length > 0 ? Math.max(...ratios.map((ratio) => (ratio >= 1 ? ratio : 1 / ratio))) : 1;
        findings.push({
          level: 'info',
          message:
            `站点公开价表输入 $${round(publishedIn)}/M、输出 $${round(publishedOut)}/M 与宣称价相差约 ${round(magnitude)}×` +
            `（≥316×）：疑似每千 token 与每百万 token 单位口径不同，不作价格比对，仅披露。${listNote}`,
          evidenceIds: [],
        });
      } else {
        const upIn = publishedIn > price.input ? (publishedIn - price.input) / price.input : 0;
        const upOut = publishedOut > price.output ? (publishedOut - price.output) / price.output : 0;
        const relUp = Math.max(upIn, upOut);
        const sourceText = `（来源：公开价表 ${publicResult?.page ?? '?'}）`;
        if (relUp > 0.5) {
          score = Math.min(score, PRICING_FAILED_SCORE);
          level = escalate(level, 'fail');
          headline = `站点公开价与宣称价格不符（相对差 ${(relUp * 100).toFixed(1)}%），存在虚标价格嫌疑`;
          findings.push({
            level: 'fail',
            message:
              `公开价表输入价 $${round(publishedIn)}/M vs 宣称 $${price.input}/M、公开价表输出价 $${round(publishedOut)}/M vs 宣称 $${price.output}/M` +
              `（相对差 ${(relUp * 100).toFixed(1)}%，>50%）：站点公开价高于宣称价，存在虚标价格嫌疑。${sourceText}${listNote}。`,
            evidenceIds: [],
          });
        } else if (relUp > 0.2) {
          level = escalate(level, 'warn');
          findings.push({
            level: 'warn',
            message:
              `公开价表输入价 $${round(publishedIn)}/M vs 宣称 $${price.input}/M、公开价表输出价 $${round(publishedOut)}/M vs 宣称 $${price.output}/M` +
              `（相对差 ${(relUp * 100).toFixed(1)}%，>20%）：站点公开价高于宣称价，存在加价嫌疑。${sourceText}${listNote}。`,
            evidenceIds: [],
          });
        } else if (relUp > 0) {
          findings.push({
            level: 'info',
            message:
              `公开价表输入价 $${round(publishedIn)}/M vs 宣称 $${price.input}/M、输出价 $${round(publishedOut)}/M vs 宣称 $${price.output}/M` +
              `（相对差 ${(relUp * 100).toFixed(1)}%，≤20%）：公开价略高于宣称价，仅披露，未达 warn 阈值。${sourceText}${listNote}。`,
            evidenceIds: [],
          });
        } else {
          // published 各轴都不高于 claimed：站点公示价更便宜。但「公示低、实收按宣称价」的引流收割
          // （低价表吸引、口头报价更高）在无余额对账时不可见，差值 ≥50% 时给 warn 披露该假设，绝不 fail。
          const downIn = (price.input - publishedIn) / price.input;
          const downOut = (price.output - publishedOut) / price.output;
          const relDown = Math.max(downIn, downOut, 0);
          if (relDown > 0.5) {
            level = escalate(level, 'warn');
            findings.push({
              level: 'warn',
              message:
                `公开价表输入价 $${round(publishedIn)}/M、输出价 $${round(publishedOut)}/M 不足宣称价 $${price.input}/M、$${price.output}/M 的一半` +
                `（低 ${(relDown * 100).toFixed(1)}%）：若实际结算按宣称价收取，存在「低价表引流、高价结算」的嫌疑` +
                `（假设实收=宣称价，未经余额验证，不判 fail）。${sourceText}${listNote}。`,
              evidenceIds: [],
            });
          } else if (publishedIn < price.input || publishedOut < price.output) {
            findings.push({
              level: 'info',
              message: `站点公开价低于宣称价，无可归因的加价。${sourceText}${listNote}。`,
              evidenceIds: [],
            });
          } else {
            findings.push({
              level: 'info',
              message: `站点公开价与宣称价一致，无可归因的加价。${sourceText}${listNote}。`,
              evidenceIds: [],
            });
          }
        }
      }
    } else {
      // cache 同乘分组倍率（缓存读价与输入价同属一个倍率体系）
      const declaredCache =
        declaredModel.cacheRatio !== null
          ? declaredModel.modelRatio * declaredModel.cacheRatio * groupFactor * ratioToUsdPerMillion
          : null;
      const cacheNote = declaredCache !== null ? `；公示缓存读价 $${round(declaredCache)}/M（同倍率折算）` : '';
      const rel = Math.max(
        Math.abs(declaredIn - price.input) / price.input,
        Math.abs(declaredOut - price.output) / price.output,
      );
      if (rel > 0.5) {
        score = Math.min(score, PRICING_FAILED_SCORE);
        level = escalate(level, 'fail');
        headline = `站点公示价与宣称价格不符（相对差 ${(rel * 100).toFixed(1)}%），存在虚标价格嫌疑`;
        findings.push({
          level: 'fail',
          message:
            `公示输入价 $${round(declaredIn)}/M vs 宣称 $${price.input}/M、公示输出价 $${round(declaredOut)}/M vs 宣称 $${price.output}/M` +
            `（相对差 ${(rel * 100).toFixed(1)}%，>50%）：站点公示价与自身宣称价格不符，存在虚标价格嫌疑。` +
            `${groupPricingNote}${cacheNote}。`,
          evidenceIds: [],
        });
      } else if (rel > 0.2) {
        findings.push({
          level: 'warn',
          message:
            `公示输入价 $${round(declaredIn)}/M vs 宣称 $${price.input}/M、公示输出价 $${round(declaredOut)}/M vs 宣称 $${price.output}/M` +
            `（相对差 ${(rel * 100).toFixed(1)}%，≤50%）：存在价格口径差异，未达 fail 阈值。${groupPricingNote}${cacheNote}。`,
          evidenceIds: [],
        });
      }
    }
  }

  // ———— 回显模型 vs 请求模型（换芯/计价错配线索） ————
  if (anchorPricing !== null && echoModels.length > 0) {
    const requestedNorm = normalizeModelName(ctx.cfg.model);
    const byEcho = new Map<string, { evidenceIds: string[] }>();
    let mismatchCount = 0;
    for (const echo of echoModels) {
      const echoNorm = normalizeModelName(echo.model);
      if (echoNorm !== requestedNorm) mismatchCount += 1;
      const bucket = byEcho.get(echo.model) ?? { evidenceIds: [] };
      bucket.evidenceIds.push(echo.evidenceId);
      byEcho.set(echo.model, bucket);
    }
    metrics['echo_model_mismatch'] = mismatchCount;
    metrics['echo_model_distinct'] = byEcho.size;
    const reqHit = lookupDeclaredModel(anchorPricing, ctx.cfg.model);
    for (const [echo, info] of byEcho) {
      const echoHit = lookupDeclaredModel(anchorPricing, echo);
      if (echoHit !== null && reqHit !== null && reqHit.model.modelRatio > 0) {
        const ratio = echoHit.model.modelRatio / reqHit.model.modelRatio;
        if (ratio < 0.5) {
          const pct = (ratio * 100).toFixed(0);
          score = Math.min(score, PRICING_FAILED_SCORE);
          level = escalate(level, 'fail');
          headline = `响应回显模型「${echo}」公示倍率仅为请求模型「${ctx.cfg.model}」的 ${pct}%，疑似换芯/低价模型冒充`;
          findings.push({
            level: 'fail',
            message:
              `响应回显模型「${echo}」的公示 model_ratio ${echoHit.model.modelRatio} 仅为请求模型「${ctx.cfg.model}」` +
              `（${reqHit.model.modelRatio}）的 ${pct}%（<50%）：疑似用低价/弱模型冒充高价模型，或计价口径被降级（换芯/错配）。`,
            evidenceIds: info.evidenceIds,
          });
        }
        continue;
      }
      // 无公示价可对比 → 只能按模型族名判断是否「完全不同的模型」；同族变体（如 -lite 后缀）不告警。
      const echoFamily = modelFamily(echo);
      const reqFamily = modelFamily(ctx.cfg.model);
      if (echoFamily !== null && echoFamily !== undefined && echoFamily === reqFamily) continue;
      familyMismatchHeadline = `请求模型「${ctx.cfg.model}」的响应回显为其他模型「${echo}」（无公示价可判定换芯，仅披露）`;
      findings.push({
        level: 'warn',
        message:
          `请求模型「${ctx.cfg.model}」的响应回显为「${echo}」，与请求模型名不一致` +
          `（${info.evidenceIds.length} 次样本），且无公示价可判定换芯/降配；仅披露，不单独定罪。`,
        evidenceIds: info.evidenceIds,
      });
      break;
    }
  }

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

  // 输出侧灌水判定（en 轨道，≥3 个可归因样本；zh 仅披露，见 completionSums 注释）。
  const enSums = completionSums.en;
  const completionRatioEn = enSums.samples >= 3 && enSums.local > 0 ? enSums.reported / enSums.local : null;
  metrics['completion_ratio_en'] = completionRatioEn !== null && Number.isFinite(completionRatioEn) ? round(completionRatioEn) : 'N/A';
  metrics['completion_pair_samples_en'] = enSums.samples;
  metrics['completion_excluded_en'] = enSums.excluded;
  const zhSums = completionSums.zh;
  metrics['completion_ratio_zh'] =
    zhSums.samples > 0 && zhSums.local > 0 && Number.isFinite(zhSums.reported / zhSums.local)
      ? round(zhSums.reported / zhSums.local)
      : 'N/A';
  metrics['completion_pair_samples_zh'] = zhSums.samples;
  metrics['completion_excluded_zh'] = zhSums.excluded;
  if (completionRatioEn !== null && Number.isFinite(completionRatioEn)) {
    if (completionRatioEn > COMPLETION_INFLATE_RATIO) {
      findings.push({
        level: 'warn',
        message: `输出侧 completion 合计为正文本地估算的 ×${round(completionRatioEn)}（${enSums.samples} 笔可见 completion 合计 ${enSums.reported} vs 估算合计 ${enSums.local}）：疑似输出 token 灌水。本地估算按 ASCII 4 字符/token（非精确 tokenizer），仅判定 35% 以上的系统性偏大；截断（finish=length）样本已排除，推理份额已按 reasoning_tokens 扣减。`,
        evidenceIds: [...enSums.evidenceIds],
      });
      score = Math.min(score, 70);
      level = escalate(level, 'warn');
      if (level !== 'fail' && headline === defaultHeadline) {
        headline = `输出侧 completion_tokens 为正文估算的 ×${round(completionRatioEn)}，疑似输出 token 灌水`;
      }
    } else if (completionRatioEn < COMPLETION_UNDERREPORT_RATIO) {
      findings.push({
        level: 'info',
        message: `输出侧 completion 合计仅为正文本地估算的 ×${round(completionRatioEn)}：少报方向对用户有利，仅披露不扣分（估算口径见 metrics.completion_ratio_en）。`,
        evidenceIds: [...enSums.evidenceIds],
      });
    }
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

  // 回归块自身的「usage 计数失败」标志位：regressionLevel 的唯一判定来源（见下方定义处注释）。
  // 恒定 usage / R²<0.9 / 斜率越界三处 fail 都置位；价格与回显类判罚不得置位。
  let usageCountFailed = false;
  if (constantUsage) {
    score = 0;
    level = 'fail';
    usageCountFailed = true;
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
        usageCountFailed = true;
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
        usageCountFailed = true;
        headline = `usage 斜率异常（${track.lang} slope=${round(ratio)}）`;
        findings.push({
          level: 'fail',
          message: `${track.lang} 轨道斜率 ${round(ratio)} tokens/估算token，超出合理区间 [0.05, 1.6]，疑似虚增或压缩计费。`,
          evidenceIds: [...track.evidenceIds],
        });
      }
      // 暗插固定 token 判定：回归斜率正常（等比缩放/计数缩放不可见）时，恒定加计只体现在截距上。
      // 仅在线性拟合成立（r2≥0.9）时判——非线性噪声下 x=0 外推不可信（图纸双审必修守卫）。
      if (Number.isFinite(reg.r2) && reg.r2 >= 0.9 && Number.isFinite(reg.intercept) && reg.intercept > INTERCEPT_WARN_TOKENS) {
        findings.push({
          level: 'warn',
          message: `${track.lang} 轨道回归截距 ${round(reg.intercept)} tokens（>${INTERCEPT_WARN_TOKENS}）：各长度档都被恒定加计与输入长度无关的固定 token，疑似暗插系统提示/网关模板固定开销（斜率 ${round(reg.slope)} 正常，等比形状检查无法发现该项）。`,
          evidenceIds: [...track.evidenceIds],
        });
        score = Math.min(score, 70);
        level = escalate(level, 'warn');
        if (level !== 'fail' && headline === defaultHeadline) {
          headline = `usage 回归截距 ${round(reg.intercept)} tokens（${track.lang} 轨道）：疑似暗插固定 token`;
        }
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

  // 实扣倍率判定的回归基准：只认回归块自身的计数失败标志（usageCountFailed），不快照全局
  // level——价格/回显类判罚（expect 倍率不符、公示价偏离、回显换芯 <50%）先于回归块执行，
  // 快照会把它们误并入 regressionLevel，让 decideRatio 误走「usage 回归失败」分支
  //（该分支 ratio>1.5 时 cap=null 不封分），换芯+倍率虚高就封不住 30 分
  //（2026-10-21 真机：换芯 + 1.5× 虚高只打出 billing 70 / 总分 77）。token-reference 的
  // 偏离已有独立 cap 与 headline，金额侧污染走下方 N/A 闸，都不参与本基准。
  const regressionLevel: Level = usageCountFailed ? 'fail' : 'pass';

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
  if (balancePostSettled === false) {
    contaminationReasons.push(
      `序列结束后的余额读数在 ${balanceAfterStable?.polls ?? 0} 次轮询内仍在变化（异步结算延迟或账户级并发流量），实际扣费无法归因到本次窗口`,
    );
  }
  if (balanceBeforeStable !== null && !balancePreClean) {
    contaminationReasons.push(
      `序列开始前的余额读数未即时稳定（${balanceBeforeStable.polls} 次读数仍在变化）：窗口前存在未结算消费或账户级并发流量，Δ起点不可靠，混入旧账会推高倍率`,
    );
  }
  if (topupRequests > 0) {
    findings.push({
      level: 'info',
      message: `应缴金额低于余额最小刻度 3 倍（精度噪声门），已自动补采 ${topupRequests} 笔采样抬升 Δ 至可判定区间：按宣称价预计追加 $${round(topupExpected)}（补采请求已计入审计窗口，真实扣费计入 Δ、声明费计入应缴金额；8 笔与 3× 目标额预算双封顶）。`,
      evidenceIds: [],
    });
  } else if (topupSkipped) {
    findings.push({
      level: 'info',
      message: `应缴金额 ${round(expectedCost)} 低于余额最小刻度 3 倍，且按 ${TOPUP_MAX_REQUESTS} 笔补采上限预估仍无法达到可判定门槛，跳过补采（不为注定 N/A 的窗口付费），实扣倍率按精度噪声作废。`,
      evidenceIds: [],
    });
  }
  let ratioDecision: RatioDecision | null;
  if (balanceEnabled && contaminationReasons.length > 0) {
    metrics['ratio_contaminated'] = 1;
    ratioDecision = {
      verdict: 'N/A',
      maskedVerdict: null,
      cap: null,
      ratio: null,
      finding: {
        level: 'info',
        message: `实扣倍率判定作废：${contaminationReasons.join('；')}。`,
        evidenceIds: [],
      },
    };
  } else {
    ratioDecision = balanceEnabled
      ? decideRatio({
          before: balanceBefore,
          after: balanceAfter,
          spendDelta,
          expectedCost,
          ratioDropped: usageMissing,
          regressionLevel,
          scope: balanceBefore?.endpoint === '/api/user/self' ? 'user' : 'key',
          balanceProbeReason,
        })
      : null;
  }
  if (balanceEnabled) {
    metrics['measured_ratio'] = ratioDecision && ratioDecision.ratio !== null ? round(ratioDecision.ratio) : 'N/A';
    metrics['ratio_masked_verdict'] = ratioDecision ? ratioDecision.maskedVerdict : null;
    metrics['balance_calibrated_unit'] = ratioDecision ? (ratioDecision.calibratedUnit ?? null) : null;
    metrics['balance_calibration_confidence'] = ratioDecision ? (ratioDecision.calibrationConfidence ?? null) : null;
    // 兼容旧键名（蓝图早期口径）：两个 key 同值透出，下游任取其一均可。
    metrics['calibration_confidence'] = ratioDecision ? (ratioDecision.calibrationConfidence ?? null) : null;
    // 校准候选明细只对 raw total_usage 有意义（quota 换算率是公示可信元数据，无候选）。
    const rawCalibrationRan =
      balanceBefore?.unit === 'total_usage_raw' || balanceAfter?.unit === 'total_usage_raw';
    let calibrationCandidates: string | null = null;
    if (
      rawCalibrationRan &&
      balanceBefore !== null &&
      balanceAfter !== null &&
      spendDelta !== null &&
      spendDelta > 0
    ) {
      const calibrationOutcome = calibrateSpendDelta({ before: balanceBefore, after: balanceAfter, spendDelta, expectedCost });
      if (calibrationOutcome.status === 'adopted') {
        metrics['spend_delta'] = round(calibrationOutcome.delta);
        calibrationCandidates = formatCalibrationCandidates(calibrationOutcome.hypotheses);
      } else {
        calibrationCandidates = calibrationOutcome.message ?? '无法校准';
      }
    }
    metrics['balance_calibration_candidates'] = calibrationCandidates;
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

  let ratioHeadlineApplied = false;
  if (ratioDecision) {
    findings.push(ratioDecision.finding);
    const applied = applyRatioDecision(score, level, ratioDecision);
    score = applied.score ?? score;
    level = applied.level;
    // 倍率判定可能把 level 拉到 fail/warn，但 headline 仍停在「线性正常」——必须同步，否则
    // 报表会出现「FAIL 30 + 标题说正常」的自相矛盾（2026-10-18 实测）。
    if (ratioDecision.finding.level === 'fail' || (ratioDecision.finding.level === 'warn' && level === 'warn')) {
      const ratioText = ratioHeadline(ratioDecision, regressionLevel);
      if (ratioText !== null) {
        headline = ratioText;
        ratioHeadlineApplied = true;
      }
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
  // 金额侧状态：ratio_verified 是唯一能证明「实收金额与宣称价一致」的证据（token-reference 不含金额）。
  if (ratioVerified) {
    metrics['money_verified'] = 1;
    metrics['money_check_state'] = 'verified';
  }

  if (level === 'pass' && !absoluteVerified) {
    // 证据分级：billing 的核验对象是端点自报 usage。形状（线性）、内部一致性
    // （total=prompt+completion、非负值）、输出侧（completion 与正文/上限）与恒定检测
    // 全部通过时，按「公示价可得程度」分档给出结论，但一律 ≤85（shape-only）：
    // ×1.3 全量等比缩放或常量偏移只有 --token-reference / 价格+余额对账能识别。
    if (declaredEstimate !== null && declaredEstimate.groupRatioUnverified && effectiveGroup !== null) {
      level = escalate(level, 'warn');
      findings.push({
        level: 'warn',
        message: `声明分组「${effectiveGroup}」未在站点公示分组倍率表中出现：分组折扣/加价无法核验，金额侧按未验证处理（不判罚、仅降档）。`,
        evidenceIds: [],
      });
    }
    if (declaredModel !== null && declaredEstimate !== null && declaredEstimate.state === 'unverified') {
      // quota_type=1（按次计费）：token→quota 换算不成立，不能用 token 形状替代金额核验。
      findings.push({
        level: 'info',
        message:
          'shape-only：站点公示该模型为按次计费（quota_type=1），usage 形状可核验但 token→金额换算不成立，金额侧未验证（不判罚）。',
        evidenceIds: [],
      });
      score = Math.min(score, SHAPE_ONLY_SCORE);
      headline = 'token 形状核验通过';
    } else if (anchorPricing !== null && declaredModel !== null && declaredEstimate !== null) {
      const inputPerM = round(anchorInPerM ?? declaredModel.modelRatio * groupFactor * ratioToUsdPerMillion);
      const outputPerM = round(
        anchorOutPerM ??
          declaredModel.modelRatio * ratioToUsdPerMillion * declaredModel.completionRatio * groupFactor,
      );
      const sourceNote =
        anchorSource === 'public-json'
          ? `公开价表 ${publicResult?.page ?? '?'}（USD 单价）`
          : '站点公示倍率';
      findings.push({
        level: 'info',
        message:
          `shape-only：${sourceNote} 输入 $${inputPerM}/M、输出 $${outputPerM}/M（model_ratio ${declaredModel.modelRatio}、completion_ratio ${declaredModel.completionRatio}；${groupPricingNote}）；` +
          `按价目应扣 $${declaredEstimate.usd !== null ? round(declaredEstimate.usd) : 'N/A'}（估算${
            declaredEstimate.isUpperBound ? '，上界' : ''
          }）；实际扣款未核对。`,
        evidenceIds: [],
      });
      score = Math.min(score, SHAPE_ONLY_SCORE);
      headline = 'token 计数核验通过';
    } else if (quotaPerUnitSynthetic && anchorPricing !== null && declaredModel !== null) {
      score = Math.min(score, SHAPE_ONLY_SCORE);
      headline = 'token 计数核验通过';
    } else if (anchorPricing !== null || declared !== null || publicResult?.state === 'ok') {
      findings.push({
        level: 'info',
        message:
          `shape-only：已读取站点${anchorSource === 'public-json' ? '公开价表' : '公示价表'}，但模型未收录或未采到有效 usage；` +
          'usage 形状通过，金额侧未验证（不判罚），实际扣款未核对。',
        evidenceIds: [],
      });
      score = Math.min(score, SHAPE_ONLY_SCORE);
      headline = 'token 计数核验通过';
    } else {
      findings.push({
        level: 'info',
        message:
          'shape-only：usage 与输入长度线性、内部一致、输出侧无矛盾；未与外部硬证据比对，全量等比缩放（如 ×1.3）或常量偏移不可见。' +
          '绝对对账需 --token-reference 或价格+余额。',
        evidenceIds: [],
      });
      score = Math.min(score, SHAPE_ONLY_SCORE);
      headline = 'token 计数核验通过，未发现造假证据';
    }
  } else if (level === 'pass') {
    findings.push({
      level: 'info',
      message: `absolute：token 估计为保守估算（非精确 tokenizer）；绝对对账依据为${
        referenceVerified ? '参考报告逐档计数' : '价格+余额实扣倍率'
      }，回归仅用于形状核验。`,
      evidenceIds: [],
    });
    headline = referenceVerified
      ? 'Token 计数与长度线性关系正常，且与参考报告逐档计数一致'
      : 'Token 计数与长度线性关系正常，且已完成余额绝对对账';
  }
  // 金额侧证据统一追加在 headline 末尾：固定顺序的实测/估算/N-A/补充说明后缀块。
  const measuredMetric = metrics['measured_ratio'];
  const spendMetric = metrics['spend_delta'];
  const driftUpMetric = metrics['declared_drift_count'];
  const driftDownMetric = metrics['declared_drift_down_count'];
  const moneySide = composeMoneySide({
    priceEnabled,
    balanceEnabled,
    measuredRatio: typeof measuredMetric === 'number' ? measuredMetric : null,
    measuredRatioInHeadline: ratioHeadlineApplied,
    spendDelta: typeof spendMetric === 'number' ? spendMetric : null,
    balanceUnit: balanceBefore?.unit ?? balanceAfter?.unit ?? null,
    // 只有前后两次余额探测都没拿到读数才算「端点不可用」；单侧缺读数/读数不稳是「样本不足」，不得误述端点能力。
    balanceEndpointUnavailable: balanceBeforeStable === null && balanceAfterStable === null,
    balanceUnstable: balanceBeforeStable !== null && !balancePreClean,
    balanceContaminated: metrics['ratio_contaminated'] === 1,
    balanceScope: balanceBefore === null ? null : balanceBefore.endpoint === '/api/user/self' ? 'user' : 'key',
    maskedVerdict: ratioDecision?.maskedVerdict ?? null,
    ratioUnattributable: ratioDecision?.verdict === 'N/A',
    calibratedUnit: ratioDecision?.calibratedUnit ?? null,
    calibrationConfidence: ratioDecision?.calibrationConfidence ?? null,
    anchorInPerM,
    anchorOutPerM,
    claimedRatioIn,
    claimedRatioOut,
    declaredEstimate,
    expectedUsd: declaredUsd,
    expectedQuota:
      declaredEstimate !== null && declaredEstimate.state === 'priced' && anchorSource !== 'public-json' && !quotaPerUnitSynthetic
        ? round(declaredEstimate.quota)
        : null,
    expectedIsUpperBound: declaredEstimate !== null && declaredEstimate.state === 'priced' && declaredEstimate.isUpperBound,
    quotaPerUnitSynthetic,
    publicPrice,
    publicPriceState: publicResult?.state ?? null,
    declaredState: declaredResult.state,
    modelCovered: anchorPricing !== null && declaredModel !== null,
    groupRatioUnverified: groupRatioUnverified || anchorSource === 'public-json',
    chargePerRequest: declaredModel?.quotaType === 1,
    driftUp: typeof driftUpMetric === 'number' ? driftUpMetric : 0,
    driftDown: typeof driftDownMetric === 'number' ? driftDownMetric : 0,
    driftInHeadline: headline.startsWith('站点公示倍率与历史快照相比已变化'),
    absoluteVerified,
  });
  if (moneySide !== '') headline += moneySide;
  // 回显他族模型：finding 已在收集处加入；这里只在 headline 仍为默认/形状结论时披露，并升 warn。
  if (familyMismatchHeadline !== null) {
    level = escalate(level, 'warn');
    if (headline === defaultHeadline || headline.startsWith('token 形状核验通过') || headline.startsWith('token 计数核验通过')) {
      headline = familyMismatchHeadline;
    }
  }
  // 价格账本写入失败/损坏：证据链降级（下次无法自动检测漂移），升 warn 但不封顶分数。
  if (ledgerWriteFailed || ledgerCorruptLines > 0 || ctx.pricingLedgerTailCorrupt === true) {
    level = escalate(level, 'warn');
  }
  // 网页价低信任参照发现显著差异：升 warn，但绝不改 fail、绝不参与漂移历史。
  if (scrapedReferenceEscalated) {
    level = escalate(level, 'warn');
    if (headline === defaultHeadline || headline.startsWith('token 形状核验通过') || headline.startsWith('token 计数核验通过')) {
      headline = '网页公示价与宣称价格存在差异（低信任参照，未作暗扣检测）';
    }
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

/** 公示价压缩为 baseline/账本快照用的 JSON（名字 → [modelRatio, completionRatio, cacheRatio, modelPrice, quotaType]）。 */
function serializeDeclaredModels(declared: DeclaredPricing): string {
  const compact: Record<string, Array<number | null>> = {};
  for (const [name, model] of Object.entries(declared.models)) {
    compact[name] = [model.modelRatio, model.completionRatio, model.cacheRatio, model.modelPrice, model.quotaType];
  }
  return JSON.stringify(compact);
}

/** 漂移项主体：模型级带模型名，全局项（group_ratio）直接用字段名。 */
function driftSubjectText(drift: PricingDrift): string {
  return drift.model !== null ? `${drift.model} ${drift.field}` : drift.field;
}

interface MoneySideArgs {
  priceEnabled: boolean;
  balanceEnabled: boolean;
  measuredRatio: number | null;
  /** 主句已带实扣倍率数字时，后缀块不再重复同一数字（去重方向：保留主句数据，去掉后缀重复项）。 */
  measuredRatioInHeadline: boolean;
  spendDelta: number | null;
  balanceUnit: string | null;
  balanceEndpointUnavailable: boolean;
  balanceUnstable: boolean;
  balanceContaminated: boolean;
  balanceScope: 'key' | 'user' | null;
  maskedVerdict: 'fail' | 'warn' | null;
  ratioUnattributable: boolean;
  calibratedUnit: CalibrationUnit | null;
  calibrationConfidence: CalibrationConfidence | null;
  anchorInPerM: number | null;
  anchorOutPerM: number | null;
  claimedRatioIn: number | null;
  claimedRatioOut: number | null;
  declaredEstimate: DeclaredCostEstimate | null;
  expectedUsd: number | null;
  expectedQuota: number | null;
  expectedIsUpperBound: boolean;
  quotaPerUnitSynthetic: boolean;
  publicPrice: PublicUsdPrice | null;
  publicPriceState: PublicPricingResult['state'] | null;
  declaredState: 'ok' | 'not_applicable' | 'failed';
  modelCovered: boolean;
  groupRatioUnverified: boolean;
  chargePerRequest: boolean;
  driftUp: number;
  driftDown: number;
  driftInHeadline: boolean;
  absoluteVerified: boolean;
}

/** N/A 原因短语：全项目（含 web/app.js 同名常量）复用同一枚举，避免同一缺口出现多种说法。 */
const NA_BALANCE_UNAVAILABLE = '该站没有可用的余额接口';
const NA_BALANCE_UNSTABLE = '余额读数不稳定';
const NA_WINDOW_UNATTRIBUTABLE = '窗口内扣费混入其他消费，无法归因到本次测试';
const NA_QUOTA_PER_UNIT = '站点未公示 quota_per_unit 换算率';
const NA_PUBLIC_RATE = '站点未公示价格';
const NA_MODEL_NOT_LISTED = '价目表中没有这个模型';

/** 一组价格比值文案；输入/输出一致时压缩为单个比值，缺一侧则只列可得的一侧。 */
function formatRatioPair(input: number | null, output: number | null, equalSuffix: string, tag: string | null = null): string {
  if (input === null && output === null) return '';
  // 两个比值来自同一张表的独立字段，理论上可完全相等；用 epsilon 防浮点尾差把「一致」拆成两段。
  if (input !== null && output !== null && Math.abs(input - output) < 1e-9) {
    return `${round(input)}×（${equalSuffix}${tag !== null ? `；${tag}` : ''}）`;
  }
  const parts: string[] = [];
  if (input !== null) parts.push(`输入 ${round(input)}×`);
  if (output !== null) parts.push(`输出 ${round(output)}×`);
  return `${parts.join(' · ')}${tag !== null ? `（${tag}）` : ''}`;
}

/** 列表价折扣文案；它是「公示价 ÷ 列表价」，不是用户宣称价 ÷ 公示价。 */
function formatListRatio(publicPrice: PublicUsdPrice | null): string {
  if (publicPrice === null) return '';
  const ratio = (actual: number, list: number | null): number | null =>
    list !== null && Number.isFinite(actual) && Number.isFinite(list) && actual > 0 && list > 0 ? actual / list : null;
  const input = ratio(publicPrice.inputUsdPerM, publicPrice.listInputUsdPerM);
  const output = ratio(publicPrice.outputUsdPerM, publicPrice.listOutputUsdPerM);
  return formatRatioPair(input, output, '输入/输出一致', '仅披露，未看实扣');
}

/**
 * headline 金额侧标准后缀块。固定顺序：①实扣倍率 ②按价目应扣 ③实扣（与应扣成对披露） ④价目对比/站点现价
 * ⑤价目漂移 ⑥N/A 连原因 ⑦补充说明。每个金额/倍率都带口径标签：
 * 「实测」只用于本轮直接采集的 Δ/回归/绝对对账；公式推算值一律标「估算」，只比价目时标「未看实扣」。
 */
/** 余额侧 N/A 标准原因级联（端点不可用 > 窗口混入 > 读数不稳 > 默认不可归因）。 */
function balanceNaReason(args: MoneySideArgs): string {
  return args.balanceEndpointUnavailable
    ? NA_BALANCE_UNAVAILABLE
    : args.balanceContaminated
      ? NA_WINDOW_UNATTRIBUTABLE
      : args.balanceUnstable
        ? NA_BALANCE_UNSTABLE
        : NA_WINDOW_UNATTRIBUTABLE;
}

export function composeMoneySide(args: MoneySideArgs): string {
  const parts: string[] = [];
  const naItems: string[] = [];
  const safety: string[] = [];
  const up = Math.max(0, Math.trunc(args.driftUp));
  const down = Math.max(0, Math.trunc(args.driftDown));
  const spend = args.spendDelta !== null && Number.isFinite(args.spendDelta) && args.spendDelta > 0 ? args.spendDelta : null;

  // ① 实扣倍率（calibratedUnit 非空时 Δ 为推断口径换算值，换算本身是估算）
  if (args.measuredRatio !== null && !args.measuredRatioInHeadline) {
    const calibrationTag =
      args.calibratedUnit !== null
        ? `（扣费按 ${args.calibratedUnit} 口径换算，置信 ${args.calibrationConfidence ?? 'low'}，换算值为估算）`
        : '';
    parts.push(`实扣倍率 ${round(args.measuredRatio)}×${calibrationTag}`);
  } else if (args.measuredRatio === null && args.balanceEnabled && spend !== null) {
    // Δ 拿到了但倍率算不出：实扣金额已在成对槽位披露，这里只补倍率缺因。
    naItems.push(`实扣倍率无法计算（${balanceNaReason(args)}）`);
  }

  // ② 按价目应扣（公式推算：公示价 × 自报 usage）
  if (args.priceEnabled) {
    if (args.expectedUsd !== null) {
      parts.push(
        `按价目应扣 $${round(args.expectedUsd)}（估算${args.expectedIsUpperBound ? '，上界' : ''}）`,
      );
    } else if (args.expectedQuota !== null) {
      parts.push(
        `按价目应扣 ${round(args.expectedQuota)} quota（估算${args.expectedIsUpperBound ? '，上界' : ''}）`,
      );
    } else if (args.declaredEstimate !== null && args.declaredEstimate.state === 'unverified') {
      // 按次计费无 token→金额换算：不用 N/A 占位，改由补充说明槽说明。
    } else if (!args.modelCovered) {
      const reason = args.publicPriceState === 'failed' || args.declaredState === 'failed' ? NA_PUBLIC_RATE : NA_MODEL_NOT_LISTED;
      naItems.push(`按价目应扣 N/A（${reason}）`);
    } else if (args.quotaPerUnitSynthetic) {
      naItems.push(`按价目应扣 N/A（${NA_QUOTA_PER_UNIT}）`);
    }
  }

  // ③ 实扣（与应扣成对披露）：直接读数标实测；校准采信后的换算值标估算+推断口径
  if (spend !== null) {
    const unitText =
      args.balanceUnit === 'USD' ? ' USD' : args.balanceUnit !== null && args.balanceUnit !== '' ? ` ${args.balanceUnit}` : '';
    if (args.calibratedUnit !== null) {
      parts.push(
        `实扣 ${round(spend)}${unitText}（按 ${args.calibratedUnit} 口径换算的估算值，置信 ${args.calibrationConfidence ?? 'low'}）`,
      );
    } else {
      parts.push(`实扣（实测）${round(spend)}${unitText}`);
    }
  } else if (args.priceEnabled || args.balanceEnabled) {
    parts.push(args.balanceEnabled ? `实扣 N/A（${balanceNaReason(args)}）` : '实扣 未测（默认不读余额）');
  }

  // ④ 价目对比（你填的单价÷站点现价）与站点现价基准
  if (args.priceEnabled) {
    const claimedRatioText = formatRatioPair(args.claimedRatioIn, args.claimedRatioOut, '输入/输出一致', '只比价目，未看实扣');
    if (claimedRatioText !== '') {
      parts.push(`你填的单价÷站点现价 ${claimedRatioText}`);
    } else if (!args.modelCovered) {
      const reason = args.publicPriceState === 'failed' || args.declaredState === 'failed' ? NA_PUBLIC_RATE : NA_MODEL_NOT_LISTED;
      naItems.push(`价目对比 N/A（${reason}）`);
    } else if (args.declaredEstimate !== null && args.declaredEstimate.state === 'unverified') {
      // 按次计费没有 token→金额口径：价目对比不适用，由补充说明槽说明。
    } else if (args.quotaPerUnitSynthetic) {
      naItems.push(`价目对比 N/A（${NA_QUOTA_PER_UNIT}）`);
    } else {
      const listRatioText = formatListRatio(args.publicPrice);
      if (listRatioText !== '') {
        parts.push(`站点现价÷官方列表价 ${listRatioText}`);
      } else {
        naItems.push(`价目对比 N/A（${NA_QUOTA_PER_UNIT}）`);
      }
    }
    if (args.anchorInPerM !== null && args.anchorOutPerM !== null) {
      parts.push(`站点现价：输入 $${round(args.anchorInPerM)}/百万 · 输出 $${round(args.anchorOutPerM)}/百万`);
    } else if (args.quotaPerUnitSynthetic) {
      naItems.push('站点未公示 quota_per_unit 换算率，现价无法换算成美元每百万（可用 --quota-per-usd 提供真实换算率）');
    } else if (args.publicPriceState === 'failed') {
      naItems.push(`站点现价 N/A（${NA_PUBLIC_RATE}，公开价表读取失败）`);
    } else if (args.declaredState === 'failed') {
      naItems.push(`站点现价 N/A（${NA_PUBLIC_RATE}，公示价读取失败）`);
    } else if (!args.modelCovered) {
      naItems.push(`站点现价 N/A（${NA_MODEL_NOT_LISTED}）`);
    } else {
      naItems.push(`站点现价 N/A（${NA_PUBLIC_RATE}）`);
    }
  }

  // ⑤ 公示倍率漂移（主句已述时去重）
  if (!args.driftInHeadline && (up > 0 || down > 0)) {
    const detail = [up > 0 ? `上调 ${up} 项` : null, down > 0 ? `下调 ${down} 项` : null].filter((item) => item !== null).join('·');
    parts.push(`价目与上次快照相比：${detail}`);
  }

  // ⑥ N/A 原因（标准短语）
  parts.push(...naItems);

  // ⑦ 补充说明槽：不可归因 / 用户级口径禁 fail / 按次计费 / 分组未核验 / 价格与余额均未启用时的兜底
  if (args.ratioUnattributable && args.maskedVerdict !== null) {
    safety.push(`实扣倍率异常但说不清是谁多扣的（疑并发消费混入或单位错配），本次不判 fail（底层判定 ${args.maskedVerdict} 记录于 metrics）`);
  }
  if (args.balanceScope === 'user' && args.maskedVerdict !== null) {
    safety.push(`余额为用户级口径（该用户所有 key 共享），无法排除其他 key 的消费，本次不判 fail（底层判定 ${args.maskedVerdict} 记录于 metrics）`);
  }
  if (args.chargePerRequest) safety.push('按次计费，金额未验证');
  if (args.groupRatioUnverified) safety.push('站点分组折扣未知，按无折扣（×1）计算');
  // 实扣状态已随应扣成对披露（③）；仅当价格与余额都未启用、无金额槽位可承载时才在补充说明兜底。
  if (!args.priceEnabled && !args.balanceEnabled) safety.push('实际扣款未核对（默认不读余额）');
  if (!args.absoluteVerified) {
    safety.push('未与外部硬证据比对（实扣倍率、历史用量基准均缺）');
  }
  if (safety.length > 0) parts.push(`补充说明：${safety.join('；')}`);

  return parts.length > 0 ? `；${parts.join('；')}` : '';
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

/**
 * 计费侧余额读数：在 balance.ts 的 BalanceReading 上附加可信换算元数据。
 * quotaToUsd 只由 billing 在 quota / total_usage_raw 口径下注入（来源：/api/status 公示
 * quota_per_unit 或 --quota-per-usd），balance.ts 与 probeBalanceStable 的契约不变。
 */
interface BillingBalanceReading extends BalanceReading {
  quotaToUsd?: number | null;
}

export interface RatioArgs {
  before: BillingBalanceReading | null;
  after: BillingBalanceReading | null;
  spendDelta: number | null;
  expectedCost: number;
  ratioDropped: number;
  regressionLevel: Level;
  /** 余额不可读时的诊断原因（probeBalanceDetailed）：随 N/A finding 一并披露。 */
  balanceProbeReason?: string | null;
  /**
   * 余额口径：'key' = key/请求级端点（new-api /api/usage/token、dashboard 类）；
   * 'user' = 用户级端点（/api/user/self，该用户全部 key 共享）。用户级口径下其他 key 的
   * 离散消费可把 Δ 推入 (1.5,10] 区间——>10 不可归因门兜不住（2026-10-19 图纸双审必修），
   * 故该来源禁出 fail（降为 warn + 披露），定论级指控只允许 key 级口径。缺省按 'key'。
   */
  scope?: 'key' | 'user';
}

export interface RatioDecision {
  verdict: 'N/A' | 'ok' | 'warn' | 'fail';
  /**
   * 保守降级/不可归因掩蔽掉的底层判定档位：ratioDropped>0 按「无缺失」重算出 warn/fail、
   * USD 口径 >10、raw 三口径带外且最接近口径 >10 时非 null。
   * 仅供 CI/报告观测（metrics['ratio_masked_verdict']），不参与合分——
   * 缺失使分母偏小、该判定上偏，直接采信会冤枉端点。
   */
  maskedVerdict: 'fail' | 'warn' | null;
  cap: number | null;
  finding: Finding;
  ratio: number | null;
  /** raw total_usage 单位校准采信的口径（仅 total_usage_raw 且采信时存在）。 */
  calibratedUnit?: CalibrationUnit;
  /** 单位换算置信档：raw 校准采信 / quota 公示换算为 high，同向虚高形态采信为 low。 */
  calibrationConfidence?: CalibrationConfidence;
}

/**
 * 实扣倍率判定矩阵，纯函数便于单测。
 * 判定基于「本次扣费 Δspend ÷ 按宣称价格与端点自报 usage 估算的应缴金额 expectedCost」。
 */
export function decideRatio(args: RatioArgs): RatioDecision | null {
  const { before, after, expectedCost, ratioDropped, regressionLevel, balanceProbeReason } = args;
  const scope = args.scope ?? 'key';
  // 递归重入（ratioDropped>0 时按「无缺失」重算底层档位）必须从原始 Δ 重新校准：
  // 下方单位换算会就地改写 spendDelta，若把已换算值再传进来会被二次换算。
  const rawSpendDelta = args.spendDelta;
  let spendDelta = rawSpendDelta;
  let calibratedUnit: CalibrationUnit | null = null;
  let calibrationConfidence: CalibrationConfidence | null = null;
  let calibrationOutcome: CalibrationOutcome | null = null;
  // 证据不足一律 N/A + info，不加罚
  if (before === null || after === null) {
    const detail =
      balanceProbeReason !== null && balanceProbeReason !== undefined && balanceProbeReason !== ''
        ? `探测原因：${balanceProbeReason}。`
        : '';
    return na(
      '余额端点不可用或返回未知 schema（如余额接口返回不可解析结构）：无法建立可比余额读数，实扣倍率无法验证' +
        '（中转站可通过禁用/改写余额接口规避此项，建议在其后台人工核对）。' +
        detail,
    );
  }
  if (spendDelta === null) {
    return na('两次余额查询不同源（endpoint/kind/unit 不一致，可能被路由到不同后端），无法作差计算实扣倍率。');
  }
  if (spendDelta === 0) {
    return na('审计窗口内余额差值 Δ=0：余额粒度不足或消费延迟入账，实扣倍率无法计算。');
  }
  if (spendDelta < 0) {
    return na(`审计窗口内余额不降反升（Δ=${round(spendDelta)}）：疑有充值干扰，实扣倍率判定作废。`);
  }
  let resolution = Math.max(
    Number.isFinite(before.resolution) ? (before.resolution as number) : 0,
    Number.isFinite(after.resolution) ? (after.resolution as number) : 0,
  );
  if (before.unit !== 'USD' || after.unit !== 'USD') {
    if (before.unit === 'total_usage_raw' && after.unit === 'total_usage_raw') {
      // raw 口径：以应缴金额为锚在 分位/同单位/quota 三种刻度假设中择近（total_usage 的单位因站点而异，
      // 无法从前缀判定）；采信后 Δ/resolution 同步换算为同一计价单位，后续判定与同单位口径完全一致。
      const outcome = calibrateSpendDelta({ before, after, spendDelta, expectedCost });
      calibrationOutcome = outcome;
      if (outcome.status !== 'adopted') {
        const winner =
          outcome.unit !== null ? (outcome.hypotheses.find((hypothesis) => hypothesis.unit === outcome.unit) ?? null) : null;
        // 带外分支同样先过精度噪声门：1-2 个刻度的 Δ 不能因为「相对应缴看起来 >10×」就出 warn。
        const outOfBandResolution = outcome.resolution;
        if (
          winner !== null &&
          outcome.status === 'out_of_band' &&
          outOfBandResolution > 0 &&
          (winner.delta < 3 * outOfBandResolution || expectedCost < 3 * outOfBandResolution)
        ) {
          return na(
            `审计窗口内余额差值 Δ=${round(winner.delta)} 或应缴金额 ${round(expectedCost)} 低于余额读数最小分辨率（${round(outOfBandResolution)}）的 3 倍：` +
              '无法区分真实扣费与读数精度噪声，实扣倍率无法判定（可增大审计窗口或改用 token-reference 对账）。',
          );
        }
        if (outcome.status === 'out_of_band' && winner !== null && winner.ratio > 10) {
          // 三口径全部落在可信带外、且最接近口径仍 >10×：与 USD 口径的 >10 分支同一语义——
          // 账户级并发/单位错配无法归因，保留原始倍率与底层 fail 档位，但不判 fail。
          return {
            verdict: 'N/A',
            maskedVerdict: 'fail',
            cap: null,
            ratio: winner.ratio,
            finding: {
              level: 'warn',
              message:
                `${outcome.message ?? ''} 最接近口径（${winner.unit}）倍率 ${round(winner.ratio)} 远超应缴金额：` +
                '无法归因到本次审计（疑账户级并发消费或余额单位错配），本次不判 fail；请确认审计窗口独占、余额单位一致，或人工核对该站账单。',
              evidenceIds: [],
            },
          };
        }
        return na(outcome.message ?? 'total_usage 单位口径无法校准：本次不判定，请人工核对账单。');
      }
      spendDelta = outcome.delta;
      resolution = outcome.resolution;
      calibratedUnit = outcome.unit;
      calibrationConfidence = outcome.confidence;
    } else if (before.unit === 'quota' && after.unit === 'quota') {
      // quota 口径：换算率来自站点 /api/status 的 quota_per_unit 或 --quota-per-usd（可信元数据）。
      const quotaToUsd = firstFinitePositive(before.quotaToUsd, after.quotaToUsd);
      if (quotaToUsd === null) {
        return na(
          '余额读数单位为 quota，与宣称价不是同一单位，且未拿到站点公示的换算率（quota→计价单位），无法与应缴金额作比。' +
            '可用 --quota-per-usd <n> 打开换算（站点 /api/status 公示 quota_per_unit 时也会自动启用）。',
        );
      }
      spendDelta = spendDelta * quotaToUsd;
      resolution = resolution * quotaToUsd;
      calibrationConfidence = 'high';
    } else {
      // 其他无法换算的单位（或前后单位不一致）：expectedCost 与宣称价同单位，直接作比会产出
      // 天文/荒谬倍率，必须整体作废而非出 warn。
      return na(
        `余额读数单位为 ${before.unit === after.unit ? before.unit : `${before.unit}/${after.unit}`}，与宣称价既不同单位也无公示换算率，` +
          '无法与应缴金额作比（工具只做同单位比值，不做币种换算），实扣倍率判定作废。',
      );
    }
  }
  const calibration: { calibratedUnit?: CalibrationUnit; calibrationConfidence?: CalibrationConfidence } = {};
  if (calibratedUnit !== null) calibration.calibratedUnit = calibratedUnit;
  if (calibrationConfidence !== null) calibration.calibrationConfidence = calibrationConfidence;
  const lowConfidenceNote =
    calibrationOutcome !== null && calibrationOutcome.confidence === 'low'
      ? calibrationLowConfidenceNote(calibrationOutcome)
      : '';
  const inferredNote =
    calibratedUnit !== null
      ? `（Δ 单位按推断口径 ${calibratedUnit} 采信，置信 ${calibrationConfidence ?? 'low'}；换算后金额为估算）`
      : '';
  const calibrationNote = `${inferredNote}${lowConfidenceNote}`;
  const finalize = (decision: RatioDecision): RatioDecision => {
    const withCalibration: RatioDecision = { ...decision, ...calibration };
    if (calibrationNote === '') return withCalibration;
    return {
      ...withCalibration,
      finding: { ...withCalibration.finding, message: `${withCalibration.finding.message}${calibrationNote}` },
    };
  };
  if (resolution > 0 && spendDelta < 3 * resolution) {
    // 精度噪声门：Δ 只有零点几个最小刻度时，无法区分「真实小额扣费」与「读数舍入噪声」，
    // 采信会产生离谱倍率（Δ=0.01/res=0.01 → ratio 任意大），必须 N/A。
    return na(
      `审计窗口内余额差值 Δ=${round(spendDelta)} 低于余额读数最小分辨率（${round(resolution)}）的 3 倍，` +
        '无法区分真实扣费与读数精度噪声，实扣倍率无法判定（可增大审计窗口或改用 token-reference 对账）。',
    );
  }
  if (expectedCost <= 0) {
    return na('无有效 usage 记录，无法估算应缴金额，实扣倍率无法计算。');
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
    return na(`实扣倍率计算结果越界（${String(ratio)}）：余额读数或 usage 数值异常，无法判定。`);
  }
  if (ratioDropped > 0) {
    // 有意设计的保守降级（防误报）：缺失使分母偏小、实扣倍率上偏，上偏的 ratio 出 fail 恰会冤枉端点，
    // 故任何缺失都以 info 收场，不进入任何 fail/warn 判定（含下方回归 fail 分支——此时偏差方向不可知）。
    // 但不掩盖事实：按「无缺失」假设重算底层档位，经 maskedVerdict/metrics 透出供 CI 观测。
    // 注意传原始 Δ：本函数会对 raw/quota 重新校准，传已换算值会被二次换算。
    const underlying = decideRatio({
      before,
      after,
      spendDelta: rawSpendDelta,
      expectedCost,
      ratioDropped: 0,
      regressionLevel,
      scope,
    });
    const masked =
      underlying !== null && (underlying.verdict === 'fail' || underlying.verdict === 'warn')
        ? underlying.verdict
        : (underlying?.maskedVerdict ?? null);
    return finalize({
      verdict: 'ok',
      maskedVerdict: masked,
      cap: null,
      ratio,
      finding: {
        level: 'info',
        message:
          `${ratioDropped} 笔请求 usage 缺失，实扣倍率分母偏小、结果上偏，仅作参考不出判定` +
          (masked !== null ? `（按无缺失重算底层档位为 ${masked}，因上偏不采信）。` : '。'),
        evidenceIds: [],
      },
    });
  }
  if (ratio > 10) {
    // 余额差值是账户级口径：10 倍以上更可能是窗口内其他并发消费、充值/退款混入或单位错配，
    // 无法归因到本次审计。保留原始倍率与 maskedVerdict 供复核，但不判 fail（防冤枉端点）。
    return finalize({
      verdict: 'N/A',
      maskedVerdict: 'fail',
      cap: null,
      ratio,
      finding: {
        level: 'warn',
        message:
          `实扣倍率 ${round(ratio)} 远超本次应缴金额（Δ=${round(spendDelta)}，应缴=${round(expectedCost)}）：` +
          '余额差值为账户级口径，无法区分真实超高计费与窗口内其他并发消费/余额单位错配，本次不判 fail；' +
          '请确认审计窗口独占、余额单位一致，或人工核对该站账单。',
        evidenceIds: [],
      },
    });
  }
  if (regressionLevel === 'fail') {
    // usage 回归失败 → usage 虚增只会压小 ratio，ratio 是真实倍率的下限
    if (ratio > 1.5) {
      if (scope === 'user') {
        return finalize({
          verdict: 'warn',
          maskedVerdict: 'fail',
          cap: 70,
          ratio,
          finding: {
            level: 'warn',
            message: `实扣倍率 ${round(ratio)} > 1.5，但余额来源为用户级口径（/api/user/self，该用户全部 key 共享 Δ）：无法排除其他 key 并发消费混入，按不诬告原则降为 warn（底层档位 fail 仅记录于 metrics），建议以 key 级余额端点复测。`,
            evidenceIds: [],
          },
        });
      }
      return finalize({
        verdict: 'fail',
        maskedVerdict: null,
        cap: null,
        ratio,
        finding: {
          level: 'fail',
          message: `即便按端点自报 usage 计算，扣费仍超宣称 1.5 倍（实扣倍率 ${round(ratio)}）；usage 不可信时真实倍率更高。`,
          evidenceIds: [],
        },
      });
    }
    return finalize({
      verdict: 'ok',
      maskedVerdict: null,
      cap: null,
      ratio,
      finding: {
        level: 'info',
        message: `usage 回归失败（计数不可信），按自报 usage 计算的倍率 ${round(ratio)} 未超 1.5，倍率无法判定。`,
        evidenceIds: [],
      },
    });
  }
  if (ratio > 1.5) {
    if (scope === 'user') {
      return finalize({
        verdict: 'warn',
        maskedVerdict: 'fail',
        cap: 70,
        ratio,
        finding: {
          level: 'warn',
          message: `实扣倍率 ${round(ratio)} > 1.5：实际扣费显著高于按宣称价格与自报 usage 的应缴金额；但余额来源为用户级口径（/api/user/self，该用户全部 key 共享 Δ），无法排除其他 key 并发消费混入，按不诬告原则降为 warn（底层档位 fail 仅记录于 metrics），建议以 key 级余额端点复测。`,
          evidenceIds: [],
        },
      });
    }
    return finalize({
      verdict: 'fail',
      maskedVerdict: null,
      cap: 30,
      ratio,
      finding: {
        level: 'fail',
        message: `实扣倍率 ${round(ratio)} > 1.5：实际扣费显著高于按宣称价格与自报 usage 的应缴金额，计费虚高（本结论以「宣称价与余额读数同单位」为前提：若填入的价格被换算成了另一种币种，请照抄站方价目表原值复测）。`,
        evidenceIds: [],
      },
    });
  }
  if (ratio > 1.1) {
    return finalize({
      verdict: 'warn',
      maskedVerdict: null,
      cap: 70,
      ratio,
      finding: {
        level: 'warn',
        message: `实扣倍率 ${round(ratio)} 落在 (1.1, 1.5]：实际扣费高于宣称价格，存在加价嫌疑（若宣称价与余额读数不是同一单位，请照抄站方价目表原值核对）。`,
        evidenceIds: [],
      },
    });
  }
  if (ratio >= 0.8) {
    return finalize({
      verdict: 'ok',
      maskedVerdict: null,
      cap: null,
      ratio,
      finding: {
        level: 'info',
        message: `实扣倍率 ${round(ratio)} 落在 [0.8, 1.1]：与宣称价格基本一致。`,
        evidenceIds: [],
      },
    });
  }
  if (ratio >= 0.5) {
    // 低报 20%-50% 不能算「一致」：可能是 usage 少计、价格/余额单位错配或账户级抵扣。
    // 不判 fail（方向对用户有利且账户级噪声未知），但必须 warn 阻止 PASS。
    return finalize({
      verdict: 'warn',
      maskedVerdict: null,
      cap: null,
      ratio,
      finding: {
        level: 'warn',
        message: `实扣倍率 ${round(ratio)} 落在 [0.5, 0.8)：实际扣费低于按宣称价格与自报 usage 的应缴金额，疑 usage 少计、价格/余额单位错配或账户级抵扣，请人工核对。`,
        evidenceIds: [],
      },
    });
  }
  return finalize({
    verdict: 'warn',
    maskedVerdict: null,
    cap: null,
    ratio,
    finding: {
      level: 'warn',
      message: `实扣倍率 ${round(ratio)} < 0.5：疑宣称价与余额读数不同单位（最常见是把价格换算成了另一种币种）、usage 少计或余额精度不足，请照抄站方价目表原值核对（工具只作同单位比值，不做币种换算）。`,
      evidenceIds: [],
    },
  });
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
 * 实扣倍率对应的 headline（与 finding 同级）：主句带原始倍率数字（数据支撑），后缀块去重。
 * fail 必须说明「扣费高于应缴」，warn 必须说明偏高/偏低方向；info/ok 返回 null（不覆盖回归结论）。
 * 校准采信时 Δ 是推断口径换算出的估算值，主句不得再用「实测」修饰。
 */
export function ratioHeadline(decision: RatioDecision, regressionLevel: Level): string | null {
  if (decision.ratio === null) return null;
  const calibrated = decision.calibratedUnit !== undefined && decision.calibratedUnit !== null;
  const subject = calibrated ? `换算后的实扣倍率 ${round(decision.ratio)} 倍` : `实际扣费是应缴的 ${round(decision.ratio)} 倍`;
  if (decision.verdict === 'N/A') {
    return `${subject}，异常但说不清是谁多扣的（疑并发消费混入或余额单位错配），本次不判 fail`;
  }
  if (decision.finding.level === 'fail') {
    const suffix = regressionLevel === 'fail' ? '；token 计数也有问题' : '';
    return `${subject}，计费虚高（判据 >1.5 倍）${suffix}`;
  }
  if (decision.finding.level === 'warn') {
    return decision.ratio < 0.5
      ? `${subject}，异常偏低，疑价格/余额单位填错`
      : `${subject}，高于你填的价格，有加价嫌疑`;
  }
  return null;
}

export function meanY(ys: readonly number[]): number {
  return mean(ys);
}
