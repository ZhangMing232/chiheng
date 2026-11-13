# 赤轨 · 项目总览

> 这份是**入口文档**：第一次打开这个仓库先看这里。专题细节在各专项文档里
> （见文末索引）。数字 2026-11-05 全面对过一轮，不是估的。
>
> **2026-11-13 更新**：11-12 晚到 11-13 早做了一次整站改版（信息架构重排、
> 像素赛博主题、新增 `/today`）。§3 页面清单、§7 当前状态、§8 索引已按现行代码对齐；
> 文中标注了日期的历史实测数字（如 §4 数据源表）保留原样，别当成现状。

---

## 1. 这是什么

**一个跑在本机的 A 股模拟盘 + 个股研究流水线。**

两件事互相喂数据：

- **模拟盘**：按现役选股策略（2026-11 二代换代后 2 套，判决书见 `design/STRATEGY-GEN2.md`）
  在真实交易日里建仓、结算、出报表，所有动作记进
  本机账本（`data/books/dev-user.json`）。它验证的是「策略在真实行情里跑会怎样」，
  不是在回测里跑——回测的结论另有出处（见 §5）。
- **研究流水线**：`/research` 页按**七个阶段**把一只票的「知道什么、凭什么知道、
  还不知道什么」分开摆出来（身份 / 价格 / 资金 / 催化剂 / 行业 / 估值 / 裁决）。
  **不给买卖建议**，结论只到「情景 + 裁决点」为止。

港股 / 美股：**只做行情查看，不做策略**（用户 2026-10-14 拍板）。
A 股那套选股逻辑（涨跌停、换手率闸、ST、板块、流通市值）在美股没有对应物，
硬套是语义错误，所以不做。

---

## 2. 怎么跑

```bash
cd /Volumes/colorful/chiheng

npm run serve        # 启动服务（正式网页 http://127.0.0.1:8787，前台，窗口别关）
npm run preflight    # 开盘前自检：11 项检查 + 退出码（0 就绪 / 1 有阻塞 / 2 休市）
npm run build:mac    # 改了前端之后必须 build 才可见（8787 跑的是 .output 产物）
npm test             # 1,324 条测试（2026-11-13 实测，两段共约 20 秒）
npm run lint         # 0 error（既有 warning 数量见当期输出）
```

### 我（AI）跑不了的命令

| 命令 | 为什么 |
|---|---|
| `npm run serve` | 服务由 launchd 托管（`com.chiheng.serve`，开机自启、崩溃自动拉起）。**只能用户自己终端起**；手动再起只会端口冲突；要重启用 `launchctl kickstart -k gui/$(id -u)/com.chiheng.serve` |
| `npm run build:mac` | 2026-11-05 起实测**可以跑**（此前外置盘 `fs.promises.cp` 被代理层拦）。11-12 晚曾被 safe-delete / fs-broker 拦过一轮，**11-13 09:53 已成功产出新构建**（见 §7）；若再遇 CODEBUDDY_BROKER_DENY，提示用户自己跑 |

### 探测服务状态的规矩

- 用 `curl --noproxy '*'`，**不要用 lsof**（本机无权限，会误报成没起来）
- **绕代理**：本机 `HTTP_PROXY` 会把本地请求发给代理，返回一个**假的 502**
- 探静态文件（`/favicon.svg`），**不要探 `/`**——`/` 自 11-12 起是纯 307 → `/today`，
  探它测到的是重定向而不是页面健康；要测页面就直连 `/today`
- 判断记账有没有发生，看 `data/recorder.json` 的心跳，**不看 HTTP**

---

## 3. 代码地图

```
src/
├── routes/           75 个路由文件（含旧地址重定向）；39 个是顶层页面
├── lib/market/       302 个模块：策略、数据、账本、研究流水线
│   ├── providers/    行情源适配（tencent / sina / eastmoney / overseas）
│   └── *.test.ts     测试和源码 1:1 挨着（全仓 156 个测试文件）
├── components/       终端风格组件（Panel / Table / Stat / Tag / StateBlock）
└── lib/auth, lib/paper.ts
scripts/              抓取与运维（Python + mjs + ts 混合，.mjs 不做类型检查）
mp/                   微信小程序（已暂停：代码完成，部署未做）
design/ docs/         规范、手册、进度表（STRATEGY-GEN2.md 是策略唯一出处）
data/                 全部运行时数据，**不在 git 里**，每天 23:30 自动快照（见 OPS.md）
```

