# 多厂商 AI API 聚合器：桌面 GUI 方案（v2，经三模型评审修订）

> 修订说明：v1 按"从零造聚合器"撰写。经 kimi-k3 / glm-5.3 / deepseek-v4.1-flash 三模型独立评审收敛：**本方案最大的问题不是缺功能，而是没有把已有的 model-xray 资产放进架构图**。v2 把命题修正为"model-xray 长成聚合器"，五点硬需求（体验优化 / 统计更准确 / 检测默认开启 / 异常警告 / 计费选填）全部在 M1–M2 默认点亮，总工期不增反降（约 12–13 周）。

前提：个人或小团队本机使用，上游既有官方 API 也有中转站；多人服务端部署不在本方案范围。

## 一、选型结论：以 model-xray 为底座演进，不重造轮子

- **model-xray（自有资产，本方案的底座）**：已落地 ①检测引擎（身份指纹 5–8 问、上下文 needle 实测、token 计数对比官方 tokenizer、余额差值实测倍率、能力门禁 vision/tool/thinking、质量题集、TTFT、加权几何评分卡+硬红线、版本化指纹基线）；②guard 常驻监控透明代理（127.0.0.1 流式 tee 旁路解析 usage/TTFT、每 20 请求滚动窗口实时评分卡、异常即时告警、JSONL 落盘、one-api 余额对账、重试防污染）；③本地 Web 控制台（8620，页面录入 key 仅存内存、token 鉴权、三标签信息架构）。**桥接方式：检测引擎去 CLI 化抽成库；guard 直接演化为网关内核（多渠道路由是透明代理的自然扩展）；8620 控制台迁移为 GUI 底座。**
- **New API / One API**：协议适配成熟，但 AGPL-3.0 + 多用户服务端形态不匹配。~~可用 New API 当引擎快速验证~~（评审砍除：guard 本身就是更好的现成验证引擎）。
- **LiteLLM**：花费追踪/预算/路由可借鉴；依赖 Postgres，本地桌面偏重。其价格 JSON 仅作带标注的参考价填入，**不作默认值**（官方价≠中转价，默认导入=制造错误账单）。
- **CC Switch**：托盘切换、一键写入配置体验照搬。
- **学术审计**：伯克利 llm-api-audit（纯软件不可严格证明→输出风险评分+证据链）、LLMmap、Model Equality Testing。CISPA 影子 API 审计：性能差异最高 47.21%，身份指纹验证失败率 45.83%。

**技术栈（M0 决策，默认 Node/TS 复用）**：guard 已证明 Node 扛得住本地单用户 SSE tee；Rust 从零重写=前 4–6 周重造已能跑的东西，且协议长尾风险在不熟的栈上翻倍。Rust 保留明确进入条件：单二进制分发需求或实测性能瓶颈。GUI 壳（Tauri sidecar vs Electron）留给 M0 spike。CLI 入口保留（TS 路线下近乎零成本，守住 CI/服务器/SSH 无头场景与存量用户）。

## 二、总体架构

```
 本地应用 (Cursor / CLI / 脚本)
        │  http://127.0.0.1:PORT   ← 本地虚拟 Key
 ┌──────▼─────────────────────────────────────────────┐
 │ Gateway Core（guard 演进：Node/TS，无 GUI 可独立跑）  │
 │  入口: OpenAI 兼容（→ Anthropic/Gemini 适配）         │
 │  → 鉴权·限流·预算 → 路由(多渠道转发/有序回退/熔断)      │
 │  → 上游(官方 / 中转站 / 自建)                          │
 │  └ 流式 Tee：透传客户端 + 旁路解析 usage/TTFT/L0 元数据 │
 ├────────────────┬─────────────────┬─────────────────┤
 │ 账本 Ledger     │ 探测器 Prober    │ 审计器 Auditor    │
 │ SQLite(WAL)    │ 健康/能力/xray引擎│ 指纹/基线/对账     │
 └──────┬─────────┴─────────────────┴─────────────────┘
        │ 管理 API（token 鉴权 + Host/Origin 校验）
 ┌──────▼────────────┐
 │ GUI（8620 三标签演进）│
 └───────────────────┘
```

## 三、账本：token 一等公民，金额可空（计费选填的 schema 根基）

