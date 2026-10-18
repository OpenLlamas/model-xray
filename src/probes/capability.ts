import type { ChatMessage, Finding, ProbeCtx, ProbeOutcome, ToolDef } from '../types.js';
import { recordCall } from '../evidence.js';
import { dataUrlPng, solidRgbPng } from '../png.js';
import { PROBE_BUDGETS, chatWithStarveRetry, isBlankAnswer } from './starve.js';

const COLORS: ReadonlyArray<{ name: string; rgb: [number, number, number] }> = [
  { name: 'red', rgb: [220, 30, 30] },
  { name: 'green', rgb: [30, 170, 60] },
  { name: 'blue', rgb: [30, 60, 220] },
  { name: 'purple', rgb: [140, 40, 200] },
  { name: 'pink', rgb: [240, 120, 180] },
  { name: 'orange', rgb: [240, 140, 20] },
  { name: 'brown', rgb: [130, 80, 40] },
  { name: 'gray', rgb: [120, 120, 120] },
];

const KNOWN = new Set(['vision', 'tool', 'thinking']);

/** 明确「能力被拒绝」白名单：仅 400（服务端请求级明确拒绝，如内容/形态不受支持）。其余一切失败一律视为证据不足。 */
const EXPLICIT_REJECT = new Set<number>([400]);

/** 失败归因：仅白名单内的 4xx 构成「能力不存在」证据；0/5xx/鉴权/限流/路由/未知 status 一律 inconclusive（降 na）。 */
function classifyFailure(status: number): 'reject' | 'inconclusive' {
  return EXPLICIT_REJECT.has(status) ? 'reject' : 'inconclusive';
}

export async function probeCapability(ctx: ProbeCtx): Promise<ProbeOutcome> {
  const claimed = ctx.cfg.expect.filter((c) => KNOWN.has(c));
  if (claimed.length === 0) {
    return {
      id: 'capability',
      status: 'insufficient',
      score: null,
      level: 'unknown',
      headline: '未声明需要核验的能力（--expect none）',
      findings: [{ level: 'info', message: '使用 --expect vision,tool 可核验标称能力。', evidenceIds: [] }],
      metrics: {},
    };
  }

  const findings: Finding[] = [];
  const metrics: Record<string, number | string | null> = { claimed: claimed.join(',') };
  const parts: number[] = [];

  if (claimed.includes('vision')) {
    const vision = await runVision(ctx, findings);
    if (vision.state === 'pass') parts.push(1);
    else if (vision.state === 'partial') parts.push(0.5);
    else if (vision.state === 'fail') parts.push(0);
    metrics['vision'] = vision.state;
  }
  if (claimed.includes('tool')) {
    const tool = await runTool(ctx, findings);
    if (tool.state === 'pass') parts.push(1);
    else if (tool.state === 'partial') parts.push(0.5);
    else if (tool.state === 'fail') parts.push(0);
    metrics['tool'] = tool.state;
  }
  if (claimed.includes('thinking')) {
    const thinking = await runThinking(ctx, findings);
    metrics['thinking'] = thinking;
  }

  if (parts.length === 0) {
    return {
      id: 'capability',
      status: 'insufficient',
      score: null,
      level: 'unknown',
      headline: '能力探针无法得出结论（请求全部失败或证据不足）',
      findings,
      metrics,
    };
  }

  const score = Math.round((parts.reduce((a, b) => a + b, 0) / parts.length) * 100);
  let level: ProbeOutcome['level'] = score >= 100 ? 'pass' : score >= 60 ? 'warn' : 'fail';
  // 全部为部分证据（0.5）时抬升为 warn：无法完整验证不应等同「能力不存在」。
  if (level === 'fail' && parts.length > 0 && parts.every((p) => p >= 0.5)) level = 'warn';
  const headline =
    level === 'pass'
      ? '标称能力全部实测通过'
      : level === 'warn'
        ? `标称能力部分异常（得分 ${score}）`
        : '标称能力实测失败：存在宣称但不可用的能力';
  return { id: 'capability', status: 'ok', score, level, headline, findings, metrics };
}

interface CheckState {
  state: 'pass' | 'partial' | 'fail' | 'na';
}

