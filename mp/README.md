# 赤轨 · 微信小程序

web 版（`src/`）搬到微信小程序的工作区。AppID 已写进 `project.config.json`。

## 现在有什么

```
mp/
├─ src/market/          从 web 版 src/lib/market 搬过来的 TS（维护用，不进小程序）
├─ build/market/        tsc 编译产物（CommonJS，.gitignore 掉了）
├─ miniprogram/         小程序本体
│  ├─ app.js/json/wxss  外壳 + 全站设计 token（和 web 版 styles.css 一一对应）
│  ├─ config.js         ★ 云开发环境 ID 填这里
│  ├─ lib/api.js        调云函数的唯一入口
│  ├─ lib/market/       编译产物，sync.cjs 自动同步
│  └─ pages/            lab / positions / news / symbol / flow 五页
├─ cloudfunctions/
│  ├─ quote/            抓行情、算选股（小程序所有外部数据都从这里出）
│  ├─ book/             账本读写（云数据库 days / rules 两个集合）
│  └─ record/           定时记账：记录当天买入、结算到期持仓、记沪深300 对照价
├─ verify.cjs           用真实账本跑一遍移植的代码，确认口径没走样
└─ sync.cjs             编译产物同步到小程序和各个云函数
```

## 跑起来要做的四件事

**① 填云开发环境 ID**
打开 `miniprogram/config.js`，把 `ENV_ID` 换成你自己的（形如 `chiheng-1a2b3c`）。
拿不到 ID：微信开发者工具顶部点「云开发」→ 进控制台 → 左上角环境名旁边那串。
**没填之前页面照样能打开**，只是拉不到数据——先看界面再补环境，好排查。

**② 上传并部署三个云函数**
在微信开发者工具里右键 `cloudfunctions/quote`（book、record 同理）→「上传并部署：云端安装依赖」。
`market/` 目录已经 `sync.cjs` 同步进去了，不用另外处理。

**③ 记账要自动跑，得配定时触发器**
`record` 这个云函数是定时任务，手动点一次也能跑，但不会自己跑。
云开发控制台 → 云函数 → record → 触发器 → 新建，cron 例如 `0 30 14 * * MON-FRI`（交易日 14:30）。

**④ 编译、真机预览**
工具里点「预览」扫码。体验版不需要审核，但要用它得在「版本管理」里把某个版本
设为体验版，并把自己的微信号加进体验成员（上限 15 人）。

## 改完 lib 之后要重新同步

```bash
node_modules/.bin/tsc -p mp/tsconfig.json   # 编译
node mp/sync.cjs                              # 同步到小程序和三个云函数
node mp/verify.cjs                            # 用真实账本验一遍数字没走样
```

三条命令按顺序跑。`verify.cjs` 会对不上的地方直接退出码 1。

## 口径搬过来了吗

搬了。`lab.ts` / `positions.ts` / `journal-book.ts` / `strategies.ts` 一个字没改，
它们算出来的数和 web 版完全一致——`verify.cjs` 每次都会用真实账本验一遍。

三条最容易走样的规矩，都在 `lib/market/journal-book.ts` 的注释里：
在拿的收益率是 `null` 不是 `0`；收盘后补记的那天（signalTime ≥ 15:00）整天不进统计；
跌停卖不出的持仓顺延到下一天，不按止损价成交。

## 还没做的

- **汇总图（海报）**：web 版用 canvas 画的那几张图，小程序要重写（canvas 2d API 不同）。
- **分时走势图**：资金页和个股详情那两条折线。
- **个股详情侧栏**：web 版点开一只票弹出的那一栏。
- **筛选范围**（板块/股价/市值）：偏好存在 `prefs` 集合里，页面还没做。
- 定时触发器不会自动配，得手动在控制台建。

## 导入 web 版账本（一次性）

云数据库是空的，不导的话实验台永远 0 笔 0 样本，看着像「这套规则没用」，
其实只是没数据。选股页空态上有个「导入 web 版账本」，点一下把 web 版
`data/books/dev-user.json` 的 2 天 71 笔写进 `days` 集合（openid 由云函数自己取）。

只在这个人的 `days` 为空时可用。已经记过的日期会被跳过——记下的成交不许改。

想重新生成种子数据（比如 web 版又记了新的）：

```bash
node -e "const b=require('./data/books/dev-user.json');console.log(JSON.stringify(b.days))"
# 把输出的数组替换掉 miniprogram/lib/seed-days.js 里 module.exports 的那一行
```