1. **一次请求一条不可变记录，重试/回退记为子记录。** 字段：请求 ID、时间、本地 Key、渠道、上游地址、请求模型名、响应实际 model 字段、状态码、错误分类、TTFT、总耗时、输入/输出/缓存读写/推理 token、价格快照版本（**可空**）、金额（微美元整数，**可空**，= token × 价格快照，仅录价渠道产出）。
2. **token 来源三档标注**：`上游 usage`（最可信）/ `本地估算`（流中断或上游未返回；**须标注 tokenizer 版本**——BPE 漂移会累积偏差）/ `对账修正`（**追加调整记录，不改写明细**，与不可变原则自洽）。GUI 中估算值用不同样式。
3. **易错细节**（逐一测试）：OpenAI 流式注入 `stream_options.include_usage`，且**部分中转站即使注入也剥离 usage，需本地估算兜底**；`prompt_tokens` 已含缓存命中（防重复计费）；Anthropic 缓存读写单独计价；客户端断开时取消上游并保留部分用量；**TTFT 跨协议口径**（message_start / 首思考块 / 首正文字节，三选一固定默认+记录口径）与时区日界统一。
4. **计费选填语义**：价格表默认为空、逐渠道选填；录价前 UI 降级显示 token 数/请求数，**禁止显示误导性 $0**，改用「余额不足」类告警；录价后支持历史回填重算金额。
5. **写入可靠性**：SQLite WAL、异步批量写入、落盘缓冲；小时/日汇总表可从明细重算；一键导出 CSV；数据保留期与降采样（防膨胀）。
6. **三方交叉校验**（继承 guard 统计纪律）：上游 usage vs 本地 tokenizer 估算 vs 余额变化/官方用量接口，偏差 >5%（可调）告警。**纪律条款：①重试窗口内实测倍率作废（POST 重试重复计费会虚高假阳性）；②余额对账需「同 Key 独占」前提声明（并发消耗会污染差值）；③修正=追加记录。**

## 四、监控与告警（可实现规格，不是条件名目）

- **被动监控**：成功率、错误分类（401/402/429/5xx/超时/流中断）、TTFT、tokens/s、P50/P95，渠道×模型热力图。
- **主动探测**：定时极小请求（每日预算上限，**首启向导明示"默认开启≈每天 $X"**）；能力矩阵：流式、工具调用、JSON 模式、视觉、长上下文、思考模式。
- **告警规格**（默认值，可调）：
  - **硬红线**（换壳实锤/usage 造假/截断）：即时红色警告 + 用户确认闭环；
  - 模型级评分下跌：滚动窗口（最近 100 请求）综合分环比降 >15% 且样本 ≥20 → 提示级告警；小样本保守阈值 + 静默期（同渠道同类告警 1h 冷却）+ 去抖（连续 2 窗口确认）——防第一周误报耗尽告警价值；
  - 连续失败 ≥3、P95 突增 >2×、余额不足、账本偏差 >5%、指纹漂移；
  - 通道：托盘变色、系统通知（多平台 Webhook 后移）。
- **故障处理**：熔断、半开探测恢复、自动回退链，每次回退日志可见。

## 五、掺假检测：分层前移，默认开启

局限（如实披露）：纯软件不可严格证明（伯克利 llm-api-audit：文本统计检验对细微替换无效，logprob 被推理非确定性干扰，只有 TEE 可证明）。产品输出**风险评分+证据链**，绿/黄/红信任等级+时间线，点开看证据与"复现检测"按钮。

| 层级 | 做法 | 时机 | 默认 |
|---|---|---|---|
| L0 元数据 | 响应 model 字段、ID 格式、工具调用 ID 前缀、usage 结构 | 随 tee 零边际成本 | **开**（M1） |
| L1 行为探测 | xray 轻量指纹题集 + 滚动评分卡 + 硬红线 | 每渠道接入自动跑一轮轻量体检；日常随窗口 | **开**（M1–M2，预算按渠道缩放） |
| L2 分布指纹 | LLMmap + Model Equality Testing + CUSUM 变点 | 专家模式 | **关**（依赖官方样本、成本高、误报高） |
| L3 计费一致性 | 固定短提示查 prompt_tokens 偏高（暗插系统提示）+ 余额对账 | 每日/录价渠道 | 录价才开 |

要点：基线自建（官方 Key 采样，版本更新重采样；无官方 Key 只做相对比较并显式标注）；持续抽样防"按概率替换"攻击；探测只用合成提示，不重放真实对话；审计证据链与"默认不存正文"承诺对齐（脱敏或显式豁免）。

## 六、GUI 与体验（从 8620 三标签演进，控制范围）

