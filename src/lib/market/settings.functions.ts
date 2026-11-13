/**
 * 这个文件是干什么的：
 * 设置页（/settings）的服务端接口：系统状态 + 配置现状 + 数据新鲜度。
 *
 * 你需要知道的：
 * - 这个接口只管**只读状态**：系统现在什么状态、配置现在是什么值、哪些数据旧了怎么补。
 *   摆一堆跳转链接看着整齐，实际是什么都答不上来。
 * - 例外（2026-11-07）：/settings 页顶部新增「每日复盘日报」配置卡片，走
 *   mail.functions.ts 由服务端写盘，不经过这个接口。日报走微信推送/邮件双通道。
 *   其余配置值仍是只读展示，每项标清「在哪儿改」。
 * - 数据新鲜度的事实收集在这里（stat 文件），判据在 data-files.ts（有单测）。
 */

import { createServerFn } from "@tanstack/react-start";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { DATA_FILES, allFreshness, missingRequired, type Facts, type Freshness } from "./data-files.ts";
import { readRules } from "./rules-file.ts";
import { readPrefs } from "./prefs-file.ts";

/** 配置现状。只读展示，每项都带「在哪儿改」。 */
export type ConfigRow = { label: string; value: string; where: string };

async function factsOf(root: string): Promise<Facts> {
  const out: Facts = {};
  for (const file of DATA_FILES) {
    try {
      const st = await stat(join(root, file.path));
      if (st.isDirectory()) {
        // 目录（通达信盘后包那种按日期一份份落的）要看**里面最新那份**的时间，
        // 目录自身的 mtime 是最后一次增删的时间，拿它判新鲜度会把「删过文件」
        // 也算成更新过。
        const names = await readdir(join(root, file.path));
        let latest: { size: number; mtime: number } | null = null;
        let count = 0;
        for (const name of names) {
          if (!name.endsWith(".json")) continue;
          count += 1;
          const one = await stat(join(root, file.path, name));
          if (!latest || one.mtimeMs > latest.mtime) latest = { size: one.size, mtime: one.mtimeMs };
        }
        out[file.path] = latest ? { size: count * 1024, mtime: latest.mtime } : null;
      } else {
        out[file.path] = { size: st.size, mtime: st.mtimeMs };
      }
    } catch {
      out[file.path] = null;
    }
  }
  return out;
}

