import type { ChatMessage, Finding, ProbeCtx, ProbeOutcome } from '../types.js';
import { recordCall } from '../evidence.js';
import { quantile } from '../stats.js';

export async function probeTtft(ctx: ProbeCtx): Promise<ProbeOutcome> {
  const findings: Finding[] = [];
  const metrics: Record<string, number | string | null> = {};
  const prompt = '请只回复一个词：pong';
  const serialTtfts: number[] = [];
  const concurrentTtfts: number[] = [];
  let serialNulls = 0;
  let concurrentNulls = 0;

  const serialSample = async (label: string): Promise<number | null> => {
    const messages: ChatMessage[] = [{ role: 'user', content: prompt }];
    const result = await ctx.client.chat({ model: ctx.cfg.model, messages, temperature: 0, max_tokens: 8, stream: true });
    recordCall(ctx.evidence, {
      probe: 'ttft',
      label,
      request: { model: ctx.cfg.model, stream: true, temperature: 0, maxTokens: 8, messages },
      result,
    });
    return result.ok ? result.ttftMs : null;
  };

  const serialCount = 5;
  for (let i = 0; i < serialCount; i += 1) {
    const ttft = await serialSample(`ttft serial #${i + 1}`);
    if (ttft === null) serialNulls += 1;
    else serialTtfts.push(ttft);
  }

  const rounds = 3;
  const concurrency = 4;
  for (let round = 0; round < rounds; round += 1) {
    const batch = Array.from({ length: concurrency }, (_, i) =>
      serialSample(`ttft concurrent r${round + 1} #${i + 1}`),
    );
    const results = await Promise.all(batch);
    for (const ttft of results) {
      if (ttft === null) concurrentNulls += 1;
      else concurrentTtfts.push(ttft);
    }
  }

  metrics['serial_samples'] = serialTtfts.length;
  metrics['concurrent_samples'] = concurrentTtfts.length;
  if (serialTtfts.length > 0) {
    metrics['serial_p50_ms'] = Math.round(quantile(serialTtfts, 0.5));
    metrics['serial_p95_ms'] = Math.round(quantile(serialTtfts, 0.95));
  }
  if (concurrentTtfts.length > 0) {
    metrics['concurrent_c4_p50_ms'] = Math.round(quantile(concurrentTtfts, 0.5));
    metrics['concurrent_c4_p95_ms'] = Math.round(quantile(concurrentTtfts, 0.95));
  }

  const serialP50 = serialTtfts.length > 0 ? Math.round(quantile(serialTtfts, 0.5)) : null;
  const concurrentP50 = concurrentTtfts.length > 0 ? Math.round(quantile(concurrentTtfts, 0.5)) : null;

  findings.push({
    level: 'info',
    message:
      serialP50 === null && concurrentP50 === null
        ? 'TTFT 观测：未获得任何流式首字时间（端点可能不支持流式）。仅观测，不计分。'
        : `TTFT 观测：串行 p50 ${serialP50 ?? '-'}ms，并发(c=4) p50 ${concurrentP50 ?? '-'}ms。仅采样不计分；绝对延迟受网络与地域影响，不可单独定罪。`,
    evidenceIds: [],
  });
  if (serialNulls > 0 || concurrentNulls > 0) {
    findings.push({
      level: 'info',
      message: `TTFT 采样缺失：串行 ${serialNulls}/${serialCount}、并发 ${concurrentNulls}/${rounds * concurrency} 次无首字时间。`,
      evidenceIds: [],
    });
  }

  const headline =
    serialP50 === null && concurrentP50 === null
      ? 'TTFT 未观测到流式数据（仅观测项）'
      : `TTFT 观测：串行 p50 ${serialP50}ms / 并发(4) p50 ${concurrentP50}ms（仅观测，不计分）`;

  return { id: 'ttft', status: 'insufficient', score: null, level: 'unknown', headline, findings, metrics };
}
