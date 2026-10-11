# model-xray

**X-ray your LLM endpoints. One command, one report.**

`model-xray` is an open CLI that audits OpenAI-compatible LLM endpoints for **fake or watered-down models** — relabeled models, quietly shortened context, padded token billing, inflated latency. It never asks you to trust a vendor's word: it probes the endpoint empirically and produces a shareable red/green report.

[English](#english) | [中文](#中文)

---

## English

### Quick start (from source, ~5 min)

Requires **Node.js ≥ 22** (`node --version` to check).

```bash
git clone https://github.com/OpenLlamas/model-xray.git
cd model-xray
npm install
npm run build
npm link          # optional but recommended: gives you the short `model-xray` command
```

Set your API key once — both `test` and `guard` read it; the key never enters the command line or shell history:

```powershell
# PowerShell
$env:MODEL_XRAY_KEY = 'sk-your-key'
```

```bash
# bash / zsh
export MODEL_XRAY_KEY='sk-your-key'
```

Run a one-shot audit:

```bash
model-xray test \
  --base-url https://your-relay.example.com/v1 \
  --model gpt-4o \
  --yes
```

If you skipped `npm link` (or npm refused due to permissions), replace `model-xray` with `node dist/src/cli.js` everywhere.

The report lands in `reports/` as three files sharing one timestamp: `report-<stamp>.md` (read this one), `report-<stamp>.html` (open in a browser), `report-<stamp>.json` (raw evidence). Exit code: `0` pass/warn · `1` fail · `2` usage error.

### Common tasks

**1) Audit a station once** — the command above. Add whatever you know about the station; unknown extras are simply skipped:

| You know | Add to the command |
|---|---|
| advertised context window (e.g. 128000) | `--claimed-context 128000` — enables the needle test |
| advertised capabilities | `--expect vision,tool,thinking` (default `vision,tool`; use `--expect none` if none claimed) |
| advertised price per 1M tokens | `--price-input 0.2 --price-output 0.7` — enables the measured-rate probe |

Preview without spending: add `--dry-run` (it prints the planned requests and token estimate, sends nothing). A full run typically costs a cent or two — ours measured ≈ $0.015 per run at $0.2/$0.7 per 1M tokens.

**2) Re-audit later, or catch a silent model swap** — keep the `baseline-<stamp>.json` written by the first run and pass it back:

```bash
model-xray test --base-url https://your-relay.example.com/v1 --model gpt-4o --yes \
  --baseline reports/baseline-2026-10-11T10-09-23-183Z.json
```

**3) Always-on monitoring (`guard`)** — a local transparent proxy that watches your real client traffic and scores it live:

```powershell
# 1) key via environment variable only (guard has no --key flag by design)
$env:MODEL_XRAY_KEY = 'sk-your-key'
# 2) start the proxy (listens on 127.0.0.1:8621 by default)
model-xray guard --base-url https://your-relay.example.com/v1 `
  --price-input 0.2 --price-output 0.7 --reconcile-minutes 15
