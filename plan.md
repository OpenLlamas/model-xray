# 多厂商 AI API 聚合器：桌面 GUI 方案（v2，经三模型评审修订）

> 修订说明：v1 按"从零造聚合器"撰写。经 kimi-k3 / glm-5.3 / deepseek-v4.1-flash 三模型独立评审收敛：**本方案最大的问题不是缺功能，而是没有把已有的 model-xray 资产放进架构图**。v2 把命题修正为"model-xray 长成聚合器"，五点硬需求（体验优化 / 统计更准确 / 检测默认开启 / 异常警告 / 计费选填）全部在 M1–M2 默认点亮，总工期不增反降（约 12–13 周）。

前提：个人或小团队本机使用，上游既有官方 API 也有中转站；多人服务端部署不在本方案范围。

## 一、选型结论：以 model-xray 为底座演进，不重造轮子

- **model-xray（自有资产，本方案的底座）**：已落地 ①检测引擎（身份指纹 5–8 问、上下文 needle 实测、token 计数回归（本地保守估算）+ `--token-reference` 绝对对账、余额差值实测倍率、能力门禁 vision/tool/thinking、质量题集、TTFT、加权几何评分卡+硬红线、版本化指纹基线）；②guard 常驻监控透明代理（127.0.0.1 流式 tee 旁路解析 usage/TTFT、每 20 请求滚动窗口实时评分卡、异常即时告警、JSONL 落盘、one-api 余额对账、重试防污染）；③本地 Web 控制台（8620，页面录入 key 仅存内存、token 鉴权、三标签信息架构）。**桥接方式：检测引擎去 CLI 化抽成库；guard 直接演化为网关内核（多渠道路由是透明代理的自然扩展）；8620 控制台迁移为 GUI 底座。**
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

### 检测严谨性审计修复与 youhua/yh2 裁决（2026-10-18，用户指令「逐维度核查 + 查漏补缺」）

