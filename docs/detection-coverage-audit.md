# 检测覆盖与可信度审计

- 审计日期：2026-10-22
- 审计对象：model-xray v0.2.0（`src/` 全部探针、评分、客户端、guard）
- 对照对象：proxy-sleuth、ai-check-model、model-verify、LogProbs，以及蒸馏检测论文（arXiv 2607.09692）
- 审计方式：逐文件读码 + 逐层对照公开 README/方法说明；**本次未修改任何代码**
- 结论口径：只陈述可复核的代码行为；无法验证的能力一律标为"未覆盖"，不按"应该能"推断

---

## 0. 一句话结论

当前实现**不是"没有统计"，而是"统计只覆盖了一个局部，且关键判定全部是未标定的经验常数"**。

- 已覆盖：自述身份、响应 model 回显、needle 截断、算术质量、三项能力、计费形状/余额对账、价格表漂移、TTFT；P0 另补协议参数（max_tokens/stop/response_format/n/logprobs + seed 观测）。
- 未覆盖（审计基线时；其中「协议参数完整性」已于 2026-10-22 作为 P0 落地，见下方实施状态）：**分布指纹（logprobs）、tokenizer 指纹、知识截止、同族档位区分、混合路由、多轮对话、流式完整性、模型目录**。
- 最关键的失效场景：**同族降档**（如 `gpt-4o → gpt-4o-mini`、`glm-5.3 → glm-5.3-flash`）。现有 identity + quality 两层都拦不住，而这正是中转站最常见的手法。
- 因此当前**不能声称"准确度可信度极高"**；能诚实声明的上限是"多维度行为筛查 + 部分计费实证"，且必须逐维度标注置信度。

> **实施状态（2026-10-22 后续切片）**：本审计中的 P0「协议参数完整性」已落地为 `src/probes/params.ts`（max_tokens/stop/response_format/n/logprobs + seed 观测），题集版本升至 `v0.2.3`；其余未覆盖项（logprobs 分布指纹、tokenizer、知识截止、同族降档、混合路由等）仍未实现。params 只证明参数是否被端点遵守，不能单独证明模型权重来源。

---

## 1. 当前实际检测矩阵（按代码行为，不按 README 措辞）

| 维度 | 实际检测项 | 方法与阈值 | 证据强度 | 主要局限 |
|---|---|---|---|---|
| identity | 7 道自述题、JSON schema 遵循、persona/品牌注入、响应 `model` 回显、具体变体冲突、重复样本一致性 | 自述族匹配；回显规范化比对；分数从 100 起，按 `min(60/80/90)` 逐级封顶（`src/probes/identity.ts:980-1055`） | 弱—中 | 自述可被 system prompt 诱导；小模型常自称大模型族；回显由网关写入，匹配不构成证明；"未发现矛盾"被计为 100 分 |
| quality | 12 道程序化算术/字符串题 + 3 道控制题（`src/probes/quality.ts:generateQuestions`） | 首答正确率 `pass1`；`≥0.9` pass，`≥0.6` warn，`<0.6` 且复采未恢复 fail；分数 = `pass1×100`（`:407-431`） | 弱 | 全部是算术/数数/比较，无代码、推理、知识、指令遵循、长文、多语言；小模型几乎全过；n=12，阈值分辨率 8.3%，置信区间极宽 |
| context | 4 个深度档 0.25/0.5/0.75/0.9，单 needle + 结尾回显 | 单侧 Fisher 精确检验，`ALPHA=0.01` + Bonferroni（`src/probes/context.ts:166-197`）；默认每档 1 样本（`src/cli.ts:504`） | 中 | 无 100% 填充、无位置扫描（默认 needle 在中间）、无多针、无多轮；默认 1 样本时检验功效接近 0，只能算初筛 |
| capability | vision 三色 256px、tool calling、thinking | 分项 pass/partial/fail，均分×100（`src/probes/capability.ts:84`） | 中 | 只验证"有没有"，不验证"好不好"；tool 只查是否发起调用与参数形态；无执行沙箱；无同族档位区分 |
| billing | usage 形状（EN/ZH 线性回归、total=prompt+completion、输出侧比例、常量偏移、常量 usage）、公示倍率、价格表漂移、余额对账、token reference | 形状通过无绝对对账时封顶 85；实测倍率 >1.5 fail；价格相对差阈值等（`src/probes/billing.ts`） | 中—强 | 核心是**自报 usage**；`estimateMessageTokens` 是保守估算、无真实 tokenizer（`src/tokens.ts:4`）；无 cached/reasoning/image token 计费核验；无重复计费主动测试 |
| ttft | 5 次串行 + 4 并发 | p50/p95（`src/probes/ttft.ts:26-35`） | 弱 | 样本过少；只测延迟，不测并发下的一致性/换模 |
| decoy | 1 道随机无害题 | 记录响应，不计分（`src/runner.ts:376-401`） | 观测 | 无统计意义，只能人工看 |
| guard | 真实流量 model 回显、usage 合法性、滚动余额对账 | 逐请求告警（`src/guard/`） | 中 | 只覆盖经过代理的流量；无变更点检测、无并发路由检测 |

