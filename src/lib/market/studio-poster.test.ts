/**
 * 这个文件是干什么的：
 * 自媒体海报的**绘制层**测试。canvas 是浏览器 API，但「图上到底画了哪些字、
 * 哪些模块」是要钉住的（不然改版式把分布条/小榜删了没人知道）。
 * 办法：用记录型 fake ctx 顶替真实 canvas，把 fillText 的文本收集起来断言。
 *
 * 为什么值得写：L2 加了一堆模块（分布条/小榜/补充行），但沙箱里跑不了无头
 * 浏览器（Chrome 起不来），没法截图对比——这个测试就是那层的替代验证。
 *
 * 注意：测的是**画了什么**，不是画得好不好看（好不好看要看真图，那得人眼看）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

/** 记录型 canvas 上下文：所有绘制调用记下来，文字收集成数组。 */
type FakeCtx = {
  texts: string[];
  /** fillText 的文本和 y 坐标（用来验证文字没画到下一张卡片上） */
  positioned: { text: string; y: number }[];
  /** 卡片起点（roundRect 的 moveTo(x+r, y)，r=20 时 x+20 → 减 20 得卡片 x） */
  cardTops: number[];
  rects: number;
  /** fill() 次数 = 画了几个卡片（圆角矩形走 beginPath+fill，不走 fillRect） */
  fills: number;
  strokes: number;
  measureText(t: string): { width: number };
  createLinearGradient(...a: unknown[]): { addColorStop(...b: unknown[]): void };
  fillRect(...a: unknown[]): void;
  fillText(t: string, ...a: unknown[]): void;
  strokeText(...a: unknown[]): void;
  beginPath(): void;
  closePath(): void;
  moveTo(...a: unknown[]): void;
  arcTo(...a: unknown[]): void;
  fill(): void;
  stroke(): void;
  save(): void;
  restore(): void;
  translate(...a: unknown[]): void;
  rotate(...a: unknown[]): void;
  scale(...a: unknown[]): void;
  setLineDash(...a: unknown[]): void;
};

function fakeCtx(): FakeCtx {
  const ctx: FakeCtx = {
    texts: [],
    positioned: [],
    cardTops: [],
    rects: 0,
    fills: 0,
    strokes: 0,
    measureText: (t: string) => ({ width: t.length * 20 }),
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    fillRect: () => {
      ctx.rects += 1;
    },
    fillText: (t: string, x?: number, y?: number) => {
      ctx.texts.push(t);
      if (typeof y === "number") ctx.positioned.push({ text: t, y });
    },
    strokeText: () => {
      ctx.strokes += 1;
    },
    beginPath: () => undefined,
    closePath: () => undefined,
    moveTo: (x?: number, y?: number) => {
      // roundRect 的第一句是 moveTo(x + r, y)，r 固定 20
      if (typeof x === "number" && typeof y === "number") ctx.cardTops.push(y - 20);
    },
    arcTo: () => undefined,
    fill: () => {
      ctx.fills += 1;
    },
    stroke: () => undefined,
    save: () => undefined,
    restore: () => undefined,
    translate: () => undefined,
    rotate: () => undefined,
    scale: () => undefined,
    setLineDash: () => undefined,
  };
  return ctx;
}

/** 装一个假的 document，跑完拆掉。 */
function withFakeCanvas<T>(fn: (ctx: FakeCtx) => T): T {
  const g = globalThis as unknown as { document?: unknown; __studioCtx?: FakeCtx };
  const prevDoc = g.document;
  const prevCtx = g.__studioCtx;
  const ctx = fakeCtx();
  g.__studioCtx = ctx;
  g.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ctx,
      toBlob: () => undefined,
    }),
  };
  try {
    return fn(ctx);
  } finally {
    g.document = prevDoc;
    g.__studioCtx = prevCtx;
  }
}

const SPEC = {
  title: "主力净流入 TOP",
  subtitle: "主力资金 · 净流入",
  layout: "ranking" as const,
  items: [
    { name: "紫金矿业", value: "+12.9亿", color: "#ff5c5c", note: "+3.21%" },
    { name: "中际旭创", value: "+9.8亿", color: "#ff5c5c" },
  ],
  dist: { label: "前 3 名合计 / 其余全部", top: 313900, rest: 162900 },
  footNote: "上涨 2843 · 下跌 2106 · 平盘 176 · 涨停 48 · 跌停 7",
};

