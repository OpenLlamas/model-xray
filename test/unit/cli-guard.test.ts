import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// F4 退出兜底专项：与 e2e 的健康路径不同，这里直接驱动 scheduleExitGuard 验证
// 「挂住时强制退出」「健康时不打扰（unref）」「默认 10s」三条行为契约。
const CLI_URL = pathToFileURL(fileURLToPath(new URL('../../src/cli.js', import.meta.url))).href;

function runChild(body: string, timeoutMs: number): Promise<{ status: number | null; elapsedMs: number; stderr: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const code = `import(${JSON.stringify(CLI_URL)}).then((m) => { ${body} }).catch((e) => { console.error(e); process.exit(3); });`;
    const child = spawn(process.execPath, ['-e', code], { windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, elapsedMs: Date.now() - started, stderr });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ status: -1, elapsedMs: Date.now() - started, stderr: String(error) });
    });
  });
}

test('exit guard: a hung process is force-exited with the audit exit code after the guard delay', async () => {
  // 模拟「main 已返回、未知句柄挂住事件循环」：keep-alive 定时器存活，guard(9, 300ms) 必须强制 exit 9
  const result = await runChild('m.scheduleExitGuard(9, 300); setInterval(() => {}, 1000);', 10_000);
  assert.equal(result.status, 9, result.stderr);
  assert.ok(result.elapsedMs >= 300, `退出过早：${result.elapsedMs}ms`);
  assert.ok(result.elapsedMs < 5_000, `退出过迟：${result.elapsedMs}ms`);
});

test('exit guard: unref never preempts a process that would exit naturally (code preserved)', async () => {
  // 无存活句柄时进程立即自然退出：退出码必须来自 process.exitCode（默认 0），而不是 9
  const result = await runChild('m.scheduleExitGuard(9, 300);', 10_000);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.elapsedMs < 2_000, `自然退出被拖延：${result.elapsedMs}ms`);
});

test('exit guard: production default delay is 10s (hung process exits with its code around 10s)', async () => {
  const result = await runChild('m.scheduleExitGuard(7); setInterval(() => {}, 1000);', 20_000);
  assert.equal(result.status, 7, result.stderr);
  assert.ok(result.elapsedMs >= 9_500, `默认守卫早于 10s 触发：${result.elapsedMs}ms`);
  assert.ok(result.elapsedMs < 15_000, `默认守卫迟于 10s 过多：${result.elapsedMs}ms`);
});