- **P0 修复（全部带回归）**：needle 编号/口令分离（复述问题里的编号不算命中）；上下文边界空响应终止扫描、按 blank 披露不判截断；usage 校准门——自报 prompt_tokens 对照实际发送量核深度，未校准的「通过」降为无法判定（--deep 完整边界扫描的确定性证据豁免该校准门）、自报上偏超带宽（>4×）不采信；identity 否定语境不声明被否定族（「not only/not just/不只/不仅」强调句不算否定的防漏判修订）；上游回显删节（裁掉能力变体后缀，如 qwen2.5-72b-instruct→qwen2.5、glm-5.3-flash→glm-5.3）按可疑计；capability vision 只认单一盘内颜色词、415/422 计入显式拒绝。
- **计量/质量加固**：余额读数非美元口径作废实测倍率（quota 单位不换算）；Δ 或应缴金额低于读数最小刻度 3×按精度噪声作废；>10× 差值按账户级不可归因处理（N/A + `ratio_masked_verdict=fail` + warn，不假 fail）；quality 准确率披露 95% Wilson 置信区间（仅披露，0.9/0.6 阈值不变）。
- **2026-10-18 计费假 fail 修复留痕**：真机 `/dashboard/billing/usage` 返回非整数美分（13058.6184），旧代码按 ÷100 当 USD 使用，$2.69 账户级抖动 ÷ $0.019 应缴 → 142.975× 假 fail 30。修复：只接受整数美分，非整数（单位未知）拒绝该接口；应缴金额低于 3×余额分辨率判 N/A；>10× 差值不再判 fail（保留原始倍率 + masked fail + warn 归因提示）。README 同步删除「官方 tokenizer 对比」过度声明。
- **youhua.md 裁决**：①EN README TTFT 权重 10 与代码 WEIGHTS ttft=0 矛盾——采纳，EN 已对齐「TTFT 仅观测不计分」；②「质量口径 v0.2.2 对不上 package 0.2.0」——核实 v0.2.2 是题集版本 PROBESET_VERSION（assets.ts）而非 package 版本，属表述歧义，中英文档改写为「题集版本 v0.2.2」消除歧义；③README baseline ratio 阈值「笔误」——核实为误报（与 gradeRatio 实现逐字一致，不改）；④README「仓库托管官方公开报告」与 .gitignore（reports/ 全量忽略）矛盾——采纳，中英文已改为「报告生成本机 reports/、属运行数据不入库」。
- **2026-10-19 identity 判级自相矛盾修复**：真机报告 `report-glm-5.3-flash-2026-10-19_01-11-14.json` 中，5 条自述全部指向 DeepSeek（falsified）本应 fail 0，但回显 `deepseek-flash` 的 warn 分支无条件把 level 改回 warn，导致「分项 WARN 0 分 + 总分 FAIL 0」并掩盖更强结论。修复：回显异常只把 pass 降为 warn，不得下压已定 fail；falsified 的 `身份矛盾` headline 不被回显文案覆盖。新增回归：falsified + 6/6 回显不一致仍为 fail 0，且回显 warn finding 保留。
- **2026-10-19 查漏补缺（context / capability / quality / identity）**：①context 400 显式拒绝前沿改为从「首个整档被拒的高深度档」起判定——50% 可读、75%/90% 整档 400 不再被漏判，75% 前沿可在 50% 偶发 400 后仍正确复验；前沿更深档出现任何有效应答才拒绝定罪。②capability 中某宣称能力为 na、另一项 pass 时，旧逻辑只把 pass 计入 parts 并输出 100 分「全部实测通过」；现保留 `unverified` 并判 insufficient（已测项通过但未测项不得静默消失）。③vision 判色先剔除否定短语（not blue / isn't blue / non-blue），避免把否定回答计为颜色命中。④--deep 下部分深度无有效样本但其余深度/边界扫描通过时，pass 标题不再宣称「needle 全部命中」，改为披露缺失深度（新增回归）。⑤quality 判题把小数整体解析，整数题答 42.5 不再因包含 42 被判对（42.0 仍算对）。⑥vision 在仅有 1 个有效作答且答错、其余为空/截断时，不再凭 0/1 判 fail，改为 na（证据不足）；显式 4xx 全部拒绝或 ≥2 个有效作答全错仍判 fail。⑦identity 旧逻辑用含空响应的 `samples.length` 作 falsified/多数告警分母：2 条他族自述 + 空响应会因样本数不足 3 跳过定罪与多数告警并输出 PASS 100；2 条他族 + 1 条中性 + 2 条空响应也会被稀释成 PASS。现少于 3 条有效自述一律不出分：2 条一致也 insufficient，1/2 条族失配仅 warn（不 falsified）；falsified 与多数告警改用有效自述数 `answerable` 作分母（3 条有效全 mismatch 仍可 fail，空响应不再稀释）。⑧vision 混合样本（1 个有效错误 + 1 个 415/400/422 + 1 个空响应）不再单凭 4xx 判 fail；3 次图像请求全部显式 4xx 才判 fail（单次 415 + 2 空响应 → na），否定正则覆盖 `not blue or/and green` 并列项、`not blue/green`、`not only/just red`（`not blue but green` 仍保留 green）。⑨`answerable` 纳入 2 字族名（如「豆包」「文心」），避免 mismatch 大于分母。⑩仅 1 条他族自述 → insufficient warn（披露 1 条族失配，但不 falsified/不出 0 分）。⑪多族对冲声明（如「我是 GPT，也是 Claude」）不再因含目标族被 `some(has)` 洗成一致：纯他族计入 `mismatch`，混合声明计入 `mixed`；全体混合/混合+纯他族达多数 → warn 60，少量混合（如 1/5）→ warn 80，falsified 仅在全为纯他族时成立。mixed 只统计第一人称自归属分句，合法比较句（`I am GPT-4o similar to Claude`）、引语/prompt 回显不触发混合告警。新增三条 context 回归、四条 capability 回归和八条 identity 回归。
- **仍未实施（如实留痕）**：per-install seed（当前默认按运行时间生成；plan v3「装机随机+本地持久化」待落地）；真值标定/故障注入中转台与官方参考臂全量方案（依赖官方 key/本地权重，本轮只做确定性证据与噪声门）；`--strict` 与退出码拆分；tokenizer 精确计数（`--token-reference` 已可对账）；`verify:*` 一对一拆分；npm `files` 补 web/scripts；同族降级专项题集与多后端聚类；网关 ttft_high 相对阈值；--key 移除（破坏性 CLI 变更，改环境变量/交互输入）；余额接口格式可配置（当前固定 one-api/new-api 系）；plan.md 移 docs/；时间敏感测试（TTFT⑭/usage-scale）改注入时钟。yh2「删总分/TTFT 计分/身份计分/砍网关」属产品级取舍，维持不采纳。
- **验证**：`tsc --noEmit` exit 0；全量 `npm test` 654/654 全绿（含本轮计费假 fail 回归、guard 整数美分与非美元口径对账、identity falsified+回显一致性/空响应分母/2 字族名/1 条他族 warn/多族混合声明/比较句不误伤回归、context 400 前沿/缺失深度披露、capability 未判定/vision 0/1/混合 4xx/单次 4xx 证据不足回归）。
- **2026-10-19 billing 证据分级：无绝对对账不得 PASS**：旧实现只在 headline 里披露「未做绝对对账」，仍出 score=100/pass，而线性回归只能证明形状——全量等比缩放（×1.3）、常量偏移、completion_tokens 伪造完全不可见，真实报告因此误报 PASS 100（用户复盘）。修复：（1）新增证据分级 gate——`reference_verified`/`ratio_verified`/`absolute_reconciliation`/`evidence_level`，无绝对对账且形状正常时返回 status=insufficient / score=null / level=unknown，headline「仅验证 usage 与输入长度线性；缺少绝对对账，计费真实性无法判定」，总分随 billing 缺证据不出（missingCore），CLI 退出码 2 并给出「补 --token-reference 或价格+余额」的错误提示；（2）新增 completion_tokens 硬矛盾检查（非空正文却报 0、超过请求 max_tokens=16）→ warn 封顶 70，补 `completion_zero_with_text`/`completion_over_cap`；（3）部分缺 usage、请求失败、窗口内重试均 warn 封顶 70，阻止 PASS；（4）实测倍率一致带收紧为 0.8–1.1（[0.5,0.8) 改 warn，不再写「与宣称价格一致」）；（5）mock 夹具现在遵守 max_tokens（completion 不得超上限）。测试：单元新增「无绝对对账→insufficient」「completion 异常→warn」「部分缺 usage→warn」「0.6 倍率→warn」；reference 模型/题集版本不匹配改为 insufficient；e2e usage-scale 1.3 无参考改为 insufficient/total null；honest 用例改为带价格+余额对账；CLI 新增「无绝对对账退出 2」用例。
- **验证**：billing 单测 43/43、e2e 40/40 全绿（本轮新增环境：带价格/余额对账的 honest 全量）。
- **2026-10-19（后）billing 判定对象收敛为 usage：形状全过即出判定，不再悬置**：上一条「无绝对对账→insufficient」实施后真机复跑仍被用户否决——用户口径：本维度核验对象就是端点自报 usage，形状/一致性/输出侧全过时必须给出「usage 是否准确无误」的明确结论，不得因缺绝对对账悬置为 N/A、扣掉总分并退出 2。修复：证据分级 gate 改判——`absoluteVerified`（reference 或 0.8–1.1 倍率）成立仍 100；仅有形状证据（线性+total=prompt+completion+非负+completion 硬矛盾+恒定检测全过、窗口干净）返回 status=ok / level=pass / score=85（`SHAPE_ONLY_SCORE`），headline「usage 计数核验通过，未发现造假证据（未做绝对对账，扣费金额真实性未验证）」+ info finding 披露 ×1.3 等比缩放只有 --token-reference / 价格+余额能识别，`evidence_level: shape-only` 如实透出；warn/fail 判据全部保留不变。CLI 移除「缺少绝对对账退出 2」专用分支（total null 只会来自真实样本不足）。真机回放验证：报告 `report-glm-5.3-flash-2026-10-19_09-19-30.json` 的 10 笔实际 prompt_tokens 重放 → slopes 0.656/0.528、R²=1.0，判 pass 85（原为 [N/A] insufficient）。测试：单测「无绝对对账→insufficient」改判 85+披露、reference 模型/题集版本不匹配同口径改 85；e2e usage-scale 1.3 无参考改 pass 85（total 非 null）；CLI「无绝对对账退出 2」改为「无对账仍出 usage 判定退出 0」。README 中英文同步（billing 判级说明、中文「Token 计数对比」行、边界条款）。

