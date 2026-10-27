/**
 * 这个文件是干什么的：
 * 每日复盘邮件（PRODUCT-PLAN §6 的留存钩子）。收盘封印后由记账进程每个交易日
 * 触发一次，内容三块：① 今日诊断摘要 ② 挑战者战况 ③ 明日验证（昨天提的因子
 * 今天什么下场）。**钩子是「没看完的实验」，不是行情**——所以没有盈亏榜，
 * 只有实验进度。
 *
 * 你需要知道的：
 * - 配置在 data/mail-config.json（不进 git）：{host, port, secure, auth:{user,pass},
 *   to:[...], from?}。QQ/163 都是 465 TLS 直连 + 授权码登录（授权码不是密码）。
 *   没配 = 静默跳过。邮件和推送一样是锦上添花，绝不能因为它把记账进程带崩。
 * - best-effort：发送失败只返回原因让调用方记日志，不抛。
 * - 拿不到的数据显式说「没跑/读不到」，不拿 0 顶替「不知道」（本项目第一条规矩）。
 * - 多用户说明：挑战者/因子队列/诊断都是全局文件（data/ 根下），样本数只算
 *   主人账本（OWNER_ID）——和 record-journal 里挑战者判决同口径。将来看要不要
 *   按用户拆，那时邮件也得按用户拆。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readAgentDiagnosis } from "./agent-loop.ts";
import {
  bucketReturns,
  CHALLENGER_RULE,
  readChallengers,
  readChampions,
  tradingDaysSince,
} from "./challenger.ts";
import { readQueue, type QueueStatus } from "./factor-queue.ts";
import { readAILog } from "./ai-log.ts";
import { sendMail, type SmtpConfig } from "./smtp.ts";

// ── 配置 ────────────────────────────────────────────────────────────

export type MailConfig = SmtpConfig & { to: string[]; from?: string };

/** 数据目录：和 challenger/ai-log/factor-queue 一个约定（测试靠它指到临时目录）。 */
function dataDir(): string {
  return process.env.CHIHENG_DATA_DIR ?? join(process.cwd(), "data");
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 读邮件配置；缺项/文件不在都返回 null（调用方静默跳过）。 */
export async function readMailConfig(): Promise<MailConfig | null> {
  try {
    const parsed = JSON.parse(await readFile(join(dataDir(), "mail-config.json"), "utf8")) as Record<string, unknown>;
    const host = str(parsed.host);
    const port = num(parsed.port);
    const auth = (parsed.auth ?? {}) as Record<string, unknown>;
    const user = str(auth.user);
    const pass = str(auth.pass);
    const to = Array.isArray(parsed.to)
      ? parsed.to.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      : [];
    if (!host || port == null || !user || !pass || to.length === 0) return null;
    return {
      host,
      port,
      secure: typeof parsed.secure === "boolean" ? parsed.secure : port === 465,
      auth: { user, pass },
      to,
      from: str(parsed.from) ?? undefined,
      timeoutMs: num(parsed.timeoutMs) ?? undefined,
    };
  } catch {
    return null;
  }
}

// ── 收集 ────────────────────────────────────────────────────────────

/** 收集需要的账本最小结构（Day 兼容）。 */
export type MailBookDay = {
  date?: string;
  signalTime?: string;
  trades: { entry?: number; exit?: number | null; style?: string; variant?: string }[];
};

export type ChallengerStanding = {
  id: string;
  name: string;
  style: string;
  since: string;
  /** 开跑以来过了几个交易日（账本里 since 及之后的不同日期数）。 */
  days: number;
  chalClosed: number;
  champClosed: number;
  /** 离判决还差几笔（双方都要到 30，按少的那边算）。 */
  need: number;
  /** 挑战者已平仓样本的等权均值；没有样本 = null（不拿 0 顶替）。 */
  chalMean: number | null;
  champMean: number | null;
  params: string;
};

export type FactorWatch = {
  id: string;
  name: string;
  /** 队列里的提议日（createdAt 就是 AI 提成名册那天，回测判决另看 lastRunAt）。 */
  proposedOn: string;
  status: QueueStatus;
  failCount: number;
  lastRunAt: string | null;
  /** 今天的判决回测跑过它没有（lastRunAt 落在今天）。 */
  verdictToday: boolean;
};

export type DailyMailReport = {
  date: string;
  todayRounds: { factor: number; strategy: number; agent: boolean; agentAt: string | null };
  /** 今天没有新报告时是 null；有旧报告时 isToday=false 并带上它的日期。 */
  diagnosis: {
    at: string;
    isToday: boolean;
    summary: string;
    factorLayer: string;
    strategyLayer: string;
    suggestions: string[];
  } | null;
  challengers: ChallengerStanding[];
  /** 今天之前提的、还活着的因子（死了的不追）。 */
  watchers: FactorWatch[];
  /** 拿不到的数据（≠ 没有）。 */
  missing: string[];
};

/** 队列状态的中文标签。死了的状态不该出现在 watchers 里，但表要全。 */
const STATUS_LABEL: Record<QueueStatus, string> = {
  pending: "待验（还没跑过回测）",
  tested: "在验·未过 6 关",
  passed: "已过 6 关",
  monitoring: "已过关·监控衰减中",
  decayed: "判定衰减·停跑",
  tombstone: "已淘汰",
};

const DEAD: QueueStatus[] = ["tombstone", "decayed"];

/** 汇总今天之前提过、还活着的因子，按提议日新的在前，最多 8 个。 */
const WATCH_CAP = 8;

/**
 * 收集日报数据。days 由调用方给（record-journal 手里就有；测试直接造）——
 * 账本读取不走 CHIHENG_DATA_DIR（book-file.ts 用 cwd/data），所以把它做成参数，
 * 收集逻辑才测得了。
 */
export async function collectDailyMail(input: {
  date: string;
  days: MailBookDay[];
}): Promise<DailyMailReport> {
  const { date, days } = input;
  const missing: string[] = [];

  // ② 挑战者战况：样本分桶口径和判决/UI 共用（challenger.bucketReturns），
  // 冠军桶要考虑「冠军是被转正的挑战者」这种情形（champions.json 映射）。
  const rets = bucketReturns(days);
  const champions = await readChampions();
  const chalList = (await readChallengers()).list;
  const challengers: ChallengerStanding[] = chalList
    .filter((c) => c.status === "running")
    .map((c) => {
      const champId = champions[c.style];
      const champKey = champId && champId !== "champion" ? `${c.style}:${champId}` : `${c.style}:champion`;
      const chal = rets.get(`${c.style}:${c.id}`) ?? [];
      const champ = rets.get(champKey) ?? [];
      const params = [
        c.holdDays != null ? `持${c.holdDays}天` : null,
        c.stopPct != null ? `止损${c.stopPct}%` : null,
        c.targetPct != null ? `目标${c.targetPct}%` : null,
      ].filter(Boolean);
      return {
        id: c.id,
        name: c.name,
        style: c.style,
        since: c.since,
        days: tradingDaysSince(days, c.since),
        chalClosed: chal.length,
        champClosed: champ.length,
        need: Math.max(0, CHALLENGER_RULE.minTrades - Math.min(chal.length, champ.length)),
        chalMean: chal.length > 0 ? chal.reduce((a, b) => a + b, 0) / chal.length : null,
        champMean: champ.length > 0 ? champ.reduce((a, b) => a + b, 0) / champ.length : null,
        params: params.length > 0 ? params.join(" / ") : "参数同冠军",
      };
    });

  // ① 今日诊断：优先今天的；没有就带旧报告的日期明说，不冒充今天。
  const diag = await readAgentDiagnosis();
  const diagnosis = diag
    ? {
        at: diag.at,
        isToday: diag.at.slice(0, 10) === date,
        summary: diag.summary,
        factorLayer: diag.factorLayer,
        strategyLayer: diag.strategyLayer,
        suggestions: diag.suggestions,
      }
    : null;

  // ③ 明日验证 + 今日闭环概览：都从 ai-log 来。
  const log = await readAILog();
  if (log.length === 0) missing.push("AI 闭环日志（ai-log.json）还没有记录");
  const todayLog = log.filter((e) => e.at.slice(0, 10) === date);
  const todayRounds = {
    factor: todayLog.filter((e) => e.layer === "factor").reduce((n, e) => n + e.proposed.length, 0),
    strategy: todayLog.filter((e) => e.layer === "strategy").reduce((n, e) => n + e.proposed.length, 0),
    agent: todayLog.some((e) => e.layer === "agent" && e.ok),
    agentAt: todayLog.find((e) => e.layer === "agent" && e.ok)?.at ?? null,
  };

  const queue = await readQueue();
  if (queue.missing) missing.push(queue.missing);
  const watchers: FactorWatch[] = queue.entries
    .filter((e) => !DEAD.includes(e.status) && e.createdAt.slice(0, 10) < date)
    .map((e) => ({
      id: e.id,
      name: e.name,
      proposedOn: e.createdAt.slice(0, 10),
      status: e.status,
      failCount: e.failCount,
      lastRunAt: e.lastRunAt,
      verdictToday: e.lastRunAt != null && e.lastRunAt.slice(0, 10) === date,
    }))
    .sort((a, b) => b.proposedOn.localeCompare(a.proposedOn))
    .slice(0, WATCH_CAP);

  return { date, todayRounds, diagnosis, challengers, watchers, missing };
}

// ── 渲染（纯函数：只吃 report，不碰任何 IO）─────────────────────────

function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 样本数显示：30 是判决下限不是上限，过了线说「已过线」，别显示成 65/30。 */
function sampleText(closed: number, mean: number | null): string {
  if (closed === 0) return `0/${CHALLENGER_RULE.minTrades}（还没有已平仓样本）`;
  if (closed >= CHALLENGER_RULE.minTrades) return `已过线（${closed} 笔，均值 ${pct(mean ?? 0)}）`;
  return `${closed}/${CHALLENGER_RULE.minTrades}（均值 ${pct(mean ?? 0)}）`;
}

/** 挑战者一行参数 + 进度。样本为 0 时说「还没有」，不显示 0.00%。 */
function challengerLine(c: ChallengerStanding): string {
  const verdict = c.need > 0 ? `还差 ${c.need} 笔判决` : "样本已够，等判决";
  return [
    `· ${c.name}（${c.style}｜${c.params}）`,
    `  账本里有 ${c.days} 个交易日 · 挑战者 ${sampleText(c.chalClosed, c.chalMean)} · 冠军 ${sampleText(c.champClosed, c.champMean)} · ${verdict}`,
  ].join("\n");
}

/** 因子一行：提于哪天、现在什么状态、判决跑过没有。 */
function watchLine(w: FactorWatch): string {
  const state = w.status === "tested" && w.failCount > 0 ? `${STATUS_LABEL[w.status]}（连续失败 ${w.failCount} 次）` : STATUS_LABEL[w.status];
  const verdict = w.verdictToday
    ? "今天的判决回测已跑过它"
    : w.lastRunAt
      ? `最近一次判决 ${w.lastRunAt.slice(0, 10)}`
      : "还没跑上回测（今晚判决回测会带上）";
  return `· ${w.name}（${w.proposedOn} 提）${state}｜${verdict}`;
}

export function renderDailyMail(report: DailyMailReport): { subject: string; text: string; html: string } {
  const { date } = report;
  const suffix: string[] = [];
  if (report.challengers.length > 0) suffix.push(`挑战者 ${report.challengers.length} 在跑`);
  if (report.watchers.length > 0) suffix.push(`待验 ${report.watchers.length}`);
  const subject = `赤轨日报 ${date}${suffix.length > 0 ? `｜${suffix.join(" · ")}` : ""}`;

  const lines: string[] = [subject, ""];

  // 开场：今天 AI 闭环做了几轮（不讲行情，讲实验）
  const t = report.todayRounds;
  const roundBits = [`因子层提议 ${t.factor} 个`, `策略层提名 ${t.strategy} 个`, t.agent ? "全局诊断 1 次" : "全局诊断没跑"];
  lines.push(`今天 AI 闭环：${roundBits.join(" · ")}`, "");

  // ① 今日诊断摘要
  lines.push("一、今日诊断");
  if (!report.diagnosis) {
    lines.push("  今天没有生成诊断报告。");
  } else if (!report.diagnosis.isToday) {
    lines.push(`  今天没有新报告，以下是最近一次（${report.diagnosis.at.slice(0, 10)}）：`);
    lines.push(`  ${report.diagnosis.summary}`);
    lines.push(`  因子层：${report.diagnosis.factorLayer}`);
    lines.push(`  策略层：${report.diagnosis.strategyLayer}`);
    for (const [i, s] of report.diagnosis.suggestions.entries()) lines.push(`  建议${i + 1}：${s}`);
  } else {
    const at = report.diagnosis.at.slice(11, 16);
    lines.push(`  （${at}）${report.diagnosis.summary}`);
    lines.push(`  因子层：${report.diagnosis.factorLayer}`);
    lines.push(`  策略层：${report.diagnosis.strategyLayer}`);
    for (const [i, s] of report.diagnosis.suggestions.entries()) lines.push(`  建议${i + 1}：${s}`);
  }
  lines.push("");

  // ② 挑战者战况
  lines.push(`二、挑战者战况（判决线：双方各 ${CHALLENGER_RULE.minTrades} 笔已平仓）`);
  if (report.challengers.length === 0) {
    lines.push("  现在没有在跑的挑战者。");
  } else {
    for (const c of report.challengers) lines.push(challengerLine(c));
  }
  lines.push("");

  // ③ 明日验证
  lines.push("三、明日验证（今天之前提的因子，现在什么下场）");
  if (report.watchers.length === 0) {
    lines.push("  队列里没有今天之前提的活因子。");
  } else {
    for (const w of report.watchers) lines.push(watchLine(w));
  }

  // 拿不到的数据单独说，不混在内容里冒充「没有」
  if (report.missing.length > 0) {
    lines.push("", "读不到的数据（不是没有）：");
    for (const m of report.missing) lines.push(`  · ${m}`);
  }

  lines.push("", "实验没跑完，明天这时见。");

  const text = lines.join("\n");
  return { subject, text, html: renderHtml(report, subject) };
}

/** HTML 版：邮件客户端会剥 <style>，全部内联样式。内容必须和 text 版同源（同一个 report 渲染两遍）。 */
function renderHtml(report: DailyMailReport, subject: string): string {
  const esc = escapeHtml;
  const { date } = report;
  const t = report.todayRounds;
  const roundBits = [`因子层提议 ${t.factor} 个`, `策略层提名 ${t.strategy} 个`, t.agent ? "全局诊断 1 次" : "全局诊断没跑"];

  const section = (title: string, body: string) =>
    `<div style="margin:18px 0 8px;font-size:15px;font-weight:600;color:#1a1a1a">${esc(title)}</div>${body}`;

  // ① 诊断
  let diagHtml: string;
  if (!report.diagnosis) {
    diagHtml = `<div style="color:#666">今天没有生成诊断报告。</div>`;
  } else {
    const d = report.diagnosis;
    const head = d.isToday ? `（${esc(d.at.slice(11, 16))}）` : `（最近一次 ${esc(d.at.slice(0, 10))}，今天没有新报告）`;
    diagHtml = [
      `<div style="margin-bottom:6px">${head}${esc(d.summary)}</div>`,
      `<div style="color:#444;margin-bottom:4px"><b>因子层：</b>${esc(d.factorLayer)}</div>`,
      `<div style="color:#444;margin-bottom:4px"><b>策略层：</b>${esc(d.strategyLayer)}</div>`,
      d.suggestions.length > 0
        ? `<div style="color:#444">${d.suggestions.map((s, i) => `<div>建议${i + 1}：${esc(s)}</div>`).join("")}</div>`
        : "",
    ].join("");
  }

  // ② 挑战者
  const chalHtml =
    report.challengers.length === 0
      ? `<div style="color:#666">现在没有在跑的挑战者。</div>`
      : report.challengers
          .map((c) => {
            const verdict = c.need > 0 ? `<b>还差 ${c.need} 笔</b>判决` : "样本已够，等判决";
            return `<div style="padding:8px 0;border-bottom:1px solid #eee">
              <div><b>${esc(c.name)}</b><span style="color:#888;font-size:12px">\u3000${esc(c.style)}｜${esc(c.params)}</span></div>
              <div style="color:#444;font-size:13px">账本里有 ${c.days} 个交易日 · 挑战者 ${esc(sampleText(c.chalClosed, c.chalMean))} · 冠军 ${esc(sampleText(c.champClosed, c.champMean))} · ${verdict}</div>
            </div>`;
          })
          .join("");

  // ③ 待验因子
  const watchHtml =
    report.watchers.length === 0
      ? `<div style="color:#666">队列里没有今天之前提的活因子。</div>`
      : report.watchers
          .map((w) => {
            const state = w.status === "tested" && w.failCount > 0 ? `${STATUS_LABEL[w.status]}（连续失败 ${w.failCount} 次）` : STATUS_LABEL[w.status];
            const verdict = w.verdictToday ? "今天的判决回测已跑过它" : w.lastRunAt ? `最近一次判决 ${w.lastRunAt.slice(0, 10)}` : "还没跑上回测（今晚判决回测会带上）";
            return `<div style="padding:6px 0;border-bottom:1px solid #eee;font-size:13px"><b>${esc(w.name)}</b>（${esc(w.proposedOn)} 提）${esc(state)}｜${esc(verdict)}</div>`;
          })
          .join("");

  const missingHtml =
    report.missing.length > 0
      ? `<div style="margin-top:18px;padding:8px 10px;background:#fff7e6;border:1px solid #ffe58f;font-size:12px;color:#8c6d1f">读不到的数据（不是没有）：${report.missing.map(esc).join("；")}</div>`
      : "";

  const html = [
    `<div style="max-width:640px;margin:0 auto;font-family:-apple-system,'PingFang SC','Helvetica Neue',Arial,sans-serif;color:#1a1a1a;font-size:14px;line-height:1.7">`,
    `<div style="font-size:18px;font-weight:600">${esc(subject)}</div>`,
    `<div style="color:#888;font-size:12px;margin:4px 0 12px">${esc(date)} · 今天 AI 闭环：${roundBits.map(esc).join(" · ")}</div>`,
    `<div style="border-top:2px solid #1a1a1a"></div>`,
    section(`一、今日诊断`, diagHtml),
    section(`二、挑战者战况（判决线：双方各 ${CHALLENGER_RULE.minTrades} 笔已平仓）`, chalHtml),
    section(`三、明日验证（今天之前提的因子，现在什么下场）`, watchHtml),
    missingHtml,
    `<div style="margin-top:20px;color:#888;font-size:12px">实验没跑完，明天这时见。</div>`,
    `</div>`,
  ].join("");
  return html;
}

// ── 发送（best-effort，永不抛）─────────────────────────────────────

export type SendResult = { sent: boolean; reason?: string };

/** 收集 + 渲染 + 发送。没配邮件返回 {sent:false, reason:"没配 mail-config.json"}；发送失败带原因。 */
export async function sendDailyMail(input: { date: string; days: MailBookDay[] }): Promise<SendResult> {
  const cfg = await readMailConfig();
  if (!cfg) return { sent: false, reason: "没配 mail-config.json" };
  try {
    const report = await collectDailyMail(input);
    const { subject, text, html } = renderDailyMail(report);
    const from = cfg.from ?? cfg.auth.user;
    await sendMail(cfg, { from, to: cfg.to, subject, text, html });
    return { sent: true };
  } catch (error) {
    return { sent: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
