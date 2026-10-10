import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderJson } from '../../src/report/json.js';
import { renderMarkdown } from '../../src/report/markdown.js';
import { renderHtml } from '../../src/report/html.js';
import { renderConsole } from '../../src/report/console.js';
import type { AuditReport, ProbeOutcome, ScoreEntry } from '../../src/types.js';

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
          usageRejected: null,
          attempts: 1,
          toolCallCount: 0,
          finishReason: 'length',
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

test('report json serializes evidence finish_reason in snake_case (explicit mapping, no camelCase key)', () => {
  const json = renderJson(sampleReport('x'));
  assert.ok(json.includes('"finish_reason": "length"'), json.slice(0, 400));
  assert.ok(!json.includes('finishReason'), 'camelCase finishReason must not leak into report JSON');
  const parsed = JSON.parse(json) as { evidence: Array<{ response: Record<string, unknown> }> };
  assert.equal(parsed.evidence[0]?.response['finish_reason'], 'length');
});

// ---------- 异常要点 / 权重列 / dark mode / 控制台着色 ----------

function reportWith(scores: ScoreEntry[], outcomes: ProbeOutcome[]): AuditReport {
  return { ...sampleReport('x'), scores, outcomes };
}

const identityFailOutcome: ProbeOutcome = {
  id: 'identity',
  status: 'ok',
  score: 40,
  level: 'fail',
  headline: '请求模型与自述不符',
  findings: [
    { level: 'fail', message: '自述模型与请求模型不一致', evidenceIds: ['ev-001', 'ev-002'] },
    { level: 'warn', message: '行为指纹漂移', evidenceIds: ['ev-003'] },
    { level: 'info', message: '仅记录项', evidenceIds: [] },
  ],
  metrics: {},
};

// C7：capability 全 partial 抬升 warn（无 fail/warn findings，靠 headline 合成一条）
const capabilityWarnOutcome: ProbeOutcome = {
  id: 'capability',
  status: 'ok',
  score: 55,
  level: 'warn',
  headline: '标称能力部分达成：vision partial 抬升为 warn',
  findings: [{ level: 'info', message: 'vision: partial（误差带内 1/3）', evidenceIds: ['ev-101'] }],
  metrics: {},
};

const failScore: ScoreEntry = { id: 'identity', weight: 15, score: 40, level: 'fail', headline: '请求模型与自述不符', status: 'ok' };

test('html：异常要点置顶盒聚合 fail/warn findings（fail 优先），每条前缀探针 id + 证据 id', () => {
  const html = renderHtml(reportWith([failScore], [identityFailOutcome, capabilityWarnOutcome]));
  assert.ok(html.includes('<div class="anomaly fail">'), '有 fail 时盒子为 fail 类');
  assert.ok(html.includes('异常要点'));
  assert.match(html, /FAIL<\/span> <span class="dim">identity<\/span> 自述模型与请求模型不一致 .*\(ev-001, ev-002\)/);
  assert.match(html, /WARN<\/span> <span class="dim">identity<\/span> 行为指纹漂移/);
  // 只看置顶盒区域（检测详情区本就会展示全部 findings，包括 info）
  const box = html.slice(html.indexOf('<div class="anomaly'), html.indexOf('<h2>分项得分'));
  assert.ok(!box.includes('仅记录项'), 'info findings 不入异常要点');
  const failIndex = box.indexOf('自述模型与请求模型不一致');
  const warnIndex = box.indexOf('行为指纹漂移');
  assert.ok(failIndex >= 0 && failIndex < warnIndex, 'fail 应排在 warn 前');
});