### 1.1 硬编码与未标定阈值（代码位置）

| 位置 | 常量 | 问题 |
|---|---|---|
| `src/scoring.ts:19,27,30,40` | `HARD_RED_CAP=45`、`FAIL_LEVEL_SCORE_CAP=45`、`MIN_COVERAGE=0.6`、`CAPABILITY_FALSIFIED_CAP=60` | 无标定来源，无敏感性分析 |
| `src/scoring.ts:157` | 硬红线 `<40` | 与 45 封顶叠加，语义重复 |
| `src/scoring.ts` 权重 | 审计时：billing 25 / quality 25 / identity 15 / context 15 / capability 10；当前（params P0 后）：billing 25 / quality 20 / identity 10 / context 15 / capability 10 / params 10 | 拍定权重；几何平均对 0 分过度敏感 |
| `src/probes/identity.ts:980-1055` | `100 / 20 / 15 / 10 / 0` 与 `min(...,60/80/90)` | 离散常数链，无假阳/假阴依据 |
| `src/probes/quality.ts:411-431` | `0.9 / 0.6`、`min(...,80)` | 12 题上的阈值，统计分辨率不足 |
| `src/probes/context.ts:166-197` | `ALPHA=0.01`、基线 25%、Bonferroni | 方法正确，但基线 25% 是假设值，未实测标定 |
| `src/probes/billing.ts:775-777,1197-1215,1247-1249` | `3×/5× resolution`、`log10(ratio)≥2.5`、价格相对差线 | 经验值，未按币种/站点分辨率标定 |
| `src/probes/ttft.ts:26-35` | 串行 5、并发 4、1 轮 | 分位数不稳定 |
| `src/types.ts:89-103` | 审计时：`ChatRequest` 仅支持 model/messages/stream/temperature/max_tokens/tools/tool_choice；params P0 已扩展 stop/seed/n/logprobs/top_logprobs/response_format | **协议层检测能力被类型系统限制死** |

---

## 2. 与开源项目的逐层对比

> 说明：以下仅依据各项目公开 README/设计说明；其中 proxy-sleuth 2 stars、model-verify 0 stars，成熟度有限。**借鉴的是方法，不是其可信度背书。**

| 检测能力 | model-xray | proxy-sleuth | ai-check-model | model-verify | LogProbs |
|---|---|---|---|---|---|
| 自述身份 | ✓ | — | ✓ | ✓ | — |
| 响应 `model` 回显 | ✓ | — | ✓ | — | — |
| 响应元数据/ID 格式 | — | — | ✓ | — | — |
| `/v1/models` 目录核验 | — | — | ✓ | — | — |
| OpenAI Responses 结构指纹 | — | — | ✓ | — | — |
| logprobs 分布指纹（JS/KL） | — | — | — | ✓ | ✓ |
| tokenizer 计数指纹 | — | — | — | — | — |
| 行为/风格指纹 | 部分（persona/变体） | — | 部分 | ✓ | — |
| 知识截止/时效题 | — | ✓（40+ 题/15 组） | ✓ | — | — |
| Magic string/官方触发串 | — | — | ✓ | — | — |
| 随机 nonce 挑战 | ✓（needle/计费） | — | ✓ | — | — |
| 参数完整性（max_tokens/top_p/stop/tools/response_format/n/logprobs） | ✓（P0：max_tokens/stop/response_format/n/logprobs；top_p/tools 待补） | ✓（核心层） | — | — | — |
| API 特性指纹（min_p/top_a/Anthropic 兼容） | — | ✓ | — | — | — |
| 上下文截断（needle） | ✓（4 档单针） | ✓（~25K，200 轮对话） | — | — | — |
| 位置扫描/多针/多轮 | — | 部分 | — | — | — |
| 能力基准（难题/执行沙箱） | 弱（算术） | ✓（沙箱执行） | ✓ | ✓（40 题/20 难题） | — |
| 同族档位区分（tier signature） | — | — | — | ✓（细节/代码风格/推理深度/拒答） | — |
| 混合路由/质量反转 | — | ✓（3× 重复） | — | — | — |
| A/B 官方对照 | — | — | — | ✓ | ✓（基线库） |
| 延迟指纹 | 弱（TTFT） | — | ✓ | ✓ | — |
| 计费形状 | ✓ | — | — | — | — |
| 余额对账/价格漂移 | ✓ | — | — | — | 价格管理 |
| 统计检验（CI/FDR/校准阈值） | 局部（context Fisher） | 未披露 | 未披露 | MMD | JS 距离 |
| 复现/基线 | ✓ | ✓ | — | ✓ | ✓ |
| 持续监控 | ✓（guard） | — | — | ✓（monitor） | — |