**页面清单**（= 侧栏**五组 + 系统**，2026-11-13 重排；唯一真源是 `src/components/screener/nav.tsx` 的 `SIDEBAR`）：
**今天**——今天该干什么 `/today`、前瞻回验 `/huiyan`；
**行情**——盯盘 `/watch`、题材与情绪 `/themes`、游资席位 `/youzi`、资金流向 `/flow`、全球行情 `/overseas`；
**研究**——情绪周期 `/cycle`、区间统计 `/interval`、趋势中军 `/rs`、因子实验室 `/factors`；
**策略**——策略选股 `/strategies/screener`、策略跟踪 `/strategies/positions`、回测审计 `/backtest`；
**我的**——自选与持仓 `/my-stocks`、快讯 `/news`；
**系统**——AI 工作台 `/ai`、大管家 `/butler`、设置与状态 `/settings`。

分组理由（`nav.tsx` 注释）：11-11 那版「按一天的节奏分八组」会把同一件事拆到两组
（资金、题材都在「盘后」，「盯盘」却只有一项）→ **分组跟着问题走，不跟着时钟走**。

- **`/` 已不是首页**：11-12 起是纯 307 → `/today`，`src/routes/index.tsx` 只剩一段注释和重定向。
  `/today` 一屏走完「市场在玩什么 → 短线买什么 → 中长线买什么 → 什么时候卖」，
  11-13 又加了**一天时间轴**，每块数据标明几点到位（昨收落档 15:12 / 竞价审核 09:26 /
  盘中资金约 1 分钟），防止把 9:26 的竞价价当成此刻能挂的价。
- **子页收进页内 tab，不占侧栏**：策略 5 tab → 3 工作台、因子 6 页 → 1 工作台（`FACTOR_TABS`）、
  资金 8 tab → 4（`/flow/industries` 并入 `/flow/sectors?view=live`、`/flow/close` 并入 `/flow`）。
  `/inbox` 11-13 下线（两个入口违反单一入口）。
- `/ai/config`、`/studio`、`/research/*`、`/review/*` 等子页只留直链，侧栏不再单列。
  个股详情 `/symbol` 从任意代码点入。旧地址全部留 307，书签不断链；
  `scripts/smoke-pages.test.mjs` 的 `LEGACY_ALIASES` / `SKIP_WITH_REASON` 是同步清单。

**界面**：11-12 晚整站换成**像素赛博**主题（`design/redesign-2026-11/` 16 个设计稿 +
`tokens.css` / `pixel.css`）。默认深色（`--color-brand: #22e6ff`），浅色保留可切
（`localStorage chiheng-theme`）；新增 `PixelHeader` / `PixelSummary` 两个组件，
标题块与摘要块已覆盖全站。旧的「浅底 + 蓝主色 #1677ff」口径已过时。

规模（2026-11-13）：704 提交 · 92 个路由文件 / 149 个脚本 · 1,324 条测试。
提交有闸门：pre-commit 跑 typecheck、pre-push 跑全量测试（`.githooks/`，
`git config core.hooksPath` 已指向它）。

---

## 4. 数据从哪来

**主源腾讯，备份新浪；港美走东财（secid 116/105）。全部零鉴权。**