# 3) point your client at http://127.0.0.1:8621/v1
#    with the client's API key set to the SAME value as MODEL_XRAY_KEY
```

Keep using your client normally: every 20 forwarded requests prints a live scorecard (availability / accounting / identity / latency / cost; rolling window = last 100 requests), anomalies alert immediately, and everything lands in `reports/guard/guard-YYYYMMDD.jsonl` (metadata only). `Ctrl+C` settles the final window before exit.

**4) View a report in the browser** (nothing leaves your machine):

```bash
npm run web    # open http://127.0.0.1:8619, then paste or drop report-*.json
```

### How to read the result

- **Verdict** (also the exit code): 通过 pass (0) · 可疑 warn (0) · 不通过 fail (1) · usage error (2).
- Dimensions without enough evidence are marked `N/A` and excluded from scoring — never counted as 0.
- **Scoring**: a weighted geometric total (0–100): billing 25 / quality 25 / identity 15 / context 15 / capability 10 / TTFT 10. Any dimension at `fail`, or a total < 40 → overall fail. Billing / capability / context / quality below 40 hit a **hard red line** (total capped at 45). Total < 75 or any warn dimension → 可疑 (warn).
- Every finding links to the raw request/response evidence in the report.

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
| `--key <key>` | API key; alternatively set `MODEL_XRAY_KEY` / `OPENAI_API_KEY` (recommended: keeps the key out of shell history; guard only supports the env var) |
| `--claimed-context <n>` | Advertised context window; enables the needle test |
| `--expect <list>` | Claimed capabilities from `vision,tool,thinking` (or `none`; default `vision,tool`) |
| `--price-input <n>` / `--price-output <n>` | Claimed price per 1M tokens, must appear as a pair; enables the measured-rate probe |
| `--baseline <path>` | Compare fingerprints against a baseline file; its seed is reused unless `--seed` is explicit |
| `--baseline-out <path>` | Write this run's baseline file (defaults to `reports/baseline-<stamp>.json`) |
| `--yes` | Skip the interactive token-cost confirmation on remote endpoints (required in scripts / non-TTY) |
| `--dry-run` | Print the planned requests and token estimate, then exit without sending anything |
| `--deep` | More samples per probe (slower, costs more) |
| `--out <dir>` | Report output directory (default `reports`) |

### Troubleshooting

| Symptom | Fix |
|---|---|
| `exit 2` / a cost confirmation appears | add `--yes` (required in scripts, CI, non-TTY terminals) |
| guard: client receives `401` | the client's API key must EXACTLY equal `MODEL_XRAY_KEY`; mismatched requests are rejected locally, never forwarded |
| guard: port already in use | `--port 8622` (default 8621) |
| cost dimension shows `N/A` / `skipped` | the station has no one-api style balance endpoint, or no `--price-input/--price-output` was given — reconciliation degrades to token-only stats, which is normal |
| a capability item fails but the station never claimed it | only put capabilities the station actually advertises into `--expect` (default `vision,tool`); drop the rest or use `--expect none` |
| want a cheaper / faster run | omit `--price-*` and `--claimed-context`; try `--dry-run` first |
| `cmd.exe` rejects a command copied from the web shell | web-shell commands use single quotes — run them in PowerShell or bash |
| build fails / `node` not found | install Node.js ≥ 22 from https://nodejs.org |

### Boundaries & caveats

- **Same unit required.** The claimed price and the endpoint's displayed balance must share one unit (USD or quota); the tool only computes the ratio and never converts units.
- **No concurrent traffic.** During the measured-rate window, keep the audited key idle — parallel requests inflate Δspend and bias the ratio upward. (Under `guard`, all traffic through the proxy is accounted per request, so the caveat shrinks to: don't use the same key outside the proxy.)
- **Recharge interference.** A top-up between the two balance reads voids the measurement (Δ<0 is discarded); a recharge concurrent with spend remains undetectable — cross-check the station's billing log manually when in doubt.
- **Same-origin assumption.** The two balance reads assume the relay routes them to the same backend and returns fresh (non-cached) values; multi-backend gateways or cached balances can distort Δ.
- **Heuristic thresholds.** Drift thresholds (quality 15%/30%, billing slope 0.05/20%, rate 0.5–1.1–1.5) are versioned heuristic initial values so reports stay comparable across versions.
- **Baseline seed reuse.** `--baseline` reuses the baseline's seed to keep the question set fixed — a relay could theoretically special-case seeded probes; the trade-off is disclosed by design.
- **Baseline format.** Baseline files are `version: 1` only; mismatched versions/models/probeset versions skip comparison with a note. A baseline holds aggregate fingerprints only (model families, accuracy, capability flags, billing slopes, seed) — never API keys, prompts, or balance values.

### Principles

- **Platform-agnostic.** The tool has no "our own station" to favor. If you operate an endpoint, publish your own reports and let others verify — the credibility comes from third parties running the same command, not from shipped rankings.
- **No leaderboard.** Maintainers publish reports, not rankings, to keep the tool out of "hit piece" territory.
- **Evidence over verdicts.** Every finding links to raw request/response transcripts in the report.
- **Versioned test sets.** Question banks and needles carry versions so a report is reproducible.

### Guard: local always-on monitor (P2)

`guard` runs a transparent local forwarding proxy that watches **real traffic** instead of firing one-shot probes (startup commands are under "Common tasks" above). What it watches per request:

- **Model consistency** — request `model` vs the model the endpoint actually answers with; a mismatch alerts immediately (`model_mismatch`).
- **Token accounting** — SSE/JSON responses are parsed for `usage` (bytes pass through untouched); negative or inconsistent token counts raise `usage_invalid`. Reported `cached_tokens` / `reasoning_tokens` details are captured when present.
- **Rolling billing reconciliation** — with claimed prices given, the balance is sampled at window boundaries: Δspend ÷ expected cost = measured rate. Rate > 1.5 alerts as fail; outside the drift band (|ratio−1| > 0.05 and > 0.2) warns; a top-up during the window (`Δ<0`) voids the window (`skipped_recharge`) instead of producing a bogus ratio.
- **JSONL audit log** — one line per request plus reconcile/anomaly/fingerprint/score events under `--out` (default `reports/guard`), rotated daily. **Metadata only**: no conversation content, no credentials, no upstream error bodies, no query strings — verified by dedicated redaction tests.
- **Truncation / disconnects** — `finish_reason=length` is recorded; client disconnects mid-stream mark the request `aborted`.
- **Live scorecard** — every 20 forwarded requests a one-line multi-dimension score is printed (availability / accounting / identity / latency / cost), plus a final card on exit; rolling window = last 100 forwarded requests (locally rejected 401/403 never enter the window); the `观测` (observed) counters — truncation rate / missing usage / aborts — are informational and never affect the grade; with tiny windows a single request can pull the overall grade red, which is normal jitter.

Optional: `--fingerprint-minutes 60` re-runs the identity-family probe periodically and alerts when the model-family fingerprint drifts (the probe sends real requests and costs real money — off by default).

Boundaries: only `chat/completions`, `completions`, and `embeddings` get deep inspection; other paths are forwarded untouched with a basic log line. HTTP/1.1 only; upstream responses are requested with `Accept-Encoding: identity` on deep-inspected endpoints (the only byte-level rewrite besides credential replacement). The balance probe polls the one-api style usage endpoint (its `total_usage` is read as ÷100); stations without such an endpoint degrade reconciliation to token-only stats with a `skipped` note. Local auth uses a constant-time comparison; `Ctrl+C` (or closing stdin) stops guard and settles the final window before flush.

### Web shell (static, offline)

`npm run web`, then open <http://127.0.0.1:8619> — a purely static, local-only shell with two tabs:

1. **Build command** — a form that assembles a `model-xray test …` command for you to copy into a terminal (it assumes the short `model-xray` command is available — run `npm link` once, or swap in `node dist/src/cli.js`). Your API key is **not** part of the command: set it in the terminal via `MODEL_XRAY_KEY` (the page prints the exact `export` / `$env:` line for bash and PowerShell).
2. **Render report** — paste a locally generated `report-*.json` to view its scorecard. Parsing happens entirely in your browser.

Notes:

- The page makes **zero network requests** and uses **no storage** (no localStorage / cookies); the key enters through your terminal's environment variable, never through the page.
- The generated command quotes arguments with single quotes, which `cmd.exe` does not support — run it in **PowerShell** or **bash/zsh** (the form also has a cmd.exe quoting mode).

### Status

v0.2.0 — `test` and the P2 `guard` proxy are functional, and the static web shell ships in-repo. Not yet published to npm: run from source (see Quick start); after publishing, `npx model-xray` works out of the box. This repository hosts the CLI, the versioned test assets, and the maintainers' own published reports (`reports/`).

## 中文

`model-xray` 是一个开源 CLI，用实证手段检测兼容 OpenAI 协议的 LLM 接入点是否存在**模型真伪 / 掺水**问题（换壳、降智、截断上下文、虚标 token 计数等中转站常见套路）。它不要求你相信任何厂商的话：直接探测端点行为，产出可分享的红绿报告。

### 快速开始（从源码，约 5 分钟）

需要 **Node.js ≥ 22**（用 `node --version` 确认）。

```bash
git clone https://github.com/OpenLlamas/model-xray.git
cd model-xray
npm install
npm run build
npm link          # 可选但推荐：此后可用短命令 model-xray（npm 报权限错误则跳过）
```

设置 API key（`test` 与 `guard` 都读它；key 不进命令行、不进 shell 历史）：

```powershell
# PowerShell
$env:MODEL_XRAY_KEY = 'sk-你的key'
```

```bash
# bash / zsh
export MODEL_XRAY_KEY='sk-你的key'
```

跑一轮审计：

```bash
model-xray test \
  --base-url https://your-relay.example.com/v1 \
  --model gpt-4o \
  --yes
