/**
 * 这个文件是干什么的：
 * 开市自检。一条命令回答「今天能不能记账、还差什么」，开盘后加 `--watch` 持续盯。
 *
 * 你需要知道的：
 * 1. **纯只读、纯本地**：不联网、不写任何文件、不要求服务在跑——「服务没起来」
 *    正是它要诊断的头号情况，所以它不能靠问服务来回答。
 * 2. **服务探测走 `node:http` 直连，不用 curl**：本机有 `HTTP_PROXY`，curl 会把
 *    本地请求也发给代理，返回一个假的 502，看着像服务挂了其实只是没进程。
 *    这个坑 2026-10-07 踩过，别再踩。
 * 3. **不要在 preflight 里 import `quotes.functions.ts`**：它顶层就 `createServerFn`，
 *    需要 TanStack 运行时，裸 node 下会炸。行情健康度读落盘的
 *    `data/universe-cache.json` 就行。
 * 4. **cwd 陷阱**：`book-file.ts` / `rules-file.ts` 里所有 data 路径都是
 *    `join(process.cwd(), "data", ...)`。在别的目录跑会读到一套不存在的 data，
 *    然后**静默地**认为「没有账本」——这是最阴的失败模式，所以开头先 chdir。
 * 5. 硬闸只停**开仓**，持仓的止损止盈照常（record-journal.ts 就是这个行为）。
 *    自检说「硬闸拦下」时要连这句一起说，否则会被误读成「今天全停了」。
 */

import { readFile, stat } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { get } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 先定位项目根并切过去：读账本/规则的模块都按 process.cwd() 拼 data 路径。
const ROOT = fileURLToPath(new URL("..", import.meta.url));
process.chdir(ROOT);

import { isTradingDay, sessionPhase, shanghaiDate, formatClock } from "../src/lib/market/session.ts";
import { noticeOf, sourceLabel } from "../src/lib/market/data-status.ts";
import { readRules } from "../src/lib/market/rules-file.ts";
import { hardGate } from "../src/lib/market/journal-book.ts";
import { OWNER_ID, bookPath } from "../src/lib/market/book-file.ts";
import { snapshotAge } from "../src/lib/market/format.ts";

type Level = "ok" | "warn" | "block" | "note";
type Check = { name: string; level: Level; value: string; fix?: string };

const MARK: Record<Level, string> = { ok: "✓", warn: "!", block: "✗", note: "·" };
const LABEL: Record<Level, string> = { ok: "就绪", warn: "警告", block: "阻塞", note: "提示" };

/** 只在终端里上色；重定向到日志或 --no-color 时自动关掉。 */
const color = process.stdout.isTTY && !process.argv.includes("--no-color");
function paint(level: Level, text: string): string {
  if (!color) return text;
  const code = level === "block" ? 31 : level === "warn" ? 33 : level === "ok" ? 32 : 90;
  return `\x1b[${code}m${text}\x1b[0m`;
}

/**
 * 探「网页进程在不在」，用一个**静态文件**而不是首页。
 *
 * 为什么不用 `/`：首页要走 Nitro SSR、要现拉全市场行情渲染，实测耗时在 80ms 到
 * 3.15 秒之间飘（冷启动最慢）。而记账进程每 60 秒要拉 60 笔 K 线，跟它抢同一个
 * 行情源，耗时更飘。拿一个飘的耗时去判断「服务死没死」= 误报，2026-10-07 晚上
 * 因为这个误报过一次（curl 明明 200，preflight 却说连不上）。
 * 静态文件是纯磁盘返回，实测 8ms，任何状态码（哪怕 404）都说明进程活着。
 */
function probeWeb(port = 8787): Promise<{ up: boolean; ms: number; reason: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const done = (up: boolean, reason: string) => resolve({ up, ms: Date.now() - started, reason });
    const req = get({ host: "127.0.0.1", port, path: "/favicon.svg", timeout: 5_000 }, (res) => {
      res.resume();
      // 404 也算活着——有 HTTP 响应就说明进程在监听并应答了。
      done(true, "");
    });
    req.on("error", (e: Error) => done(false, e.message));
    req.on("timeout", () => {
      req.destroy();
      done(false, "5 秒没响应");
    });
  });
}

/**
 * 数据源连通性探测（canary）。
 *
 * 学 Vibe-Trading 的 `backtest/loader_health.py`：拿一个固定标的问一句，确认源还活着。
 * **为什么需要它**：赤轨被腾讯 WAF 挡过 501（全市场批量拉久了会触发），
 * 当时缓存是旧的、页面照常显示、没有任何预警——等到结算卡住才发现，已经晚了。
 *
 * 三条纪律照抄那边：
 * 1. **连通性失败就是失败，不能跳过当通过**（"connectivity is never a passing skip"）。
 * 2. **canary 用固定大盘股**，不随机——每股每天问一句就够了，别自己制造请求量。
 * 3. **区分"源拒绝"和"没应答"**，给的修复建议不一样。
 */
