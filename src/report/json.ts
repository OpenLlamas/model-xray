import type { AuditReport, EvidenceRecord } from '../types.js';

/**
 * 报告 JSON 序列化器：不依赖对象键直出——逐字段显式构造 evidence 响应，
 * 把 finishReason 显式映射为 snake_case finish_reason（与 usage 的 prompt_tokens 等
 * OpenAI API 惯例一致）。evidence 形状是报告消费方（网页壳/第三方脚本）的版本化契约，
 * 新增字段必须在此显式登记，禁止静默直出。
 */
export function renderJson(report: AuditReport): string {
  const payload = {
    ...report,
    evidence: report.evidence.map(serializeEvidenceRecord),
  };
  return JSON.stringify(payload, null, 2);
}

function serializeEvidenceRecord(record: EvidenceRecord): Record<string, unknown> {
  return {
    id: record.id,
    probe: record.probe,
    label: record.label,
    request: record.request,
    response: {
      status: record.response.status,
      textPreview: record.response.textPreview,
      textChars: record.response.textChars,
      usage: record.response.usage,
      usageRejected: record.response.usageRejected,
      attempts: record.response.attempts,
      toolCallCount: record.response.toolCallCount,
      finish_reason: record.response.finishReason,
      error: record.response.error,
    },
    ttftMs: record.ttftMs,
    durationMs: record.durationMs,
    ts: record.ts,
  };
}