test("ranking 版式：分布条、条目、底部补充行都画上去了", async () => {
  const { drawStudioPoster } = await import("@/lib/market/studio-poster");
  await withFakeCanvas(async (ctx) => {
    const out = drawStudioPoster(SPEC, "vertical", Date.parse("2026-10-23T00:00:00+08:00"));
    assert.ok(out.canvas, "要返回 canvas");
    assert.ok(out.filename.includes("赤轨"));
    // 标题 + 副标题
    assert.ok(ctx.texts.includes("主力净流入 TOP"));
    assert.ok(ctx.texts.includes("主力资金 · 净流入"));
    // 条目名和值
    assert.ok(ctx.texts.includes("紫金矿业"));
    assert.ok(ctx.texts.includes("+12.9亿"));
    // 分布条标签与两个数
    assert.ok(ctx.texts.includes("前 3 名合计 / 其余全部"), "分布条标签要在图上");
    assert.ok(ctx.texts.some((t) => t.includes("31.4亿")), `分布条前 3 合计：${ctx.texts.join("|")}`);
    assert.ok(ctx.texts.some((t) => t.includes("16.3亿")), "其余合计也要标");
    // 底部补充行
    assert.ok(ctx.texts.some((t) => t.includes("上涨 2843")), "涨跌家数行要在图上");
    // 合规
    assert.ok(ctx.texts.some((t) => t.includes("不构成投资建议")), "免责要在图上");
    // 品牌与日期
    assert.ok(ctx.texts.includes("赤轨"));
    assert.ok(ctx.texts.includes("10月23日"));
    assert.ok(ctx.fills >= 3, `要有实际绘制（卡片），实际 fill 次数 ${ctx.fills}`);
  });
});

test("stat 版式：指数卡、分布条、领涨领跌小榜都画上去了", async () => {
  const { drawStudioPoster } = await import("@/lib/market/studio-poster");
  await withFakeCanvas(async (ctx) => {
    drawStudioPoster(
      {
        title: "今日 A 股",
        layout: "stat",
        stats: [
          { label: "上证指数", value: "3614.12", sub: "-1.20%", color: "#2dd4a0" },
          { label: "创业板指", value: "2286.40", sub: "-2.14%", color: "#2dd4a0" },
        ],
        breadth: { up: 609, down: 4554, flat: 176, limitUp: 21, limitDown: 86 },
        mini: [
          { title: "资金流入前三", rows: [{ name: "半导体", value: "21.0亿" }] },
          { title: "资金流出前三", rows: [{ name: "银行", value: "-9.9亿" }] },
        ],
      },
      "square",
      Date.parse("2026-10-23T00:00:00+08:00"),
    );
    assert.ok(ctx.texts.includes("上证指数"));
    assert.ok(ctx.texts.includes("3614.12"));
    assert.ok(ctx.texts.includes("-1.20%"));
    assert.ok(ctx.texts.includes("资金流入前三"), "小榜标题要画");
    assert.ok(ctx.texts.includes("资金流出前三"));
    assert.ok(ctx.texts.includes("半导体"));
    assert.ok(ctx.texts.includes("21.0亿"));
    assert.ok(ctx.texts.some((t) => t.includes("涨停 21")), "涨跌停计数要画");
  });
});

test("ladder 版式：梯队行和情绪脚注都在", async () => {
  const { drawStudioPoster } = await import("@/lib/market/studio-poster");
  await withFakeCanvas(async (ctx) => {
    drawStudioPoster(
      {
        title: "连板梯队",
        layout: "ladder",
        rungs: [
          { streak: 1, count: 48 },
          { streak: 2, count: 12 },
        ],
        mood: "最高 4 板，炸板率 33.3%。梯队越厚，愿意接力的钱越多。",
      },
      "vertical",
      Date.parse("2026-10-23T00:00:00+08:00"),
    );
    assert.ok(ctx.texts.includes("1板"));
    assert.ok(ctx.texts.includes("2板"));
    assert.ok(ctx.texts.includes("48 只"));
    assert.ok(ctx.texts.includes("12 只"));
    assert.ok(ctx.texts.some((t) => t.includes("炸板率 33.3%")), "情绪脚注要画");
  });
});

