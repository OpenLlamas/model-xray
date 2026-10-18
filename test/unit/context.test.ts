import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeContext } from '../../src/probes/context.js';
import { createEvidenceRecorder } from '../../src/evidence.js';
import { createRng } from '../../src/random.js';
import type { ChatRequest, ChatResult, OpenAIClient, ProbeCtx, RunConfig } from '../../src/types.js';

/**
 * 上下文探针的「定论级证据门槛」回归。
 *
 * 背景（2026-10-17 层 3 审查 + 官方 1M 实测）：非 --deep 时每档仅 3 个样本，
 * 「1 次未命中」是注意力噪声而非截断。原实现据 2/3 未命中即判「标称窗口不实（15 分 fail）」，
 * 属用稀疏样本诬告；反过来真实截断（保留尾部）在高深度档表现为命中率单调下降而非整档零命中，
 * 若简单改成「必须整档零命中」又会漏检。本组用例钉住两条边界：
 * ① 稀疏零星未命中 → warn（附命中计数，供人工复测）；
 * ② 整档零命中 / 单调恶化 / 双控制同时失败 / 二分扫描确认 / 400 尺寸类显式拒绝 → fail。
 */

function hitResult(text: string): ChatResult {
  return {
    ok: true,
    status: 200,
    finishReason: 'stop',
    model: 'm',
    text,
    reasoning: null,
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    usageRejected: null,
    attempts: 1,
    toolCalls: [],
    ttftMs: null,
    durationMs: 1,
    error: null,
    raw: '',
  };
}

function failResult(status: number, error: string): ChatResult {
  return {
    ok: false,
    status,
    finishReason: null,
    model: null,
    text: '',
    reasoning: null,
    usage: null,
    usageRejected: null,
    attempts: 1,
    toolCalls: [],
    ttftMs: null,
    durationMs: 1,
    error,
    raw: '',
  };
}

/**
 * 脚本化客户端：needle 请求按序号（0..2=25% 档，3..5=50%，6..8=75%，9..11=90%）
 * 走策略函数；echo 请求按提示词里的「结尾核对」标记识别。
 * 命中策略只需返回「是否命中」，命中文案统一为该请求自己的 nonce（从问题里解析）。
 */
function scriptedContextClient(
  needle: (index: number) => 'hit' | 'miss' | ChatResult,
  echo: 'auto' | 'hit' | 'miss' | ChatResult,
): { client: OpenAIClient; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let needleIndex = 0;
  const nonceOf = (prompt: string): string =>
    prompt.match(/编号([A-Z0-9]{6})/)?.[1] ?? prompt.match(/record ([A-Z0-9]{6})/)?.[1] ?? prompt.match(/结尾核对 ([A-Z0-9]{6})/)?.[1] ?? 'ZZZZZZ';
  return {
    requests,
    client: {
      baseUrl: 'http://127.0.0.1:0/v1',
      async chat(req: ChatRequest): Promise<ChatResult> {
        requests.push(req);
        const last = req.messages[req.messages.length - 1];
        const prompt = typeof last?.content === 'string' ? last.content : '';
        const isEcho = prompt.includes('结尾核对');
        const outcome = isEcho ? echo : needle(needleIndex++);
        if (typeof outcome !== 'string') return outcome;
        // 'auto' = 结尾回显默认命中（正常端点都能复述尾部）
        return outcome === 'hit' || outcome === 'auto' ? hitResult(nonceOf(prompt)) : hitResult('未找到相关记录');
      },
    },
  };
}

function makeCtx(client: OpenAIClient, deep = false): ProbeCtx {
  const cfg: RunConfig = {
    baseUrl: 'http://127.0.0.1:0/v1',
    apiKey: 'k',
    model: 'gpt-4o',
    claimedContext: 32000,
    expect: [],
    deep,
    contextSamples: deep ? 5 : 3,
    contextConfirmSamples: 3,
    seed: 1,
    timeoutMs: 1000,
    retries: 0,
    streamFallback: false,
    outDir: 'reports',
    html: false,
    yes: true,
    quiet: true,
  };
  return { client, cfg, rng: createRng(1), evidence: createEvidenceRecorder() };
}

