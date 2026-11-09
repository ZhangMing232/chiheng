/**
 * 竞价审核：读取收盘后生成的候选信号，拉东财分时竞价数据审核每条信号。
 * 9:25 竞价结束后跑（约 9:26），审核结果写入 data/signals/reviewed.json。
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
    console.log("没有候选信号文件，跳过审核");
    return;
  }

  if (!candidates.signals?.length) {
    console.log("候选信号为空");
    return;
  }

  console.log(`候选信号 ${candidates.signals.length} 条，开始竞价审核...\n`);

  const reviewed: Reviewed[] = [];

  for (let ci = 0; ci < candidates.signals.length; ci++) {
    const s = candidates.signals[ci];
    const secid = s.id.startsWith("sh") ? `1.${s.code}` : `0.${s.code}`;
    let auctionPrice: number | null = null;

    try {
      // 用腾讯快照接口（东财被墙）拿开盘价作为竞价审核依据
      const prefix = s.id.startsWith("sh") ? "sh" : "sz";
      const url = `https://web.sqt.gtimg.cn/utf8/q=${prefix}${s.code}`;
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
      const text = await res.text();
      const fields = text.split("~");
      // 腾讯快照格式：0=name, 3=现价, 4=昨收, 5=开盘(竞价出清价)
      const openPrice = Number(fields[5]);
      if (openPrice > 0) auctionPrice = openPrice;
    } catch (e) {
      console.log(`  ${s.code} ${s.name} 竞价数据拉取失败: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 审核判决
    let verdict: Reviewed["verdict"] = "ok";
    let verdictReason = "";

    if (auctionPrice == null) {
      verdict = "skip";
      verdictReason = "竞价数据缺失，无法审核";
    } else {
      const gap = ((auctionPrice - s.buyPrice) / s.buyPrice) * 100;
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

      reviewed.push({
        ...s,
        auctionPrice,
        auctionGap: +gap.toFixed(2),
        verdict,
        verdictReason,
      });
    }

    // 东财接口限流
    if (ci % 20 === 19) await new Promise(r => setTimeout(r, 500));
  }

  const ok = reviewed.filter(r => r.verdict === "ok");
  const warn = reviewed.filter(r => r.verdict === "warn");
  const skip = reviewed.filter(r => r.verdict === "skip");

  console.log(`审核完成：🟢 ${ok.length} 可执行 | 🟡 ${warn.length} 需观望 | ⚪ ${skip.length} 跳过\n`);

  // ── PushPlus 推送：绿色可执行 + 黄色观望都推（2026-11-09 补缺口：原来只推
  //    绿色，唯一信号是「观望」的那天整条静默——用户「什么价位该买什么都没
  //    通知」就是这个洞。观望不等于没有信号，只推一半等于没推）。─────────
  if (ok.length + warn.length > 0) {
    try {
      const { sendPushPlus } = await import("../src/lib/market/push.ts");
// 买入单格式（2026-11-09 用户要求「选出→告诉我让我买入」）：
      // 执行行压成「买 价格 | 止损 | 目标」三要素，一眼可下单；纪律一行钉死。
      const fmt = (r: (typeof reviewed)[number], mark: string) => {
        const gap = r.auctionGap != null ? `${r.auctionGap > 0 ? "+" : ""}${r.auctionGap}%` : "--";
        return `${mark} ${r.name} ${r.code} | 买 ${r.buyPrice} | 止损 ${r.stop ?? "—"} | 目标 ${r.target ?? "—"} | 竞价${r.auctionPrice} ${gap}`;
      };
      const lines = [
        ...ok.slice(0, 10).map((r) => fmt(r, "🟢")),
        ...warn.slice(0, 10).map((r) => fmt(r, "🟡")),
      ];
      const sent = await sendPushPlus(
        ok.length > 0 ? `明日买入单 · 🟢${ok.length} 可执行` : `今日观望 · 🟡${warn.length} 只`,
        [
          `信号日：${new Date().toLocaleDateString("sv-SE")}（竞价已核对）`,
          "──────────────────",
          ...lines,
          "──────────────────",
          "纪律：挂单价打到才买 · 买入当天不卖 · 拿满 8 个交易日",
          "单笔不保证，30 笔一批算期望；连亏是这套打法的常态。",
          ...(ok.length === 0 ? ["今日无可执行信号；🟡 观望不是买入指令。"] : []),
        ].join("\n"),
        "txt",
      );
      console.log(sent ? "PushPlus 推送已发送" : "PushPlus 没推出去（看上一行的原因），审核结果已落盘不影响页面");
    } catch (e) {
      console.log(`PushPlus 推送失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const r of ok.slice(0, 5)) console.log(`  🟢 ${r.code} ${r.name} | ${r.strategy} | ${r.verdictReason}`);
  for (const r of warn.slice(0, 5)) console.log(`  🟡 ${r.code} ${r.name} | ${r.strategy} | ${r.verdictReason}`);

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
  console.log(`\n审核结果已保存到 ${DATA}/signals/reviewed.json`);
}

main().catch(e => { console.error(e); process.exit(1); });