- **M1 起步形态=8620 控制台扩展**：一次性检测 / API 聚合与实时监控 / 历史报告三标签已验证（guard 收敛为纯 CLI，控制台不再托管其启停），渠道管理在此之上生长；仪表盘/路由/本地 Key 等九页设计**后置按需增页**，1–2 人团队不做大而全。
- 首启向导：添加渠道 → 测试（自动跑 L0+轻量体检）→ 复制 Base URL 和 Key，三步完成；明示探测成本。
- 一键写入分两级：**L1=复制 BaseURL+Key**（近乎零成本，M3）；L2=全量改写客户端配置**带回滚**（M5，误覆盖风险与收益不成比例地高）。
- 托盘常驻：状态灯 + 今日 token/花费（未录价渠道只显 token）。
- 数据下钻：任何图表数字 → 请求明细 → 证据。
- **安全**：上游 Key 存系统钥匙串（不落明文；正文加密须配套密钥方案与丢失恢复，否则是伪承诺）；代理与管理端口只绑 127.0.0.1 且分离；管理 API token 鉴权 + Host/Origin 校验（防 DNS rebinding，8620 已有现成做法）；自动更新带签名校验 + **空闲检测与在途流排空后再重启**；单实例锁 + 与独立 8620/8621 端口共存方案。

## 七、技术栈

- 核心：Node/TS（guard 演进；Rust 仅在 M0 判定满足进入条件时启用）。
- GUI：Web 控制台（8620 演进）→ 桌面壳（Tauri sidecar / Electron，M0 spike 定）。
- 存储：SQLite（WAL）+ 汇总表；DuckDB 后移。打包 MSI/dmg/AppImage + 自动更新（后移至 M5）。

## 八、路线图（约 12–13 周，1–2 人全职）

| 里程碑 | 内容 | 需求闭环 |
|---|---|---|
| **M0（1 周）** | xray 资产盘点（引擎抽库清单）；技术栈 spike（TS 网关 vs Rust + Rust 进入条件）；账本 schema 定稿（token 必记、金额可空）；JSONL/基线迁移方案；SSE 录制-回放 fixture 库进 CI（xray 题集作回归种子——协议长尾是头号风险） | 决定后续全部工期 |
| **M1（2–3 周）** | 网关=guard 演进（多渠道转发+有序回退）；账本+重试防污染口径；**L0 默认开启**；渠道接入自动跑轻量体检；GUI 从 8620 三标签演进；本地端口安全基线 | 日常可用 + 检测默认开启（L0） |
| **M2（3 周）** | 完整路由（权重/熔断/半开）+本地虚拟 Key/预算；**滚动评分卡+模型级告警默认开启**（含阈值/去抖/冷却规格与误报抑制）；"计费未启用"降级态；托盘 | **异常警告最小闭环** |
| **M3（2 周）** | 主动探测+能力矩阵（与审计同一调度器，避免做两遍）；余额对账+usage API（防污染纪律落地）；一键写入 L1（复制）；探测成本透明化 | 统计准确对账闭环 |
| **M4（2 周）** | 计费选填完整闭环（逐渠道录价、历史回填、导出）；基线管理 UI+版本重采样；L2 专家模式（默认关）+CUSUM；数据保留策略 | **计费选填闭环** |
| **M5（2 周）** | 打包+签名自动更新（含排空）；Anthropic/Gemini 走兼容适配层；一键写入 L2（带回滚）；打磨；⌘K/双语等后移项 | 体验收尾 |

工期节省来源：砍 Rust 重写（约省 4–6 周）、M3 探测与 M4 审计 L1 合并、M4 变薄——这些足以抵消 M0 新增与检测前移。

## 九、主要风险

- **协议长尾**：为每个适配器做录制-回放回归（SSE fixture 库，M0 建）。
- **价格表维护**：调价频繁→价格变更提醒+人工确认；默认空表+逐渠道选填，官方参考价仅带标注填入。
- **审计误报**：采样噪声、版本静默更新→分层告警+静默期+保守阈值，只提示风险不下结论；默认开启的检测必须成本透明（每日 $X 明示）。
- **探测成本**：每渠道每日预算上限，默认轻量套件。
- **范围失控**（v2 新增）：1–2 人团队，GUI 严守"8620 演进"路径，九页大GUI按需生长；所有"可砍"项（New API 引擎、Rust 重写、L2 默认开、Gemini 原生入口、DuckDB、多平台 Webhook、⌘K/双语）未经复盘不复活。

## 十、网关主入口化方案（v3，2026-10-14，kimi-k3/glm-5.3/deepseek-v4.1-flash 三模型评审 + 逐条裁决）

> 前提变更：Tauri 桌面壳已删除（只保留 CLI + 8620 WebUI）；下一迭代把「API 聚合网关」升级为唯一主入口：任意 OpenAI 客户端指向网关，全部流量经过程序，程序在其上做全流量监控、渠道持续检测、周期主动探测。

### 裁决后的七条铁律（三模型一致，全 [必须]）