| 数据 | 抓取 | 落在哪 | 更新节奏 |
|---|---|---|---|
| 全市场行情 | 服务自己每 60 秒拉 | `data/universe-cache.json` | 分钟级 |
| 账本 | 记账进程 | `data/books/dev-user.json` | 每次记账 |
| 日线（回测用） | `fetch-kline.py`（baostock） | `data/backtest/kline/` | 每天 |
| 财报基本面 | `fetch-fundamentals.py`（akshare→东财） | `fundamentals.json` 2.3MB | 45 天 |
| 总市值 | `build-caps.mjs`（读本地缓存，不联网） | `cap.json` | 7 天 |
| 流通市值 | `build-caps.mjs`（同一脚本，一起建） | `floatcap.json` | 7 天 |
| 一致预期 | 东财研报接口直连 | 实时 | 3 天 |
| 行业分类 | `fetch-industry.mjs` | `industry.json` 496 板块/5659 只 | 6 小时 |
| 行业月度 | `fetch-industry-monthly.mjs` | `industry-monthly.json` 8928 完整月 | 24 小时 |
| 回测记录 | `backtest.ts` 自动追加 | `runs.jsonl` | 跑一次加一行 |
| 情绪周期序列 | `cycle-history.ts`（收盘快照后自动，只读本地 K 线，不联网） | `data/history/cycle/series.json` | 每天 |
| 题材简报 | `brief-build.ts`（同上，串在快照之后） | `data/history/brief/*.json` | 每天 |
| 收盘价快照（区间统计） | `closes-index.ts`（串在快照之后） | `data/history/closes/<date>.json` | 每天 |
| 趋势中军 RS 榜 | `rs-build.ts`（同上，只读本地 K 线） | `data/history/rs/latest.json` | 每天 |
| 前瞻回验落档 | `forecast.ts`（同上，自带「没封印不落」闸） | `data/history/forecast/<date>.json` | 每天 |
| 席位档案 | `record-hotmoney.ts` + `seats-build.ts`（18:10，等东财龙虎榜） | `data/history/seats/latest.json` | 每天 |
| 涨停原因原文 | 第三方盘后整理 | `data/history/limit-up-reasons/*.json` | 每天 |
| 三池今日快取 | `capture-intraday-pools.ts` / `capture-market-snapshot.ts`（东财 push2ex 3 池串行） | `data/signals/limit-pools-today.json` | **盘中每 3 分钟 / 收盘 15:12** |
| 三池按日归档（盯盘回看） | `capture-market-snapshot.ts` / `backfill-limit-pools.ts` | `data/history/limit-pools/<date>.json` | 每交易日一份，永不覆写别天 |
| 笔记 | 笔记页写 | `notes.json` | 你写的时候 |

**限速与缓存 TTL 只有一个来源**：`src/lib/market/fetch-policy.ts`。
脚本里不许再写裸的 `sleep(1200)`（东财风控实测：串行 1.2s 安全，开并发立刻被封）。

**akshare 装不上**（py-mini-racer 只有 x86_64 wheel），别写「用 akshare」。

---

## 5. 回测与实盘的关系（最容易搞混的一块）

**回测的结论不等于策略能用；实盘样本才是判决。** 2026-11 二代换代的判决书
（`design/STRATEGY-GEN2.md`）是这一节的唯一出处，要点：

- **中期反转**：淘汰（2026-10-28）。回测超额只有 +0.14%（t=1.10，**没过线**），
  却上了实盘——51 笔、胜率 11%、累计 **−758%**。这是本项目最大的一课：
  回测没过线的东西不该上实盘。⚠️ 更早那份「+1.03%（t=5.06）」是旧口径，
  已被 2026-10-25 全池基线推翻，别再引用。
- **放量突破**：保留为骨架。回测过线的是它的两个变体（早期版 t=2.57、
  排天量 t=2.03，已并入现役条件）；实盘亏在执行参数和验证口径不一致
  （实盘止损 −2%，验证的是 −8%），已对齐。⚠️ 2026-10-29 被自动闸门暂停建仓
  （全池回测信噪比=−2.35 ≤ −2，691 笔/212 天），冷却 10 天后按预登记标准复跑。
- **低估值**：现役，唯一实盘正收益的一套。
- **趋势回踩 / 启动前期 / 次日补涨**：全部淘汰，只结算历史仓。
- **因子挖掘**：过时结论更正（2026-11-13）。原来写「没有一个过全部 6 关」，那是 **2026-11-05 放宽门槛之前**的话——那天把因子 6 关协议放低了：G2 信噪比门槛从 |t|≥2 降到 ≥1.5，G5 从多阈值改成 BH-FDR(q=0.10)。放宽后因子能逐关过。但「因子→策略」融合长出的候选，到目前**仍没有一个过实盘双闸**（聚类 |t|≥2 **且**前后同向 **且**超额为正），所以准确说法是：不是因子没过关，而是没长出能上实盘的策略。死因档案在 `/factors`。

