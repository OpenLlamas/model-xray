# guard journal（JSONL）条目契约

guard 的审计日志为 JSONL（每行一个 JSON 对象），文件名随运行目录产出（`--out` 下）。本文件是**对外消费契约**：guard 自身只写不读（仓库内唯一逐行解析方是测试）；外部聚合/重放工具以本文为准。

## 脱敏红线（所有条目）

- 不含对话内容、不含任何凭证（key / Authorization / token 值）；
- `errors` 只允许 `{code, status}`，不落上游错误体；
- `path` 不含 query。

## 条目类型判别

每行必带 `type` 字段：`request` | `reconcile` | `anomaly` | `fingerprint` | `score`。TS 结构定义以 `src/guard/journal.ts` 为准（单一事实源）。

## reconcile 条目：金额口径契约

```jsonc
{
  "type": "reconcile",
  "spendDelta": 0.13,      // 差值，单位见 deltaUnit
  "rawDelta": 13,          // 未换算、不圆整的原始差值（与读数同单位，必保号 —— 含 -0/极小负值）
  "deltaUnit": "USD",      // 同行 spendDelta 值的单位
  "ratio": 1.3,            // spendDelta / 窗口应缴（verdict 非 skipped 时存在）
  "verdict": "ok" | "warn" | "fail" | "skipped" | "skipped_recharge",
  "message": "…"
}
```

### deltaUnit 取值域与聚合规则（硬约定）

1. **`deltaUnit: "USD"`** —— `spendDelta` 已换算/校准为美元口径，`rawDelta` 是换算前的原始差值。聚合美元账面时**只允许纳入 `deltaUnit === "USD"` 的行**（严格等值比较 `=== 'USD'`）。
2. **`deltaUnit: "<raw 单位字符串>"`** —— 该行 verdict 必为 `skipped`（单位无法换算）；`spendDelta` 原样落 raw 差值、`rawDelta` 与其相同。此类行**禁止**与美元金额相加（会重演单位混算，如 quota 直加 USD 产出天文倍率）。当前取值集合：`total_usage_raw`（OpenAI total_usage 原始透传）、`quota`（one-api/new-api 原始额度，缺换算率）、或站点自报的其他单位字符串（原样透传，取自余额读数 `unit` 字段）。消费方对未知单位按「不可聚合」处理，不要枚举白名单后丢弃。
3. **`rawDelta` 与 `spendDelta` 三角一致**：`deltaUnit === 'USD'` 时 `spendDelta = rawDelta × 换算系数（>0，符号不变）`；否则两者相等。`spendDelta` 展示圆整到 6 位小数，`rawDelta` 恒为原值（不圆整，判充值用的 raw 符号锚定依赖它）。

### 旧数据兼容（无需迁移）

`rawDelta` / `deltaUnit` 是**增量可选**字段，随本轮 raw 透传口径引入；JSONL 无全局 schema 版本号，靠可选字段渐进兼容：

- **旧行（缺失两字段）**：`spendDelta` 恒与余额读数同单位（旧版实现只产美元口径或整体 skip，非美元站一律 skip 不落 spendDelta）。消费方可按 `balanceAfter.unit / balanceBefore.unit` 推导实际单位。
- **新行必带**两字段（`rawDelta` 恒有值或 null）。

### verdict 语义

- `ok` / `warn` / `fail`：实扣倍率分级（gradeRatio：|ratio-1| 同时超绝对 0.05 与相对 0.2 → warn；ratio > 1.5 → fail）。
- `skipped`：证据不足（余额不可得 / 不同源 / 单位口径无法校准 / 窗口无有效 usage / 分母不完整 / 计算越界 / NaN 差值）。
- `skipped_recharge`：窗口内余额上升超过读数最小刻度（`spendDelta < -max(resolution)`），疑充值/退款混入——不出 ratio。

## 变更纪律

新增/变更条目字段必须在本文同步（对外契约）；TS 类型（`src/guard/journal.ts`）与本文一并更新。增量可选字段不需要迁移；破坏性形状变更需在 `type` 或条目内引入显式版本字段。