import type { ChatMessage, Finding, ProbeCtx, ProbeOutcome, Rng } from '../types.js';
import { recordCall } from '../evidence.js';

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
  const numbers = [...text.matchAll(/-?\d+/g)].map((m) => Number(m[0]));
  if (question.exclusive && question.exclusive.length > 0) {
    const hasAnswer = numbers.includes(question.answer);
    const hasDistractor = question.exclusive.some((d) => numbers.includes(d));
    return hasAnswer && !hasDistractor;
  }
  return numbers.includes(question.answer);
}

export async function probeQuality(ctx: ProbeCtx): Promise<ProbeOutcome> {
  const findings: Finding[] = [];
  const metrics: Record<string, number | string | null> = {};
  const questions = generateQuestions(ctx.rng);
  const main = questions.filter((q) => !q.control);
  const controls = questions.filter((q) => q.control);

  let controlCorrect = 0;
  let mainCorrect = 0;
  const wrong: string[] = [];

  for (const question of questions) {
    const messages: ChatMessage[] = [{ role: 'user', content: question.prompt }];
    const result = await ctx.client.chat({
      model: ctx.cfg.model,
      messages,
      temperature: 0,
      max_tokens: 64,
    });
    const evidence = recordCall(ctx.evidence, {
      probe: 'quality',
      label: `${question.control ? 'control' : 'main'} ${question.id}`,
      request: { model: ctx.cfg.model, stream: false, temperature: 0, maxTokens: 64, messages },
      result,
    });
    const ok = result.ok && checkAnswer(result.text, question);
    if (question.control) {
      if (ok) controlCorrect += 1;
      else {
        findings.push({
          level: 'warn',
          message: `控制题 ${question.id} 未通过（期望 ${question.answer}，响应：${preview(result.text)}）：端点当前不可用或严重异常，本次质量结论不可信。`,
          evidenceIds: [evidence.id],
        });
      }
    } else if (ok) {
      mainCorrect += 1;
    } else {
      wrong.push(question.id);
      findings.push({
        level: 'warn',
        message: `题 ${question.id} 答错（期望 ${question.answer}，响应：${preview(result.text)}）`,
        evidenceIds: [evidence.id],
      });
    }
  }

  metrics['main'] = `${mainCorrect}/${main.length}`;
  metrics['controls'] = `${controlCorrect}/${controls.length}`;

  if (controlCorrect < controls.length) {
    return {
      id: 'quality',
      status: 'insufficient',
      score: null,
      level: 'unknown',
      headline: `控制题未全对（${controlCorrect}/${controls.length}）：端点异常或拒答，质量评分不可信`,
      findings,
      metrics,
    };
  }

  const accuracy = main.length === 0 ? 0 : mainCorrect / main.length;
  const score = Math.round(accuracy * 100);
  let level: ProbeOutcome['level'];
  if (accuracy >= 0.9) level = 'pass';
  else if (accuracy >= 0.6) level = 'warn';
  else level = 'fail';

  const headline =
    level === 'pass'
      ? `质量题集通过：主题 ${mainCorrect}/${main.length}（控制题全对）`
      : level === 'warn'
        ? `质量可疑：主题 ${mainCorrect}/${main.length}，错误集中在 ${wrong.slice(0, 4).join('、')}`
        : `疑似降智：主题仅 ${mainCorrect}/${main.length} 正确（控制题全对），已答错 ${wrong.length} 题`;

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
