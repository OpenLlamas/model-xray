import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PRICE_PAGE_CANDIDATES, scrapeDeclaredPricing } from '../../src/pricing-scrape.js';

interface RecordedRequest {
  path: string;
  accept: string | undefined;
  authorization: string | undefined;
}

interface Site {
  origin: string;
  requests: RecordedRequest[];
  close: () => void;
}

function requestPath(req: IncomingMessage): string {
  return (req.url ?? '/').split('?')[0] ?? '/';
}

function replyHtml(res: ServerResponse, body: string, status = 200): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

function replyNotFound(res: ServerResponse): void {
  replyHtml(res, '<html><body>not found</body></html>', 404);
}

/** 本地 mock 站点：记录每个请求的路径与请求头（用于验证不带凭证、不打跨源）。 */
function startSite(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Site> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    requests.push({
      path: requestPath(req),
      accept: typeof req.headers.accept === 'string' ? req.headers.accept : undefined,
      authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
    });
    // 客户端超限/超时取消时，服务端写入会报错；吞掉避免测试进程被未处理事件打断。
    res.on('error', () => undefined);
    handler(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address !== null && typeof address === 'object');
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        requests,
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}

test('plain HTML price table: 表头声明 $/1M，行内无标签按输入→输出约定解析', async () => {
  const page = `<!doctype html><html><body>
    <table>
      <tr><th>Model</th><th>Input</th><th>Output</th></tr>
      <tr><th>unit</th><th>$ / 1M tokens</th><th>$ / 1M tokens</th></tr>
      <tr><td>gpt-4o-mini</td><td>$0.15</td><td>$0.60</td></tr>
      <tr><td>GPT-4o</td><td>$2.50</td><td>$10.00</td></tr>
    </table>
  </body></html>`;
  const site = await startSite((req, res) => {
    if (requestPath(req) === '/pricing') replyHtml(res, page);
    else replyNotFound(res);
  });
  try {
    const result = await scrapeDeclaredPricing(site.origin, 'gpt-4o', { timeoutMs: 2000 });
    assert.equal(result.state, 'ok');
    assert.equal(result.reason, null);
    assert.equal(result.page, '/pricing');
    assert.ok(result.html !== null && result.html.includes('<table'));
    assert.equal(result.entries.length, 2);
    assert.ok(result.matched !== null);
    assert.equal(result.matched?.modelName, 'GPT-4o', 'modelName 保留页面原文大小写');
    assert.equal(result.matched?.inputUsdPerM, 2.5);
    assert.equal(result.matched?.outputUsdPerM, 10);
    assert.equal(result.matched?.currency, 'USD');
    assert.equal(result.matched?.confidence, 'table');
    assert.ok(result.matched?.rawLine.includes('GPT-4o'));
    for (const request of site.requests) {
      assert.equal(request.accept, 'text/html', '只声明 accept: text/html');
      assert.equal(request.authorization, undefined, '绝不携带 Authorization');
    }
  } finally {
    site.close();
  }
});

test('显式 输入/输出 标签：按行内标签归属输入价与输出价', async () => {
  const page = `<html><body><table>
    <tr><td>claude-3.5-sonnet</td><td>输入 $3.00 / 1M tokens</td><td>输出 $15.00 / 1M tokens</td></tr>
  </table></body></html>`;
  const site = await startSite((req, res) => {
    if (requestPath(req) === '/pricing') replyHtml(res, page);
    else replyNotFound(res);
  });
  try {
    const result = await scrapeDeclaredPricing(site.origin, 'claude-3.5-sonnet', { timeoutMs: 2000 });
    assert.equal(result.state, 'ok');
    assert.ok(result.matched !== null);
    assert.equal(result.matched?.modelName, 'claude-3.5-sonnet');
    assert.equal(result.matched?.inputUsdPerM, 3);
    assert.equal(result.matched?.outputUsdPerM, 15);
    assert.equal(result.matched?.confidence, 'table');
  } finally {
    site.close();
  }
});

test('CNY 页面：currency=CNY，USD 字段保持 null（绝不换算）', async () => {
  const page = `<html><body><table>
    <tr><td>qwen-max</td><td>输入 ￥14 / 百万 tokens</td><td>输出 70 元 / 百万 tokens</td></tr>
  </table></body></html>`;
  const site = await startSite((req, res) => {
    if (requestPath(req) === '/pricing') replyHtml(res, page);
    else replyNotFound(res);
  });
  try {
    const result = await scrapeDeclaredPricing(site.origin, 'qwen-max', { timeoutMs: 2000 });
    assert.equal(result.state, 'ok');
    assert.ok(result.matched !== null);
    assert.equal(result.matched?.currency, 'CNY');
    assert.equal(result.matched?.inputUsdPerM, null);
    assert.equal(result.matched?.outputUsdPerM, null);
  } finally {
    site.close();
  }
});