test('context: 仅 1 个有效 needle 样本（其余空流）→ insufficient，不出 pass 100（最少证据门槛）', async () => {
  const blank: ChatResult = { ...hitResult(''), finishReason: null, usage: { prompt_tokens: 100, completion_tokens: 0, total_tokens: 100 } };
  const { client } = scriptedContextClient((i) => (i === 0 ? 'hit' : blank), 'hit');
  const outcome = await probeContext(makeCtx(client));
  assert.equal(outcome.status, 'insufficient', outcome.headline);
  assert.equal(outcome.score, null);
  assert.equal(outcome.level, 'unknown');
  assert.match(outcome.headline, /有效 needle 样本不足/);
});

test('context: 25% 档 1/3 未命中（其余全部命中 + 结尾回显通过）→ warn 55，不判「窗口不实」', async () => {
  const { client } = scriptedContextClient((index) => (index === 1 ? 'miss' : 'hit'), 'auto');
  const outcome = await probeContext(makeCtx(client));
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.level, 'warn', `稀疏样本不得定罪：${outcome.headline}`);
  assert.equal(outcome.score, 55);
  assert.match(outcome.headline, /2\/3/);
  assert.match(String(outcome.metrics['miss_depths'] ?? ''), /0\.25/);
  assert.equal(outcome.metrics['zero_miss_depths'], 'none');
  assert.ok(!outcome.findings.some((f) => f.level === 'fail'), JSON.stringify(outcome.findings));
});

test('context: 25% 档整档零命中 + 结尾回显通过 → fail 15（头部被裁剪的指纹仍能检出）', async () => {
  // 头部被裁剪指纹：25% 档首轮 0/3、确认性复采仍 0/3（共 0/6），高深度与结尾回显全部正常
  const script = [0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0];
  const { client, requests } = scriptedContextClient((index) => (script[index]! > 0 ? 'hit' : 'miss'), 'auto');
  const outcome = await probeContext(makeCtx(client));
  assert.equal(outcome.level, 'fail');
  assert.equal(outcome.score, 15);
  assert.match(outcome.headline, /窗口不实/);
  assert.match(String(outcome.metrics['zero_miss_depths'] ?? ''), /25%/);
  assert.equal(requests.length, 16, '基线档只复核一次（3 样本），不得重复复采');
  assert.match(String(outcome.metrics['depth_hits']), /0\.25:0\/6/);
});

test('context: 高深度命中率随深度单调下降（保留尾部型截断）→ 确认性复采复现后 fail 10', async () => {
  // 25% 3/3；50%/75% 各 1/3；90% 0/3 → 全部高深度档命中率低于低深度档且 ≥2 档有未命中
  // 非 --deep（n=3）需确认性复采：复采同样按退化作答才定罪（miss_pattern 记 *_confirmed）
  // 首轮 12 个样本：25% 3/3，三个高深度档各 0/3；复采 90%（0/3）、75%（0/3）、基线 25%（3/3）
  // → 基线复核后 6/6，两档 0/6：Fisher 精确检验 P=1/924，Bonferroni×3 后仍 ≤ α=0.01 → 定罪
  const script = [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1];
  const { client } = scriptedContextClient((index) => (script[index]! > 0 ? 'hit' : 'miss'), 'auto');
  const outcome = await probeContext(makeCtx(client));
  assert.equal(outcome.level, 'fail', outcome.headline);
  assert.equal(outcome.score, 10);
  assert.equal(outcome.metrics['miss_pattern'], 'monotone_degrade_confirmed');
  assert.ok(outcome.findings.some((f) => f.message.includes('确认性复采')), '必须披露确认性复采');
});

test('context: 单调恶化首轮信号经确认性复采不复现 → 降为 warn 55，不定罪', async () => {
  // 首轮：25% 3/3、三个高深度档各 0/3（看似整档不可读）；复采 25%（再 0/3）与 50%（全命中）
  // → 合并后低深度 3/6 与 50% 3/6 不再分出高低，整档零命中档位未复核 → 判为注意力噪声
  const script = [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1];
  const { client } = scriptedContextClient((index) => (script[index]! > 0 ? 'hit' : 'miss'), 'auto');
  const outcome = await probeContext(makeCtx(client));
  assert.equal(outcome.level, 'warn', `复采不复现不得定罪：${outcome.headline}`);
  assert.equal(outcome.score, 55);
  assert.equal(outcome.metrics['miss_pattern'], 'not_confirmed');
});

