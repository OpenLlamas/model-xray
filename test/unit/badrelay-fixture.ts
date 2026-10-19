/**
 * badrelay 标定台：把「坏中转站」的可调参行为固化为检出矩阵。
 *
 * 背景（chroe.md 优化 + 2026-10-19 会话）：各维度的单项 e2e 已覆盖常规作弊模式，
 * 本标定台的增量价值是把多个作弊旋钮**同时**打开的组合坏中转（真实世界的中转站
 * 往往同时虚增 usage + 偷换型号 + 截断上下文），并逐维度断言检出等级：
 * 通过 runAudit 直连（不走 CLI 子进程），每个场景一次完整审计。
 *
 * 矩阵契约（不诬告优先于不漏报，与既定口径一致）：
 * - honest          → 全维度 pass/ok，overall pass；
 * - usage-scale 1.3 → billing warn（输出侧 ratio 1.5 越线），quality/identity 不受牵连；
 * - relabel         → identity fail 0（族不匹配为定论级证据）；
 * - truncate 7000   → context warn（非 --deep 仅统计信号，不指控）；
 * - retry-fix 12    → quality warn 80（首答 0/12，复采样洗白封顶）；
 * - persona-inject  → identity warn 80（人格污染，不足以定论）；
 * - 组合（usage-scale×relabel×truncate）→ billing pass 85（截断抵消了输出侧 ratio 信号的
 *   真实遮蔽：正文被截 7000 后 visible 下降，ratio 0.733 落入正常带；shape-only 契约下不定论，
 *   但必须披露「全量等比缩放不可见 + 未做绝对对账」——测试断言披露存在，不是默认无监督放行）、
 *   identity fail、context warn。
 */
import { runAudit } from '../../src/runner.js';
import { createMockServer, type MockOptions, type MockServer } from '../mock-server.js';
import type { AuditReport, ProbeId, RunConfig } from '../../src/types.js';

export type BadRelayScenario = {
  name: string;
  mock: MockOptions;
  overrides: Partial<RunConfig>;
  /** 期望检出等级：pass | warn | fail | （其余维度不断言） */
  expect: Partial<Record<ProbeId | 'overall', 'pass' | 'warn' | 'fail'>>;
};

export const BADRELAY_MATRIX: readonly BadRelayScenario[] = [
  {
    name: 'honest',
    mock: { mode: 'honest', balanceRate: 1, priceInput: 2, priceOutput: 8 },
    overrides: { claimedContext: 8000 },
    expect: { identity: 'pass', billing: 'pass', context: 'pass', quality: 'pass', overall: 'pass' },
  },
  {
    name: 'usage-scale-1.3',
    mock: { mode: 'usage-scale', usageScale: 1.3, priceInput: 2, priceOutput: 8, balanceRate: 1 },
    overrides: { claimedContext: 8000 },
    expect: { billing: 'warn', identity: 'pass', quality: 'pass' },
  },
  {
    name: 'relabel',
    mock: { mode: 'relabel', identityName: 'glm-5.3-flash' },
    overrides: { claimedContext: 8000 },
    expect: { identity: 'fail', billing: 'pass' },
  },
  {
    name: 'persona-inject',
    mock: { mode: 'persona-inject', identityName: 'gpt-4o' },
    overrides: { claimedContext: 8000 },
    expect: { identity: 'warn' },
  },
  {
    name: 'truncate-7000',
    mock: { mode: 'truncate', truncateTokens: 7000 },
    overrides: { claimedContext: 32000 },
    expect: { context: 'warn' },
  },
  {
    name: 'retry-fix-12',
    mock: { mode: 'retry-fix', retryFixPerturb: 12 },
    overrides: { claimedContext: 8000 },
    expect: { quality: 'warn' },
  },
  {
    name: 'combined-usage-relabel-truncate',
    // 组合旋钮（与 mode 正交）：usage 虚增 ×1.3 + identity 自述换族 + 静默截断 7000 tokens 同时打开
    mock: { mode: 'honest', scaleUsage: 1.3, retellAs: 'glm-5.3-flash', truncateAtTokens: 7000 },
    overrides: { claimedContext: 32000 },
    expect: { billing: 'pass', identity: 'fail', context: 'warn' },
  },
];

export async function createBadRelay(scenario: BadRelayScenario): Promise<MockServer> {
  return createMockServer(scenario.mock);
}

export function levelOf(report: AuditReport, id: ProbeId | 'overall'): string | null {
  if (id === 'overall') return report.overall;
  return report.outcomes.find((o) => o.id === id)?.level ?? null;
}

export async function auditScenario(scenario: BadRelayScenario): Promise<AuditReport> {
  const mock = await createBadRelay(scenario);
  try {
    return await runAudit(
      {
        baseUrl: mock.baseUrl,
        apiKey: 'test-key',
        model: 'gpt-4o',
        claimedContext: null,
        expect: ['vision', 'tool'],
        deep: false,
        seed: 20261019,
        timeoutMs: 20000,
        retries: 1,
        outDir: 'reports',
        html: false,
        yes: true,
        quiet: true,
        ...scenario.overrides,
      },
    );
  } finally {
    mock.server.close();
  }
}