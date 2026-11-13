# 赤轨 × DeepSeek HARNESS 嵌入接入方案（方案 B）

> 2026-10-22 目标第 1 轮，用户已拍板「方案 B：嵌入 DeepSeek HARNESS 运行时」。
> 依据：本地参照实现 `deepseek-harness-quant`（MIT，已跑通）的 `harness/` 目录与桥接插件源码逐行读完。

---

## 1. 结论先行

DSH 是**可分发 npm 包** `@deepseek-ai/dsh`，赤轨可以通过「独立进程 + 桥接插件 + HTTP」把它接进来当 AI 大脑运行时，与量化 Web 系统分离、任何一方挂了另一方照常。

> **版本核对（2026-10-22 实测，本轮新增）**：npm 最新 `0.2.1-rc.2`（参照实现 deepseek-harness-quant 用的 `0.1.0-rc.6` 已过时）。已解包 0.2.1-rc.2 逐项核对服务面，桥接插件据此写成，见 `chiheng-dsh-embed/`。

---

## 2. 参照实现已跑通的形态（deepseek-harness-quant）

```
harness/                          ← 赤轨要新增的一层
├── package.json                  ← 只依赖 "@deepseek-ai/dsh"
├── install.cmd                   ← npm install（可选）
├── home/                         ← = DSH_HOME 用户数据根
│   ├── settings.yaml             ← 模型路由（provider deepseek-official / model deepseek-v4-flash）
│   ├── .credentials.yaml(.example) ← DEEPSEEK_API_KEY
│   ├── skills/                   ← 空白 skill 模板（按需加载）
│   └── profiles/web/
│       ├── cordis.yml            ← 空 entry list（根）
│       ├── cordis.patch.yml      ← insert 桥接插件
│       └── plugins/dsq-quant-bridge.js  ← 桥接插件
└── plugins/                      ← 桥接插件源码位置（二选一，参照里两处都有）
```

启动方式（HARNESS接入.md）：
```bash
node harness/node_modules/@deepseek-ai/dsh/lib/bin.js web   # :3080 GUI
# headless 单轮：
node npx -y @deepseek-ai/dsh --profile headless --resume <sessionId> <text>
```

---

## 3. DSH 提供的服务（从桥接插件 `ctx.get(...)` 反推的稳定面）

| 服务 | 用途 |
|---|---|
| `webServer` | DSH 的 HTTP 服务 + `register({kind:'exact'\|'prefix', path, handler})` 让插件挂路由 |
| `sessionQuery` / `sessions` | 会话列表/标题/正文读取 |
| `llm` / `agentDefaultModel` | 模型路由与流式调用（`llm.stream`）；`agentDefaultModel.currentSelection()` 取默认模型 |
| `subprocess` | `spawn()` 拉起 headless agent 会话（关键入口） |
| `fs` | 文件抽象（`resolve`/`readText`/`writeText`） |

> 0.2.1-rc.2 核对结论（含实测）：上表服务名全部**仍存在**（`agentDefaultModel` 用 `super(ownerContext,"agentDefaultModel")` 声明，容易被 grep `super(ctx,...)` 漏掉）；`llm.stream` 的参数是 `{provider, model, messages, system?, temperature?, maxTokens?}`，流块 `type==='text-delta'|'reasoning-delta'`。profile 结构：首次启动自动生成 `package.json`（`dsh.profile.bundles` 声明 bundles）+ `cordis.yml`（空根）+ `cordis.patch.yml`（补丁层）——**只需编辑 `cordis.patch.yml` 挂插件**。已在 /tmp 实跑验证：`dsh web` 启动后 `/chihengapi/health` 返回 `{"ok":true,"provider":"deepseek-official","model":"deepseek-flash"}`。

桥接插件 = Cordis 插件，`inject: ['webServer']`，在 `apply(ctx)` 里 `ctx.webServer.register({ kind:'prefix', path:'/quantapi', handler })`，宿主通过 HTTP 调用这些路由。这是赤轨复刻的模板。

