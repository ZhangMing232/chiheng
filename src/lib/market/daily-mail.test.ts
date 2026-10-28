/**
 * daily-mail.ts 的守门测试。
 *
 * 测法：CHIHENG_DATA_DIR 指到临时目录，里面放 challengers/champions/factor-queue/
 * ai-log/agent-diagnosis 的夹具；账本天数直接当参数传（book-file 不走 env，
 * 所以 collectDailyMail 把它做成入参——收集逻辑这才测得了）。
 *
 * 钉的东西：
 *   1. 离判决还差几笔 = 15 − min(挑战者样本, 冠军样本)，冠军桶要考虑（Welch 门槛 30→15，aeabce4）
 *      「冠军是被转正的挑战者」（champions.json 映射）——两边桶弄错，进度条就是假的
 *   2. 没有样本说「还没有」，不显示 0.00%（0 会读成「不赚不亏」）
 *   3. 今日诊断：没有就明说没有；是旧报告就带日期，不冒充今天
 *   4. 待验因子：死了的（tombstone/decayed）不追、今天提的不算「明日验证」、
 *      lastRunAt 落今天才算「判决跑过它」
 *   5. 读不到的数据进 missing 单独说（拿不到 ≠ 没有）
 *   6. 渲染是纯函数：同一个 report 渲染两遍结果一致；HTML 里正文要转义
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDailyMail, renderDailyMail, type DailyMailReport, type MailBookDay } from "@/lib/market/daily-mail";

const DATE = "2026-10-25";
const YESTERDAY = "2026-10-24";

/** 造一个交易日账本：since=10-09 起每天一条（有的天没信号）。 */
function bookDays(): MailBookDay[] {
  const days: MailBookDay[] = [];
  for (let d = 9; d <= 25; d++) {
    const date = `2026-10-${String(d).padStart(2, "0")}`;
    if (d % 2 === 0) continue; // 偶数日没记账，交易日数照数（tradingDaysSince 按有记录的天数）
    days.push({ date, signalTime: "09:35", trades: [] });
  }
  return days;
}

/** 带样本的账本：breakout 冠军 5 笔、挑战者 2 笔；rebound 两边 0 笔。 */
function bookWithSamples(): MailBookDay[] {
  return [
    {
      date: "2026-10-20",
      signalTime: "09:35",
      trades: [
        { entry: 10, exit: 10.5, style: "breakout" },
        { entry: 10, exit: 11, style: "breakout" },
        { entry: 10, exit: 9.9, style: "breakout" },
        { entry: 10, exit: 10.2, style: "breakout" },
        { entry: 10, exit: 10.8, style: "breakout" },
      ],
    },
    {
      date: "2026-10-22",
      signalTime: "09:35",
      trades: [
        { entry: 10, exit: 10.4, style: "breakout", variant: "breakout-lcap-long" },
        { entry: 10, exit: 11.6, style: "breakout", variant: "breakout-lcap-long" },
      ],
    },
    { date: "2026-10-23", signalTime: "09:35", trades: [] },
  ];
}

type Fixture = {
  challengers?: unknown;
  champions?: unknown;
  queue?: unknown;
  aiLog?: unknown;
  diagnosis?: unknown;
};

