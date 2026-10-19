import type { ChatMessage, ChatRequest, Finding, ProbeCtx, ProbeOutcome, Rng } from '../types.js';
import { recordCall } from '../evidence.js';
import { wilsonLowerBound, wilsonUpperBound } from '../stats.js';
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
  // 千分位逗号归一：模型常答 "7,718"，按 -?\d+ 切分会拆成 7 与 718 两个数，漏判正确答案。
  const normalized = text.replace(/\d{1,3}(?:,\d{3})+/g, (m) => m.replace(/,/g, ''));
  // 小数必须整体解析：整数题答 "42.5" 不能因包含 42 而被判对（旧 -?\d+ 只是截断整数部分）。
  const numbers = [...normalized.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  if (question.exclusive && question.exclusive.length > 0) {
    const hasAnswer = numbers.includes(question.answer);
    const hasDistractor = question.exclusive.some((d) => numbers.includes(d));
    return hasAnswer && !hasDistractor;
  }
  return numbers.includes(question.answer);
}

/** 剔除后有效分母低于原主问题数的 80% → 不再出分（样本太少，比例无统计意义），判 insufficient。 */
const MIN_USABLE_RATIO = 0.8;

export async function probeQuality(ctx: ProbeCtx): Promise<ProbeOutcome> {
  const findings: Finding[] = [];
  const metrics: Record<string, number | string | null> = {};
  const questions = generateQuestions(ctx.rng);
  const main = questions.filter((q) => !q.control);
  const controls = questions.filter((q) => q.control);

  let controlCorrect = 0;
  let mainCorrect = 0;
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

  for (const question of questions) {
    const messages: ChatMessage[] = [{ role: 'user', content: question.prompt }];
    // 预算实测：thinking 模型在 64 tokens 下推理即占满预算（content 空/截断），256 基本可用，仍截断升 512 重试一次。
    const call = await chatWithStarveRetry(ctx, {
      probe: 'quality',
      label: `${question.control ? 'control' : 'main'} ${question.id}`,
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
    const label = `${question.control ? '控制题' : '题'} ${question.id}`;
    if (question.control) {
      if (starved) {
        if (hit) {
          controlCorrect += 1;
        } else {
          controlStarved += 1;
          findings.push({
            level: 'warn',
            message: `控制题 ${question.id} 因推理占满预算未作答（升预算重试仍截断，期望 ${question.answer}）：证据不足，本次质量结论不可信。`,
            evidenceIds: call.evidenceIds,
          });
        }
      } else if (unavailable) {
        // 请求失败时即使上游残留正文碰巧含答案，也不得把「未成功响应」当成控制题通过——
        // 否则端点故障会被残缺证据洗白，控制题失去「排除整体故障」的作用。
        findings.push({
          level: 'warn',
          message: `控制题 ${question.id} 未通过（期望 ${question.answer}，请求失败 ${call.result.error ?? 'unknown'}）：端点当前不可用或严重异常，本次质量结论不可信。`,
          evidenceIds: call.evidenceIds,
        });
      } else if (blank) {
        // HTTP 200 空文本不是「答错」：没有答案可判，控制题同样不能算通过。
        emptySamples += 1;
        controlEmpty += 1;
        findings.push({
          level: 'warn',
          message: `控制题 ${question.id} 返回空响应（HTTP 200，无 content${call.blankRetried ? '，已自动改用流式回退仍为空' : ''}；期望 ${question.answer}）：未获得答案，本次质量结论不可信（空响应 ≠ 答错）。`,
          evidenceIds: call.evidenceIds,
        });
      } else if (hit) {
        controlCorrect += 1;
      } else {
        findings.push({
          level: 'warn',
          message: `控制题 ${question.id} 未通过（期望 ${question.answer}，响应：${preview(call.result.text)}）：端点当前不可用或严重异常，本次质量结论不可信。`,
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
          message: `题 ${question.id} 因推理占满预算未作答（升预算重试仍截断）：该题剔除分母，不计入答错。`,
          evidenceIds: call.evidenceIds,
        });
      }
    } else if (unavailable) {
      unavailableSamples += 1;
      findings.push({
        level: 'warn',
        message: `题 ${question.id} 请求未成功（${call.result.error ?? 'unknown'}${call.result.attempts > 1 ? `；已尝试 ${call.result.attempts} 次` : ''}）：该题剔除分母（未获得答案 ≠ 答错）。`,
        evidenceIds: call.evidenceIds,
      });
    } else if (blank) {
      // 200 空文本：未获得答案，剔除分母且不触发复采样（复采样只会放大请求量，不能把空响应当答错）。
      emptySamples += 1;
      mainEmpty += 1;
      findings.push({
        level: 'warn',
        message: `题 ${question.id} 返回空响应（HTTP 200，无 content${call.blankRetried ? '，已自动改用流式回退仍为空' : ''}）：该题剔除分母（空响应 ≠ 答错）。`,
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
        label: `${question.id} (resample@0.7)`,
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
          message: `题 ${question.id} 首答错误、复采样（temperature 0.7）答对，按两次机会口径计为正确；首答响应：${preview(call.result.text)}`,
          evidenceIds: [...call.evidenceIds, resampleEvidence.id],
        });
      } else {
        wrong.push(question.id);
        const resampleClean = resample.ok && !isStarved(resample);
        findings.push({
          level: 'warn',
          message: resampleClean
            ? `题 ${question.id} 答错（复采样仍错；期望 ${question.answer}，首答响应：${preview(call.result.text)}）`
            : `题 ${question.id} 答错（复采样未产出可用答案；期望 ${question.answer}，响应：${preview(call.result.text)}）`,
          evidenceIds: [...call.evidenceIds, resampleEvidence.id],
        });
      }
    }
  }

  const usable = main.length - excluded - unavailableSamples - mainEmpty;
  metrics['main'] = `${mainCorrect}/${usable}`;
  metrics['controls'] = `${controlCorrect}/${controls.length}`;
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

  if (controlCorrect < controls.length) {
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
            : `控制题未全对（${controlCorrect}/${controls.length}）：端点异常或拒答，质量评分不可信`,
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
      headline: `主问题全部被剔除（0/${main.length} 有效：推理占满预算/请求失败/空响应${blankRetriedCount > 0 ? '，空响应已重试/流式回退' : ''}）：证据不足，无法评分`,
      findings,
      metrics,
    };
  }
  if (usable < main.length * MIN_USABLE_RATIO) {
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
      headline: `有效样本不足（${usable}/${main.length}，其余因${reasons || '证据不足'}剔除）：证据不足，无法评分`,
      findings,
      metrics,
    };
  }

  const accuracy = mainCorrect / usable;
  let score = Math.round(accuracy * 100);
  let level: ProbeOutcome['level'];
  if (accuracy >= 0.9) level = 'pass';
  else if (accuracy >= 0.6) level = 'warn';
  else level = 'fail';

  // 准确率 95% 双侧 Wilson 置信区间（z=1.96）：小样本下点估计不可靠，区间只披露、不参与判定
  //（0.9/0.6 阈值口径不变），供报告读者自行评估「10/10」与「40/40」的证据强度差异。
  const ciLow = wilsonLowerBound(mainCorrect, usable, 1.96);
  const ciHigh = wilsonUpperBound(mainCorrect, usable, 1.96);
  metrics['accuracy_ci95_low'] = Math.round(ciLow * 1000) / 1000;
  metrics['accuracy_ci95_high'] = Math.round(ciHigh * 1000) / 1000;
  findings.push({
    level: 'info',
    message: `主样本 ${usable} 题的准确率 95% 置信区间为 [${(ciLow * 100).toFixed(1)}%, ${(ciHigh * 100).toFixed(1)}%]` +
      (ciHigh - ciLow > 0.15 ? '：样本量偏小、区间较宽，结论置信度有限，建议复测或扩样后再定性。' : '。'),
    evidenceIds: [],
  });

  const excludedNote = excluded > 0 ? `，另有 ${excluded} 题因推理占满预算剔除分母` : '';
  let headline =
    level === 'pass'
      ? `质量题集通过：主题 ${mainCorrect}/${usable}（控制题全对${excludedNote}）`
      : level === 'warn'
        ? `质量可疑：主题 ${mainCorrect}/${usable}，错误集中在 ${wrong.slice(0, 4).join('、')}${excludedNote}`
        : `疑似降智：主题仅 ${mainCorrect}/${usable} 正确（控制题全对），已答错 ${wrong.length} 题${excludedNote}`;

  // 恢复率防洗白（F1 裁决口径）：端点识别「重复提问」后策略性作答时，复采样恢复率会异常高。
  // ① 恢复率异常高：只披露、不出分（首答正确数少 + 复采样几乎全对 = 可疑模式）；
  // ② 过半主题依赖复采样才答对：按可疑处理（分数封顶 80、pass 降 warn），headline 同步改写。
  const firstCorrect = mainCorrect - recoveredCount;
  if (retriedCount > 0) {
    if (recoveredCount >= 3 && recoveredCount / retriedCount >= 0.9 && firstCorrect <= 6) {
      findings.push({
        level: 'info',
        message: `复采样恢复率异常高（${recoveredCount}/${retriedCount}，首答正确 ${firstCorrect}/${main.length}）：不排除端点识别重复提问后策略性作答，建议人工复核。`,
        evidenceIds: [],
      });
    }
    if (recoveredCount / main.length >= 0.5) {
      findings.push({
        level: 'warn',
        message: `过半主题依赖复采样才答对（${recoveredCount}/${main.length}）：疑似端点识别重复提问后二次作答。`,
        evidenceIds: [],
      });
      score = Math.min(score, 80);
      if (level === 'pass') level = 'warn';
      headline = `质量可疑：过半主题需复采样才对（${mainCorrect}/${usable}）`;
    }
  }

  findings.push({
    level: 'info',
    message: `题集为程序化生成（seed=${ctx.rng.seed}），答案可在报告中复算；控制题全对用于排除端点整体故障。`,
    evidenceIds: [],
  });
  return { id: 'quality', status: 'ok', score, level, headline, findings, metrics };
}

function preview(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 40 ? `${oneLine.slice(0, 40)}…` : oneLine;
}
