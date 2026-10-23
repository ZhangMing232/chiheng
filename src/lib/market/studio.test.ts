/**
 * 这个文件是干什么的：
 * 钉住自媒体图文的**体裁系统**——这次重写就是解决"所有内容都长一个样"，
 * 所以测试的核心是：不同体裁必须出不同版式、不同文案指令。
 *
 * 重点：
 * 1. 五种体裁 → 四种版式的映射（ranking/event/stat/ladder）
 * 2. topN 真的生效（5/10/15）
 * 3. event 体裁按用户选的下标取快讯，不是永远第一条
 * 4. 空数据不崩、不出假内容（无快讯/无连板各有兜底文案）
 * 5. 每种体裁的文案指令不同（GENRE_VOICE 分化，防回归成一套 prompt）
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GENRES,
  TOPIC_LABEL,
  buildStudioSpec,
  defaultTitle,
  genreOf,
  titleFromCaption,
  type StudioData,
} from "@/lib/market/studio";
import { GENRE_VOICE } from "@/lib/market/studio";

const DATA: StudioData = {
  indices: [
    { id: "sh000001", name: "上证指数", price: 3891.23, pct: 0.42, chg: 16.3 } as never,
    { id: "sz399001", name: "深证成指", price: 12876.5, pct: -0.18, chg: -23.2 } as never,
  ],
  breadth: { up: 2843, down: 2106, flat: 176, limitUp: 48, limitDown: 7 },
  flow: {
    stocksIn: [
      { name: "紫金矿业", inflow: 128600, chg: 2.31 },
      { name: "中际旭创", inflow: 98200 },
      { name: "宁德时代", inflow: 87100 },
      { name: "贵州茅台", inflow: 65400 },
      { name: "比亚迪", inflow: 54300 },
      { name: "立讯精密", inflow: 43200 },
    ],
    stocksOut: [
      { name: "东方财富", inflow: -45600 },
      { name: "中信证券", inflow: -38900 },
    ],
    sectorsIn: [
      { name: "半导体", inflow: 210400 },
      { name: "有色金属", inflow: 156700 },
      { name: "新能源车", inflow: 98600 },
    ],
    sectorsOut: [
      { name: "银行", inflow: -98700 },
      { name: "煤炭", inflow: -65400 },
      { name: "电力", inflow: -32100 },
    ],
    north: [],
    market: [],
    tape: [],
    asOf: 0,
  } as never,
  hotMoney: {
    date: "2026-10-23",
    seats: [
      { name: "章盟主", netWan: 12000, stocks: [{ name: "某A" }, { name: "某B" }] },
      { name: "赵老哥", netWan: 8600, stocks: [{ name: "某C" }] },
    ],
  } as never,
  news: [
    { id: "n1", time: "10:23", title: "国务院部署新一轮设备更新", summary: "会议指出加快重点行业设备更新改造。", tone: "good", boards: [], stocks: [{ id: "s1", code: "600000", name: "浦发银行", chg: 1.2 }] },
    { id: "n2", time: "09:41", title: "央行开展 5000 亿 MLF 操作", summary: "本月 MLF 超额续作。", tone: "flat", boards: [], stocks: [] },
  ],
  breakRate: null,
  ladder: [
    { streak: 1, count: 48 },
    { streak: 2, count: 12 },
    { streak: 3, count: 4 },
    { streak: 4, count: 1 },
  ],
};

test("五种体裁都注册了，且各有数据源和条数选项", () => {
  assert.equal(GENRES.length, 5);
  for (const g of GENRES) {
    assert.ok(g.topics.length >= 1, `${g.label} 至少一个数据源`);
    assert.ok(g.topNOptions.length >= 1, `${g.label} 至少一个条数选项`);
    assert.ok(g.desc.length > 0, `${g.label} 要有说明（页面上显示）`);
  }
});

test("体裁 → 版式映射：榜单/游资=ranking，事件=event，复盘=stat，情绪=ladder", () => {
  assert.equal(buildStudioSpec("ranking", "stockIn", DATA, { topN: 10 }).layout, "ranking");
  assert.equal(buildStudioSpec("ranking", "sectorOut", DATA, { topN: 10 }).layout, "ranking");
  assert.equal(buildStudioSpec("hotmoney", "seats", DATA, { topN: 10 }).layout, "ranking");
  assert.equal(buildStudioSpec("event", "news", DATA, { topN: 1, newsIndex: 0 }).layout, "event");
  assert.equal(buildStudioSpec("recap", "daily", DATA, { topN: 1 }).layout, "stat");
  assert.equal(buildStudioSpec("sentiment", "ladder", DATA, { topN: 1 }).layout, "ladder");
});

test("ranking：topN 生效，红涨绿跌（净流出是负→绿）", () => {
  const spec = buildStudioSpec("ranking", "stockIn", DATA, { topN: 3 });
  assert.equal(spec.items!.length, 3);
  assert.equal(spec.items![0]!.name, "紫金矿业");
  assert.equal(spec.items![0]!.value, "+12.9亿");
  const out = buildStudioSpec("ranking", "stockOut", DATA, { topN: 5 });
  assert.ok(out.items![0]!.value.startsWith("-"), "净流出带负号");
});

test("游资：条目带「买了啥」note（这是游资体裁的招牌信息）", () => {
  const spec = buildStudioSpec("hotmoney", "seats", DATA, { topN: 5 });
  assert.equal(spec.items![0]!.name, "章盟主");
  assert.equal(spec.items![0]!.note, "买了 某A · 某B");
});

test("event：按用户选的下标取快讯，不是永远第一条", () => {
  const first = buildStudioSpec("event", "news", DATA, { topN: 1, newsIndex: 0 });
  assert.equal(first.title, "国务院部署新一轮设备更新");
  assert.equal(first.meta?.includes("浦发银行"), true, "meta 带涉及的票");
  const second = buildStudioSpec("event", "news", DATA, { topN: 1, newsIndex: 1 });
  assert.equal(second.title, "央行开展 5000 亿 MLF 操作");
});

test("recap：指数大数字 + 涨跌分布（up/down/flat 三个数都在）", () => {
  const spec = buildStudioSpec("recap", "daily", DATA, { topN: 1 });
  assert.equal(spec.stats!.length, 2);
  assert.equal(spec.stats![0]!.value, "3891.23");
  assert.equal(spec.stats![0]!.sub, "+0.42%");
  assert.deepEqual(
    { up: spec.breadth!.up, down: spec.breadth!.down, flat: spec.breadth!.flat },
    { up: 2843, down: 2106, flat: 176 },
  );
  assert.equal(spec.breadth!.limitUp, 48);
});

test("sentiment：梯队升序（1板→4板），带情绪脚注；空梯队有兜底", () => {
  const spec = buildStudioSpec("sentiment", "ladder", DATA, { topN: 1 });
  assert.deepEqual(spec.rungs!.map((r) => r.streak), [1, 2, 3, 4]);
  assert.ok(spec.mood?.includes("最高 4 板"));
  const empty = buildStudioSpec("sentiment", "ladder", { ...DATA, ladder: [] }, { topN: 1 });
  assert.equal(empty.rungs!.length, 0);
  assert.ok(empty.mood, "空梯队也要有话，不留空");
});

test("空数据不崩：没快讯/没榜单各有兜底，不出假条目", () => {
  const bare = { ...DATA, news: [], flow: null, hotMoney: null, ladder: [] } as StudioData;
  const ev = buildStudioSpec("event", "news", bare, { topN: 1, newsIndex: 0 });
  assert.ok(ev.body![0]!.includes("还没抓到快讯"));
  const rk = buildStudioSpec("ranking", "stockIn", bare, { topN: 10 });
  assert.equal(rk.items!.length, 0);
});

test("每种体裁的文案指令不同（防回归成一套 prompt 打天下）", () => {
  const voices = new Set(Object.values(GENRE_VOICE));
  assert.equal(voices.size, 5, "五段指令五个样，不能有重复");
  assert.ok(GENRE_VOICE.ranking.includes("甩"));
  assert.ok(GENRE_VOICE.event.includes("牵动"));
  assert.ok(GENRE_VOICE.sentiment.includes("梯队"));
});

test("genreOf：查不到回退到第一个（不崩）", () => {
  assert.equal(genreOf("ranking").id, "ranking");
  assert.equal(genreOf("不存在的体裁" as never).id, "ranking");
});

test("标题抽取：从文案里拿【标题】，超长或缺失回退默认", () => {
  assert.equal(titleFromCaption("【标题】主力今天跑了128亿\n【正文】…", "兜底"), "主力今天跑了128亿");
  assert.equal(titleFromCaption("【标题】特别特别特别特别特别特别特别特别特别特别长的标题", "兜底"), "兜底");
  assert.equal(titleFromCaption("没有标题行", "兜底"), "兜底");
  assert.equal(defaultTitle("ladder"), "连板梯队");
  assert.equal(TOPIC_LABEL.sectorIn, "板块净流入 TOP");
});

// ── L2 信息密度（2026-10-23，STUDIO-UPGRADE 第一层）──────────────────

test("L2 榜单：条目带涨跌幅小字（chg 有才显示，null 不编）", () => {
  const withChg = { ...DATA, flow: { ...DATA.flow, stocksIn: [{ name: "甲", inflow: 1000, chg: 3.25 }, { name: "乙", inflow: 800, chg: null }] } as never };
  const spec = buildStudioSpec("ranking", "stockIn", withChg, { topN: 5 });
  assert.equal(spec.items![0]!.sub, "+3.25%", "涨跌幅进 sub 小字");
  assert.equal(spec.items![1]!.sub, undefined, "chg 是 null 不显示，不编 0%");
});

test("L2 榜单：集中度分布条——前 3 vs 榜上其余，不足 4 行不画", () => {
  const spec = buildStudioSpec("ranking", "stockIn", DATA, { topN: 10 });
  assert.ok(spec.distrib, "10 行有集中度");
  // DATA.stocksIn 前 3：128600+98200+87100=313900；其余：65400+54300+43200=162900
  assert.equal(spec.distrib!.top3, 313900);
  assert.equal(spec.distrib!.rest, 162900);
  const few = { ...DATA, flow: { ...DATA.flow, stocksIn: [{ name: "甲", inflow: 100 }, { name: "乙", inflow: 90 }, { name: "丙", inflow: 80 }] } as never };
  assert.equal(buildStudioSpec("ranking", "stockIn", few, { topN: 5 }).distrib, undefined, "3 行画不出集中，不渲染");
});

test("L2 榜单：底部市场事实行（涨跌家数，全市场真数据）", () => {
  const spec = buildStudioSpec("ranking", "stockIn", DATA, { topN: 10 });
  assert.ok(spec.breadthLine?.includes("涨 2843"), "上涨家数在");
  assert.ok(spec.breadthLine?.includes("涨停 48"), "涨停数在");
});

test("L2 复盘：板块 mini 双榜各 3 条（条数纪律）", () => {
  const spec = buildStudioSpec("recap", "daily", DATA, { topN: 1 });
  assert.ok(spec.sectorMini, "有板块 mini 榜");
  assert.equal(spec.sectorMini!.gain.length, 3);
  assert.equal(spec.sectorMini!.gain[0]!.name, "半导体");
  assert.equal(spec.sectorMini!.lose.length, 3);
  assert.equal(spec.sectorMini!.lose[0]!.name, "银行");
});

test("L2 复盘：事实行从数据算，不写 AI 话", () => {
  const spec = buildStudioSpec("recap", "daily", DATA, { topN: 1 });
  assert.ok(spec.facts!.some((f) => f.includes("领涨三板块主力净流入合计")), "确定性描述");
  assert.ok(spec.facts!.some((f) => f.includes("涨停 48")), "涨跌停在事实行");
  // flow 没有时 mini 榜整个不渲染（不留空模块）
  const bare = { ...DATA, flow: null } as StudioData;
  assert.equal(buildStudioSpec("recap", "daily", bare, { topN: 1 }).sectorMini, undefined);
});

test("L2 情绪：炸板率进 spec（/signals 汇总，null 不渲染）", () => {
  const withRate = { ...DATA, breakRate: 40 };
  const spec = buildStudioSpec("sentiment", "ladder", withRate, { topN: 1 });
  assert.equal(spec.breakRate, 40);
  assert.equal(buildStudioSpec("sentiment", "ladder", DATA, { topN: 1 }).breakRate, null);
});

test("L2 游资：每席位最多带 2 只票（条数纪律，原来 3 只）", () => {
  const spec = buildStudioSpec("hotmoney", "seats", DATA, { topN: 5 });
  assert.equal(spec.items![0]!.note, "买了 某A · 某B", "2 只，不堆");
});

test("L2 事件：涉及票带涨跌幅（chg 有才显示）", () => {
  const spec = buildStudioSpec("event", "news", DATA, { topN: 1, newsIndex: 0 });
  assert.ok(spec.meta?.includes("浦发银行 +1.20%"), "票带涨跌幅：" + spec.meta);
});