test("event 版式：meta、正文段落都画上去了", async () => {
  const { drawStudioPoster } = await import("@/lib/market/studio-poster");
  await withFakeCanvas(async (ctx) => {
    drawStudioPoster(
      {
        title: "国务院部署新一轮设备更新",
        subtitle: "快讯深读",
        layout: "event",
        meta: "10:23 · 涉及 浦发银行 +1.20%",
        body: ["会议指出加快重点行业设备更新改造。", "牵扯到的票：浦发银行 +1.20%。"],
      },
      "vertical",
      Date.parse("2026-10-23T00:00:00+08:00"),
    );
    assert.ok(ctx.texts.includes("10:23 · 涉及 浦发银行 +1.20%"));
    assert.ok(ctx.texts.includes("会议指出加快重点行业设备更新改造。"));
    assert.ok(ctx.texts.includes("牵扯到的票：浦发银行 +1.20%。"));
  });
});

test("空条目不崩：items 为空时照样出图（只是没有列表）", async () => {
  const { drawStudioPoster } = await import("@/lib/market/studio-poster");
  await withFakeCanvas(async (ctx) => {
    const out = drawStudioPoster({ title: "空榜", layout: "ranking", items: [] }, "vertical");
    assert.ok(out.canvas);
    assert.ok(ctx.texts.includes("空榜"));
  });
});

test("🔴 带小字的行不挤到下一张卡片上（另一个会话先发现的行高 bug）", async () => {
  const { drawStudioPoster } = await import("@/lib/market/studio-poster");
  await withFakeCanvas(async (ctx) => {
    drawStudioPoster(
      {
        title: "带小字的榜单",
        layout: "ranking",
        items: [
          { name: "甲", value: "+1亿", color: "#ff5c5c", note: "+3.21%" },
          { name: "乙", value: "+2亿", color: "#ff5c5c" },
          { name: "丙", value: "+3亿", color: "#ff5c5c", note: "-1.00%" },
        ],
      },
      "vertical",
      Date.parse("2026-10-23T00:00:00+08:00"),
    );
    // 卡片起点（升序）：第 1 张、带 note 的第 2 张更靠后 → 行高按内容分三态
    const tops = [...ctx.cardTops].sort((a, b) => a - b);
    assert.ok(tops.length >= 3, `至少 3 张卡片，实际 ${tops.length}`);
    // 带 note 的行（甲）到下一张卡（乙）的距离必须容得下小字
    const noteY = ctx.positioned.find((p) => p.text === "+3.21%")!.y;
    const secondCardTop = tops[1]!;
    assert.ok(noteY < secondCardTop, `小字 y=${noteY} 必须在下一张卡片起点 ${secondCardTop} 之前`);
  });
});

test("🔴 列表不能压到底部事实行/免责区（行高计算要扣掉分布条高度）", async () => {
  const { drawStudioPoster } = await import("@/lib/market/studio-poster");
  await withFakeCanvas(async (ctx) => {
    // 竖版 1080×1920，**8 条**带分布条 + 事实行。
    // ⚠️ 条数很关键：5 条时增量被 MAX_ROW_EXTRA(80) 封顶，两种算法结果一样，
    // 测不出顺序 bug；8 条时封顶不生效，顺序错了才会压到事实行（实测）。
    drawStudioPoster(
      {
        title: "主力净流入 TOP",
        subtitle: "主力资金 · 净流入",
        layout: "ranking",
        items: Array.from({ length: 8 }, (_, i) => ({
          name: `票${i + 1}`,
          value: "+1.0亿",
          color: "#ff5c5c",
          note: "+1.00%",
        })),
        dist: { label: "前 3 名合计 / 其余全部", top: 320247, rest: 334200 },
        footNote: "上涨 2135 · 下跌 2887",
      },
      "vertical",
      Date.parse("2026-10-23T00:00:00+08:00"),
    );
    const tops = [...ctx.cardTops].sort((a, b) => a - b);
    const lastBottom = tops[tops.length - 1]! + 132; // 最后一张卡片（含 note 行高 132）
    const footY = ctx.positioned.find((p) => p.text.startsWith("上涨 2135"))?.y ?? 0;
    assert.ok(footY > lastBottom, `事实行 y=${footY} 必须 below 最后一张卡片底边 ${lastBottom}`);
    assert.ok(footY < 1920 - 48, `事实行 y=${footY} 不能压到免责区（1920-48）`);
  });
});
