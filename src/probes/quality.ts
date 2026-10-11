import type { ChatMessage, Finding, ProbeCtx, ProbeOutcome, Rng } from '../types.js';
import { PROBE_BUDGETS, chatWithStarveRetry } from './starve.js';

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
  const numbers = [...normalized.matchAll(/-?\d+/g)].map((m) => Number(m[0]));
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
  let controlStarved = 0;
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
    // 判定契约：
    // ① starved（finish=length）但答案已出现在（截断）正文中 → 正常计对；
    // ② 重试后仍 starved 且无答案 → 该题剔除分母 + warn（证据不足，不得按答错计 0）；
    // ③ 非 starved 的答错/请求失败 → 维持原语义（主问题计错、控制题触发 insufficient）。
    const starved = call.starved;
    const hit = checkAnswer(call.result.text, question);
    const label = `${question.control ? '控制题' : '题'} ${question.id}`;
    if (question.control) {
      if (hit) {
        controlCorrect += 1;
      } else if (starved) {
        controlStarved += 1;
        findings.push({
          level: 'warn',
          message: `控制题 ${question.id} 因推理占满预算未作答（升预算重试仍截断，期望 ${question.answer}）：证据不足，本次质量结论不可信。`,
          evidenceIds: call.evidenceIds,
        });
      } else {
        findings.push({
          level: 'warn',
          message: `控制题 ${question.id} 未通过（期望 ${question.answer}，响应：${preview(call.result.text)}）：端点当前不可用或严重异常，本次质量结论不可信。`,
          evidenceIds: call.evidenceIds,
        });
      }
    } else if (hit) {
      mainCorrect += 1;
    } else if (starved) {
      excluded += 1;
      findings.push({
        level: 'warn',
        message: `题 ${question.id} 因推理占满预算未作答（升预算重试仍截断）：该题剔除分母，不计入答错。`,
        evidenceIds: call.evidenceIds,
      });
    } else {
      wrong.push(question.id);
      findings.push({
        level: 'warn',
        message: `题 ${question.id} 答错（期望 ${question.answer}，响应：${preview(call.result.text)}）`,
        evidenceIds: call.evidenceIds,
      });
    }
  }

  const usable = main.length - excluded;
  metrics['main'] = `${mainCorrect}/${usable}`;
  metrics['controls'] = `${controlCorrect}/${controls.length}`;
  metrics['excluded'] = excluded;

  if (controlCorrect < controls.length) {
    return {
      id: 'quality',
      status: 'insufficient',
      score: null,
      level: 'unknown',
      headline:
        controlStarved > 0
          ? `控制题未产出答案（${controlStarved} 题推理占满预算未作答）：证据不足，质量评分不可信`
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
      headline: `主问题全部因推理占满预算被剔除（0/${main.length} 有效）：证据不足，无法评分`,
      findings,
      metrics,
    };
  }
  if (usable < main.length * MIN_USABLE_RATIO) {
    return {
      id: 'quality',
      status: 'insufficient',
      score: null,
      level: 'unknown',
      headline: `有效样本不足（${usable}/${main.length}，其余因推理占满预算剔除）：证据不足，无法评分`,
      findings,
      metrics,
    };
  }

  const accuracy = mainCorrect / usable;
  const score = Math.round(accuracy * 100);
  let level: ProbeOutcome['level'];
  if (accuracy >= 0.9) level = 'pass';
  else if (accuracy >= 0.6) level = 'warn';
  else level = 'fail';

  const excludedNote = excluded > 0 ? `，另有 ${excluded} 题因推理占满预算剔除分母` : '';
  const headline =
    level === 'pass'
      ? `质量题集通过：主题 ${mainCorrect}/${usable}（控制题全对${excludedNote}）`
      : level === 'warn'
        ? `质量可疑：主题 ${mainCorrect}/${usable}，错误集中在 ${wrong.slice(0, 4).join('、')}${excludedNote}`
        : `疑似降智：主题仅 ${mainCorrect}/${usable} 正确（控制题全对），已答错 ${wrong.length} 题${excludedNote}`;

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
