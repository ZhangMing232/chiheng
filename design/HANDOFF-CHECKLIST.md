# 赤轨 · 剩余任务清单（交接给执行 AI）

> 2026-10-16 11:00 整理。对标对象：`simonlin1212/Vibe-Research`（v2.2.1）。
> 本文档是**执行清单**：只列「做什么、去哪做、怎么算做完」。
> 每条差距的完整论证（为什么、取舍理由）在 `design/GAP-REPORT.md`；
> 排期与依赖在 `design/REMAINING.md`；设计规范在 `design/DESIGN.md`。**先读这三份再动手。**
>
> 状态图例：⬜ 待做 · 🔄 部分完成 · ❓ 等用户拍板（不要替用户决定）

---

## 0. 先读我（执行纪律）

1. 项目根：`/Volumes/colorful/chiheng`（外置硬盘）。所有命令先 `export PATH="$HOME/nodejs/bin:$PATH"`。
2. **验收三件套，缺一不可**：
   - `npm run typecheck`（tsc --noEmit，0 error）
   - `npm test`（当前 829 项 JS，必须全绿；**看 fail 数，不是只看 pass 数**——`pass 803 fail 1` 和全绿长得一样，我因此错过两次）
   - `npm run test:py`（25 项 Python）
3. **build 的规矩**（重要，踩过）：
   - 日常开发**不用 build**：serve 会自动判断，src 比 `.output` 新就走 vite dev（热更新，改完刷新就见）。
   - 正式验收才 `npm run build:mac`。**agent 跑它可能被沙箱拦**（`CODEBUDDY_BROKER_DENY`，失败过一次还把 `.output` 搞坏过、服务直接起不来）。被拦就让用户在终端跑，别反复试。
   - build 完服务要重启才生效（launchd 的 KeepAlive 会拉，或在用户终端 Ctrl-C 后 `npm run serve`）。
4. 每个逻辑改动 = 一次 commit，message 学 git log 的中文格式，**必须 `git push origin main`**。
5. 纪律（用户原话，违反等于返工）：
   - **避免黑箱**：一切可视化、参数化、可灵活调整。
   - **页面布局和人机交互的视觉感、体验感**优先，不是一味堆功能。
   - 拿不到数据无法对标的地方，**说出来问用户，给建议，不自行做适配、不裁剪凑数**。
   - 数字/结论必须有真数据源；页面不许造假数、不许空页充数、不拿没兑现的浮动盈亏冒充成绩。
6. 已拍板、不要重开的问题：M3（印度等市场）不做；Electron 不做；美股不接策略；
   港股只做行情不接策略；GAP-REPORT 里不许替用户标「❌ 不跟」（2026-10-16 用户明确纠正过）。
7. **没有真实数据就标空缺或示例**，不编。区分「已实测」和「应该能行」——提交信息里写清楚哪个是哪个。

---

## 1. 不要重复排查（2026-10-15/16 已修，都有提交记录）

| 症状 | 原因 | 提交 |
|---|---|---|
| 整站点击失灵 / 客户端 bundle 启动即崩 | 8 个文件里有顶层 `node:path` 调用进了客户端包 | `9962189` |
| 手机打开卡几秒 | SSR 把 5300 只全市场快照塞进 HTML | `d238a71` / `3b6a034` |
| 部署到 Grok 平台才有的外网脚本堵 hydration | grok.com extensions.js 无 project id 也注入 | `a405814` |
| launchd 自启起不来（退出码 127） | dev 模式 spawn 裸名 `vite`，launchd 的 PATH 只有 4 个系统目录 | `b303650` |
| 记账静默挂 18.7 小时 | `@/` 别名后又带 `.ts` 拼成双扩展名 | `89befb3` 引入、10-14 修 |

**排查服务问题的固定动作**：`tail data/serve.log` → 看 `recorder.json` 心跳（记账的证据）
→ `curl --noproxy '*' http://127.0.0.1:8787/favicon.svg`（探静态文件，**不要探 `/`**，
首页要走 SSR 拉行情，耗时 80ms~3s 飘，拿它判生死必然误报）。

---

## 2. 任务清单

### P0 · 数据源补齐（东财 HTTP 直连套路，不碰 akshare）

每接一个端点的完整套路：`src/lib/market/xxx.ts`（解析纯函数+测试）→ `xxx.functions.ts`
（serverFn）→ 页面消费 → registry 登记（traps 写实测坑）→ **真数据端到端验一次**。
已有 30 个登记端点（`/settings` 页可见），对标它的 119 个 A 股端点。

