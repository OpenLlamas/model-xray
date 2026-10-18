import type { AuditReport, EvidenceRecord, EvidenceRequest, Usage } from '../types.js';

/**
 * 报告 JSON 序列化器：不依赖对象键直出——顶层与 evidence 均逐字段显式构造，
 * 把 finishReason 显式映射为 snake_case finish_reason（与 usage 的 prompt_tokens 等
 * OpenAI API 惯例一致）。顶层形状是报告消费方（网页壳/第三方脚本）的版本化契约，
 * 新增字段必须在此显式登记，禁止静默直出；nullable 契约字段统一 `?? null`，
 * 保证键恒存在（JSON.stringify 会静默省略 undefined 值的键）。
 */
export function renderJson(report: AuditReport): string {
  const payload = {
    meta: report.meta,
    total: report.total ?? null,
    overall: report.overall,
    scores: report.scores,
    outcomes: report.outcomes,
    evidence: report.evidence.map(serializeEvidenceRecord),
    notes: report.notes,
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function serializeEvidenceRecord(record: EvidenceRecord): Record<string, unknown> {
  return {
    id: record.id,
    probe: record.probe,
    label: record.label,
    request: serializeRequest(record.request),
    response: {
      status: record.response.status,
      model: record.response.model ?? null,
      textPreview: record.response.textPreview,
      textChars: record.response.textChars,
      usage: serializeUsage(record.response.usage),
      usageRejected: record.response.usageRejected ?? null,
      attempts: record.response.attempts,
      toolCallCount: record.response.toolCallCount,
      finish_reason: record.response.finishReason ?? null,
      error: record.response.error ?? null,
      raw: record.response.raw,
      rawChars: record.response.rawChars,
    },
    ttftMs: record.ttftMs ?? null,
    durationMs: record.durationMs,
    ts: record.ts,
  };
}

function serializeRequest(request: EvidenceRequest): Record<string, unknown> {
  return {
    model: request.model,
    stream: request.stream,
    temperature: request.temperature ?? null,
    maxTokens: request.maxTokens ?? null,
    messageCount: request.messageCount,
    lastUserPreview: request.lastUserPreview,
    lastUserTailPreview: request.lastUserTailPreview,
    lastUserChars: request.lastUserChars,
    totalChars: request.totalChars,
  };
}

function serializeUsage(usage: Usage | null): Record<string, unknown> | null {
  if (usage === null) return null;
  return {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    cached_tokens: usage.cached_tokens ?? null,
    reasoning_tokens: usage.reasoning_tokens ?? null,
  };
}
