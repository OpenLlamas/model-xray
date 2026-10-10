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

Exit codes: 0 = pass/warn; 1 = fail; 2 = argument error or inconclusive (insufficient scorable items).

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
| `--yes` | Skip the interactive token-cost confirmation on remote endpoints (required in scripts / non-TTY) |
| `--dry-run` | Print the planned requests and token estimate, then exit without sending anything |

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

### Guard: local always-on monitor (P2)

`model-xray guard` runs a transparent local forwarding proxy that watches **real traffic** instead of firing one-shot probes:

```bash
# PowerShell: set the key via environment variable (guard has no --key flag, so the key never enters shell history)
$env:MODEL_XRAY_KEY = 'sk-xxx'
model-xray guard --base-url https://your-relay.example.com/v1 \
  --price-input 2 --price-output 8 --reconcile-minutes 15 --out reports/guard
```

Point your client's `base-url` at `http://127.0.0.1:8621/v1` (any local client works; the client-side API key must equal `MODEL_XRAY_KEY` — mismatched requests are rejected with 401 and never forwarded). Path semantics: the incoming request path is appended to `--base-url` as-is, and a repeat of the full `--base-url` path prefix (e.g. `/v1` in both) is deduplicated automatically — so `--base-url` may or may not include `/v1` (if a station genuinely serves a doubled prefix like `/v1/v1`, point `--base-url` at the site root). `--base-url` must not carry a query string or fragment.

What it watches per request:

- **Model consistency** — request `model` vs the model the endpoint actually answers with; a mismatch alerts immediately (`model_mismatch`).
- **Token accounting** — SSE/JSON responses are parsed for `usage` (bytes pass through untouched); negative or inconsistent token counts raise `usage_invalid`.
- **Rolling billing reconciliation** — with claimed prices given, the balance is sampled at window boundaries: Δspend ÷ expected cost = measured rate. Rate > 1.5 alerts as fail; outside the drift band (|ratio−1| > 0.05 and > 0.2) warns; a top-up during the window (`Δ<0`) voids the window (`skipped_recharge`) instead of producing a bogus ratio.
- **JSONL audit log** — one line per request plus reconcile/anomaly/fingerprint/score events under `--out` (default `reports/guard`), rotated daily. **Metadata only**: no conversation content, no credentials, no upstream error bodies, no query strings — verified by dedicated redaction tests.
- **Truncation / disconnects** — `finish_reason=length` is recorded; client disconnects mid-stream mark the request `aborted`.
- **Live scorecard** — every 20 forwarded requests a one-line multi-dimension score is printed (availability / usage accounting / identity / latency / cost), plus a final card on exit; rolling window = last 100 forwarded requests (locally rejected 401/403 never enter the window); the `观测` (observed) counters — truncation rate / missing usage / aborts — are informational and never affect the grade; with tiny windows a single request can pull the overall grade red, which is normal jitter.

Optional: `--fingerprint-minutes 60` re-runs the identity-family probe periodically and alerts when the model-family fingerprint drifts (the probe sends real requests and costs real money — off by default).

Boundaries: only `chat/completions`, `completions`, and `embeddings` get deep inspection; other paths are forwarded untouched with a basic log line. HTTP/1.1 only; upstream responses are requested with `Accept-Encoding: identity` on deep-inspected endpoints (the only byte-level rewrite besides credential replacement). The balance probe polls the one-api style usage endpoint (its `total_usage` is read as ÷100); stations without such an endpoint degrade reconciliation to token-only stats with a `skipped` note. Local auth uses a constant-time comparison; `Ctrl+C` (or closing stdin) stops guard and settles the final window before flush.

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

退出码：0=通过/可疑；1=不通过；2=参数错误或未能得出结论（可评分项不足）。

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
| `--yes` | 跳过远程端点的交互式成本确认（脚本/非 TTY 环境必需） |
| `--dry-run` | 只打印计划请求量与 token 预估，不发任何请求 |

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

### Guard：本地常驻监控（P2）

`model-xray guard` 启动一个本地透明转发代理，盯**真实流量**而不是一次性探测：

```powershell
# PowerShell：key 走环境变量（guard 不提供 --key 旗标，key 永不进入命令行历史）
$env:MODEL_XRAY_KEY = 'sk-xxx'
model-xray guard --base-url https://your-relay.example.com/v1 `
  --price-input 2 --price-output 8 --reconcile-minutes 15 --out reports/guard
```

把客户端的 `base-url` 改成 `http://127.0.0.1:8621/v1`（本地任意客户端均可；客户端侧 API key 须与 `MODEL_XRAY_KEY` 一致，不一致的请求直接 401、绝不转发）。路径语义：请求路径原样拼接到 `--base-url` 之后；与 `--base-url` 完整路径前缀重复的部分（如都带 `/v1`）会自动去重——`--base-url` 带不带 `/v1` 均可（若站点确有 `/v1/v1` 类双前缀路由，请把 `--base-url` 设为站点根）。`--base-url` 不得携带 query 或 fragment。

逐请求盯什么：

- **模型一致性** —— 请求的 `model` 与端点实际应答的模型不一致，立即告警（`model_mismatch`）。
- **Token 记账** —— 解析 SSE/JSON 响应里的 `usage`（字节原样透传）；token 为负或分项对不上报 `usage_invalid`。
- **滚动对账** —— 提供宣称价格后，窗口首尾各查一次余额：Δ扣费 ÷ 应缴金额 = 实测倍率。倍率 > 1.5 按 fail 告警；超出漂移带宽（|ratio−1| > 0.05 且 > 0.2）按 warn 告警；窗口内充值（Δ<0）作废该窗口（`skipped_recharge`），不出假倍率。
- **JSONL 审计日志** —— 每请求一行，外加 reconcile/anomaly/fingerprint/score 事件，写入 `--out`（默认 `reports/guard`）并按日轮转。**只记元数据**：无对话内容、无凭证、无上游错误体、无 query——有专门的脱敏测试钉死这条红线。
- **截断与断连** —— `finish_reason=length` 记录在案；客户端流中断开标记 `aborted`。
- **实时评分卡** —— 每 20 个已转发请求输出一次多维单行评分（可用性/计量/身份/时延/成本），退出时无论计数再输出一张终卡；滚动窗口为最近 100 个已转发请求（本地 401/403 拒绝的请求不转发、不入窗）；「观测」项（截断率/缺用量/中止）仅记录不计总评；小样本（窗口内请求很少时）单笔异常即可拉红总评，属正常抖动。

可选：`--fingerprint-minutes 60` 周期性复跑身份族指纹探针，模型族漂移即告警（探针发真实请求、产生真实计费——默认关闭）。

边界：只有 `chat/completions`、`completions`、`embeddings` 做深检，其余路径原样转发并记基础行；仅支持 HTTP/1.1；深检端点会强制 `Accept-Encoding: identity`（除凭证替换外唯一的字节级改写）。余额探针按 one-api 风格 usage 接口读取（`total_usage` 按 ÷100 折算），站点没有该接口时对账降级为纯 token 统计并出 `skipped` 提示。本地鉴权用常量时间比较；`Ctrl+C`（或关闭 stdin）停止时先结算最后一个对账窗口再落盘。

### 状态

开发中。本仓库将承载 CLI、版本化测试资产，以及官方自己的公开报告（`reports/`）。

## License

MIT