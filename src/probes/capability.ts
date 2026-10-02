import type { ChatMessage, Finding, ProbeCtx, ProbeOutcome, ToolDef } from '../types.js';
import { recordCall } from '../evidence.js';
import { dataUrlPng, solidRgbPng } from '../png.js';

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
      headline: '能力探针无法得出结论（请求全部失败）',
      findings,
      metrics,
    };
  }

  const score = Math.round((parts.reduce((a, b) => a + b, 0) / parts.length) * 100);
  const level: ProbeOutcome['level'] = score >= 100 ? 'pass' : score >= 60 ? 'warn' : 'fail';
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

function isTransportFailure(status: number): boolean {
  return status === 0 || status >= 500;
}

async function runVision(ctx: ProbeCtx, findings: Finding[]): Promise<CheckState> {
  const picks = ctx.rng.shuffle(COLORS).slice(0, 3);
  let correct = 0;
  let attempted = 0;
  let allHttp4xx = true;
  let anyOk = false;
  const evidenceIds: string[] = [];

  for (const color of picks) {
    const png = solidRgbPng(8, color.rgb);
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '图中是一个纯色方块。它是什么颜色？只回答一个英文颜色单词。' },
          { type: 'image_url', image_url: { url: dataUrlPng(png) } },
        ],
      },
    ];
    const result = await ctx.client.chat({ model: ctx.cfg.model, messages, temperature: 0, max_tokens: 16 });
    const evidence = recordCall(ctx.evidence, {
      probe: 'capability',
      label: `vision color=${color.name}`,
      request: { model: ctx.cfg.model, stream: false, temperature: 0, maxTokens: 16, messages },
      result,
    });
    evidenceIds.push(evidence.id);
    attempted += 1;
    if (!result.ok) {
      if (!(result.status >= 400 && result.status < 500)) allHttp4xx = false;
      continue;
    }
    anyOk = true;
    if (result.text.toLowerCase().includes(color.name)) correct += 1;
  }

  if (!anyOk) {
    if (allHttp4xx && attempted > 0) {
      findings.push({
        level: 'fail',
        message: '标称支持 vision，但端点对图像请求明确返回 4xx 拒绝：该能力不存在。',
        evidenceIds,
      });
      return { state: 'fail' };
    }
    findings.push({ level: 'warn', message: 'vision 探针全部请求失败，无法判定。', evidenceIds });
    return { state: 'na' };
  }

  if (correct === attempted) {
    findings.push({ level: 'info', message: `vision 通过：${correct}/${attempted} 次随机纯色图全部识别正确。`, evidenceIds });
    return { state: 'pass' };
  }
  findings.push({
    level: 'fail',
    message: `vision 可疑：仅 ${correct}/${attempted} 次识别正确（8 色随机，3/3 全对才通过）。`,
    evidenceIds,
  });
  return { state: 'partial' };
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
  const first = await ctx.client.chat({
    model: ctx.cfg.model,
    messages: firstMessages,
    temperature: 0,
    max_tokens: 200,
    tools: [echoTool()],
    tool_choice: 'auto',
  });
  const firstEvidence = recordCall(ctx.evidence, {
    probe: 'capability',
    label: `tool roundtrip call nonce=${nonce}`,
    request: { model: ctx.cfg.model, stream: false, temperature: 0, maxTokens: 200, messages: firstMessages },
    result: first,
  });

  const call = first.toolCalls.find((c) => c.function.name === 'echo_nonce');
  if (!first.ok) {
    if (isTransportFailure(first.status)) {
      findings.push({ level: 'warn', message: `tool 探针请求失败（${first.error ?? 'unknown'}），无法判定。`, evidenceIds: [firstEvidence.id] });
      return { state: 'na' };
    }
    findings.push({
      level: 'fail',
      message: `标称支持 tool calling，但首轮请求被拒绝（${first.error ?? 'unknown'}）。`,
      evidenceIds: [firstEvidence.id],
    });
    return { state: 'fail' };
  }
  if (!call) {
    findings.push({
      level: 'fail',
      message: '标称支持 tool calling，但首轮未发起工具调用（返回纯文本）。',
      evidenceIds: [firstEvidence.id],
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
  const second = await ctx.client.chat({ model: ctx.cfg.model, messages: secondMessages, temperature: 0, max_tokens: 64 });
  const secondEvidence = recordCall(ctx.evidence, {
    probe: 'capability',
    label: `tool roundtrip result nonce=${nonce}`,
    request: { model: ctx.cfg.model, stream: false, temperature: 0, maxTokens: 64, messages: secondMessages },
    result: second,
  });

  if (argsNonce !== nonce) {
    findings.push({
      level: 'fail',
      message: `工具调用参数错误：要求回传 nonce=${nonce}，实际为 "${argsNonce}"。`,
      evidenceIds: [firstEvidence.id],
    });
    return { state: 'fail' };
  }
  if (!second.ok) {
    if (isTransportFailure(second.status)) {
      findings.push({ level: 'warn', message: `tool 探针第二轮请求失败（${second.error ?? 'unknown'}），无法判定。`, evidenceIds: [secondEvidence.id] });
      return { state: 'na' };
    }
    findings.push({
      level: 'fail',
      message: `工具结果回传后第二轮请求被拒绝（${second.error ?? 'unknown'}），往返调用不完整。`,
      evidenceIds: [secondEvidence.id],
    });
    return { state: 'fail' };
  }
  if (!second.text.includes(nonce)) {
    findings.push({
      level: 'fail',
      message: '工具结果回传后未能完成第二轮确认（响应中未包含 nonce），往返调用不完整。',
      evidenceIds: [secondEvidence.id],
    });
    return { state: 'fail' };
  }
  findings.push({ level: 'info', message: 'tool calling 通过：echo_nonce 参数回填与两轮往返均正确。', evidenceIds: [firstEvidence.id, secondEvidence.id] });
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
