import type { ChatMessage, ChatRequest, ChatResult, Finding, ProbeCtx, ProbeOutcome } from '../types.js';
import { recordCall } from '../evidence.js';

/**
 * 协议参数完整性探针（P0）。
 *
 * 目标：检测中转站在 HTTP 200 下静默忽略/改写 OpenAI 兼容参数。判定遵循「实测接受后才定罪」：
 * - 端点以 400/404/405/422/501 拒绝或未实现参数 → na，不扣分、不判 fail；
 * - 端点返回 200 但行为不符合参数语义 → fail（参数被忽略/改写）；
 * - 其余错误（401/403/429/5xx/超时等）→ error，不计入分子分母；
 * - 有效计分项（5 项）少于 3 项 → score=null / unknown，避免单点有效即给分。
 *
 * seed 只作观测：同 seed 一致 + 不同 seed 分化才算符合预期；同 seed 不一致记 warn，
 * 但绝不单独据此定罪（官方端点也可能因批处理/浮点非确定性产生差异）。
 */

type CheckState = 'pass' | 'fail' | 'na' | 'error';

interface CheckResult {
  state: CheckState;
  evidenceId: string | null;
  detail: string;
}

interface CheckOutcome {
  id: string;
  state: CheckState;
  evidenceId: string | null;
  detail: string;
}

const SCORED_CHECKS = ['max_tokens', 'stop', 'response_format', 'n', 'logprobs'] as const;
const MIN_SCORED = 3;

function nonce(ctx: ProbeCtx): string {
  return ctx.rng.nonce(6);
}

function userMessage(text: string): ChatMessage[] {
  return [{ role: 'user', content: text }];
}

interface CallOutcome {
  result: ChatResult;
  evidenceId: string;
}

async function call(
  ctx: ProbeCtx,
  label: string,
  req: Omit<ChatRequest, 'model'>,
): Promise<CallOutcome> {
  // retryEmpty=false：空正文是待判定的观测结果，重发会掩盖第一次行为并可能重复计费。
  const result = await ctx.client.chat({ model: ctx.cfg.model, retryEmpty: false, ...req });
  const evidence = recordCall(ctx.evidence, {
    probe: 'params',
    label,
    request: {
      model: ctx.cfg.model,
      stream: req.stream === true,
      temperature: req.temperature ?? null,
      maxTokens: req.max_tokens ?? null,
      stop: req.stop ?? null,
      seed: req.seed ?? null,
      n: req.n ?? null,
      logprobs: req.logprobs ?? null,
      topLogprobs: req.top_logprobs ?? null,
      responseFormat: req.response_format?.type ?? null,
      messages: req.messages,
    },
    result,
  });
  return { result, evidenceId: evidence.id };
}

/** 端点不支持该参数/路由的 HTTP 状态：按 na 处理，绝不计入 fail。 */
function unsupportedStatus(result: ChatResult): boolean {
  if (result.ok) return false;
  return result.status === 400 || result.status === 404 || result.status === 405 || result.status === 422 || result.status === 501;
}

function classifyError(result: ChatResult, paramName: string): CheckResult {
  if (unsupportedStatus(result)) {
    return {
      state: 'na',
      evidenceId: null,
      detail: `端点拒绝或未实现 ${paramName}（HTTP ${result.status}），该项不判定：${result.error ?? '无错误文本'}`,
    };
  }
  return {
    state: 'error',
    evidenceId: null,
    detail: `请求失败（HTTP ${result.status}）：${result.error ?? '未知错误'}`,
  };
}

function isBlankOk(result: ChatResult): boolean {
  return result.ok && result.text.trim() === '' && result.toolCalls.length === 0;
}

