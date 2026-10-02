import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../../src/report/markdown.js';
import { renderHtml } from '../../src/report/html.js';
import type { AuditReport } from '../../src/types.js';

function sampleReport(textPreview: string): AuditReport {
  return {
    meta: {
      tool: '0.1.0',
      version: 'v0.1.0',
      probesetVersion: 'v0.1.0',
      assetsVersion: 'assets-v0.1.0',
      model: 'gpt-4o<script>',
      baseUrl: 'https://relay.example.com/v1',
      seed: 42,
      startedAt: '2026-01-01T00:00:00Z',
      durationMs: 1234,
      nodeVersion: 'v22.0.0',
      claimedContext: 32768,
    },
    total: 88,
    overall: 'warn',
    scores: [
      { id: 'identity', weight: 15, score: 100, level: 'pass', headline: 'ok', status: 'ok' },
    ],
    outcomes: [
      {
        id: 'identity',
        status: 'ok',
        score: 100,
        level: 'pass',
        headline: 'ok',
        findings: [{ level: 'info', message: 'note', evidenceIds: ['ev-001'] }],
        metrics: { samples: 3 },
      },
    ],
    evidence: [
      {
        id: 'ev-001',
        probe: 'identity',
        label: 'probe',
        request: {
          model: 'gpt-4o',
          stream: false,
          temperature: 0,
          maxTokens: 10,
          messageCount: 1,
          lastUserPreview: 'hello <img src=x onerror=alert(1)>',
          lastUserChars: 10,
          totalChars: 10,
        },
        response: {
          status: 200,
          textPreview,
          textChars: textPreview.length,
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
          toolCallCount: 0,
          error: null,
        },
        ttftMs: null,
        durationMs: 5,
        ts: '2026-01-01T00:00:00Z',
      },
    ],
    notes: ['note <b>'],
  };
}

test('html escapes model output and metadata (no raw script tags)', () => {
  const html = renderHtml(sampleReport('<script>alert("x")</script>'));
  assert.ok(!html.includes('<script>alert("x")</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'));
  assert.ok(!html.includes('gpt-4o<script>'));
  assert.ok(html.includes('&quot;'));
});

test('html escapes attribute-context payloads', () => {
  const html = renderHtml(sampleReport(`" onmouseover="alert(1)`));
  assert.ok(!html.includes('onmouseover="alert(1)"'));
  assert.ok(html.includes('&quot; onmouseover=&quot;alert(1)'));
});

test('html escapes single quotes and ampersands', () => {
  const html = renderHtml(sampleReport(`it's a & b`));
  assert.ok(html.includes('it&#39;s a &amp; b'));
});

test('markdown escapes pipes and fences, keeps evidence ids', () => {
  const md = renderMarkdown(sampleReport('a|b ``` c'));
  assert.ok(md.includes('ev-001'));
  assert.ok(md.includes('\\|'));
  assert.ok(md.includes('`` `'));
});