async function configRows(): Promise<ConfigRow[]> {
  const rows: ConfigRow[] = [];
  // 选股规则
  try {
    const rules = await readRules();
    rows.push({
      label: "选股规则版本",
      value: `v${rules.version} · 当日涨幅 ${rules.chgMin}~${rules.chgMax}% · 20 日涨幅 ${rules.d20Min}~${rules.d20Max}%`,
      where: "策略选股页",
    });
  } catch {
    rows.push({ label: "选股规则", value: "读不到（多半是文件没生成）", where: "策略选股页" });
  }
  // 偏好
  try {
    const { requireUserId } = await import("@/lib/auth/verify.server");
    const prefs = await readPrefs(await requireUserId());
    const keys = Object.entries(prefs)
      .slice(0, 6)
      .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("/") : String(v)}`)
      .join(" · ");
    rows.push({ label: "自选偏好", value: keys || "没设过", where: "自选与持仓页" });
  } catch {
    rows.push({ label: "自选偏好", value: "读不到", where: "自选与持仓页" });
  }
  return rows;
}

/** 系统体检的一行：管理者视角「哪里不正常」。 */
export type HealthRow = {
  label: string;
  /** ok / warn / bad —— 只看这三种，不要更多档，否则人分不清轻重 */
  state: "ok" | "warn" | "bad";
  /** 一句话现状（带数字） */
  detail: string;
  /** 怎么修（只在非 ok 时给） */
  fix: string | null;
};

export type SettingsPayload = {
  recorder: { at: number | null; ok: boolean };
  universe: { source: string | null; count: number; ageMin: number | null };
  files: Freshness[];
  missing: Freshness[];
  config: ConfigRow[];
  gaps: string[];
  /** 系统体检（2026-11-14 新增）：把散在 ops-check / serve.log / ai-log /
   *  rule-change-effects 里的「哪里不正常」收敛到一屏。 */
  health: HealthRow[];
};


/**
 * 系统体检（2026-11-14）：把「哪里不正常」从 5 个地方收敛到一屏。
 *
 * 为什么需要它（用户 2026-11-13 的要求：不展示的东西，管理者怎么发现问题）：
 * 之前要发现问题得同时看 `scripts/ops-check.mjs`、`data/serve.log`、
 * `data/ai-log.json`、`data/rule-change-effects.jsonl`、`data/strategy-gates.json`
 * ——五个地方，还得知道每处该看什么字段。管理者视角缺一个入口。
 *
 * 判据纪律（同全站）：**只报事实 + 数字，不报「可能」「建议关注」这种模糊词**；
 * 读不到就写「读不到」并给修复命令，不拿 0 顶替；只分 ok/warn/bad 三档，
 * 档位多了人反而分不清轻重。
 */
async function healthRows(root: string): Promise<HealthRow[]> {
  const { readFile } = await import("node:fs/promises");
  const readJson = async <T,>(rel: string): Promise<T | null> => {
    try {
      return JSON.parse(await readFile(join(root, rel), "utf8")) as T;
    } catch {
      return null;
    }
  };
  const rows: HealthRow[] = [];

  // ① 记账心跳：整个系统的心脏。超过 5 分钟没跳 = 记账停了。
  const rec = await readJson<{ at?: number; ok?: boolean }>("data/recorder.json");
  if (!rec || typeof rec.at !== "number") {
    rows.push({ label: "记账心跳", state: "bad", detail: "读不到 recorder.json", fix: "确认服务在跑：npm run mac:status" });
  } else {
    const ageMin = Math.round((Date.now() - rec.at) / 60_000);
    rows.push({
      label: "记账心跳",
      state: !rec.ok ? "bad" : ageMin > 5 ? "bad" : "ok",
      detail: `${ageMin} 分钟前${rec.ok ? "" : "（进程报 ok=false）"}`,
      fix: !rec.ok || ageMin > 5 ? "服务可能停了：npm run mac:restart" : null,
    });
  }

  // ② 进化熔断：断电了就等于自我进化停了，必须显眼。
  const brk = await readJson<{ trippedAt?: string | null; trippedReason?: string }>("data/evolve-breaker.json");
  if (brk?.trippedAt) {
    rows.push({
      label: "自动进化",
      state: "bad",
      detail: `已熔断（${brk.trippedAt.slice(0, 10)}）：${brk.trippedReason || "连续失败"}`,
      fix: "去 /ai 页重新打开「自动进化」开关",
    });
  } else {
    const prefs = await readJson<{ autoEvolve?: boolean }>("data/ai-prefs.json");
    rows.push({
      label: "自动进化",
      state: prefs?.autoEvolve === false ? "warn" : "ok",
      detail: prefs?.autoEvolve === false ? "开关是关的（手动模式）" : "开着，未熔断",
      fix: prefs?.autoEvolve === false ? "要自动跑就去 /ai 打开开关" : null,
    });
  }

  // ③ 策略闸：停用的策略 = 不建仓，管理者必须知道现在到底几套在跑。
  const gates = await readJson<Record<string, { state?: string; since?: string; reason?: string }>>("data/strategy-gates.json");
  const disabled = Object.entries(gates ?? {}).filter(([, g]) => g?.state === "disabled");
  rows.push({
    label: "策略闸",
    state: disabled.length > 0 ? "warn" : "ok",
    detail:
      disabled.length > 0
        ? `${disabled.length} 套停用：${disabled.map(([k, g]) => `${k}（${g.since ?? "?"} ${truncate(g.reason ?? "", 20)}）`).join("、")}`
        : "全部就绪",
    fix: null,
  });

  // ④ 规则改动回验（本轮新增）：无效改动 = 白砍了一刀，要建议回滚。
  const effects = await (async () => {
    try {
      const raw = await readFile(join(root, "data", "rule-change-effects.jsonl"), "utf8");
      return raw.split("\n").filter(Boolean).map((l) => {
        try {
          return JSON.parse(l) as { key: string; verdict: string; reason: string; revertAdvice: string | null };
        } catch {
          return null;
        }
      }).filter(Boolean) as { key: string; verdict: string; reason: string; revertAdvice: string | null }[];
    } catch {
      return [];
    }
  })();
  const ineffective = effects.filter((e) => e.verdict === "ineffective");
  const pendingFx = effects.filter((e) => e.verdict === "pending");
  rows.push({
    label: "规则回验",
    state: ineffective.length > 0 ? "warn" : "ok",
    detail:
      effects.length === 0
        ? "还没有回验记录（要等规则改动后 10 个交易日）"
        : `已回验 ${effects.length} 条 · 判无效 ${ineffective.length} · 观察中 ${pendingFx.length}` +
          (ineffective.length > 0 ? `（${ineffective[0].key}：${truncate(ineffective[0].reason, 30)}）` : ""),
    fix: ineffective.length > 0 ? ineffective[0].revertAdvice : null,
  });

  // ⑤ AI 闭环：昨天有没有真的跑过。连续失败说明 API/key 有问题。
  const aiLog = await readJson<{ entries?: { at?: string; trigger?: string; ok?: boolean }[] }>("data/ai-log.json");
  const entries = aiLog?.entries ?? [];
  const today = new Date().toISOString().slice(0, 10);
  const todayAuto = entries.filter((e) => (e.at ?? "").slice(0, 10) === today && e.trigger === "auto");
  const fails = todayAuto.filter((e) => e.ok === false).length;
  rows.push({
    label: "AI 闭环",
    state: fails >= 2 ? "bad" : todayAuto.length === 0 ? "warn" : "ok",
    detail:
      todayAuto.length === 0
        ? "今天还没跑（收盘封印后自动触发，或开关关着）"
        : `今天 ${todayAuto.length} 轮，失败 ${fails} 轮`,
    fix: fails >= 2 ? "看 /ai 页的失败原因；连续失败会触发熔断" : null,
  });


  // ⑥ 实盘 vs 回测背离（2026-11-14 新增）：两个真相并存时必须显式摆出来。
  // 回测说无 alpha、实盘说 +0.18%，26 笔不够下结论——但背离本身要盯着。
  try {
    const { compareLiveVsBacktest, sideStats } = await import("./live-vs-backtest.ts");
    const book = await readJson<{ days?: { trades?: { style?: string; entry: number; exit: number | null }[] }[] }>(
      "data/books/dev-user.json",
    );
    const valueTrades = (book?.days ?? [])
      .flatMap((d) => d.trades ?? [])
      .filter((t) => t?.style === "value" && typeof t.exit === "number");
    const liveRet = valueTrades.map((t) => ((t.exit as number) - t.entry) / t.entry);

    // 回测侧取 strategy-verdicts 里最接近现役的一套（value 默认不进判决，
    // 用 spring 作参照；真值在 BT_VALUE=1 的专项回测里，见 AUDIT 文档）。
    const verdicts = await readJson<{ at?: string; strategies?: Record<string, { excess?: number; n?: number; clusterT?: number }> }>(
      "data/strategy-verdicts.json",
    );
    const anyKey = verdicts?.strategies ? Object.keys(verdicts.strategies)[0] : null;
    const anyV = anyKey ? verdicts!.strategies![anyKey] : null;
    const cmp = compareLiveVsBacktest({
      backtest: sideStats({
        source: `回测·${anyKey ?? "?"}`,
        returns: anyV?.excess != null && anyV.n ? Array(Math.min(anyV.n, 2000)).fill(anyV.excess) : [],
        tStat: anyV?.clusterT ?? null,
      }),
      live: sideStats({ source: "实盘·value", returns: liveRet }),
    });
    rows.push({
      label: "实盘vs回测",
      state: cmp.verdict === "divergent" ? "warn" : cmp.verdict === "insufficient" ? "warn" : "ok",
      detail: `${cmp.reason}（实盘 ${liveRet.length} 笔）`,
      fix: cmp.action,
    });
  } catch {
    rows.push({ label: "实盘vs回测", state: "warn", detail: "读不到账本或判决，无法比对", fix: null });
  }


  // ⑦ 探索效率（2026-11-14 新增）：系统「只会一直找、不会停下来想值不值」。
  // 熔断器只管连续失败，管不了「永远成功运行但永远没产出」。这里补上产出钩子。
  try {
    const { evaluateExplorationBudget, attemptsFromQueue, BUDGET_RULE } = await import("./exploration-budget.ts");
    const q = await readJson<{ entries?: { id: string; status?: string; createdAt?: string; lastRunAt?: string | null }[] }>(
      "data/factor-queue.json",
    );
    const g = await readJson<{ list?: { id: string; status?: string; since?: string }[] }>("data/strategy-genome.json");
    const attempts = attemptsFromQueue({ factorQueue: q?.entries ?? [], genome: g?.list ?? [] });
    const budget = evaluateExplorationBudget(attempts, new Date().toISOString().slice(0, 10));
    rows.push({
      label: "探索效率",
      state: budget.verdict === "halt" ? "bad" : budget.verdict === "cooldown" ? "warn" : "ok",
      detail: `${budget.reason}（判据：${BUDGET_RULE.windowDays} 天窗口 / ≥${BUDGET_RULE.minAttempts} 次才判）`,
      fix: budget.action,
    });
  } catch {
    rows.push({ label: "探索效率", state: "warn", detail: "读不到因子队列或基因组，算不出", fix: null });
  }


  // ⑧ 判决功效（2026-11-14 新增）：比「判出什么」更根本——这套规则有没有能力判。
  // 实测：标准差 10.05% + minTrades=12 → 最小可检出 11.49pp，而典型效果只有 3pp。
  // 也就是说攒够样本也判不出来。这条比任何单次判决结论都重要。
  try {
    const { evaluateRulePower } = await import("./rule-power.ts");
    const { loadChallengerRule } = await import("./challenger.ts");
    const rule = await loadChallengerRule();
    const book = await readJson<{ days?: { trades?: { entry: number; exit: number | null }[] }[] }>(
      "data/books/dev-user.json",
    );
    const rets = (book?.days ?? [])
      .flatMap((d) => d.trades ?? [])
      .filter((t) => t && typeof t.exit === "number")
      .map((t) => ((t.exit as number) - t.entry) / t.entry);
    if (rets.length < 30) {
      rows.push({ label: "判决功效", state: "warn", detail: `已平仓只有 ${rets.length} 笔，算不出可靠标准差`, fix: "继续攒样本，≥30 笔后再看" });
    } else {
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
      const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
      const power = evaluateRulePower({ perSide: rule.minTrades, sd, thresholdT: rule.promoteT });
      rows.push({
        label: "判决功效",
        state: power.verdict === "underpowered" ? "warn" : "ok",
        detail: `${power.reason}（标准差 ${(sd * 100).toFixed(2)}% / minTrades=${rule.minTrades}）`,
        fix: power.advice,
      });
    }
  } catch {
    rows.push({ label: "判决功效", state: "warn", detail: "读不到挑战者规则或账本", fix: null });
  }

  return rows;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

export const getSettings = createServerFn({ method: "GET" }).handler(async (): Promise<SettingsPayload> => {
  const root = process.cwd();
  const gaps: string[] = [];

  // 自动记账状态
  let recorder = { at: null as number | null, ok: false };
  try {
    const parsed = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "data", "recorder.json"), "utf8")) as {
      at?: unknown;
      ok?: unknown;
    };
    recorder = { at: typeof parsed.at === "number" ? parsed.at : null, ok: parsed.ok !== false };
  } catch {
    gaps.push("读不到自动记账状态 data/recorder.json——服务可能没在跑，或从没记过账");
  }

  // 行情快照
  let universe = { source: null as string | null, count: 0, ageMin: null as number | null };
  try {
    const snap = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "data", "universe-cache.json"), "utf8")) as {
      at?: unknown;
      payload?: { source?: string; quotes?: unknown[] };
    };
    const quotes = snap.payload?.quotes ?? [];
    universe = {
      source: typeof snap.payload?.source === "string" ? snap.payload.source : null,
      count: Array.isArray(quotes) ? quotes.length : 0,
      ageMin: typeof snap.at === "number" ? Math.max(0, Math.round((Date.now() - snap.at) / 60_000)) : null,
    };
    if (universe.source === "sina") {
      gaps.push("行情快照来自新浪（备源）。它的 d5/d10/d20/d60 整批为 null，依赖涨幅的策略今天会不出票");
    }
  } catch {
    gaps.push("读不到行情快照 data/universe-cache.json——页面上的实时数字会开不了");
  }

  const files = allFreshness(await factsOf(root));
  const missing = missingRequired(files);
  const config = await configRows();
  const health = await healthRows(root);

  return { recorder, universe, files, missing, config, gaps, health };
});