### 2.1 可直接借鉴的四项方法

1. **proxy-sleuth 的 param-integrity 层**：验证 `max_tokens` 是否被截、`temperature` 是否被锁、`stop` 是否生效、工具是否被剥离、system prompt 是否被注入。这是"无死角"里最便宜、最高命中率的一层；审计基线时几乎空白，P0 已补 max_tokens/stop/response_format/n/logprobs。
2. **model-verify 的 logprob 层 + tier signature**：同族大/小模型的行为差异（细节密度、代码风格、推理链长度、拒答模式）比自述可靠；logprob 分布可做 JS/KL 距离。
3. **LogProbs 的基线库**：固定 10 条探针 + top-5 logprobs + JS 散度，先建官方基线，再比对中转站。
4. **arXiv 2607.09692 的统计口径**：阈值必须由校准集得到（`τ*`），报告要用单侧检验 + bootstrap 置信区间，而不是拍一个 `0.6`。

---

## 3. 盲区清单（按可被利用程度排序）

### B1 同族降档：现有两层都拦不住（严重）

攻击：请求 `gpt-4o`，实际路由 `gpt-4o-mini`；`model` 字段照抄请求值。
- identity：小模型大概率自称"GPT-4 系列"，且回显由网关伪造 → 通过。
- quality：12 道算术题 mini 也能全对 → 通过。
- capability：vision/tool 两者都有 → 通过。
- 结果：可能拿到接近满分，实际是低价模型。

这是当前**最大的单点失效**，也是"准确度"最该补的洞。

### B2 协议参数静默改写（严重）

攻击：clamp `max_tokens`、锁死 `temperature`、忽略 `stop`、剥离 `tools`、忽略 `response_format`、不支持 `n`/`logprobs` 却返回成功。
- 审计基线时 `ChatRequest` 没有这些字段（`src/types.ts:89-103`），无法发起测试；P0 已扩展 `stop/seed/n/logprobs/top_logprobs/response_format`，但 `top_p`/penalties 仍未覆盖。
- 审计基线时唯一相关逻辑是 temperature 被 400 拒绝时自动去掉并披露（`src/client.ts:82-119`），**不是检测**；P0 已新增独立 params 探针。

### B3 分布级替换/量化/蒸馏（高）

攻击：全精度换成量化版、同厂蒸馏版，行为接近但分布不同。
- 当前无 logprobs 采集（全仓库 0 处），无 JS/KL 距离，无基线分布。

### B4 tokenizer 差异（高）

攻击：用不同 tokenizer 的模型冒充，或虚标 prompt token。
- 当前只有保守估算 `estimateMessageTokens`，无真实 tokenizer 计数（`src/tokens.ts:4`）。
- 用已知 token 数的构造串做差分，是最便宜、最难伪造的指纹之一。

### B5 知识截止/模型代际（高）

攻击：用上一代同族模型冒充新一代（如 GPT-4o → GPT-4.1 之前的版本）。
- 当前 0 处 knowledge cutoff 探针；identity 只问"你是谁"，不问"你知道什么"。

### B6 混合路由/按时段/按长度换模（高）

攻击：简单题走大模型、复杂题走小模型；或前几次走真模型、之后降级；或并发时混路由。
- 当前无重复采样方差检验、无 easy/hard 反转、无时间窗对比、无并发一致性；decoy 只有 1 题。

### B7 长上下文覆盖不足（中高）

攻击：只支持 8K 却标 128K；或 25% 深度就开始截断；或 needle 放中间才失效。
- 当前 4 档、单针、默认 1 样本、无 100% 填充、无位置扫描、无多针、无多轮累积。

