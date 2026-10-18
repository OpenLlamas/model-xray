// web/index.html ↔ web/app.js 接线烟雾回归：
// 页面里每个 button/input/textarea/select 的 id 都必须在 app.js 通过访问器被引用，
// 防「页面加了控件但前端没接线」；一次性检测表单与渠道表单的字段另钉在各自提交体里。
// （web/ 不参与 tsc 编译，此文件是编译后的运行时回归，构建后从 dist/test/unit 上溯仓库根。）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'web', 'index.html'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('未找到 web/index.html：请在仓库根目录构建并运行测试。');
}

const repoRoot = findRepoRoot();
const html = readFileSync(join(repoRoot, 'web', 'index.html'), 'utf8');
const app = readFileSync(join(repoRoot, 'web', 'app.js'), 'utf8');

/** 抽取 button/input/textarea/select 上的 id（属性顺序不限）。 */
function collectControlIds(source: string): string[] {
  const ids: string[] = [];
  for (const match of source.matchAll(/<(?:button|input|textarea|select)\b[^>]*\bid="([^"]+)"/g)) {
    if (match[1] !== undefined) ids.push(match[1]);
  }
  return ids;
}

// 显式豁免（每条注明原因，禁止静默扩大）：
const EXEMPT_IDS = new Map<string, string>([
  ['f-expect-vision', '动态 id：EXPECT_ALLOWED 循环按 `f-expect-${key}` 模板生成'],
  ['f-expect-tool', '动态 id：EXPECT_ALLOWED 循环按 `f-expect-${key}` 模板生成'],
  ['f-expect-thinking', '动态 id：EXPECT_ALLOWED 循环按 `f-expect-${key}` 模板生成'],
  ['btn-channel-save', 'type=submit：由 #channel-form 的 submit 事件统一处理，无独立 id 引用'],
]);

test('webui 接线：index.html 所有控件 id 均在 app.js 中被引用（缺失即失败并点名）', () => {
  const ids = collectControlIds(html);
  assert.ok(ids.length >= 30, `控件 id 数量异常（${ids.length}，疑似抽取规则过期）`);
  const missing: string[] = [];
  for (const id of ids) {
    if (EXEMPT_IDS.has(id)) continue;
    const referenced =
      app.includes(`byId('${id}')`) ||
      app.includes(`querySelector('#${id}')`) ||
      app.includes(`inputValue('${id}')`) ||
      app.includes(`checkedValue('${id}')`);
    if (!referenced) missing.push(id);
  }
  assert.deepEqual(missing, [], `以下控件 id 未在 web/app.js 接线：${missing.join(', ')}`);
});

test('webui 接线：一次性检测表单字段进入 collectForm() 提交体', () => {
  const start = app.indexOf('function collectForm()');
  assert.ok(start !== -1, '缺少 collectForm()');
  const end = app.indexOf('function updateCommandPreview()', start);
  assert.ok(end > start, 'collectForm() 结构异常（未找到后续函数边界）');
  const region = app.slice(start, end);
  for (const field of [
    'f-base-url', 'f-model', 'f-claimed-context', 'f-price-input', 'f-price-output',
    'f-price-cached-read', 'f-price-threshold', 'f-price-input2', 'f-price-output2', 'f-price-cached-read2',
    'f-seed', 'f-timeout', 'f-out', 'f-baseline', 'f-deep', 'f-dry-run', 'f-expect-',
  ]) {
    assert.ok(region.includes(field), `collectForm() 缺少字段 ${field}`);
  }
});

test('webui 接线：渠道表单字段进入提交体（协议透传 + 模型行与价格汇总 + allowPrivateUpstream 布尔透传）', () => {
  const start = app.indexOf("channelForm?.addEventListener('submit'");
  assert.ok(start !== -1, '缺少渠道表单 submit 监听');
  const end = app.indexOf('\n  });', start);
  assert.ok(end > start, '渠道表单 submit 监听结构异常（未找到监听器结束边界）');
  const region = app.slice(start, end);
  for (const field of [
    'f-channel-id', 'f-channel-label', 'f-channel-base-url', 'f-channel-key',
    'f-channel-protocol', 'collectModelRows()', 'collectModelPrices()',
  ]) {
    assert.ok(region.includes(field), `渠道提交体缺少字段 ${field}`);
  }
  assert.ok(region.includes('modelPrices: priced.modelPrices'), '渠道提交体必须携带 modelPrices（空对象=清空价格）');
  assert.ok(region.includes('allowPrivateUpstream'), '渠道提交体必须携带 allowPrivateUpstream');
  assert.ok(region.includes("checkedValue('f-channel-private')"), '复选框须以真布尔（checkedValue）上报');
});

