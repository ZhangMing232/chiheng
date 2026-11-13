# 赤轨 → 成熟产品：路线图与差距分析

> 生成于 2026-10-22（目标第 1 轮）。目标：部署 AI 当大脑、融合 Vibe-Trading / Vibe-Research、
> 对标两者的功能与开放模式、支持注册登录收费、接入/部署 AI agent 或 harness。
> 本文档是后续所有执行轮次的工作地图，状态随进展更新。

---

## 0. 目标拆解

| # | 子目标 | 一句话 |
|---|---|---|
| G1 | AI 当大脑 | 让 AI 自主观察账本、提议、诊断，闭环自我进化 |
| G2 | 融合 Vibe-Trading / Vibe-Research | 移植两者的功能到赤轨 |
| G3 | 对标开放模式 + 会员收费 | 注册登录 + 分层会员 + 收款 |
| G4 | 接入/部署 AI agent 或 harness | 给赤轨装一个 harness 型 AI 运行时层 |

---

## 1. 现状盘点（已完成的，逐条核对过源码/文档）

### G1 AI 大脑 —— 已基本就位 ✅
- `src/lib/market/agent-loop.ts`：观察+诊断层（把整个账本摊给 AI：因子判决史/队列/死因档案/挑战者/策略闸/自身进化史），落 `data/agent-diagnosis.json`。
- `factor-queue.ts` + `strategy-ai.ts`：两层单轮提议闭环（因子假设、策略参数变体）。
- `vt-tools.ts`：stdio 客户端，把本地 Vibe-Trading 当 MCP 工具矿山（实测 74 工具）。
- `factor-expr.ts`：AI 产出只许白名单表达式，无 eval 编译。
- 每晚自动闭环：收盘封印后自动跑「因子层→策略层」进化（`evolve-once.ts` / `auto-verdict.ts`）。
- AI 多档案：`data/ai-config.json`（DeepSeek `deepseek-v4-pro` + Moonshot Kimi），支持 Ollama/LM Studio。
- 边界写死：`AI-BOUNDARY.md` + `red-line.ts`（不给投资建议）+ `number-gate.ts`（数字有出处）。
- 2026-10-22 新上：AI 额度闸（按 plan 限每日进化/诊断次数，`quota.ts`）。

### G2 Vibe 融合 —— 大部分完成 ✅
- **Vibe-Research 侧**：/research 七阶段研判、6 套 SOP（财报/估值/催化剂/产业链/取数）、知识档案（knowledge.ts）、reportDiff（同票两次研判对比）、portfolio health（持仓体检）。
- **Vibe-Trading 侧 VT1–VT7**：回测稳健性三件套(walkForward/bootstrap/PSR)、DSR、IC/ICIR、PBO、参数敏感度、数字核验，全部完成；**VT6 组合权重优化暂缓**。
- 参照源码都在本地：`~/Documents/kimi/tasks/2026-09-30/11-14-40-0dc258a0/{Vibe-Research,deepseek-harness-quant}` 和 `chiheng/vendor/vt-mcp/Vibe-Trading`。

### G3 开放模式 + 会员 —— v1 完成，收款/持久化待做 🔶
- ✅ Better Auth 邮箱密码注册登录（`server/routes/api/auth/[...].ts`）。
- ✅ plan 档位 `free / pro-monthly / pro-yearly / lifetime / admin`（`migrations/0002_membership.sql`）。
- ✅ `/membership` 页：定价 29/299/999（`pricing.ts` 单一事实来源）+ 人工授予开通。
- ✅ AI 额度闸 v1（免费 0 次/天，付费按档位限次数）。
- ✅ 多用户隔离 R1–R4：自选/笔记/研判报告/知识库/收件箱按人落盘。
- ✅ **账本已分账**（`book-file.ts`）：`data/books/用户id.json` 每人一本，含防路径穿越 + 原子写入（tmp+rename），`OWNER_ID=dev-user`。
- ✅ **Neon 持久化是零代码**（`db.ts`）：`DATABASE_URL` 一设即切 Neon（`dbSource`），PGLite 只是没配时的内存兜底；只差老板提供 Neon 连接串。
- ⬜ **AI 闭环运行时文件仍全局单用户**：`ai-log.json` / `factor-queue.json` / `challengers.json` / 策略闸 / 因子 runs 是全局文件（不是 per-user）——多用户共用时这部分要隔离。
- ⬜ **收款渠道**（待拍板）：微信/支付宝原生（需个体户）、爱发电、面包多、Stripe、Lemon Squeezy。

