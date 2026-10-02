import type { ChatMessage, Finding, ProbeCtx, ProbeOutcome } from '../types.js';
import { buildEchoQuestion, buildFiller, buildNeedle, buildNeedleQuestion } from '../assets.js';
import { recordCall } from '../evidence.js';

const DEPTHS = [0.25, 0.5, 0.75, 0.9];

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
  const samplesPerDepth = ctx.cfg.deep ? 5 : 3;
  let explicitReject = false;
  let anySuccess = false;

  const depthResults: Record<string, string> = {};
  const depthMiss: Record<string, boolean> = {};

  for (const depth of DEPTHS) {
    const targetTokens = Math.floor(claimed * depth);
    let successAtDepth = 0;
    let rejectedAtDepth = 0;
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
      const result = await ctx.client.chat({
        model: ctx.cfg.model,
        messages,
        temperature: 0,
        max_tokens: 32,
      });
      const evidence = recordCall(ctx.evidence, {
        probe: 'context',
        label: `needle depth=${depth} nonce=${nonce}`,
        request: { model: ctx.cfg.model, stream: false, temperature: 0, maxTokens: 32, messages },
        result,
      });
      attempted += 1;
      const hit = result.ok && containsNonce(result.text, nonce);
      if (hit) {
        successAtDepth += 1;
        anySuccess = true;
      }
      if (!result.ok && result.status === 400) rejectedAtDepth += 1;
      findings.push({
        level: hit ? 'info' : 'warn',
        message: `深度 ${(depth * 100).toFixed(0)}%（约 ${targetTokens} tokens）needle ${nonce}：${
          hit ? '命中' : result.ok ? `未命中（响应：${preview(result.text)}）` : `请求失败 ${result.error ?? ''}`
        }`,
        evidenceIds: [evidence.id],
      });
    }
    depthResults[String(depth)] = `${successAtDepth}/${attempted}`;
    depthMiss[String(depth)] = attempted > 0 && successAtDepth < attempted;
    if (attempted > 0 && successAtDepth === 0 && depth >= 0.5 && rejectedAtDepth === attempted) {
      explicitReject = true;
    }
  }

  metrics['depth_hits'] = Object.entries(depthResults).map(([d, v]) => `${d}:${v}`).join(' ');
  metrics['depth_explicit_reject'] = explicitReject ? 1 : 0;

  const lowDepthMiss = depthMiss['0.25'] === true;
  const highDepthMiss = depthMiss['0.75'] === true || depthMiss['0.9'] === true;
  const missDepths = DEPTHS.filter((d) => depthMiss[String(d)] === true);
  const deepMissTiers = missDepths.filter((d) => d >= 0.5).length;
  metrics['miss_depths'] = missDepths.join(',') || 'none';

  const echoNonce = ctx.rng.nonce(6);
  const echoFiller = buildFiller(ctx.rng, Math.floor(claimed * 0.9));
  const echoTail = `【结尾核对 ${echoNonce}】最后一句话的校验词是 ${echoNonce}。`;
  const echoDoc = `${echoFiller}\n\n${echoTail}`;
  const echoMessages: ChatMessage[] = [
    { role: 'system', content: '你将收到一份长文档和一个指令。请严格按指令执行。' },
    { role: 'user', content: `${echoDoc}\n\n${buildEchoQuestion()}` },
  ];
  const echoResult = await ctx.client.chat({
    model: ctx.cfg.model,
    messages: echoMessages,
    temperature: 0,
    max_tokens: 64,
  });
  const echoEvidence = recordCall(ctx.evidence, {
    probe: 'context',
    label: `tail-echo nonce=${echoNonce}`,
    request: { model: ctx.cfg.model, stream: false, temperature: 0, maxTokens: 64, messages: echoMessages },
    result: echoResult,
  });
  const echoHit = echoResult.ok && containsNonce(echoResult.text, echoNonce);
  metrics['tail_echo'] = echoHit ? 'hit' : 'miss';
  findings.push({
    level: echoHit ? 'info' : 'fail',
    message: echoHit
      ? '结尾回显控制通过：标称长度 90% 处的结尾内容可被读取与复述。'
      : explicitReject
        ? '结尾回显控制失败：标称长度 90% 处的请求被端点显式拒绝 —— 标称窗口与实际接受长度不符（显式拒绝，非静默截断）。'
        : `结尾回显控制失败：标称长度 90% 处插入的结尾标记 ${echoNonce} 无法被复述（高深度 needle 失败=${highDepthMiss ? '是' : '否'}）。`,
    evidenceIds: [echoEvidence.id],
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
      explicitReject = true;
    }
  }
  metrics['boundary_scanned'] = boundaryScanned ? 1 : 0;

  let score = 100;
  let level: ProbeOutcome['level'] = 'pass';
  let headline = `上下文实测通过：标称 ${claimed} tokens 内 needle 全部命中`;

  if (!anySuccess) {
    score = 20;
    level = 'fail';
    headline = `上下文实测未获得任何命中：标称 ${claimed} tokens 不可用`;
  } else if (explicitReject) {
    score = 15;
    level = 'fail';
    headline = `标称窗口不实：端点对 ${claimed} tokens 标称长度内的输入显式拒绝（非静默截断）`;
  } else if (lowDepthMiss && highDepthMiss) {
    score = 10;
    level = 'fail';
    headline = `疑似静默截断：标称 ${claimed} tokens，但低深度（25%）与高深度（75%/90%）位置均有内容不可读`;
    findings.push({
      level: 'fail',
      message: '低深度与高深度同时出现未命中：输入中段/开头被丢弃，实际可用窗口小于标称值。',
      evidenceIds: [],
    });
  } else if (lowDepthMiss && echoHit) {
    score = 15;
    level = 'fail';
    headline = `标称窗口不实：标称 ${claimed} tokens，但 25% 深度位置的内容已不可读；结尾回显通过说明问题在输入被裁剪`;
    findings.push({
      level: 'fail',
      message:
        '低深度（25%）needle 未命中而结尾回显正常：端点保留了输入尾部、丢弃了开头（滑动窗口/裁掉头部），实际窗口小于标称值。',
      evidenceIds: [],
    });
  } else if (deepMissTiers >= 2) {
    score = 10;
    level = 'fail';
    headline = `标称窗口不实：标称 ${claimed} tokens，但 50% 以上深度有 ${deepMissTiers} 档出现内容不可读且随深度恶化`;
    findings.push({
      level: 'fail',
      message: `未命中档位：${missDepths.map((d) => `${d * 100}%`).join('、')}。在标称窗口内的中高深度出现系统性检索失败，且随深度单调恶化，与"真实窗口小于标称值"一致（也见结尾回显结果）。`,
      evidenceIds: [],
    });
  } else if (!echoHit && highDepthMiss) {
    score = 10;
    level = 'fail';
    headline = `疑似静默截断：标称 ${claimed} tokens，结尾回显与高深度（75%/90%）needle 同时失败`;
  } else if (boundaryTruncated) {
    score = 10;
    level = 'fail';
    headline = `边界扫描确认截断：实际可用长度约 ${metrics['boundary'] ?? '?'}`;
  } else if (!echoHit) {
    score = 50;
    level = 'warn';
    headline = '结尾回显控制失败但高深度 needle 命中，结论矛盾：可能为单次指令遵循失败，需复测';
  } else if (lowDepthMiss) {
    score = 55;
    level = 'warn';
    headline = '低深度 needle 部分未命中但结尾回显通过：疑似注意力衰减或代理改写，未构成截断定论';
  } else if (highDepthMiss) {
    score = 55;
    level = 'warn';
    headline = '高深度 needle 部分未命中但结尾回显通过：疑似注意力衰减或代理改写，未构成截断定论';
  }

  return { id: 'context', status: 'ok', score, level, headline, findings, metrics };
}