1. **origin 贯穿**：每条账本/评分/告警记录必带 `origin: user|probe|health`；评分窗口按 `(channel, origin)` 二维开窗，探针流量永不混入用户流量统计与对账窗口。
2. **core 共用**：SSE 切帧/usage 提取/TTFT 计量从 guard 抽成纯函数库 `core/`（输入字节流+注入时钟，输出结构化事件），guard、网关数据面、探针三方共用同一份代码；`core/` 不 import 任何有状态模块，fixture 回放 100% 确定性覆盖。
3. **账本 append-only**：SQLite（node:sqlite 内置，WAL）不可变请求记录 + settlements 子记录，settle 幂等（`WHERE status='inflight'`，0 行受影响=重复结算不双记）；token 必记但可 NULL（NULL 必带 `token_source`/`token_missing_reason`，禁止写 0 冒充）；金额可空；`error_source: upstream|gateway|client` 三值必填——**渠道评分只消费 upstream，网关自身故障绝不冤枉渠道**；`upstream_status` 与 `client_status` 分离（客户端断开≠上游失败）。
4. **被动为主，探针为辅**：被动观测（免费、不可被针对性伪装）是第一信号源；探针结论最高只到 `suspect`，只有被动+主动双源一致才允许 alert/红线；两者矛盾 = **differential_treatment 独立告警**（中转站对探针给优待的铁证），绝不加权平均把矛盾洗掉。
5. **诚实 N/A**：低样本渠道不外推——n<5 不出分、n<20 不报 p95（只给 median+原始值）、n<30 标 provisional；任何评分输出强制带 `n` 与覆盖率披露（「总分 82，基于 4/6 维」）；缺失维度权重重归一化，N/A 永不记 0。
6. **观测降级不装瞎**：账本写失败/磁盘只读时转发照常（fail-open），但 healthz=degraded + 控制台横幅 + 评分卡标注数据缺口时段；TTFT 用单调时钟并附带事件循环滞后观测，滞后超阈样本标记剔除（本地工具最大误报源）。
7. **正文零持久化**：用户流量只存结构元数据（token 数、chunk 形态、finish_reason、has_tools/has_image、计时），正文内存解析后即弃；探针流量内容是自产的，可存全文做证据链——这条写进 schema（用户流量表没有 content 列）而非靠自觉；canary key 金丝雀测试钉死「key/正文不入日志/库」。

### 关键设计裁决（分歧处）

- **计费对账双轨**（kimi 账本即真相 vs deepseek/glm 静默窗口，二者互补非冲突）：① 网关直通模式——分子用账本 Σusage（全 origin），分母用余额 Δ，前提渠道声明 `exclusive_key=true`（key 被网关独占），false 则该维度 N/A；② 非独占 key——沿用探针静默窗口 Δ 法，窗口内落任何其他请求立即 contaminated 作废。重试纪律平移：billable 请求默认永不自动重试。
- **include_usage 注入默认关**（采 deepseek 保守派）：网关默认字节原样透传，不替客户端改请求语义（改了就不是"原样透传"且部分站会 400）；按渠道 opt-in，探针永远强制带 usage；上游因注入 400 时不重发（防双扣费），学习标记"该通道流式无 usage"→ N/A。
- **端口终态**：单进程双监听——8621=数据面（`/v1` 用虚拟 key `sk-mx-`，存量 guard 客户端零改动；显式声明渠道走 guard 透明兼容模式），8620=控制面（WebUI+`/__mx` 管理 API 用管理 token）；控制面永不代理、数据面永不吐 HTML。否决单端口混鉴权。
- **TTFT 双口径**：同时记 `upstream_ttft`（渠道评分用）与 `client_ttft`（体验用），本地网关开销不污染渠道结论。
- **per-install seed**（采纳 glm）：题集 seed 改为装机时随机、本地持久化，跨次运行仍固定（与基线对比兼容），但全网不再同一公开 seed，防针对性过题；被动观测是终极兜底。
- **熔断/回退/重试缓做**（三模型一致 + M6 opt-in）：熔断只"标记+告警"不自动切流（探针失败≠渠道不可用，不得用自己的本地故障诬告渠道）；自动回退默认关（回退会把"假模型"问题洗成"可用性"问题）；重试仅首字节前 + attempt 子记录链 + 窗口内对账作废。前置条件：网关承载真实日常流量稳定 ≥2 周。
- **多后端聚类后置（建议）**：中转站单别名背后可能轮询多后端——先做行为签名聚类（finish_reason 分布/delta 粒度/usage 形态），检出后报告「该别名疑似 ≥k 个后端」，指纹告警降级为簇级跟踪，不做单源硬比对。
- **key 持久化（建议，后置）**：默认仍内存；可选加密存储（scrypt+AES-256-GCM，零新依赖）或 OS 钥匙串作为独立小切片。
- **identity 指纹代价（披露即可）**：强制 `Accept-Encoding: identity` 是可识别特征，短期保留+文档披露；中期可评估透传+tee 侧解压（字节不再原样，需权衡）。

