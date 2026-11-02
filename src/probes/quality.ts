import type { ChatMessage, ChatRequest, Finding, ProbeCtx, ProbeOutcome, Rng } from '../types.js';
import { recordCall } from '../evidence.js';
import { exactMcNemarP, wilsonLowerBound, wilsonUpperBound } from '../stats.js';
import { PROBE_BUDGETS, chatWithStarveRetry, isStarved, isBlankAnswer } from './starve.js';

export interface Question {
  id: string;
  prompt: string;
  answer: number;
  exclusive: number[] | null;
  control: boolean;
}

export function generateQuestions(rng: Rng): Question[] {
  const questions: Question[] = [];

  const mulAdd = { a: rng.int(23, 97), b: rng.int(13, 79), c: rng.int(5, 45) };
  questions.push({
    id: 'mul-add',
    prompt: `计算 ${mulAdd.a} × ${mulAdd.b} + ${mulAdd.c} 的值。只回答最终数字。`,
    answer: mulAdd.a * mulAdd.b + mulAdd.c,
    exclusive: null,
    control: false,
  });

  const mul = { a: rng.int(17, 89), b: rng.int(14, 66) };
  questions.push({
    id: 'mul',
    prompt: `一箱有 ${mul.a} 个苹果，${mul.b} 箱共有多少个？只回答数字。`,
    answer: mul.a * mul.b,
    exclusive: null,
    control: false,
  });

  const mod = { a: rng.int(200, 900), b: rng.int(7, 23) };
  questions.push({
    id: 'mod',
    prompt: `${mod.a} 除以 ${mod.b} 的余数是多少？只回答数字。`,
    answer: mod.a % mod.b,
    exclusive: null,
    control: false,
  });

  const seq = { x: rng.int(11, 60), d: rng.int(4, 15) };
  questions.push({
    id: 'seq',
    prompt: `数列 ${seq.x}, ${seq.x + seq.d}, ${seq.x + 2 * seq.d}, ${seq.x + 3 * seq.d} 的下一项是多少？只回答数字。`,
    answer: seq.x + 4 * seq.d,
    exclusive: null,
    control: false,
  });

  const even = 2 * rng.int(20, 90);
  const odd1 = 2 * rng.int(20, 90) + 1;
  const odd2 = 2 * rng.int(20, 90) + 1;
  const evenList = rng.shuffle([even, odd1, odd2]);
  questions.push({
    id: 'even',
    prompt: `以下哪个数是偶数：${evenList.join(', ')}？只回答那一个数字。`,
    answer: even,
    exclusive: [odd1, odd2],
    control: false,
  });

  const cmp = { a: rng.int(31, 80), b: rng.int(31, 80), c: rng.int(31, 80), d: rng.int(31, 80) };
  const left = cmp.a + cmp.b;
  let right = cmp.c + cmp.d;
  if (right === left) right += 1;
  questions.push({
    id: 'compare',
    prompt: `比较这两组数的和：${cmp.a} + ${cmp.b} 与 ${cmp.c} + ${cmp.d}，哪一组更大？只回答较大的那个和。`,
    answer: Math.max(left, right),
    exclusive: null,
    control: false,
  });

  const count = rng.int(7, 12);
  const letters = 'abcdefghijklmnopqrstuvwyz'.split('');
  const pool: string[] = [];
  for (let i = 0; i < count; i += 1) pool.push('x');
  while (pool.length < 40) pool.push(rng.pick(letters));
  const target = rng.shuffle(pool).join('');
  questions.push({
    id: 'count',
    prompt: `字符串 "${target}" 中包含几个字符 x（小写字母 x）？只回答数字。`,
    answer: count,
    exclusive: null,
    control: false,
  });

  const dbl = rng.int(30, 90);
  questions.push({
    id: 'double',
    prompt: `Multiply ${dbl} by 2 and then subtract 7. Answer with the number only.`,
    answer: dbl * 2 - 7,
    exclusive: null,
    control: false,
  });

  const days = rng.int(4, 60);
  questions.push({
    id: 'days',
    prompt: `${days} days equal how many hours? Answer with the number only.`,
    answer: days * 24,
    exclusive: null,
    control: false,
  });

  const json = { a: rng.int(120, 900), b: rng.int(11, 110) };
  questions.push({
    id: 'json-sub',
    prompt: `Given the JSON {"a": ${json.a}, "b": ${json.b}}, what is a minus b? Answer with the number only.`,
    answer: json.a - json.b,
    exclusive: null,
    control: false,
  });

  const area = { a: rng.int(17, 80), b: rng.int(11, 40) };
  questions.push({
    id: 'area',
    prompt: `一个长方形长 ${area.a} 宽 ${area.b}，面积是多少？只回答数字。`,
    answer: area.a * area.b,
    exclusive: null,
    control: false,
  });

  const pct = { a: rng.int(2, 9) * 100, p: rng.pick([15, 25, 35, 45]) };
  questions.push({
    id: 'percent',
    prompt: `${pct.a} 的 ${pct.p}% 是多少？只回答数字。`,
    answer: (pct.a * pct.p) / 100,
    exclusive: null,
    control: false,
  });

  const add1 = { a: rng.int(3, 9), b: rng.int(3, 9) };
  questions.push({
    id: 'control-add',
    prompt: `${add1.a} + ${add1.b} 等于多少？只回答数字。`,
    answer: add1.a + add1.b,
    exclusive: null,
    control: true,
  });
  questions.push({
    id: 'control-months',
    prompt: '一年有几个月？只回答数字。',
    answer: 12,
    exclusive: null,
    control: true,
  });
  const mul1 = { a: rng.int(2, 9), b: rng.int(2, 9) };
  questions.push({
    id: 'control-mul',
    prompt: `${mul1.a} × ${mul1.b} 等于多少？只回答数字。`,
    answer: mul1.a * mul1.b,
    exclusive: null,
    control: true,
  });

  return rng.shuffle(questions);
}