```

（跳过 `npm link` 的话，把命令里的 `model-xray` 换成 `node dist/src/cli.js` 即可。）

报告落盘到 `reports/`，同一时间戳三份：`report-<stamp>.md`（看这份）、`report-<stamp>.html`（浏览器打开）、`report-<stamp>.json`（原始证据）。退出码：`0` 通过/可疑 · `1` 不通过 · `2` 用法错误。

### 常用场景（照抄即可）

**1）只审计一次** —— 就是上面的命令。知道什么就补什么，不知道的项自动跳过：

| 你知道 | 加上 |
|---|---|
| 标称上下文窗口（如 128000） | `--claimed-context 128000` —— 启用 needle 实测 |
| 宣称能力 | `--expect vision,tool,thinking`（默认 `vision,tool`；都没宣称用 `--expect none`） |
| 标称价格（每百万 tokens） | `--price-input 0.2 --price-output 0.7` —— 启用实测倍率 |

想先看会发什么请求、大约花多少：加 `--dry-run`（不发任何请求）。一整轮通常只花几分钱——实测 53 样本 ≈ $0.015（按 $0.2/$0.7 每 M tokens）。

**2）过段时间复测 / 抓偷换模型** —— 保留第一次产出的 `baseline-<stamp>.json`，复测时带上：

```bash
model-xray test --base-url https://your-relay.example.com/v1 --model gpt-4o --yes \
  --baseline reports/baseline-2026-10-11T10-09-23-183Z.json