async function scanBoundary(
  ctx: ProbeCtx,
  claimed: number,
): Promise<{ found: boolean; foundAtTokens: number | null; explicitReject: boolean; detail: string; evidenceIds: string[] }> {
  const evidenceIds: string[] = [];
  let lo = 0;
  let hi = claimed;
  let foundAtTokens: number | null = null;
  let explicitReject = false;
  for (let step = 0; step < 3; step += 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (mid <= 0) break;
    const nonce = ctx.rng.nonce(6);
    const filler = buildFiller(ctx.rng, mid);
    const document = `${filler}\n\n${buildNeedle(ctx.rng, nonce)}`;
    const messages: ChatMessage[] = [
      { role: 'system', content: '你将收到一份文档和问题，只依据文档回答。' },
      { role: 'user', content: `${document}\n\n${buildNeedleQuestion(nonce, 'zh')}` },
    ];
    const result = await ctx.client.chat({ model: ctx.cfg.model, messages, temperature: 0, max_tokens: 32 });
    const evidence = recordCall(ctx.evidence, {
      probe: 'context',
      label: `boundary mid=${mid}`,
      request: { model: ctx.cfg.model, stream: false, temperature: 0, maxTokens: 32, messages },
      result,
    });
    evidenceIds.push(evidence.id);
    if (!result.ok && result.status === 400) {
      explicitReject = true;
      hi = mid;
      continue;
    }
    if (result.ok && containsNonce(result.text, nonce)) {
      lo = mid;
    } else {
      hi = mid;
      foundAtTokens = mid;
    }
  }
  const found = foundAtTokens !== null && foundAtTokens <= claimed * 0.9;
  return {
    found,
    foundAtTokens,
    explicitReject,
    detail: `lo=${lo} hi=${hi} found=${foundAtTokens ?? 'n/a'} explicitReject=${explicitReject}`,
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