test('「计费单元」中的“元”不算 CNY 币种：纯 USD 行仍按 USD 解析', async () => {
  const page = `<html><body><table>
    <tr><td>gpt-4o</td><td>计费单元 输入 $2.50 / 1M tokens</td><td>输出 $10.00 / 1M tokens</td></tr>
  </table></body></html>`;
  const site = await startSite((req, res) => {
    if (requestPath(req) === '/pricing') replyHtml(res, page);
    else replyNotFound(res);
  });
  try {
    const result = await scrapeDeclaredPricing(site.origin, 'gpt-4o', { timeoutMs: 2000 });
    assert.equal(result.state, 'ok');
    assert.equal(result.matched?.currency, 'USD');
    assert.equal(result.matched?.inputUsdPerM, 2.5);
    assert.equal(result.matched?.outputUsdPerM, 10);
  } finally {
    site.close();
  }
});

test('所有候选页 404 → not_applicable（能力边界，不是错误）', async () => {
  const site = await startSite((_req, res) => replyNotFound(res));
  try {
    const result = await scrapeDeclaredPricing(site.origin, 'gpt-4o', { timeoutMs: 2000 });
    assert.equal(result.state, 'not_applicable');
    assert.match(result.reason ?? '', /404/);
    assert.equal(result.page, null);
    assert.equal(result.html, null);
    assert.deepEqual(result.entries, []);
    assert.equal(result.matched, null);
    assert.deepEqual(
      site.requests.map((request) => request.path),
      [...PRICE_PAGE_CANDIDATES],
      '按候选顺序逐个探测且不重复',
    );
  } finally {
    site.close();
  }
});

test('无标签表格行出现价格区间 → 不按输入/输出两列配对，字段留 null', async () => {
  const page = `<html><body><table>
    <tr><td>gpt-4o</td><td>$2.50 - $5.00 / 1M tokens</td></tr>
  </table></body></html>`;
  const site = await startSite((req, res) => {
    if (requestPath(req) === '/pricing') replyHtml(res, page);
    else replyNotFound(res);
  });
  try {
    const result = await scrapeDeclaredPricing(site.origin, 'gpt-4o', { timeoutMs: 2000 });
    assert.equal(result.state, 'ok');
    assert.equal(result.entries.length, 1);
    assert.equal(result.matched?.inputUsdPerM, null);
    assert.equal(result.matched?.outputUsdPerM, null);
  } finally {
    site.close();
  }
});

test('同一行混排 /1K 与 /1M → 单位不可判定，整行放弃', async () => {
  const page = `<html><body><table>
    <tr><td>gpt-4o</td><td>输入 $0.002 / 1K tokens</td><td>输出 $0.010 / 1M tokens</td></tr>
  </table></body></html>`;
  const site = await startSite((req, res) => {
    if (requestPath(req) === '/pricing') replyHtml(res, page);
    else replyNotFound(res);
  });
  try {
    const result = await scrapeDeclaredPricing(site.origin, 'gpt-4o', { timeoutMs: 2000 });
    assert.equal(result.state, 'not_applicable');
    assert.equal(result.matched, null);
  } finally {
    site.close();
  }
});

test('SPA shell（无价格文本）→ not_applicable，理由说明需要 JS 渲染', async () => {
  const shell =
    '<!doctype html><html><head><script src="/assets/app.js"></script></head><body><div id="root"></div></body></html>';
  const site = await startSite((_req, res) => replyHtml(res, shell));
  try {
    const result = await scrapeDeclaredPricing(site.origin, 'gpt-4o', { timeoutMs: 2000 });
    assert.equal(result.state, 'not_applicable');
    assert.match(result.reason ?? '', /JS 渲染/);
    assert.match(result.reason ?? '', /SPA/);
    assert.deepEqual(result.entries, []);
    assert.equal(result.matched, null);
    assert.equal(result.page, '/pricing');
    assert.ok(result.html !== null && result.html.includes('id="root"'), 'html 仍返回供调用方落盘');
  } finally {
    site.close();
  }
});

