#!/usr/bin/env node
// model-xray Web 控制台启动器（薄封装）：默认端口 8620，仅绑定 127.0.0.1。
// 实际服务由 scripts/serve.mjs 提供（静态控制台 + 本地 API）；
// 端口被占用时以退出码 1 结束并给出换端口提示。
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConsoleServer } from './serve.mjs';

const DEFAULT_PORT = 8620;
const raw = process.argv[2];
let port = DEFAULT_PORT;
if (raw !== undefined) {
  if (!/^\d+$/.test(raw) || Number(raw) > 65535) {
    console.error(`端口参数非法：${JSON.stringify(raw)}。示例：node scripts/web-server.mjs ${DEFAULT_PORT}（或 0 表示随机端口）`);
    process.exit(2);
  }
  port = Number(raw);
}
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  const server = await createConsoleServer({ port, repoRoot });
  console.log(`model-xray Web 控制台：http://127.0.0.1:${server.port}（仅本机回环；Ctrl+C 退出）`);
  if (server.port !== 0 && process.stdout.isTTY && process.env.MODEL_XRAY_NO_BROWSER !== '1') {
    const { spawn } = await import('node:child_process');
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
  process.on('SIGINT', () => {
    void server.close().finally(() => process.exit(0));
  });
} catch (error) {
  const code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code === 'EADDRINUSE') {
    console.error(
      `端口 ${port} 被占用（web-server 默认端口 ${DEFAULT_PORT}）。` +
        `请换一个端口重试，例如：node scripts/web-server.mjs ${DEFAULT_PORT + 1}`,
    );
    process.exit(1);
  }
  throw error;
}
