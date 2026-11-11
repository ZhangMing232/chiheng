# AGENTS.md · AI 会话守则

给在这个仓库里干活的 AI（和未来的自己）。**入口文档是 `PROJECT.md`，先读它**；
策略问题的唯一出处是 `design/STRATEGY-GEN2.md`，拍板记录在 `design/DECISIONS.md`，
进度总表在 `design/REMAINING.md`。本文只列容易踩的规矩。

## 铁律（代码里钉着，违反就是真 bug）

1. **不给买卖建议**：`red-line.ts` 扫每条结论；输出只到「数据 / 分析框架 / 情景概率 / 裁决点」。
2. **不编数据**：缺数据和「确认没有」是两件事；拿不到就写缺口，不许补 0、不许拿旧值冒充新值。
3. **数字必须有出处**：数字闸门扫结论；页面上的每个数都要能回查到 data/ 或证据文件。
4. **回测 |t| < 2 等于没测出来**：不许上实盘。执行参数必须等于验证参数（教训：实盘 -758%）。

## 前瞻观察的定位（2026-11-11 用户拍板，别再按旧的「不预测」口径写）

用户明确要赤轨**能预测市场**，并要求改掉页面里写死的「不预测」。已拍板：

- **允许**给前瞻判断、情景概率、「下一个可能热门」这类观察，页面不再写「不预测 / 非预测」。
- **不变**：铁律 1「不给买卖建议」是合规红线，`red-line.ts` 代码钉死，不许借这次改定位拆掉。
  四类允许输出里本来就含「情景概率」，所以前瞻判断与红线不冲突。
- **不变**：铁律 2/3/4、不编数据、数字有出处、T+1、无前视、`|t|<2 不上实盘`。
- **每条前瞻结论必须标证据等级**：`已验证`（有样本外证据，如连板阶梯 t=-10.2）、
  `待验证`（缺历史样本，如冰点买）、`噪声级`（测过但无优势，如题材补涨 +0.06%/t+0.63）。
  **没验过的东西不许写成确定结论，也不许写成买入信号**——这是「不编数据」在前瞻场景的延伸。

## 动手之前

- **动 `data/` 之前先备份**：`node scripts/snapshot-data.mjs`（约 8 秒，快照到 `~/chiheng-backup`，留 5 份）。
  每天 23:30 launchd（`com.chiheng.backup`）会自动跑一次，但手动改数据前别等它。
- `data/ai-config.json` 含 apiKey（权限 600），**永远不进 git、不贴进对话**。
- 改判决函数 / 改记账口径前，先读 `design/STRATEGY-GEN2.md` 和 `data/strategy-gates.json`，
  确认不会把在跑的挑战者判决写坏（status 只能是 running/promoted/rejected/inconclusive——
  2026-11-04 写进过 `"reject"`，UI 直接崩）。

## 工程规矩

