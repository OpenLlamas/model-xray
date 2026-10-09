import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { get } from 'node:http';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 运行时位于 dist/test/unit/，向上回溯到仓库根（以 scripts/web-server.mjs 为标记）
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'scripts', 'web-server.mjs'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('未找到 scripts/web-server.mjs：请在仓库根目录下构建并运行测试。');
}

const REPO_ROOT = findRepoRoot();
const SERVER_SCRIPT = join(REPO_ROOT, 'scripts', 'web-server.mjs');

interface HttpResponse {
  status: number | undefined;
  contentType: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

// 注意：必须用 async spawn + 事件回调；spawnSync 会阻塞父事件循环，与子进程请求死锁
function request(port: number, path: string): Promise<HttpResponse> {
  return new Promise((resolvePromise, reject) => {
    const req = get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolvePromise({
          status: res.statusCode,
          contentType: String(res.headers['content-type'] ?? ''),
          headers: res.headers,
          body,
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('请求超时')));
  });
}

test('web-server：索引页/静态资源 200，穿越路径与缺失文件 404（端口 0 随机）', { timeout: 20000 }, async () => {
  const child = spawn(process.execPath, [SERVER_SCRIPT, '0'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });

  try {
    // 轮询解析启动日志里的实际端口；GET / 重试直到 200（上限 ~5s）
    const deadline = Date.now() + 5000;
    let port: number | null = null;
    let index: HttpResponse | null = null;
    let lastError = '';
    while (Date.now() < deadline) {
      const match = output.match(/127\.0\.0\.1:(\d+)/);
      if (match !== null && match[1] !== undefined) {
        port = Number(match[1]);
        try {
          const res = await request(port, '/');
          if (res.status === 200) {
            index = res;
            break;
          }
          lastError = `GET / → ${res.status}`;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
      await delay(100);
    }
    assert.ok(port !== null, `5 秒内未解析到端口。输出：${output}`);
    assert.ok(index !== null, `5 秒内 GET / 未就绪：${lastError}；输出：${output}`);
    assert.match(index.body, /model-xray/i);

    const appJs = await request(port, '/app.js');
    assert.equal(appJs.status, 200);
    assert.ok(appJs.contentType.includes('text/javascript'), `Content-Type: ${appJs.contentType}`);

    // 穿越路径（原始路径与百分号编码两种）都必须 404
    const traversal = await request(port, '/../etc/package.json');
    assert.equal(traversal.status, 404, `穿越路径返回了 ${traversal.status}`);
    const traversalEncoded = await request(port, '/%2e%2e/etc/package.json');
    assert.equal(traversalEncoded.status, 404, `编码穿越路径返回了 ${traversalEncoded.status}`);

    // 同级目录前缀绕过（web-xxx 与 web/ 共享字符串前缀但不共享分隔符边界）→ 404
    const sibling = await request(port, '/../web-server.mjs');
    assert.equal(sibling.status, 404, `同级路径返回了 ${sibling.status}`);

    // 点文件/点目录（.git、.env 等）一律 404
    const dotFile = await request(port, '/.hidden.json');
    assert.equal(dotFile.status, 404);
    const dotDir = await request(port, '/.git/config');
    assert.equal(dotDir.status, 404);

    // 畸形百分号编码 → 400（不是 500/崩溃）
    const malformed = await request(port, '/%zz');
    assert.equal(malformed.status, 400, `畸形编码返回了 ${malformed.status}`);

    // 纵深防御头：nosniff 必须在响应上
    const indexAgain = await request(port, '/');
    assert.match(String(indexAgain.headers['x-content-type-options'] ?? ''), /nosniff/i);

    // 404 兜底
    const missing = await request(port, '/no-such-file.html');
    assert.equal(missing.status, 404);
  } finally {
    child.kill();
    await once(child, 'exit').catch(() => undefined);
  }
});

test('web-server：端口被占用 → 退出码 1 并提示换端口', { timeout: 15000 }, async () => {
  const { createServer } = await import('node:net');
  const blocker = createServer();
  await new Promise<void>((resolvePromise) => blocker.listen(0, '127.0.0.1', resolvePromise));
  const address = blocker.address();
  assert.ok(address !== null && typeof address === 'object', '占用端口的服务未就绪');
  const port = address.port;

  const child = spawn(process.execPath, [SERVER_SCRIPT, String(port)], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 1, `退出码应为 1，实际 ${String(code)}；输出：${output}`);
    assert.match(output, /被占用/);
    assert.match(output, /8620/);
  } finally {
    blocker.close();
  }
});
