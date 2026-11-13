# 归档：赤轨早期产品化文档（2026-10-22 ~ 10-23）

> ⚠️ **这批是历史过程记录，不是现行文档，勿按此施工。**
> 归档于 2026-11-13，来源：会话工作区 `/Users/zhangweimin/Documents/the coding assistant/default-workspace/赤轨-*.md`。
> 字节原样保留，只加本说明；工作区原件未删。

| 归档文件 | 生成日 | 当时写的内容 | 与 2026-11-13 现状的冲突 |
|---|---|---|---|
| `ARCHIVED-赤轨-DSH嵌入接入方案.md` | 10-22 | 方案 B 接入步骤，§4 写「G4 harness 尚未开始」 | **已 100% 跑通**：`harness/` 已装 `@deepseek-ai/dsh@0.2.1-rc.2`，`home-server.mjs` 已编排，`:3080/chihengapi/health` 实测 200，`factor-queue` / `butler` / `studio` / `quotes.functions` 四处真接线。现行实现看 `harness/home/profiles/web/plugins/chiheng-bridge.js` 与 `src/lib/market/chiheng-dsh-client.ts` |
| `ARCHIVED-赤轨-产品化路线图.md` | 10-22 | 四子目标 G1–G4、12 轮进度（收款 / Neon / 多用户隔离） | 进度记录本身有效，但 §3「待拍板清单」已失效：付费模式 10-22 拍板**暂缓**；本机仍无 `DATABASE_URL`（内存 PGLite）；`/membership` 页面至今显示「自动支付接入中 · 现走人工授予」，`pricing.ts:66` 仍是占位文案。当前方向见 `design/P2-RECONCILE-REPORT.md` |
| `ARCHIVED-赤轨-产品功能规划.md` | 10-23 | 7 功能页 + 管理 + 自媒体，写 `/overview` 已建、大管家待建 | `/overview` **已变成 307 → `/review/breadth`**（`src/routes/overview.tsx`）；`/butler` 已建并接 DSH；「小道消息聚合」源被封、「自媒体视频」因本机无 ffmpeg 未做。侧栏现行真源是 `src/components/screener/nav.tsx` 的 `SIDEBAR` |
| `ARCHIVED-赤轨-多用户数据隔离方案.md` | 10-22 | 三类归档 + 混合命名空间 + 4 个待迁文件 | 与 `README.md` 末尾「策略和偏好仍是全站共用，不随用户改」直接矛盾；付费暂缓 / 不开放注册前提下这套没有落地。仅 `prefs` 分账与 `CHIHENG_DATA_DIR` 路径统一已做 |
| `ARCHIVED-赤轨-收款落地清单.md` | 10-22 | 爱发电 / 面包多，写「只差一个链接」 | 付费模式已**暂缓**，链接仍未填（`pricing.ts:66` 占位）；`grant-plan.ts` 只对 Neon 有意义，而 Neon 未挂。整条收费线冻结 |

## 现行真源（看这些，别看上面）

| 想找什么 | 看哪 |
|---|---|
| 项目入口 / 怎么跑 | `PROJECT.md`、`README.md` |
| 策略判决 / 铁律 | `design/STRATEGY-GEN2.md`、`AI-BOUNDARY.md` |
| 页面清单与分组 | `src/components/screener/nav.tsx` 的 `SIDEBAR`；`PROJECT.md` §3 |
| 界面色值 / 主题 | `src/styles.css`（`design/redesign-2026-11/` 是 11-12 起现行设计稿） |
| 两份名单对账与 P2 裁决 | `design/P2-RECONCILE-REPORT.md`、`design/PLAN-unify-daily-picks.md`、`scripts/reconcile-p2.ts` |
| 口径说明组件 | `src/components/scope-note.tsx` |
| 部署 / 运维 / 推送 | `OPS.md`、`README.md` 后半、`scripts/home-server.mjs` |

## 一句话

这批文档的**过程价值**（DSH 怎么接进来的、隔离方案怎么分类的、收款要考虑什么）还在，
但里面的「现状」「待办」「已建页面」全部停留在 10-22/10-23，跟 11-13 的代码对不上。
留着备查，别当施工依据。
