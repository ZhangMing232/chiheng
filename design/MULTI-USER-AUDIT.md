# 多用户隔离审计（开放注册前必读）

> 2026-10-21。背景：会员体系 v1（`ce1991a`）已让任何人都能注册登录。
> 身份层（`requireUserId` / Better Auth 会话）是可信的，但**数据层不是每个存储都认了身份**。
> 本文件盘点「别人注册进来会看到/改到什么」，已修与未修分开列。

## 结论速览

| 存储 | 内容归属 | 修前状态 | 现在 |
| --- | --- | --- | --- |
| 交易账本 `data/books/` | 每人一本 | ✅ 早已按 userId 隔离 | 不变 |
| 推送/AI 配置 | 仅主人可改 | ✅ `userId !== OWNER_ID` 拒绝 | 不变（见风险 R2） |
| 自选股 `data/watchlist/` | 每人一份 | ❌ 全局单文件，人人共享 | ✅ 已修（本轮） |
| 笔记 `data/notes/` | 每人一份 | ❌ 全局单文件，人人共享 | ✅ 已修（本轮） |
| 研判报告 `data/reports/` | 每人一份 | ❌ 全局，人人可读可写 | ✅ 已修（R1） |
| 知识库 `data/knowledge/` | 每人一份 | ❌ 全局，按股票覆盖 | ✅ 已修（R2） |
| 预警收件箱 | 主人策略产物 | ❌ 人人可读 | ✅ 已修（R3，只对 admin 可见） |

## 本轮已修（自选 + 笔记）

改动模式（两存储同构，后续存储照抄）：

1. 落盘路径加用户维度：`data/<store>/<userId>.json`，用户 id 过 `safeUserId` 白名单（防 `../`）。
2. 所有 server 函数 handler 第一行 `requireUserId()`，用它做读写键。
   动态 import（`await import("@/lib/auth/verify.server")`），跟 quotes.functions.ts 既有写法一致。
3. **旧全局文件只迁给 `dev-user`**（这台机器的主人）：第一次读时发现 per-user 文件不存在，
   把 `data/<store>.json` 复制成主人的那份并改名 `.migrated` 留底。
   新注册用户从空开始——**任何人都不该继承这台机器上的私人数据**。
4. 迁移失败不阻塞：旧文件留着，下次再试；读不到就返回空，不报错。
5. 单测钉住三件事：每人一份互不可见、迁移只给主人、坏文件读回空。

注意：存储层（`watchlist.ts` / `notes-store.ts`）**不 import** `book-file.ts` 的
`OWNER_ID`/`safeUserId`，而是本地同值常量 + 同规则函数。原因：`notes-store.ts` 会进客户端
bundle（见该文件头注释），不让 node:fs 链路有任何被客户端引到的机会。

## 修复记录（全部完成）

> R1（报告）、R2（知识库）、R3（收件箱）、R4（admin 认定）均已修。

### R4 + R3 的做法（2026-10-21）

- verify.server.ts 新增 `requirePrincipal()`：一次解析给出
  `{ userId, isOwner }`。isOwner = `plan === "admin"`（isAdmin 判定）；
  唯一例外是没有真实库的 dev 回落（和 requireUserId 同一条路），
  dev-user 天然是主人。getSessionUser 现在把 user.additionalFields.plan
  一并返回（Better Auth 的 session.user 自带这个字段）。
- quotes.functions.ts 的 19 处 `userId !== OWNER_ID` 门全部换成
  `!isOwner`。**本机 dev 和线上真实账号同一套判定**：grant-plan.ts
  给哪个账号授 admin，哪个账号就能改推送/AI 配置、跑 AI 闭环。
- alerts.functions.ts getAlerts：非主人返回空。收件箱是主人策略的推送
  产物，免费用户看了等于白嫖；未来做每用户预警时再改成数据级过滤。
- 仍保留 `userId === "dev-user"` 的地方（正确，勿改）：
  各存储的 LEGACY_OWNER_ID 迁移（数据文件归属）和
  getChallengerSamples 读主人的账本（挑战者配置是全局文件）。

### 部署时注意事项（开真实数据库前过一遍）

- 本机数据（账本/报告/知识库/自选/笔记）都落在 `data/` 下以 dev-user
  为键的文件里。线上你的账号是 Better Auth 随机 id + admin 档位：
  **数据文件需要一次性改名/迁移到你的账号 id**，或给线上账号特殊处理
  （比如 grant-plan 同时把数据目录 dev-user 改名成新 id）。
- `scripts/grant-plan.ts` 目前只在 DATABASE_URL 形态可用（本机 PGLite
  是内存库）——线上部署后第一个动作就是给自己的账号授 admin。