/** 纯色测试图边长。实测依据（2026-10-10 真机）：8px 图会被 vision 栈误判（brown→purple、orange→blue），
 *  256px 同色全部识别正确——过小的图是识别伪影，不能作为能力判定依据。 */
const VISION_IMAGE_SIZE = 256;

async function runVision(ctx: ProbeCtx, findings: Finding[]): Promise<CheckState> {
  const picks = ctx.rng.shuffle(COLORS).slice(0, 3);
  let correct = 0;
  let okCount = 0;
  let failCount = 0;
  let starvedCount = 0;
  let emptyCount = 0;
  let blankRetriedCount = 0;
  let streamFallbackCount = 0;
  const failStatuses: number[] = [];
  const evidenceIds: string[] = [];
  const starvedEvidence: string[] = [];
  const emptyEvidence: string[] = [];
  const recoveredEvidence: string[] = [];
  const streamFallbackEvidence: string[] = [];

  for (const color of picks) {
    const png = solidRgbPng(VISION_IMAGE_SIZE, color.rgb);
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '图中是一个纯色方块。它的颜色必须是以下之一：red, green, blue, purple, pink, orange, brown, gray。只回答一个英文颜色单词。',
          },
          { type: 'image_url', image_url: { url: dataUrlPng(png) } },
        ],
      },
    ];
    // 预算实测：glm-5.3-flash 等 thinking 模型在 16 tokens 下推理即占满预算（content 恒空）；
    // 1024 可产出答案，仍截断时升 2048 重试一次（详见 starve.ts PROBE_BUDGETS 注释）。
    const call = await chatWithStarveRetry(ctx, {
      probe: 'capability',
      label: `vision color=${color.name}`,
      buildRequest: (maxTokens) => ({ model: ctx.cfg.model, messages, temperature: 0, max_tokens: maxTokens }),
      budget: PROBE_BUDGETS.vision,
      retryBudget: PROBE_BUDGETS.visionRetry,
    });
    evidenceIds.push(...call.evidenceIds);
    if (call.blankRetried) blankRetriedCount += 1;
    if (call.streamFallback) {
      streamFallbackCount += 1;
      streamFallbackEvidence.push(...call.evidenceIds);
    }
    if (call.starved) {
      starvedCount += 1;
      starvedEvidence.push(...call.evidenceIds);
      continue;
    }
    if (call.retried) recoveredEvidence.push(...call.evidenceIds);
    const { result } = call;
    if (!result.ok) {
      failCount += 1;
      failStatuses.push(result.status);
      continue;
    }
    if (isBlankAnswer(result)) {
      // 200 空文本不是「识别错误」：没有答案可判，剔除分母。
      emptyCount += 1;
      emptyEvidence.push(...call.evidenceIds);
      continue;
    }
    okCount += 1;
    if (containsColorWord(result.text, color.name)) correct += 1;
  }

  if (starvedCount > 0) {
    findings.push({
      level: 'warn',
      message: `vision 有 ${starvedCount}/3 次因推理占满预算未产出答案（已升预算重试仍截断），按证据不足处理，不计入失败。`,
      evidenceIds: starvedEvidence,
    });
  }
  if (recoveredEvidence.length > 0) {
    findings.push({
      level: 'info',
      message: `vision 有 ${recoveredEvidence.length} 次首查推理占满预算（max_tokens=${PROBE_BUDGETS.vision}），升预算至 ${PROBE_BUDGETS.visionRetry} 重试后成功。`,
      evidenceIds: recoveredEvidence,
    });
  }
  if (emptyCount > 0) {
    findings.push({
      level: 'warn',
      message: `vision 有 ${emptyCount}/3 次返回空文本（HTTP 200，无 content${blankRetriedCount > 0 ? '，已自动改用流式回退仍为空' : ''}）：按证据不足处理，不计入识别错误或能力缺失。`,
      evidenceIds: emptyEvidence,
    });
  }
  if (streamFallbackCount > 0) {
    findings.push({
      level: 'info',
      message: `vision 有 ${streamFallbackCount} 次非流式空响应，已自动改用流式回退并取得答案（空响应 ≠ 能力缺失）。`,
      evidenceIds: streamFallbackEvidence,
    });
  }

  if (okCount === 0) {
    if (failCount > 0 && failStatuses.every((s) => classifyFailure(s) === 'reject')) {
      findings.push({
        level: 'fail',
        message: '标称支持 vision，但端点对图像请求明确返回 4xx 拒绝：该能力不存在。',
        evidenceIds,
      });
      return { state: 'fail' };
    }
    if (failCount === 0 && starvedCount > 0) {
      findings.push({
        level: 'warn',
        message: `vision 探针全部因推理占满预算未产出答案（升预算至 ${PROBE_BUDGETS.visionRetry} 重试仍截断），无法判定（证据不足，不代表能力缺失）。`,
        evidenceIds,
      });
      return { state: 'na' };
    }
    if (failCount === 0 && emptyCount > 0) {
      findings.push({
        level: 'warn',
        message: `vision 探针全部返回空文本（HTTP 200，无 content${blankRetriedCount > 0 ? '，已自动改用流式回退仍为空' : ''}）：无法判定（空响应 ≠ 能力缺失）。`,
        evidenceIds,
      });
      return { state: 'na' };
    }
    const codes = [...new Set(failStatuses)].join('/');
    findings.push({
      level: 'warn',
      message: `vision 探针全部请求失败（状态码 ${codes}），无法判定（鉴权/限流/传输故障不代表能力缺失）。`,
      evidenceIds,
    });
    return { state: 'na' };
  }
  if (failCount === 0 && starvedCount === 0 && emptyCount === 0 && correct === okCount) {
    findings.push({ level: 'info', message: `vision 通过：${correct}/${okCount} 次随机纯色图全部识别正确。`, evidenceIds });
    return { state: 'pass' };
  }
  if (failCount === 0 && correct === okCount) {
    // 全部有效作答样本均正确，但部分样本空响应/推理截断：不构成失败证据，按部分证据处理（partial→warn 抬升）。
    const missing = [
      starvedCount > 0 ? `${starvedCount} 次因推理占满预算未产出答案` : '',
      emptyCount > 0 ? `${emptyCount} 次空响应` : '',
    ]
      .filter((s) => s !== '')
      .join('、');
    findings.push({
      level: 'warn',
      message: `vision ${correct}/${okCount} 次识别正确，另有 ${missing}：按部分证据处理。`,
      evidenceIds: [...starvedEvidence, ...emptyEvidence],
    });
    return { state: 'partial' };
  }
  const emptyNote = emptyCount > 0 ? `，另有 ${emptyCount} 次空响应` : '';
  const detail = failCount === 0 ? `仅 ${correct}/${okCount} 次识别正确${emptyNote}` : `${correct}/${okCount} 次识别正确，另有 ${failCount} 次请求失败${emptyNote}`;
  findings.push({
    level: 'fail',
    message: `vision 可疑：${detail}（8 色随机，全部正确且无失败才通过）。`,
    evidenceIds,
  });
  return { state: 'partial' };
}