### M1–M6 切片（每片可独立验收，正确性 > 覆盖面 > 花哨）

| 切片 | 内容 | 硬验收（每条一命令） | Out-of-scope |
|---|---|---|---|
| M1 内核+账本 | core 抽取（guard 改依赖，旧测试全绿不动）；SQLite append-only 账本（origin/error_source/token_source、幂等 settle、崩溃恢复 inflight→interrupted） | `verify:sse`（逐字节切割回放+UTF-8 跨界+tee 零差异）·`verify:usage`（7 类畸形 fixture 表断言）·`verify:ledger`（hang/abort/dup-settle 恰好一个终态）·`verify:crash`（kill -9 后 integrity_check+无半行）·`verify:leak`（canary grep=0） | 评分、告警、探针、UI、重试 |
| M2 全流量被动观测 | 网关 tee→账本（origin=user）；模型一致性/usage 分类/双 TTFT/finish_reason/参数保真度（info 级）；`(channel,origin)` 评分卡三档样本量语义 | `verify:ttft`（role-only 假首 chunk 排除）·`verify:tz`（epoch ms 库内一致）·`verify:looplag`（注入 300ms 阻塞样本被剔除）·低样本 N/A 用例 | 主动探针、对账、告警外发 |
| M3 评分+告警状态机 | 去抖/冷却/静默/风暴熔断（>10 条/分钟折叠为单条摘要）；degraded 横幅；控制台渠道页（带 n 与覆盖率） | `verify:alerts`（脚本化事件流回放，发射时刻序列精确匹配）·`verify:degraded`（DB 只读→转发 200+healthz degraded） | 探针、Δ 窗口 |
| M4 探测调度+融合 | CLI test 抽库；L0 体检（max_tokens=1）/L1 身份/L2 手动全量；预算四闸门（金额/token/RPM 份额/并发）+泊松抖动；被动异常→定向确认探针；differential_treatment 告警；探测花费日报 | `verify:sched`（虚拟时钟 30 天预算零突破）·`verify:delta`（窗口中途落用户请求→void 且如实报告）·探针全文入库+用户正文零入库 grep 断言 | 完整 test 周期自动跑、熔断 |
| M5 对账+端口收敛 | 双轨计费对账（账本Σusage×exclusive_key / 探针静默窗）；8621 双模式数据面；guard CLI 保留（共用 core 零重复）；WebUI 接新 API（不加功能只换数据源） | `verify:ports`（8620 无 /v1、8621 无 HTML）·存量 guard 客户端零改动 e2e ·对账 fixture（并发/跨界/充值三类） | 多渠道重试/回退 |
| M6 可用性 opt-in（可无限期推迟） | 熔断标记+告警；首字节前重试（attempt 链+窗口作废）；显式回退记录 fallback_from/to | `verify:retry`（父请求+N 子尝试全链入账、恰好一次 settle） | 自动切流、负载均衡 |

### 反面清单（全 [必须拒绝]，三方一致）

1. 自动重试提成功率——双发计费污染对账、证据归因断裂；失败原样透传，客户端自己的重试如实记两笔。
2. N/A 记 0 / 用探针填用户流量样本空洞——几何均值下 0 分=诬告；缺失维度剔除+重归一+覆盖率披露。
3. 探针失败⇒渠道不可用（并自动切流）——本地网络抖动会变成诬告渠道还断真实流量；探针结论只到 suspect。
4. 多后端中转上做单源基线硬比对——30% 流量走灌水后端会让渠道均分来回摆、告警 flap；先聚类再下结论。
5. 用对话正文做检测证据/截留正文（含"只截一段错误体调试"）——一次违约，隐私承诺归零；schema 层禁止。
6. 把上游 usage 当真值——虚增/伪造常态；探针强制 tokenizer 对比，用户流量抽查。
7. 主被动分数加权平均——矛盾（被动 dirty+主动 clean）恰是最有价值的差异化证据，必须升格为独立告警类型。

### 总口径

**检测结论 = 证据链 + 样本量 + 污染标记 + 置信度 + N/A 边界**，不是"一个总分定生死"。每份报告都要经得起反问：「这个结论基于哪几条请求、什么口径、N/A 了什么、本机有没有嫌疑」。