```

**3）常驻监控（`guard`）** —— 本地透明代理，盯真实客户端流量并实时打分：

```powershell
# ① key 只走环境变量（guard 没有 --key 旗标，key 不进命令行历史）
$env:MODEL_XRAY_KEY = 'sk-你的key'
# ② 启动代理（默认监听 127.0.0.1:8621）
model-xray guard --base-url https://your-relay.example.com/v1 `
  --price-input 0.2 --price-output 0.7 --reconcile-minutes 15
# ③ 把客户端 base-url 指向 http://127.0.0.1:8621/v1，
#    并把客户端 key 设为与 MODEL_XRAY_KEY 相同的值
```

之后正常用你的客户端：每 20 个已转发请求打印一次实时评分卡（可用性/计量/身份/时延/成本；滚动窗口 = 最近 100 个请求），异常立即告警，全部写入 `reports/guard/guard-YYYYMMDD.jsonl`（只记元数据）。`Ctrl+C` 退出前会先结算最后一个窗口。

**4）浏览器里看报告**（数据不出本机）：

```bash
npm run web    # 打开 http://127.0.0.1:8619，粘贴或拖入 report-*.json
```

### 结果怎么读

- **判定**（同退出码）：通过（0）· 可疑（0）· 不通过（1）· 用法错误（2）。
- 证据不足的维度标 `N/A` 并排除在计分之外——绝不按 0 分算。
- **计分**：加权几何合成 0–100 总分：计费 25 / 质量 25 / 身份 15 / 上下文 15 / 能力 10 / TTFT 10。任一维度 fail 或总分 < 40 → 不通过；计费/能力/上下文/质量 低于 40 触发**硬红线**（总分封顶 45）；总分 < 75 或有 warn 维度 → 可疑。
- 每条结论都附原始请求/响应证据，可回查。

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
| `--key <key>` | API key；也可改用环境变量 `MODEL_XRAY_KEY` / `OPENAI_API_KEY`（推荐：key 不进 shell 历史；guard 只能用环境变量） |
| `--claimed-context <n>` | 标称上下文窗口；启用 needle 实测 |
| `--expect <list>` | 宣称能力，取值 `vision,tool,thinking`（或 `none`；默认 `vision,tool`） |
| `--price-input <n>` / `--price-output <n>` | 每百万 tokens 的宣称价格，必须成对出现；启用实测倍率探针 |
| `--baseline <path>` | 与基线文件做指纹对比；未显式给 `--seed` 时沿用基线 seed |
| `--baseline-out <path>` | 落盘本轮基线（缺省写到 `reports/baseline-<stamp>.json`） |
| `--yes` | 跳过远程端点的交互式成本确认（脚本/非 TTY 环境必需） |
| `--dry-run` | 只打印计划请求量与 token 预估，不发任何请求 |
| `--deep` | 每项探针更多样本（更慢、更贵） |
| `--out <dir>` | 报告输出目录（缺省 `reports`） |

### 出错了怎么办

| 现象 | 处理 |
|---|---|
| `exit 2` / 提示成本确认 | 加 `--yes`（脚本、CI、非交互终端必需） |
| guard：客户端收到 `401` | 客户端 key 必须与 `MODEL_XRAY_KEY` **完全一致**；不一致的请求本地即拒、绝不转发 |
| guard：端口被占用 | `--port 8622`（默认 8621） |
| 成本维度 `N/A` / `skipped` | 站点没有 one-api 风格余额接口，或没给 `--price-input/--price-output`——对账降级为纯 token 统计，属正常 |
| 能力项 fail 但站方从没宣称过 | 只把站方确实宣称的能力放进 `--expect`（默认 `vision,tool`），其余去掉或用 `--expect none` |
| 想跑得更省更快 | 不传 `--price-*` 与 `--claimed-context`；先 `--dry-run` 预估 |
| cmd.exe 执行 web 壳生成的命令报错 | 该命令用单引号，请改用 PowerShell 或 bash（表单也有 cmd.exe 引号模式） |
| 构建失败 / 找不到 node | 安装 Node.js ≥ 22（https://nodejs.org） |

### 边界与注意

- **单位必须一致。** 宣称价格与该站余额显示单位须一致（美元/quota 均可），工具只算比值，不做单位换算。
- **勿有并发流量。** `test` 实测倍率窗口内，被测 key 不要跑其他请求——并发消费会抬高 Δ扣费、使倍率偏高估。（`guard` 模式下经代理的流量逐请求入账，只需注意别让同一 key 在代理之外并发使用。）
- **充值干扰。** 两次余额查询之间发生充值会使测量作废（Δ<0 直接判无效）；充值与消费叠加的情况难以识别，存疑时请人工核对该站账单流水。
- **同源假设。** 两次余额读数假定中转站路由到同一后端且返回非缓存值；多后端网关或余额缓存可能使 Δ失真。
- **阈值为启发式初值。** 漂移阈值（质量 15%/30%、计费斜率 0.05/20%、倍率 0.5–1.1–1.5）随题集版本化管理，保证跨版本报告可比。
- **基线沿用 seed。** `--baseline` 会沿用基线 seed 固定题集——端点理论上可对固定 seed 特判，该权衡在此明示。
- **基线格式。** 基线文件仅支持 `version: 1`；版本/模型/题集版本不符时跳过对比并给出提示。基线只含聚合指纹字段（模型族、正确率、能力布尔、计费斜率、seed）——不含 API key、提示词原文或余额数值。

### 原则

- **对所有平台一视同仁。** 工具自身没有"自营站点"立场。若你是接入点运营方，请发布自己的检测报告并接受任何人复测——公信力来自第三方跑同一条命令，而不是自带榜单。
- **不做排行榜。** 官方只发布报告不排名次，避免黑稿嫌疑。
- **证据优先。** 每条结论都附原始请求/响应记录链接。
- **题集版本化。** 题库与 needle 均带版本号，报告可复现可追溯。

### Guard：本地常驻监控（P2）

`guard` 启动一个本地透明转发代理，盯**真实流量**而不是一次性探测（启动命令见「常用场景 3」）。逐请求盯什么：

- **模型一致性** —— 请求的 `model` 与端点实际应答的模型不一致，立即告警（`model_mismatch`）。
- **Token 记账** —— 解析 SSE/JSON 响应里的 `usage`（字节原样透传）；token 为负或分项对不上报 `usage_invalid`。响应里带 `cached_tokens` / `reasoning_tokens` 明细时会一并捕获入账。
- **滚动对账** —— 提供宣称价格后，窗口首尾各查一次余额：Δ扣费 ÷ 应缴金额 = 实测倍率。倍率 > 1.5 按 fail 告警；超出漂移带宽（|ratio−1| > 0.05 且 > 0.2）按 warn 告警；窗口内充值（Δ<0）作废该窗口（`skipped_recharge`），不出假倍率。
- **JSONL 审计日志** —— 每请求一行，外加 reconcile/anomaly/fingerprint/score 事件，写入 `--out`（默认 `reports/guard`）并按日轮转。**只记元数据**：无对话内容、无凭证、无上游错误体、无 query——有专门的脱敏测试钉死这条红线。
- **截断与断连** —— `finish_reason=length` 记录在案；客户端流中断开标记 `aborted`。
- **实时评分卡** —— 每 20 个已转发请求输出一次多维单行评分（可用性/计量/身份/时延/成本），退出时无论计数再输出一张终卡；滚动窗口为最近 100 个已转发请求（本地 401/403 拒绝的请求不转发、不入窗）；「观测」项（截断率/缺用量/中止）仅记录不计总评；小样本（窗口内请求很少时）单笔异常即可拉红总评，属正常抖动。

可选：`--fingerprint-minutes 60` 周期性复跑身份族指纹探针，模型族漂移即告警（探针发真实请求、产生真实计费——默认关闭）。

边界：只有 `chat/completions`、`completions`、`embeddings` 做深检，其余路径原样转发并记基础行；仅支持 HTTP/1.1；深检端点会强制 `Accept-Encoding: identity`（除凭证替换外唯一的字节级改写）。余额探针按 one-api 风格 usage 接口读取（`total_usage` 按 ÷100 折算），站点没有该接口时对账降级为纯 token 统计并出 `skipped` 提示。本地鉴权用常量时间比较；`Ctrl+C`（或关闭 stdin）停止时先结算最后一个对账窗口再落盘。

### Web 壳（纯静态、纯本地）

`npm run web` 然后打开 <http://127.0.0.1:8619> —— 一个纯静态轻壳，两个标签页：

1. **生成命令** —— 表单帮你拼好 `model-xray test …` 命令，复制到终端执行（它假定 `model-xray` 短命令可用：先跑一次 `npm link`，或把命令头换成 `node dist/src/cli.js`）。key **不会**出现在命令里：在终端用环境变量 `MODEL_XRAY_KEY` 设置（页面会给出 bash 与 PowerShell 两种写法）。
2. **渲染报告** —— 粘贴本地生成的 `report-*.json` 即可渲染评分卡，解析完全发生在浏览器本地。

注意：

- 页面零网络请求、零存储（无 localStorage / cookie）；key 通过终端环境变量进入，不经过页面。
- 生成的命令使用单引号包裹参数，`cmd.exe` 不支持单引号——请在 **PowerShell** 或 **bash/zsh** 中执行（表单也提供 cmd.exe 引号模式）。

### 状态

v0.2.0 —— `test` 与 `guard`（P2）均已可用，静态 Web 壳随仓库提供；尚未发布到 npm：请按「快速开始」从源码运行（发布后 `npx model-xray` 开箱即用）。本仓库承载 CLI、版本化测试资产，以及官方自己的公开报告（`reports/`）。

## License

MIT