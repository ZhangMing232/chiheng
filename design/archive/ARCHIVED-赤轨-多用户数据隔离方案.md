# 赤轨 · 多用户数据隔离方案

> 2026-10-22 目标第 4 轮。目标：开放注册前，把 `data/` 下「全局单用户」的文件理清
> 哪些该共享、哪些该按用户分，给出可拍板的分类与迁移清单。
> 依据：逐文件 grep 了 `src/lib/market/*.ts` 的落盘路径定义。

---

## 1. 结论（一句话）

赤轨的 `data/` 天然分三类，**绝大多数「策略/系统/行情」数据本来就该共享（社区模式）**，
真正需要按用户隔离的只有 5 处——其中账本/自选/笔记等已完成，**剩下要补的是计费和用户私有偏好**。

---

## 2. 三类分类

### A 类 · 系统/行情（永远一份，共享）
市场数据、抓取产物、主人级配置，多用户共享，无隔离需求：

| 文件 | 用途 |
|---|---|
| `universe-cache.json` | 全市场行情快照 |
| `backtest/kline/ klines/ factor-runs.jsonl industry*.json fundamentals.json cap.json tdx-daily/` | 回测原料（日线/因子判决/行业/基本面） |
| `macro/` `risk/` | 宏观、两融龙虎榜 |
| `recorder.json` | 记账进程心跳 |
| `relay-freeze.json` | 次日补涨冻结名单 |
| `rules.json` | 启动前期规则 |
| `ai-config.json` `tushare-config.json` `push-config.json` | **主人级密钥**（AI key / 数据源 token / 推送 token），只主人可见 |

### B 类 · 策略进化（社区共享，一份样本）
冠军-挑战者、因子队列、策略闸是全系统唯一一套研究管道，**分账会打散样本、毁掉统计意义**，必须共享：

| 文件 | 用途 |
|---|---|
| `factor-queue.json` | 预登记待验因子队列 |
| `challengers.json` `champions.json` `champion-log.jsonl` `challenger-robustness.json` | 冠军-挑战者状态与判决 |
| `strategy-gates.json` `gate-blocks.jsonl` | 策略闸状态与阻断日志 |
| `factor-tombstones.jsonl` | 因子死因档案 |
| `evolve-breaker.json` | 进化熔断 |
| `ai-log.json` `agent-diagnosis.json` | AI 自我进化记忆 / 当前诊断报告 |

### C 类 · 用户私有（按用户分，需隔离）

| 文件 | 用途 | 现状 |
|---|---|---|
| `books/<userId>.json` | 账本（持仓/成交） | ✅ 已分账 |
| 自选 `watchlist` | 自选股 | ✅ R1 已按人落盘 |
| 笔记 `notes` | 笔记 | ✅ R1 已按人落盘 |
| 研判报告 `reports` | 报告 | ✅ R1 已按人落盘 |
| 知识库 `knowledge` | 知识档案 | ✅ R2 已按人落盘 |
| 收件箱 `inbox` | 提醒 | ✅ R3 已按人落盘 |
| **`ai-usage.json` `ai-failures.json`** | **AI 用量计费 / 失败** | ⬜ **仍全局**（额度闸按 plan 限次，计费必须按用户） |
| **`nav-history.json`** | 净值曲线 | ⬜ 仍全局（每个用户自己的净值） |
| **`prefs.json`** | 用户偏好 | ⬜ 仍全局 |
| **`sell-alerts.json`** | 卖出预警 | ⬜ 仍全局（预警发给「我」） |

---

## 3. 建议方案（可直接拍板）

**共享 B 类（社区模式），隔离 C 类（按用户）。** 理由：

- B 类（策略进化）是**全系统唯一一套**，样本共享才有统计意义；按用户分账等于把几十笔样本拆成「每人几笔」，挑战者/因子判决永远凑不满 30 笔门槛，进化闭环直接饿死。
- C 类的 `ai-usage`/`ai-failures` 是**额度闸的计费依据**，不按用户就分不清谁用了多少次，收费无法落地。
- `nav-history`/`prefs`/`sell-alerts` 是纯用户私有，隔离零争议。

### ⚠️ 用户拍板（2026-10-22）：混合模式