test('html/md：无 fail/warn findings 的 warn outcome 以 headline 合成一条（capability 全 partial）', () => {
  const html = renderHtml(reportWith([], [capabilityWarnOutcome]));
  assert.ok(html.includes('<div class="anomaly warn">'));
  assert.match(html, /WARN<\/span> <span class="dim">capability<\/span> 标称能力部分达成：vision partial 抬升为 warn/);
  const md = renderMarkdown(reportWith([], [capabilityWarnOutcome]));
  assert.match(md, /## 异常要点/);
  assert.match(md, /- \*\*WARN\*\* \[capability\] 标称能力部分达成：vision partial 抬升为 warn/);
});

test('html/md/console：无异常时明示「未发现异常」（绿色盒）', () => {
  const report = sampleReport('x');
  const html = renderHtml(report);
  assert.ok(html.includes('<div class="anomaly ok">'));
  assert.ok(html.includes('未发现异常'));
  assert.ok(renderMarkdown(report).includes('## 异常要点'));
  assert.match(renderMarkdown(report), /未发现异常/);
  assert.match(renderConsole(report), /异常要点:\s*\n\s*未发现异常/);
});

test('html/md：分项得分表含权重列（0 显示 -）', () => {
  const html = renderHtml(sampleReport('x'));
  assert.ok(html.includes('<th>权重</th>'));
  assert.match(html, /<td>100<\/td><td>15<\/td>/, 'identity 得分 100 后应紧跟权重 15');

  const decoyScore: ScoreEntry = { id: 'decoy', weight: 0, score: null, level: 'unknown', headline: '诱饵', status: 'ok' };
  const htmlZero = renderHtml(reportWith([decoyScore], []));
  // decoy 行：判定 N/A、得分 -、权重 -（weight=0 显示 '-'）
  assert.match(htmlZero, /<td>decoy<div class="muted">[\s\S]*?<\/td><td class="tag unknown">N\/A<\/td><td>-<\/td><td>-<\/td>/);
  const md = renderMarkdown(sampleReport('x'));
  assert.ok(md.includes('| 检测项 | 判定 | 得分 | 权重 | 摘要 |'));
  assert.match(md, /\| identity \| PASS \| 100 \| 15 \|/);
});

test('html：每维度一行静态说明（id→测什么/评分依据）', () => {
  // 六个维度齐备的 fixture：说明随 score 条目逐行渲染
  const allDims: ScoreEntry[] = [
    { id: 'identity', weight: 15, score: 100, level: 'pass', headline: 'ok', status: 'ok' },
    { id: 'context', weight: 15, score: 100, level: 'pass', headline: 'ok', status: 'ok' },
    { id: 'billing', weight: 25, score: 100, level: 'pass', headline: 'ok', status: 'ok' },
    { id: 'capability', weight: 10, score: 55, level: 'warn', headline: 'partial', status: 'ok' },
    { id: 'quality', weight: 25, score: 100, level: 'pass', headline: 'ok', status: 'ok' },
    { id: 'ttft', weight: 10, score: 100, level: 'pass', headline: 'ok', status: 'ok' },
  ];
  const html = renderHtml(reportWith(allDims, []));
  assert.ok(html.includes('身份与指纹'));
  assert.ok(html.includes('长上下文实测'));
  assert.ok(html.includes('token 计量与线性'));
  assert.ok(html.includes('标称能力实测'));
  assert.ok(html.includes('程序化题集'));
  assert.ok(html.includes('流式首字延迟'));
  assert.ok(html.includes('评分依据'));
});

test('html：dark mode 样式存在（prefers-color-scheme + 异常盒红/橙/绿深底浅字）', () => {
  const html = renderHtml(sampleReport('x'));
  assert.ok(html.includes('prefers-color-scheme:dark'));
  assert.ok(html.includes('.anomaly.fail'));
  assert.ok(html.includes('.anomaly.warn'));
  assert.ok(html.includes('.anomaly.ok'));
  // dark 段里三类盒均有深底浅字覆盖
  const dark = html.slice(html.indexOf('prefers-color-scheme:dark'));
  assert.match(dark, /\.anomaly\.fail\{background:#3a1214;color:#ffb4ae/);
  assert.match(dark, /\.anomaly\.warn\{background:#33260d;color:#ffd48a/);
  assert.match(dark, /\.anomaly\.ok\{background:#0f2a18;color:#8fdca8/);
});

test('console：color=false 零 ANSI 且含异常要点块；color=true 着色（装饰），剥色后与纯文本一致', () => {
  const report = reportWith([failScore], [identityFailOutcome]);
  const plain = renderConsole(report, { color: false });
  assert.ok(!plain.includes('\u001b'), 'color=false 输出零 ANSI 字节');
  assert.match(plain, /异常要点:/);
  assert.match(plain, /\[FAIL\] identity: 自述模型与请求模型不一致 \(ev-001, ev-002\)/);
  assert.match(plain, /\[WARN\] identity: 行为指纹漂移/);
  assert.match(plain, /总分 /);

  const colored = renderConsole(report, { color: true });
  assert.ok(colored.includes('\u001b[31m'), 'fail 项应红');
  assert.ok(colored.includes('\u001b[33m'), 'warn 项应黄');
  assert.equal(colored.replace(/\u001b\[\d+m/g, ''), plain, '着色仅为装饰');
});