test('context: 孤立零星未命中（浅档 2/3 + 最深档 2/3，中间档全命中）→ warn 55，不按单调恶化定罪', async () => {
  const { client } = scriptedContextClient((index) => (index === 1 || index === 10 ? 'miss' : 'hit'), 'auto');
  const outcome = await probeContext(makeCtx(client));
  assert.equal(outcome.level, 'warn', outcome.headline);
  assert.equal(outcome.score, 55);
  assert.equal(outcome.metrics['miss_pattern'], undefined, '未构成单调恶化/整档零命中时不得记 miss_pattern');
});

test('context: 400 尺寸类显式拒绝 → fail 15（差分验证通过后才成立）', async () => {
  const tooLong = () => failResult(400, 'HTTP 400: {"error":{"message":"maximum context length exceeded","code":"context_length_exceeded"}}');
  // 索引 0..2 = 25% 档命中；3..11 = 深档全部 400；12/13 = 差分短输入对照（512/1024 tokens，需均成功）；
  // 14 = 最小被拒深度（25%）的配对长样本复验（须仍被拒，400 可复现才算与长度相关）
  const { client } = scriptedContextClient((index) => (index < 3 || (index >= 12 && index <= 13) ? 'hit' : tooLong()), tooLong());
  const outcome = await probeContext(makeCtx(client));
  assert.equal(outcome.level, 'fail', outcome.headline);
  assert.equal(outcome.score, 15);
  assert.match(outcome.headline, /显式拒绝/);
  assert.equal(outcome.metrics['depth_explicit_reject'], 1);
  assert.match(String(outcome.metrics['size_differential']), /accepted/);
});

test('context: 高深度档首样本 400、后续样本成功 → 不构成整档显式拒绝', async () => {
  // records.find(depth) 只取该档第一条记录：若首样本是 400、后续样本成功，
  // 旧逻辑会误把「首条 400」当成「整档全部 400」→ explicitReject 误定罪。
  const tooLong = () => failResult(400, 'HTTP 400 max context length exceeded');
  // 3/6/9 = 50%/75%/90% 档首样本 400；同档后续样本命中。
  // 12/13 = 差分短输入对照（成功）；14 = 最小被拒深度配对长样本（仍 400）。
  const { client } = scriptedContextClient((index) => {
    if (index === 14) return tooLong();
    if (index >= 12) return 'hit';
    if (index === 3 || index === 6 || index === 9) return tooLong();
    return 'hit';
  }, 'auto');
  const outcome = await probeContext(makeCtx(client));
  assert.equal(outcome.level, 'pass', `首样本 400 但同档后续成功不得判窗口不实：${outcome.headline}`);
  assert.equal(outcome.score, 100);
  assert.equal(outcome.metrics['depth_explicit_reject'], 0);
  assert.ok(!outcome.findings.some((f) => f.level === 'fail'), JSON.stringify(outcome.findings));
});

test('context: 400 但归因是欠费/限流 → 不算尺寸证据，全部样本失败 → unknown', async () => {
  const quota = () => failResult(400, 'HTTP 400: {"error":{"message":"insufficient balance, please recharge"}}');
  const { client } = scriptedContextClient(() => quota(), quota());
  const outcome = await probeContext(makeCtx(client));
  assert.equal(outcome.level, 'unknown', `欠费不得判成窗口不实：${outcome.headline}`);
  assert.equal(outcome.score, null);
  assert.equal(outcome.status, 'insufficient');
  assert.equal(outcome.metrics['depth_explicit_reject'], 0);
  assert.ok(!outcome.findings.some((f) => f.level === 'fail'), JSON.stringify(outcome.findings));
});

test('context: 400 文案未提及长度且短输入对照同样 400 → 差分验证不通过 → unknown（不据 400 指控窗口）', async () => {
  // 层 3 双审共同指出的残余误告：靠文案枚举归因不靠得住（网关/参数/WAF 也回 400）。
  // 差分验证：400 之外再打一发 ≤1024 tokens 的短输入对照，同样 400 → 拒绝与长度无关。
  const generic = () => failResult(400, 'HTTP 400: {"error":{"message":"Bad Request"}}');
  const { client } = scriptedContextClient(() => generic(), generic());
  const outcome = await probeContext(makeCtx(client));
  assert.equal(outcome.level, 'unknown', `差分验证未通过时不得定罪：${outcome.headline}`);
  assert.equal(outcome.score, null);
  assert.equal(outcome.metrics['depth_explicit_reject'], 0);
  assert.match(String(outcome.metrics['size_differential']), /failed/);
  assert.ok(outcome.findings.some((f) => /差分验证未通过/.test(f.message)));
  assert.ok(!outcome.findings.some((f) => f.level === 'fail'), JSON.stringify(outcome.findings));
});