用户原话：「**付费用户可以看到我的，但他们也可以自己去独立创造**」。

拆成两层命名空间：

| 命名空间 | 内容 | 读写 |
|---|---|---|
| **主人（admin）命名空间** | 官方的因子队列/挑战者/冠军/策略闸/诊断/进化记忆 + 行情/回测原料/密钥 | 主人写；**付费用户只读**（看到主人的选股结果与进化状态） |
| **用户私有命名空间** | 各自账本/自选/笔记/报告/知识库/收件箱 + 计费/偏好/预警 + **各自独立的因子队列/挑战者实验** | 用户自己读写，互不可见 |

即：**B1（主人单份，付费可读）+ B2（用户各自可独立创造）同时成立**——不是二选一。

### 落盘布局（建议）

```
data/                              ← 主人命名空间（现状不变，付费用户只读）
  factor-queue.json  challengers.json  champions.json  champion-log.jsonl
  strategy-gates.json  gate-blocks.jsonl  factor-tombstones.jsonl  evolve-breaker.json
  ai-log.json  agent-diagnosis.json  challenger-robustness.json
  universe-cache.json  backtest/  macro/  risk/  recorder.json  relay-freeze.json  rules.json
  ai-config.json  tushare-config.json  push-config.json     ← 主人密钥，永远不暴露
  books/<userId>.json  watchlist  notes  reports  knowledge  inbox   ← 用户私有（已分）
data/users/<userId>/               ← 用户私有命名空间（新增，独立创造）
  ai-usage.json  ai-failures.json  nav-history.json  prefs.json  sell-alerts.json
  factor-queue.json  challengers.json  champions.json  strategy-gates.json  ai-log.json  agent-diagnosis.json
```

要点：
- 主人命名空间的「策略进化」是**官方一份**，付费用户只读——样本不被打散，进化闭环照常。
- 用户私有命名空间的「策略进化」是**各自实验田**，跑各自纸面账当样本（样本少就少，那是用户自己的实验，不影响官方结论）。
- `ai-usage/ai-failures` 必须按用户（计费依据），放用户私有命名空间。

---

## 4. 具体迁移清单（待拍板后执行）

只动 C 类仍全局的 4 个文件，B 类一律不动：

1. **`ai-usage.json` / `ai-failures.json`** → 改成 `data/ai-usage/<userId>.json`（或 `ai-usage-<userId>.json`），与 `books/` 同款按 userId 分文件。写入口在 `ai-usage.ts` / `ai-retry.ts`（两者已走 `dataDir()`，加 userId 子目录即可）。**计费口径**：AI 闭环跑在「主人」账上，但「谁触发的这轮进化/诊断」要记到触发者头上，才能按 plan 限次。
2. **`nav-history.json`** → `data/nav-history/<userId>.json`（`quotes.functions.ts` 的 `appendNav` 已按 userId 分组写，只需落盘路径分文件）。
3. **`prefs.json`** → `data/prefs/<userId>.json`（`prefs-file.ts`，目前硬编码 `process.cwd()/data/prefs.json`）。
4. **`sell-alerts.json`** → `data/sell-alerts/<userId>.json`（预警由记账进程按持仓人生成，天然可带 userId）。

**工程注意**：
- 已有 `safeUserId()`（`book-file.ts`）防路径穿越，C 类新分文件一律复用它。
- `prefs-file.ts`、`quotes.functions.ts`、`push.ts`、`strategy-gate.ts` 等目前**硬编码** `join(process.cwd(),"data",...)`，没走 `CHIHENG_DATA_DIR`；若要支持「换数据目录」顺手统一（测试靠它）。
- B 类文件的读取方（`agent-loop.ts` / `record-journal.ts`）**不用改**——它们读的是共享的一份，这正是社区模式要的。

---

## 5. 依赖关系与风险

- **依赖拍板**：共享 B + 分 C（本建议）或「全部分账」。选「全部分账」会导致策略进化样本饥饿，不推荐。
- **计费正确性**：`ai-usage` 按用户分是关键中的关键——额度闸（`quota.ts`）已经按 `plan` 限次，数据口径没跟上就白做。
- **风险**：迁移时要保证旧数据（当前全局的一份）能落到 `dev-user`（主人）名下，不丢历史。
