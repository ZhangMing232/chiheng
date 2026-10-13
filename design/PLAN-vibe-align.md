# 赤轨 × Vibe-Research 对标改造方案

> 2026-10-11 · 基于 Vibe-Research v2.2.1 源码实测与赤轨当前代码状态
>
> **一句话结论**：Vibe 是「研究工具」（人驱动，AI 辅助解释），赤轨是「自我进化系统」（系统驱动，AI 提议 + 预登记判决）。
> **学它的证据纪律，不学它的产品形态。**

---

## 一、两条路的本质区别

| | Vibe Research | 赤轨 |
|---|---|---|
| 谁驱动 | 人发起一次研究 | 系统每晚自动跑闭环 |
| AI 干什么 | 解释编排器取好的数据 | 提议因子/参数，**判决由预登记函数给** |
| 产物 | 一份研究报告 | 一个会自己进化的策略库 |
| 核心资产 | 168 个数据端点 + 六阶段 SOP | 冠军-挑战者 + 因子 6 关 + 三层闸门 |

**所以**：把 Vibe 的**证据纪律**补进赤轨的进化闭环，而不是把赤轨改成 Vibe 那样的一次性研究工具。

---

## 二、差距清单（按价值排序）

| # | 差距 | 赤轨现状 | Vibe 做法 | 价值 |
|---|---|---|---|---|
| 1 | **证据溯源** | ❌ 完全没有 | `raw/`+`evidence.json`+`calculations.json`(DAG) | 极高 |
| 2 | **可信度分级** | 只有 pending/tested/tombstone/passed | 四档（含"被反证"），必须带依据 id | 高 |
| 3 | **数据源 registry** | 散在各 loader，口径陷阱写在注释里 | 168 端点，标合规级/阶段/关键/量纲 | 高 |
| 4 | **编排器 vs 大脑分离** | AI 能间接碰到数据 | AI 无 Shell/无网络，只读产物 | 高 |
| 5 | **确定性计算层** | 部分确定性 | `calc/` 强制，禁止心算 | 中 |
| 6 | **技能可插拔** | 无 | `.agents/skills/` 每技能一目录 | 中 |
| 7 | **禁止投资建议** | 无约束 | 宪法明令禁止，诱导也不给 | 中（合规） |
| 8 | 多市场 | 仅 A 股 | A/美/港 | 低（暂缓） |
| 9 | 研报库 RAG | 无 | PDF 导入 + 引用回查 | 低（暂缓） |
| 10 | 会员制 | 无 | 也无（本地优先） | 独立议题 |

---

## 三、分四期落地

### P0 · 证据溯源（最缺，也最值钱）

**问题**：因子判决、挑战者判决现在**都回答不了"这个数字当时是怎么算出来的"**。
一旦口径出问题（比如昨天的时区 bug），没法回溯。

**新增 `src/lib/market/evidence.ts`**（纯逻辑，可单测）：

```ts
/** 一条证据。对应 Vibe 的 evidence.json 单条。 */
export type Evidence = {
  id: string;            // sha256(source|endpoint|symbol|fetchedAt)
  field: string;         // 如 "close" / "d60" / "announcementTitle"
  value: number | string | null;
  unit: string;          // 元 / 万元 / 千元 / % / 手 / 股
  period?: string;       // 报告期或交易日
  asOf: string;          // 数据的时间点
  source: string;        // tencent / eastmoney / cninfo / baostock
  endpoint: string;      // 具体端点
  fetchedAt: string;
  rawRef?: string;       // 原始落盘文件路径
  rawSha256?: string;
};

/** 一次计算。对应 Vibe 的 calculations.json 单条。 */
export type Calculation = {
  id: string;
  fn: string;            // 函数名，如 "spearman" / "tStat"
  inputs: Record<string, unknown>;
  refs: { type: "evidence" | "calculation"; id: string }[];  // 计算 DAG
  output: number | null;
};
```

**改动点**：

| 文件 | 改什么 | 工作量 |
|---|---|---|
| `src/lib/market/evidence.ts` | 新增（纯逻辑 + 落盘） | 0.5 天 |
| `src/lib/market/factors.ts` | `analyzeFactors` 输出每条带 evidence | 1 天 |
| `scripts/backtest.ts` | 因子检验落盘 `runs/<id>/evidence.json` | 1 天 |
| `src/lib/market/challenger.ts` | Welch 判决记 calculation DAG | 0.5 天 |

**风险**：低。纯新增 + 落盘，不动判决逻辑本身。

---

### P1 · 可信度分级 + 数据源 registry

**1) 可信度四档**（照搬 Vibe，不用"高/中/低"）：

```ts
export type Confidence =
  | "disclosed"    // 已披露证实（公告/财报直接证实）
  | "inferred"     // 有依据的推断（由本次证据推出）
  | "unverified"   // 未核实线索（只有标题/传闻，或本次没取到）
  | "refuted";     // 被反证（本次证据与之矛盾）
```