async function checkMaxTokens(ctx: ProbeCtx): Promise<CheckResult> {
  const marker = nonce(ctx);
  const { result, evidenceId } = await call(ctx, `params max_tokens=1 (${marker})`, {
    messages: userMessage(`__XRAY_PARAMS__ 请输出从 1 到 30 的所有整数，用空格分隔，只输出数字。校验码 ${marker}`),
    temperature: 0,
    max_tokens: 1,
    stream: false,
  });
  if (!result.ok) {
    const classified = classifyError(result, 'max_tokens');
    return { ...classified, evidenceId };
  }
  if (result.usage === null) {
    return { state: 'na', evidenceId, detail: '响应缺少 usage，无法核对 completion_tokens 是否被 max_tokens 限制' };
  }
  const completion = result.usage.completion_tokens;
  if (completion > 1) {
    return {
      state: 'fail',
      evidenceId,
      detail: `max_tokens=1 被忽略：completion_tokens=${completion}（finish_reason=${result.finishReason ?? 'null'}）`,
    };
  }
  if (completion === 1 && result.finishReason === 'length') {
    return {
      state: 'pass',
      evidenceId,
      detail: 'max_tokens=1 被遵守（completion_tokens=1, finish_reason=length）',
    };
  }
  // completion_tokens=0 或 finish_reason 不是 length：可能是自然结束/空正文，
  // 无法证明上限生效；判 na，避免假 pass。
  return {
    state: 'na',
    evidenceId,
    detail: `completion_tokens=${completion}、finish_reason=${result.finishReason ?? 'null'}，无法区分自然结束与 max_tokens 限制`,
  };
}