test('context --deep: 边界扫描「先成功未命中、后遇传输故障」→ 不判截断（foundAtTokens 须一并失效）', async () => {
  // 层 3 反向审查明确要求的用例：break 前已得的 foundAtTokens 若不清空，一次故障后仍会触发 fail 10。
  let calls = 0;
  const nonceOf = (prompt: string): string =>
    prompt.match(/编号([A-Z0-9]{6})/)?.[1] ?? prompt.match(/record ([A-Z0-9]{6})/)?.[1] ?? prompt.match(/结尾核对 ([A-Z0-9]{6})/)?.[1] ?? 'ZZZZZZ';
  const client: OpenAIClient = {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(req: ChatRequest): Promise<ChatResult> {
      calls += 1;
      const last = req.messages[req.messages.length - 1];
      const prompt = typeof last?.content === 'string' ? last.content : '';
      if (calls <= 13) return hitResult(nonceOf(prompt));
      // 边界扫描第 1 次：成功但未命中（foundAtTokens 被记录）；第 2 次：传输故障
      return calls === 14 ? hitResult('未找到') : failResult(0, 'network：fetch failed');
    },
  };
  const outcome = await probeContext(makeCtx(client, true));
  // 2026-10-17 终审后口径：needle 有未命中 + 结尾回显传输故障 → 结论不得是 pass「全部命中」，
  // 但也绝不得是截断 fail（传输故障不定罪）→ 稀疏未命中 warn 55（附计数）。
  assert.equal(outcome.level, 'warn', `成功未命中后再遇故障不得判截断、也不得谎称全命中：${outcome.headline}`);
  assert.equal(outcome.score, 55);
  assert.match(String(outcome.metrics['boundary']), /errored=1/);
  assert.ok(!outcome.findings.some((f) => f.level === 'fail'), JSON.stringify(outcome.findings));
});

test('context --deep: 边界扫描遇传输故障 → 不判「边界扫描确认截断」（0 次网络抖动不得定罪）', async () => {
  // needle 请求在 calls>13 后一律传输故障（90% 档因此没有有效样本），结尾回显同样失败；
  // 随后边界二分扫描的请求也一律传输故障。边界故障不得变成截断定论；但缺失深度 + 回显未取得
  // 也不足以给出 pass，须诚实降为不可判定。
  const nonceOf = (prompt: string): string =>
    prompt.match(/编号([A-Z0-9]{6})/)?.[1] ?? prompt.match(/record ([A-Z0-9]{6})/)?.[1] ?? prompt.match(/结尾核对 ([A-Z0-9]{6})/)?.[1] ?? 'ZZZZZZ';
  let calls = 0;
  const client: OpenAIClient = {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(req: ChatRequest): Promise<ChatResult> {
      calls += 1;
      if (calls > 13) return failResult(0, 'network：fetch failed');
      const last = req.messages[req.messages.length - 1];
      const prompt = typeof last?.content === 'string' ? last.content : '';
      return hitResult(nonceOf(prompt));
    },
  };
  const outcome = await probeContext(makeCtx(client, true));
  assert.equal(outcome.status, 'insufficient', `缺失深度不得凭其余深度判 pass：${outcome.headline}`);
  assert.equal(outcome.score, null);
  assert.equal(outcome.level, 'unknown');
  assert.match(String(outcome.metrics['boundary'] ?? ''), /errored=1/);
  assert.ok(!outcome.findings.some((f) => f.level === 'fail'), JSON.stringify(outcome.findings));
  assert.match(outcome.headline, /结尾回显未取得/);
  assert.ok(outcome.findings.some((f) => /边界扫描.*传输\/协议故障/.test(f.message)));
});