### B8 多轮对话一致性（中高）

攻击：单轮正常，多轮后降级/遗忘/截断；或注入 system prompt 改写人格。
- 当前所有探针基本是单轮（billing 也只有单轮复述）。

### B9 流式完整性（中）

攻击：重复 chunk、丢失 usage、`finish_reason` 错误、SSE 与 JSON 结果不一致。
- 当前解析 SSE 但不做完整性断言；`stream_options.include_usage` 未使用。

### B10 缓存/模板特判（中）

攻击：对固定题集缓存答案或硬编码；对 seed 复用题集特判。
- 当前题集程序化随机（好），但 `--baseline` 复用 seed 的设计已被文档承认为可被特判（`docs/README-detailed.md` "Baseline seed reuse"）。
- identity 只对"逐字一致"给 warn，未做跨会话/跨题型的模板检测。

### B11 安全/拒答风格（中）

攻击：用对齐风格不同的模型冒充（拒答边界、措辞、语言习惯）。
- 当前 refusal 仅作为 identity 旁证，未做 tier signature 的四维风格分析。

### B12 计费绝对口径（中高）

攻击：统一 ×1.3 缩放 usage、虚增 cached/reasoning token、重复计费。
- 当前形状检测无法排除均匀缩放（文档已承认 `evidence_level: shape-only`）；
- 无独立 tokenizer 绝对值；
- 无 cached/reasoning/image/audio token 的专项核验；
- 无主动重复请求测双计费。

### B13 统计与决策（严重，影响所有维度）

- **无全局多重比较控制**：identity/billing/quality/capability 各自一堆检查，未做 FDR/FWER。几十项检查各按经验阈值判，族错误率不可控。
- **阈值未校准**：没有"诚实端点假阳率 / 已知坏端点假阴率"的实测数据。
- **分数是点估计**：quality 的 Wilson 区间只披露、不参与判定；identity 是常数链；总分几何平均后再硬封顶。
- **负证据当正证据**：identity 从 100 分起步，未发现矛盾即 100；这与"证伪优先"的原则冲突。
- **固定题集公开**：quality/identity 题池写在 `src/assets.ts`，仓库公开；对定向作弊者不构成盲测。

### B14 并发与路由（中）

- TTFT 只测延迟；未测同一 prompt 并发下的一致性。
- guard 只看经过代理的流量，无变更点检测。

### B15 模型目录/路由层（中）

- 未查 `/v1/models` 是否存在该模型、声明的 `context_length`/`supported_parameters` 是否与实测一致。
- ai-check-model 把这一项单列 10 分，成本极低。

---

## 4. 为什么现在不能声称"极高可信度"

### 4.1 没有校准集，就没有假阳/假阴

"极高可信度"必须能被量化为：

- 诚实端点误报率（FAR）≤ 1%
- 已知坏端点漏报率（FRR）≤ 1%，且按攻击类型分别统计
- 同 seed 复现率 100%
- 每条 finding 可复算

当前仓库没有任何一项有实测数据支撑。没有校准集时，所有阈值都只是"看起来合理"。

### 4.2 多重比较会制造假警报

假设 30 项近似独立的检查、每项经验阈值对应 α≈0.05，则至少一次误报的概率约为：

`1 − 0.95^30 ≈ 78.5%`

50 项时约 `92.3%`。这不是说当前一定误报，而是说**在未做 FDR/FWER 控制前，"单项通过"不能外推为"整体可信"**。当前只有 context 一处做了 Bonferroni。

### 4.3 样本量不足，分数分辨率是假的

- quality：12 道主题，阈值 0.6/0.9 对应 8/12 与 11/12；n=12 的 95% 区间宽度可达 ±25 个百分点以上。
- context：默认每档 1 样本，Fisher 检验几乎没有功效，只能算初筛（代码已如实标注）。
- ttft：5 个样本的 p50/p95 不具稳定性。

### 4.4 最有效的判别信号没有采集

按判别力从高到低：

1. logprobs/top_logprobs 分布距离
2. tokenizer 计数差分
3. 难题/执行型能力（同族档位可分）
4. 用户流量上的路由一致性
5. 自述身份（最弱，可诱导）
6. 响应 `model` 回显（可伪造）

当前主要依赖 5 和 6，恰好是最弱的两个。

---

## 5. 目标架构：把"无死角"定义为可审计的覆盖矩阵