async function checkStop(ctx: ProbeCtx): Promise<CheckResult> {
  const marker = nonce(ctx);
  const sentinel = `XRAYSTOP${marker}`;
  const prompt = `__XRAY_PARAMS__ 请原样输出下面这一行，不要改写、不要添加解释：BEGIN ${sentinel} END`;
  const baseline = await call(ctx, `params stop baseline (${marker})`, {
    messages: userMessage(prompt),
    temperature: 0,
    max_tokens: 64,
    stream: false,
  });
  if (!baseline.result.ok) {
    const classified = classifyError(baseline.result, 'stop');
    return { ...classified, evidenceId: baseline.evidenceId };
  }
  // 无 stop 基线必须真的产出哨兵，否则「带 stop 后不含哨兵」无法区分是 stop 生效还是模型没照做。
  if (!baseline.result.text.includes(sentinel)) {
    return {
      state: 'na',
      evidenceId: baseline.evidenceId,
      detail: '基线未产出哨兵文本，无法判定 stop 是否生效（不据此定罪）',
    };
  }
  const { result, evidenceId } = await call(ctx, `params stop=${sentinel} (${marker})`, {
    messages: userMessage(prompt),
    temperature: 0,
    max_tokens: 64,
    stop: [sentinel],
    stream: false,
  });
  if (!result.ok) {
    const classified = classifyError(result, 'stop');
    return { ...classified, evidenceId };
  }
  if (result.text.includes(sentinel)) {
    return { state: 'fail', evidenceId, detail: `stop 被忽略：响应仍包含哨兵 ${sentinel}` };
  }
  if (result.text.trim() === '' || result.finishReason === 'length' || result.finishReason === 'content_filter') {
    return {
      state: 'na',
      evidenceId,
      detail: `stop 响应无可判定正文（finish_reason=${result.finishReason ?? 'null'}），不能区分 stop 生效与自然结束/截断`,
    };
  }
  if (result.finishReason !== 'stop') {
    return {
      state: 'na',
      evidenceId,
      detail: `响应不含哨兵但 finish_reason=${result.finishReason ?? 'null'}，无法确认是 stop 截断还是自然结束`,
    };
  }
  const sentinelAt = baseline.result.text.indexOf(sentinel);
  const expectedPrefix = baseline.result.text.slice(0, sentinelAt).trimEnd();
  const observedPrefix = result.text.trimEnd();
  if (observedPrefix !== expectedPrefix) {
    return {
      state: 'na',
      evidenceId,
      detail: `响应不含哨兵但正文不是基线哨兵前前缀（期望「${expectedPrefix.slice(0, 80)}」，实际「${observedPrefix.slice(0, 80)}」），无法确认是 stop 截断`,
    };
  }
  return { state: 'pass', evidenceId, detail: 'stop 生效：哨兵及其后内容被截断（finish_reason=stop）' };
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const unfenced = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    : trimmed;
  try {
    const parsed = JSON.parse(unfenced) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function checkResponseFormat(ctx: ProbeCtx): Promise<CheckResult> {
  const marker = nonce(ctx);
  // prompt 必须包含 "JSON"（OpenAI json_object 的硬性要求），但明确要求用自然语言回答：
  // 基线若已是 JSON 则说明模型自发输出 JSON，参数效果不可分辨 → na。
  const prompt = `__XRAY_PARAMS__ 请用一段自然语言介绍缓存的作用，不要输出 JSON 格式。校验码 ${marker}`;
  const baseline = await call(ctx, `params response_format baseline (${marker})`, {
    messages: userMessage(prompt),
    temperature: 0,
    max_tokens: 96,
    stream: false,
  });
  if (!baseline.result.ok) {
    const classified = classifyError(baseline.result, 'response_format');
    return { ...classified, evidenceId: baseline.evidenceId };
  }
  if (parseJsonObject(baseline.result.text) !== null) {
    return {
      state: 'na',
      evidenceId: baseline.evidenceId,
      detail: '无 response_format 基线已自发输出 JSON，无法区分参数效果',
    };
  }
  const { result, evidenceId } = await call(ctx, `params response_format=json_object (${marker})`, {
    messages: userMessage(prompt),
    temperature: 0,
    max_tokens: 96,
    response_format: { type: 'json_object' },
    stream: false,
  });
  if (!result.ok) {
    const classified = classifyError(result, 'response_format');
    return { ...classified, evidenceId };
  }
  if (parseJsonObject(result.text) === null) {
    if (isBlankOk(result)) {
      return { state: 'na', evidenceId, detail: '响应为空正文/被内容过滤，无法判定 response_format' };
    }
    return {
      state: 'fail',
      evidenceId,
      detail: `response_format=json_object 被忽略：响应不是合法 JSON 对象（${result.text.slice(0, 80)}）`,
    };
  }
  return { state: 'pass', evidenceId, detail: 'response_format=json_object 生效：响应为合法 JSON 对象' };
}

async function checkN(ctx: ProbeCtx): Promise<CheckResult> {
  const marker = nonce(ctx);
  const { result, evidenceId } = await call(ctx, `params n=2 (${marker})`, {
    messages: userMessage(`__XRAY_PARAMS__ 请列出三个不同的颜色名称，用逗号分隔，只输出列表。校验码 ${marker}`),
    temperature: 0.8,
    max_tokens: 64,
    n: 2,
    stream: false,
  });
  if (!result.ok) {
    const classified = classifyError(result, 'n');
    return { ...classified, evidenceId };
  }
  if (result.choiceCount === undefined) {
    return { state: 'na', evidenceId, detail: '响应未提供 choice 数量，n 不可判定' };
  }
  if (result.choiceCount === 2) {
    // choices.length=2 还不够：重复/缺失 index 可能是把同一个 choice 复制两份，
    // 空 choice 也可能是补齐数量；必须同时确认两个独立 index 都有实际内容。
    if (result.choiceIndices === undefined) {
      return { state: 'na', evidenceId, detail: 'n=2 响应有 2 个 choices，但 choice index 未解析，无法确认是独立候选' };
    }
    if (result.choiceIndices.length !== 2) {
      return { state: 'na', evidenceId, detail: 'n=2 响应有 2 个 choices，但 choice index 缺失/非法，无法确认是独立候选' };
    }
    const distinct = new Set(result.choiceIndices);
    if (distinct.size !== 2) {
      return { state: 'fail', evidenceId, detail: `n=2 响应 2 个 choices 共用 choice index（${result.choiceIndices.join(',')}），不是独立候选` };
    }
    if (!distinct.has(0) || !distinct.has(1)) {
      return { state: 'fail', evidenceId, detail: `n=2 响应 choice index 不是 0/1（${result.choiceIndices.join(',')}），与参数语义不符` };
    }
    if (result.choiceNonEmptyCount === undefined) {
      return { state: 'na', evidenceId, detail: 'n=2 响应 choice 内容解析缺失，无法确认两个候选都有正文' };
    }
    if (result.choiceNonEmptyCount !== 2) {
      return {
        state: 'fail',
        evidenceId,
        detail: `n=2 响应仅 ${result.choiceNonEmptyCount}/2 个 choices 有正文/推理/工具调用，空 choice 不能算独立候选`,
      };
    }
    return { state: 'pass', evidenceId, detail: 'n=2 生效：返回 2 个独立且有内容的 choices' };
  }
  if (result.choiceCount === 1) {
    return { state: 'fail', evidenceId, detail: 'n=2 被忽略：仅返回 1 个 choice' };
  }
  if (result.choiceCount === 0) {
    return { state: 'error', evidenceId, detail: 'n=2 响应 choices 为空，属畸形响应，不计入计分项' };
  }
  return { state: 'na', evidenceId, detail: `响应 choices 数量为 ${result.choiceCount}，与 n=2 不可比，不据此定罪` };
}

async function checkLogprobs(ctx: ProbeCtx): Promise<CheckResult> {
  const marker = nonce(ctx);
  const { result, evidenceId } = await call(ctx, `params logprobs (${marker})`, {
    messages: userMessage(`__XRAY_PARAMS__ 请只回答一个英文单词：hello。校验码 ${marker}`),
    temperature: 0,
    max_tokens: 8,
    logprobs: true,
    top_logprobs: 3,
    stream: false,
  });
  if (!result.ok) {
    const classified = classifyError(result, 'logprobs');
    return { ...classified, evidenceId };
  }
  if (result.viaStream === true) {
    return { state: 'na', evidenceId, detail: '端点强制流式返回，当前未聚合流式 logprobs，不可判定' };
  }
  if (result.logprobsTokenCount === undefined) {
    return { state: 'na', evidenceId, detail: '响应未解析 logprobs 字段，不可判定' };
  }
  if (isBlankOk(result)) {
    return { state: 'na', evidenceId, detail: '响应为空正文/被内容过滤，无法判定 logprobs' };
  }
  if (result.logprobsInvalidCount === undefined) {
    return { state: 'na', evidenceId, detail: '响应未解析 logprobs 合法性，不可判定' };
  }
  if (result.logprobsInvalidCount !== null && result.logprobsInvalidCount > 0) {
    return {
      state: 'fail',
      evidenceId,
      detail: `logprobs 内容含 ${result.logprobsInvalidCount} 个非法条目（token 缺失、logprob 非有限值或 >0）`,
    };
  }
  if (result.logprobsTokenCount !== null && result.logprobsTokenCount > 0) {
    if (result.topLogprobsTokenCount === undefined || result.topLogprobsTokenCount === null) {
      return { state: 'na', evidenceId, detail: '响应未解析 top_logprobs，无法确认 top_logprobs=3 是否生效' };
    }
    if (result.topLogprobsTokenCount !== result.logprobsTokenCount) {
      return {
        state: 'fail',
        evidenceId,
        detail: `top_logprobs 未完整覆盖：${result.topLogprobsTokenCount}/${result.logprobsTokenCount} 个 token 带合法 top_logprobs`,
      };
    }
    return {
      state: 'pass',
      evidenceId,
      detail: `logprobs 生效：${result.logprobsTokenCount} 个 token 的 logprob 合法，top_logprobs 覆盖 ${result.topLogprobsTokenCount}/${result.logprobsTokenCount} 个 token`,
    };
  }
  return { state: 'fail', evidenceId, detail: 'logprobs=true 被忽略：200 响应未携带合法 logprobs 内容' };
}

async function checkSeed(ctx: ProbeCtx): Promise<{ state: 'pass' | 'warn' | 'na' | 'error'; evidenceIds: string[]; detail: string }> {
  const marker = nonce(ctx);
  const prompt = `__XRAY_PARAMS__ 请输出一个 10 个英文单词的句子，主题是数据库。只输出句子。校验码 ${marker}`;
  const base = {
    messages: userMessage(prompt),
    temperature: 0,
    max_tokens: 64,
    stream: false,
  } as const;
  const a1 = await call(ctx, `params seed=12345 #1 (${marker})`, { ...base, seed: 12345 });
  const a2 = await call(ctx, `params seed=12345 #2 (${marker})`, { ...base, seed: 12345 });
  const a3 = await call(ctx, `params seed=54321 (${marker})`, { ...base, seed: 54321 });
  const evidenceIds = [a1.evidenceId, a2.evidenceId, a3.evidenceId];
  for (const item of [a1, a2, a3]) {
    if (!item.result.ok) {
      if (unsupportedStatus(item.result)) {
        return { state: 'na', evidenceIds, detail: '端点明确不支持 seed，该项仅观测' };
      }
      return { state: 'error', evidenceIds, detail: `seed 请求失败（HTTP ${item.result.status}）：${item.result.error ?? '未知错误'}` };
    }
  }
  const t1 = a1.result.text.trim();
  const t2 = a2.result.text.trim();
  const t3 = a3.result.text.trim();
  if (t1 === '' || t2 === '' || t3 === '') {
    return { state: 'na', evidenceIds, detail: 'seed 样本存在空正文，无法比较确定性' };
  }
  if (t1 !== t2) {
    return { state: 'warn', evidenceIds, detail: '同 seed 两次输出不同：端点未保证确定性（不作为参数篡改定罪）' };
  }
  if (t1 === t3) {
    return { state: 'na', evidenceIds, detail: '不同 seed 输出相同：无法区分 seed 是否生效（仅观测）' };
  }
  return { state: 'pass', evidenceIds, detail: 'seed 行为符合预期：同 seed 一致、不同 seed 分化' };
}

function stateText(state: CheckState | 'warn'): string {
  switch (state) {
    case 'pass':
      return '通过';
    case 'fail':
      return '失败';
    case 'na':
      return '不适用';
    case 'warn':
      return '告警';
    default:
      return '错误';
  }
}

export async function probeParams(ctx: ProbeCtx): Promise<ProbeOutcome> {
  const checks: CheckOutcome[] = [];
  const findings: Finding[] = [];
  const metrics: Record<string, number | string | null> = {};

  // 串行执行：协议探针请求量小（10 发），串行避免并发触发端点限流、污染行为判定。
  const runners: Array<[string, () => Promise<CheckResult>]> = [
    ['max_tokens', () => checkMaxTokens(ctx)],
    ['stop', () => checkStop(ctx)],
    ['response_format', () => checkResponseFormat(ctx)],
    ['n', () => checkN(ctx)],
    ['logprobs', () => checkLogprobs(ctx)],
  ];
  for (const [id, run] of runners) {
    const result = await run();
    checks.push({ id, ...result });
    metrics[`${id}_state`] = result.state;
    if (result.state === 'fail') {
      findings.push({
        level: 'fail',
        message: `${id} 参数被静默忽略：${result.detail}`,
        evidenceIds: result.evidenceId === null ? [] : [result.evidenceId],
      });
    } else if (result.state === 'error') {
      findings.push({
        level: 'warn',
        message: `${id} 未判定（请求错误）：${result.detail}`,
        evidenceIds: result.evidenceId === null ? [] : [result.evidenceId],
      });
    } else if (result.state === 'na') {
      findings.push({
        level: 'info',
        message: `${id} 未判定（${stateText(result.state)}）：${result.detail}`,
        evidenceIds: result.evidenceId === null ? [] : [result.evidenceId],
      });
    }
  }

  const seed = await checkSeed(ctx);
  metrics['seed_state'] = seed.state;
  metrics['seed_evidence_count'] = seed.evidenceIds.length;
  if (seed.state === 'warn' || seed.state === 'error') {
    findings.push({ level: 'warn', message: `seed 未判定（${stateText(seed.state)}）：${seed.detail}`, evidenceIds: seed.evidenceIds });
  } else if (seed.state === 'na') {
    findings.push({ level: 'info', message: `seed 未判定（${stateText(seed.state)}）：${seed.detail}`, evidenceIds: seed.evidenceIds });
  } else {
    findings.push({ level: 'info', message: seed.detail, evidenceIds: seed.evidenceIds });
  }

  const passCount = checks.filter((c) => c.state === 'pass').length;
  const failCount = checks.filter((c) => c.state === 'fail').length;
  const naCount = checks.filter((c) => c.state === 'na').length;
  const errorCount = checks.filter((c) => c.state === 'error').length;
  const scored = passCount + failCount;
  metrics['scored_pass'] = passCount;
  metrics['scored_fail'] = failCount;
  metrics['scored_na'] = naCount;
  metrics['scored_error'] = errorCount;

  // 全量 na/error 时不出分；有效项不足 3 项也不出分（防单点有效即判 100）。
  if (scored < MIN_SCORED) {
    const status = errorCount === SCORED_CHECKS.length ? 'error' : 'insufficient';
    const headline = errorCount === SCORED_CHECKS.length
      ? `协议参数完整性未能判定：${SCORED_CHECKS.length} 项检查全部请求失败`
      : `协议参数完整性证据不足：仅 ${scored}/${SCORED_CHECKS.length} 项有效（${passCount} 通过 / ${failCount} 失败 / ${naCount} 不适用 / ${errorCount} 错误）`;
    return { id: 'params', status, score: null, level: 'unknown', headline, findings, metrics };
  }

  const score = Math.round((passCount / scored) * 100);
  const coverageNotes: string[] = [];
  if (naCount > 0) coverageNotes.push(`${naCount} 项不适用/未判定`);
  if (errorCount > 0) coverageNotes.push(`${errorCount} 项请求失败未计分`);
  if (seed.state === 'na') coverageNotes.push('seed 观测不可判定');
  const coverageSuffix = coverageNotes.length > 0 ? `（${coverageNotes.join('，')}）` : '';
  // seed 只作观测：同 seed 不一致/请求错误把分项标记为 warn，但不把“确定性未确认”升级为参数篡改。
  const level: ProbeOutcome['level'] = failCount > 0 ? 'fail' : errorCount > 0 || seed.state === 'error' ? 'warn' : 'pass';
  const failedNames = checks.filter((c) => c.state === 'fail').map((c) => c.id);
  const headline = failCount > 0
    ? `协议参数被静默改写：${failedNames.join('、')} 已接受请求但行为不符合参数语义${coverageSuffix}`
    : errorCount > 0
      ? `协议参数完整性部分通过：${passCount}/${scored} 项实测遵守${coverageSuffix}`
      : seed.state === 'error'
        ? `协议参数完整性通过（${passCount}/${scored}），但 seed 观测请求失败，确定性未确认${coverageSuffix}`
        : seed.state === 'warn'
          ? `协议参数完整性通过（${passCount}/${scored}），但同 seed 输出不一致，确定性未确认${coverageSuffix}`
          : `协议参数完整性通过：${passCount}/${scored} 项实测遵守${coverageSuffix}`;

  return { id: 'params', status: 'ok', score, level, headline, findings, metrics };
}
