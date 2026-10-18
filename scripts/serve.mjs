#!/usr/bin/env node
// scripts/serve.mjs — model-xray 本地控制台服务器（仅绑定 127.0.0.1 回环）。
// 职责：
//   ① 托管 web/ 控制台页面（index.html 注入一次性 token，页面凭 token 调用本服务 API）；
//   ② 一次性检测：POST /api/test 真实 spawn CLI 子进程，逐行流式回传日志（/api/jobs/:id/log）；
//   ③ key 页面录入：仅存于本进程内存（keySource=page），绝不回显、绝不写日志；
//   ④ 历史报告：列取/读取 reports/ 下的报告文件（白名单扩展名 + 防穿越）；
//   ⑤ 别名网关管理面：/api/gateway/*（渠道 CRUD/状态/虚拟 key/用量/告警/模型列表探测；渠道配置存本进程内存、
//      跨网关启停保留（网关启动前即可配置）；数据面由 dist/src/gateway 独立回环端口提供）；
//      S1 账本（dist/src/ledger，reports/gateway-ledger.db）随网关启动做恢复、随停止关闭（正文零持久化）。
// 安全约定：
//   - 只监听 127.0.0.1；token 每次启动随机生成；/api/gateway/* 与全部 POST 端点必须携带 x-model-xray-token；
//   - key 只经环境变量 MODEL_XRAY_KEY 注入子进程，不出现在命令行参数 / 日志 / 响应里；
//   - 网关上游 apiKey 只存本进程内存（渠道视图 hasKey:true，绝不回显/落盘/日志）；
//   - 静态文件仅限 web/ 目录；路径穿越、点文件、畸形编码一律拒绝；

import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, isAbsolute, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_PORT = 8620;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPORT_EXT_WHITELIST = new Set(['.json', '.md', '.html', '.txt', '.log', '.jsonl']);
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.jsonl': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const CONSOLE_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// 仅支持 POST 的已登记端点：非 POST 方法在这些路径回 405；其余未知路径的非 POST 方法必须回 404。
const POST_ONLY_ENDPOINTS = new Set(['/api/key', '/api/key/clear', '/api/reports/clear', '/api/test']);

function isPositiveIntStr(raw) {
  return /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) && Number(raw) >= 1;
}
function isPositiveNumberStr(raw) {
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(raw)) return false;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0;
}
function isNonNegativeNumberStr(raw) {
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(raw)) return false;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0;
}
function bad(message) {
  return { ok: false, error: message };
}
function validateBaseUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return bad('baseUrl 非法：收到值 (空)。示例：https://relay.example.com/v1（通常以 /v1 结尾）');
  }
  const value = raw.trim();
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return bad(`baseUrl 非法：收到值 ${JSON.stringify(value)}。示例：https://relay.example.com/v1（通常以 /v1 结尾）`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return bad(`baseUrl 协议必须为 http/https：收到值 ${JSON.stringify(value)}。示例：https://relay.example.com/v1`);
  }
  return { ok: true, value };
}

// —— Host/Origin 校验（防 DNS rebinding；静态页与 /api/* 全覆盖，先于一切路由） ——
// 只比对主机名、不比对端口：DNS rebinding 的威胁在主机名；端口缺省时浏览器会省略，比端口会误拒。
const CONSOLE_HOST_ALLOWLIST = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Host 头必须为主机名白名单成员；缺失/多值/畸形一律拒绝（HTTP/1.1 请求必须携带 Host）。 */
function hostAllowed(raw) {
  if (typeof raw !== 'string' || raw === '' || raw.includes(',')) return false;
  const lower = raw.trim().toLowerCase();
  if (lower === '') return false;
  const host = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':')[0];
  return CONSOLE_HOST_ALLOWLIST.has(host);
}

/** Origin：缺失（CLI/headless 客户端无 Origin）放行；'null'（file:// 等不透明来源）/多值/非 http 一律拒绝。 */
function originAllowed(raw) {
  if (raw === undefined || raw === '') return true;
  if (typeof raw !== 'string' || raw === 'null' || raw.includes(',')) return false;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.protocol === 'http:' && CONSOLE_HOST_ALLOWLIST.has(url.hostname);
}

/** 逐行收集子进程输出；任何 key 痕迹（会话 key 或 sk- 前缀）都替换为 ***，绝不落日志。 */
function createLineCollector(push, secrets) {
  const scrub = (text) => {
    let out = text;
    for (const secret of secrets) {
      if (secret !== '' && out.includes(secret)) out = out.split(secret).join('***');
    }
    return out.replace(/sk-[A-Za-z0-9_\-]{8,}/g, 'sk-***');
  };
  return (stream) => {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) push(scrub(line));
    });
    stream.on('end', () => {
      if (buffer !== '') push(scrub(buffer));
      buffer = '';
    });
  };
}

function parseReportPaths(lines, dryRun) {
  if (dryRun) return null;
  const paths = { markdownPath: null, htmlPath: null, jsonPath: null, baselinePath: null };
  for (const line of lines) {
    const match = line.match(/^\s*([^\s]+\.(?:json|md|html))\s*$/);
    if (match === null) continue;
    const file = match[1].replaceAll('\\', '/');
    if (paths.baselinePath === null && /baseline-[^/]+\.json$/.test(file)) {
      paths.baselinePath = file;
    } else if (paths.markdownPath === null && file.endsWith('.md')) {
      paths.markdownPath = file;
    } else if (paths.htmlPath === null && file.endsWith('.html')) {
      paths.htmlPath = file;
    } else if (paths.jsonPath === null && file.endsWith('.json')) {
      paths.jsonPath = file;
    }
  }
  const any = paths.markdownPath ?? paths.htmlPath ?? paths.jsonPath ?? paths.baselinePath;
  return any === null ? null : paths;
}