const CANARY_ID = "sh601398"; // 工商银行：A 股大盘股，停牌概率极低，数据最稳

async function probeSource(): Promise<{ ok: boolean; ms: number; reason: string }> {
  const started = Date.now();
  try {
    const res = await fetch(`https://web.sqt.gtimg.cn/utf8/q=${CANARY_ID}`, {
      headers: { referer: "https://gu.qq.com/" },
      signal: AbortSignal.timeout(5_000),
    });
    const ms = Date.now() - started;
    const body = await res.text();
    if (!res.ok) return { ok: false, ms, reason: `HTTP ${res.status}` };
    // 返回体应该是「v_sh601398="1~工商银行~601398~…"」这样的一串，
    // 拿不到或太短说明被挡了 —— 只判状态码不够，WAF 会回 200 带一个空壳。
    if (!body.includes("601398") || body.length < 20) {
      return { ok: false, ms, reason: "返回内容为空（可能被 WAF 挡了）" };
    }
    return { ok: true, ms, reason: "" };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, reason: (err as Error).message };
  }
}

/** src 目录里最新一个文件的 mtime。用来和 .output 比。 */
function newestUnder(dir: string): number {
  let newest = 0;
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else newest = Math.max(newest, statSync(p).mtimeMs);
    }
  };
  if (existsSync(dir)) walk(dir);
  return newest;
}

async function launchdInstalled(): Promise<{ installed: boolean | null; detail: string }> {
  const plist = join(process.env.HOME ?? "", "Library/LaunchAgents/com.chiheng.serve.plist");
  if (!existsSync(plist)) return { installed: false, detail: "没装" };
  // plist 在只说明脚本跑到过；launchd 认没认这个 job 要问它本人。
  // 非 GUI 会话下 launchctl print 会失败——那种情况给「未知」，不能误报没装。
  return new Promise((resolve) => {
    execFile("launchctl", ["print", `gui/${process.getuid()}/com.chiheng.serve`], (err) => {
      if (err) resolve({ installed: null, detail: "未知（请在自己的终端里跑一次确认）" });
      else resolve({ installed: true, detail: "已装且 launchd 认了这个 job" });
    });
  });
}

