# 赤轨 · 项目总览

> 这份是**入口文档**：第一次打开这个仓库先看这里。专题细节在各专项文档里
> （见文末索引）。数字 2026-11-05 全面对过一轮，不是估的。

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
npm run build:mac    # 改了前端之后必须 build 才可见（⚠️ 见下方「我跑不了的命令」）
npm test             # 1,556 条测试，约 3 秒跑完
npm run lint         # 0 error（110 个既有 warning）
```

### 我（AI）跑不了的命令

| 命令 | 为什么 |
|---|---|
| `npm run build:mac` | 2026-11-05 起实测**可以跑**（此前外置盘 `fs.promises.cp` 被代理层拦）。若再遇 CODEBUDDY_BROKER_DENY，提示用户自己跑 |
| `npm run serve` | 服务由 launchd 托管（`com.chiheng.serve`，开机自启、崩溃自动拉起）。手动再起只会端口冲突；要重启用 `launchctl kickstart -k gui/$(id -u)/com.chiheng.serve` |

### 探测服务状态的规矩

- 用 `curl --noproxy '*'`，**不要用 lsof**（本机无权限，会误报成没起来）
- **绕代理**：本机 `HTTP_PROXY` 会把本地请求发给代理，返回一个**假的 502**
- 探静态文件（`/favicon.svg`），**不要探 `/`**——首页 SSR 耗时在 80ms~3.15 秒之间飘，
  拿飘的耗时判生死必然偶发误报
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

**页面清单**（= 侧栏八组，2026-11-11 起按「一天的节奏」排）：
**盘前**——总览 `/`、今日决策 `/decision`、前瞻回验 `/huiyan`；
**盯盘**——盯盘 `/watch`（今日梯队/三日演变；原 `/grid` 多股同屏 + `/ladder` 连板天梯，11-11 晚合一）；
**盘后**——每日复盘 `/review`（涨跌分布/信号/公司事件三个子页）、资金流向 `/flow`
（北向/行业/板块/个股/收盘快照/两融/期指七个子页；「游资」11-12 并入 /youzi）、游资与席位 `/youzi`
（游资追踪/席位档案）、题材 `/themes`（市场情报/题材轮动/题材简报）；
**研究**——情绪周期 `/cycle`、区间统计 `/interval`、趋势中军 `/rs`、自选 `/my-stocks`；
**资讯**——快讯 `/news`、消息与提醒 `/inbox`、全球行情 `/overseas`；
**进化**——策略看板 `/strategies/screener`、因子实验室 `/factors`、回测 `/backtest`；
**AI**——工作台 `/ai`、大管家 `/butler`；**设置**——`/settings`。
`/ai/config`、`/studio`、`/research/*` 等子页只留直链，侧栏不再单列。
个股详情 `/symbol` 从任意代码点入。旧地址（`/intel` `/rotation` `/brief` `/hotmoney`
`/seats` `/review/flow/*` `/grid` `/ladder` `/flow/hot`）全部留重定向，书签不断链。

规模：647 提交 · 107,000 行（src + scripts）· 1,556 条测试。
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
- **因子挖掘**：没有一个过全部 6 关（g5 多重检验是最难过的一关）。死因档案在 `/factors`。

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

## 7. 当前状态（2026-11-05 实测）

| 项 | 状态 |
|---|---|
| 服务 | **在跑**：launchd 托管三件——serve（开机自启 · 网页 8787）、tunnel（对外 meanwhy.top）、backup（每天 23:30 快照）。⚠️ `com.chiheng.verdict`（原每天 16:10 的重复判决）**11-06 已 bootout 卸载**，plist 早就不存在；每日判决统一走 `record-journal` 收盘封印段的 `auto-verdict.ts`（15:08）。详见 `design/REMAINING.md` §13 |
| 测试 | 1,556 条全绿 · typecheck 干净 · lint 0 error（110 个既有 warning）· 页面冒烟 0 FAIL |
| 策略 | 现役 2 套：低估值在跑；放量突破被闸门暂停（10-29 起，冷却中）。已下线 4 套只结算历史仓 |
| 记账 | 每分钟记账正常；「赤轨日终」推送 2026-11-05 首次触发成功（stamp 去重一天一次） |
| 备份 | `data/` 741MB，23:30 定时快照到 `~/chiheng-backup`（留 5 份）。⚠️ **11-06 才修好**（launchd 包 bash + 日志落内盘），此前从未跑成过；今晚 23:30 首次真实定时触发，明早验 `last exit code`。详见 OPS.md |
| 密钥 | `data/ai-config.json` 已收紧 600（含 apiKey，别进 git） |
| 下一步 | 四件大件中 **②流水去重 / ③AI 超时治理 / ④深扫复盘已落地**（11-06）；①账本加锁待收盘后做，账本确定**不迁 SQLite**（体检与结论见 `design/REMAINING.md` §12） |

---

## 8. 索引

| 文档 | 管什么 |
|---|---|
| `design/STRATEGY-GEN2.md` | **策略判决书**——现役/已下线、二代换代依据、验证标准（策略问题先看这里） |
| `design/REMAINING.md` | **进度总表**——每项的状态、卡点、依赖 |
| `design/DECISIONS.md` | 拍板记录——已定的方案和理由，别再重新讨论 |
| `design/GAP-REPORT.md` | 对标 Vibe-Research 的缺口逐条（数据/市场/实现/工程） |
| `design/DESIGN.md` | 界面规范（十章） |
| `docs/DATA-ACCESS.md` | 取数口径手册：数据源登记、限速、TTL、降级、**踩过第二次的坑** |
| `docs/EARNINGS.md` | 财报口径（单季/TTM/杜邦） |
| `docs/VALUATION.md` | 估值口径（历史分位/前瞻 PE/PEG） |
| `docs/CATALYST-RISK.md` | 催化剂与风险 |
| `OPS.md` | 运维照做清单（**本机数据备份** + 小程序部署） |
| `design/PLAN-vibe-align.md` | 对标 Vibe-Research 的总计划与逐项状态 |