> "无死角"不等于"绝对证明"。黑盒远程 API 无法证明模型身份，只能给出**分维度、带误差上界**的证据结论。目标是把每个盲区变成"已覆盖并有量化指标"或"明确声明不在范围内"。

### Layer 0 校准与金标准（前置，决定其余所有层）

- 官方端点金标准：每个目标模型至少 1 个官方/可信基线。
- 坏端点样本库：同族降档、跨族换壳、量化、蒸馏、截断、参数剥离、计费虚增、混合路由，每类 ≥100。
- 每条检查在好/坏样本上的分布 → 选阈值（FAR≤1%）→ 记录 FRR。
- 校准结果版本化，作为 CI 门禁；阈值改动必须重新校准。

### Layer 1 传输与元数据

- 响应头、`id` 格式（`chatcmpl-` / `msg_`）、`created`、`system_fingerprint`、`service_tier`。
- `/v1/models` 成员资格、`context_length`、`supported_parameters`。
- SSE 完整性：chunk 顺序、usage chunk、`finish_reason`、重复内容。
- 错误面：上游错误泄漏、限流头、重定向。

### Layer 2 协议/参数完整性（P0，最便宜的高命中层）

- `max_tokens`：请求 1/16/256，验证 completion 上限与 `finish_reason`。
- `stop`：给出必停序列，验证真的停。
- `temperature`：0 时多次请求应近确定性；高温应有多样性；检测锁定。
- `top_p` / `presence_penalty` / `frequency_penalty`：是否被忽略。
- `n>1`：是否返回多条。
- `logprobs` / `top_logprobs`：是否支持、值是否合理。
- `response_format`：`json_object` / `json_schema` 是否真的约束。
- `tools` / `tool_choice`：强制调用、必需参数、并行调用。
- `seed`：同 seed 是否可复现。
- system prompt：冲突指令是否被遵守；是否被注入品牌人格。
- 上下文元数据 vs 实测可用长度。

### Layer 3 分布指纹（P1）

- 10–20 条固定探针，采样 `top_logprobs=5`，对每个位置做 JS/KL 距离。
- 与官方基线比较，阈值由校准集给出；报告效应量与 bootstrap CI。
- 无 logprobs 时明确降级为"分布层不可用"，并限制总体置信度上限。

### Layer 4 tokenizer 指纹（P1）

- 构造已知 token 数的字符串（不同 tokenizer 差异最大化）。
- 用 `usage.prompt_tokens` 的差分与官方 tokenizer 计数比对。
- 该信号独立于模型自述，且难以在不改 tokenizer 的情况下伪造。

### Layer 5 行为/知识指纹（P1）

- 知识截止：带明确时间边界的事件题（只问"是否知道/何时发生"）。
- 风格/tier signature：细节密度、代码风格、推理链长度、拒答模式、中文引号/标点习惯。
- Magic string / 官方触发串（仅使用公开且稳定的）。
- 多语言一致性。
- 自述只作弱旁证，永不单独定罪。

### Layer 6 能力（P1）

- 难度分层题库，程序化生成，held-out 轮换。
- 代码题用沙箱执行验证，数学题用程序验证，指令遵循用程序检查。
- pass@k + 置信区间；题目难度用 IRT/校准集标定。
- 专设"同族档位区分题"：能稳定区分大/小模型。

### Layer 7 上下文与多轮（P2）

- 深度 10/25/50/75/90/100%，每档多针。
- 固定深度做位置扫描（头/中/尾）。
- 多轮累积到目标长度，验证早轮信息是否保留。
- 边界二分搜索 + 尾回显 + 多针交叉验证。

### Layer 8 计费与价格（P1）

- 用独立 tokenizer 做绝对计数，不只做形状。
- cached / reasoning / image / audio token 专项核验。
- 主动重复请求测双计费。
- 余额对账 + 价格表漂移 + 账本基线（已有，保留）。
- 明确区分 `verified` / `shape-only` / `insufficient`。

### Layer 9 路由与时序（P2）

- 同一 prompt 间隔重复 K 次，检测方差与换模。
- easy/hard 反转：简单题失败而难题通过 → 混合路由。
- 并发 A/B：并行请求是否落到不同后端。
- 会话前后半段漂移。
- guard 流量上的变更点检测（CUSUM/贝叶斯变点）。

### Layer 10 统计汇总（P0，替换现有评分）

