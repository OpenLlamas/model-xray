import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderJson } from '../../src/report/json.js';
import { renderMarkdown } from '../../src/report/markdown.js';
import { renderHtml } from '../../src/report/html.js';
import { renderConsole } from '../../src/report/console.js';
import { createEvidenceRecorder, recordCall } from '../../src/evidence.js';
import type { AuditReport, ChatResult, ProbeOutcome, ScoreEntry } from '../../src/types.js';

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
          lastUserTailPreview: '',
          lastUserChars: 10,
          totalChars: 10,
          stop: null,
          seed: null,
          n: null,
          logprobs: null,
          topLogprobs: null,
          responseFormat: null,
        },
        response: {
          status: 200,
          model: null,
          textPreview,
          textChars: textPreview.length,
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
          usageRejected: null,
          attempts: 1,
          temperatureDropped: false,
          toolCallCount: 0,
          finishReason: 'length',
          choiceCount: 1,
          logprobsTokenCount: null,
          viaStream: false,
          error: null,
          raw: '',
          rawChars: 0,
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

test('recordCall：长请求保留尾部摘要（按 code point 截断），短请求为空', () => {
  const recorder = createEvidenceRecorder();
  const result: ChatResult = {
    ok: true,
    status: 200,
    finishReason: 'stop',
    model: null,
    text: 'ok',
    reasoning: null,
    usage: null,
    usageRejected: null,
    attempts: 1,
    toolCalls: [],
    ttftMs: null,
    durationMs: 1,
    error: null,
    raw: '',
  };
  const tail = '编号ABC123';
  const long = recordCall(recorder, {
    probe: 'context',
    label: 'long',
    request: { model: 'm', stream: false, messages: [{ content: `${'头'.repeat(900)}${tail}` }] },
    result,
  });
  assert.ok(long.request.lastUserTailPreview.startsWith('…'));
  assert.ok(long.request.lastUserTailPreview.endsWith(tail));
  assert.equal(Array.from(long.request.lastUserTailPreview).length, 401);
  const short = recordCall(recorder, {
    probe: 'context',
    label: 'short',
    request: { model: 'm', stream: false, messages: [{ content: '短请求' }] },
    result,
  });
  assert.equal(short.request.lastUserTailPreview, '');
});

test('params evidence: JSON 序列化协议参数与解析计数，MD/HTML 同步展示', () => {
  const report = sampleReport('ok');
  report.evidence[0]!.probe = 'params';
  const request = report.evidence[0]!.request;
  request.stop = ['XRAYSTOPABC123'];
  request.seed = 12345;
  request.n = 2;
  request.logprobs = true;
  request.topLogprobs = 3;
  request.responseFormat = 'json_object';
  const response = report.evidence[0]!.response;
  response.choiceCount = 2;
  response.choiceIndices = [0, 1];
  response.choiceNonEmptyCount = 2;
  response.logprobsTokenCount = 2;
  response.logprobsInvalidCount = 0;
  response.topLogprobsTokenCount = 2;
  response.viaStream = false;
  response.temperatureDropped = true;

  const json = JSON.parse(renderJson(report)) as {
    evidence: Array<{
      request: Record<string, unknown>;
      response: Record<string, unknown>;
    }>;
  };
  assert.deepEqual(json.evidence[0]!.request['stop'], ['XRAYSTOPABC123']);
  assert.equal(json.evidence[0]!.request['seed'], 12345);
  assert.equal(json.evidence[0]!.request['n'], 2);
  assert.equal(json.evidence[0]!.request['logprobs'], true);
  assert.equal(json.evidence[0]!.request['topLogprobs'], 3);
  assert.equal(json.evidence[0]!.request['responseFormat'], 'json_object');
  assert.equal(json.evidence[0]!.response['choiceCount'], 2);
  assert.deepEqual(json.evidence[0]!.response['choiceIndices'], [0, 1]);
  assert.equal(json.evidence[0]!.response['choiceNonEmptyCount'], 2);
  assert.equal(json.evidence[0]!.response['logprobsTokenCount'], 2);
  assert.equal(json.evidence[0]!.response['logprobsInvalidCount'], 0);
  assert.equal(json.evidence[0]!.response['topLogprobsTokenCount'], 2);
  assert.equal(json.evidence[0]!.response['temperatureDropped'], true);

  const md = renderMarkdown(report);
  assert.match(md, /- 协议参数: stop=.*seed=12345.*n=2.*logprobs=true/);
  assert.match(md, /tempDropped=true/);
  const html = renderHtml(report);
  assert.ok(html.includes('协议参数'));
  assert.ok(html.includes('choices=2'));
  assert.ok(html.includes('logprobs=2'));
  assert.ok(html.includes('tempDropped=true'));
});

test('旧报告 evidence 缺协议字段：渲染不出现 undefined，JSON 归一为 null', () => {
  const report = sampleReport('ok');
  const evidence = report.evidence[0]!;
  evidence.probe = 'params';
  delete evidence.request.stop;
  delete evidence.request.seed;
  delete evidence.request.n;
  delete evidence.request.logprobs;
  delete evidence.request.topLogprobs;
  delete evidence.request.responseFormat;
  delete evidence.response.choiceCount;
  delete evidence.response.choiceIndices;
  delete evidence.response.choiceNonEmptyCount;
  delete evidence.response.logprobsTokenCount;
  delete evidence.response.logprobsInvalidCount;
  delete evidence.response.topLogprobsTokenCount;
  delete evidence.response.viaStream;
  delete (evidence.response as { temperatureDropped?: boolean }).temperatureDropped;
  const md = renderMarkdown(report);
  const html = renderHtml(report);
  assert.ok(!md.includes('undefined'));
  assert.ok(!html.includes('undefined'));
  const json = JSON.parse(renderJson(report)) as {
    evidence: Array<{ request: Record<string, unknown>; response: Record<string, unknown> }>;
  };
  assert.equal(json.evidence[0]!.request['stop'], null);
  assert.equal(json.evidence[0]!.response['choiceCount'], null);
  assert.equal(json.evidence[0]!.response['choiceIndices'], null);
  assert.equal(json.evidence[0]!.response['choiceNonEmptyCount'], null);
  assert.equal(json.evidence[0]!.response['viaStream'], null);
  assert.equal(json.evidence[0]!.response['temperatureDropped'], null);
  assert.ok(md.includes('viaStream=n/a'));
  assert.ok(html.includes('viaStream=n/a'));
});

test('长请求：HTML/Markdown 保留结尾摘要，且同样转义', () => {
  const report = sampleReport('ok');
  const request = report.evidence[0]!.request;
  request.lastUserChars = 5000;
  request.lastUserTailPreview = '结尾问题：编号ABC123 <script>alert(1)</script>';
  const html = renderHtml(report);
  assert.ok(html.includes('请求结尾'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  const md = renderMarkdown(report);
  assert.ok(md.includes('请求结尾'));
  assert.ok(md.includes('编号ABC123'));
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

test('markdown: quote()（列表上下文）不再转义管道，仍转义反引号围栏', () => {
  const md = renderMarkdown(sampleReport('a|b ``` c'));
  assert.ok(md.includes('ev-001'));
  assert.ok(md.includes('a|b `` ` c'), 'quote 保留字面管道、仍转义围栏');
  assert.ok(!md.includes('\\|'), '列表上下文的 \\| 是字面噪声，不应出现');
});

test('markdown: cell()（表格上下文）保持管道转义，破列仍被防住', () => {
  const report = reportWith(
    [{ id: 'identity', weight: 15, score: 100, level: 'pass', headline: 'a|b', status: 'ok' }],
    [],
  );
  const md = renderMarkdown(report);
  assert.ok(md.includes('| identity | PASS | 100 | 15 | a\\|b |'));
});

test('report json serializes evidence finish_reason in snake_case (explicit mapping, no camelCase key)', () => {
  const json = renderJson(sampleReport('x'));
  assert.ok(json.includes('"finish_reason": "length"'), json.slice(0, 400));
  assert.ok(!json.includes('finishReason'), 'camelCase finishReason must not leak into report JSON');
  const parsed = JSON.parse(json) as { evidence: Array<{ response: Record<string, unknown> }> };
  assert.equal(parsed.evidence[0]?.response['finish_reason'], 'length');
  assert.equal(parsed.evidence[0]?.response['raw'], '');
  assert.equal(parsed.evidence[0]?.response['rawChars'], 0);
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

test('html/md：检测详情与评分卡同源——fail 维度显示 scores 封顶分，不显示探针原始分', () => {
  // 实锤封顶语义：探针原始分 70（PRICING_FAILED_SCORE）在聚合层被压到 45，
  // 详情区标题必须与评分卡同为 45，否则同一份报告出现「评分卡 45 / 详情 70」的矛盾。
  const report = reportWith(
    [{ id: 'billing', weight: 25, score: 45, level: 'fail', headline: '换芯实锤', status: 'ok' }],
    [
      { id: 'billing', status: 'ok', score: 70, level: 'fail', headline: '换芯实锤', findings: [], metrics: {} },
      { id: 'decoy', status: 'ok', score: null, level: 'unknown', headline: '诱饵', findings: [], metrics: {} },
    ],
  );
  const md = renderMarkdown(report);
  assert.match(md, /### billing — FAIL（45）/, '详情区必须显示封顶分 45');
  assert.ok(!md.includes('（70）'), `详情区不得出现原始分 70：${md.split('\n').find((l) => l.includes('billing'))}`);
  assert.match(md, /### decoy — N\/A（未判定）/, 'scores 未覆盖的观测项回退 outcome.score');
  const html = renderHtml(report);
  assert.match(html, /\(45\)<\/h3>/, 'HTML 详情区必须显示封顶分 45');
  assert.ok(!html.includes('(70)</h3>'), 'HTML 详情区不得出现原始分 70');
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

// ---------- 可信度框架（v0.2.1）：标签 + 固定注记 + 无基线提示 ----------

test('markdown：总分标签为「可信度总分：」且结论后置，null 总分记 未判定', () => {
  const md = renderMarkdown(sampleReport('x'));
  // warn 轮只展示分数，无结论词（「可疑」档已移除）
  assert.match(md, /> 可信度总分：\*\*88\/100\*\*(?![^\n]*结论)/);
  assert.ok(!md.includes('可疑'));
  const fail = { ...sampleReport('x'), overall: 'fail' as const };
  assert.match(renderMarkdown(fail), /> 可信度总分：\*\*88\/100\*\* · 结论：\*\*不通过\*\*/);
  const unknown = { ...sampleReport('x'), total: null, overall: 'unknown' as const };
  assert.match(renderMarkdown(unknown), /> 可信度总分：\*\*未判定\*\* · 结论：\*\*未判定\*\*/);
});

test('html/console：总分标签同步为「可信度总分」', () => {
  const html = renderHtml(sampleReport('x'));
  assert.ok(html.includes('<strong>可信度总分 88/100</strong>'), html.slice(0, 600));
  assert.ok(!html.includes('<strong>总分 '));
  assert.ok(!html.includes('可疑'), 'warn 轮 HTML 不出现「可疑」徽标/文案');
  const failHtml = renderHtml({ ...sampleReport('x'), overall: 'fail' as const });
  assert.ok(failHtml.includes('>不通过</span>'), failHtml.slice(0, 600));
  const console_ = renderConsole(sampleReport('x'), { color: false });
  // warn 轮 console 只给分数，无结论后缀
  assert.match(console_, /可信度总分 88\/100\n/);
  assert.ok(!console_.includes('可疑'));
  const failConsole = renderConsole({ ...sampleReport('x'), overall: 'fail' as const }, { color: false });
  assert.match(failConsole, /可信度总分 88\/100 — 不通过/);
  const unknown = { ...sampleReport('x'), total: null, overall: 'unknown' as const };
  assert.match(renderConsole(unknown, { color: false }), /可信度总分 未判定 — 证据不足，无法得出结论/);
});

test('markdown/html：说明段固定追加可信度框架注记（notes 为空也渲染）', () => {
  const fixedNote = '本报告输出可信度评分与异常证据，不对模型真伪做二元断言；结论与退出码仅供 CI 门禁参考。';
  const md = renderMarkdown(sampleReport('x'));
  assert.ok(md.includes(fixedNote), md);
  const emptyNotes = { ...sampleReport('x'), notes: [] };
  assert.ok(renderMarkdown(emptyNotes).includes('## 说明'), 'notes 为空时说明段仍应渲染');
  assert.ok(renderMarkdown(emptyNotes).includes(fixedNote));
  const html = renderHtml(emptyNotes);
  assert.ok(html.includes('<h2>说明</h2>'));
  assert.ok(html.includes(fixedNote));
});

test('markdown/html/console/json：报告 notes（含无基线提示）在四处渲染器均输出', () => {
  const hint = '未加载指纹基线：无法对比历史指纹，同族换壳/静默降级不可检测。建议固定基线后用 --baseline 复测。';
  const report = { ...sampleReport('x'), notes: [hint] };
  assert.ok(renderMarkdown(report).includes(hint), 'markdown 应渲染 notes');
  assert.ok(renderHtml(report).includes(hint), 'html 应渲染 notes');
  assert.ok(renderConsole(report, { color: false }).includes(hint), 'console 应渲染 notes');
  const parsed = JSON.parse(renderJson(report)) as { notes: string[] };
  assert.ok(parsed.notes.includes(hint), 'json 序列化整个 report.notes');
});

// ---------- 本次多模型审查修复的回归测试 ----------

test('summary：pass 级 outcome 携带 warn finding 仍入异常要点（不做 outcome.level 门槛）', () => {
  const billingPassWithWarn: ProbeOutcome = {
    id: 'billing',
    status: 'ok',
    score: 95,
    level: 'pass',
    headline: 'Token 计数与长度线性关系正常',
    findings: [{ level: 'warn', message: '端点自报 total_tokens 与 prompt+completion 不一致（第 3 笔）', evidenceIds: ['ev-001'] }],
    metrics: {},
  };
  const report = reportWith(
    [{ id: 'billing', weight: 25, score: 95, level: 'pass', headline: 'Token 计数与长度线性关系正常', status: 'ok' }],
    [billingPassWithWarn],
  );
  const md = renderMarkdown(report);
  assert.match(md, /- \*\*WARN\*\* \[billing\] 端点自报 total_tokens/);
  const html = renderHtml(report);
  assert.ok(html.includes('<div class="anomaly warn">'), 'pass 级 outcome 的 warn finding 不再漏报「未发现异常」');
  assert.match(html, /WARN<\/span> <span class="dim">billing<\/span> 端点自报 total_tokens/);
  assert.match(renderConsole(report), /\[WARN\] *billing: 端点自报 total_tokens/);
});

test('summary：fail 级 outcome 的 fail/warn findings 只有 warn 时补 headline 合成 FAIL 行（quality 场景）', () => {
  const qualityFail: ProbeOutcome = {
    id: 'quality',
    status: 'ok',
    score: 55,
    level: 'fail',
    headline: '程序化题集正确率过低',
    findings: [{ level: 'warn', message: '控制题 q1 因推理占满预算未作答', evidenceIds: ['ev-001'] }],
    metrics: {},
  };
  const report = reportWith(
    [{ id: 'quality', weight: 25, score: 55, level: 'fail', headline: '程序化题集正确率过低', status: 'ok' }],
    [qualityFail],
  );
  const md = renderMarkdown(report);
  assert.match(md, /- \*\*WARN\*\* \[quality\] 控制题 q1/);
  assert.match(md, /- \*\*FAIL\*\* \[quality\] 程序化题集正确率过低/, '异常要点区必须有 FAIL 行与分项表口径一致');
  assert.ok(md.indexOf('- **FAIL** [quality]') < md.indexOf('- **WARN** [quality]'), 'fail 优先排序');
});

test('report json：顶层为显式契约键序，文件以换行结尾', () => {
  const json = renderJson(sampleReport('x'));
  assert.ok(json.endsWith('\n'), 'JSON 文件以 POSIX 换行结尾');
  const parsed = JSON.parse(json) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(parsed),
    ['meta', 'total', 'overall', 'scores', 'outcomes', 'evidence', 'notes'],
    '顶层键为显式版本化契约，防止静默直出漂移',
  );
});

test('html：0 条证据时输出明示空态，不再渲染「原始证据（0 条）」悬空标题', () => {
  const report = { ...sampleReport('x'), evidence: [] };
  const html = renderHtml(report);
  assert.ok(!html.includes('原始证据（'));
  assert.ok(html.includes('本次审计未产生原始证据记录'));
});

test('console：unknown 行 [N/A] 补齐 6 列、未评分得分列为对齐的 -', () => {
  const report = reportWith(
    [
      failScore,
      { id: 'ttft', weight: 10, score: null, level: 'unknown', headline: '未判定', status: 'insufficient' },
    ],
    [],
  );
  const out = renderConsole(report, { color: false });
  assert.match(out, /\[N\/A\]\s+ttft\s+-/, '[N/A] 5 字符须补齐到 6 列，得分列 - 与其他行对齐');
});

test('console/markdown：C0/C1 控制字符（终端转义注入）在渲染边界被剥离', () => {
  const dirtyOutcome: ProbeOutcome = {
    id: 'identity',
    status: 'ok',
    score: 40,
    level: 'fail',
    headline: '被注入\u001b[31m红色\u0007',
    findings: [{ level: 'fail', message: '消息\u0002带控制符', evidenceIds: [] }],
    metrics: {},
  };
  const report = reportWith([failScore], [dirtyOutcome]);
  const out = renderConsole(report, { color: false });
  assert.ok(!out.includes('\u001b[31m') && !out.includes('\u0007') && !out.includes('\u0002'), JSON.stringify(out.slice(0, 300)));
  const md = renderMarkdown(report);
  assert.ok(!md.includes('\u001b') && !md.includes('\u0007') && !md.includes('\u0002'), 'Markdown 报告同样剥离控制符');
  // 正文内容保留（只剥控制字节；残留的 "[31m" 是惰性文本，无 ESC 前缀不会被终端解释）
  assert.ok(md.includes('被注入[31m红色'), JSON.stringify(md.slice(md.indexOf('被注入') - 20, md.indexOf('被注入') + 20)));
});

// ---------------------------------------------------------------------------
// 计费与倍率摘要块：倍率必须一眼可见（不许只埋在几十行原始指标表里）
// ---------------------------------------------------------------------------

function billingOutcome(metrics: Record<string, number | string | null> = {}): ProbeOutcome {
  return {
    id: 'billing',
    status: 'ok',
    score: 85,
    level: 'pass',
    headline: 'token 计数核验通过，未发现造假证据；实扣倍率无法计算（该站没有可用的余额接口）；补充说明：实际扣款未核对（该站没有可用的余额接口）；未与外部硬证据比对（实扣倍率、历史用量基准均缺）',
    findings: [],
    metrics: {
      pricing_state: 'ok',
      declared_origin: 'https://relay.example.com',
      declared_model_ratio: 2,
      declared_completion_ratio: 5,
      measured_ratio: 'N/A',
      money_check_state: 'not_applicable',
      balance_probe_reason: '候选余额接口均不可用（origin https://relay.example.com）',
      evidence_level: 'shape-only',
      ...metrics,
    },
  };
}

test('markdown：计费维度输出「计费与倍率」摘要块（公示倍率 / 实扣倍率 / 为何没有倍率的原因）', () => {
  const md = renderMarkdown(reportWith([], [billingOutcome()]));
  assert.ok(md.includes('**计费与倍率**'), '计费维度必须有中文标签的倍率摘要块');
  assert.ok(md.includes('| 公示输入倍率（公开价表为反推值） | 2 |'), `缺公示输入倍率：${md}`);
  assert.ok(md.includes('| 公示输出倍率（公开价表为反推值） | 5 |'), `缺公示输出倍率：${md}`);
  assert.ok(md.includes('| 实扣倍率（实际扣费÷应缴） | N/A |'), `缺实扣倍率：${md}`);
  assert.ok(md.includes('| 余额探测原因 | 候选余额接口均不可用（origin https://relay.example.com） |'), '缺「为什么没有倍率」的原因字段');
  assert.ok(md.includes('| 证据等级（shape-only / absolute） | shape-only |'), '缺证据等级（形状证据 vs 绝对对账）');
});

test('html：计费维度输出「计费与倍率」摘要块（与 markdown 同口径）', () => {
  const html = renderHtml(reportWith([], [billingOutcome()]));
  assert.ok(html.includes('<h4>计费与倍率</h4>'), 'HTML 计费维度缺倍率摘要块');
  assert.ok(html.includes('公示输入倍率'), 'HTML 缺公示输入倍率标签');
  assert.ok(html.includes('实扣倍率'), 'HTML 缺实扣倍率标签');
  assert.ok(html.includes('余额探测原因'), 'HTML 缺余额探测原因');
});

test('console：终端输出带倍率摘要行（实测 / 金额核验状态）', () => {
  const out = renderConsole(reportWith([], [billingOutcome()]), { color: false });
  assert.match(out, /倍率: 实扣 N\/A · 金额核验 not_applicable/);
});

test('console：实测不可得但有录入价/当前公示价时，主位给 1×，列表折扣只作附注', () => {
  const out = renderConsole(
    reportWith(
      [],
      [
        billingOutcome({
          claimed_price_ratio_input: 1,
          claimed_price_ratio_output: 1,
          public_price_ratio_input: 0.3,
          public_price_ratio_output: 0.3,
        }),
      ],
    ),
    { color: false },
  );
  assert.match(
    out,
    /倍率: 你填的单价÷站点现价 1×（输入\/输出一致；只比价目，未看实扣） · 站点现价÷官方列表价 0\.3×（输入\/输出一致，仅披露） · 实际扣款未核对 · 金额核验 not_applicable/,
  );
  assert.ok(!out.includes('实测 N/A'), out);
});

test('console：价格核验默认模式给出倍率与计费探针费用（不读余额）', () => {
  const outcome = billingOutcome({
    claimed_price_ratio_input: 1,
    claimed_price_ratio_output: 1,
    public_price_ratio_input: 0.3,
    public_price_ratio_output: 0.3,
    expected_cost_usd_declared: 0.016,
    cost_is_upper_bound: 1,
  });
  delete outcome.metrics['measured_ratio'];
  delete outcome.metrics['balance_probe_reason'];
  outcome.headline =
    'token 计数核验通过，未发现造假证据；按价目应扣 $0.016（估算，上界）；实扣 未测（默认不读余额）；补充说明：未与外部硬证据比对（实扣倍率、历史用量基准均缺）';
  const out = renderConsole(reportWith([], [outcome]), { color: false });
  assert.match(
    out,
    /倍率: 你填的单价÷站点现价 1×（输入\/输出一致；只比价目，未看实扣） · 站点现价÷官方列表价 0\.3×（输入\/输出一致，仅披露） · 本轮测试按价目应扣 \$0\.016（估算，上界） · 金额核验 not_applicable/,
  );
  // 默认模式（不读余额）的倍率行不得泄漏余额探测产物（实测值/余额接口状态只属于余额模式）
  const ratioLine = out.split('\n').find((line) => line.startsWith('倍率:')) ?? '';
  assert.ok(!ratioLine.includes('实测'), ratioLine);
  assert.ok(!ratioLine.includes('余额'), ratioLine);
});

test('markdown：录入价/当前公示价核对与列表价折扣各有独立标签（不埋在原始 JSON 里）', () => {
  const md = renderMarkdown(
    reportWith(
      [],
      [
        billingOutcome({
          claimed_price_ratio_input: 1,
          claimed_price_ratio_output: 1,
          public_price_ratio_input: 0.3,
          public_price_ratio_output: 0.3,
        }),
      ],
    ),
  );
  assert.ok(md.includes('| 你填的单价÷站点现价（输入；只比价目，未看实扣） | 1 |'), md);
  assert.ok(md.includes('| 你填的单价÷站点现价（输出；只比价目，未看实扣） | 1 |'), md);
  assert.ok(md.includes('| 站点现价÷官方列表价（输入；仅披露） | 0.3 |'), md);
  assert.ok(md.includes('| 站点现价÷官方列表价（输出；仅披露） | 0.3 |'), md);
});

test('无计费探针的报告不出现倍率摘要块（老报告不炸）', () => {
  assert.ok(!renderMarkdown(sampleReport('x')).includes('计费与倍率'));
  assert.ok(!renderHtml(sampleReport('x')).includes('计费与倍率'));
  assert.ok(!renderConsole(sampleReport('x'), { color: false }).includes('倍率: '));
});

test('漂移钉子：控制台与 CLI 报告的倍率标签表同口径（键、中文标签、顺序一致）', () => {
  const reportLabels = extractBillingLabels(readFileSync(join(repoRoot(), 'src', 'report', 'markdown.ts'), 'utf8'), 'export const BILLING_METRIC_LABELS');
  const consoleLabels = extractBillingLabels(readFileSync(join(repoRoot(), 'web', 'app.js'), 'utf8'), 'const BILLING_METRIC_LABELS');
  assert.ok(reportLabels.length > 0 && consoleLabels.length > 0, '标签表不得为空');
  assert.deepEqual(consoleLabels, reportLabels, '控制台与报告的倍率标签表漂移了（web/app.js vs src/report/markdown.ts）');
  // 关键标签必须在册（用户诉求：公示倍率 / 实扣倍率 / 原因 / 证据等级）
  for (const key of [
    'declared_model_ratio',
    'declared_completion_ratio',
    'claimed_price_ratio_input',
    'claimed_price_ratio_output',
    'public_price_ratio_input',
    'public_price_ratio_output',
    'measured_ratio',
    'balance_probe_reason',
    'evidence_level',
    'money_check_state',
  ]) {
    assert.ok(reportLabels.some(([k]) => k === key), `标签表缺少关键指标 ${key}`);
  }
});

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'src', 'report', 'markdown.ts'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('未找到 src/report/markdown.ts：请在仓库根目录下构建并运行测试。');
}

function extractBillingLabels(source: string, marker: string): Array<[string, string]> {
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `未找到标签表标记 ${marker}`);
  const end = source.indexOf('];', start);
  assert.ok(end > start, '标签表结束边界异常');
  const region = source.slice(start, end);
  return [...region.matchAll(/\['([a-z0-9_]+)', '([^']+)'\]/g)].map((m) => [m[1]!, m[2]!] as [string, string]);
}