/** 归一化词边界判色：小写后按非字母切词，整词等于基础色名才算命中；禁止 includes 子串（"reddish"/"crimson" 不得命中）。 */
function containsColorWord(text: string, color: string): boolean {
  const words = text.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 0);
  return words.includes(color);
}

function echoTool(): ToolDef {
  return {
    type: 'function',
    function: {
      name: 'echo_nonce',
      description: 'Echo back the provided nonce.',
      parameters: {
        type: 'object',
        properties: { nonce: { type: 'string', description: 'The nonce to echo.' } },
        required: ['nonce'],
      },
    },
  };
}

async function runTool(ctx: ProbeCtx, findings: Finding[]): Promise<CheckState> {
  const nonce = ctx.rng.nonce(6);
  const firstMessages: ChatMessage[] = [
    { role: 'user', content: `你必须调用 echo_nonce 工具，把参数 nonce 设为 "${nonce}"。不要直接回复文字。` },
  ];
  const firstCall = await chatWithStarveRetry(ctx, {
    probe: 'capability',
    label: `tool roundtrip call nonce=${nonce}`,
    buildRequest: (maxTokens) => ({
      model: ctx.cfg.model,
      messages: firstMessages,
      temperature: 0,
      max_tokens: maxTokens,
      tools: [echoTool()],
      tool_choice: 'auto' as const,
    }),
    budget: PROBE_BUDGETS.toolFirst,
    retryBudget: PROBE_BUDGETS.toolFirstRetry,
    acceptToolCalls: true,
  });
  const first = firstCall.result;

  const call = first.toolCalls.find((c) => c.function.name === 'echo_nonce');
  if (firstCall.streamFallback) {
    findings.push({
      level: 'info',
      message: `tool 探针首轮非流式返回空响应，已自动改用流式回退并取得响应（空响应 ≠ 未发起工具调用）。`,
      evidenceIds: firstCall.evidenceIds,
    });
  }
  if (!first.ok) {
    if (classifyFailure(first.status) === 'reject') {
      findings.push({
        level: 'fail',
        message: `标称支持 tool calling，但首轮请求被明确拒绝（HTTP ${first.status}，${first.error ?? 'unknown'}）。`,
        evidenceIds: firstCall.evidenceIds,
      });
      return { state: 'fail' };
    }
    findings.push({
      level: 'warn',
      message: `tool 探针首轮请求失败（HTTP ${first.status}，${first.error ?? 'unknown'}${first.attempts > 1 ? `；已尝试 ${first.attempts} 次` : ''}），无法判定（鉴权/限流/传输故障不代表能力缺失）。`,
      evidenceIds: firstCall.evidenceIds,
    });
    return { state: 'na' };
  }
  if (!call) {
    // thinking 模型推理占满预算：升预算重试仍截断 → 无「工具调用缺失」证据，属证据不足（与 vision 同口径）。
    // 历史缺陷：首轮写死 max_tokens=200 且无 starved 判定，推理吃掉预算后返回纯文本即被误判 fail 0。
    if (firstCall.starved) {
      findings.push({
        level: 'warn',
        message: `标称支持 tool calling，但首轮因推理占满预算未产出答案（升预算至 ${PROBE_BUDGETS.toolFirstRetry} 重试仍截断）：证据不足，无法判定（不代表工具能力缺失）。`,
        evidenceIds: firstCall.evidenceIds,
      });
      return { state: 'na' };
    }
    if (isBlankAnswer(first)) {
      findings.push({
        level: 'warn',
        message: `标称支持 tool calling，但首轮返回空文本（HTTP 200，无 content${firstCall.blankRetried ? '，已自动改用流式回退仍为空' : ''}）：无法判定（空响应 ≠ 未发起工具调用）。`,
        evidenceIds: firstCall.evidenceIds,
      });
      return { state: 'na' };
    }
    findings.push({
      level: 'fail',
      message: '标称支持 tool calling，但首轮未发起工具调用（返回纯文本）。',
      evidenceIds: firstCall.evidenceIds,
    });
    return { state: 'fail' };
  }
  let argsNonce = '';
  try {
    const parsed = JSON.parse(call.function.arguments) as Record<string, unknown>;
    argsNonce = typeof parsed['nonce'] === 'string' ? parsed['nonce'] : '';
  } catch {
    argsNonce = '';
  }

  const secondMessages: ChatMessage[] = [
    ...firstMessages,
    { role: 'assistant', content: null, tool_calls: [call] },
    { role: 'tool', content: 'ok', tool_call_id: call.id },
  ];
  const secondCall = await chatWithStarveRetry(ctx, {
    probe: 'capability',
    label: `tool roundtrip result nonce=${nonce}`,
    buildRequest: (maxTokens) => ({ model: ctx.cfg.model, messages: secondMessages, temperature: 0, max_tokens: maxTokens }),
    budget: PROBE_BUDGETS.toolSecond,
    retryBudget: PROBE_BUDGETS.toolSecondRetry,
  });
  const second = secondCall.result;

  if (argsNonce !== nonce) {
    findings.push({
      level: 'fail',
      message: `工具调用参数错误：要求回传 nonce=${nonce}，实际为 "${argsNonce}"。`,
      evidenceIds: firstCall.evidenceIds,
    });
    return { state: 'fail' };
  }
  if (secondCall.starved) {
    // thinking 模型推理占满预算（升预算重试仍截断）：无正文可判定，证据不足——不得判 partial 或 fail。
    findings.push({
      level: 'warn',
      message: `首轮工具调用与参数回填正确，但第二轮因推理占满预算未产出答案（升预算至 ${PROBE_BUDGETS.toolSecondRetry} 重试仍截断）：证据不足，无法判定。`,
      evidenceIds: [...firstCall.evidenceIds, ...secondCall.evidenceIds],
    });
    return { state: 'na' };
  }
  if (!second.ok) {
    if (classifyFailure(second.status) === 'reject') {
      findings.push({
        level: 'fail',
        message: `工具结果回传后第二轮请求被明确拒绝（HTTP ${second.status}，${second.error ?? 'unknown'}），往返调用不完整。`,
        evidenceIds: secondCall.evidenceIds,
      });
      return { state: 'fail' };
    }
    findings.push({
      level: 'warn',
      message: `首轮工具调用与参数回填正确，但第二轮请求失败（HTTP ${second.status}，${second.error ?? 'unknown'}）：判定为部分通过，需人工复核。`,
      evidenceIds: [...firstCall.evidenceIds, ...secondCall.evidenceIds],
    });
    return { state: 'partial' };
  }
  if (isBlankAnswer(second)) {
    findings.push({
      level: 'warn',
      message: `首轮工具调用与参数回填正确（tool calling 能力已实证），但第二轮返回空文本（HTTP 200，无 content${secondCall.blankRetried ? '，已自动改用流式回退仍为空' : ''}）：往返确认不完整，按部分证据处理（空响应 ≠ 能力缺失）。`,
      evidenceIds: [...firstCall.evidenceIds, ...secondCall.evidenceIds],
    });
    return { state: 'partial' };
  }
  if (!second.text.includes(nonce)) {
    // 首轮已实证「能正确发起工具调用 + 正确回填参数」= tool calling 能力存在；
    // 次轮只是没复述 nonce（thinking 模型预算小、或不按指令复述），不足以判定能力不可用。
    // 历史缺陷：此处判 fail → glm-5.3-flash 实测（2026-10-17，官方 1M 上下文复核）首轮工具调用正确、
    // 仅次轮未复述 nonce，被打成 capability 50 fail，与首轮证据自相矛盾。
    findings.push({
      level: 'warn',
      message: `首轮工具调用与参数回填正确（tool calling 能力已实证），但第二轮响应未复述 nonce（往返确认不完整）：判定为部分通过，需人工复核。`,
      evidenceIds: [...firstCall.evidenceIds, ...secondCall.evidenceIds],
    });
    return { state: 'partial' };
  }
  findings.push({ level: 'info', message: 'tool calling 通过：echo_nonce 参数回填与两轮往返均正确。', evidenceIds: [...firstCall.evidenceIds, ...secondCall.evidenceIds] });
  return { state: 'pass' };
}

async function runThinking(ctx: ProbeCtx, findings: Finding[]): Promise<string> {
  const messages: ChatMessage[] = [{ role: 'user', content: '请仔细思考后回答：127 × 31 等于多少？只回答数字。' }];
  const result = await ctx.client.chat({ model: ctx.cfg.model, messages, temperature: 0, max_tokens: 512 });
  const evidence = recordCall(ctx.evidence, {
    probe: 'capability',
    label: 'thinking observation',
    request: { model: ctx.cfg.model, stream: false, temperature: 0, maxTokens: 512, messages },
    result,
  });
  const hasReasoning = result.reasoning !== null && result.reasoning.length > 0;
  findings.push({
    level: 'info',
    message: hasReasoning
      ? 'thinking 观测：响应包含 reasoning 字段（仅观测，不计分——网关可能剥离该字段，不能据此判假）。'
      : 'thinking 观测：响应未透出 reasoning 字段（仅观测，不计分）。',
    evidenceIds: [evidence.id],
  });
  return hasReasoning ? 'reasoning_field_present' : 'no_reasoning_field';
}