async function checkAll(): Promise<{ checks: Check[]; trading: boolean; level: Level }> {
  const checks: Check[] = [];
  const now = Date.now();
  const date = shanghaiDate(now);
  const phase = sessionPhase(now);
  const trading = isTradingDay(date);

  // 2 交易日
  checks.push({
    name: "交易日",
    level: trading ? "ok" : "note",
    value: trading ? `是（${date}）` : `不是（${date}，${phase.label}）`,
    fix: trading ? undefined : "今天休市，记账只会跑结算段，不会建仓——这不算故障。",
  });

  // 3 时段 + 建仓窗口
  // 注意：9:25–9:30 页面写「早盘买入时段」，但 matching 要 9:30 才为 true，
  // 那五分钟实际一笔都不会记。不说清楚会让人以为记账坏了。
  const buying = trading && phase.matching && !phase.sealed;
  checks.push({
    name: "时段",
    level: trading ? (buying ? "ok" : "note") : "note",
    value: buying
      ? `${phase.label} · 建仓窗口：是`
      : `${phase.label} · 建仓窗口：否${trading ? (phase.sealed ? "（已收盘）" : "（9:30 才开始，9:25–9:30 那五分钟不建仓）") : ""}`,
  });

  // 1 网页进程（注意：这一项只管「页面能不能开」，不管记账会不会发生——那是心跳的事）
  const probe = await probeWeb();
  checks.push({
    name: "网页进程",
    level: probe.up ? "ok" : "warn",
    value: probe.up ? `在跑（${probe.ms}ms）` : `连不上：${probe.reason}`,
    fix: probe.up ? undefined : "页面打不开，但记账不依赖页面——看下面「记账心跳」那一行判断要不要处理",
  });

  // 8.5 数据源连通（canary）—— 和「行情源」那一行互补：
  // 行情源看的是**缓存里现在有什么**，这一行看的是**源还能不能答**。
  // 缓存有货但源已挂（WAF、欠费、改版）是最难自查的一种：页面照常显示，结算却在卡。
  const src = await probeSource();
  checks.push({
    name: "数据源连通",
    level: src.ok ? "ok" : "warn",
    value: src.ok ? `腾讯源应答正常（${src.ms}ms）` : `探不到：${src.reason}`,
    fix: src.ok
      ? undefined
      : "记账要拉 K 线，源挂了会结算卡住。等一会儿重跑本命令；持续不通就别硬拉（每次重拉都可能加深 WAF 限制）",
  });

  // 8 记账心跳（阈值和页面 RecordLine 对齐：3 分钟）
  let heartbeat: Check;
  try {
    const rec = JSON.parse(await readFile(join("data", "recorder.json"), "utf8")) as { at?: number; ok?: boolean };
    const ageMin = rec.at ? (now - rec.at) / 60000 : Infinity;
    if (rec.ok === false) {
      heartbeat = { name: "记账心跳", level: "block", value: "上次记账失败了", fix: "tail -40 data/serve.log 看报错" };
    } else if (!Number.isFinite(ageMin)) {
      heartbeat = { name: "记账心跳", level: "warn", value: "没有心跳记录", fix: "服务起来跑过一次记账后会自动写" };
    } else if (ageMin > 10) {
      heartbeat = {
        name: "记账心跳",
        level: "block",
        // snapshotAge 自带「前」字，别再加一个（会变成「3 小时前前」）
        value: `${snapshotAge(now - (rec.at ?? now))}（${formatClock(rec.at ?? now)}）`,
        fix: "这是记账会不会发生的唯一证据（心跳不依赖网页）。起服务：双击桌面「赤轨.app」或 npm run mac:start；或记账脚本卡住了（典型是 K 线撞腾讯 WAF）",
      };
    } else if (ageMin > 3) {
      heartbeat = { name: "记账心跳", level: "warn", value: `${Math.round(ageMin)} 分钟前` };
    } else {
      heartbeat = { name: "记账心跳", level: "ok", value: `${Math.round(ageMin)} 分钟前（记账在跑）` };
    }
  } catch {
    heartbeat = { name: "记账心跳", level: "warn", value: "读不到 data/recorder.json" };
  }
  checks.push(heartbeat);

  // 4 行情源
  try {
    const cache = JSON.parse(await readFile(join("data", "universe-cache.json"), "utf8")) as {
      at?: number;
      payload?: { source?: string; asOf?: number; quotes?: unknown[]; stale?: boolean; partial?: boolean; total?: number };
    };
    const uni = cache.payload;
    if (!uni || !uni.quotes || uni.quotes.length === 0) {
      checks.push({ name: "行情源", level: "block", value: "缓存里没有行情", fix: "服务起来后会自动拉" });
    } else {
      const notice = noticeOf(uni as never, now);
      checks.push({
        name: "行情源",
        level: notice ? (trading ? "block" : "warn") : "ok",
        value: notice
          ? `${sourceLabel(uni.source)} · ${notice.label}：${notice.impact}`
          : `${sourceLabel(uni.source)} · ${snapshotAge(now - (uni.asOf ?? cache.at ?? now))} · ${uni.quotes.length} 只`,
        fix: notice?.recovery,
      });
    }
  } catch {
    checks.push({ name: "行情源", level: "warn", value: "读不到 data/universe-cache.json", fix: "服务起来后第一次记账会生成" });
  }

  // 5 硬闸 + 9 未结笔数（一起读账本）
  try {
    const book = JSON.parse(await readFile(bookPath(OWNER_ID), "utf8")) as {
      days?: { date: string; trades?: { entry: number; exit: number | null; exitDate?: string | null }[] }[];
      nextSettleAt?: number | null;
    };
    const days = book.days ?? [];
    const allTrades = days.flatMap((d) => d.trades ?? []);
    const closed = days.flatMap((d) =>
      (d.trades ?? [])
        .filter((t) => t.exit != null)
        .map((t) => ({ date: t.exitDate ?? d.date, ret: ((t.exit as number) - t.entry) / t.entry })),
    );
    const open = allTrades.filter((t) => t.exit == null).length;
    const rules = await readRules();
    const hard = hardGate(closed, rules);
    checks.push({
      name: "硬闸",
      level: hard.ok ? "ok" : "warn",
      value: hard.ok ? `放行（已结 ${closed.length} 笔，无连亏）` : `拦下：${hard.reason}`,
      fix: hard.ok ? undefined : "硬闸只停开仓，持仓的止损止盈照常执行。",
    });
    const overdue = book.nextSettleAt == null || now >= (book.nextSettleAt as number);
    checks.push({
      name: "账本",
      level: open > 0 && overdue ? "warn" : "ok",
      value:
        `${OWNER_ID}：${days.length} 天 ${allTrades.length} 笔，未结 ${open}` +
        (overdue && open > 0 ? `，nextSettleAt 已过期 → 服务一起来就补跑结算（${open} 次 K 线请求，留意 WAF）` : ""),
    });
  } catch {
    checks.push({ name: "账本", level: "warn", value: `读不到账本（${OWNER_ID}）`, fix: "服务起来第一次记账会新建" });
  }

  // 6 构建新鲜度（只影响网页，记账直接读 src）
  try {
    const outM = (await stat(join(".output", "server", "index.mjs"))).mtimeMs;
    const srcM = newestUnder("src");
    const stale = srcM > outM;
    checks.push({
      name: "构建",
      level: stale ? "warn" : "ok",
      value: stale ? ".output 比 src 旧，页面跑的是旧逻辑" : ".output 比 src 新",
      fix: stale ? "npm run build:mac（记账不受影响，它直接读 src）" : undefined,
    });
  } catch {
    checks.push({ name: "构建", level: "block", value: "缺 .output/server/index.mjs", fix: "npm run build:mac，否则服务起不来" });
  }

  // 7 依赖文件
  const missing = [".output/server/index.mjs", "data/universe-cache.json", "data/prefs.json"].filter((f) => !existsSync(f));
  const noRules = !existsSync(join("data", "rules.json"));
  checks.push({
    name: "依赖",
    level: missing.length > 0 ? "block" : noRules ? "note" : "ok",
    value:
      missing.length > 0
        ? `缺 ${missing.join("、")}`
        : noRules
          ? "齐，只缺 data/rules.json（走默认规则，硬闸放行——属于已知状态）"
          : "齐",
  });

  // 10 自启
  const ld = await launchdInstalled();
  checks.push({
    name: "自启",
    level: ld.installed === true ? "ok" : ld.installed === false ? "warn" : "note",
    value: ld.detail,
    fix: ld.installed === false ? "自己的终端里跑 npm run install:mac（launchctl 要 GUI 会话权限）" : undefined,
  });

  const level: Level = checks.some((c) => c.level === "block")
    ? "block"
    : checks.some((c) => c.level === "warn")
      ? "warn"
      : "ok";
  return { checks, trading, level };
}