async function withDataDir(fx: Fixture, fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "daily-mail-test-"));
  const prev = process.env.CHIHENG_DATA_DIR;
  process.env.CHIHENG_DATA_DIR = dir;
  try {
    await mkdir(dir, { recursive: true });
    if (fx.challengers !== undefined) await writeFile(join(dir, "challengers.json"), JSON.stringify(fx.challengers));
    if (fx.champions !== undefined) await writeFile(join(dir, "champions.json"), JSON.stringify(fx.champions));
    if (fx.queue !== undefined) {
      // string 当原始文件内容写（测「坏 JSON」用）；其余走 JSON.stringify
      await writeFile(join(dir, "factor-queue.json"), typeof fx.queue === "string" ? fx.queue : JSON.stringify(fx.queue));
    }
    if (fx.aiLog !== undefined) await writeFile(join(dir, "ai-log.json"), JSON.stringify(fx.aiLog));
    if (fx.diagnosis !== undefined) await writeFile(join(dir, "agent-diagnosis.json"), JSON.stringify(fx.diagnosis));
    await fn();
  } finally {
    if (prev === undefined) delete process.env.CHIHENG_DATA_DIR;
    else process.env.CHIHENG_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

const CHALLENGERS = {
  list: [
    {
      id: "breakout-lcap-long",
      style: "breakout",
      name: "放量突破·大市值长持",
      holdDays: 18,
      stopPct: 7,
      targetPct: 26,
      status: "running",
      since: "2026-10-09",
    },
    {
      id: "rebound-fast-revert",
      style: "rebound",
      name: "中期反转·短持快收",
      holdDays: 12,
      stopPct: 7,
      targetPct: 14,
      status: "running",
      since: "2026-10-09",
    },
    { id: "old-dead", style: "breakout", name: "已淘汰的", status: "rejected", since: "2026-10-09" },
  ],
};

const QUEUE = {
  entries: [
    { id: "f_old_tested", name: "老在验", category: "量能", direction: -1, expr: "std20", rationale: "", source: "ai", status: "tested", failCount: 1, runs: 1, createdAt: "2026-10-22T07:00:00.000Z", lastRunAt: "2026-10-24T16:30:00.000Z" },
    { id: "f_today", name: "今天提的", category: "动量", direction: 1, expr: "d5", rationale: "", source: "ai", status: "pending", failCount: 0, runs: 0, createdAt: `${DATE}T07:06:00.000Z`, lastRunAt: null },
    { id: "f_verdict_today", name: "今天判过的", category: "形态", direction: 1, expr: "amp20", rationale: "", source: "manual", status: "tested", failCount: 0, runs: 1, createdAt: `${YESTERDAY}T07:00:00.000Z`, lastRunAt: `${DATE}T16:30:00.000Z` },
    { id: "f_never_run", name: "没跑过的", category: "规模", direction: -1, expr: "floatCap", rationale: "", source: "ai", status: "pending", failCount: 0, runs: 0, createdAt: "2026-10-21T07:00:00.000Z", lastRunAt: null },
    { id: "f_dead", name: "已淘汰", category: "波动率", direction: 1, expr: "atr14", rationale: "", source: "ai", status: "tombstone", failCount: 2, runs: 2, createdAt: "2026-10-20T07:00:00.000Z", lastRunAt: "2026-10-23T16:30:00.000Z" },
    { id: "f_decayed", name: "衰减停跑", category: "反转", direction: -1, expr: "d60", rationale: "", source: "manual", status: "decayed", failCount: 0, runs: 4, createdAt: "2026-10-18T07:00:00.000Z", lastRunAt: "2026-10-24T16:30:00.000Z" },
  ],
  missing: null,
};

const AILOG = {
  entries: [
    { at: "2026-10-24T07:00:43.000Z", layer: "agent", trigger: "auto", ok: true, proposed: [], rejected: [], note: "昨天也诊断过" },
    { at: `${DATE}T07:00:43.000Z`, layer: "agent", trigger: "auto", ok: true, proposed: [], rejected: [] },
    { at: `${DATE}T07:06:00.000Z`, layer: "factor", trigger: "auto", ok: true, proposed: [{ id: "f_today", name: "今天提的" }], rejected: [] },
    { at: `${DATE}T07:07:00.000Z`, layer: "strategy", trigger: "auto", ok: true, proposed: [], rejected: ["名额占满"] },
  ],
};

test("收集：挑战者进度 = 15 − min(挑战者, 冠军)，没样本说 null 不编 0", async () => {
  await withDataDir({ challengers: CHALLENGERS, champions: {} }, async () => {
    const report = await collectDailyMail({ date: DATE, days: bookWithSamples() });
    assert.equal(report.challengers.length, 2, "只列在跑的");
    const lcap = report.challengers.find((c) => c.id === "breakout-lcap-long");
    assert.ok(lcap);
    assert.equal(lcap.chalClosed, 2);
    assert.equal(lcap.champClosed, 5);
    assert.equal(lcap.need, 13, "15 − min(2,5) = 13");
    // netReturn 扣往返手续费（ROUND_TRIP_COST = 0.102%）：(3.898% + 15.898%) / 2 = 9.898%
    assert.ok(Math.abs((lcap.chalMean ?? 0) - 0.09898) < 1e-6, "两笔扣费后均值 9.898%");
    // 冠军五笔毛收益 5%/10%/−1%/2%/8%，各扣 0.102% 后均值 4.698%
    assert.ok(Math.abs((lcap.champMean ?? 0) - 0.04698) < 1e-6, "冠军五笔扣费后均值 4.698%");
    const revert = report.challengers.find((c) => c.id === "rebound-fast-revert");
    assert.ok(revert);
    assert.equal(revert.chalClosed, 0);
    assert.equal(revert.need, 15);
    assert.equal(revert.chalMean, null, "没样本 = null，不是 0");
    assert.equal(revert.params, "持12天 / 止损7% / 目标14%");
    assert.equal(report.challengers.find((c) => c.id === "old-dead"), undefined, "已淘汰的不列");
  });
});

test("收集：冠军是被转正的挑战者时，样本桶跟着映射走", async () => {
  await withDataDir(
    {
      challengers: CHALLENGERS,
      // rebound 的冠军是转正的挑战者：它的已平仓样本应算进「冠军」桶
      champions: { rebound: "rebound-fast-revert" },
    },
    async () => {
      const days: MailBookDay[] = [
        {
          date: "2026-10-22",
          signalTime: "09:35",
          trades: [{ entry: 10, exit: 10.5, style: "rebound", variant: "rebound-fast-revert" }],
        },
      ];
      const report = await collectDailyMail({ date: DATE, days });
      const revert = report.challengers.find((c) => c.id === "rebound-fast-revert");
      assert.ok(revert);
      // 它既是冠军又是挑战者时，两个桶是同一批样本——数字必须一致，不能一个有一个没有
      assert.equal(revert.chalClosed, 1);
      assert.equal(revert.champClosed, 1);
      assert.equal(revert.need, 14);
    },
  );
});

test("收集：跑了几个交易日按账本里有记录的天数（since 及之后去重）", async () => {
  await withDataDir({ challengers: CHALLENGERS, champions: {} }, async () => {
    const report = await collectDailyMail({ date: DATE, days: bookDays() });
    // 9..25 奇数日：9,11,13,15,17,19,21,23,25 = 9 天
    assert.equal(report.challengers[0].days, 9);
  });
});

test("收集：待验因子——今天提的不算、死了的不追、判决日看 lastRunAt", async () => {
  await withDataDir({ challengers: CHALLENGERS, champions: {}, queue: QUEUE }, async () => {
    const report = await collectDailyMail({ date: DATE, days: [] });
    const ids = report.watchers.map((w) => w.id);
    assert.deepEqual(ids, ["f_verdict_today", "f_old_tested", "f_never_run"], "按提议日新的在前；f_today（今天提的）和两个死因子不在");
    const verdictToday = report.watchers.find((w) => w.id === "f_verdict_today");
    assert.equal(verdictToday?.verdictToday, true);
    assert.equal(verdictToday?.proposedOn, YESTERDAY);
    const old = report.watchers.find((w) => w.id === "f_old_tested");
    assert.equal(old?.verdictToday, false, "lastRunAt 是昨天，不算今天判过");
    assert.equal(old?.failCount, 1);
    const never = report.watchers.find((w) => w.id === "f_never_run");
    assert.equal(never?.lastRunAt, null);
  });
});

test("收集：今日闭环轮次从 ai-log 按今天数；诊断区分今天/旧/没有", async () => {
  await withDataDir({ aiLog: AILOG, queue: QUEUE }, async () => {
    const report = await collectDailyMail({ date: DATE, days: [] });
    assert.equal(report.todayRounds.factor, 1);
    assert.equal(report.todayRounds.strategy, 0);
    assert.equal(report.todayRounds.agent, true);
    assert.equal(report.todayRounds.agentAt, `${DATE}T07:00:43.000Z`);
  });

  // 今天的新诊断
  await withDataDir(
    { aiLog: AILOG, diagnosis: { at: `${DATE}T07:00:43.000Z`, summary: "今天的", factorLayer: "f", strategyLayer: "s", suggestions: ["a"], ruleChangeRequests: [] } },
    async () => {
      const report = await collectDailyMail({ date: DATE, days: [] });
      assert.equal(report.diagnosis?.isToday, true);
    },
  );

  // 只有旧诊断：isToday=false，但内容保留（渲染层负责标日期）
  await withDataDir(
    { aiLog: AILOG, diagnosis: { at: "2026-10-23T07:00:43.000Z", summary: "昨天的", factorLayer: "f", strategyLayer: "s", suggestions: [], ruleChangeRequests: [] } },
    async () => {
      const report = await collectDailyMail({ date: DATE, days: [] });
      assert.equal(report.diagnosis?.isToday, false);
      assert.equal(report.diagnosis?.summary, "昨天的");
    },
  );

  // 没有诊断文件
  await withDataDir({ aiLog: AILOG }, async () => {
    const report = await collectDailyMail({ date: DATE, days: [] });
    assert.equal(report.diagnosis, null);
  });
});

test("收集：队列读不到进 missing，不当成「没有因子」", async () => {
  await withDataDir({ queue: "{坏JSON" }, async () => {
    const report = await collectDailyMail({ date: DATE, days: [] });
    assert.equal(report.watchers.length, 0);
    assert.ok(report.missing.some((m) => m.includes("factor-queue.json")), "读不到要留痕");
  });
});

test("收集：ai-log 空也要说，不静默当成「AI 没干活」", async () => {
  await withDataDir({}, async () => {
    const report = await collectDailyMail({ date: DATE, days: [] });
    assert.ok(report.missing.some((m) => m.includes("ai-log")));
    assert.equal(report.todayRounds.factor, 0);
  });
});

function baseReport(over: Partial<DailyMailReport> = {}): DailyMailReport {
  return {
    date: DATE,
    todayRounds: { factor: 3, strategy: 0, agent: true, agentAt: `${DATE}T07:00:43.000Z` },
    diagnosis: null,
    challengers: [],
    watchers: [],
    missing: [],
    ...over,
  };
}

test("渲染：主题带日期和进度；三块标题 text/html 都有", () => {
  const { subject, text, html } = renderDailyMail(
    baseReport({
      challengers: [
        { id: "c1", name: "挑战者甲", style: "breakout", since: "2026-10-09", days: 9, chalClosed: 2, champClosed: 5, need: 28, chalMean: 0.1, champMean: 0.028, params: "持18天 / 止损7%" },
      ],
      watchers: [
        { id: "w1", name: "因子乙", proposedOn: YESTERDAY, status: "tested", failCount: 1, lastRunAt: null, verdictToday: false },
      ],
    }),
  );
  assert.ok(subject.includes(DATE));
  assert.ok(subject.includes("挑战者 1 在跑"));
  assert.ok(subject.includes("待验 1"));
  for (const head of ["一、今日诊断", "二、挑战者战况", "三、明日验证"]) {
    assert.ok(text.includes(head), `text 要有「${head}」`);
    assert.ok(html.includes(head), `html 要有「${head}」`);
  }
});

test("渲染：没有诊断就明说没有，不拿旧内容冒充", () => {
  const { text, html } = renderDailyMail(baseReport());
  assert.ok(text.includes("今天没有生成诊断报告"));
  assert.ok(html.includes("今天没有生成诊断报告"));
  assert.ok(!text.includes("（最近一次"), "没有旧报告时不许出现最近一次字样");
});

test("渲染：旧诊断带日期，不冒充今天", () => {
  const { text, html } = renderDailyMail(
    baseReport({
      diagnosis: { at: "2026-10-23T07:00:43.000Z", isToday: false, summary: "旧总评", factorLayer: "旧因子", strategyLayer: "旧策略", suggestions: ["旧建议"] },
    }),
  );
  assert.ok(text.includes("最近一次（2026-10-23）"));
  assert.ok(text.includes("旧总评"));
  assert.ok(html.includes("最近一次 2026-10-23"));
});

test("渲染：0 样本说「还没有已平仓样本」，不显示 0.00%", () => {
  const { text, html } = renderDailyMail(
    baseReport({
      challengers: [
        { id: "c1", name: "零样本", style: "rebound", since: "2026-10-09", days: 3, chalClosed: 0, champClosed: 0, need: 30, chalMean: null, champMean: null, params: "参数同冠军" },
      ],
    }),
  );
  assert.ok(text.includes("还没有已平仓样本"));
  assert.ok(!text.includes("0.00%"), "0 会读成不赚不亏，不许显示");
  assert.ok(html.includes("还没有已平仓样本"));
  assert.ok(text.includes("还差 30 笔"));
  assert.ok(html.includes("还差 30 笔"));
});

test("渲染：样本过 30 说「已过线」不显示 65/30；need=0 说等判决", () => {
  const { text, html } = renderDailyMail(
    baseReport({
      challengers: [
        { id: "c1", name: "老挑战者", style: "breakout", since: "2026-10-09", days: 40, chalClosed: 35, champClosed: 65, need: 0, chalMean: 0.03, champMean: 0.01, params: "p" },
      ],
    }),
  );
  assert.ok(text.includes("已过线（35 笔，均值 3.00%）"));
  assert.ok(text.includes("已过线（65 笔，均值 1.00%）"));
  assert.ok(!text.includes("35/30"), "30 是判决下限不是上限，过了线还显示 x/30 会读成「没攒够」");
  assert.ok(text.includes("样本已够，等判决"));
  assert.ok(html.includes("已过线（35 笔"));
  assert.ok(html.includes("样本已够，等判决"));
});

test("渲染：待验因子三种判决状态各说各的话", () => {
  const { text } = renderDailyMail(
    baseReport({
      watchers: [
        { id: "a", name: "判过的", proposedOn: YESTERDAY, status: "tested", failCount: 0, lastRunAt: `${DATE}T16:30:00.000Z`, verdictToday: true },
        { id: "b", name: "旧判的", proposedOn: "2026-10-22", status: "tested", failCount: 1, lastRunAt: "2026-10-24T16:30:00.000Z", verdictToday: false },
        { id: "c", name: "没跑的", proposedOn: "2026-10-21", status: "pending", failCount: 0, lastRunAt: null, verdictToday: false },
      ],
    }),
  );
  assert.ok(text.includes("判过的（2026-10-24 提）在验·未过 6 关｜今天的判决回测已跑过它"));
  assert.ok(text.includes("旧判的（2026-10-22 提）在验·未过 6 关（连续失败 1 次）｜最近一次判决 2026-10-24"));
  assert.ok(text.includes("没跑的（2026-10-21 提）待验（还没跑过回测）｜还没跑上回测（今晚判决回测会带上）"));
});

test("渲染：HTML 转义诊断正文，不把 <script> 当标签", () => {
  const { html } = renderDailyMail(
    baseReport({
      diagnosis: { at: `${DATE}T07:00:43.000Z`, isToday: true, summary: "<script>alert(1)</script>", factorLayer: "a<b", strategyLayer: "c&d", suggestions: [] },
    }),
  );
  assert.ok(!html.includes("<script>"), "正文里的标签必须转义");
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("a&lt;b"));
  assert.ok(html.includes("c&amp;d"));
});

test("渲染：读不到的数据单独成块，不混进内容冒充", () => {
  const { text, html } = renderDailyMail(baseReport({ missing: ["factor-queue.json 读不到（x）"] }));
  assert.ok(text.includes("读不到的数据（不是没有）"));
  assert.ok(text.includes("factor-queue.json 读不到"));
  assert.ok(html.includes("读不到的数据（不是没有）"));
});

test("渲染：纯函数——同一个 report 渲染两遍一字不差", () => {
  const report = baseReport({
    diagnosis: { at: `${DATE}T07:00:43.000Z`, isToday: true, summary: "s", factorLayer: "f", strategyLayer: "g", suggestions: ["x"] },
    challengers: [{ id: "c1", name: "甲", style: "breakout", since: "2026-10-09", days: 9, chalClosed: 2, champClosed: 5, need: 28, chalMean: 0.1, champMean: 0.028, params: "p" }],
    watchers: [{ id: "w", name: "乙", proposedOn: YESTERDAY, status: "tested", failCount: 1, lastRunAt: null, verdictToday: false }],
  });
  const a = renderDailyMail(report);
  const b = renderDailyMail(report);
  assert.deepEqual(a, b);
});