**判断一套策略有没有阿尔法，不看「平均收益」，看同期全池基准 + 信噪比。
|t| < 2 等于没测出来。** 铁律：回测过不了 |t|≥2 的不许上实盘；执行参数必须
等于验证参数。详见 `docs/DATA-ACCESS.md` 与因子页 `/factors`。

---

## 6. 贯穿全项目的铁律

这些不是口号，是代码里钉着（测试 + 红线检查）：

1. **不给买卖建议**。`red-line.ts` 扫每一条结论，命中就换成占位句并留说明。
   报告只给「数据 / 分析框架 / 情景概率 / 裁决点」四类输出。
2. **缺数据和「确认没有」是两件事**。拿不到就写缺口，不许补 0、不许留空数组冒充。
3. **数字必须有出处**。数字闸门扫结论里的数字，没在证据里的换成（略※）。
   **规则阈值有豁免**：比较词 + 无量纲计数（「近 3 个」「连续 2 天」「评分高于 2」）
   放行——它们是旋钮不是数据。带度量单位的（「PE 低于 20 倍」「涨幅超过 5%」）
   和没比较词的（「持有 8 天」）仍要核对。
4. **不编**。产业链上下游映射表宁可不做（没有知识库支撑，编出来就是假数据）；
   申万分类拿不到就换东财并说清代价，不假装有。
5. **不拿旧值冒充新值**。过期就是过期，`isFresh` 判到 TTL 那一毫秒。
6. **回测的幸存者偏差、市值用今天快照、抽样外推要谨慎**——这些写在页面上，不藏。

### 前瞻观察（2026-11-11 用户拍板）

用户要赤轨**能预测市场**，页面里写死的「不预测」定位已废除。**允许**给前瞻判断、
情景概率、「下一个可能热门」这类观察。但三条边界不变也不许绕：

- **铁律 1「不给买卖建议」不动**。`red-line.ts` 合规红线，允许输出里的「情景概率」
  本来就给前瞻判断留了位置，不需要拆红线。
- **每条前瞻结论标证据等级**：已验证 / 待验证 / 噪声级。没样本外证据的写「待验证」，
  不冒充确定结论；测过没优势的写「噪声级」，不当买入信号。
- **历史样本从 2026-11-11 起按日落盘**（题材热度、连板三池、情绪温度计），
  在此之前不拿近似值或占位顶替。预测模型要等样本够了再做样本外验证。

拍板记录见 `design/DECISIONS.md` 末尾，守则见 `AGENTS.md`。

---

## 7. 当前状态（2026-11-13 深夜实测）

| 项 | 状态 |
|---|---|
| 服务 | **在跑**：8787 HTTP 200，`.output` 是 11-13 深夜的新构建（双页头收口 + huiyan 重排已上线）。launchd 三件（serve / tunnel / backup 23:30）沿用；`com.chiheng.verdict` 11-06 已 bootout，每日判决走 `record-journal` 收盘封印段的 `auto-verdict.ts`。详见 `design/REMAINING.md` §13 |
| 测试 | **1,341 / 1,341 全绿** · typecheck 干净 · `check:client` 97 个 JS 干净 · 冒烟 **0 FAIL** |
| git | **origin/main 已同步 `9695506`**。11-13 晚五个提交：对账+ScopeNote+归档（dbddb39）、P2 四条（0715088）、UI 根因修复（80700d6）、双页头收口（ffb2d02）、huiyan 重排（9695506） |
| 数据链路 | 记账心跳正常；`data/reconcile/<date>.json` 每日收盘后自动落对账快照（11-13 起新增）；`limit-pools` 归档 15 天、`closes` 303、`forecast` 4 |
| 策略 | 现役 `ACTIVE_STYLES = ["value"]` 一套；breakout 被闸门 disabled（10-29 起，「全池 t=-2.35 无 alpha」）。已下线 4 套只结算历史仓。**研究结论未因这次改版变化**：`strategy-verdicts.json` 11 套聚类 t 全在 ±2 内，无可部署 alpha |
| 对账裁决 | **P2「两链合一」已评估并裁决不做**（5 日实测 31 笔差异 = 16 挑战者实验 + 15 盘中新增，0 丢单）。`/today` 短线腿标「观察·不建仓」；策略追踪「今日对照」带三类归因标签。详见 `design/P2-RECONCILE-REPORT.md` |
| 密钥 | `ai-config.json` / `push-config.json` / `tushare-config.json` 三个都是 600，不进 git、不贴进对话 |
| 推送 | 见下方「两条推送通道」 |
| 待办 | **E2 baseline 已重跑完成**（`data/backtest/baseline-2026-11-13.txt`，窗口 2025-11-04~2026-11-13，11 套全未过两关、超额 ≤0.8%）。P1-3 硬判据 / DECISIONS 三件仍待拍板——本轮数字不支持任何口径放宽 |