export function checkAnswer(text: string, question: Question): boolean {
  // 千分位逗号归一：模型常答 "7,718"，按 -?\d+ 切分会拆成 7 和 718 两个数，漏判正确答案。
  const normalized = text.replace(/\d{1,3}(?:,\d{3})+/g, (m) => m.replace(/,/g, ''));
  // 小数必须整体解析：整数题答 "42.5" 不能因包含 42 而被判对（旧 -?\d+ 只是截断整数部分）。
  const numbers = [...normalized.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  const hasAnswer = numbers.includes(question.answer);
  // 否定语境（"不是 42，是 43" / "11（不是 12）"）：正确答案只出现在被否定的位置时不算答对，
  // 否则答错的端点会被「排除法复述」洗白。仍保留原有宽松口径（"7,718 或 9,999" 计对）：
  // 题面要求只回答数字，多写的数字不单独定罪，只要有一处肯定作答即计对。
  let answerAffirmed = false;
  for (const match of normalized.matchAll(/-?\d+(?:\.\d+)?/g)) {
    if (Number(match[0]) !== question.answer) continue;
    const before = normalized.slice(Math.max(0, match.index - 8), match.index);
    const after = normalized.slice(match.index + match[0].length, match.index + match[0].length + 2);
    if (NEGATED_BEFORE.test(before)) continue;
    // 答案后紧跟问号属复述题面（"42? not 42, is 43"），不算模型自己的肯定作答。
    if (/^[?？]/.test(after)) continue;
    answerAffirmed = true;
  }
  if (hasAnswer && !answerAffirmed) {
    // 答案只出现在否定/复述位置（"不是 42"、"42? not 42"）：没有任何一处肯定作答，不算答对。
    return false;
  }
  if (question.exclusive && question.exclusive.length > 0) {
    const hasDistractor = question.exclusive.some((d) => numbers.includes(d));
    return hasAnswer && !hasDistractor;
  }
  return hasAnswer;
}

const NEGATED_BEFORE = /(?:不是|并非|而不是|而非|非|not|isn'?t|no)\s*$/i;

/** 剔除后有效分母低于原主问题数的 80% → 不再出分（样本太少，比例无统计意义），判 insufficient。 */
const MIN_USABLE_RATIO = 0.8;

interface MainFirstSample {
  question: Question;
  /** 多轮题集下的唯一样本标识：单轮 = 题 id，多轮 = r<轮次>/<题 id>（findings/证据/参考配对统一口径）。 */
  sampleId: string;
  correct: boolean;
  evidenceIds: string[];
}

interface ReferenceAssessment {
  metrics: Record<string, number | string | null>;
  findings: Finding[];
  systematicLevel: 'warn' | 'fail' | null;
}

async function assessQualityReference(
  ctx: ProbeCtx,
  mainFirst: readonly MainFirstSample[],
): Promise<ReferenceAssessment> {
  const metrics: Record<string, number | string | null> = {
    reference_configured: 0,
    reference_main: '0/0',
    reference_delta: 0,
    reference_systematic: 0,
    reference_discordant: 0,
    reference_main_better: 0,
    reference_ref_better: 0,
    reference_mcnemar_p: null,
  };
  const findings: Finding[] = [];
  if (ctx.referenceClient === null || ctx.referenceClient === undefined || !ctx.referenceModel) {
    return { metrics, findings, systematicLevel: null };
  }

  metrics['reference_configured'] = 1;
  const referenceCtx: ProbeCtx = {
    ...ctx,
    client: ctx.referenceClient,
    referenceClient: null,
    referenceModel: null,
    endpoint: 'reference',
    cfg: { ...ctx.cfg, model: ctx.referenceModel },
  };
  let pairedUsable = 0;
  let referenceCorrect = 0;
  let pairedMainCorrect = 0;
  let mainBetter = 0;
  let referenceBetter = 0;
  const mismatchIds: string[] = [];
  const mismatchEvidenceIds: string[] = [];
  const unusableIds: string[] = [];

  // 逐样本配对：多轮题集下同一题 id 会出现多次（不同题面），以 sampleId 区分；
  // 参考端点对与主端点拿到有效首答的完全同一批题面作答。
  for (const mainSample of mainFirst) {
    const question = mainSample.question;
    const messages: ChatMessage[] = [{ role: 'user', content: question.prompt }];
    const call = await chatWithStarveRetry(referenceCtx, {
      probe: 'quality',
      label: `reference main ${mainSample.sampleId}`,
      buildRequest: (maxTokens) => ({
        model: ctx.referenceModel as string,
        messages,
        temperature: 0,
        max_tokens: maxTokens,
      }),
      budget: PROBE_BUDGETS.quality,
      retryBudget: PROBE_BUDGETS.qualityRetry,
    });
    if (!call.result.ok || call.starved || isBlankAnswer(call.result)) {
      unusableIds.push(mainSample.sampleId);
      continue;
    }
    pairedUsable += 1;
    const referenceHit = checkAnswer(call.result.text, question);
    if (referenceHit) referenceCorrect += 1;
    if (mainSample.correct) pairedMainCorrect += 1;
    if (referenceHit !== mainSample.correct) {
      mismatchIds.push(mainSample.sampleId);
      mismatchEvidenceIds.push(...mainSample.evidenceIds, ...call.evidenceIds);
      if (referenceHit) referenceBetter += 1;
      else mainBetter += 1;
    }
  }

  const delta = pairedMainCorrect - referenceCorrect;
  metrics['reference_main'] = `${referenceCorrect}/${pairedUsable}`;
  metrics['reference_delta'] = delta;
  if (pairedUsable === 0) {
    findings.push({
      level: 'warn',
      message: unusableIds.length > 0
        ? `参考端点未返回可配对的首答（${unusableIds.join('、')} 为空响应、截断或请求失败）：本轮不据此判定质量。`
        : '主端点和参考端点没有共同有效样本：本轮不据此判定质量。',
      evidenceIds: [],
    });
    return { metrics, findings, systematicLevel: null };
  }

  if (mismatchIds.length > 0) {
    findings.push({
      level: 'info',
      message: `主/参考首答差异 ${mismatchIds.length} 题（${mismatchIds.join('、')}）；单题差异仅披露，不单独定级。`,
      evidenceIds: mismatchEvidenceIds,
    });
  }
  if (unusableIds.length > 0) {
    findings.push({
      level: 'info',
      message: `参考端点 ${unusableIds.length} 题无有效首答（${unusableIds.join('、')}），已从配对分母剔除，不按答错计分。`,
      evidenceIds: [],
    });
  }

  const deficit = referenceCorrect - pairedMainCorrect;
  const relativeDeficit = referenceCorrect > 0 ? deficit / referenceCorrect : 0;
  // McNemar 精确单侧检验：把配对分歧样本（discordant = 恰好一侧答对的题数）放到「两侧无差异」的
  // Binomial(0.5) 零假设下，问 reference 多对 ≥ referenceBetter 题的概率。数量门槛（少对 ≥3 题且
  // 相对差距 ≥25%）之外再要求统计显著性（p ≤ 0.15）才升级系统性差分——小样本运气差分或
  // 反向分歧共存（主端点也有多对）时 p 会变大，避免假定罪；fail（定论级）要求更强显著性 p ≤ 0.05。
  const discordant = mainBetter + referenceBetter;
  const mcnemarP = exactMcNemarP(discordant, referenceBetter);
  metrics['reference_discordant'] = discordant;
  metrics['reference_main_better'] = mainBetter;
  metrics['reference_ref_better'] = referenceBetter;
  metrics['reference_mcnemar_p'] = Math.round(mcnemarP * 10000) / 10000;
  const systematic = deficit >= 3 && relativeDeficit >= 0.25 && mcnemarP <= 0.15;
  metrics['reference_systematic'] = systematic ? 1 : 0;
  if (!systematic) return { metrics, findings, systematicLevel: null };

  const referenceAccuracy = referenceCorrect / pairedUsable;
  const mainAccuracy = pairedMainCorrect / pairedUsable;
  const systematicLevel =
    referenceAccuracy >= 0.9 && mainAccuracy < 0.6 && mcnemarP <= 0.05 ? 'fail' : 'warn';
  findings.push({
    level: systematicLevel,
    message:
      `参考端点首答 ${referenceCorrect}/${pairedUsable}，主端点首答 ${pairedMainCorrect}/${pairedUsable}；` +
      `主端点少对 ${deficit} 题（相对差距 ${(relativeDeficit * 100).toFixed(1)}%，` +
      `配对分歧 ${discordant} 题中参考多对 ${referenceBetter} 题、主端点多对 ${mainBetter} 题，` +
      `McNemar 精确检验 p=${mcnemarP.toFixed(4)}），构成系统性质量差分。`,
    evidenceIds: mismatchEvidenceIds,
  });
  return { metrics, findings, systematicLevel };
}

export async function probeQuality(ctx: ProbeCtx): Promise<ProbeOutcome> {
  const findings: Finding[] = [];
  const metrics: Record<string, number | string | null> = {};
  // 题集轮数：缺省 1 轮（12 主问题 + 3 控制题）；--deep 3 轮；显式 --quality-samples 优先。
  // 每轮沿同一 rng 顺序生成一套全新程序化题面（同 seed 可复现），多轮聚合 pass@1——
  // 把单轮 12 题的小样本运气升级为统计上更稳的结论；控制题逐轮重新生成，仍须全对。
  const qualityRounds = ctx.cfg.qualitySamples ?? (ctx.cfg.deep ? 3 : 1);
  // 采样计划先行展开：逐轮生成题集；多轮时用 r<轮次>/ 前缀区分同 id 的不同题面。
  const plan: Array<{ question: Question; sampleId: string }> = [];
  for (let round = 0; round < qualityRounds; round += 1) {
    const prefix = qualityRounds > 1 ? `r${round + 1}/` : '';
    for (const question of generateQuestions(ctx.rng)) {
      plan.push({ question, sampleId: `${prefix}${question.id}` });
    }
  }

  let controlCorrect = 0;
  let mainCorrect = 0;
  let mainTotal = 0;
  let controlTotal = 0;
  let excluded = 0;
  let unavailableSamples = 0;
  let emptySamples = 0;
  let mainEmpty = 0;
  let controlEmpty = 0;
  let controlStarved = 0;
  // v0.2.2 两次机会口径：retriedCount = 触发复采样的主问题数（含复采样失败/starved 的），
  // recoveredCount = 复采样答对（按正确计）的主问题数。
  let retriedCount = 0;
  let recoveredCount = 0;
  let blankRetriedCount = 0;
  let streamFallbackCount = 0;
  const streamFallbackEvidenceIds: string[] = [];
  const wrong: string[] = [];
  const mainFirst: MainFirstSample[] = [];

  for (const { question, sampleId } of plan) {
    if (question.control) controlTotal += 1;
    else mainTotal += 1;
    const messages: ChatMessage[] = [{ role: 'user', content: question.prompt }];
    // 预算实测：thinking 模型在 64 tokens 下推理即占满预算（content 空/截断），256 基本可用，仍截断升 512 重试一次。
    const call = await chatWithStarveRetry(ctx, {
      probe: 'quality',
      label: `${question.control ? 'control' : 'main'} ${sampleId}`,
      buildRequest: (maxTokens) => ({ model: ctx.cfg.model, messages, temperature: 0, max_tokens: maxTokens }),
      budget: PROBE_BUDGETS.quality,
      retryBudget: PROBE_BUDGETS.qualityRetry,
    });
    if (call.blankRetried) blankRetriedCount += 1;
    if (call.streamFallback) {
      streamFallbackCount += 1;
      streamFallbackEvidenceIds.push(...call.evidenceIds);
    }
    // 判定契约：
    // ① starved（finish=length）但答案已出现在（截断）正文中 → 正常计对；
    // ② 重试后仍 starved 且无答案 → 该题剔除分母 + warn（证据不足，不得按答错计 0）；
    // ③ 请求未成功（传输故障/5xx/上游错误载荷/非尺寸类 4xx）→ 同样剔除分母（证据不足），
    //    只有「拿到答案且答错」才计错。历史缺陷（层 3 审查）：请求失败原被计为答错，
    //    在有效样本刚过 MIN_USABLE_RATIO 的窄带里（n=15 时可用 12~14）可把正确率压到 <40
    //    触发质量硬红线封顶 45 —— 用「没答上来」冒充「答错了」属诬告。
    //    （控制题全对只能排除整体故障，不能排除「长题被拒/长题网络失败」的选择性失败。）
    const starved = call.starved;
    const unavailable = !call.result.ok;
    const blank = isBlankAnswer(call.result);
    const hit = checkAnswer(call.result.text, question);
    const label = `${question.control ? '控制题' : '题'} ${sampleId}`;
    if (!question.control && ((!starved && !unavailable && !blank) || (starved && hit))) {
      mainFirst.push({ question, sampleId, correct: hit, evidenceIds: call.evidenceIds });
    }
    if (question.control) {
      if (starved) {
        if (hit) {
          controlCorrect += 1;
        } else {
          controlStarved += 1;
          findings.push({
            level: 'warn',
            message: `控制题 ${sampleId} 因推理占满预算未作答（升预算重试仍截断，期望 ${question.answer}）：证据不足，本次质量结论不可信。`,
            evidenceIds: call.evidenceIds,
          });
        }
      } else if (unavailable) {
        // 请求失败时即使上游残留正文碰巧含答案，也不得把「未成功响应」当成控制题通过——
        // 否则端点故障会被残缺证据洗白，控制题失去「排除整体故障」的作用。
        findings.push({
          level: 'warn',
          message: `控制题 ${sampleId} 未通过（期望 ${question.answer}，请求失败 ${call.result.error ?? 'unknown'}）：端点当前不可用或严重异常，本次质量结论不可信。`,
          evidenceIds: call.evidenceIds,
        });
      } else if (blank) {
        // HTTP 200 空文本不是「答错」：没有答案可判，控制题同样不能算通过。
        emptySamples += 1;
        controlEmpty += 1;
        findings.push({
          level: 'warn',
          message: `控制题 ${sampleId} 返回空响应（HTTP 200，无 content${call.blankRetried ? '，已自动改用流式回退仍为空' : ''}；期望 ${question.answer}）：未获得答案，本次质量结论不可信（空响应 ≠ 答错）。`,
          evidenceIds: call.evidenceIds,
        });
      } else if (hit) {
        controlCorrect += 1;
      } else {
        findings.push({
          level: 'warn',
          message: `控制题 ${sampleId} 未通过（期望 ${question.answer}，响应：${preview(call.result.text)}）：端点当前不可用或严重异常，本次质量结论不可信。`,
          evidenceIds: call.evidenceIds,
        });
      }
    } else if (starved) {
      // 截断正文已含答案仍按计对（思考型模型常见：答案先出、后续推理被 max_tokens 截断）。
      if (hit) {
        mainCorrect += 1;
      } else {
        excluded += 1;
        findings.push({
          level: 'warn',
          message: `题 ${sampleId} 因推理占满预算未作答（升预算重试仍截断）：该题剔除分母，不计入答错。`,
          evidenceIds: call.evidenceIds,
        });
      }
    } else if (unavailable) {
      unavailableSamples += 1;
      findings.push({
        level: 'warn',
        message: `题 ${sampleId} 请求未成功（${call.result.error ?? 'unknown'}${call.result.attempts > 1 ? `；已尝试 ${call.result.attempts} 次` : ''}）：该题剔除分母（未获得答案 ≠ 答错）。`,
        evidenceIds: call.evidenceIds,
      });
    } else if (blank) {
      // 200 空文本：未获得答案，剔除分母且不触发复采样（复采样只会放大请求量，不能把空响应当答错）。
      emptySamples += 1;
      mainEmpty += 1;
      findings.push({
        level: 'warn',
        message: `题 ${sampleId} 返回空响应（HTTP 200，无 content${call.blankRetried ? '，已自动改用流式回退仍为空' : ''}）：该题剔除分母（空响应 ≠ 答错）。`,
        evidenceIds: call.evidenceIds,
      });
    } else if (hit) {
      mainCorrect += 1;
    } else {
      // v0.2.2 抗噪（F1）：干净答错 = 拿到答案（ok 且非 starved）但判错。仅对主问题复采样一次
      // （同题同 messages、temperature 0.7），复采样答对按两次机会口径计为正确；复采样仍错或
      // 未产出可用答案则维持判错。控制题/starved/请求失败分支不触发（不得扩大复采样面）。
      retriedCount += 1;
      const resampleBudget = call.retried ? PROBE_BUDGETS.qualityRetry : PROBE_BUDGETS.quality;
      const resampleRequest: ChatRequest = { model: ctx.cfg.model, messages, temperature: 0.7, max_tokens: resampleBudget };
      const resample = await ctx.client.chat(resampleRequest);
      const resampleEvidence = recordCall(ctx.evidence, {
        probe: 'quality',
        label: `${sampleId} (resample@0.7)`,
        request: { model: ctx.cfg.model, stream: false, temperature: 0.7, maxTokens: resampleBudget, messages },
        result: resample,
      });
      // 与 ① 判定契约一致：复采样 starved（截断）但截断正文已含答案可按计对；
      // 但请求失败（ok=false）的残缺正文不得洗白——失败样本绝不能因 partial 文本碰巧含答案而计对。
      const recovered = resample.ok && checkAnswer(resample.text, question);
      if (recovered) {
        mainCorrect += 1;
        recoveredCount += 1;
        findings.push({
          level: 'info',
          message: `题 ${sampleId} 首答错误、复采样（temperature 0.7）答对，按两次机会口径计为正确；首答响应：${preview(call.result.text)}`,
          evidenceIds: [...call.evidenceIds, resampleEvidence.id],
        });
      } else {
        wrong.push(sampleId);
        const resampleClean = resample.ok && !isStarved(resample);
        findings.push({
          level: 'warn',
          message: resampleClean
            ? `题 ${sampleId} 答错（复采样仍错；期望 ${question.answer}，首答响应：${preview(call.result.text)}）`
            : `题 ${sampleId} 答错（复采样未产出可用答案；期望 ${question.answer}，响应：${preview(call.result.text)}）`,
          evidenceIds: [...call.evidenceIds, resampleEvidence.id],
        });
      }
    }
  }

  const usable = mainTotal - excluded - unavailableSamples - mainEmpty;
  // —— pass@1 主口径（2026-10-19 图纸双审裁决）：质量主指标 = 首答正确率；
  // metrics['main'] 记首答（与 headline/评分同口径），metrics['main_recovered'] 记两次机会口径。
  const firstCorrect = mainCorrect - recoveredCount;
  metrics['main'] = `${firstCorrect}/${usable}`;
  metrics['main_recovered'] = `${mainCorrect}/${usable}`;
  metrics['metric_version'] = 'pass1';
  metrics['quality_samples'] = qualityRounds;
  metrics['main_total'] = mainTotal;
  metrics['controls'] = `${controlCorrect}/${controlTotal}`;
  metrics['excluded'] = excluded;
  if (unavailableSamples > 0) metrics['unavailable'] = unavailableSamples;
  if (emptySamples > 0) metrics['empty'] = emptySamples;
  if (retriedCount > 0) metrics['retried'] = retriedCount;
  if (recoveredCount > 0) metrics['recovered'] = recoveredCount;
  if (blankRetriedCount > 0) metrics['blank_retried'] = blankRetriedCount;
  if (streamFallbackCount > 0) metrics['stream_fallbacks'] = streamFallbackCount;
  if (streamFallbackCount > 0) {
    findings.push({
      level: 'info',
      message: `质量探针有 ${streamFallbackCount} 题非流式空响应，已自动改用流式回退并取得答案（空响应 ≠ 答错）。`,
      evidenceIds: streamFallbackEvidenceIds,
    });
  }

  // Reference differential runs even when the main-side result is insufficient: the
  // comparison still explains whether a weak result is endpoint-specific.
  const referenceAssessment = await assessQualityReference(ctx, mainFirst);
  Object.assign(metrics, referenceAssessment.metrics);
  findings.push(...referenceAssessment.findings);

  if (controlCorrect < controlTotal) {
    return {
      id: 'quality',
      status: 'insufficient',
      score: null,
      level: 'unknown',
      headline:
        controlStarved > 0
          ? `控制题未产出答案（${controlStarved} 题推理占满预算未作答）：证据不足，质量评分不可信`
          : controlEmpty > 0
            ? `控制题未获得有效答案（${controlEmpty} 题空响应${blankRetriedCount > 0 ? '，已自动重试/流式回退仍为空' : ''}）：端点异常，质量评分不可信`
            : `控制题未全对（${controlCorrect}/${controlTotal}）：端点异常或拒答，质量评分不可信`,
      findings,
      metrics,
    };
  }
  if (usable <= 0) {
    return {
      id: 'quality',
      status: 'insufficient',
      score: null,
      level: 'unknown',
      headline: `主问题全部被剔除（0/${mainTotal} 有效：推理占满预算/请求失败/空响应${blankRetriedCount > 0 ? '，空响应已重试/流式回退' : ''}）：证据不足，无法评分`,
      findings,
      metrics,
    };
  }
  if (usable < mainTotal * MIN_USABLE_RATIO) {
    const reasons = [
      excluded > 0 ? `${excluded} 题推理占满预算` : '',
      unavailableSamples > 0 ? `${unavailableSamples} 题请求未成功` : '',
      mainEmpty > 0 ? `${mainEmpty} 题空响应${blankRetriedCount > 0 ? '（已重试/流式回退）' : ''}` : '',
    ]
      .filter((s) => s !== '')
      .join('、');
    return {
      id: 'quality',
      status: 'insufficient',
      score: null,
      level: 'unknown',
      headline: `有效样本不足（${usable}/${mainTotal}，其余因${reasons || '证据不足'}剔除）：证据不足，无法评分`,
      findings,
      metrics,
    };
  }

  // —— pass@1 判定（阈值不变：0.9/0.6；语义从「两次机会」改为「首答」）——
  // fail 增设复采前提（图纸双审必修）：首答 <0.6 且复采样仍未恢复至 0.6 线才判 fail（定论级）；
  // 复采恢复到 ≥0.6 视为随机失误，降为 warn 不定罪。pass 只认首答：复采样答对绝不把端点
  // 抬进 pass——识别「重复提问」后策略性作答的端点无法借第二次机会洗白。
  const pass1 = firstCorrect / usable;
  const twoChance = mainCorrect / usable;
  // 分母口径维持「可用样本」：空响应/失败/截断（含推理占满预算）样本已按既有裁决剔除，
  // 且 MIN_USABLE_RATIO=0.8 保证被剔除比例不超过 20%；把无答案样本算回分母等于把
  // 「未获得答案」当「答错」，会误伤预算被推理吃掉的正常端点（2026-11 复核驳回该改法）。
  let score: number;
  let level: ProbeOutcome['level'];
  let whitewashRescued = false;
  const recoveredNote = recoveredCount > 0 ? `，复采样恢复 ${recoveredCount} 题` : '';
  if (pass1 >= 0.9) {
    level = 'pass';
    score = Math.round(pass1 * 100);
  } else if (pass1 >= 0.6) {
    level = 'warn';
    score = Math.round(pass1 * 100);
  } else if (twoChance >= 0.6) {
    // 首答跌破 0.6 线但复采样恢复：随机失误不定罪，warn + 两次机会口径封顶 80
    //（识别重复提问的端点即便复采全对也只能拿 80，不得接近满分洗白）。
    level = 'warn';
    score = Math.min(Math.round(twoChance * 100), 80);
    whitewashRescued = true;
  } else {
    level = 'fail';
    score = Math.round(pass1 * 100);
  }

  if (referenceAssessment.systematicLevel !== null) {
    const cap = referenceAssessment.systematicLevel === 'fail' ? 45 : 70;
    score = Math.min(score, cap);
    if (referenceAssessment.systematicLevel === 'fail' || level === 'pass') {
      level = referenceAssessment.systematicLevel;
    }
  }

  // 准确率 95% 双侧 Wilson 置信区间（z=1.96）：小样本下点估计不可靠，区间只披露、不参与判定
  //（0.9/0.6 阈值口径不变），供报告读者自行评估「10/10」与「40/40」的证据强度差异。
  // 区间基于首答样本（与主指标同口径）。
  const ciLow = wilsonLowerBound(firstCorrect, usable, 1.96);
  const ciHigh = wilsonUpperBound(firstCorrect, usable, 1.96);
  const ciWidth = ciHigh - ciLow;
  metrics['accuracy_ci95_low'] = Math.round(ciLow * 1000) / 1000;
  metrics['accuracy_ci95_high'] = Math.round(ciHigh * 1000) / 1000;
  metrics['accuracy_ci95_width'] = Math.round(ciWidth * 1000) / 1000;
  // 证据强度（仅披露，不参与判定阈值）：有效样本越多、区间越窄，结论越接近「可靠」。
  // high：≥45 个有效样本且 CI 宽 ≤0.10（约 4 轮题集全有效）；medium：≥24 且 ≤0.15；否则 low。
  const evidenceStrength =
    usable >= 45 && ciWidth <= 0.1 ? 'high' : usable >= 24 && ciWidth <= 0.15 ? 'medium' : 'low';
  metrics['evidence_strength'] = evidenceStrength;
  findings.push({
    level: 'info',
    message: `首答准确率 95% 置信区间为 [${(ciLow * 100).toFixed(1)}%, ${(ciHigh * 100).toFixed(1)}%]（证据强度 ${evidenceStrength}）` +
      (ciWidth > 0.15 ? '：样本量偏小、区间较宽，结论置信度有限，建议复测或用 --quality-samples/--deep 扩样后再定性。' : '。'),
    evidenceIds: [],
  });

  const excludedNote = excluded > 0 ? `，另有 ${excluded} 题因推理占满预算剔除分母` : '';
  let headline: string;
  if (level === 'pass') {
    headline = `质量题集通过：首答 ${firstCorrect}/${usable}（控制题全对${excludedNote}${recoveredNote}）`;
  } else if (level === 'warn') {
    headline = whitewashRescued
      ? `质量未达通过线：首答仅 ${firstCorrect}/${usable}，复采样恢复至 ${mainCorrect}/${usable}（随机失误不足以定罪${excludedNote}）`
      : `质量未达通过线：首答 ${firstCorrect}/${usable}，错误集中在 ${wrong.slice(0, 4).join('、')}${excludedNote}${recoveredNote}`;
  } else {
    headline = `疑似降智：首答仅 ${firstCorrect}/${usable} 正确，复采样后 ${mainCorrect}/${usable} 仍未达 0.6 线（控制题全对），已答错 ${wrong.length} 题${excludedNote}`;
  }

  // 恢复率防洗白（F1 裁决口径，2026-10-19 收窄为纯披露）：端点识别「重复提问」后策略性作答时，
  // 复采样恢复率会异常高——只披露提醒人工复核，不再参与计分/判定（pass@1 主口径下复采样
  // 答对已不影响 pass 线，旧「过半依赖复采样 cap80」分支失去存在意义，删除）。
  if (retriedCount > 0 && recoveredCount >= 3 && recoveredCount / retriedCount >= 0.9 && firstCorrect <= Math.floor(mainTotal / 2)) {
    findings.push({
      level: 'info',
      message: `复采样恢复率异常高（${recoveredCount}/${retriedCount}，首答正确 ${firstCorrect}/${mainTotal}）：不排除端点识别重复提问后策略性作答，建议人工复核。`,
      evidenceIds: [],
    });
  }

  findings.push({
    level: 'info',
    message: `题集为程序化生成（seed=${ctx.rng.seed}，共 ${qualityRounds} 轮 ${mainTotal} 主问题 + ${controlTotal} 控制题），答案可在报告中复算；控制题全对用于排除端点整体故障。`,
    evidenceIds: [],
  });
  return { id: 'quality', status: 'ok', score, level, headline, findings, metrics };
}

function preview(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 40 ? `${oneLine.slice(0, 40)}…` : oneLine;
}