test('context --deep: 边界扫描前一步定界、后一步 starved → 已得边界作废，不判截断', async () => {
  // 二分扫描中途遇推理占满预算：该点无正文可判，二分前提被破坏；
  // 若只记 starvedSeen 而不清空 foundAtTokens，会把未经完整确认的旧边界当成截断定论。
  const starved = (): ChatResult => ({ ...hitResult(''), finishReason: 'length' });
  const { client } = scriptedContextClient((index) => {
    if (index >= 20 && index <= 25) return 'miss'; // 第一步 16000：主样本 + 4 发确认全 miss → 定界
    if (index === 28 || index === 29) return starved(); // 第三步 12000：首查 + 升预算重试均 starved，终止扫描
    return 'hit';
  }, 'auto');
  const outcome = await probeContext(makeCtx(client, true));
  assert.equal(outcome.level, 'pass', `starved 终止扫描后不得保留旧边界：${outcome.headline}`);
  assert.equal(outcome.score, 100);
  assert.match(String(outcome.metrics['boundary'] ?? ''), /found=n\/a/);
  assert.match(String(outcome.metrics['boundary'] ?? ''), /starved=true/);
  assert.match(String(outcome.metrics['boundary'] ?? ''), /errored=0/);
  assert.ok(outcome.findings.some((f) => /边界扫描存在推理占满预算样本/.test(f.message)), JSON.stringify(outcome.findings));
  assert.ok(!outcome.findings.some((f) => f.level === 'fail'), JSON.stringify(outcome.findings));
});

test('context --deep: 边界定界至少需要同尺寸三点一致 miss（主样本+双needle确认①+确认②）', async () => {
  // 双审必修项 1（2026-10-17 终轮裁决）：原确认链只需「主样本 miss + 确认① miss」即记 foundAt，
  // 对同尺寸注意力衰减/结构相关偶发漏回显仍有诬告通道 → 增加第二发确认样本，三点一致才定界；
  // 任一确认命中 → 视为噪声（lo=mid，不记边界）。边界采样为双 needle（文档开头+结尾），全 miss 扣任一 needle。
  const nonceOf = (prompt: string): string =>
    prompt.match(/编号([A-Z0-9]{6})/)?.[1] ?? prompt.match(/record ([A-Z0-9]{6})/)?.[1] ?? prompt.match(/结尾核对 ([A-Z0-9]{6})/)?.[1] ?? 'ZZZZZZ';
  let calls = 0;
  const client: OpenAIClient = {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(req: ChatRequest): Promise<ChatResult> {
      calls += 1;
      const last = req.messages[req.messages.length - 1];
      const prompt = typeof last?.content === 'string' ? last.content : '';
      // --deep：20 needle + echo = 21 全部命中；之后进入边界扫描。
      // 第一个中点（mid=16000）：主样本(22)+确认①(23) miss，确认②(24) 命中 → 不定界（噪声）；
      // 区间收敛到 [16000,32000]，mid=24000：主样本(25)+确认①(26) miss，确认②(27) 命中 → 也不定界。
      if (calls <= 21) return hitResult(nonceOf(prompt));
      if (calls % 3 === 0) return hitResult(nonceOf(prompt));
      return hitResult('未找到');
    },
  };
  const outcome = await probeContext(makeCtx(client, true));
  assert.equal(outcome.level, 'pass', `两发 miss + 一发命中不得定界截断：${outcome.headline}`);
  assert.match(String(outcome.metrics['boundary'] ?? ''), /found=n\/a/);
});

test('context --deep: 边界三点一致 miss → 确认定界（foundAtTokens 记录）', async () => {
  // 双审必修项 1 的通过侧：确认链必须仍能在稳定失败点成立（加确认样本不得漏检真截断）。
  const nonceOf = (prompt: string): string =>
    prompt.match(/编号([A-Z0-9]{6})/)?.[1] ?? prompt.match(/record ([A-Z0-9]{6})/)?.[1] ?? prompt.match(/结尾核对 ([A-Z0-9]{6})/)?.[1] ?? 'ZZZZZZ';
  let calls = 0;
  const client: OpenAIClient = {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(req: ChatRequest): Promise<ChatResult> {
      calls += 1;
      const last = req.messages[req.messages.length - 1];
      const prompt = typeof last?.content === 'string' ? last.content : '';
      if (calls <= 21) return hitResult(nonceOf(prompt));
      return hitResult('未找到');
    },
  };
  const outcome = await probeContext(makeCtx(client, true));
  assert.equal(outcome.level, 'fail', `三点一致 miss 构成边界证据：${outcome.headline}`);
  // 三步二分全 miss 收敛：16000 → 8000 → 4000，foundAt 取最后一个稳定失败点
  assert.match(String(outcome.metrics['boundary'] ?? ''), /found=4000/);
});

