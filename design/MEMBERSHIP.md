# 赤轨会员体系方案（MEMBERSHIP.md）

> 2026-10-21 立项。目标：对标 Vibe Research / Vibe Trading 的开放模式，
> 但走出它们没走的一步——**注册登录 + 会员收费**，让赤轨从「个人项目」
> 变成「能养活自己的产品」。本文档是这一路的单一事实来源。

## 一、对标调研：那两个项目的「开放模式」到底是什么

### Vibe Research（simonlin1212/Vibe-Research，MIT，2.7k star）

- **完全开源 + 本地优先**：研究记录和资料全在用户自己电脑上，AI 用自己的
  （Claude Code / Codex / WorkBuddy 订阅或任意 Chat Completions API key）。
- **没有任何用户体系**：没有注册登录、没有账号、没有收费。官网 viberesearch.wiki
  是文档站。它的开放模式 = 「开源换 star + 自带 key 零成本运营」。
- 作者的收入模式（如果有）不在仓库里——大概率是流量/订阅转化，与产品无关。

### Vibe Trading（vibe-trading，本地量化 harness）

- 同样**无用户体系**。鉴权只出现在两个地方：LLM provider 的 OAuth 登录
  （OpenAI Codex / Copilot，用户自己的订阅）和券商通道 OAuth（用户自己的账户）。
  即「鉴权 = 用户带自己的凭证」，产品侧零账号。

### 结论

两个对标的「开放」都是**开源 + 本地 + BYO-key**，没有人做 SaaS 化会员。
这既是空白也是风险：赤轨做注册收费没有现成对标，要自己趟：
账号体系（Better Auth 已在仓库里）、会员闸（按 plan 分层）、
收款渠道（见下，**需要老板拍板**）。

## 二、账号体系（已决定）

- 复用仓库自带的 **Better Auth**（`/api/auth/*`），数据库与 app 数据同库
  （本地 PGLite / 部署时 Neon 同一套迁移）。
- 开通**邮箱+密码**注册登录（`src/lib/auth/email-password.ts` 翻 true）。
  不依赖 Grok OAuth broker（那是模板自带的中介，赤轨独立部署用不上）。
- 用户表加 `plan` 字段（`migrations/0002_membership.sql`）：
  `free`（默认）/ `pro-monthly` / `pro-yearly` / `lifetime` / `admin`。
  additionalFields 在 `src/lib/auth/server.ts` 注册，输入不可写（input:false），
  改 plan 只能走服务端脚本/支付回调。
- 会话：Better Auth 自带 session 表 + cookie（`__Host-` 前缀已配好）。

## 三、收款渠道（**待老板拍板**，先实现人工授予）

个人开发者收会员费的现实选项（2026-10 中国主体）：

| 渠道 | 资质要求 | 费率(约) | 周期 | 备注 |
|---|---|---|---|---|
| 微信支付/支付宝（原生） | **营业执照**（个体户即可） | 0.6% | T+1 | 最顺滑但要有主体；个体户注册成本低 |
| 爱发电 afdian | 无 | ~5-10% | 月结 | 创作者平台，粉丝付费心智成熟，适合早期验证 |
| 面包多 / 知识星球 | 无 | 5-10% | 月结 | 类似爱发电 |
| Stripe | 海外主体/香港卡 | 2.9%+ | T+7 | 面向海外用户才划算 |
| Lemon Squeezy / Polar | 无（MoR 代收） | 5-8% | 月结 | 软件出海标配，人民币用户不友好 |

**建议路径**：v1 用「人工授予」跑通闭环（用户爱发电付款 → 老板给邮箱开 plan），
同时注册个体户，v2 接微信支付原生/虎皮椒类第四方。**拍板项**：走哪条、定价多少
（建议 ¥29/月、¥299/年、¥999 终身，对齐投研工具行情）。

## 四、会员闸（分层方案）

v1 已上第一道硬闸：**AI 额度闸**（`src/lib/auth/quota.ts` + `quotes.functions.ts` 的
`aiGate`）——AI 闭环（进化/诊断）走内置接口、调用费记在老板账上，所以按 plan 限每日
次数：free 0 次；pro-monthly 进化 2 轮 + 诊断 5 次/天；pro-yearly 3+10；lifetime 5+20；
admin（主人）不限不计。计数按上海自然日清零，调用前记账、失败也计（防刷重试）。只闸
主动触发（页面按钮）；收盘 autoEvolve 是系统行为不过闸。
其余硬闸候选（等真有人付了再上）：
2. VT 工具矿山的高级工具（回测/研报检索）
3. 自选股/持仓条数上限
4. 远程访问（手机看家里部署的赤轨）——已有 Tailscale/域名方案，可对免费用户关闭

闸的实现位置：`src/lib/auth/middleware.ts` 的 `requireUserId` 已稳定，
加一个 `requirePlan(min)` 同层校验，失败返回 402 + 前端跳 /login 或升级页。

## 五、落地清单

- [x] 调研对标开放模式（本文 §一）
- [x] 邮箱密码注册登录（2026-10-21：flag 常开 + 迁移收编 + /login 页 + Nitro
      路由 server/routes/api/auth/[...].ts——TanStack 1.168 的 createFileRoute
      不认 server.handler，走了 Nitro 的框架级扫描才通；实测注册/会话全链路 200）
- [x] `plan` 字段 + 人工授予脚本（scripts/grant-plan.ts，仅 DATABASE_URL 形态）
- [x] 顶栏账号入口 + plan 徽章（AccountChip，未登录显示「登录」）
- [x] 会员页 /membership：定价（¥29/月 ¥299/年 ¥999 终身，pricing.ts 单一事实来源）
      + 人工授予开通流程 + 诚实口径（付费 = 每日 AI 额度 + 支持 + 锁定价）；
      账号徽章点进会员页，登录页回链
- [x] AI 额度闸 v1（quota.ts + aiGate，免费 0 次 / 付费按档位限每日次数，
      blurb 数字与 AI_QUOTA 由 pricing.test.ts 钉住同步）
- [ ] 已知限制：本机 serve 的 PGLite 是内存库，注册的用户重启即失——
      会员体系要真用，部署必须挂 Neon（DATABASE_URL）
- [ ] 收款渠道拍板 → 支付回调接 plan（等老板）
- [ ] requirePlan 其余硬闸（工具矿山/自选股上限/远程访问，有付费用户后）
- [x] 会员页展示「今日额度 x/y」（quota.functions.ts getAIQuotaStatus + 当前档位面板）
- [ ] 部署形态：多用户共用服务端时数据隔离审计（账本现在是全局单用户口径！）

## 六、风险与纪律

1. **账本隔离**：赤轨的账本（ai-log/因子判决/持仓）目前是全局单用户文件口径。
   真开放注册前必须决定：共享一本账（社区模式，简单但数据互相可见部分要隔离）
   还是按 user_id 分账（工作量大）。**这是开放前最大的坑，先想清楚再开门。**
2. **AI token 成本**：免费用户也能跑 AI 闭环 = 老板倒贴。额度闸要跟着注册一起上。
3. 判决纪律不变：会员体系只碰「谁能用」，不碰「判决规则怎么算」。
