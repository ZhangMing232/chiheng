/**
 * 竞价审核：读取收盘后生成的候选信号，拉东财分时竞价数据审核每条信号。
 * 9:25 竞价结束后跑（约 9:26），审核结果写入 data/signals/reviewed.json。
 * 2026-11-09 晚起分两腿推送：中长线「明日买入单」+ 短线「短线买入单」
 * （题材补涨），每天各一条、无候选也推——静默只留给「服务没开」。
 *
 * 审核逻辑：
 * - 竞价出清价 vs 挂单价：差距在 ±2% 内 = 交易窗口正常
 * - 竞价量能 vs 近期日均：太低 = 流动性不足
 * - 竞价匹配量趋势：最后 5 分钟萎缩 = 警惕
 *
 * 用法：
 *   node --experimental-strip-types --import ./scripts/alias.mjs scripts/review-auction.ts
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { legOf, orderFieldsOf, type Leg } from "./lib/signal-legs.ts";
import { boardLimitPct } from "@/lib/market/short-forms";

const DATA = process.env.CHIHENG_DATA_DIR ?? "data";

interface Candidate {
  date: string;
  id: string;
  code: string;
  name: string;
  strategy: string;
  buyPrice: number;
  score: number;
  reason: string;
  stop?: number;
  target?: number;
  /** 腿：short 短线（题材补涨）/ long 中长线。generate-signals 2026-11-10 起写入，旧文件按策略名回退。 */
  leg?: Leg;
  /** 第 N 个交易日收盘走（买入日算第 1 日）。旧候选文件没有，按腿回退。 */
  holdDays?: number;
}

interface Reviewed extends Candidate {
  auctionPrice: number | null;
  auctionGap: number | null;   // (auction - buy) / buy * 100
  verdict: "ok" | "warn" | "skip";
  verdictReason: string;
}