### 2026-10-19 韧性切片：瞬时过载不得报废整维度 + 失败归因（某中转站 503 真机复盘驱动）

- **根因复盘**：真实报告 `report-glm-5.3-flash-2026-10-19_03-39-05.json` 中 13s 过载窗口（11/41 笔 HTTP 503 system cpu overloaded）导致 identity 6/6 全 503 → UNKNOWN、billing 三档全 503 → insufficient，工具对瞬时过载过于脆弱且 UNKNOWN 未说清是谁的问题。
- **重试分层（src/client.ts）**：新增 `--http-retries <n>`（[0,6]，默认 2）——429/503「网关层拒绝」（未进入推理、通常不计费）用独立预算重试，`Retry-After` 优先采纳（上限 5s）+ 抖动退避；与 `--retries`（200 空正文）分开计预算；运行级 `retryBudget`（默认 24，跨请求共享）限制端点整体过载时的重试放大。
- **污染口径收窄（层 3 审查 3 必修全采纳）**：① `contaminatingRetry` 请求级**粘性**（`200空→503→200` 交错序列不得被后续 5xx 复位）；② 豁免仅限 429/503——408/409/500/502/504/超时/网络错误仍判「可能已计费」污染（POST 非幂等）；③ 配额耗尽（429 quota）不消耗重试预算维持不变。
- **billing 指标拆分**：`retried_requests`（attempts>1 观测计数）与 `contaminating_retries`（可能已计费的重试）分开；只有后者作废实测倍率、封顶 70；`retried_requests` 不再触发任何惩罚（诚实披露）。billing insufficient 标题改为带主导错误归因（「计费探针有效样本不足，无法运行回归；主因：端点/网关拒绝（N/M 笔）：HTTP 503…」）。
- **失败归因（新建 src/diagnostics.ts）**：`categorizeFailure`（gateway/auth/not-found/network/endpoint-error/other）+ `summarizeFailures` + `failureDigest` + `runFailureDigest`；错误详情白名单化（状态码+截断 90 字+去控制字符防 ANSI 注入）；文案称「端点/网关」而非「上游」（natapp 隧道场景 503 实为网关返回）；identity「无有效样本」标题与 runner notes（运行级失败汇总+建议）接入；明确不做：端点预检/健康门、放宽 billing 每档 ≥3 样本门槛、把 5xx 记为模型问题。
- **范围外**：不自动放宽任何 fail 判据；UNKNOWN 仍如实呈现，只是说清是谁的问题并给建议（错峰重测等）。
- **验证**：全量 `npm test` **672/672**（新增：client 重试分层×4、billing 污染口径×2、identity 归因标题×1、diagnostics 单测×5；既有断言按新口径对齐：billing insufficient 标题、e2e flaky500 污染指标）；`tsc --noEmit` exit 0；`git diff --check` exit 0。README 中英文同步（--http-retries、污染豁免口径、503/UNKNOWN 排查行）。