test('跨源绝对 URL / 协议相对 URL 一律拒绝，且不发起任何网络请求', async () => {
  const site = await startSite((_req, res) => replyNotFound(res));
  try {
    const absolute = await scrapeDeclaredPricing(site.origin, 'gpt-4o', {
      timeoutMs: 2000,
      pricePage: 'https://evil.example/pricing',
    });
    assert.equal(absolute.state, 'not_applicable');
    assert.match(absolute.reason ?? '', /跨源/);
    assert.equal(absolute.page, null);

    const protocolRelative = await scrapeDeclaredPricing(site.origin, 'gpt-4o', {
      timeoutMs: 2000,
      pricePage: '//evil.example/pricing',
    });
    assert.equal(protocolRelative.state, 'not_applicable');
    assert.match(protocolRelative.reason ?? '', /跨源/);

    assert.equal(site.requests.length, 0, '拒绝发生在 fetch 之前');
  } finally {
    site.close();
  }
});

test('响应体超过 512KB 上限（流式分块）→ failed', async () => {
  const site = await startSite((req, res) => {
    if (requestPath(req) !== '/pricing') {
      replyNotFound(res);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.write('<html><body>');
    res.write('x'.repeat(600 * 1024));
    res.end('</body></html>');
  });
  try {
    const result = await scrapeDeclaredPricing(site.origin, 'gpt-4o', { timeoutMs: 2000 });
    assert.equal(result.state, 'failed');
    assert.match(result.reason ?? '', /512KB|上限/);
    assert.equal(result.page, '/pricing');
    assert.equal(result.html, null);
    assert.deepEqual(result.entries, []);
  } finally {
    site.close();
  }
});

test('<script>/<style> 里的价格不参与解析（只认可见文本）', async () => {
  const page = `<html><head>
    <script>window.__FAKE__ = "gpt-4o 输入 $0.01 / 1M tokens 输出 $0.02 / 1M tokens";</script>
    <style>.fake::after { content: "$9.99 / 1M tokens"; }</style>
  </head><body><table>
    <tr><td>gpt-4o</td><td>$2.50 / 1M tokens</td><td>$10.00 / 1M tokens</td></tr>
  </table></body></html>`;
  const site = await startSite((req, res) => {
    if (requestPath(req) === '/pricing') replyHtml(res, page);
    else replyNotFound(res);
  });
  try {
    const result = await scrapeDeclaredPricing(site.origin, 'gpt-4o', { timeoutMs: 2000 });
    assert.equal(result.state, 'ok');
    assert.equal(result.entries.length, 1, '脚本里的假价不得生成额外条目');
    assert.equal(result.matched?.inputUsdPerM, 2.5);
    assert.equal(result.matched?.outputUsdPerM, 10);
  } finally {
    site.close();
  }
});

test('模型名 token 边界：gpt-4o 不得命中 gpt-4o-mini 行', async () => {
  const page = `<html><body><table>
    <tr><th>unit</th><th>$/1M tokens</th><th>$/1M tokens</th></tr>
    <tr><td>gpt-4o-mini</td><td>$0.15</td><td>$0.60</td></tr>
  </table></body></html>`;
  const site = await startSite((req, res) => {
    if (requestPath(req) === '/pricing') replyHtml(res, page);
    else replyNotFound(res);
  });
  try {
    const result = await scrapeDeclaredPricing(site.origin, 'gpt-4o', { timeoutMs: 2000 });
    assert.equal(result.state, 'ok', '页面确实有可解析价格');
    assert.equal(result.matched, null, '目标模型不在页面中时必须 matched=null');
    assert.equal(result.entries[0]?.modelName, 'gpt-4o-mini');
  } finally {
    site.close();
  }
});

test('标签存在但同一字段有多个数字 → 字段留 null（不猜），模型名邻近推断 confidence=nearby', async () => {
  const page = `<html><body>
    <div>gpt-4o</div>
    <div>输入价 $2.50 / 1M tokens / $10.00 / 1M tokens</div>
  </body></html>`;
  const site = await startSite((req, res) => {
    if (requestPath(req) === '/pricing') replyHtml(res, page);
    else replyNotFound(res);
  });
  try {
    const result = await scrapeDeclaredPricing(site.origin, 'gpt-4o', { timeoutMs: 2000 });
    assert.equal(result.state, 'ok');
    assert.ok(result.matched !== null);
    assert.equal(result.matched?.inputUsdPerM, null, '输入价有歧义时不得挑一个数');
    assert.equal(result.matched?.outputUsdPerM, null);
    assert.equal(result.matched?.confidence, 'nearby');
    assert.equal(result.matched?.modelName, 'gpt-4o');
  } finally {
    site.close();
  }
});

test('裸数字（无币种）不当作价格：即使有每百万单位也不解析', async () => {
  const page = `<html><body>
    <table><tr><td>gpt-4o</td><td>2.50</td><td>10.00</td></tr></table>
    <p>单位：每百万 tokens</p>
  </body></html>`;
  const site = await startSite((req, res) => {
    if (requestPath(req) === '/pricing') replyHtml(res, page);
    else replyNotFound(res);
  });
  try {
    const result = await scrapeDeclaredPricing(site.origin, 'gpt-4o', { timeoutMs: 2000 });
    assert.equal(result.state, 'not_applicable');
    assert.deepEqual(result.entries, []);
    assert.equal(result.matched, null);
  } finally {
    site.close();
  }
});

test('显式同源价格页被接受，且只请求该页', async () => {
  const page = `<html><body><table>
    <tr><td>gpt-4o</td><td>$2.50 / 1M tokens</td><td>$10.00 / 1M tokens</td></tr>
  </table></body></html>`;
  const site = await startSite((req, res) => {
    if (requestPath(req) === '/custom-price') replyHtml(res, page);
    else replyNotFound(res);
  });
  try {
    const result = await scrapeDeclaredPricing(site.origin, 'gpt-4o', {
      timeoutMs: 2000,
      pricePage: `${site.origin}/custom-price`,
    });
    assert.equal(result.state, 'ok');
    assert.equal(result.page, '/custom-price');
    assert.equal(result.matched?.inputUsdPerM, 2.5);
    assert.deepEqual(
      site.requests.map((request) => request.path),
      ['/custom-price'],
      '显式指定时不再探测候选页',
    );
  } finally {
    site.close();
  }
});

test('重定向不跟随：指定价格页 302 → not_applicable 且不请求 Location', async () => {
  const site = await startSite((req, res) => {
    if (requestPath(req) === '/pricing') {
      res.writeHead(302, { location: '/login' });
      res.end();
      return;
    }
    replyNotFound(res);
  });
  try {
    const result = await scrapeDeclaredPricing(site.origin, 'gpt-4o', {
      timeoutMs: 2000,
      pricePage: '/pricing',
    });
    assert.equal(result.state, 'not_applicable');
    assert.match(result.reason ?? '', /重定向/);
    assert.deepEqual(
      site.requests.map((request) => request.path),
      ['/pricing'],
      '不得跟随 Location 再发一次请求',
    );
  } finally {
    site.close();
  }
});

test('请求超时 → failed（AbortController 生效）', async () => {
  const site = await startSite((_req, _res) => {
    // 故意不响应，等待客户端超时。
  });
  try {
    const result = await scrapeDeclaredPricing(site.origin, 'gpt-4o', { timeoutMs: 80 });
    assert.equal(result.state, 'failed');
    assert.match(result.reason ?? '', /超时/);
    assert.equal(result.page, '/pricing');
  } finally {
    site.close();
  }
});

test('baseUrl 带 /v1 时仍探测站点根价目页（不落 /v1/pricing）', async () => {
  const page = `<html><body><table>
    <tr><td>gpt-4o</td><td>$2.50 / 1M tokens</td><td>$10.00 / 1M tokens</td></tr>
  </table></body></html>`;
  const site = await startSite((req, res) => {
    if (requestPath(req) === '/pricing') replyHtml(res, page);
    else replyNotFound(res);
  });
  try {
    const result = await scrapeDeclaredPricing(`${site.origin}/v1`, 'gpt-4o', { timeoutMs: 2000 });
    assert.equal(result.state, 'ok');
    assert.equal(result.page, '/pricing');
    assert.equal(result.matched?.inputUsdPerM, 2.5);
    assert.deepEqual(
      site.requests.map((request) => request.path),
      ['/pricing'],
      '价目页在站点根：baseUrl 的 /v1 段不得进入候选页路径',
    );
  } finally {
    site.close();
  }
});

test('baseUrl 带 /v1 时显式相对价格页按站点根解析', async () => {
  const page = `<html><body><table>
    <tr><td>gpt-4o</td><td>$2.50 / 1M tokens</td><td>$10.00 / 1M tokens</td></tr>
  </table></body></html>`;
  const site = await startSite((req, res) => {
    if (requestPath(req) === '/pricing') replyHtml(res, page);
    else replyNotFound(res);
  });
  try {
    const result = await scrapeDeclaredPricing(`${site.origin}/v1`, 'gpt-4o', {
      timeoutMs: 2000,
      pricePage: '/pricing',
    });
    assert.equal(result.state, 'ok');
    assert.equal(result.page, '/pricing');
    assert.deepEqual(
      site.requests.map((request) => request.path),
      ['/pricing'],
      '相对路径按站点根解析，不得落 /v1/pricing',
    );
  } finally {
    site.close();
  }
});
