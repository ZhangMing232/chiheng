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
| 预警收件箱 | 主人策略产物 | ❌ 人人可读 | ❌ 未修（见下） |

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

## 未修清单（按风险排序）

> R1（报告）、R2（知识库）已修，见上表。以下两项仍在：

### R3. 预警收件箱（读别人的推送，中）

- `alerts.functions.ts getAlerts` 返回全局收件箱。收件箱内容是主人策略信号经 PushPlus 的产物，
  免费用户看到主人的实时策略信号 = 白嫖付费内容。
- 修法：短期最省事——收件箱只对 `OWNER_ID`（或 plan === "admin"）可见，其他人返回空 +
  一句说明；长期做 per-user 预警时再按用户拆。

### R4. 「主人」判定：真实数据库下 `OWNER_ID` 不认主（中，全局性）

- 现在「主人」判定是 `userId === "dev-user"`。开了真实数据库（DATABASE_URL）后，
  主人注册的 Better Auth id 是随机串，不是 dev-user——主人的推送/AI 配置全锁死，
  反之如果把 dev-user 当公共 fallback 又会出大事（verify.server 已在没库时才允许 dev-user）。
- 修法：把「主人」从用户 id 改成 **`plan === "admin"`**（plan.ts 已有 isAdmin）。
  授予脚本（`scripts/grant-plan.ts`）给主人账号授 admin 即完成认定。
  quotes.functions.ts 里所有 `userId !== OWNER_ID` 的判断都要换。

## 依赖关系

```
R4（admin 认定）──→ R3（收件箱对主人可见）
      │
      └── 不阻塞 R1/R2（reports/knowledge 按 userId 拆，与谁是主人无关）
```

建议顺序：~~R1 → R2~~ ✅ → R4 → R3。R1/R2 是隐私线，必须先于任何形式的对外宣传；
R4 是功能线（主人自己的配置），开真实库之前必须完成。