### 2026-10-19 五维度收口切片（billing 输出侧/identity 变体/quality pass@1/context 早停与预算/badrelay 标定台）

- **图纸双审留痕**：`dual_review` 裁决「有条件通过」，3 必修项逐条裁决后全部采纳：① balance `quota_per_unit` 校准不可达时不计分、余额只采信 `total_available`；② quality fail 需「复采样未恢复至 0.6 线」前提、pass 只认首答 ≥0.9、基线 `metricVersion:'pass1'` 守卫；③ context 早停必须满足「90% 档 ≥2 发有效 needle 全中 + usage 校准可信 + 该档干净」，samples=1/usage 不可信/有未命中一律不早停。
- **billing 输出侧合计比对（src/probes/billing.ts）**：Σ(可见 completion = completion − reasoning_tokens，仅 `finish=stop`) ÷ Σ(正文本地估算) > 1.35 → 疑似输出 token 灌水，warn 封顶 70；< 0.6 → 仅提示；回归非零常量偏移（finite r²≥0.9 且截距超 `INTERCEPT_WARN_TOKENS=120`）同样 warn。真机实证：中转对普通复读也报 `reasoning_tokens=1`，需扣除推理 token 后比对。usage-scale 1.3 e2e 改为真阳性：mock billing 回 `NO_PASSPHRASE`（13 字符）走「校验」口令分支 → ×1.3 后 visible/est = 1.5 越线，合法抓到输出侧灌水。
- **identity 变体冲突（src/probes/identity.ts）**：`TARGET_IDENTITY_RE` 族前缀+X.Y 版本+变体后缀比对——同族不同变体（宣称 glm-5.3、自述 glm-5.3-flash）→ warn 封顶 80；跨族 → fail 0。变体分隔符只认 `[-._]`（含 `\s` 会吞 "by" 产生假冲突）；benign 裸别名（latest/preview/beta/exp/experimental）归一为空不参与冲突；否定守卫含「不叫」；触发=精确版本题 1 条冲突或 ≥2 样本同一冲突变体。单测 62/62。
- **quality pass@1（src/probes/quality.ts + src/baseline.ts）**：`firstCorrect = mainCorrect − recoveredCount`，`metrics['main']`=pass@1、`metrics['main_recovered']`=两次机会、`metric_version='pass1'`；rescued（首答<0.6 但复采≥0.6）→ warn 封顶 80；旧「过半依赖复采样 cap80」分支删除。基线 metricVersion 守卫：旧口径基线与 pass1 本次混比 → 跳过质量对比 + notes 提示重建，其余维度照常比较。单测 29/29 + baseline 25/25。
- **context 降序执行 + 早停 + 软预算（src/probes/context.ts + src/cli.ts）**：`DEPTHS` 改降序 [0.9,0.75,0.5,0.25]（省 75% 发送量），frontier 判定（fullyRejectedHighDepths/highTiers）改升序找首个整档被拒档；早停四条件（DEPTH_TOP 档、samples≥2、全中、usage 校准可信且档干净）→ 浅档 skipped 披露、不计缺失深度；`--context-budget-usd <n>` 软预算（`createSpendTracker`，须与价格成对，估算超限即停发 needle/回显/边界扫描，pass 只建立在停发前证据 → insufficient + 披露估算花费，warn/fail 结论保留）。单测 38/38 + CLI e2e 2/2（缺价格对/非数字 fail-fast 零请求；'-0.5' 被 parseArgs 判 ambiguous 属另一 exit 2 路径）。
- **badrelay 标定台（test/unit/badrelay-fixture.ts + badrelay.test.ts）**：7 场景检出矩阵（honest 反锚点/usage-scale 1.3→billing warn/relabel→identity fail 0/persona-inject→warn 80/truncate-7000→context warn/retry-fix-12→quality warn 80/组合）。mock-server 新增与 mode 正交的组合旋钮 `truncateAtTokens`/`retellAs`/`scaleUsage`。组合场景如实记录真实遮蔽：截断抵消输出侧 ratio 信号（0.733 落正常带）→ billing shape-only pass 85，但「等比缩放不可见 + 未做绝对对账」披露必须存在（专测钉住）——诚实降级而非假装全知。
- **README 中英文同步**：质量口径 pass@1（注意 PROBESET_VERSION 仍为 v0.2.2，未 bump）、identity 变体冲突、context 早停/预算、billing 输出侧合计比对+截距、实测倍率 new-api 端点（/api/usage/token + /api/status 校准、baseUrl /v1 剥离）、--context-budget-usd 参数行、基线 metricVersion 条款。
- **暂缓（未擅自补）**：分词器指纹、L0 零成本信号、跨探针复用 usage、多针 needle、SPRT/流水线、new-api 逐请求日志对账、稳健回归离群剔除、completion 控制题校准。

