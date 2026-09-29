# 赤衡

A 股选股。每天给出最多 3 只刚启动、还没走远的股票，附参考买入价。调入之后放进等待卖出的股票池，到期记入历史信号。

这不是投资建议，也不会下单。

默认条件：今日涨幅 1%–4.5%，5 日 0–8%，20 日 -3%–12%，60 日 -10%–25%，量比 1.2–2.8，换手 1.5%–12%，成交额至少 5000 万。不选 ST，不碰涨跌停。

## 部署到自己的电脑

需要 Node.js 22 或更新版本。

```bash
git clone https://github.com/ZhangMing232/chiheng.git
cd chiheng
npm install
npm run build
npm run serve
```

本机打开 http://127.0.0.1:8787 。交易日 14:40 前开着并保持到收盘，当天名单才会写入 `data/journal.json`。

开发用 `npm run dev`，地址 http://127.0.0.1:8080 ，不会自动记账。