test('webui 接线：一键获取模型走服务端探测端点，模型行由 buildModelRow 渲染（key 留在服务端）', () => {
  const start = app.indexOf("byId('btn-channel-probe')?.addEventListener('click'");
  assert.ok(start !== -1, '缺少「一键获取模型」监听');
  const end = app.indexOf('\n  });', start);
  assert.ok(end > start, '探测监听结构异常');
  const region = app.slice(start, end);
  for (const fragment of [
    "api('/api/gateway/probe-models'",
    'channelId',
    'buildModelRow(',
    'setProbeStatus(',
  ]) {
    assert.ok(region.includes(fragment), `探测监听缺少 ${fragment}`);
  }
  assert.ok(app.includes("byId('btn-model-add')?.addEventListener('click'"), '缺少「手动添加一行」接线');
});

test('webui 接线：接入信息复制按钮（/v1、Anthropic 根地址、虚拟 Key）均已绑定', () => {
  for (const id of ['btn-gateway-copy-url', 'btn-gateway-copy-root', 'btn-gateway-copy-key']) {
    assert.ok(app.includes(`byId('${id}')`), `复制按钮 ${id} 未接线`);
  }
});

test('webui 接线：模型价格编辑（别名跟随、纯函数校验、一键导入不得回潮）', () => {
  for (const fragment of [
    "byId('channel-price-details')",
    "byId('channel-price-rows')",
    'function syncPriceRows(',
    'buildPriceRow(',
    'data-price-field',
    'function collectModelPrices()',
    'buildModelPrices(entries)',
  ]) {
    assert.ok(app.includes(fragment), `价格编辑接线缺少 ${fragment}`);
  }
  for (const fragment of ['parseChannelsImport', 'importForm', 'importText', 'channel-import-form', 'button id="btn-channel-import"']) {
    assert.ok(!app.includes(fragment), `一键导入已移除，app.js 不得再含 ${fragment}`);
  }
});

test('webui 接线：app.js 不再调用已移除的 guard 托管端点', () => {
  assert.ok(!app.includes('/api/guard/'), 'app.js 不得再包含 /api/guard/ 调用（guard 仅保留 CLI）');
});

test('webui 接线：编辑回填（价格先清残留行再 seed 重建、allowPrivateUpstream 复选框按渠道状态恢复）', () => {
  const start = app.indexOf('function setChannelForm(');
  assert.ok(start !== -1, '缺少 setChannelForm()');
  const end = app.indexOf('function channelModelTags(', start);
  assert.ok(end > start, 'setChannelForm() 结构异常（未找到后续函数边界）');
  const region = app.slice(start, end);
  const clearIdx = region.indexOf("if (priceRows !== null) priceRows.textContent = '';");
  const syncIdx = region.indexOf('syncPriceRows(storedPrices, true);');
  assert.ok(clearIdx !== -1, '编辑回填价格前必须先清空残留价格行（reset() 只清值不清行）');
  assert.ok(syncIdx !== -1 && clearIdx < syncIdx, '清空必须在 syncPriceRows(storedPrices, true) 之前，否则空草稿快照掩盖 seed：回填空白且保存静默清价');
  assert.ok(region.includes('privateCheck.checked = editing && channel.allowPrivateUpstream === true'), '编辑表单必须按渠道状态恢复「允许本机/内网上游」勾选（否则保存会把安全开关静默翻转为 false）');
});

test('webui 接线：favicon 为无脚本/无外链的静态 SVG，head 中声明 icon 链接', () => {
  const faviconPath = join(repoRoot, 'web', 'favicon.svg');
  assert.ok(existsSync(faviconPath), '缺少 web/favicon.svg（控制台 404 回归）');
  const svg = readFileSync(faviconPath, 'utf8');
  assert.ok(!/<\s*script/i.test(svg), 'favicon 不得含 script');
  assert.ok(!/foreignObject/i.test(svg), 'favicon 不得含 foreignObject');
  assert.ok(!/\son\w+\s*=/i.test(svg), 'favicon 不得含事件属性');
  const stripped = svg.replace(/xmlns="[^"]+"/g, '');
  assert.ok(!/https?:\/\//i.test(stripped), 'favicon 不得引用外部资源');
  assert.match(html, /<link rel="icon" href="\/favicon\.svg">/, 'index.html head 必须声明 favicon 链接');
});
