// scripts/serve.mjs 的源码级回归钉子（I1/I2/I3/I5）：
// serve.mjs 不参与 tsc 编译，运行时行为由 tmp/mx-webui-dom.mjs 的真实浏览器用例覆盖；
// 这里用源码断言把「入口校验存在且在路由之前 / DTO 字段 / 报告类型 / CSP 收紧」钉死，防静默回退。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'scripts', 'serve.mjs'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('未找到 scripts/serve.mjs：请在仓库根目录构建并运行测试。');
}

const source = readFileSync(join(findRepoRoot(), 'scripts', 'serve.mjs'), 'utf8');

test('serve.mjs：Host/Origin 校验位于请求入口且先于静态与 /api 路由（防 DNS rebinding 回归）', () => {
  const hostCheck = source.indexOf('if (!hostAllowed(req.headers.host))');
  const originCheck = source.indexOf('if (!originAllowed(req.headers.origin))');
  const staticRoute = source.indexOf('await serveStatic(req, res, pathname)');
  const apiRoute = source.indexOf("pathname === '/api/status'");
  assert.ok(hostCheck !== -1, '缺少 Host 校验调用');
  assert.ok(originCheck !== -1, '缺少 Origin 校验调用');
  assert.ok(staticRoute !== -1, '缺少静态路由（抽取规则疑似过期）');
  assert.ok(apiRoute !== -1, '缺少 API 路由分发（抽取规则疑似过期）');
  assert.ok(hostCheck < staticRoute, 'Host 校验必须先于静态文件路由');
  assert.ok(originCheck < staticRoute, 'Origin 校验必须先于静态文件路由');
  assert.ok(hostCheck < apiRoute && originCheck < apiRoute, 'Host/Origin 校验必须先于 API 路由分发');
  assert.ok(
    source.includes("const CONSOLE_HOST_ALLOWLIST = new Set(['127.0.0.1', 'localhost', '[::1]']);"),
    '主机名白名单必须为回环三态 127.0.0.1 / localhost / [::1]',
  );
  assert.ok(source.includes("raw === 'null' || raw.includes(',')"), 'Origin 必须拒绝 null 与多值来源');
});

test('serve.mjs：控制台仅绑定回环地址（srv.listen 不得被放宽）', () => {
  assert.ok(source.includes("srv.listen(portArg, '127.0.0.1'"), '控制台必须仅绑定 127.0.0.1');
});

test('serve.mjs：job DTO 携带严格布尔 dryRun（/api/jobs/:id 与 /log 两处，预演反馈依赖）', () => {
  const matches = source.match(/dryRun: job\.dryRun === true/g) ?? [];
  assert.ok(matches.length >= 2, `job 序列化处的 dryRun 字段应至少 2 处（实际 ${matches.length}）`);
  assert.ok(source.includes('dryRun: body.dryRun === true'), 'startTestJob 必须记录 dryRun');
});

test('serve.mjs：报告列表项携带 kind（report/baseline/other 分流，防基线被当报告渲染）', () => {
  assert.ok(source.includes('kind: reportKind(entry.name)'), 'listReports 必须输出 kind');
  assert.ok(source.includes("fileName.startsWith('report-')"), '缺少 report- 前缀判定');
  assert.ok(source.includes("fileName.startsWith('baseline-')"), '缺少 baseline- 前缀判定');
});

test('serve.mjs：控制台 CSP 收紧为 img-src self，且静态服务声明 svg content-type', () => {
  assert.ok(source.includes("img-src 'self';"), "CSP 必须为 img-src 'self'");
  assert.ok(!source.includes("img-src 'self' data:"), 'CSP 不得保留 data: 图片源（favicon 走静态文件）');
  assert.ok(source.includes("'.svg': 'image/svg+xml'"), '静态服务必须声明 svg content-type');
});

test('serve.mjs：/api/reports/clear 在 POST token 闸门之后（破坏性端点不得免鉴权）', () => {
  const gate = source.lastIndexOf("if (!requireToken(req, res)) return;");
  const route = source.indexOf("pathname === '/api/reports/clear'");
  assert.ok(gate !== -1, '缺少 POST requireToken 闸门');
  assert.ok(route !== -1, '缺少清理路由');
  assert.ok(route > gate, '清理路由必须位于 requireToken 之后');
});