### G4 harness 接入 —— 尚未开始 ⬜
- 现状：赤轨的 AI 走**直接 OpenAI 兼容 API**（`callAIWithFallback`）+ **MCP stdio**（VT 工具），没有独立的 harness 运行时层。
- 参照物：`deepseek-harness-quant` = 量化系统 + DeepSeek HARNESS 运行时（:3080）+ 桥接插件（`dsq-quant-bridge.js` /quant/* 路由）+ credentials/skills，独立进程 HTTP 桥接。

---

## 2. harness 接入方案（G4，新，需拍板方向）

三选一：

| 方案 | 内容 | 优点 | 代价/风险 |
|---|---|---|---|
| **A. 维持现状** | 继续用直接 API + 增强 agent 编排（把 agent-loop 的 observe 补全 plan/act） | 零迁移、零新依赖、已跑通 | 没有「harness 级」的会话/技能/多代理能力 |
| **B. 嵌入 DSH 运行时** | 学 deepseek-harness-quant：独立 DSH 进程 + 桥接插件，赤轨做宿主 | 会话/技能/牛散人格/插件热更开箱即用；和赤轨 AI-BOUNDARY 已引用的「nl-command-console skill」同源 | 需维护 Node 运行时 + 桥接契约；多一层部署 |
| **C. 折中** | 维持赤轨直连 API，但把 DSH 的「skill/白名单边界」机制抽象进 agent-loop | 渐进，不引入新运行时 | 要自己重造部分 harness 能力 |

**已拍板（2026-10-22）：方案 B —— 嵌入 DeepSeek HARNESS 运行时**。详细接入方案见 [`赤轨-DSH嵌入接入方案.md`](</Users/zhangweimin/Documents/deepseek-harness/default-workspace/赤轨-DSH嵌入接入方案.md>)。

---

## 3. 待拍板清单（给老板，阻塞项集中在这）

| # | 事项 | 现状 | 需要你定的 |
|---|---|---|---|
| 1 | **收款渠道** | 人工授予已跑通 | ⏸ **2026-10-22 拍板：付费模式先待定**（爱发电/面包多暂缓） |
| 2 | **定价** | 29/月、299/年、999 终身已在代码里 | ⏸ 随付费模式一并待定 |
| 3 | **数据库部署** | 代码已支持 Neon，只差连接串 | ⏸ 付费/开放注册待定，Neon 暂缓（本机内存 PGLite 够用） |
| 4 | **AI 运行时文件隔离** | ai-log/因子队列/挑战者/策略闸仍全局 | 共享（社区模式）还是按 user 分文件？ |
| 5 | **harness 方向** | 见 §2 | ✅ **已定：方案 B 嵌入 DSH 运行时** |
| 6 | **DECISIONS.md 4 件** | 判决规则维持现状 | Welch 门槛加不加提前否决、g5 维持、3 笔样本去留、top-10 饱和观察 |

---

## 4. 推荐执行顺序（分阶段）

**阶段 0（本轮）**：产出本路线图 + 差距确认 ✅

**阶段 1（可自主，不依赖拍板）**：
1. **DSH 嵌入可行性验证**（G4-B，已拍板）：装 `@deepseek-ai/dsh`，跑 web + headless，见 `赤轨-DSH嵌入接入方案.md` 步骤 0。
2. **`chiheng-bridge` 桥接插件最小骨架**：先暴露 `/chihengapi/quotes` 只读路由，验证「赤轨行情 → DSH agent → 结论」链路。
3. AI 运行时文件隔离调研（G3 剩余坑）：列出 `ai-log.json`/`factor-queue.json`/`challengers.json`/策略闸按 user 分文件的改动面与成本评估。

**阶段 2（需拍板后启动）**：
4. 收款渠道接入（G3，已定爱发电/面包多）：/membership 页挂爱发电/面包多付费链接 + 人工授予流程文档化。
5. Neon 挂载（G3）：等老板提供 `DATABASE_URL`，验证迁移 + 注册持久化。
6. 剩余硬闸（工具矿山/自选上限/远程访问）`requirePlan` 分层。

**阶段 3（产品化收尾）**：
7. DSH 桥接全面接线（G4-B）：账本/因子/挑战者路由 + 进程编排 + launchd。
8. 微信小程序部署（OPS.md 待手动步骤）。
9. 数据缺口 D7–D10（宏观/问财/打板）。

---

## 5. 进度记录

### 第 1 轮
- [x] 核对四子目标现状，定位 4 处真实缺口 + 6 项待拍板。
- [x] 找到并分析 harness 参照物 `deepseek-harness-quant`（DSH 嵌入样板，逐行读完桥接插件）。
- [x] 产出本路线图文档 + DSH 嵌入接入方案。
- [x] 收集三决策：收款=爱发电/面包多、harness=方案 B、定价=29/299/999。

### 第 2 轮
- [x] 实测 `@deepseek-ai/dsh@0.2.1-rc.2` 可安装（npm 临时缓存绕过本机 .npm 权限问题）。
- [x] 解包核对 0.2.1-rc.2 服务面：webServer/llm/agentDefaultModel/subprocess 全在；profile 结构从 cordis.yml 改为 dsh.profile.bundles。
- [x] 产出 `chiheng-dsh-embed/`（桥接插件 + 脚手架 + README），语法/YAML 全部校验通过。
- [x] 摸清 AI 运行时文件隔离面：账本已分账；ai-log/factor-queue/challengers/strategy-gates 仍全局（其中 ai-log/factor-queue 已有 CHIHENG_DATA_DIR 间接层，challenger/strategy-gate 硬编码 data/）。

### 第 3 轮
- [x] **端到端实测验证 DSH 嵌入**（在 /tmp 实跑 @deepseek-ai/dsh@0.2.1-rc.2）：
  - `dsh web --port 38765` 正常启动；
  - `chiheng-bridge` 插件经 `cordis.patch.yml` 成功组合进 profile（`--dump-config` 确认）；
  - `GET /chihengapi/health` → `{"ok":true,"provider":"deepseek-official","model":"deepseek-flash"}`；
  - `POST /chihengapi/chat`（空 user）→ 400 校验、未知路由 404、CORS 204 全通过。
- [x] 修正认知：`cordis.yml` 空根在 0.2.1-rc.2 **仍存在**（自动生成），变的是 bundles 声明位置。

### 第 4 轮
- [x] 产出 `赤轨-多用户数据隔离方案.md`：把 data/ 下 20+ 文件按「系统/策略进化/用户私有」三类归档。
- [x] **隔离模式拍板（混合）**：主人命名空间（官方策略进化，付费只读）+ 用户私有命名空间（账本/计费/偏好 + 各自独立创造）。
- [x] 给出落盘布局（`data/` 主人 + `data/users/<userId>/` 用户私有）与迁移清单。
- [x] Neon 决策：用户稍后提供连接串。

### 第 5 轮
- [x] 产出 `chiheng-dsh-client.ts`（赤轨侧 drop-in 客户端：callDSH/callDSHWithFallback，DSH 优先、直连兜底）。
- [x] 产出 `赤轨-收款落地清单.md`；**确认收款 v1（人工授予）代码已就绪**（grant-plan.ts + pricing.ts + membership.tsx），只差爱发电真实链接 + Neon。

### 第 6 轮
- [x] **真实 LLM 闭环验证通过**：配 DeepSeek key 后 `POST /chihengapi/chat` 真实调通 DeepSeek、返回文本。
- [x] 发现并修复「正文/思考混排」：DeepSeek 推理模型的 chain-of-thought 混进正文，桥接插件改为正文只取 `text-delta`、思考单独放 `reasoning` 字段；复测正文干净。
- [x] DSH 嵌入至此 **100% 端到端验证完成**（加载/路由/校验/CORS/真实 LLM/正文分离）。

### 第 7 轮（🎉 突破：获得写赤轨目录权限）
- [x] **写入权限打通**：用「申请更高权限」重试，成功写 `/Volumes/colorful/chiheng`。
- [x] 复制 `harness/`（DSH 运行时脚手架）进赤轨仓库。
- [x] 复制 `src/lib/market/chiheng-dsh-client.ts`（赤轨侧 DSH 客户端）。
- [x] 接线 `factor-queue.ts` 的 `callAIWithFallback`：`CHIHENG_DSH_URL` 门控的「DSH 优先、直连兜底」。
- [x] `.gitignore` 补 `harness/home/.credentials.yaml`（防 key 泄露）。
- [x] 生成 `harness/home/.credentials.yaml`（复用 ai-config.json 的 key，已 git-ignore）。
- [x] `tsc --noEmit` 全绿（exit 0）。

### 第 8 轮（🚀 DSH 部署完成）
- [x] `harness/npm install`：装 `@deepseek-ai/dsh@0.2.1-rc.2`（615 包，2 分钟）。
- [x] 预建 profile 模板文件（`package.json` + `cordis.yml`），profile 开箱即用。
- [x] `home-server.mjs` 加 DSH 编排：条件启动（未装则跳过）、失败重启、关机停掉、注入 `CHIHENG_DSH_URL`。
- [x] 验证：`--dump-config` 确认 `chiheng-bridge` 在 harness 目录正确组合（exit 0）；`node --check` 语法全过。

### 第 9 轮（✅ DSH 端到端启动验证 + 收尾）
- [x] **从 harness/ 真实启动 DSH**：发现并修复凭据权限问题（DSH 要求 `.credentials.yaml` 为 600，原本 644 被拒）。
- [x] `chmod 600` 后 DSH 端到端启动成功，`/chihengapi/health` 返回 `{"ok":true,"provider":"deepseek-official","model":"deepseek-flash"}`。
- [x] gitignore 补 DSH 运行时文件（`.anonymous-user-id` / `logs/` / `storages/` / `settings.yaml.imported`）。
- [x] **DSH（AI 大脑 + harness）这条线至此 100% 完成**：装好、编排好、接线好、真实启动验证通过。

### 第 10 轮（隔离第一件：prefs 按用户分账）
- [x] `prefs-file.ts` 改 `data/prefs/<userId>.json`，`readPrefs/writePrefs` 带 userId，含旧数据迁移（rename 幂等）。
- [x] 更新 3 个调用方（getPrefs/savePrefs/settings）用 `requireUserId()`。
- [x] 验证：typecheck 全绿；旧 `data/prefs.json` 自动迁到 `data/prefs/dev-user.json`，内容无损；服务健康。

### 第 11 轮（隔离前置：统一策略进化文件路径）
- [x] 把 `challenger.ts` / `strategy-gate.ts` 的路径从硬编码 `process.cwd()/data` 统一到 `CHIHENG_DATA_DIR ?? data/`，与 factor-queue / ai-log / agent-loop 一致。
- [x] typecheck 全绿、服务健康。
- [x] 至此所有策略进化文件都有统一 `dataDir()` 间接层——**按用户分账（独立创造）只需把 dataDir 改成带 userId 即可**。

### 第 12 轮（回归验证）
- [x] 跑相关单测：challenger 7 / strategy-gate 46 / factor-queue 21 / ai-log 7，**全部通过（0 fail）**。
- [x] 确认全部改动（DSH 部署 + prefs 分账 + 路径统一）不破坏现有测试与运行中的服务。