| 优先级 | 内容 | 状态 |
|---|---|---|
| P0-1 | **事件驱动剩余 9 类**（业绩预告已落地，现并入 /calendar?tab=events）：股东增减持、机构调研、股票回购、股权质押、定增、龙虎榜明细等，按东财 datacenter `RPT_*` 逐个接。注意：增减持/机构调研我 10-15 探过返回 0 行（reportName 或字段名不对），要重新探 | 🔄 |
| P0-2 | 同花顺涨停揭秘（题材归因）——那是市场叙事不是核验过的因果，接了页面必须写明口径 | ❓ 待拍板 |
| P0-3 | 问财自然语言选股——需同花顺授权，不建议做，等用户明确说做才做 | ❓ 待拍板 |
| P0-4 | 宏观数据扩充：CPI、汇率、利率走廊（国债/PMI/LPR/社融已接进 /review） | ⬜ |
| P0-5 | 盘后包日常化：10-15 起没再拉（`python3 scripts/fetch-tdx-package.py`），它是每日增量源，断了历史就断档；可选 `--back 250` 补 250 天（675MB，先问用户） | 🔄 |

### P1 · 交互组件对标（组件级，全部不需要新数据源）

来源：GAP-REPORT §组件/交互级发现（2026-10-15 晚逐组件读 Vibe 源码 126 个组件）。
按表中顺序做，每块独立 commit。

| 优先级 | 内容 | 状态 |
|---|---|---|
| P1-1 | **可排序表头**（Vibe SortTh.tsx 三态排序）——赤轨全站没有 aria-sort。先做 `src/components/` 通用 `SortTh`，再接持仓页、回测页、/sectors 板块表 | ⬜ |
| P1-2 | **搜索联想**（Vibe SymbolSearch.tsx）——已有 ⌘K 快速搜索，缺：拼音首字母（gzmt）、300ms debounce + AbortController、键盘全支持（↑↓/回车/Esc/isComposing）、portal 到 body | ⬜ |
| P1-3 | **K 线增强**（Vibe KlineCard）——日/周/月切换、A 股复权切换、图上方常驻最新值摘要条、诚实脚注（来源/取数时间/bar 数）。文件：`src/components/screener/kline-chart.tsx` | ⬜ |
| P1-4 | **回测防过拟合三件套**（Vibe BacktestCharts 另一半）——扣费前后对照、最深回撤段表、bootstrap 稳健性 + 参数敏感度网格。和因子 6 关同一哲学。文件：`src/routes/backtest.tsx` + `scripts/backtest.ts` | ⬜ |
| P1-5 | **论点→判据→裁决日工作流**（Vibe ThesisPanel/VerdictPanel）——**GAP-REPORT 判为最值得优先抄的一块**：裁决点 vs 证伪条件分开、下一个裁决日徽章、到期对照自评、六格校准表。落点：/research 个股研判的 verdict 阶段 + /debate | ⬜ |
| P1-6 | 陈旧响应守卫——切换即 AbortController 作废旧请求（Vibe 用单调序号 ref），全站异步面板通用模式 | ⬜ |

### P2 · AI 能力（等用户拍板后再动）

| 优先级 | 内容 | 状态 |
|---|---|---|
| P2-1 | 对话式 AiDock（每页带页面上下文提问）——形态差异最大的一块。两个必抄细节：每轮回答挂「本轮来源」、红线删行要提示 | ❓ |
| P2-2 | 多 agent 桥（Claude Code/Codex 订阅 CLI 复用）——和「只填 API key」两条路可并存 | ❓ |
| P2-3 | 笔记 AI 反思 + 隐私打码（/notes 主体已落地） | ❓ |
| P2-4 | 研报库向文档提问（RAG 链）——/reports 已落地摄入+检索+引用回查，差问答层 | ❓ |

### P3 · 工程与维护

