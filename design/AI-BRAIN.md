# 赤轨 AI 大脑：harness / agent 接入方案调研

> 2026-10-21。问题：能不能给赤轨接入或部署一个 AI agent / harness 当大脑，
> 融合 Vibe-Trading / Vibe-Research / deepseek-harness-quant，让策略因子自动挖掘-测试-融合闭环自己转。

## 一、三个参考项目的 harness 实质

### deepseek-harness-quant（yuanwang589-dev）
- 它的 "HARNESS" = DeepSeek 官方 agent 运行时 `@deepseek-ai/dsh@0.1.0-rc.6`
  （npm 包，Cordis 插件架构，跑在 Node 18+），本质和 Kimi Code / Claude Code
  同类：一个能自主多步执行的 coding agent。
- 量化系统本身（Python 写死引擎 + PIT 数据层）**不含 AI**；AI 全部活在
  harness 运行时里，通过 `harness/plugins/dsq-quant-bridge/index.js` 这个
  Cordis 插件把 Web 面板（:3080 /quantapi/*）和 agent 会话桥起来：
  - 自主推进：发「1」触发审计/修复/归档（系统自我进化）
  - 挖因子：自然语言 → 拆假设 → 生成因子 → 九步验证 → 入池或证伪
  - 审计：让 AI 自查前视、覆盖率、共线性、过拟合
  - 牛散：7 位人格（SKILL.md 档案 + 全量量化快照 → LLM）对话选股，决策 JSON 入远期池验证
- **关键启示**：harness 负责"驱动层"（理解意图、多步规划、调工具），
  写死引擎负责"执行层"（评分/回测/风控），数据层负责"事实层"。
  AI 不预测个股是硬约束——**权限边界写死在执行层，不在 prompt 里**。

### Vibe-Trading v0.1.16（本地已解包）
- 自带 **`mcp_server.py`：74 个只读/研究类 MCP 工具**（skills、研究目标、
  策略发现、回测/因子/期权/形态分析、资金流龙虎榜北向、研报新闻公告、
  期权链、宏观序列、iwencai/qveris 问财检索、机构持仓、量化库计算……），
  支持 stdio / SSE / Streamable HTTP 三种 transport，**零 API key**
  （港美加密用 yfinance/OKX/AKShare 免费源）。
- 自带 `api_server.py`：FastAPI REST 全家桶（api_server/ 路由模块化）。
- **关键启示**：这是一座现成的"工具矿山"。赤轨不需要复制这 74 个工具，
  把它的 MCP server 本地跑起来，赤轨的 AI 直接当 MCP client 调。

### Vibe-Research
- 研究流水线六阶段 + 外壳 + 回测闸口三件套，之前 GAP-REPORT 已对齐
  （walk-forward/bootstrap CI/PSR 已移植进 robustness.ts = VT1，DSR = VT2）。
- 它的价值在**方法论流水线**，不是运行时。

## 二、赤轨现状盘点

已有（别重复造）：
- AI 提议层：`src/lib/market/evolve.ts`（因子层→策略层编排）、`factor-queue.ts`
  （parseAIProposals 预登记校验）、`strategy-ai.ts`（挑战者提名）
- 判决层（写死、AI 碰不到）：6 关因子闸 + Bonferroni + Welch + 策略闸，
  `auto-verdict.ts` 每晚自愈重跑 + pushplus
- AI 管理面：`/ai` 页（多服务商 key、token 用量监控）、`ai-log`（记账）、
  `ai-retry`、`ai-presets`（人格/提示词模板）、`evolve-breaker`（熔断）
- 边界纪律：AI 只许提议和展示，改规则必须主人拍板（VT1/VT2 已守住）

缺的（= 本方案要补的）：
1. **多步自主循环**：现在是"一轮一次"的单轮 propose，没有
   观察账本 → 诊断 → 计划 → 执行 → 反思 的 agent loop。
2. **工具层**：AI 现在只会"读账本 + 写提议"，没有可调用的研究工具
   （行情/基本面/资金流/研报检索）。
3. **审计自证**：没有"让 AI 自查前视/覆盖率/共线性/过拟合"的入口
   （data-audit 是写死的规则审计，AI 不参与）。
4. **人格蒸馏**：没有牛散式对话选股 → 决策入池验证的通道。

## 三、方案（推荐组合：A + B，C 暂缓）

### 方案 A：赤轨自研轻量 agent harness（核心，符合现有边界纪律）
在现有 ai-* 基础设施上加一层 **agent loop**，不引入外部运行时：

```
每晚（或手动触发）：
  observe  读账本：因子判决史 / 挑战者纸面 / 因子层 DSR / 数据审计结果
  diagnose 生成诊断：哪些因子族失效、哪些市场环境匹配、 tombstone 死因聚类
  plan     产出行动清单：提议新因子 / 提名挑战者 / 请求审计 / 提议规则变更*
  act      走现有写死通道：parseAIProposals（入队）/ strategy-ai（提名）
  reflect  结果记 ai-log，下一轮 observe 看到（跨天记忆 = 账本本身）
```
- *规则变更只生成「变更提案」给人拍板，AI 永远碰不到判决代码（沿用 VT 纪律）。
- 循环上限 + token 预算 + evolve-breaker 熔断已有，直接复用。
- 新增：`src/lib/market/agent-loop.ts` + `/ai` 页一个「agent 跑一轮」按钮 +
  诊断报告展示。

### 方案 B：接入 Vibe-Trading MCP server 当工具矿山
- `pip install vibe-trading-ai`（或直接用本地解包目录）起
  `python mcp_server.py --transport http`，赤轨加一个 MCP client
  （`src/lib/market/vt-tools.ts`，stdio/http 两种 transport 都支持）。
- 给方案 A 的 plan 步骤喂工具：AI 提议因子前可先 `get_fund_flow` /
  `screen_market` / `get_research_reports` / `iwencai_search` 拿证据，
  提议质量从"拍脑袋"变成"有研报/资金数据支撑"。
- 74 个工具全是只读/研究类，天然符合"AI 不碰执行"的纪律。
- 风险：vibe-trading 依赖重（装的时候会拉一堆 py 依赖），先跑通
  `mcp_server.py --transport http` 验证可用性再写入计划。

**探针结果（2026-10-21，✅ 可用）**：
- 启动所需最小依赖比想象轻：fastmcp + pydantic + pandas/numpy + httpx +
  defusedxml + yfinance + requests 即可起服务；**langchain/langgraph 全家桶
  不需要**（那是 swarm/agent 功能才用）。A 股数据工具要补装 `akshare`。
- stdio 真进程验证通过：74 个工具列全，`list_skills` 返回真实数据，
  `screen_market(market='a')` 返回东财真实全市场快照。
- 数据源现状：东财（akshare）今天可用 ✅；雅虎今天 SSL 抖动+429（环境问题
  不是架构问题）；FRED 宏观需要 key；baostock/mootdx 未装会自动降级腾讯。
- 安全默认值好：shell 工具默认关（`--enable-shell-tools` 才开），网络
  transport 有 DNS-rebinding 防护——原样保留，赤轨不打开 shell 工具。
- 下一步（未做）：chiheng 侧 MCP client（`vt-tools.ts`）+ /ai 页显示
  「VT 工具在线 + 工具清单」；起服务方式建议 stdio 子进程（赤轨 spawn，
  不常驻端口）。
- 探针复现（本机）：解包目录 + venv 在
  `/Users/zhangweimin/Documents/kimi/tasks/2026-09-30/11-14-40-0dc258a/`
  （`Vibe-Trading/` + `vt-venv/`，已装 fastmcp/mcp/pydantic/pandas/numpy/
  httpx/defusedxml/yfinance/requests/akshare）。赤轨集成时建议把这套 venv
  挪进 `/Volumes/colorful/chiheng/vendor/vt-mcp/`（不进 git，加 .gitignore），
  spawn 命令：`vt-venv/bin/python Vibe-Trading/mcp_server.py`（stdio）。

### 方案 C：部署 DeepSeek HARNESS 运行时（暂缓）
- 需要 `@deepseek-ai/dsh@0.1.0-rc.6`（私有 rc 包）+ DeepSeek API key，
  本质是再养一个 coding agent 进程，和赤轨的记账/判决体系是两套会话。
- 它适合"通用自主编程"，但赤轨要的是"量化闭环自治"，方案 A 的窄循环
  更可控、更省 token。等 A+B 跑顺了再评估要不要 C 做"外脑"。

## 四、落地顺序（建议）

> 进度：1 ✅（2026-10-21，4707890：agent-loop 诊断层 + CLI + 5 单测，实跑一轮报告合格）。
> 进度：2 ✅ 探针（2026-10-21）：VT 的 MCP server 本地 stdio 起服务成功，74 工具列全，
> A 股筛选工具返回东财真实数据；细节见方案 B 一节。

1. **A 的 observe/diagnose**：agent-loop.ts 骨架 + 诊断 prompt 模板
   （读账本 → 输出诊断报告，先只展示不行动）——改动小、立刻有体感 ✅
2. **B 的 MCP 探针 + client**：本地起 vibe-trading MCP，赤轨加 client，
   /ai 页显示「VT 工具在线 + 工具清单」——✅（2026-10-21，dbf626d）：
   `src/lib/market/vt-tools.ts` stdio JSON-RPC client（懒 spawn venv python →
   initialize → tools/list/call，闲置 5 分钟回收，env 可覆盖
   CHIHENG_VT_MCP_HOME/PY/SCRIPT）；源码归位 `vendor/vt-mcp/Vibe-Trading/`，
   venv 固定 `~/.chiheng/vt-venv/`；实测探针 1.6s 报 74 工具在线，
   `screen_market` 出证喂 evidenceOf 格式正确（change_pct 为百分数×100，
   amount 为元，渲染 217.03%/成交 7.6 亿正常）；7 条单测钉死。
   **证据三源化**（2026-10-21，e5fb2be）：因子层/策略层提议 prompt 的市场证据
   从单一 screen_market 升级为 `gatherVtEvidence()` 三路——头部个股截面 +
   行业板块强弱（get_sector_info ranking）+ 龙虎榜热钱方向（get_dragon_tiger
   按净买排序），串行取数 + 单源独立容错（东财会对突发 IP 限流，实测并发全灭，
   串行才稳；invokeVtTool 对 Connection aborted 类抖动重试一次）。
3. **A 的 plan/act**：诊断接上现有提议通道（因子层先通，策略层后通）
   ✅（2026-10-21）：诊断 suggestions 经 fetchDiagnosisHints 自动进因子层和策略层的
   提议 prompt（plan 层接线，建议性不强制）；规则变更仍只生成人工请求，判决规则不动。
4. 审计自证 + 人格蒸馏（从 A 的诊断里长出来的子功能，不急）

## 五、和「策略因子自动挖掘测试融合实现赚钱」的关系

闭环现状：AI 提议 → 6 关判决 → 过关因子 → 挑战者纸面 → Welch 转正。
方案 A+B 补的是这个闭环的"眼"和"手"：
- 眼（B 的工具 + A 的诊断）：提议从随机变有证据，淘汰死因被聚类学习
- 手（A 的 plan）：同一个闭环每天自动迭代，不再依赖人点按钮
- 纪律不变：判决规则写死，AI 越权即熔断（evolve-breaker 已有）
