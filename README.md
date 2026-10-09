# model-xray

**X-ray your LLM endpoints. One command, one report.**

[English](#english) | [中文](#中文)

---

## English

`model-xray` is an open CLI that audits OpenAI-compatible LLM endpoints for **fake or watered-down models** — a widespread problem behind third-party relay/proxy stations. It never asks you to trust a vendor's word: it probes the endpoint empirically and produces a shareable pass/fail report.

```bash
npx model-xray test \
  --base-url https://your-relay.example.com/v1 \
  --key sk-... \
  --model claude-sonnet-4-5
```

One command → one markdown report: red/green table, verdict, raw evidence.

### What it checks

| Check | What it does |
|---|---|
| Identity & fingerprint | Self-ID questions and behavioral fingerprints catch relabeled/guardrail-swapped models (e.g.自称 Claude 却答 "我是 GLM") |
| Context length (needle test) | Bursts needles at claim-depth to verify the advertised window is real, not truncated silently |
| Token counting | Compares endpoint usage tokens against official tokenizer counts, exposing padded billing |
| Measured rate (balance delta) | Snapshots the billing balance before/after the billing series; Δspend ÷ expected cost (claimed price × self-reported usage) reveals the real multiplier behind "cheap" sticker prices |
| Fingerprint baseline | Saves/compares a versioned baseline (model family, quality, capability, billing slopes) across runs to catch silent model swaps |
| Capability gates | vision / tool-calling / thinking flags actually exercised, not just advertised |
| Fixed question bank | A versioned, reproducible set scored against reference answers for quality drift |
| Streaming first-token latency | p50/p95 TTFT sampled under load, useful for spotting "queue-stretched" relays |

### Key options

| Flag | Meaning |
|---|---|
| `--price-input <n>` / `--price-output <n>` | Claimed price per 1M tokens, must appear as a pair; enables the measured-rate probe |
| `--baseline <path>` | Compare fingerprints against a baseline file; its seed is reused unless `--seed` is explicit |
| `--baseline-out <path>` | Write this run's baseline file (defaults to `reports/baseline-<stamp>.json`) |

### Boundaries & caveats

- **Same unit required.** The claimed price and the endpoint's displayed balance must share one unit (USD or quota); the tool only computes the ratio and never converts units.
- **No concurrent traffic.** During the measured-rate window, keep the audited key idle — parallel requests inflate Δspend and bias the ratio upward (per-request attribution lands with the planned P2 proxy mode).
- **Recharge interference.** A top-up between the two balance reads voids the measurement (Δ<0 is discarded); a recharge concurrent with spend is undetectable in P1 — cross-check the station's billing log manually when in doubt.
- **Same-origin assumption.** The two balance reads assume the relay routes them to the same backend and returns fresh (non-cached) values; multi-backend gateways or cached balances can distort Δ.
- **Heuristic thresholds.** Drift thresholds (quality 15%/30%, billing slope 0.05/20%, rate 0.5–1.1–1.5) are versioned heuristic initial values so reports stay comparable across versions.
- **Baseline seed reuse.** `--baseline` reuses the baseline's seed to keep the question set fixed — a relay could theoretically special-case seeded probes; the trade-off is disclosed by design.
- **Baseline format.** Baseline files are `version: 1` only; mismatched versions/models/probeset versions skip comparison with a note. A baseline holds aggregate fingerprints only (model families, accuracy, capability flags, billing slopes, seed) — never API keys, prompts, or balance values.

### Principles

- **Platform-agnostic.** The tool has no "our own station" to favor. If you operate an endpoint, publish your own reports and let others verify — the credibility comes from third parties running the same command, not from shipped rankings.
- **No leaderboard.** Maintainers publish reports, not rankings, to keep the tool out of "hit piece" territory.
- **Evidence over verdicts.** Every finding links to raw request/response transcripts in the report.
- **Versioned test sets.** Question banks and needles carry versions so a report is reproducible.

### Web shell (static, offline)

`npm run web`, then open <http://127.0.0.1:8619> — a purely static, local-only shell with two tabs:

1. **Build command** — a form that assembles the `model-xray test …` command for you to copy into a terminal. Your API key is **not** part of the command: set it in the terminal via the `MODEL_XRAY_KEY` environment variable (the page prints the exact `export` / `$env:` line for bash and PowerShell).
2. **Render report** — paste a locally generated `report-*.json` to view its scorecard. Parsing happens entirely in your browser.

Notes:

- The page makes **zero network requests** and uses **no storage** (no localStorage / cookies); the key enters through your terminal's environment variable, never through the page.
- The generated command quotes arguments with single quotes, which `cmd.exe` does not support — run it in **PowerShell** or **bash/zsh**. Values containing a single quote or control characters are rejected with an error instead of being quoted, because shell quoting rules differ.

### Status

Work in progress. This repository will host the CLI, the versioned test assets, and the maintainers' own published reports (`reports/`).

## 中文

`model-xray` 是一个开源 CLI，用实证手段检测兼容 OpenAI 协议的 LLM 接入点是否存在**模型真伪 / 掺水**问题（换壳、降智、截断上下文、虚标 token 计数等中转站常见套路）。它不要求你相信任何厂商的话：直接探测端点行为，产出可分享的红绿报告。

```bash
npx model-xray test \
  --base-url https://your-relay.example.com/v1 \
  --key sk-... \
  --model claude-sonnet-4-5
```

一条命令 → 一份 markdown 报告：红绿表格、结论、原始证据。

### 检测项

| 检测项 | 做法 |
|---|---|
| 身份与指纹 | 自我身份问答 + 行为指纹，识破换标签/换护栏的"套皮"模型（如自称 Claude 却答"我是 GLM"） |
| 上下文长度实测 | 在标称深度埋 needle，验证标称窗口是真实的，而非静默截断 |
| Token 计数对比 | 端点返回的 usage token 与官方 tokenizer 实算对比，暴露虚增计费 |
| 实测倍率（余额差值法） | 计费序列前后各查一次余额，Δ扣费 ÷（宣称价格 × 端点自报 usage）的应缴金额，揭示"低价"背后的真实倍率 |
| 指纹基线对比 | 保存/对比版本化指纹基线（模型族、质量、能力、计费斜率），识别两次检测之间模型被偷换 |
| 能力校验 | vision / tool calling / thinking 标称能力逐项实测，而非只看宣称 |
| 固定题集质量打分 | 版本化可复现题集，对照参考答案量化质量（降智检测） |
| 流式首字延迟 | 采样 p50/p95 TTFT，识别"排队拉长"型中转 |

### 关键参数

| 参数 | 说明 |
|---|---|
| `--price-input <n>` / `--price-output <n>` | 每百万 tokens 的宣称价格，必须成对出现；启用实测倍率探针 |
| `--baseline <path>` | 与基线文件做指纹对比；未显式给 `--seed` 时沿用基线 seed |
| `--baseline-out <path>` | 落盘本轮基线（缺省写到 `reports/baseline-<stamp>.json`） |

### 边界与注意

- **单位必须一致。** 宣称价格与该站余额显示单位须一致（美元/quota 均可），工具只算比值，不做单位换算。
- **勿有并发流量。** 实测倍率审计窗口内，被测 key 不要跑其他请求——并发消费会抬高 Δ扣费、使倍率偏高估（按请求归因将在 P2 代理模式解决）。
- **充值干扰。** 两次余额查询之间发生充值会使测量作废（Δ<0 直接判无效）；充值与消费叠加的场景 P1 无法识别，存疑时请人工核对该站账单流水。
- **同源假设。** 两次余额读数假定中转站路由到同一后端且返回非缓存值；多后端网关或余额缓存可能使 Δ失真。
- **阈值为启发式初值。** 漂移阈值（质量 15%/30%、计费斜率 0.05/20%、倍率 0.5–1.1–1.5）随题集版本化管理，保证跨版本报告可比。
- **基线沿用 seed。** `--baseline` 会沿用基线 seed 固定题集——端点理论上可对固定 seed 特判，该权衡在此明示。
- **基线格式。** 基线文件仅支持 `version: 1`；版本/模型/题集版本不符时跳过对比并给出提示。基线只含聚合指纹字段（模型族、正确率、能力布尔、计费斜率、seed）——不含 API key、提示词原文或余额数值。

### 原则

- **对所有平台一视同仁。** 工具自身没有"自营站点"立场。若你是接入点运营方，请发布自己的检测报告并接受任何人复测——公信力来自第三方跑同一条命令，而不是自带榜单。
- **不做排行榜。** 官方只发布报告不排名次，避免黑稿嫌疑。
- **证据优先。** 每条结论都附原始请求/响应记录链接。
- **题集版本化。** 题库与 needle 均带版本号，报告可复现可追溯。

### Web 壳（纯静态、纯本地）

`npm run web` 然后打开 <http://127.0.0.1:8619> —— 一个纯静态轻壳，两个标签页：

1. **生成命令** —— 表单帮你拼好 `model-xray test …` 命令，复制到终端执行。key **不会**出现在命令里：在终端用环境变量 `MODEL_XRAY_KEY` 设置（页面会给出 bash 与 PowerShell 两种写法）。
2. **渲染报告** —— 粘贴本地生成的 `report-*.json` 即可渲染评分卡，解析完全发生在浏览器本地。

注意：

- 页面零网络请求、零存储（无 localStorage / cookie）；key 通过终端环境变量进入，不经过页面。
- 生成的命令使用单引号包裹参数，`cmd.exe` 不支持单引号——请在 **PowerShell** 或 **bash/zsh** 中执行。含单引号或换行等控制字符的参数值会被直接拒绝并报错（各 shell 转义规则不一致，宁可拒绝也不产出会被静默损坏的命令）。

### 状态

开发中。本仓库将承载 CLI、版本化测试资产，以及官方自己的公开报告（`reports/`）。

## License

MIT