function render(checks: Check[], trading: boolean, level: Level, brief = false): string {
  if (brief) {
    const pick = (n: string) => checks.find((c) => c.name === n);
    return (
      `${formatClock(Date.now())} ` +
      checks
        .filter((c) => ["服务", "记账心跳", "行情源", "时段"].includes(c.name))
        .map((c) => `${c.name}=${c.value.split(" · ")[0].slice(0, 18)}`)
        .join("  ")
    );
  }
  const lines: string[] = [];
  const w = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    lines.push(
      `  ${c.name.padEnd(w)}  ${c.value.padEnd(52)}  ${paint(c.level, MARK[c.level] + " " + LABEL[c.level])}`,
    );
    if (c.fix) lines.push(`  ${" ".repeat(w)}    → ${c.fix}`);
  }
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const watch = args.includes("--watch");
  const jsonMode = args.includes("--json");
  const interval = Number(args[args.indexOf("--interval") + 1] ?? 60) * 1000;

  const run = async () => {
    const { checks, trading, level } = await checkAll();
    if (jsonMode) {
      console.log(JSON.stringify({ at: new Date().toISOString(), trading, level, checks }, null, 2));
      return level === "block" ? 1 : trading ? 0 : 2;
    }
    if (watch) {
      console.log(render(checks, trading, level, true));
      return level === "block" ? 1 : trading ? 0 : 2;
    }
    const now = Date.now();
    console.log(`\n赤轨开市自检   ${shanghaiDate(now)} ${formatClock(now)}（上海时间）\n`);
    console.log(render(checks, trading, level));
    const blockers = checks.filter((c) => c.level === "block");
    // 阻塞优先判。休市日服务挂了仍然是真故障——不建仓是对的，但结算也不跑了，
    // 不能被「今天休市，不是故障」盖过去（这个顺序写反过一次）。
    if (blockers.length > 0) {
      console.log(`\n结论：现在还不能记账 —— 还差 ${blockers.length} 件事`);
      blockers.forEach((c, i) => console.log(`  ${i + 1}. ${c.name}：${c.value}${c.fix ? ` → ${c.fix}` : ""}`));
      if (!trading) console.log("  （今天休市本来就不建仓，但上面这些要先修好——不然连结算也不会跑）");
    } else if (!trading) {
      console.log(`\n结论：今天休市，不建仓（结算照跑）。闸门和心跳都正常，不是故障。`);
    } else {
      console.log(`\n结论：可以记账。${level === "warn" ? "有警告，留意上面标「!」的项。" : ""}`);
    }
    console.log("");
    return level === "block" ? 1 : trading ? 0 : 2;
  };

  if (watch) {
    let last = "";
    for (;;) {
      const { checks, trading, level } = await checkAll();
      const line = render(checks, trading, level, true);
      // 只在状态变化时打完整块，其余打一行——盯一天不该被刷屏。
      if (line !== last) {
        console.log(line);
        last = line;
      } else {
        console.log(`${formatClock(Date.now())} ${paint(level, MARK[level])} 无变化`);
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  }
  process.exit(await run());
}

await main();
