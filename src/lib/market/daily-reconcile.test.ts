/**
 * 对账纯函数的守门测试。
 *
 * 数据来自 2026-11-13 实测：/today 20 只信号、账本 3 笔成交、只重合 1 只
 * （九安医疗 002432，/today 挂单价 56.92 / 账本真实成交 56.70）。
 * 这里用同样的形状造 fixture，但只放必要的几只，测的是分类逻辑不是数字本身。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  reconcileDay,
  reconcileSummary,
  sixDigitCode,
  attributeBookOnly,
  attributeBookOnlyAll,
  BOOK_ONLY_LABEL,
  type ReconcileDay,
  type ReconcileSignal,
} from "./daily-reconcile.ts";

const DATE = "2026-11-13";

/** /today 的 20 只里挑 4 只做代表；其余行为不影响分类。 */
const signals: ReconcileSignal[] = [
  { code: "600015", name: "华夏银行", leg: "long", orderPrice: 6.6, verdict: "ok", fillStatus: "filled" },
  { code: "601997", name: "贵阳银行", leg: "long", orderPrice: 5.92, verdict: "ok", fillStatus: "missed" },
  { code: "002432", name: "九安医疗", leg: "long", orderPrice: 56.92, verdict: "ok", fillStatus: "filled" },
  { code: "000672", name: "上峰材料", leg: "short", orderPrice: null, verdict: "warn" },
];

const days: ReconcileDay[] = [
  {
    date: DATE,
    trades: [
      { code: "002648", name: "卫星化学", entry: 23.52, style: "value" },
      { code: "002432", name: "九安医疗", entry: 56.7, style: "value" },
      { code: "601009", name: "南京银行", entry: 12.58, style: "value" },
    ],
  },
];

test("sixDigitCode：带前缀的归一化，六位原样保留", () => {
  assert.equal(sixDigitCode("sh600015"), "600015");
  assert.equal(sixDigitCode("sz002432"), "002432");
  assert.equal(sixDigitCode("bj920000"), "920000");
  assert.equal(sixDigitCode("600015"), "600015");
  assert.equal(sixDigitCode(null), "");
});

test("三分类：1 只重合 / 3 只信号独有 / 2 笔账本独有，顺序不乱", () => {
  const r = reconcileDay({ date: DATE, signals, days });
  assert.equal(r.signalRows.length, 4);
  assert.deepEqual(r.matched.map((s) => s.code), ["002432"]);
  assert.deepEqual(r.signalOnly.map((s) => s.code), ["600015", "601997", "000672"]);
  assert.deepEqual(r.bookOnly.map((t) => t.code), ["002648", "601009"]);
  assert.equal(r.bookTradeCount, 3);
  assert.equal(r.missing, null);
  assert.equal(r.signalRows.map((x) => x.signal.code).join(","), signals.map((s) => s.code).join(","));
});

test("🔴 账本成交价用 entry，绝不用理论成交 fillPrice 冒充", () => {
  const r = reconcileDay({ date: DATE, signals, days });
  const hit = r.signalRows.find((x) => x.signal.code === "002432");
  assert.ok(hit?.bookTrade);
  // 信号侧的挂单价/理论成交是 56.92，账本真实成交是 56.70。
  assert.equal(hit.bookTrade.entry, 56.7);
  assert.notEqual(hit.bookTrade.entry, hit.signal.orderPrice);
  // 纯函数刻意不接收 fillPrice：类型上没有这个字段，值也无从进入 bookTrade。
  assert.equal("fillPrice" in hit.bookTrade, false);
});

test("日期不匹配不算重合：拿昨天的成交不能冒充今天", () => {
  const r = reconcileDay({
    date: DATE,
    signals,
    days: [{ date: "2026-11-12", trades: days[0]!.trades }],
  });
  assert.deepEqual(r.matched, []);
  assert.equal(r.bookTradeCount, 0);
  assert.equal(r.missing, null); // 读到了、只是当天没成交，不是数据缺口
  assert.equal(r.signalOnly.length, 4);
});

test("账本读不到：写明原因，不拿空数组冒充「没买」", () => {
  const noDays = reconcileDay({ date: DATE, signals, days: null });
  assert.match(noDays.missing ?? "", /账本读不到/);
  const why = reconcileDay({ date: DATE, signals, days: [], journalWhy: "没登录或登录状态过期" });
  assert.match(why.missing ?? "", /没登录或登录状态过期/);
  const noSignals = reconcileDay({ date: DATE, signals: null, days });
  assert.match(noSignals.missing ?? "", /信号名单读不到/);
});

test("账本读到了但当天没有记录：零成交是事实，不是缺口", () => {
  const r = reconcileDay({ date: DATE, signals, days: [] });
  assert.equal(r.missing, null);
  assert.equal(r.bookTradeCount, 0);
  assert.equal(r.matched.length, 0);
  assert.equal(r.signalOnly.length, 4);
});