- **scripts/*.mjs 纯 JS 不写类型注解**；要类型就写成 .ts 并用
  `node --experimental-strip-types --import ./scripts/alias.mjs` 跑。
- **限速与缓存 TTL 唯一出处是 `src/lib/market/fetch-policy.ts`**：脚本里不许写裸 `sleep(1200)`。
  东财串行 1.2s 安全，开并发立刻被封。akshare 装不上（py-mini-racer 无 arm wheel），别用。
- **改了前端必须 `npm run build:mac`** 才能在 8787 上看到（home-server 跑的是 .output 产物）。
- **测试和源码 1:1 挨着放**：改行为要带测试；全套 3 秒，没有理由跳过。
- **提交有闸门**：`.githooks/pre-commit`（typecheck）+ `.githooks/pre-push`（npm test），
  `git config core.hooksPath` 已指向 `.githooks`。别绕过它——类型错误曾经推上 main 才发现。
- 提交信息用中文，说清「为什么」，正文按项目惯例写清改动动机与钉住的回归。

## 服务与探测

- launchd 三件：`com.chiheng.serve`（网页 8787，KeepAlive）、`com.chiheng.tunnel`
  （对外 meanwhy.top）、`com.chiheng.backup`（23:30 全量快照）。
- ⚠️ `com.chiheng.verdict` **已于 2026-11-06 bootout 卸载**：它原是个幽灵 job
  （plist 已不存在、只剩 launchd 内存里挂着），每天 16:10 重复跑一次判决。
  现在每日判决只走 `record-journal` 收盘封印 → `scripts/auto-verdict.ts`（15:08，
  带当日 stamp 防重）。手动想立刻刷一次判决：`bash scripts/daily-verdict.sh`（壳留着）。
- 重启 serve：`launchctl kickstart -k gui/$(id -u)/com.chiheng.serve`。
- **探活用 `curl --noproxy '*'`，不要用 lsof**（本机无权限，必误报）；本机代理会把
  localhost 请求发出去返回假 502，必须绕。判断记账活着看 `data/recorder.json` 心跳，不看 HTTP。

## UI

- **2026-11-10 起默认主题 = 浅底 + 蓝主色**（8 张效果图整体换肤）：`--color-brand: #1677ff`
  （按钮/激活/链接；小字用 `--color-brand-text: #095dcc` 保对比）。**红只许出现在两处**：
  logo 方块（nav.tsx 写死的渐变红）和 A 股涨跌（红涨绿跌铁律）。AI 区专用青
  （`--color-ai`）继续给 AI 页的状态语义用。深色主题整套保留为可切换
  （`html[data-theme="dark"]`，墨黑+青观感），新页面不需要为深色单独写样式——
  一律用 token，两套主题自动适配。旧文档 `design/ui-upgrade-2026-10.md` 的
  「朱砂主强调」「2026-11-06 青统一」两条都已过时，别再照抄。
- 面向用户的页面给白话：术语用 `src/lib/ui/glossary.ts` 的 `<Term>` 悬停卡，别在页面上裸抛黑话；
  「已下线」的东西明说「历史仓结算中」，不和现役混排。

### 新页面标齐清单（照着做，别后改）

新建一个路由页，从上往下对齐这套，不要等"看起来割裂了再返工"：

1. **页面根用 `<Frame>`**（`@/components/screener/nav`）：它给顶栏（标题/刷新/主题切换）、
   L1 环境光晕、L2 页头（图标+页面名+一句话职能+状态药丸）、L3 专属装饰件。
   数据密集页传 `<Frame wide>`（max-w-[1440px] 铺满）；阅读型页不传（窄栏 max-w-3xl）。
2. **在 `src/lib/ui/page-decor.ts` 的 `PAGE_DECOR` 里登记路由**：填 `title`/`icon`/`purpose`/`hue`
   （and 可选 `status`/`ornament`）。**不登记就没有 L2 页头**——页头权威来源是这张表，不靠侧栏。
3. **卡片一律用共享组件**：`Panel`/`Stat`/`Tag`/`Table`（来自 `@/components/terminal`）、
   `Section`（来自 `factor-sections`/`flow-sections`）。它们已 token 化、`rounded-lg`(8px)、
   `border-line`、`bg-surface`。**不要自己写裸 `border`/`bg-` 色值**，用 token。
4. **表格必须落在卡片里**：`<Table>` 放进 `Panel`/`Section`，别在页面里裸放 `<table>`。
   桌面端统一带 `data-table` class（已集中做好表头色带 + 行 hover + 间距；手机端自动变卡片流）。
5. **强调色只有这几类 token**：`brand`/`accent`（青）、`up`·`down`（红涨绿跌，A 股铁律）、
   `warn`（异常/饱和）、`gold`（评分/冠军）、`ai`（AI 自身状态）。**页面 JSX 不许写死 hex**。
6. **圆角**：卡片统一 `rounded-lg`；小控件（按钮/标签/输入框）才用 `rounded`。
   **间距对齐 Tailwind 量表**（gap/padding 只用 1/2/3/4/6/8 = 4/8/12/16/24/32px，半档 0.5/1.5/3.5 允许），新代码不写 `px-[37px]` 这类任意值——间距散着写是「页面看着不齐」的根因（2026-11-06 参考实现 §7 的教训）。
7. 改完跑 `npm run build:mac`，浏览器强刷（Cmd+Shift+R）核对；提交走既有闸门。

### 2026-11-11 补的两条（踩过才写的）

- **`aside` 只放真实状态，不放页名。** 页名在面包屑和 L2 页头各出现一次，再往 `aside`
  塞一次就是同一屏三个「多股同屏」。参照 `/factors` 的写法：`aside` 放「因子批次 2026/11/11 15:17:34」
  这类真实数据；**没有状态就不传**（`aside` 是可选的，别拿页名充数）。
  同时 `Panel` 的 `title` 不要和页名一字不差——那就成了第四遍。
- **窄屏表格必须给 `min-w-`，否则 `overflow-x-auto` 不生效。** `table w-full` 在 390px 下
  会被压扁而不是滚动：30 个交易日的热力图日期会连成一片、`/grid` 三列会把票名截成「日…」。
  修法是 `table className="w-full min-w-[760px]"`，让外层容器真的横向滚。