### S1-S3 实施规格 + 双向审查裁决（2026-10-14，kimi-k3 正向 / glm-5.3 反向 / deepseek-v4.1-flash 裁决）

第一实施切片 = S1 账本（node:sqlite WAL，Node 22.22 已验证 DatabaseSync 可用）+ S2 tee 观测与实时用量 + S3 渠道告警。裁决「有条件通过」，3 项必修已并入规格：

1. **管理端点不落数据面**：用量/事件/健康（usage/events/health）全部走 8620 控制台既有 token 鉴权 API（/api/gateway/*），8621 数据面不新增任何无鉴权端点。
2. **settlement 同步落库**：requests 插入与 settlements 结算同步写、失败即 degraded 计数（fail open 转发），**绝不经有界丢弃队列**；丢弃队列仅承载可丢的观测指标。
3. **验收口径修正**：「/__mx usage 与账本 SUM 完全相等」仅在正常（非 degraded）窗口成立，degraded 期披露丢弃/差异计数，不再无条件断言相等。

采入规格的审查建议：client_status 枚举补 `interrupted`（启动恢复用）；settlements 冗余 channel_id/alias 列（聚合不依赖 join，requests 插入失败不产生口径失真）；落账矩阵（usage 被拒收→token 列 NULL + token_source='none' + missing_reason 取 missing|negative|inconsistent|absent，usage_valid=0）；model_mismatch 比较大小写不敏感 + 窗口内 ≥2 次才升级告警（T1 差异化防御的保守起点）；TTFT 漂移需 n≥20 + 绝对下限 300ms，低样本 provisional；告警重启后 5min 静默期防重发风暴（持久化后置 M5）；tee 全程逐帧 try/catch + tee_error 计数（观测失败绝不碰字节透传）；非流式旁路解析副本上限 2MB，超限跳过并计数；/v1/models 不入账本（仅网关计数）；amount 本切片恒 NULL（定价 M5）；user_version=1 + 「本版不清理」retention 声明；关闭顺序 = 停收新→观测 flush→wal_checkpoint(TRUNCATE)→close。key_hash 聚合维度、DatabaseSync 批量写压测、告警持久化：记录为后续项。

### 查漏补缺切片裁决（2026-10-16，两路审计 + 图纸双审「有条件通过」→ 3 必修已并入）

1. **ttft_high 命名裁决**：规格原文「TTFT 漂移」在本切片只实现「单窗口绝对下限」（未污染样本 n≥20 且 p95≥300ms）；与历史基线/相邻窗口比较的「漂移」语义未实现，命名如实改为 `ttft_high`，不叫 drift（名实必须一致）。
2. **client_ttft 口径硬化**：client_ttft 独立于 upstream 口径——打点通道覆盖 `res.write`/`res.writeHead`/`res.end`（首字节任何形态均捕获），且结算时机不得早于响应头写出（上游 500 错误体转发等路径 settle 延后到 writeHead 之后）；全程无写入才写 NULL，绝不写 0 冒充，也不以「上游流式/成功」为 gate。回归用例：上游 500 JSON（upstream=NULL 而 client 非 NULL）。
3. **静默期/冷却抑制诚实条款**：静默期早退不计入 `alertSuppressed`（那只计「规则已触发但被冷却拦下」，静默期规则根本不评估，冒充抑制次数=撒谎）；静默期效果以 `alertSilenceRemainingMs` + 粘性 `alertSilenceWasActive` 披露（过期后仍为 true，防「检查过没问题」假安心）。`/v1/models` 只进网关内存计数（requests.total/ok），不入账本；鉴权拒绝不计入 total。
4. **验收脚本降级披露**：`verify:*` 十条仅覆盖已实现切片；verify:sched/delta/ports/retry 属 M4–M6，故意不设（不设假验收集）。README 两侧已加映射表。
5. **已完成后置项（本切片顺带落地）**：面板静默/抑制披露行、轮询失败陈旧标注、污染剔除与 usage 缺失列、告警证据 id 展示、账本恢复（recovered）横幅。
6. **仍然后置**（按序入后续切片）：告警证据 id 的账本一键下钻；(channel,origin) 二维窗口键化；guard 与网关共用切帧器；n<5 / n<20 / n<30 三档样本量语义在网关侧对齐；TTFT 相邻窗口/历史基线「漂移」比较；风暴熔断（>10 条/分钟折叠摘要）。

### 聚合页体验重构 + Anthropic Messages 支持（v3.1，2026-10-18，用户验收驱动；不改七条铁律口径）

- **聚合页流程重排（四步）**：① 渠道与模型 → ② 启动本地 API → ③ 实时监控 → ④ 客户端接入；按钮统一 `.action-row` 修复间距（flex+gap，行内按钮清零 `margin-top`，回归锚钉在 webui 测试）；`ANTHROPIC_BASE_URL` 复制行按「不带 /v1」口径（SDK 自行拼 `/v1/messages`）。
- **一键获取模型**：`POST /api/gateway/probe-models`（8620，token 鉴权）由控制台进程代取上游 `GET {basePath}/models`——复用 ssrf 校验+钉定、15s 超时、2MB 上限；openai 走 `Authorization: Bearer`、anthropic 走 `x-api-key` + `anthropic-version: 2023-06-01`；key 只进请求头、响应片段 scrub；上游未实现 /models（部分 Anthropic 中转）时错误信息引导改手动添加。
- **渠道持久化语义变更**：渠道表从「挂在网关实例」改为控制台持有（`scripts/serve.mjs` 进程内持久 `ChannelStore`，`createAliasGateway({store})` 注入）：网关启动前即可配置、跨网关启停保留；控制台进程退出仍丢失（文案如实披露）。回归测试钉死「启动前配置 → 启动后数据面 /v1/models 可见」。
- **Anthropic Messages 协议（M5「Anthropic/Gemini 兼容适配层」部分前移）**：渠道 `protocol: 'openai'|'anthropic'`（严格枚举，400 带收到值与示例；update 保持现值、view 透出）；数据面扩为四条路由（+`POST /v1/messages`、`POST /v1/messages/count_tokens`）；`/v1/messages*` 双鉴权（`x-api-key` 或 Bearer，常量时间）；双向 409 `protocol_mismatch`（绝不触达上游）；上游 `${basePath}/messages`、强制 `x-api-key`、透传 `anthropic-version`/`anthropic-beta`、缺 `max_tokens` → 400；count_tokens 轻路径（真实转发、零账本、不进 usage 告警窗口）。tee 按渠道协议分派解析：`message_start`→usage.input、`content_block_delta`→首内容信号/TTFT、`message_delta`→ `stop_reason` 映射（`end_turn→stop`/`max_tokens→length`/`stop_sequence→stop`/`tool_use→tool_calls`）与 output_tokens 终值，非法形状降级 null 不抛；监控告警与 OpenAI 通道同口径（`truncated` 告警仍基于连接截断，与 finish_reason 无关）。
- **范围外（守住）**：无重试/回退/熔断、无定价（amount 仍 NULL）、Gemini 未做、正文零持久化不变。

### v3.2 unified 统一中转 + OpenAI Responses + 按模型价格计费（2026-10-18，用户第 8 条反馈驱动）

- **协议三值**：`protocol: 'unified'|'openai'|'anthropic'`（缺省 unified；缺省/非三值 400 带收到值+示例）。unified=统一中转按**客户端请求格式**透传（chat→/chat/completions、responses→/responses、messages→/messages，五条路由全通）；显式协议仅拒跨格式（409，不触达上游）。数据面扩为五条路由（v3.1 四条 + `POST /v1/responses`）。
- **OpenAI 第二种格式（Responses）**：`POST /v1/responses` 仅 Bearer 鉴权；上游 `${basePath}/responses`、Bearer + CLIENT_HEADER_ALLOWLIST；tee 观测 `TeeFormat='chat'|'messages'|'responses'` 按请求种类推导（与渠道协议解耦）；`sse.ts` 新增 `mapResponsesUsage`/`parseResponsesStreamPayload`/`responsesContentHasSignal`（纯函数降级绝不抛；`response.completed→stop`、`incomplete→length/原样 reason`、`failed→错误不落 tee`）。
- **一键导入移除**：前端导入解析器/接线/用例/README 描述全清（用户明示不需要）。
- **按模型 token 统计**：监控 usage 表 14 列（新增缓存/费用列）；`tokenCached`（chat cached_tokens / responses cached_tokens_details / anthropic cache_read）、`tokenReasoning`（responses reasoning_tokens）独立口径；`costUsd` 内存累计 + 账本 `settlements.amount` 实际落值（v3.1 恒 NULL 结束）。
- **modelPrices（可选录价，新建 `src/gateway/pricing.ts`）**：`{input, output, cachedRead?, threshold?, input2?, output2?, cachedRead2?}`（USD/百万 tokens）；`threshold` 严格大于时**整单二档**（`cachedRead2 ?? input2`）；cached>prompt 钳 0；不录价只统计 token，金额恒 NULL 绝不 $0。严格校验 400 带收到值+示例（键∈models、input/output 成对、阶梯三元组同在或缺省）；update `undefined→保持`、`{}→清空`、models 变更后重校验绝不静默失效；settle 按路由时刻捕获价、usageSummary 按「当前是否仍录价」判空。
- **验证**：全量 `npm test` 474/475（唯一失败 TTFT⑭ 已知抖动，隔离复跑 gateway 54/54 exit 0）；四契约文件新用例 117/117；e2e 驱动 15/15（mock 统一中转：unified 三格式路由+模型映射、threshold 阶梯费用、缓存按 cachedRead/缺省 input 价计、probe 三态、无虚拟 key 401）。
- **口径披露**：真实上游仅发 `response.completed` 不发 delta 帧时 TTFT 观测为 null（保守不伪造）；`response.failed` 错误消息 tee 无消费方不落字段（规格偏差留痕）。

### 修复：报告「清理（保留最新）」点击无响应（2026-10-18，用户反馈驱动）

- 根因两层：① 清理确认用 `window.confirm` 原生对话框，在内嵌浏览器/网页视图环境会被静默吞掉（点击零反馈、无请求）；② 目录里没有更旧工件时（deleted=0）只有一行小字，观感等同「没反应」。
- 修复：清理按钮改**两步点击确认**（首次点击进入待确认态：按钮文字变「再点一次＝清理」+ 琥珀色描边 + 提示文案；5 秒内再点执行；点其他位置/超时自动取消）——不依赖任何原生对话框；deleted=0 时明确显示「无需清理：没有更旧的报告/基线可删」；新增回归：webui 测试锁死「不得调用 window.confirm(」+ 两按钮均走两步确认；Playwright 真实浏览器 10/10（含 Playwright 默认自动 dismissal 对话框 ≈ webview 病态环境的复现口径、同戳基线保留、点外取消、清空全部）。

### 全功能审计 83 项 + 编辑回填两处修复（2026-10-18，用户指令「检查每一个功能 包括 webui 里的每一个功能」）

- **审计口径**：`tmp/mx-audit.mjs`（报告夹具仓库副本 + mock 上游 + Playwright msedge，全程不触真实仓库）三段 83 项——A 服务端 22 项（Host/Origin/token/CSP/穿越/越界/静态白名单/1MB body/错误脱敏/probe 复用与拒绝/渠道视图无明文 key/任务 dry-run 生命周期/405 Allow 头）、B 浏览器 60 项（三 tab 全交互：key 生命周期、运行携带输入 key 即用、命令预览逐参数精确匹配、预演流、渠道表单校验/取消/别名跟随/价格行同步/模型行移除同步缩价/去重探测/停启/启动/轮换+旧 key 401+点选全选/复制三键剪贴板内容、数据面三格式、用量表数值与费用、静默期披露、清理 409 互锁、停止复位、编辑回填、报告列表分流/「打开」链接实际可下载/评分卡/两步清理/keep-latest 文件系统语义）、C 清空后复核——全绿 83/83。
- **修复 1（`scripts/serve.mjs`）**：非 POST 方法语义——未知路径必须 404「未知的 API 端点」（原先一律回 405「该端点仅支持 POST」，文案说谎）；仅 `POST_ONLY_ENDPOINTS`（/api/key、/api/key/clear、/api/reports/clear、/api/test）上的非 POST 方法回 405，且 405 一律带 `Allow: POST`（静态 405 带 `Allow: GET, HEAD`，RFC 9110）。serve.test.ts guard 用例改 404 并新增「405/404 不得混淆 + Allow + 未知 POST 404 + 静态 Allow」行为用例；serve-console.test.ts 加源码钉子。
- **修复 2（`web/app.js`）**：编辑渠道价格行回填空白、保存静默清价——`channelForm.reset()` 只清价格输入值不清行元素，空草稿快照掩盖 seed；修复：`setChannelForm` 先清残留价格行再 `syncPriceRows(seed, true)`。
- **修复 3（`web/app.js`）**：编辑表单不恢复「允许本机/内网上游」勾选 → 私有上游渠道保存被 400 拒、公网渠道被静默翻转 false；修复：按 `channel.allowPrivateUpstream` 恢复勾选。两处均加 webui-wiring 源码钉子。
- **验证**：全量 `npm test` 520/520（含新增钉子）；审计复跑 83/83；e2e 单文件 38/38（全量并发下 usage-scale 两例曾见负载抖动，单跑与全量复跑均绿，属已知时间敏感模式）。
- **工作区**：根目录调试残留 tmp-hist*.mjs / tmp-verify-issue.mjs 已清除；审计与 e2e 脚本归档 `tmp/`（gitignore）；reports/ 按既定策略视为 runtime data（.gitignore 新增 reports/），tracked 旧报告删除保持 staged，随下次提交生效。