---

## 4. 赤轨现状 vs 目标差距

| 维度 | 现状（G1 已完成） | 目标（嵌入 DSH 后） |
|---|---|---|
| LLM 调用 | 直连 OpenAI 兼容 API（`callAIWithFallback`，DeepSeek/Kimi 多档案） | DSH `llm` 服务统一路由 |
| 工具 | `vt-tools.ts` MCP stdio（Vibe-Trading 74 工具） | 桥接插件把赤轨数据 + VT 工具暴露给 DSH agent |
| 会话 | 无（单轮提议，无多轮会话） | DSH 原生会话（可 resume） |
| 技能 | 无（prompt 内嵌） | DSH `skills/`（按需加载方法论） |
| 编排 | agent-loop 只到「观察+诊断」 | DSH headless agent 的观察→计划→行动闭环 |

---

## 5. 分步接入计划

### 步骤 0：可行性验证（最小、可回退）
1. 在赤轨仓库新增 `harness/package.json` 依赖 `@deepseek-ai/dsh`，`npm install`。
2. 配 `harness/home/.credentials.yaml`（复用赤轨 `data/ai-config.json` 的 DeepSeek key）。
3. 跑 `web`（:3080）与 `headless --resume` 各一次，确认 DSH 服务面 + headless 单轮可用。

### 步骤 1：桥接插件 `chiheng-bridge`
复刻 `dsq-quant-bridge`，暴露 `/chihengapi/*` 给 DSH agent：
- `/chihengapi/quotes` → 全市场行情快照（读 `universe-cache.json`）
- `/chihengapi/ledger` → 账本（读 `data/books/<uid>.json`）
- `/chihengapi/factors` → 因子判决史 / 队列 / 死因档案
- `/chihengapi/challengers` → 冠军-挑战者状态
- `/chihengapi/vt-tools` → 代理 Vibe-Trading MCP 工具矿山（把 stdio 包成 HTTP）

### 步骤 2：赤轨后端接线
- agent-loop 的 observe/plan/act 改为**通过 HTTP 调 DSH headless agent**（`subprocess.spawn` 等价物），或先并存（旧直连保留，新 DSH 通道灰度）。
- 决策：DSH 的 `llm` 服务 vs 赤轨 `ai-config.json` 多档案，谁当唯一来源（建议 DSH 设置收敛，赤轨保留「用哪把 key」的 UI）。

### 步骤 3：进程编排
- `scripts/home-server.mjs` 同时拉起：赤轨 Web（:8787）+ DSH（:3080）。
- launchd 自启（`install:mac`）一并管理两进程的健康与重启。

### 步骤 4：安全边界对齐（不可省）
- DSH 的 skill/白名单 与赤轨 `AI-BOUNDARY.md` 硬闸（`red-line.ts` / `number-gate.ts` / `factor-expr.ts`）对齐——DSH agent 的输出仍要过赤轨的判决函数，AI 仍只许「提议」，判决逻辑写死在赤轨代码里。

---

## 6. 风险与待定

| 风险/待定 | 说明 |
|---|---|
| DSH 是 rc 版 | `0.1.0-rc.6`，接口可能变，桥接插件要跟版本锁 |
| 多一层部署 | 多一个 Node 进程 + 端口，运维复杂度上升（home-server.mjs 要管两进程） |
| 与现有直连/VT-MCP 的分工 | 并存还是迁移？建议先并存灰度，跑稳再收敛 |
| 多用户 | DSH 会话/技能是否按用户隔离，要和「AI 运行时文件隔离」一起定 |

---

## 7. 建议的第一刀（下轮就做）

先做**步骤 0 可行性验证 + 步骤 1 的 `chiheng-bridge` 最小骨架**（只暴露 `/chihengapi/quotes` 一个只读路由，把行情喂给 DSH agent 试一轮），验证「赤轨数据 → DSH agent → 结论」整条链路通不通，再扩到账本/因子。