| 优先级 | 内容 | 状态 |
|---|---|---|
| P3-1 | 冒烟测试日常化——`npm run smoke` 已建好（无头 Chrome 逐页查客户端异常 + 真实点击）。**agent 沙箱里跑不了**（2026-10-16 实测：Chrome 调试端口 45 秒起不来、`--dump-dom` 直接崩退出码 133）——要在用户终端跑。2026-10-24 修了覆盖漂移：PAGES 从 23 条修到 46 条（10-21 信息架构后的新页面全补上：/review/flow/* 9 个子页、membership/login/admin/butler/studio/reports/overseas/notes/settings/my-stocks/inbox/research/debate、factors 子页、ai/rules；删掉 5 条已重定向的旧 /flow/*），NAV_PAGES 修掉必败的 /flow（侧栏入口已撤），并加守门测试 `scripts/smoke-pages.test.mjs`（活路由漏覆盖/列了不存在的路由/导航项点不到 → 测试红）。**2026-10-24 晚用户终端实跑 `npm run smoke`，46 页全过** ✅ |
| P3-2 | baseline 重跑——成本口径变了旧数字失效，用户说一声就跑（命令在 data/backtest/baseline 文件末尾） | ⬜ |
| P3-3 | 移动端小屏完整走查——10-16 修完性能后没做：导航、表格、图表在手机上的排版逐页过 | ⬜ |
| P3-4 | 域名 + 公网访问（meanwhy.top 候选）——等用户买域名；隧道方案已在 REMAINING.md 留档 | ⏸ 等用户 |

---

## 3. 每类任务的交付标准（Definition of Done）

**P0 数据源**：
- [ ] 解析层是纯函数，测试覆盖坏行/缺字段/非交易日（fixture 用真实返回，不用编的数据）
- [ ] registry 登记，traps 每条能回溯到实测出处（测试会拦空话）
- [ ] **真数据端到端跑过一次**，提交信息写实测数字（多少行、什么日期、什么值）
- [ ] 页面显示「数据截至 X」，拿不到就说「没拿到」，不显示全 0（0 会被读成「今天没有」）
- [ ] 拉数是脚本落盘还是实时 serverFn，按数据频率定：日频/实时走 serverFn，月频走脚本落盘

**P1 交互组件**：
- [ ] typecheck + 829 测试 + test:py 全绿
- [ ] `npm run smoke` 跑过（防 SSR 正常但 JS 崩）；**你动的页面必须在 PAGES 覆盖列表里**，不在就先把 scripts/smoke-test.mjs 的 PAGES 补上
- [ ] **桌面 + 手机两端都看一遍**（用户视觉体验优先，窄屏变形算没做完）
- [ ] 键盘可达 + aria 语义（aria-sort / role 等），这是 Vibe 做对的、赤轨欠的
- [ ] 新组件照 kline-chart 的模式：CSS 变量取色（不硬编码颜色）、ResizeObserver、红涨绿跌
- [ ] 用户原话「避免黑箱」落到具体：可调参数露出、口径脚注写明（来源/时间/样本数）

**P2 AI 能力**：
- [ ] **先拿到用户拍板再动**（❓ 不是「可以做」的意思）
- [ ] 红线：回答必须挂来源；AI 的判断和事实分开显示（参考 /events 的 forecastTone 分层——公司措辞原样、我们的倾向克制、不表态的不涂色）
- [ ] 其余同 P1

**P3 工程**：
- [ ] 脚本可重复跑、幂等；跑一次的输出写进提交信息
- [ ] 文档同步更新（GAP-REPORT 是活文档，对应行状态要改）
- [ ] 不引入新依赖，除非先确认 arm64 装得上（akshare 死在 py-mini-racer 上；pypdf 这种纯 Python 的才安全）

---

## 4. 关键坑速查（全都踩过，别重踩）

1. **写 registry traps 只能用这些措辞**（测试正则只认）：具体数字/日期、`不含`、`不同`、`——`、`xxx.ts:函数名`（冒号紧跟文件名）、`元`/`万元`。**`见 xxx` 永远不过**（`见\b` 要求后面紧跟单词字符，有空格就匹配不上）。 traps 里的中文引号一律用「」，写成 ASCII 双引号会直接 TS 语法错误。
2. **src 下 import 用 `@/` 别名且不带 `.ts`**（alias 会拼路径时再加一次）；相对路径要带 `.ts`（node 的 strip-types 认 `.ts` 扩展名，不认无扩展名）。犯了就是 ERR_MODULE_NOT_FOUND，tsc 不报、测试可能全绿、只有运行时崩——`import-hygiene.test.ts` 盯这个。
3. **加新页面要手改 `src/routeTree.gen.ts` 共 9 处**（import / const / FileRouteTypes 三个字符串联合 / 三个 interface 成员 / preLoaderRoute / rootRouteChildren / FileRoutesByPath 块）。沙箱拦 vite 对这个文件的重新生成。第 9 处（FileRoutesByPath 的块）最容易漏，少了它 tsc 报的是 `Link 的 to 不含 '/xxx'`，看不出是 routeTree 缺。
4. **东财分页从第 1 页起**：要最新数据 `sortTypes` 必须 `-1`，给升序拿到的是最早的（接 LPR 时页面显示过 2014 年的报价）。测试用自造数据测不出这个，**必须真数据验**。
5. **别用 grep 核对中文文件**（静默返回空），用 Grep 工具或 python 读文件。写完文件扫一眼替换符 `�`（heredoc 写中文会截断）。
6. **agent 不要起长驻服务**（进程会被回收，还会留僵尸）。验证服务走 launchd 那条路或让用户在终端起；用 `npm run` 验通过 ≠ launchd 能跑（PATH 不同，10-15 踩过）。
7. 完整踩坑记录在工作区记忆 `.workbuddy/memory/MEMORY.md` 和 `memory/2026-10-*.md`，动手前翻一遍。

---

## 5. 做完一项怎么交

1. 三件套验收全绿（§0.2），P0 加一条真数据实测记录。
2. commit + push，message 写「对标 Vibe-Research 的哪一块 + 改了哪些文件 + 实测数字」。
3. 更新 `design/GAP-REPORT.md` 对应行状态（活文档），大功能在 `design/REMAINING.md` §10 补排期记录。
4. 本文档对应行状态同步改（它是入口，别让它先说旧的）。
