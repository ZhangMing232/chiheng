/**
 * 旧路由兼容。/flow/hot（资金流向的「游资」子页）2026-11-12 并进「游资与席位」
 * （/youzi/track）。本文件不再渲染页面，进来直接送过去。
 *
 * 为什么并：两页读的是同一个 getHotMoney()、同一天同一批龙虎榜席位，
 * 只是一个画成「一行一个席位」、一个按游资名号聚合成净买/净卖两栏。
 * 用户原话「那个资金流向里的游资那个页面也可以删掉了，和那个游资与席位又重复了」。
 *
 * 并之前把旧页独有的东西挪过去了：每只成分股的净买/净卖金额（原 /youzi/track
 * 只有股票名）、生成汇总图的按钮。旧页的排序与席位别名本来就在 hotmoney.ts，共用。
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/flow/hot")({
  beforeLoad: () => {
    throw redirect({ to: "/youzi/track", replace: true });
  },
});