- 每条检查输出：效应量、p 值、置信区间、样本量。
- 全局 Benjamini–Hochberg FDR，`q=0.01`。
- 预注册阈值；顺序检验控制 α。
- 维度结论四态：`verified`（有正证据）/ `not_refuted`（无反证但未证实）/ `contradicted`（fail）/ `insufficient`。
- 只有 `verified` 与 `contradicted` 参与总分；`not_refuted` 不计 100 分。
- 总分改为"证据等级 + 后验概率/置信区间"，或保留分数但强制附区间与覆盖声明。
- 删除拍定的硬封顶，或让封顶值由校准结果推导。

---

## 6. 分阶段落地

### P0（先做，2 周量级）

| 任务 | 落点 | 验收 |
|---|---|---|
| 参数完整性探针 | 新增 `src/probes/params.ts`；扩展 `ChatRequest`（top_p/stop/seed/logprobs/response_format/n） | 每项参数有 pass/fail/na + 证据（2026-10-22：max_tokens/stop/response_format/n/logprobs + seed 观测已完成；top_p/tools/penalties 待补） |
| 质量题升级 | `src/probes/quality.ts` + `src/assets.ts` | 题库含代码执行/指令遵循/知识/多语言；难度分层；仍可 seed 复现 |
| 统计汇总层 | `src/stats.ts` + `src/scoring.ts` | BH-FDR、CI、四态结论；`not_refuted` 不再算 100 |
| 校准框架 | `test/calibration/` + 现有 `test/mock-server.js` | 能跑 N=100 好/坏样本，输出 FAR/FRR 表 |
| 回归门禁 | `package.json` 脚本 | FAR/FRR 超线即 CI fail |

### P1（1–2 月）

- logprobs 指纹 + 官方基线库。
- tokenizer 计数指纹。
- 知识截止探针。
- 同族档位区分题（tier signature）。
- 混合路由检测（重复/反转/并发）。
- 计费绝对口径（独立 tokenizer、cached/reasoning/image）。
- `/v1/models` 目录核验。
- 流式完整性断言。

### P2（持续）

- 上下文位置扫描、多针、多轮。
- A/B 官方对照模式。
- guard 变更点检测。
- 校准集扩充与阈值再标定；按攻击类型发布 FRR。

---

## 7. 验收标准（可机械检查）

1. 同 seed 两次运行，报告 JSON 除时间戳外逐字节一致。
2. 诚实端点 N=100：每个维度的假阳率 ≤1%，并给出置信区间。
3. 每类坏端点 N=100：对应维度的假阴率 ≤1%；未覆盖的攻击类型必须显式列为 `out_of_scope`。
4. 全局 FDR `q≤0.01`；每条 finding 带 p 值/效应量/样本量。
5. 任何维度在样本不足或对照缺失时输出 `insufficient`，不得输出分数。
6. 每条结论可追溯到 evidenceId 与原始请求/响应。
7. 阈值改动必须附带新的校准报告；无报告不得合并。
8. 报告中每个维度的置信度单独声明；禁止单一"极高可信"总评。

---

## 8. 对现有设计的保留意见

以下部分应当保留，不要为了"加检测"而推翻：

- evidenceId + 原始请求/响应留痕（可复算的基础）。
- needle 的 recordId 与 passphrase 分离（防"复述题面"假通过）。
- starve/blank 与"答错"分离（证据不足不给 0 分）。
- 余额对账、价格账本、倍率漂移（billing 的强项）。
- guard 对真实流量的逐请求核算。
- 版本化题集与基线。
- context 的 Fisher + Bonferroni（全仓库唯一形式化检验）。
- 文档中已主动披露启发式阈值与 seed 复用风险（诚实，应继续保持）。

---

## 9. 结论与边界

- 当前程序的价值是"多维度行为筛查 + 计费实证"，不是"模型身份证明"。
- 在补齐 Layer 0/2/3/4 之前，**同族降档可以稳定绕过**，因此"准确度极高"不成立。
- 补齐后也应表述为："在已校准的检测面上，假阳/假阴有上界；未覆盖面明确声明"，而不是"零误差、无死角"。
- 黑盒 API 的物理边界：无法读取权重、无法证明训练来源；任何"绝对真伪"承诺都是过度声明。

---

## 10. 本次审计未做的事

- 未修改任何源码、测试或配置。
- 未运行真实端点（无 key 授权）。
- 未对对照项目做代码级审计，仅依据其公开 README/方法说明。
- 未给出工期与费用承诺；P0/P1 的时间仅为工程量级估计。
