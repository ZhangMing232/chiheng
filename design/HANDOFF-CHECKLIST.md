# 赤轨 · 剩余任务清单（交接给执行 AI）

> 2026-10-16 整理。对标对象：`simonlin1212/Vibe-Research`（v2.2.1）。
> 本文档是**执行清单**：只列「做什么、去哪做、怎么算做完」。
> 每条差距的完整论证（为什么、取舍理由）在 `design/GAP-REPORT.md`；
> 排期与依赖在 `design/REMAINING.md`。**先读这两份再动手。**
>
> 状态图例：⬜ 待做 · 🔄 部分完成 · ❓ 等用户拍板（不要替用户决定）

---

## 0. 先读我（执行纪律）

1. 项目根：`/Volumes/colorful/chiheng`。所有命令先 `export PATH="$HOME/nodejs/bin:$PATH"`。
2. 验收三件套，**缺一不可**：
   - `npm run typecheck`
   - `npm test`（829 项，必须全绿）
   - `npm run build:mac` → `launchctl kickstart -k gui/$(id -u)/com.chiheng.serve` → `npm run smoke`（无头 Chrome 冒烟测试，见 `scripts/smoke-test.mjs`）
3. 每个逻辑改动 = 一次 commit，commit message 学 git log 的中文格式，**必须 `git push origin main`**。
4. 纪律（用户原话，违反等于返工）：
   - **避免黑箱**：一切可视化、参数化、可灵活调整。
   - **页面布局和人机交互的视觉感、体验感**优先，不是一味堆功能。
   - 拿不到数据无法对标的地方，**说出来问用户，不自行做适配**。
   - 数字/结论必须有真数据源；页面不许造假数、不许空页充数。
5. 已拍板、不要重开的问题：M3（印度等市场）不做；Electron 不做；美股不接策略；
   港股只做行情不接策略；GAP-REPORT 里不许替用户标「❌ 不跟」。
6. 2026-10-16 刚修完的手机端问题（**不要重复排查**）：全站点击失灵（node:path 顶层
   调用崩客户端 bundle，已修 8 个文件）、SSR 塞 5300 只全市场快照（已瘦身）、grok.com
   外部 defer 脚本已移除。详见 git log `9962189`、`d238a71`、`3b6a034`。

---

## P0 · 数据源补齐（B 组主线，东财 HTTP 直连套路，不碰 akshare）

每接一个端点：登记进数据新鲜度（`src/lib/market/data-files.ts`）+ 抓数脚本落盘
`data/` + 页面消费 + 测试。已有 17 个登记端点（`/settings` 页可见），对标它的 119 个 A 股端点。

| # | 任务 | 说明 | 状态 |
|---|---|---|---|
| D10 | 事件驱动剩余 9 类 | 业绩预告已落地（/events 页 10-15），其余事件类（减持/回购/定增/龙虎榜明细等）按东财 datacenter 逐个接 | 🔄 |
| D9 | 同花顺涨停揭秘（题材归因） | 注意是市场叙事不是核验过的因果，页面要写明口径 | ❓ 待拍板 |
| D8 | 问财自然语言选股 | 需同花顺授权或爬取，不建议做，等用户明确说做才做 | ❓ 待拍板 |
| D7 后续 | 宏观数据扩充 | CPI/PMI/LPR/社融已落地接进 /review，它的宏观层还有 5 个端点（汇率/利率走廊等），按需补 | ⬜ |

## P1 · 交互组件对标（组件级清单，全部不需要新数据源）

来源：GAP-REPORT §组件/交互级发现（2026-10-15 晚逐组件读 Vibe 源码 126 个组件）。
建议按此顺序做，每块都是独立 PR：

1. **可排序表头**（Vibe SortTh.tsx 三态排序）——赤轨全站没有 aria-sort。
   先做 `src/components/` 通用 `SortTh`，再接到持仓页、回测页、/sectors 板块表。
2. **搜索联想**（Vibe SymbolSearch.tsx）——赤轨已有 ⌘K 快速搜索（nav.tsx 的
   getQuickSearch），缺：拼音首字母（gzmt）、300ms debounce + AbortController、
   键盘全支持（↑↓/回车/Esc/isComposing）、portal 到 body、搜不通不挡路。
3. **K 线增强**（Vibe KlineCard）——日/周/月切换、A 股复权切换（港美不传不复用）、
   图上方常驻最新值摘要条、诚实脚注（来源/取数时间/bar 数）。文件：
   `src/components/screener/kline-chart.tsx`。
4. **回测防过拟合三件套**（Vibe BacktestCharts 的另一半）：
   扣费前后对照、最深回撤段表、bootstrap 稳健性 + 参数敏感度网格。
   和因子 6 关同一哲学。文件：`src/routes/backtest.tsx` + `scripts/backtest.ts`。
5. **论点→判据→裁决日工作流**（Vibe ThesisPanel/VerdictPanel）——
   GAP-REPORT 判为「最值得优先抄的一块」：裁决点 vs 证伪条件分开、
   下一个裁决日徽章、到期对照自评、六格校准表。落点建议：/research 个股研判
   的 verdict 阶段 + /debate。
6. **陈旧响应守卫**——切换即 AbortController 作废旧请求（Vibe 用单调序号 ref），
   全站异步面板的通用模式。

## P2 · AI 能力（等用户拍板后再动）

| # | 任务 | 说明 | 状态 |
|---|---|---|---|
| AI-1 | 对话式 AiDock（每页带页面上下文提问） | Vibe 形态差异最大的一块；赤轨是「自动实验室」，要不要加对话助手用户定。两个必抄细节：每轮回答挂「本轮来源」、红线删行要提示 | ❓ |
| AI-2 | 多 agent 桥（Claude Code/Codex 订阅 CLI 复用） | 和「只填 API key」是两条路，可并存 | ❓ |
| AI-3 | 笔记 AI 反思 + 隐私打码 | /notes 已落地主体，这两个未做 | ❓ |
| AI-4 | 研报库向文档提问（RAG 链） | /reports 已落地摄入+检索+引用回查，提问需 RAG | ❓ |

## P3 · 工程与维护

| # | 任务 | 说明 | 状态 |
|---|---|---|---|
| T-smoke | 把 `npm run smoke` 挂进日常 | 已建好（scripts/smoke-test.mjs），每次 build 后跑一次；可选：接进定时任务每天开盘前跑一次 | ⬜ |
| E2 | baseline 重跑 | 成本口径变了旧数字失效，用户说一声就跑 | ⬜ |
| T-1 | 移动端小屏完整走查 | 10-16 修完性能后未做：导航、表格、图表在手机上的排版逐个页面过 | ⬜ |
| T-2 | 域名 + 公网访问 | 用户要买域名（meanwhy.top 候选）后部署；方案 2（隧道）已留档 | ⏸ 等用户 |

---

## 做完一项怎么交

1. 三件套验收全绿（§0.2）。
2. commit + push，message 里写「对标 Vibe-Research 的哪一块 + 文件」。
3. 更新 `design/GAP-REPORT.md` 对应行的状态（它是活文档）。
4. 大功能在 `design/REMAINING.md` §10 补一条排期记录。