test('context --deep: 确认样本遇尺寸类 400 → 不得与主样本 miss 混构「确认截断」（拒绝类证据不入定罪链）', async () => {
  // 双审必修项 1 后半：拒绝类证据与「正文未命中」是两类事由——确认链任一发为尺寸类 400 时只收敛区间，
  // 不记 foundAt；是否定罪走 needle 阶段的差分验证口径（400 全样本 + 前沿 + 差分）。
  const nonceOf = (prompt: string): string =>
    prompt.match(/编号([A-Z0-9]{6})/)?.[1] ?? prompt.match(/record ([A-Z0-9]{6})/)?.[1] ?? prompt.match(/结尾核对 ([A-Z0-9]{6})/)?.[1] ?? 'ZZZZZZ';
  let calls = 0;
  const client: OpenAIClient = {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(req: ChatRequest): Promise<ChatResult> {
      calls += 1;
      const last = req.messages[req.messages.length - 1];
      const prompt = typeof last?.content === 'string' ? last.content : '';
      if (calls <= 21) return hitResult(nonceOf(prompt));
      // 边界第一中点（mid=16000）：主样本(22) miss，确认①(23) 尺寸类 400 → 只收敛区间（hi=16000）
      if (calls === 23) return failResult(400, 'HTTP 400 max context length exceeded');
      // 此后 mid=8000：主样本(24)+确认①(25)+确认②(26) 全命中 → lo=8000；mid=12000(27) 命中 → 无定界
      return hitResult(nonceOf(prompt));
    },
  };
  const outcome = await probeContext(makeCtx(client, true));
  assert.equal(outcome.level, 'pass', `确认样本尺寸类 400 不得混构截断定论：${outcome.headline}`);
  assert.match(String(outcome.metrics['boundary'] ?? ''), /sizeReject=1/);
  assert.ok(outcome.findings.some((f) => f.level === 'info' && /尺寸类 400 拒绝/.test(f.message)), JSON.stringify(outcome.findings));
});

test('context: 结尾回显传输故障 + 稀疏高深度 miss → warn 55（不得输出「全部命中」的 pass）', async () => {
  // 2026-10-17 调试实证的标题不一致缺陷：0.75 档 3/4 + echo 传输故障时，
  // 「echo 故障仅披露」分支抢先 return pass，标题声称 needle 全部命中与 depth_hits 计数矛盾。
  const nonceOf = (prompt: string): string =>
    prompt.match(/编号([A-Z0-9]{6})/)?.[1] ?? prompt.match(/record ([A-Z0-9]{6})/)?.[1] ?? prompt.match(/结尾核对 ([A-Z0-9]{6})/)?.[1] ?? 'ZZZZZZ';
  let needleIndex = 0;
  const client: OpenAIClient = {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(req: ChatRequest): Promise<ChatResult> {
      const last = req.messages[req.messages.length - 1];
      const prompt = typeof last?.content === 'string' ? last.content : '';
      const isEcho = prompt.includes('结尾核对');
      if (isEcho) return failResult(0, 'network：fetch failed');
      needleIndex += 1;
      // 0.75 档第 4 个样本（needleIndex 14）未命中，其余全命中
      return needleIndex === 14 ? hitResult('未找到') : hitResult(nonceOf(prompt));
    },
  };
  const outcome = await probeContext(makeCtx(client, true));
  assert.equal(outcome.level, 'warn', `存在未命中时不得判 pass：${outcome.headline}`);
  assert.equal(outcome.score, 55);
});