**关键约束**：`disclosed` 和 `inferred` **必须带依据 id**；没依据只能标 `unverified`。

**接入**：`factor-queue.ts` 的队列条目加 `confidence` 字段；`decay.ts` 的状态机加 `refuted` 档（现在只有 passed/monitoring/decayed/retired）。

**2) 数据源 registry**（新增 `src/lib/market/registry.ts`）：

```
每个端点标：市场 | 源 | 合规级 | symbol_kind | 阶段 | 关键标记 | 量纲陷阱
```

把你已经踩过的坑固化进去：
- 腾讯：科创板成交额单位**元**、主板**万元**（差一万倍）
- 新浪：d5/d10/d20/d60 **全 null**、volRatio=0
- 巨潮：`stock` 必须 `代码,orgId`；`announcementTime` 是**北京时间**毫秒
- 东财：资金流历史**封顶 120 交易日**

**阶段标记**（照 Vibe）：`profile:required` / `financials:required` / `valuation:optional`。
**关键端点失败 → 状态 incomplete，不编值、不拿旧值冒充。**

---

### P2 · 编排器/大脑分离 + 技能可插拔

**核心**：AI 碰不到数据源，只能读编排器给的产物。

赤轨现在 `callAI` 直接收 prompt 字符串——虽然 prompt 里只有统计量（隐私干净），
但**架构上没有隔离**。改成：

```
编排器（有网络、有 fs）
  → 取数、落盘 evidence
  → 把产物摘要交给大脑（5 个受控工具）
    → 大脑只能：读产物 / 调确定性计算 / 写提议 / 报告结束
```

**技能可插拔**（对应你的"开放度"诉求）：

```
src/lib/market/skills/
  factor-mining/SKILL.md     因子挖掘口径
  strategy-tuning/SKILL.md   参数调优边界
  └── 每个技能 = SKILL.md（口径说明）+ 可选 scripts/
```

这比"让用户写表达式"更容易扩展，也是 Vibe 验证过的形态。

---

### P3 · 产品化（会员 + 开放平台）

这部分 Vibe **没有**（它本地优先、无会员），是你自己的方向。

- **会员**：`ai-usage.ts` 已是完整 token 账本 → 直接当计费基础，加硬预算闸门
- **开放度阶梯**：L1 配置 → L2 表达式（`factor-expr.ts` 已就绪）→ L3 策略 → L4 脚本（建议不做）→ L5 MCP/API
- **AI 文生图**：`poster.ts` 当模板层，**AI 只画背景，数字由模板叠加**

---

## 四、⚠️ 合规红线（照搬 Vibe 宪法 §0 第 3 条）

你要做「AI 个股研判」，这条必须写死：

> **AI 不给建仓 / 加减仓 / 目标价 / 止损位等任何投资动作建议。**
> 产出只包含四类：数据、分析框架、情景概率、裁决点（什么数据出来会改变判断）。
> 用户诱导、改口、分步套取也不给。

**赤轨现在没有这条约束**，而你的 AI 研判页面原型里已经出现"止损位 125.74"这类表述——
虽然是你自己仓位的数据，但**由 AI 说出"你的止损位是 X"已经是动作建议的边缘**。

建议：在 `constitution` 层（新增 `src/lib/market/red-line.ts`）明确四类可说、四类不可说。

---

## 五、明确不做

| 不做 | 理由 |
|---|---|
| **照搬 Vibe 的六阶段研究 SOP** | 那是给"一次性公司深挖"用的，你的主流程是每晚自动进化 |
| **多市场（美股/港股）** | 你的策略全是 A 股量价，扩市场等于重做一遍因子检验 |
| **研报库 RAG** | 需求不急，且和"因子-策略"主链无关 |
| **L4 用户脚本沙箱** | 安全成本高；L2 表达式 + L3 参数已覆盖 90% 定制需求 |
| **把赤轨改成 Electron 桌面应用** | 你现在 8787 + launchd 跑得好好的，改部署形态纯属折腾 |

---

## 六、建议顺序

```
P0 证据溯源      ← 先做，它是所有判决可审计的地基
P1 可信度 + registry
P2 编排器/大脑分离
P3 会员 + 开放平台
```

**P0 之前先做一件事**：`cp -r data data.bak-$(date +%F)`。
`data/` 在 gitignore 里，`~/chiheng-backup` 只备份账本，**其余 json 没有任何版本保护**。

---

## 附：Vibe 那三句话，值得贴在代码里

1. 「只拉支持假设的字段比算错更危险——它让错误看起来有数据支撑。」
2. 「是不是强结论？是的话必须先找一个反证，找不到才成立。」
3. 「必需端点失败：不编值、不拿旧值冒充，状态置 incomplete，写明缺什么、试过哪些备源。」