export async function createConsoleServer(options = {}) {
  const portArg = Number(options.port ?? 0);
  const repoRoot = resolve(String(options.repoRoot ?? process.cwd()));
  const webRoot = join(repoRoot, 'web');
  const reportsRoot = join(repoRoot, 'reports');
  const cliPath = join(repoRoot, 'dist', 'src', 'cli.js');
  const token = randomBytes(24).toString('hex');

  const state = {
    sessionKey: null,
    job: null,
    // 别名网关管理面状态：实例懒加载自 dist/（未构建时相关端点回 503，控制台其余功能不受影响）
    gateway: { instance: null, modulePromise: null, starting: false, ledger: null, ledgerPromise: null, store: null, channelsPromise: null, ssrfPromise: null },
  };
  const envKey = () => process.env.MODEL_XRAY_KEY || process.env.OPENAI_API_KEY || null;
  const effectiveKey = () => state.sessionKey ?? envKey();
  const keyInfo = () => {
    const source = state.sessionKey !== null ? 'page' : envKey() !== null ? 'env' : null;
    return { keyConfigured: source !== null, keySource: source };
  };

  function send(res, status, payload, extraHeaders = {}) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    });
    res.end(body);
  }
  function sendError(res, status, message, extraHeaders = {}) {
    send(res, status, { error: message }, extraHeaders);
  }
  function readBody(req) {
    return new Promise((resolveBody, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          reject(new Error('请求体超过 1MB 上限'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (raw === '') {
          resolveBody({});
          return;
        }
        try {
          resolveBody(JSON.parse(raw));
        } catch {
          reject(new Error('请求体不是合法 JSON'));
        }
      });
      req.on('error', reject);
    });
  }
  function requireToken(req, res) {
    const header = String(req.headers['x-model-xray-token'] ?? '');
    if (header !== token) {
      sendError(res, 403, '缺少或错误的 x-model-xray-token：请从控制台页面发起请求（token 由页面携带）。');
      return false;
    }
    return true;
  }

  // —— 静态文件：仅 web/ 目录、仅 GET/HEAD ——
  function resolveStaticPath(pathname) {
    if (pathname === '/') return { file: join(webRoot, 'index.html'), isIndex: true };
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return { error: 400 };
    }
    const segments = decoded.slice(1).split('/');
    for (const segment of segments) {
      if (segment === '' || segment === '.' || segment === '..' || segment.startsWith('.')) {
        return { error: 404 };
      }
    }
    const file = resolve(webRoot, ...segments);
    const rel = relative(webRoot, file);
    if (rel === '' || rel.startsWith('..') || rel.split(sep).includes('..')) return { error: 404 };
    return { file };
  }
  async function serveStatic(req, res, pathname) {
    const resolved = resolveStaticPath(pathname);
    if (resolved.error !== undefined) {
      sendError(res, resolved.error, resolved.error === 400 ? '路径编码畸形。' : '未找到该文件。');
      return;
    }
    let content;
    try {
      const info = await stat(resolved.file);
      if (!info.isFile()) throw new Error('not a file');
      content = await readFile(resolved.file);
    } catch {
      sendError(res, 404, '未找到该文件。');
      return;
    }
    if (resolved.isIndex) {
      // 控制台页面：注入 token（全量替换，任何位置都不留占位符）并下发 CSP
      content = Buffer.from(content.toString('utf8').replaceAll('__MX_TOKEN__', token), 'utf8');
    }
    const dotAt = resolved.file.lastIndexOf('.');
    const ext = dotAt === -1 ? '' : resolved.file.slice(dotAt).toLowerCase();
    const headers = {
      'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
      'content-length': String(content.length),
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    };
    if (resolved.isIndex) headers['content-security-policy'] = CONSOLE_CSP;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : content);
  }

  // —— 报告文件：两类合法请求 ——
  //   ① reports/ 相对路径（历史列表/页面渲染用）；
  //   ② 绝对路径（CLI 在 stderr 打印 resolve(outDir) 后的绝对路径，任务完成后的 reportPaths 就是它）。
  // 安全防线：解析结果必须仍在 repoRoot 内，且（位于 reports/ 下 或 文件名形如 report-/baseline-），
  // 防止借绝对路径读取仓库任意文件（package.json/plan.md 等一律 404）。
  function resolveReportRequest(name) {
    if (typeof name !== 'string' || name === '') return { error: '未指定报告文件。' };
    const normalized = name.replaceAll('\\', '/');
    let file;
    if (/^(?:[A-Za-z]:)?\//.test(normalized)) {
      file = resolve(normalized);
    } else {
      const segments = normalized.split('/');
      for (const segment of segments) {
        if (segment === '' || segment === '.' || segment === '..' || segment.startsWith('.')) {
          return { error: '非法的报告文件路径。' };
        }
      }
      file = resolve(reportsRoot, ...segments);
    }
    const relRepo = relative(repoRoot, file);
    if (relRepo === '' || relRepo.startsWith('..') || isAbsolute(relRepo)) {
      return { error: '报告文件路径越出仓库范围。' };
    }
    const relReports = relative(reportsRoot, file);
    const insideReports = relReports !== '' && !relReports.startsWith('..') && !isAbsolute(relReports);
    if (!insideReports && !/^(report|baseline)-.+\./i.test(basename(file))) {
      return { error: '仅提供报告文件（reports/ 下或 report-/baseline- 命名）。' };
    }
    return { file };
  }
  async function serveReportFile(res, name) {
    const resolved = resolveReportRequest(name);
    if (resolved.error !== undefined) {
      sendError(res, 404, resolved.error);
      return;
    }
    const file = resolved.file;
    const dotAt = file.lastIndexOf('.');
    const ext = dotAt === -1 ? '' : file.slice(dotAt).toLowerCase();
    if (!REPORT_EXT_WHITELIST.has(ext)) {
      sendError(res, 404, `不支持的报告文件类型：${ext}（白名单：${[...REPORT_EXT_WHITELIST].join(' ')}）。`);
      return;
    }
    let content;
    try {
      content = await readFile(file);
    } catch {
      sendError(res, 404, '未找到该报告文件。');
      return;
    }
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[ext] ?? 'text/plain; charset=utf-8',
      'content-length': String(content.length),
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
    res.end(content);
  }
  /** 报告列表项类型：report-* 为检测报告（可渲染评分卡）；baseline-* 为对照基线；其余为未识别文件。 */
  function reportKind(fileName) {
    if (fileName.startsWith('report-')) return 'report';
    if (fileName.startsWith('baseline-')) return 'baseline';
    return 'other';
  }
  async function listReports(res) {
    if (!existsSync(reportsRoot)) {
      send(res, 200, { reports: [] });
      return;
    }
    const found = [];
    const walk = async (dir, depth) => {
      if (depth > 3) return;
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
          continue;
        }
        const dotAt = entry.name.lastIndexOf('.');
        const ext = dotAt === -1 ? '' : entry.name.slice(dotAt).toLowerCase();
        if (!REPORT_EXT_WHITELIST.has(ext)) continue;
        const info = await stat(full);
        found.push({
          name: relative(reportsRoot, full).replaceAll('\\', '/'),
          size: info.size,
          mtimeMs: Math.round(info.mtimeMs),
          kind: reportKind(entry.name),
        });
      }
    };
    try {
      await walk(reportsRoot, 0);
    } catch {
      sendError(res, 500, '扫描 reports/ 目录失败。');
      return;
    }
    found.sort((a, b) => b.mtimeMs - a.mtimeMs);
    send(res, 200, { reports: found.slice(0, 300) });
  }

  // —— 一次性检测任务 ——
  function buildTestArgs(body) {
    const args = ['test', '--base-url', body.baseUrl, '--model', body.model];
    const claimed = typeof body.claimedContext === 'string' ? body.claimedContext.trim() : '';
    if (claimed !== '') {
      if (!isPositiveIntStr(claimed)) {
        throw new Error(`claimed-context 必须是正整数。收到：${JSON.stringify(claimed)}。示例：32000`);
      }
      args.push('--claimed-context', claimed);
    }
    const expectAllowed = ['vision', 'tool', 'thinking'];
    const expect = Array.isArray(body.expect) ? body.expect.filter((v) => expectAllowed.includes(v)) : [];
    args.push('--expect', expect.length > 0 ? expect.join(',') : 'none');
    const priceIn = typeof body.priceInput === 'string' ? body.priceInput.trim() : '';
    const priceOut = typeof body.priceOutput === 'string' ? body.priceOutput.trim() : '';
    const priceCachedRead = typeof body.priceCachedRead === 'string' ? body.priceCachedRead.trim() : '';
    const priceThreshold = typeof body.priceThreshold === 'string' ? body.priceThreshold.trim() : '';
    const priceIn2 = typeof body.priceInput2 === 'string' ? body.priceInput2.trim() : '';
    const priceOut2 = typeof body.priceOutput2 === 'string' ? body.priceOutput2.trim() : '';
    const priceCachedRead2 = typeof body.priceCachedRead2 === 'string' ? body.priceCachedRead2.trim() : '';
    const optionalPricePresent =
      priceCachedRead !== '' || priceThreshold !== '' || priceIn2 !== '' || priceOut2 !== '' || priceCachedRead2 !== '';
    if (priceIn === '' && priceOut === '') {
      if (optionalPricePresent) {
        throw new Error('price-input 与 price-output 必须成对填写（缓存读与阶梯价为可选补充）。示例：priceInput=2.5, priceOutput=10');
      }
    } else {
      if (priceIn === '' || priceOut === '') {
        throw new Error('price-input 与 price-output 必须成对填写。示例：priceInput=2.5, priceOutput=10（单位：每百万 tokens）');
      }
      if (!isPositiveNumberStr(priceIn)) {
        throw new Error(`price-input 必须为正数。收到：${JSON.stringify(priceIn)}。示例：2.5`);
      }
      if (!isPositiveNumberStr(priceOut)) {
        throw new Error(`price-output 必须为正数。收到：${JSON.stringify(priceOut)}。示例：10`);
      }
      if (priceCachedRead !== '' && !isNonNegativeNumberStr(priceCachedRead)) {
        throw new Error(`price-cached-read 必须为不小于 0 的数字。收到：${JSON.stringify(priceCachedRead)}。示例：0.5（缓存免费填 0）`);
      }
      const tierPresent = priceThreshold !== '' || priceIn2 !== '' || priceOut2 !== '';
      const tierComplete = priceThreshold !== '' && priceIn2 !== '' && priceOut2 !== '';
      if (tierPresent && !tierComplete) {
        throw new Error('price-threshold、price-input2、price-output2 必须成组填写。示例：1000000 / 6 / 22.5');
      }
      if (!tierComplete && priceCachedRead2 !== '') {
        throw new Error('price-cached-read2 仅在填写阶梯价时可用。示例：threshold=1000000, input2=6, output2=22.5, cachedRead2=0.75');
      }
      if (tierComplete) {
        if (!isPositiveIntStr(priceThreshold)) {
          throw new Error(`price-threshold 必须是正整数 tokens。收到：${JSON.stringify(priceThreshold)}。示例：1000000`);
        }
        if (!isPositiveNumberStr(priceIn2)) {
          throw new Error(`price-input2 必须为正数。收到：${JSON.stringify(priceIn2)}。示例：6`);
        }
        if (!isPositiveNumberStr(priceOut2)) {
          throw new Error(`price-output2 必须为正数。收到：${JSON.stringify(priceOut2)}。示例：22.5`);
        }
        if (priceCachedRead2 !== '' && !isNonNegativeNumberStr(priceCachedRead2)) {
          throw new Error(`price-cached-read2 必须为不小于 0 的数字。收到：${JSON.stringify(priceCachedRead2)}。示例：0.75`);
        }
      }
      args.push('--price-input', priceIn, '--price-output', priceOut);
      if (priceCachedRead !== '') args.push('--price-cached-read', priceCachedRead);
      if (tierComplete) {
        args.push('--price-threshold', priceThreshold, '--price-input2', priceIn2, '--price-output2', priceOut2);
        if (priceCachedRead2 !== '') args.push('--price-cached-read2', priceCachedRead2);
      }
    }
    const seed = typeof body.seed === 'string' ? body.seed.trim() : '';
    if (seed !== '') {
      if (!isPositiveIntStr(seed)) throw new Error(`seed 必须是正整数。收到：${JSON.stringify(seed)}。示例：12345`);
      args.push('--seed', seed);
    }
    const timeout = typeof body.timeout === 'string' ? body.timeout.trim() : '';
    if (timeout !== '') {
      if (!isPositiveIntStr(timeout)) {
        throw new Error(`timeout 必须是正整数（秒）。收到：${JSON.stringify(timeout)}。示例：60`);
      }
      args.push('--timeout', timeout);
    }
    const out = typeof body.out === 'string' ? body.out.trim() : '';
    if (out !== '') {
      // UI 承诺「结果页内渲染」：out 越出仓库范围会导致报告无法经 /api/reports/file 读回，提前拒绝
      const resolvedOut = resolve(repoRoot, out);
      const relOut = relative(repoRoot, resolvedOut);
      if (relOut === '' || relOut.startsWith('..') || isAbsolute(relOut)) {
        throw new Error(
          `out 必须位于仓库目录内（页面渲染需要读取报告文件）。收到：${JSON.stringify(out)}。示例：reports`,
        );
      }
      args.push('--out', out);
    }
    const baseline = typeof body.baseline === 'string' ? body.baseline.trim() : '';
    if (baseline !== '') args.push('--baseline', baseline);
    if (body.deep === true) args.push('--deep');
    if (body.dryRun === true) args.push('--dry-run');
    else args.push('--yes');
    return args;
  }
  function startTestJob(body, args) {
    const job = {
      id: randomUUID(),
      status: 'running',
      exitCode: null,
      reportPaths: null,
      dryRun: body.dryRun === true,
      startedAt: Date.now(),
      lines: [],
      nextSeq: 0,
      child: null,
    };
    state.job = job;
    const secrets = [effectiveKey() ?? '', String(body.key ?? '')].filter((s) => s !== '');
    const collect = createLineCollector(
      (text) => {
        job.lines.push({ seq: job.nextSeq, text });
        job.nextSeq += 1;
        if (job.lines.length > 20000) job.lines.splice(0, job.lines.length - 20000);
      },
      secrets,
    );
    try {
      const child = spawn(process.execPath, [cliPath, ...args], {
        cwd: repoRoot,
        env: {
          ...process.env,
          ...(effectiveKey() !== null ? { MODEL_XRAY_KEY: effectiveKey() } : {}),
          // 控制台任务始终输出阶段/每请求进度（CLI 直接运行时默认不输出，保持简洁）
          MODEL_XRAY_PROGRESS: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      job.child = child;
      collect(child.stdout);
      collect(child.stderr);
      child.on('error', (error) => {
        job.status = 'error';
        job.lines.push({ seq: job.nextSeq, text: `子进程启动失败：${error.message}` });
        job.nextSeq += 1;
      });
      child.on('exit', (code) => {
        job.exitCode = code;
        job.status = code === null ? 'error' : 'done';
        job.reportPaths = parseReportPaths(job.lines.map((l) => l.text), body.dryRun === true);
        job.child = null;
      });
    } catch (error) {
      job.status = 'error';
      job.lines.push({
        seq: job.nextSeq,
        text: `任务启动失败：${error instanceof Error ? error.message : String(error)}`,
      });
      job.nextSeq += 1;
    }
    return job;
  }

  // —— 别名网关管理面（懒加载 dist 网关模块；未构建时端点回 503 引导构建） ——
  // 加载失败不缓存 null：构建完成后下次点击启动即可重试成功（无需重启控制台）。
  function loadGatewayModule() {
    const gateway = state.gateway;
    if (gateway.modulePromise === null) {
      gateway.modulePromise = import(pathToFileURL(join(repoRoot, 'dist', 'src', 'gateway', 'server.js')).href).catch(() => {
        gateway.modulePromise = null;
        return null;
      });
    }
    return gateway.modulePromise;
  }
  function loadLedgerModule() {
    const gateway = state.gateway;
    if (gateway.ledgerPromise === null) {
      gateway.ledgerPromise = import(pathToFileURL(join(repoRoot, 'dist', 'src', 'ledger', 'ledger.js')).href).catch(() => {
        gateway.ledgerPromise = null;
        return null;
      });
    }
    return gateway.ledgerPromise;
  }
  // 渠道模块（dist/src/gateway/channels.js）：懒加载后由控制台持有一个持久 ChannelStore——
  // 渠道配置跨网关启停保留（启动前即可配置），网关启动时把同一 store 注入数据面。
  function loadChannelsModule() {
    const gateway = state.gateway;
    if (gateway.channelsPromise === null) {
      gateway.channelsPromise = import(pathToFileURL(join(repoRoot, 'dist', 'src', 'gateway', 'channels.js')).href).catch(() => {
        gateway.channelsPromise = null;
        return null;
      });
    }
    return gateway.channelsPromise;
  }
  async function ensureChannelStore() {
    const gateway = state.gateway;
    if (gateway.store !== null) return gateway.store;
    const module = await loadChannelsModule();
    if (module === null) return null;
    gateway.store = new module.ChannelStore();
    return gateway.store;
  }
  // SSRF 策略模块（dist/src/gateway/ssrf.js）：探测端点复用与数据面完全相同的校验/钉定口径。
  function loadSsrfModule() {
    const gateway = state.gateway;
    if (gateway.ssrfPromise === null) {
      gateway.ssrfPromise = import(pathToFileURL(join(repoRoot, 'dist', 'src', 'gateway', 'ssrf.js')).href).catch(() => {
        gateway.ssrfPromise = null;
        return null;
      });
    }
    return gateway.ssrfPromise;
  }
  const CHANNEL_MODULE_HINT =
    '渠道模块未构建：请先在仓库目录运行 npm run build（生成 dist/src/gateway）后重试（无需重启本控制台）。';
  /**
   * 服务端代取上游 /models（控制台进程直连，不受浏览器 CORS 限制）：
   * URL 校验与解析钉定由 ssrf.js 完成（与数据面同一安全口径），15 秒超时、响应上限 2 MB；
   * Key 只进请求头，绝不进日志/响应。
   */
  function fetchUpstreamModels({ url, ip, apiKey, protocol, lookup, timeoutMs = 15000 }) {
    return new Promise((resolve) => {
      const basePath = url.pathname.replace(/\/+$/, '');
      const isHttps = url.protocol === 'https:';
      // unified（统一中转）同时携带 Bearer 与 x-api-key + anthropic-version，最大化 `/models` 端点兼容性
      const headers =
        protocol === 'anthropic'
          ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', accept: 'application/json', 'accept-encoding': 'identity', 'user-agent': 'model-xray-console/1.0' }
          : protocol === 'unified'
            ? { authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', accept: 'application/json', 'accept-encoding': 'identity', 'user-agent': 'model-xray-console/1.0' }
            : { authorization: `Bearer ${apiKey}`, accept: 'application/json', 'accept-encoding': 'identity', 'user-agent': 'model-xray-console/1.0' };
      const clientReq = (isHttps ? httpsRequest : httpRequest)(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port === '' ? (isHttps ? 443 : 80) : Number(url.port),
          path: `${basePath}/models`,
          method: 'GET',
          headers,
          lookup,
          agent: false,
          timeout: timeoutMs,
        },
        (upstream) => {
          const chunks = [];
          let size = 0;
          let oversize = false;
          upstream.on('data', (chunk) => {
            size += chunk.length;
            if (size > 2 * 1024 * 1024) {
              oversize = true;
              upstream.destroy();
              return;
            }
            chunks.push(chunk);
          });
          upstream.on('end', () => {
            if (oversize) resolve({ status: upstream.statusCode ?? 0, error: '上游响应超过 2 MB 上限，已中止' });
            else resolve({ status: upstream.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
          });
          upstream.on('error', (error) => resolve({ status: 0, error: error.message }));
        },
      );
      clientReq.on('timeout', () => clientReq.destroy(new Error('上游请求超时（15 秒）')));
      clientReq.on('error', (error) => resolve({ status: 0, error: error.message }));
      clientReq.end();
    });
  }
  // ChannelError（来自 dist 模块）结构透传 status；其余错误按 400 处理
  function sendGatewayChannelError(res, error) {
    if (error !== null && typeof error === 'object' && typeof error.status === 'number' && typeof error.message === 'string') {
      sendError(res, error.status, error.message);
      return;
    }
    sendError(res, 400, error instanceof Error ? error.message : String(error));
  }
  function gatewayNotRunning(res, hint) {
    sendError(res, 400, `网关未运行：请先 POST /api/gateway/start 启动（${hint}）。示例：{"port":"8622"}（缺省 = 随机回环端口）`);
  }
  function decodeChannelId(raw) {
    try {
      return decodeURIComponent(raw);
    } catch {
      return null;
    }
  }

  const server = await new Promise((resolveServer, rejectServer) => {
    const srv = createServer(async (req, res) => {
      try {
        // ⓪ Host/Origin 校验最先执行（含静态与 /api/*；防 DNS rebinding/跨站访问）
        if (!hostAllowed(req.headers.host)) {
          sendError(
            res,
            403,
            `Host 校验未通过（防 DNS rebinding）：收到值 ${JSON.stringify(req.headers.host ?? null)}。` +
              `受信主机名仅 127.0.0.1 / localhost / [::1]。示例：http://127.0.0.1:<port>/`,
          );
          return;
        }
        if (!originAllowed(req.headers.origin)) {
          sendError(
            res,
            403,
            `Origin 校验未通过（防跨站/DNS rebinding）：收到值 ${JSON.stringify(req.headers.origin ?? null)}。` +
              `仅接受本机来源（http://127.0.0.1:<port> / http://localhost:<port> / http://[::1]:<port>）；无 Origin 的 CLI 客户端不受影响。示例：http://127.0.0.1:<port>/`,
          );
          return;
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const pathname = url.pathname;
        if (!pathname.startsWith('/api/')) {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendError(res, 405, '静态资源仅支持 GET/HEAD。', { allow: 'GET, HEAD' });
            return;
          }
          await serveStatic(req, res, pathname);
          return;
        }
        if (pathname === '/api/status' && req.method === 'GET') {
          send(res, 200, keyInfo());
          return;
        }
        if (pathname === '/api/reports' && req.method === 'GET') {
          await listReports(res);
          return;
        }
        if (pathname === '/api/reports/file' && req.method === 'GET') {
          await serveReportFile(res, url.searchParams.get('name'));
          return;
        }
        const jobLogMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/log$/);
        if (jobLogMatch !== null && req.method === 'GET') {
          const job = state.job;
          if (job === null || job.id !== jobLogMatch[1]) {
            sendError(res, 404, '未找到该任务。');
            return;
          }
          const after = Number(url.searchParams.get('after') ?? '0');
          const from = Number.isInteger(after) && after >= 0 ? after : 0;
          send(res, 200, {
            lines: job.lines.filter((line) => line.seq >= from),
            status: job.status,
            dryRun: job.dryRun === true,
            next: job.nextSeq,
            startedAt: job.startedAt,
          });
          return;
        }
        const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
        if (jobMatch !== null && req.method === 'GET') {
          const job = state.job;
          if (job === null || job.id !== jobMatch[1]) {
            sendError(res, 404, '未找到该任务。');
            return;
          }
          send(res, 200, {
            id: job.id,
            status: job.status,
            exitCode: job.exitCode,
            reportPaths: job.reportPaths,
            dryRun: job.dryRun === true,
            startedAt: job.startedAt,
          });
          return;
        }
        // —— 别名网关管理面：全部端点要求控制台 token（含 GET；渠道视图绝不含上游 key） ——
        if (pathname.startsWith('/api/gateway/')) {
          if (!requireToken(req, res)) return;
          const gateway = state.gateway;
          if (req.method === 'GET') {
            if (pathname === '/api/gateway/status') {
              if (gateway.instance === null) {
                send(res, 200, { running: false });
                return;
              }
              send(res, 200, { running: true, ...gateway.instance.status() });
              return;
            }
            if (pathname === '/api/gateway/channels') {
              // 渠道挂在控制台持久的 ChannelStore 上：网关未启动也能列出/配置（模块未构建时不可能有渠道，回空列表）
              const store = await ensureChannelStore();
              send(res, 200, {
                channels: store === null ? [] : store.list().map((channel) => store.view(channel)),
              });
              return;
            }
            if (pathname === '/api/gateway/virtual-key') {
              if (gateway.instance === null) {
                gatewayNotRunning(res, '虚拟 key 随网关启动生成');
                return;
              }
              send(res, 200, { virtualKey: gateway.instance.virtualKey });
              return;
            }
            // 用量与告警（S2/S3）：运行期实时口径（内存计数），账本（reports/gateway-ledger.db）为权威账
            if (pathname === '/api/gateway/usage') {
              if (gateway.instance === null) {
                send(res, 200, { usage: [] });
                return;
              }
              send(res, 200, { usage: gateway.instance.usageSummary() });
              return;
            }
            if (pathname === '/api/gateway/events') {
              if (gateway.instance === null) {
                send(res, 200, { events: [] });
                return;
              }
              send(res, 200, { events: gateway.instance.events() });
              return;
            }
            sendError(res, 404, '未知的 API 端点。');
            return;
          }
          if (req.method !== 'POST') {
            sendError(res, 405, '该端点仅支持 GET/POST。', { allow: 'GET, POST' });
            return;
          }
          let gbody;
          try {
            gbody = await readBody(req);
          } catch (error) {
            sendError(res, 400, error instanceof Error ? error.message : String(error));
            return;
          }
          if (pathname === '/api/gateway/start') {
            if (gateway.instance !== null) {
              sendError(res, 409, '网关已在运行；如需换端口请先 POST /api/gateway/stop 停止。');
              return;
            }
            if (gateway.starting) {
              sendError(res, 409, '网关正在启动中：请稍候（无需重复点击；长时间无响应可重试）。');
              return;
            }
            gateway.starting = true;
            try {
              let port = 0;
              if (gbody.port !== undefined && gbody.port !== null && String(gbody.port).trim() !== '') {
                const raw = String(gbody.port).trim();
                if (raw === '0') {
                  port = 0;
                } else if (!isPositiveIntStr(raw) || Number(raw) > 65535) {
                  sendError(res, 400, `port 必须是 [0, 65535] 整数（0 或缺省 = 随机回环端口）。收到：${JSON.stringify(raw)}。示例：8622`);
                  return;
                } else {
                  port = Number(raw);
                }
              }
              const gatewayModule = await loadGatewayModule();
              const ledgerModule = await loadLedgerModule();
              if (gatewayModule === null || ledgerModule === null) {
                sendError(res, 503, '网关模块未构建：请先在仓库目录运行 npm run build（生成 dist/src/gateway 与 dist/src/ledger）后再次点击启动即可（无需重启本控制台）。');
                return;
              }
              const store = await ensureChannelStore();
              if (store === null) {
                sendError(res, 503, CHANNEL_MODULE_HINT);
                return;
              }
              // S1 账本：随网关启动创建；启动时先做 recover（补结上次进程中断的请求），随停止/控制台关闭而 close。
              // 账本写失败 fail-open（转发不受影响），degraded 状态经 /api/gateway/status 披露。
              let ledger = null;
              try {
                await mkdir(reportsRoot, { recursive: true });
                ledger = new ledgerModule.Ledger(join(reportsRoot, 'gateway-ledger.db'));
                const recovered = ledger.recover();
                if (recovered > 0) {
                  console.error(`[gateway] 账本恢复：补结 ${recovered} 条中断请求（client_status=interrupted，归因 gateway，不计渠道错误）`);
                }
                // store：控制台持有的持久渠道表（跨启停保留、启动前即可配置）；数据面与页面看到同一份渠道
                const instance = await gatewayModule.createAliasGateway({ port, ledger, onLog: (line) => console.error(line), store });
                gateway.instance = instance;
                gateway.ledger = ledger;
                ledger = null; // 所有权移交运行中的网关，停止/关闭时由本进程统一 close
                console.error(`[gateway] 已启动：127.0.0.1:${instance.port}（仅本机回环；虚拟 key 只在页面展示，不落日志）`);
                send(res, 200, { port: instance.port, virtualKey: instance.virtualKey });
              } catch (error) {
                if (ledger !== null) ledger.close();
                const code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : '';
                if (code === 'EADDRINUSE') {
                  sendError(res, 400, `端口 ${port} 被占用：请换一个端口或留空使用随机端口。收到：${JSON.stringify(String(port))}。示例：{"port":"8623"}`);
                } else {
                  sendError(res, 400, `网关启动失败：${error instanceof Error ? error.message : String(error)}。示例：{"port":"8622"}（缺省 = 随机回环端口）`);
                }
              }
            } finally {
              gateway.starting = false;
            }
            return;
          }
          if (pathname === '/api/gateway/stop') {
            if (gateway.starting) {
              sendError(res, 409, '网关正在启动中：请等启动完成后再停止（避免启动/停止互相覆盖）。');
              return;
            }
            if (gateway.instance === null) {
              send(res, 200, { stopped: false });
              return;
            }
            const instance = gateway.instance;
            gateway.instance = null;
            gateway.modulePromise = null;
            gateway.ledgerPromise = null;
            await instance.close().catch(() => undefined);
            if (gateway.ledger !== null) {
              // 先停网关（不再产生新结算）再关账本：checkpoint 后释放文件句柄
              gateway.ledger.close();
              gateway.ledger = null;
            }
            console.error('[gateway] 已停止（在途请求由数据面自行收尾；账本已 checkpoint 关闭）');
            send(res, 200, { stopped: true });
            return;
          }
          if (pathname === '/api/gateway/channels') {
            const store = await ensureChannelStore();
            if (store === null) {
              sendError(res, 503, CHANNEL_MODULE_HINT);
              return;
            }
            try {
              const channel = store.create(gbody);
              console.error(
                `[gateway] 渠道已添加：${channel.id}（协议 ${channel.protocol ?? 'unified'}；别名 ${channel.models.length} 个；允许本机/内网上游=${channel.allowPrivateUpstream === true ? '是' : '否'}；上游 key 仅存内存，不回显/不落日志）`,
              );
              send(res, 200, { channel: store.view(channel) });
            } catch (error) {
              sendGatewayChannelError(res, error);
            }
            return;
          }
          const channelDeleteMatch = pathname.match(/^\/api\/gateway\/channels\/([^/]+)\/delete$/);
          if (channelDeleteMatch !== null) {
            const id = decodeChannelId(channelDeleteMatch[1]);
            if (id === null) {
              sendError(res, 400, '渠道 id 百分号编码畸形，无法解析。示例：先用 GET /api/gateway/channels 列出有效 id。');
              return;
            }
            const store = await ensureChannelStore();
            if (store === null) {
              sendError(res, 503, CHANNEL_MODULE_HINT);
              return;
            }
            if (!store.remove(id)) {
              sendError(res, 404, `未找到渠道 ${JSON.stringify(id)}（可能已被删除）。示例：先用 GET /api/gateway/channels 列出有效 id。`);
              return;
            }
            console.error(`[gateway] 渠道已移除：${id}（在途请求不打断；别名即刻释放可复用）`);
            send(res, 200, { deleted: true });
            return;
          }
          const channelMatch = pathname.match(/^\/api\/gateway\/channels\/([^/]+)$/);
          if (channelMatch !== null) {
            const id = decodeChannelId(channelMatch[1]);
            if (id === null) {
              sendError(res, 400, '渠道 id 百分号编码畸形，无法解析。示例：先用 GET /api/gateway/channels 列出有效 id。');
              return;
            }
            const store = await ensureChannelStore();
            if (store === null) {
              sendError(res, 503, CHANNEL_MODULE_HINT);
              return;
            }
            try {
              const channel = store.update(id, gbody);
              send(res, 200, { channel: store.view(channel) });
            } catch (error) {
              sendGatewayChannelError(res, error);
            }
            return;
          }
          if (pathname === '/api/gateway/virtual-key/rotate') {
            if (gateway.instance === null) {
              gatewayNotRunning(res, '虚拟 key 随网关启动生成');
              return;
            }
            send(res, 200, { virtualKey: gateway.instance.rotateVirtualKey() });
            return;
          }
          // 一键获取模型：服务端代取上游 GET {baseUrl}/models（无需网关运行；Key 只进请求头、不回显不落日志）
          if (pathname === '/api/gateway/probe-models') {
            const protocolProvided =
              gbody.protocol !== undefined && gbody.protocol !== null && gbody.protocol !== '';
            let protocol = protocolProvided ? gbody.protocol : 'unified';
            if (protocolProvided && protocol !== 'unified' && protocol !== 'openai' && protocol !== 'anthropic') {
              sendError(res, 400, `protocol 非法：收到值 ${JSON.stringify(gbody.protocol ?? null)}。示例："unified"（统一中转）或 "openai"、"anthropic"（三值之一）`);
              return;
            }
            let baseUrl = typeof gbody.baseUrl === 'string' ? gbody.baseUrl.trim() : '';
            let apiKey = typeof gbody.apiKey === 'string' ? gbody.apiKey : '';
            let allowPrivate = gbody.allowPrivateUpstream === true;
            if (typeof gbody.channelId === 'string' && gbody.channelId !== '') {
              const store = await ensureChannelStore();
              if (store === null) {
                sendError(res, 503, CHANNEL_MODULE_HINT);
                return;
              }
              const existing = store.list().find((item) => item.id === gbody.channelId) ?? null;
              if (existing === null) {
                sendError(res, 404, `未找到渠道 ${JSON.stringify(gbody.channelId)}（可能已被删除）。示例：先用 GET /api/gateway/channels 列出有效 id。`);
                return;
              }
              if (baseUrl === '') baseUrl = existing.baseUrl;
              if (apiKey === '') apiKey = existing.apiKey;
              if (gbody.allowPrivateUpstream === undefined) allowPrivate = existing.allowPrivateUpstream === true;
              // 编辑已有渠道时省略 protocol：沿用渠道已保存的协议，不能静默退回 unified
              if (!protocolProvided) protocol = existing.protocol ?? 'unified';
            }
            if (baseUrl === '') {
              sendError(res, 400, 'probe-models 需要 baseUrl（或提供已保存渠道的 channelId 复用）。示例：{"baseUrl":"https://relay.example.com/v1","apiKey":"sk-…","protocol":"unified"}');
              return;
            }
            if (apiKey === '') {
              sendError(res, 400, '缺少上游 API Key：新渠道必须携带 apiKey；编辑已有渠道可传 channelId 复用已保存的 Key。示例：{"baseUrl":"https://relay.example.com/v1","apiKey":"sk-…"}');
              return;
            }
            const ssrfModule = await loadSsrfModule();
            if (ssrfModule === null) {
              sendError(res, 503, CHANNEL_MODULE_HINT);
              return;
            }
            const check = ssrfModule.validateUpstreamBaseUrl(baseUrl, { allowPrivate });
            if (!check.ok || check.url === null) {
              sendError(res, 400, String(check.message));
              return;
            }
            const pinned = await ssrfModule.resolvePinnedUpstream({ hostname: check.url.hostname, lookup: ssrfModule.defaultDnsLookup, allowPrivate });
            if (!pinned.ok || pinned.ip === null) {
              sendError(res, 400, String(pinned.message));
              return;
            }
            const result = await fetchUpstreamModels({
              url: check.url,
              ip: pinned.ip,
              apiKey,
              protocol,
              lookup: ssrfModule.pinnedLookup(pinned.ip),
            });
            const scrub = (text) => String(text).split(apiKey).join('***').slice(0, 300);
            if (result.error !== undefined) {
              sendError(res, 502, `获取模型列表失败（网络层）：${scrub(result.error)}。请检查 Base URL 与网络后重试。`);
              return;
            }
            if (result.status < 200 || result.status >= 300) {
              sendError(res, 502, `获取模型列表失败：上游返回 HTTP ${result.status}。响应片段：${scrub(result.body ?? '')}（Key 不回显）。若该上游未实现 /models 列表（部分 Anthropic 中转常见），请改用手动添加模型行。`);
              return;
            }
            let parsed;
            try {
              parsed = JSON.parse(result.body ?? '');
            } catch {
              sendError(res, 502, `获取模型列表失败：上游响应不是 JSON。响应片段：${scrub(result.body ?? '')}。若该上游未实现 /models 列表，请改用手动添加模型行。`);
              return;
            }
            const data = parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.data) ? parsed.data : [];
            const models = [];
            for (const item of data) {
              if (item !== null && typeof item === 'object' && typeof item.id === 'string' && item.id.trim() !== '') models.push(item.id.trim());
            }
            if (models.length === 0) {
              sendError(res, 502, `获取模型列表失败：上游 /models 响应中没有可识别的模型 id（data[].id）。响应片段：${scrub(result.body ?? '')}。请改用手动添加模型行。`);
              return;
            }
            send(res, 200, { models });
            return;
          }
          sendError(res, 404, '未知的 API 端点。');
          return;
        }
        // 其余均为 POST：需要 token。未知路径的非 POST 方法必须回 404（「仅支持 POST」只对已登记端点成立，否则文案说谎）。
        if (req.method !== 'POST') {
          if (!POST_ONLY_ENDPOINTS.has(pathname)) {
            sendError(res, 404, '未知的 API 端点。');
            return;
          }
          sendError(res, 405, '该端点仅支持 POST。', { allow: 'POST' });
          return;
        }
        if (!requireToken(req, res)) return;
        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          sendError(res, 400, error instanceof Error ? error.message : String(error));
          return;
        }
        if (pathname === '/api/key') {
          if (typeof body.key !== 'string' || body.key.trim() === '') {
            sendError(res, 400, 'key 必须为非空字符串（收到空白或非字符串值）。示例：sk-xxx');
            return;
          }
          state.sessionKey = body.key.trim();
          send(res, 200, { stored: true, ...keyInfo() });
          return;
        }
        if (pathname === '/api/key/clear') {
          state.sessionKey = null;
          send(res, 200, { stored: false, ...keyInfo() });
          return;
        }
        if (pathname === '/api/reports/clear') {
          const scope = typeof body.scope === 'string' ? body.scope : null;
          if (scope !== 'keep-latest' && scope !== 'reports-root' && scope !== 'all') {
            sendError(
              res,
              400,
              `清理范围非法：收到值 ${JSON.stringify(body.scope ?? null)}。` +
                `示例：{"scope":"keep-latest"}（可选 keep-latest=保留最新一套报告与最新基线、reports-root=删除报告/基线文件、all=清空 reports/ 全部）`,
            );
            return;
          }
          const runningJob = state.job !== null && state.job.status === 'running';
          const runningGateway = state.gateway.instance !== null || state.gateway.starting === true;
          if (runningJob || runningGateway) {
            const parts = [runningJob ? '检测任务' : null, runningGateway ? '聚合网关' : null].filter((label) => label !== null);
            sendError(res, 409, `清理被拒绝：${parts.join('、')} 仍在运行（证据文件正在写入，删除会截断观测）。请先停止后再清理。`);
            return;
          }
          if (!existsSync(reportsRoot)) {
            send(res, 200, { deleted: 0, freedBytes: 0, keep: [] });
            return;
          }
          // 规划器懒加载自 dist（未构建时诚实 503，不缓存失败——下次构建后直接可用）
          let planFn;
          try {
            ({ planReportsClear: planFn } = await import('../dist/src/report/clear-plan.js'));
          } catch {
            sendError(res, 503, '清理功能需要先构建：请在仓库根目录运行 npm run build（缺少 dist/src/report/clear-plan.js）。');
            return;
          }
          const dirents = await readdir(reportsRoot, { withFileTypes: true });
          const entries = [];
          for (const dirent of dirents) {
            if (dirent.name.startsWith('.')) continue;
            if (dirent.isDirectory()) {
              entries.push({ name: dirent.name, type: 'directory', size: 0, mtimeMs: 0 });
              continue;
            }
            const info = await stat(join(reportsRoot, dirent.name));
            entries.push({ name: dirent.name, type: 'file', size: info.size, mtimeMs: Math.round(info.mtimeMs) });
          }
          const plan = planFn(entries, scope);
          for (const item of plan.delete) {
            await rm(join(reportsRoot, item.name), { recursive: true, force: true });
          }
          send(res, 200, {
            deleted: plan.delete.length,
            freedBytes: plan.freedBytes,
            keep: plan.keep,
          });
          return;
        }
        if (pathname === '/api/test') {
          const base = validateBaseUrl(body.baseUrl);
          if (!base.ok) {
            sendError(res, 400, base.error);
            return;
          }
          body.baseUrl = base.value;
          if (typeof body.model !== 'string' || body.model.trim() === '') {
            sendError(res, 400, 'model 非法：收到值 (空)。示例：gpt-4o');
            return;
          }
          body.model = body.model.trim();
          if (typeof body.key === 'string' && body.key.trim() !== '') {
            state.sessionKey = body.key.trim();
          }
          if (state.job !== null && state.job.status === 'running') {
            sendError(res, 409, '已有一个检测任务在运行；请等当前任务完成后再发起（一次仅允许一个任务）。');
            return;
          }
          try {
            // 先做参数校验/组装：非法参数直接 400（含收到值与示例），不进入任务生命周期
            const args = buildTestArgs(body);
            const job = startTestJob(body, args);
            send(res, 200, { id: job.id });
          } catch (error) {
            sendError(res, 400, error instanceof Error ? error.message : String(error));
          }
          return;
        }
        sendError(res, 404, '未知的 API 端点。');
      } catch (error) {
        try {
          sendError(res, 500, `服务器内部错误：${error instanceof Error ? error.message : String(error)}`);
        } catch {
          /* 响应已发送则忽略 */
        }
      }
    });
    srv.on('error', rejectServer);
    srv.listen(portArg, '127.0.0.1', () => resolveServer(srv));
  });
  const address = server.address();
  if (address === null || typeof address !== 'object') throw new Error('服务器未能获取监听地址');
  const close = async () => {
    const closing = new Promise((resolveClose, rejectClose) => {
      server.close((error) => (error === undefined ? resolveClose(undefined) : rejectClose(error)));
    });
    server.closeAllConnections?.();
    const job = state.job;
    if (job !== null && job.child !== null) job.child.kill();
    const gatewayInstance = state.gateway.instance;
    if (gatewayInstance !== null) {
      state.gateway.instance = null;
      state.gateway.modulePromise = null;
      state.gateway.ledgerPromise = null;
      await gatewayInstance.close().catch(() => undefined);
    }
    const ledgerInstance = state.gateway.ledger;
    if (ledgerInstance !== null) {
      state.gateway.ledger = null;
      ledgerInstance.close();
    }
    await closing.catch(() => undefined);
  };
  return { port: address.port, token, close };
}

// —— CLI 直跑：node scripts/serve.mjs [port] [--no-browser] ——
//   [port] 缺省 8620；传 0 表示随机端口。
function parseServeArgs(argv) {
  let port = null;
  let noBrowser = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--no-browser') {
      noBrowser = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      return { ok: false, help: true, message: '用法：node scripts/serve.mjs [port] [--no-browser]（port 缺省 8620；0 表示随机端口）' };
    }
    if (/^\d+$/.test(arg) && Number(arg) <= 65535) {
      port = Number(arg);
      continue;
    }
    return { ok: false, message: `参数非法：${JSON.stringify(arg)}。示例：node scripts/serve.mjs 8620（或 0 表示随机端口）` };
  }
  return { ok: true, port, noBrowser };
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  const parsed = parseServeArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.message);
    process.exit(parsed.help === true ? 0 : 2);
  }
  const port = parsed.port ?? DEFAULT_PORT;
  const repoRoot = resolve(SCRIPT_DIR, '..');
  try {
    const server = await createConsoleServer({ port, repoRoot });
    console.log(`model-xray 控制台：http://127.0.0.1:${server.port}（仅本机回环）`);
    let shutdownStarted = false;
    const shutdown = (trigger, exitCode = 0) => {
      if (shutdownStarted) return Promise.resolve();
      shutdownStarted = true;
      console.log(`model-xray 控制台正在退出（${trigger}）…`);
      return server
        .close()
        .catch(() => undefined)
        .then(() => process.exit(exitCode));
    };
    if (!parsed.noBrowser && server.port !== 0 && process.stdout.isTTY && process.env.MODEL_XRAY_NO_BROWSER !== '1') {
      const url = `http://127.0.0.1:${server.port}`;
      const opener =
        process.platform === 'win32'
          ? spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' })
          : process.platform === 'darwin'
            ? spawn('open', [url], { detached: true, stdio: 'ignore' })
            : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
      opener.on('error', () => undefined);
      opener.unref();
    }
    console.log('Ctrl+C（或关闭 stdin）停止。');
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code === 'EADDRINUSE') {
      console.error(`端口 ${port}（默认 ${DEFAULT_PORT}）被占用。请换一个端口重试，例如：npm run ui -- ${DEFAULT_PORT + 1}`);
      process.exit(1);
    }
    throw error;
  }
}