async function main() {
  // 1. 读候选信号
  let candidates: { date: string; signals: Candidate[] };
  try {
    candidates = JSON.parse(await readFile(`${DATA}/signals/candidates.json`, "utf8"));
  } catch {
    // 管道断了也要有声音（2026-11-09 修静默洞）：原来这里直接 return，早上什么都不推，
    // 用户看到的是「没有推送」而不是「没跑成」。现在推一条说明 + 落日期标记挡住重启重推。
    console.log("没有候选信号文件");
    try {
      const { sendPushPlus } = await import("../src/lib/market/push.ts");
      await sendPushPlus(
        "⚠️ 明日买入单 · 候选文件缺失",
        [
          `信号日：${new Date().toLocaleDateString("sv-SE")}`,
          "昨天 15:30 信号生成没跑成（data/signals/candidates.json 不在），今天没有买入单。",
          "不是没有信号，是管道断了——看 home-server 日志。",
        ].join("\n"),
        "txt",
      );
    } catch (e) {
      console.log(`PushPlus 推送失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    await mkdir(`${DATA}/signals`, { recursive: true });
    await writeFile(
      `${DATA}/signals/reviewed.json`,
      JSON.stringify({ date: new Date().toISOString().slice(0, 10), candidates: 0, reviewed: 0, ok: 0, warn: 0, skip: 0, signals: [], missing: true }, null, 2),
    );
    return;
  }

  if (!candidates.signals?.length) {
    // 空候选也走完推送流程（下面两腿各推一条「今日无候选」），不再静默 return
    console.log("候选信号为空，仍推「无候选」说明");
  }

  console.log(`候选信号 ${candidates.signals.length} 条，开始竞价审核...\n`);

  const reviewed: Reviewed[] = [];

  for (let ci = 0; ci < candidates.signals.length; ci++) {
    const s = candidates.signals[ci];
    let auctionPrice: number | null = null;
    let prevClose: number | null = null;

    try {
      // 用腾讯快照接口（东财被墙）拿开盘价作为竞价审核依据
      const prefix = s.id.startsWith("sh") ? "sh" : "sz";
      const url = `https://web.sqt.gtimg.cn/utf8/q=${prefix}${s.code}`;
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
      const text = await res.text();
      const fields = text.split("~");
      // 腾讯快照格式：0=name, 3=现价, 4=昨收, 5=开盘(竞价出清价)
      const openPrice = Number(fields[5]);
      const pc = Number(fields[4]);
      if (pc > 0) prevClose = pc;
      if (openPrice > 0) auctionPrice = openPrice;
    } catch (e) {
      console.log(`  ${s.code} ${s.name} 竞价数据拉取失败: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 审核判决
    let verdict: Reviewed["verdict"] = "ok";
    let verdictReason = "";
    let gap: number | null = null;

    if (auctionPrice == null) {
      verdict = "skip";
      verdictReason = "竞价数据缺失，无法审核";
    } else if (
      // 一字涨停拦截（2026-11-10 P1-3 撮合口径）：竞价开在涨停价附近＝封死，
      // 挂单价买不到，不追（追板/连板是项目最强反向 t=−10.2）。
      // 涨跌停幅度唯一出处是 short-forms.ts 的 boardLimitPct，容差同它的 TOUCH。
      prevClose != null &&
      auctionPrice >= prevClose * (1 + (boardLimitPct(s.id) - 0.15) / 100) * 0.998
    ) {
      verdict = "skip";
      verdictReason = "竞价封死涨停（开盘即板），挂单价买不到——不追";
    } else {
      gap = ((auctionPrice - s.buyPrice) / s.buyPrice) * 100;
      if (gap > 3) {
        verdict = "warn";
        verdictReason = `竞价高开 ${gap.toFixed(1)}%，挂单价 ${s.buyPrice} 可能买不到，建议等开盘回踩`;
      } else if (gap < -3) {
        verdict = "warn";
        verdictReason = `竞价低开 ${Math.abs(gap).toFixed(1)}%，有更便宜的买入机会，但需确认不是利空`;
      } else if (gap >= -2 && gap <= 2) {
        verdict = "ok";
        verdictReason = `交易窗口正常（竞价 ${auctionPrice} vs 挂单 ${s.buyPrice}，偏差 ${gap.toFixed(1)}%）`;
      } else {
        verdict = "warn";
        verdictReason = `竞价 ${auctionPrice} vs 挂单 ${s.buyPrice}，偏差 ${gap.toFixed(1)}%，建议观望`;
      }
    }

    // skip 的行也要落盘（2026-11-09 修：原来 reviewed.push 在 else 里，拉不到竞价的
    // 候选直接蒸发、skip 恒 0——「没审成」必须看得见，不能比「审过」更隐形）
    reviewed.push({
      ...s,
      auctionPrice,
      auctionGap: gap != null ? +gap.toFixed(2) : null,
      verdict,
      verdictReason,
    });

    // 东财接口限流
    if (ci % 20 === 19) await new Promise(r => setTimeout(r, 500));
  }

  const ok = reviewed.filter(r => r.verdict === "ok");
  const warn = reviewed.filter(r => r.verdict === "warn");
  const skip = reviewed.filter(r => r.verdict === "skip");

  console.log(`审核完成：🟢 ${ok.length} 可执行 | 🟡 ${warn.length} 需观望 | ⚪ ${skip.length} 跳过\n`);

  // 腿归属：新候选文件带 leg 字段；旧文件按策略名回退（规则在 scripts/lib/signal-legs.ts）
  const shortRows = reviewed.filter((r) => legOf(r) === "short");
  const longRows = reviewed.filter((r) => legOf(r) !== "short");

  // 窗口标记：只有 9:26~12:00 的腾讯「开盘价」才是今晨竞价；别的时间跑（手动预演/
  // 补跑）拿到的是当日开盘价代用——标【预演】，不让代用数字冒充竞价。
  const nowM = new Date();
  const hm = nowM.getHours() * 60 + nowM.getMinutes();
  const inWindow = hm >= 9 * 60 + 26 && hm < 12 * 60;
  const tag = inWindow ? "" : "【预演】";
  const dayLine = inWindow
    ? `信号日：${nowM.toLocaleDateString("sv-SE")}（竞价已核对）`
    : `信号日：${nowM.toLocaleDateString("sv-SE")}（预演：非竞价窗口，「竞价」价以当日开盘价代用）`;

  // ── 「市场在玩什么」概览：涨停/连板/最高板/炸板率/情绪 + 题材热度 Top6 ──
  //    2026-11-12 合并推送：原来 9:26 这里推两条腿，runDecisionPush 再推一条「今日决策」，
  //    三条说的是同一件事、内容还重叠。现在概览并进当天第一条（中长线腿）顶部，
  //    决策那条不再单独发（push-decision.ts 留着手动补发用）。
  const marketLines = await (async (): Promise<string[]> => {
    const readMaybe = async <T,>(p: string): Promise<T | null> => {
      try {
        return JSON.parse(await readFile(`${DATA}/${p}`, "utf8")) as T;
      } catch {
        return null;
      }
    };
    const snap = await readMaybe<{
      limitUp?: unknown[];
      limitDown?: unknown[];
      summary?: { ladder?: { streak: number; count: number }[]; breakRate?: number | null } | null;
    }>("signals/limit-pools-today.json");
    const th = await readMaybe<{
      hot?: { name: string; limitUp: number; avg: number; leader?: { name?: string } | null }[];
    }>("theme-heat.json");
    if (!snap && !th) return [];
    const ladder = snap?.summary?.ladder ?? [];
    const ladderCount = ladder.reduce((n, l) => n + (l.streak >= 2 ? l.count : 0), 0);
    const maxStreak = ladder.reduce((m, l) => Math.max(m, l.streak), 0);
    const br = snap?.summary?.breakRate ?? null;
    const mood =
      br != null && br >= 0.4
        ? "退潮 —— 炸板率高，追高被套概率大，短线少动"
        : maxStreak >= 5
          ? "沸点 —— 情绪亢奋，只跟题材不追高连板"
          : ladderCount >= 15 && (br ?? 0) < 0.25
            ? "温和偏热 —— 梯队健康，短线可做题材龙头"
            : ladderCount < 5
              ? "冰点 —— 情绪冷，冰点不抄底，观望"
              : "温和 —— 中性，只做有题材支撑的票";
    const out = ["【市场在玩什么】"];
    out.push(
      `涨停 ${snap?.limitUp?.length ?? 0} · 连板 ${ladderCount} · 最高 ${maxStreak}板 · 跌停 ${snap?.limitDown?.length ?? 0} · 炸板率 ${br != null ? (br * 100).toFixed(0) + "%" : "—"}`,
    );
    out.push(`情绪：${mood}`);
    for (const t of (th?.hot ?? []).slice(0, 6)) {
      out.push(`  · ${t.name}｜${t.limitUp}涨停｜均${t.avg > 0 ? "+" : ""}${t.avg.toFixed(1)}%｜龙头${t.leader?.name ?? "—"}`);
    }
    return out;
  })();

  // ── PushPlus 推送：两腿各推一条（2026-11-09 晚补「早上看不到短线」的洞：
  //    短线原来只有 15:10 收盘热榜，早盘管道里根本没有它）。每天必响——
  //    无候选也推「今日无候选」，静默只留给「服务没开」。─────────────────
  try {
    const { sendPushPlus } = await import("../src/lib/market/push.ts");
    const gapText = (r: (typeof reviewed)[number]) =>
      r.auctionGap != null ? `${r.auctionGap > 0 ? "+" : ""}${r.auctionGap}%` : "--";

    // 中长线腿：原「明日买入单」格式不动（2026-11-09 用户要求「选出→告诉我让我买入」）：
    // 执行行压成「买 价格 | 止损 | 目标」三要素，一眼可下单；纪律一行钉死。
    {
      const fmt = (r: (typeof reviewed)[number], mark: string) =>
        `${mark} ${r.name} ${r.code} | ${orderFieldsOf(r)} | 竞价${r.auctionPrice} ${gapText(r)}`;
      const lok = longRows.filter((r) => r.verdict === "ok");
      const lwarn = longRows.filter((r) => r.verdict === "warn");
      const lskip = longRows.filter((r) => r.verdict === "skip");
      const lines = [
        ...lok.slice(0, 10).map((r) => fmt(r, "🟢")),
        ...lwarn.slice(0, 10).map((r) => fmt(r, "🟡")),
      ];
      const title = lok.length + lwarn.length === 0
        ? `${tag}明日买入单 · 今日无中长线候选`
        : lok.length > 0
          ? `${tag}明日买入单 · 🟢${lok.length} 可执行`
          : `${tag}今日观望 · 🟡${lwarn.length} 只`;
      const sent = await sendPushPlus(title, [
        dayLine,
        ...marketLines,
        "──────────────────",
        ...(lines.length ? lines : ["今天没有到买点的中长线票——不买就是今天的操作。"]),
        ...(lskip.length ? [`⚪ ${lskip.length} 只竞价数据缺失没审成（不是没信号）`] : []),
        "──────────────────",
        "怎么走：买入日算第 1 日，行末「走 第N日」那天收盘卖；止损/目标先到先走 · 买入当天不卖",
        "挂单价打到才买。单笔不保证，30 笔一批算期望；连亏是这套打法的常态。",
        ...(lok.length === 0 && lwarn.length > 0 ? ["今天没有到买点的票——🟡 就是不买，等明天。"] : []),
      ].join("\n"), "txt");
      console.log(sent ? "中长线腿推送已发送" : "中长线腿没推出去（看上一行的原因），审核结果已落盘不影响页面");
    }

    // 短线腿：题材补涨「短线买入单」。行格式同中长线三要素，多带一句题材理由。
    {
      const fmt = (r: (typeof reviewed)[number], mark: string) =>
        `${mark} ${r.name} ${r.code}｜${r.reason.slice(0, 24)}｜${orderFieldsOf(r)} | 竞价${r.auctionPrice} ${gapText(r)}`;
      const sok = shortRows.filter((r) => r.verdict === "ok");
      const swarn = shortRows.filter((r) => r.verdict === "warn");
      const sskip = shortRows.filter((r) => r.verdict === "skip");
      const lines = [
        ...sok.slice(0, 8).map((r) => fmt(r, "🟢")),
        ...swarn.slice(0, 5).map((r) => fmt(r, "🟡")),
      ];
      const title = sok.length + swarn.length === 0
        ? sskip.length > 0
          ? `${tag}短线买入单 · ⚪${sskip.length} 竞价缺失没审成`
          : `${tag}短线买入单 · 今日无候选`
        : sok.length > 0
          ? `${tag}短线买入单 · 🟢${sok.length} 可跟`
          : `${tag}短线买入单 · 🟡${swarn.length} 只需观望`;
      const sent = await sendPushPlus(title, [
        dayLine,
        "──────────────────",
        ...(lines.length ? lines : ["今日无短线候选：题材没烧（≥3 只涨停的概念板为 0）或热题材都已启动。"]),
        ...(sskip.length ? [`⚪ ${sskip.length} 只竞价数据缺失没审成（不是没信号）`] : []),
        "──────────────────",
        "题材补涨＝昨日热题材里还没动的票，赌浪拍到头上。",
        "怎么走：行末「走 第N日」那天收盘卖；止损/目标先到先走 · 买入当天不卖 · 勿碰已涨停/连板（板越高次日越亏）。",
        "挂单价打到才买。回测口径：补涨 +0.06% 无优势，小仓试错，30 笔一批算期望。",
      ].join("\n"), "txt");
      console.log(sent ? "短线腿推送已发送" : "短线腿没推出去（看上一行的原因），审核结果已落盘不影响页面");
    }
  } catch (e) {
    console.log(`PushPlus 推送失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  for (const r of ok.slice(0, 5)) console.log(`  🟢 ${r.code} ${r.name} | ${r.strategy} | ${r.verdictReason}`);
  for (const r of warn.slice(0, 5)) console.log(`  🟡 ${r.code} ${r.name} | ${r.strategy} | ${r.verdictReason}`);
  for (const r of skip.slice(0, 5)) console.log(`  ⚪ ${r.code} ${r.name} | ${r.strategy} | ${r.verdictReason}`);

  // 落盘
  await mkdir(`${DATA}/signals`, { recursive: true });
  await writeFile(`${DATA}/signals/reviewed.json`, JSON.stringify({
    date: new Date().toISOString().slice(0, 10),
    candidates: candidates.signals.length,
    reviewed: reviewed.length,
    ok: ok.length,
    warn: warn.length,
    skip: skip.length,
    signals: reviewed,
  }, null, 2));
  // 竞价价落盘攒历史（2026-11-10）：以前 9:26 拉到的开盘价只用来判一次 verdict 就丢，
  // 攒不出「竞价强弱」的时间序列。现在每天存一份；拉不到的留痕写缺失，不补 0。
  // 非竞价窗口跑属预演，开盘价只是代用，必须在文件里说清，不许冒充当日真实竞价。
  await mkdir(`${DATA}/signals/auction`, { recursive: true });
  const auctionDay = new Date().toLocaleDateString("sv-SE");
  const auctionFile = `${DATA}/signals/auction/${auctionDay}.json`;
  await writeFile(
    auctionFile,
    JSON.stringify(
      {
        date: auctionDay,
        generatedAt: new Date().toISOString(),
        source: "腾讯快照开盘价（9:25 集合竞价出清价代用）",
        inWindow,
        note: inWindow
          ? "竞价窗口内抓取，开盘价=当日竞价出清价"
          : "非竞价窗口（预演/补跑）：开盘价代用，不是当日真实竞价数据",
        candidates: reviewed.length,
        priced: reviewed.filter((r) => r.auctionPrice != null).length,
        missing: reviewed.filter((r) => r.auctionPrice == null).length,
        rows: reviewed.map((r) => ({
          id: r.id,
          code: r.code,
          name: r.name,
          leg: legOf(r),
          strategy: r.strategy,
          buyPrice: r.buyPrice,
          auctionPrice: r.auctionPrice,
          auctionGap: r.auctionGap,
          verdict: r.verdict,
          status: r.auctionPrice == null ? "竞价价缺失（不是没有信号）" : "ok",
        })),
      },
      null,
      2,
    ),
  );
  console.log(`竞价价已存档 → ${auctionFile}`);
  console.log(`\n审核结果已保存到 ${DATA}/signals/reviewed.json`);
}

main().catch(e => { console.error(e); process.exit(1); });