test("同一只当天多笔成交：重合只算一次，成交笔数如实取真值", () => {
  const r = reconcileDay({
    date: DATE,
    signals: [signals[2]!],
    days: [
      {
        date: DATE,
        trades: [
          { code: "002432", name: "九安医疗", entry: 56.7 },
          { code: "002432", name: "九安医疗", entry: 56.9, variant: "value-stop10" },
        ],
      },
    ],
  });
  assert.equal(r.matched.length, 1);
  assert.equal(r.bookTradeCount, 2);
  assert.equal(r.bookOnly.length, 0);
});

test("带市场前缀的前瞻票也能对上账本", () => {
  const r = reconcileDay({
    date: DATE,
    signals: [{ code: "sz002432", name: "九安医疗", orderPrice: 56.92 }],
    days,
  });
  assert.deepEqual(r.matched.map((s) => s.code), ["sz002432"]);
});

test("汇总行数字从结果现算，不写死", () => {
  assert.equal(
    reconcileSummary(reconcileDay({ date: DATE, signals, days })),
    "信号 4 只 · 账本成交 3 笔 · 重合 1 只",
  );
});

// ── days[] 顺序守门（P2 报告 §5-③）─────────────────────────────────────
// 2026-11-13 实测：账本 days[] 是**降序**（新→旧），不是升序、也不是无序。
// 任何写 days[days.length - 1] 取「最新一天」的代码都会静默拿到最早那天
// （实测会拿到 2026-09-29 而不是 2026-11-13）。这条测试钉住两件事：
// 1. 造具时顺序乱了也能按 date 命中（本模块只认 date，不认位置）；
// 2. 反向钉死「按位置取最新」是错的 —— 它拿到的不是最新那天。

const unordered: ReconcileDay[] = [
  { date: "2026-09-29", trades: [{ code: "000001", name: "平安银行", entry: 11.0 }] },
  { date: DATE, trades: [{ code: "002432", name: "九安医疗", entry: 56.7 }] },
  { date: "2026-10-09", trades: [{ code: "600000", name: "浦发银行", entry: 8.0 }] },
];

test("days[] 乱序也按 date 命中，不依赖数组位置", () => {
  const r = reconcileDay({
    date: DATE,
    signals: [{ code: "002432", name: "九安医疗", orderPrice: 56.92 }],
    days: unordered,
  });
  assert.equal(r.matched.length, 1);
  assert.equal(r.bookTradeCount, 1);
});

test("守门：days[days.length-1] 取不到最新一天（反向验证这条纪律）", () => {
  const last = unordered[unordered.length - 1];
  assert.notEqual(last.date, DATE, "若这条挂了，说明 days[] 顺序约定变了，需同步全仓取最新一天的写法");
  // 正确写法是找 date，不是拿末项
  const byDate = unordered.find((d) => d.date === DATE);
  assert.equal(byDate?.date, DATE);
});

// ── 「账本独有」归因（P2 报告 §5-①）────────────────────────────────────

test("归因：variant / deepScan 一律算挑战者实验田", () => {
  assert.equal(attributeBookOnly({ code: "600690", name: "海尔智家", entry: 20.81, style: "value", variant: "value-stop10" }, new Set()), "experiment");
  assert.equal(attributeBookOnly({ code: "601857", name: "中国石油", entry: 11.96, style: "value", deepScan: true }, new Set()), "experiment");
});

test("归因：非现役 style 算已淘汰策略结算", () => {
  assert.equal(attributeBookOnly({ code: "300476", name: "胜宏科技", entry: 128, style: "rebound" }, new Set()), "retired");
});

test("归因：出现在 signals.jsonl 里算盘中新增扫描", () => {
  assert.equal(attributeBookOnly({ code: "002648", name: "卫星化学", entry: 23.52, style: "value" }, new Set(["002648"])), "intraday");
});

test("归因：读不到信号日志时老实标未留痕，不猜成盘中", () => {
  assert.equal(attributeBookOnly({ code: "601009", name: "南京银行", entry: 12.58, style: "value" }, null), "unknown");
});

test("归因：日志读到了但没这只，也算未留痕", () => {
  assert.equal(attributeBookOnly({ code: "601009", name: "南京银行", entry: 12.58, style: "value" }, new Set(["600000"])), "unknown");
});

test("归因：批量与原数组同序，标签可直接按 index 取", () => {
  const trades = [
    { code: "600690", name: "海尔智家", entry: 20.81, style: "value", variant: "value-stop10" },
    { code: "300476", name: "胜宏科技", entry: 128, style: "rebound" },
    { code: "002648", name: "卫星化学", entry: 23.52, style: "value" },
  ];
  assert.deepEqual(attributeBookOnlyAll(trades, new Set(["002648"])), ["experiment", "retired", "intraday"]);
  assert.equal(BOOK_ONLY_LABEL.experiment, "挑战者·深扫实验");
});