### 两条推送通道（别混，2026-11-13 核实）

设置页 `/settings` 有两块，共用一个 PushPlus token（`data/push-config.json`）：

| 通道 | 什么时候发 | 由谁触发 | 状态落盘 |
|---|---|---|---|
| **收盘日报** | 交易日 **15:12 收盘封印后**（实测 15:08~15:16） | `record-journal.ts` → `daily-digest.ts` 的 `sendDailyDigest` | `data/.daily-digest-last.json`（`sent`/`failed` + 通道），配 `.daily-mail-<date>.stamp` 一天一次去重 |
| **交易提醒** | 09:20 前瞻 3 只 / 09:26 中长线+短线买入单 / 15:10 温度计 / 到止损·到目标·到期该卖 | `home-server.mjs` 时间表 + `scripts/forecast.ts --push-morning` 等，各自调 `sendPushPlus` | **不写 `.daily-digest-last.json`**，只在 `data/serve.log` 留痕 |

🔴 **`.daily-digest-last.json` 只描述收盘日报这一条，不是全站推送健康度。**
看到它停在昨天不代表今天的推送漏了：交易日 15:12 之前本来就不该有当天记录。
（2026-11-13 11:00 实测：状态是 11-12 15:14:34 `sent/wechat`，而 11-13 早上
09:20 买入单已在 `serve.log` 记为「早上买入单已推送微信」，两者互不覆盖，都正常。）

**提醒**：11-12 起用户拍板「前瞻买入单只要早上 9:20 这条」，`forecast.ts` 落档时
默认不再自动推（保留 `--push-on-lock` 手动）。改动的是买入单，**不是收盘日报**。

---

## 8. 索引

| 文档 | 管什么 |
|---|---|
| `design/STRATEGY-GEN2.md` | **策略判决书**——现役/已下线、二代换代依据、验证标准（策略问题先看这里） |
| `design/REMAINING.md` | **进度总表**——每项的状态、卡点、依赖 |
| `design/DECISIONS.md` | 拍板记录——已定的方案和理由，别再重新讨论 |
| `design/GAP-REPORT.md` | 对标 Vibe-Research 的缺口逐条（数据/市场/实现/工程） |
| `design/DESIGN.md` | 界面规范（十章，偏早期） |
| `design/redesign-2026-11/` | **现行界面真源**：像素赛博 8 屏设计稿 + 手机版 + `tokens.css` / `pixel.css` / `_rail.txt` / `_steps.txt`。11-12 晚改版的设计记录，和 `src/styles.css` 对齐 |
| `docs/DATA-ACCESS.md` | 取数口径手册：数据源登记、限速、TTL、降级、**踩过第二次的坑** |
| `docs/EARNINGS.md` | 财报口径（单季/TTM/杜邦） |
| `docs/VALUATION.md` | 估值口径（历史分位/前瞻 PE/PEG） |
| `docs/CATALYST-RISK.md` | 催化剂与风险 |
| `OPS.md` | 运维照做清单（**本机数据备份** + 小程序部署） |
| `design/PLAN-vibe-align.md` | 对标 Vibe-Research 的总计划与逐项状态 |