test('serve.mjs：清理范围用硬编码枚举校验（400 文案带收到值与示例），规划器不吃请求端任意文件名', () => {
  const start = source.indexOf("pathname === '/api/reports/clear'");
  const end = source.indexOf("pathname === '/api/test'", start);
  assert.ok(end > start, '清理路由结构异常（未找到后继路由边界）');
  const region = source.slice(start, end);
  for (const fragment of [
    "scope !== 'keep-latest' && scope !== 'reports-root' && scope !== 'all'",
    '收到值',
    '示例',
    "rm(join(reportsRoot, item.name)",
    'planReportsClear',
  ]) {
    assert.ok(region.includes(fragment), `清理路由缺少关键约束：${fragment}`);
  }
  assert.ok(!region.includes('body.name'), '清理路由不得接受来自请求体的文件名（防注入删除面）');
});

test('serve.mjs：清理与检测/网关互锁（证据文件写入中不得删除）', () => {
  const start = source.indexOf("pathname === '/api/reports/clear'");
  const end = source.indexOf("pathname === '/api/test'", start);
  const region = source.slice(start, end);
  assert.ok(region.includes("state.job !== null && state.job.status === 'running'"), '缺少检测任务运行互锁');
  assert.ok(region.includes('state.gateway.instance !== null'), '缺少网关实例互锁');
  assert.ok(region.includes('sendError(res, 409,'), '互锁必须返回 409');
});

test('serve.mjs：控制台不再托管 guard（状态/函数/路由零残留；监控仅保留 CLI guard）', () => {
  for (const fragment of ['/api/guard/', 'state.guard', 'startGuard', 'stopGuard']) {
    assert.ok(!source.includes(fragment), `serve.mjs 不得残留 guard 托管实现：${fragment}`);
  }
});

test('serve.mjs：清理规划器懒加载自 dist 且失败不缓存（dist 缺失 → 503 诚实降级）', () => {
  const start = source.indexOf("pathname === '/api/reports/clear'");
  const end = source.indexOf("pathname === '/api/test'", start);
  const region = source.slice(start, end);
  assert.ok(region.includes("import('../dist/src/report/clear-plan.js')"), '规划器应从 dist 懒加载');
  assert.ok(region.includes('sendError(res, 503,'), 'dist 缺失必须显式 503，不得静默');
  assert.ok(!region.includes('clearPlanModule = '), '不得缓存模块加载失败（回归：模块加载失败缓存 null 属已修缺陷）');
});

test('serve.mjs：非 POST 方法语义——未知路径 404，仅已登记 POST 端点回 405（「仅支持 POST」不得对未知路径说谎）', () => {
  assert.ok(
    source.includes("const POST_ONLY_ENDPOINTS = new Set(['/api/key', '/api/key/clear', '/api/reports/clear', '/api/test']);"),
    '缺少 POST_ONLY_ENDPOINTS 端点名单',
  );
  const start = source.indexOf('// 其余均为 POST：需要 token');
  assert.ok(start !== -1, '缺少 POST 兜底注释锚（抽取规则疑似过期）');
  const region = source.slice(start, start + 560);
  assert.ok(region.includes('POST_ONLY_ENDPOINTS.has(pathname)'), '未知路径必须先判 404 再判 405');
  assert.ok(region.includes("sendError(res, 404, '未知的 API 端点。')"), '未登记路径的非 POST 方法必须 404');
  assert.ok(region.includes("sendError(res, 405, '该端点仅支持 POST。', { allow: 'POST' })"), '已登记端点的非 POST 方法仍回 405，且必须带 Allow: POST');
});

test('serve.mjs：WebUI 任务启用逐请求进度，且 /log 下发 startedAt（运行中状态条依赖）', () => {
  const logStart = source.indexOf('const jobLogMatch = pathname.match');
  const logEnd = source.indexOf('const jobMatch = pathname.match', logStart);
  assert.ok(logStart !== -1 && logEnd > logStart, '日志路由结构异常（未找到 /api/jobs/:id/log 边界）');
  const logRegion = source.slice(logStart, logEnd);
  assert.ok(logRegion.includes('startedAt: job.startedAt'), '/api/jobs/:id/log 必须返回 startedAt');
  assert.ok(source.includes("MODEL_XRAY_PROGRESS: '1'"), '控制台任务必须注入 MODEL_XRAY_PROGRESS=1');
});
