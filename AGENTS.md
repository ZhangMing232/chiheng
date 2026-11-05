# AGENTS.md · AI 会话守则

给在这个仓库里干活的 AI（和未来的自己）。**入口文档是 `PROJECT.md`，先读它**；
策略问题的唯一出处是 `design/STRATEGY-GEN2.md`，拍板记录在 `design/DECISIONS.md`，
进度总表在 `design/REMAINING.md`。本文只列容易踩的规矩。

## 铁律（代码里钉着，违反就是真 bug）

1. **不给买卖建议**：`red-line.ts` 扫每条结论；输出只到「数据 / 分析框架 / 情景概率 / 裁决点」。
2. **不编数据**：缺数据和「确认没有」是两件事；拿不到就写缺口，不许补 0、不许拿旧值冒充新值。
3. **数字必须有出处**：数字闸门扫结论；页面上的每个数都要能回查到 data/ 或证据文件。
4. **回测 |t| < 2 等于没测出来**：不许上实盘。执行参数必须等于验证参数（教训：实盘 -758%）。

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

- launchd 四件：`com.chiheng.serve`（网页 8787，KeepAlive）、`com.chiheng.tunnel`
  （对外 meanwhy.top）、`com.chiheng.verdict`（每天 16:10 收盘判决）、`com.chiheng.backup`（23:30）。
- 重启 serve：`launchctl kickstart -k gui/$(id -u)/com.chiheng.serve`。
- **探活用 `curl --noproxy '*'`，不要用 lsof**（本机无权限，必误报）；本机代理会把
  localhost 请求发出去返回假 502，必须绕。判断记账活着看 `data/recorder.json` 心跳，不看 HTTP。

## UI

- 界面规范 `design/DESIGN.md` 与 `design/ui-upgrade-2026-10.md`（侧栏七组 IA、朱砂 token、红涨绿跌）。
- 面向用户的页面给白话：术语用 `src/lib/ui/glossary.ts` 的 `<Term>` 悬停卡，别在页面上裸抛黑话；
  「已下线」的东西明说「历史仓结算中」，不和现役混排。
