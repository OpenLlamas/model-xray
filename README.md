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
| Capability gates | vision / tool-calling / thinking flags actually exercised, not just advertised |
| Fixed question bank | A versioned, reproducible set scored against reference answers for quality drift |
| Streaming first-token latency | p50/p95 TTFT sampled under load, useful for spotting "queue-stretched" relays |

### Principles

- **Platform-agnostic.** The tool has no "our own station" to favor. If you operate an endpoint, publish your own reports and let others verify — the credibility comes from third parties running the same command, not from shipped rankings.
- **No leaderboard.** Maintainers publish reports, not rankings, to keep the tool out of "hit piece" territory.
- **Evidence over verdicts.** Every finding links to raw request/response transcripts in the report.
- **Versioned test sets.** Question banks and needles carry versions so a report is reproducible.

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
| 能力校验 | vision / tool calling / thinking 标称能力逐项实测，而非只看宣称 |
| 固定题集质量打分 | 版本化可复现题集，对照参考答案量化质量（降智检测） |
| 流式首字延迟 | 采样 p50/p95 TTFT，识别"排队拉长"型中转 |

### 原则

- **对所有平台一视同仁。** 工具自身没有"自营站点"立场。若你是接入点运营方，请发布自己的检测报告并接受任何人复测——公信力来自第三方跑同一条命令，而不是自带榜单。
- **不做排行榜。** 官方只发布报告不排名次，避免黑稿嫌疑。
- **证据优先。** 每条结论都附原始请求/响应记录链接。
- **题集版本化。** 题库与 needle 均带版本号，报告可复现可追溯。

### 状态

开发中。本仓库将承载 CLI、版本化测试资产，以及官方自己的公开报告（`reports/`）。

## License

MIT