test('context: 默认低成本档 4 个空响应 → insufficient/unknown，不计未命中、不判 fail、不再发 90% 回显', async () => {
  // 2026-10-18 真机回归：中转站返回 HTTP 200 空流时，旧实现把空响应当 needle 未命中，
  // 12 发全空后仍发 90% 回显并判「窗口不实」。空响应没有答案可判，必须剔除分母。
  const { client, requests } = scriptedContextClient(() => hitResult(''), 'auto');
  const ctx = makeCtx(client);
  ctx.cfg.contextSamples = 1;
  const outcome = await probeContext(ctx);
  assert.equal(outcome.status, 'insufficient');
  assert.equal(outcome.level, 'unknown');
  assert.equal(outcome.score, null);
  assert.equal(outcome.metrics['empty_samples'], 4);
  assert.equal(requests.length, 4, '无有效样本时不得再发 90% 结尾回显');
  assert.match(outcome.headline, /空响应/);
  assert.ok(!outcome.findings.some((f) => f.level === 'fail'), JSON.stringify(outcome.findings));
  assert.ok(outcome.findings.some((f) => /空文本.*剔除/.test(f.message)), JSON.stringify(outcome.findings));
});
test('context: 部分深度空响应且仅一档命中 → insufficient（不得 100 pass，且不再发 90% 回显）', async () => {
  // 2026-10-18 真机回归：0.25/0.9 档空响应、仅 0.5/0.75 档命中时，
  // 旧实现因「无未命中」直接走 pass 100，并宣称「needle 全部命中」。
  const { client, requests } = scriptedContextClient((index) => (index === 1 || index === 2 ? 'hit' : hitResult('')), 'auto');
  const ctx = makeCtx(client);
  ctx.cfg.contextSamples = 1;
  const outcome = await probeContext(ctx);
  assert.equal(outcome.status, 'insufficient');
  assert.equal(outcome.score, null);
  assert.equal(outcome.level, 'unknown');
  assert.equal(outcome.metrics['missing_depths'], '25%,90%');
  assert.match(outcome.headline, /仅在 2\/4 个深度获得有效样本/);
  assert.equal(requests.length, 4, '覆盖不全时不得再发 90% 结尾回显');
  assert.ok(!outcome.findings.some((f) => f.level === 'fail'), JSON.stringify(outcome.findings));
});

test('context --deep: 部分深度全空 + 结尾回显空响应 → insufficient（不得凭其余深度 pass 100）', async () => {
  // --deep 跳过「每档有效样本覆盖」提前返回（边界扫描可能补正证据）；但回显同样未取得时，
  // 缺失深度没有任何可读性证据，不能宣称标称窗口通过。
  const nonceOf = (prompt: string): string =>
    prompt.match(/编号([A-Z0-9]{6})/)?.[1] ?? prompt.match(/record ([A-Z0-9]{6})/)?.[1] ?? 'ZZZZZZ';
  let call = 0;
  const client: OpenAIClient = {
    baseUrl: 'http://127.0.0.1:0/v1',
    async chat(req: ChatRequest): Promise<ChatResult> {
      const last = req.messages[req.messages.length - 1];
      const prompt = typeof last?.content === 'string' ? last.content : '';
      if (prompt.includes('结尾核对')) return hitResult('');
      const index = call;
      call += 1;
      // --deep 每档 5 样本：0..4=25%、5..9=50%、10..14=75%、15..19=90%；20 起为边界扫描
      if (index < 10 || index >= 20) return hitResult(nonceOf(prompt));
      return hitResult('');
    },
  };
  const outcome = await probeContext(makeCtx(client, true));
  assert.equal(outcome.status, 'insufficient', outcome.headline);
  assert.equal(outcome.score, null);
  assert.equal(outcome.level, 'unknown');
  assert.equal(outcome.metrics['missing_depths'], '75%,90%');
  assert.match(outcome.headline, /结尾回显未取得/);
  assert.equal(call, 26, '边界扫描 3 步 × 2 位置应全部读取，且结论应为证据不足');
});

test('context: 低成本 1 样本档的未命中只报疑似 warn，不直接判 fail', async () => {
  // 每档 1 样本时，低深度 0/1 + 高深度未命中曾被直接判「窗口不实」（10 分 fail）。
  // 单样本未命中是注意力噪声的高发区：低成本档只作筛查，定论必须 --context-samples 3/--deep。
  const { client } = scriptedContextClient((index) => (index === 0 || index === 2 ? 'miss' : 'hit'), 'hit');
  const ctx = makeCtx(client);
  ctx.cfg.contextSamples = 1;
  const outcome = await probeContext(ctx);
  assert.equal(outcome.level, 'warn');
  assert.equal(outcome.score, 55);
  assert.match(outcome.headline, /初步筛查/);
  assert.match(outcome.headline, /--context-samples 3 或 --deep/);
  assert.ok(!outcome.findings.some((f) => f.level === 'fail'), JSON.stringify(outcome.findings));
});