### 2026-10-19 查漏补缺（对照 chroe.md 全清单复核）：余额快照稳定化 + temperature 400 去参回退

- **复核结论**：chroe.md 逐项对照——已落地：badrelay 标定台（§1 部分）、计量差分截距/completion 合计比对（§2 部分）、pass@1 质量口径（§4 主项）、needle 降序早停+预算（§5 主项）、TTFT 文档矛盾/别名快照归一（§6）；既定暂缓（勿擅自补）：离线 tokenizer 参考表、跨探针复用 usage、网关被动 Theil–Sen、L0 零成本信号、分词器指纹、SPRT、多针 needle、流水线、new-api 逐请求日志/倍率表对账、题集程序化生成——均依赖官方 key/大改题集/网关重构，留痕见上。
- **余额 post 快照稳定化（src/balance.ts `probeBalanceStable` + billing 接线）**：chroe §2「post 快照要轮询到连续两次读数稳定再取」。计费序列结束后以 400ms 间隔重读余额（上限 3 次额外），连续两次一致才认稳定；轮询上限内仍在变化（异步结算极慢/账户级并发）→ settled=false → 并入「实测倍率作废」闸（Δ 不可归因，info 披露不 fail）。异步结算延迟下单次读数会让 Δ 偏小、把诚实站点误判成低报 warn——这是本轮查出的真实误报源。余额 GET 不消耗模型 token。metrics 新增 `balance_post_settled`（1/0/null）/`balance_post_polls`。
- **temperature 400 去参回退（src/client.ts）**：chroe §4「部分模型拒绝 temperature 参数（400），不该记成能力失败」——旧实现全维度请求带 temperature，被拒时每条探针请求失败 → 全报告 insufficient。现在 client 层对「400 且错误体含 temperature 且本请求带该参数」自动去参重发一次（不占 httpRetries/retries 预算；400 参数校验不进入推理、不计费，不置污染）；`ChatResult.temperatureDropped` 披露并写入证据（EvidenceResponse 同步）。attempts 如实 +1。回退只做一次，仍 400 则如实失败。
- **测试**：balance 单测 19/19（新增稳定化 4 条：收敛取稳定值/上限内仍动 settled=false/首读即稳 2 次即停/端点不可达 null）；client 单测新增去参回退 4 条（去参成功不污染/非 temperature 400 不回退/回退后仍 400 如实失败/本无 temperature 不触发）；report 夹具补 temperatureDropped 字段。README 中英文同步（实测倍率稳定化条款 + 400 temperature 排查行）。

