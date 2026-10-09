#!/usr/bin/env node
// model-xray 纯静态 Web 壳本地服务器。
// 只读 web/ 目录下的文件；仅 GET/HEAD；无任何后端逻辑、不代理、不转发。
// 用法：node scripts/web-server.mjs [port]   （默认 8619，传 0 表示随机端口并打印实际值）
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web');

const rawPort = process.argv[2];
const PORT = rawPort === undefined ? 8619 : Number(rawPort);
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  console.error(`端口必须是 0-65535 的整数。收到：${JSON.stringify(rawPort)}。`);
  console.error('示例：node scripts/web-server.mjs 8620（或 0 表示随机端口）');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const TEXT_PLAIN = { 'Content-Type': 'text/plain; charset=utf-8' };

// 纵深防御：所有响应都带 nosniff 与 CSP（错误响应也无害）。
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  if (body === undefined) {
    res.end();
    return;
  }
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, '仅支持 GET/HEAD\n', { ...TEXT_PLAIN, Allow: 'GET, HEAD' });
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
    } catch {
      send(res, 400, '非法的 URL 编码\n', TEXT_PLAIN);
      return;
    }
    if (pathname.includes('\0') || pathname.includes('\\')) {
      send(res, 404, 'Not Found\n', TEXT_PLAIN);
      return;
    }

    let rel = pathname;
    if (rel === '/') rel = '/index.html';
    else if (rel.endsWith('/')) rel += 'index.html';

    // 拒点文件/点目录（.git、.env 等）：任一路径段以 . 开头一律 404
    if (rel.split('/').some((segment) => segment.startsWith('.'))) {
      send(res, 404, 'Not Found\n', TEXT_PLAIN);
      return;
    }

    // 防穿越：normalize 后必须以 ROOT + 分隔符 为前缀（挡住 /../ 与编码后的 %2e%2e 等）
    const resolved = normalize(join(ROOT, rel));
    if (resolved !== ROOT && !resolved.startsWith(ROOT + sep)) {
      send(res, 404, 'Not Found\n', TEXT_PLAIN);
      return;
    }

    let body;
    try {
      body = await readFile(resolved);
    } catch {
      send(res, 404, 'Not Found\n', TEXT_PLAIN);
      return;
    }

    const type = MIME[extname(resolved).toLowerCase()] ?? 'application/octet-stream';
    send(res, 200, req.method === 'HEAD' ? undefined : body, {
      'Content-Type': type,
      'Content-Length': String(body.length),
    });
  } catch (error) {
    send(res, 500, `内部错误：${error instanceof Error ? error.message : String(error)}\n`, TEXT_PLAIN);
  }
});

server.on('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    console.error(`端口被占用，换一个端口：node scripts/web-server.mjs 8620`);
    process.exit(1);
  }
  console.error(`服务器错误：${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  const address = server.address();
  const port = address !== null && typeof address === 'object' ? address.port : PORT;
  console.error(`model-xray web 壳已启动：http://127.0.0.1:${port}（仅监听本机回环，Ctrl+C 停止）`);
});