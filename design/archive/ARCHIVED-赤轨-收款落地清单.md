# 赤轨 · 收款落地清单（爱发电 / 面包多）

> 2026-10-22。收款渠道已拍板：**爱发电（afdian.net）或面包多**。v1 走「人工授予」，代码已就绪。

---

## 1. 现状：代码已就绪，只差一个链接

- ✅ `scripts/grant-plan.ts`：人工授予脚本（`node ... grant-plan.ts <邮箱> <档位>`），档位 free/pro-monthly/pro-yearly/lifetime/admin。
- ✅ `src/lib/auth/pricing.ts`：定价单一事实来源（29/299/999），第 66 行有占位文案「去爱发电完成付款（渠道链接拍板后替换这里）」。
- ✅ `/membership` 页（`membership.tsx`）：已渲染「三档定价 + 人工授予流程 + 怎么开通」。
- ⬜ **只差**：把爱发电/面包多的真实付费页链接填进 `pricing.ts`。

## 2. 你要做的（约 10 分钟）

1. 去 [爱发电 afdian.net](https://afdian.net)（或面包多）注册创作者账号。
2. 建 3 个「赞助档位」对应三档会员：
   | 档位 | 定价 | 爱发电档位建议 |
   |---|---|---|
   | pro-monthly | ¥29/月 | 月度赞助 29 |
   | pro-yearly | ¥299/年 | 年度赞助 299 |
   | lifetime | ¥999 终身 | 单次赞助 999 |
3. 把爱发电主页链接（或每个档位链接）发我，我填进 `pricing.ts` 第 66 行 + `/membership` 页的按钮。

## 3. 开通流程（已写死在代码里，无需改）

```
用户在 /membership 选档位 → 跳爱发电付款 → 付款后私信店主报「注册邮箱」
→ 你在终端跑：node --experimental-strip-types --import ./scripts/alias.mjs scripts/grant-plan.ts <邮箱> <档位>
→ plan 立即生效，用户刷新页面徽章就变
```

## 4. 关键限制（诚实口径，页面上已写明）

- **无自动回调**：爱发电/面包多没有现成的「付款成功 → 自动改 plan」webhook，v1 是人工核验后跑脚本。所以 `/membership` 页写的是「自动支付接入中 · 现走人工授予」，不装成已接入。
- **必须挂 Neon**：`grant-plan.ts` 只对 `DATABASE_URL`（Neon）形态有意义；本机内存 PGLite 重启即清空，授予留不住。**所以收款上线前必须先接 Neon**（等你的连接串）。

## 5. v2 展望（有真实付费用户后再做）

- 爱发电有创作者 API（查询赞助订单），可做「定时轮询订单 → 自动跑 grant-plan」的半自动授予，不用 webhook。
- 若要真正自动回调，得换微信支付/支付宝原生（需个体户营业执照），或 Stripe/Lemon Squeezy（面向海外）。