### 2026-10-19 偷调倍率专项（再次查漏补缺，图纸双审「有条件通过」5 必修全采纳）

- **复核结论**：实测倍率链路存在三个真实缺口——① pre 快照单次读数：窗口前未结算旧账会混入 Δ 推高倍率（诬告方向，post 稳定化只堵了漏计方向）；② expectedCost < 3×余额分辨率（整数美分端点 + 便宜模型）必然 N/A：余额端点可用却测不出；③ one-api /api/user/self 为 raw quota 单位 + 用户级口径：按非 USD 整体作废（永远测不出），且其他 key 并发消费可落 (1.5,10]（>10 门兜不住）。另修复候选探测隐藏缺陷：/api/* 候选原先打在 /v1/api/*（真实部署永远 404），现剥 /v1 后从站点根探测。
- **必修落地**（dual_review 5 项全采纳）：① pre 稳定化 + 「首比即稳才认净」（polls≤2）：短窗内读数仍在动 = 窗口前有未结算消费 → 并入污染闸 N/A info；② /api/user/self 用户级来源禁出 fail：>1.5 降 warn + maskedVerdict=fail 记入 metrics（定论级指控只认 key 级），regressionLevel=fail 分支同受约束；③ top-up 硬预算：3× 目标额（按宣称价，含重试最坏放大），超限即停；④ top-up 触发守门：窗口干净（无失败/污染）+ pre 首比即稳 + USD 口径 + ≥1 有效计价样本，补采中首个不可归因事件（失败/污染重试/usage 缺失）立即停；⑤ qpu 校准量级守卫（1~1e12）+ pre/post resolution 一致性（spendBetween 不一致返回 null——qpu 中途变更产伪 Δ）。
- **top-up 参数**：TOPUP_PROMPT_TOKENS=48000、TOPUP_MAX_REQUESTS=8、目标 5×resolution（作废门 3× 留裕量）、预检（8 笔全有效仍到不了作废门 → 整段跳过不付费，billing_topup_skipped=1 披露）；补采样本只进 Δ/应缴/ratioSamples，不进回归轨道与输出侧比对；metrics billing_topup_requests/billing_topup_expected_usd。
- **顺带修复**：billing.test 4 处 per-reads 余额夹具迁移（>=2 → <=2 两段式，适配 pre/post 双稳定化轮询）；e2e balanceSeries [9950,10000] → [9950,9950,10000,10000]。
- **测试**：全量 725/725（+9：decideRatio user 级禁 fail 三分支、pre 未即时稳定作废、top-up 触发/跳过/首败即停 3 条端到端、/api/user/self 校准可达/不可达/量级异常 3 条、spendBetween resolution 一致性）；tsc --noEmit 0；README 中英文实测倍率行双更新。
