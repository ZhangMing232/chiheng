/**
 * 这个文件是干什么的：
 * 数据审计闸——判决回测跑之前先审数据，数据不可信就不跑、不判、推送叫人。
 *
 * 学 deepseek-harness-quant 的 risk/data_audit.py 三件套：
 *   检查项注册制（加一个检查 = 加一个方法，不改框架）
 *   FAIL 即熔断（block 级检查不过 → 当晚判决回测整个不跑，而不是带病出数）
 *   审计即留档（每次运行追加 data/backtest/data-audit.jsonl，只追加不改）
 *
 * 2026-10-05 的教训是现成动机：下午主源降级三小时，页面只显示「这套策略现在
 * 没有符合的股票」，看着像没机会，实际是数据源缺字段。那次靠人翻日志才发现——
 * 这个闸就是让它当晚自动判「数据不合格 → 不出数 → 推微信」。
 *
 * 你需要知道的：
 * 1. 纯函数 auditFromFacts 只吃「事实」（文件年龄、条数），不碰 fs——
 *    事实收集在最外层，测试拿构造的事实直接测判据。
 * 2. 判据全在本文件 AUDIT_RULE 预登记，改阈值 = 改规则，带着理由改。
 * 3. severity 两级：block = 不过就熔断当晚判决；warn = 记账不挡跑。
 * 4. 只读审计：本文件绝不修改任何数据文件。
 */

/** 预先登记的审计判据。改这里等于改规则本身，要带着理由改。 */
export const AUDIT_RULE = {
  /** 行情快照（universe-cache.json）最长多少分钟没更新算过期。盘前跑审计时放宽。 */
  universeMaxAgeMin: { intraday: 30, premarket: 60 * 14 },
  /** K 线缓存至少多少只才算够回测抽样用（抽样 300，留缓冲）。 */
  minKlineCache: 280,
  /** 市值快照（cap.json 总市值 / floatcap.json 流通市值）最长多少天没更新。
   *  两份由同一个脚本从同一份行情快照建（scripts/build-caps.mjs），同一条线。 */
  capMaxAgeDays: 7,
  /** 因子判决日志（factor-runs.jsonl）最长多少天没更新算判决过期。 */
  verdictMaxAgeDays: 3,
  /** 财报基本面库（fundamentals.json）最长多少天没重抓。财报按季披露，45 天 ≈ 一个半
   *  月，覆盖季度内的增量更新；超龄只 warn——基本面因子已证伪不挡出数，但数据腐烂
   *  要叫人知道，否则哪天翻案重测时拿的是半年前的旧账。 */
  fundMaxAgeDays: 45,
} as const;

/** 一条检查的事实输入。拿不到的事实是 null——判「拿不到」，不猜。 */
export type AuditFacts = {
  /** 行情快照年龄（分钟）。文件不存在 = null。 */
  universeAgeMin: number | null;
  /** 现在是不是盘前（收盘后到次日开盘前）。盘前放宽快照判据。 */
  premarket: boolean;
  /** K 线缓存条数。目录读不到 = null。 */
  klineCount: number | null;
  /** 市值快照年龄（天）。 */
  capAgeDays: number | null;
  /** 流通市值快照年龄（天）。 */
  floatCapAgeDays: number | null;
  /** 最近一批因子判决的年龄（天）。没有批次 = null。 */
  verdictAgeDays: number | null;
  /** 财报基本面库年龄（天）。没跑过抓取脚本 = null。 */
  fundAgeDays: number | null;
};

export type AuditSeverity = "block" | "warn";

export type AuditCheck = {
  id: string;
  label: string;
  severity: AuditSeverity;
  pass: boolean;
  detail: string;
};

export type AuditVerdict = {
  pass: boolean;
  /** block 级失败项——熔断的就是它们。 */
  blocks: AuditCheck[];
  /** warn 级项。 */
  warns: AuditCheck[];
  checks: AuditCheck[];
};

/** 单关判据。注册一个新检查 = 在 CHECKS 里加一条，不改框架。 */
const CHECKS: { id: string; label: string; severity: AuditSeverity; run: (f: AuditFacts) => { pass: boolean; detail: string } }[] = [
  {
    id: "A1",
    label: "行情快照新鲜度",
    severity: "block",
    run: (f) => {
      if (f.universeAgeMin == null) return { pass: false, detail: "universe-cache.json 不存在——行情根本没进来" };
      const limit = f.premarket ? AUDIT_RULE.universeMaxAgeMin.premarket : AUDIT_RULE.universeMaxAgeMin.intraday;
      return {
        pass: f.universeAgeMin <= limit,
        detail: `快照 ${Math.round(f.universeAgeMin)} 分钟前${f.premarket ? "（盘前口径）" : ""}，上限 ${limit} 分钟`,
      };
    },
  },
  {
    id: "A2",
    label: "K 线缓存覆盖",
    severity: "block",
    run: (f) => {
      if (f.klineCount == null) return { pass: false, detail: "data/backtest/kline 读不到——回测没有原料" };
      return {
        pass: f.klineCount >= AUDIT_RULE.minKlineCache,
        detail: `缓存 ${f.klineCount} 只，下限 ${AUDIT_RULE.minKlineCache} 只`,
      };
    },
  },
  {
    id: "A3",
    label: "市值快照新鲜度",
    severity: "warn",
    run: (f) => {
      // cap.json（总市值，回测 BT_CAP 过滤用）和 floatcap.json（流通市值，换手率闸用）
      // 是同一个脚本从同一份行情快照建的两份，检查也放一条：哪份出问题就说哪份。
      const cap = f.capAgeDays;
      const float = f.floatCapAgeDays;
      if (cap == null && float == null) {
        return { pass: false, detail: "cap.json / floatcap.json 都不存在——市值过滤和换手率闸都没了（node scripts/build-caps.mjs 重建）" };
      }
      if (cap != null && float != null && cap <= AUDIT_RULE.capMaxAgeDays && float <= AUDIT_RULE.capMaxAgeDays) {
        const r1 = (d: number) => Math.round(d * 10) / 10;
        return {
          pass: true,
          detail: `总市值 ${r1(cap)} 天前 / 流通市值 ${r1(float)} 天前，上限 ${AUDIT_RULE.capMaxAgeDays} 天`,
        };
      }
      const bad: string[] = [];
      if (cap == null) bad.push("cap.json 缺失（总市值，BT_CAP 市值过滤回退到不滤）");
      else if (cap > AUDIT_RULE.capMaxAgeDays) bad.push(`cap.json ${Math.round(cap)} 天前`);
      if (float == null) bad.push("floatcap.json 缺失（流通市值，换手率闸不生效、放量突破偏宽松）");
      else if (float > AUDIT_RULE.capMaxAgeDays) bad.push(`floatcap.json ${Math.round(float)} 天前`);
      return { pass: false, detail: `${bad.join("；")}，上限 ${AUDIT_RULE.capMaxAgeDays} 天` };
    },
  },
  {
    id: "A4",
    label: "判决日志新鲜度",
    severity: "warn",
    run: (f) => {
      if (f.verdictAgeDays == null) return { pass: false, detail: "factor-runs.jsonl 没有批次——AI 的 prompt 将没有账可读" };
      return {
        pass: f.verdictAgeDays <= AUDIT_RULE.verdictMaxAgeDays,
        detail: `最近判决 ${f.verdictAgeDays} 天前，上限 ${AUDIT_RULE.verdictMaxAgeDays} 天`,
      };
    },
  },
  {
    id: "A5",
    label: "财报基本面库新鲜度",
    severity: "warn",
    run: (f) => {
      if (f.fundAgeDays == null) return { pass: false, detail: "fundamentals.json 不存在——基本面因子全部取 null（已证伪所以不挡跑，但重测前要先抓数）" };
      return {
        pass: f.fundAgeDays <= AUDIT_RULE.fundMaxAgeDays,
        detail: `财报库 ${Math.round(f.fundAgeDays)} 天前重抓，上限 ${AUDIT_RULE.fundMaxAgeDays} 天（scripts/fetch-fundamentals.py 增量补）`,
      };
    },
  },
];

/** 纯函数：事实 → 判定。 */
export function auditFromFacts(facts: AuditFacts): AuditVerdict {
  const checks: AuditCheck[] = CHECKS.map((c) => ({ id: c.id, label: c.label, severity: c.severity, ...c.run(facts) }));
  const blocks = checks.filter((c) => c.severity === "block" && !c.pass);
  const warns = checks.filter((c) => c.severity === "warn" && !c.pass);
  return { pass: blocks.length === 0, blocks, warns, checks };
}

// ── 事实收集 + 留档（node:fs，server-only）────────────────────

import { appendFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

function dataDir(): string {
  return process.env.CHIHENG_DATA_DIR ?? join(process.cwd(), "data");
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

/** 从盘上收集事实。任何一项读不到都是 null，由判据说人话。 */
export async function collectFacts(now = Date.now()): Promise<AuditFacts> {
  let universeAgeMin: number | null = null;
  try {
    const s = await stat(join(dataDir(), "universe-cache.json"));
    universeAgeMin = (now - s.mtimeMs) / MIN_MS;
  } catch {
    // null = 不存在
  }
  let klineCount: number | null = null;
  try {
    klineCount = (await readdir(join(dataDir(), "backtest", "kline"))).length;
  } catch {
    // null
  }
  let capAgeDays: number | null = null;
  try {
    const s = await stat(join(dataDir(), "backtest", "cap.json"));
    capAgeDays = (now - s.mtimeMs) / DAY_MS;
  } catch {
    // null
  }
  let floatCapAgeDays: number | null = null;
  try {
    const s = await stat(join(dataDir(), "backtest", "floatcap.json"));
    floatCapAgeDays = (now - s.mtimeMs) / DAY_MS;
  } catch {
    // null
  }
  let verdictAgeDays: number | null = null;
  try {
    const raw = await readFile(join(dataDir(), "backtest", "factor-runs.jsonl"), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    if (lines.length > 0) {
      const last = JSON.parse(lines[lines.length - 1]) as { at?: string };
      if (last.at) verdictAgeDays = (now - new Date(last.at).getTime()) / DAY_MS;
    }
  } catch {
    // null
  }
  let fundAgeDays: number | null = null;
  try {
    const s = await stat(join(dataDir(), "backtest", "fundamentals.json"));
    fundAgeDays = (now - s.mtimeMs) / DAY_MS;
  } catch {
    // null = 没跑过抓取脚本
  }
  // 盘前 = 本地时间 15:00 之后或 09:30 之前（粗略但够用：这个判据只为放宽 A1）。
  const d = new Date(now);
  const mins = d.getHours() * 60 + d.getMinutes();
  const premarket = mins >= 15 * 60 || mins < 9 * 60 + 30;
  return { universeAgeMin, premarket, klineCount, capAgeDays, floatCapAgeDays, verdictAgeDays, fundAgeDays };
}

/** 跑一轮审计并留档。返回判定；写 data/backtest/data-audit.jsonl（只追加）。 */
export async function runDataAudit(now = Date.now()): Promise<AuditVerdict> {
  const verdict = auditFromFacts(await collectFacts(now));
  const dir = join(dataDir(), "backtest");
  await mkdir(dir, { recursive: true });
  await appendFile(
    join(dir, "data-audit.jsonl"),
    JSON.stringify({ at: new Date(now).toISOString(), pass: verdict.pass, checks: verdict.checks }) + "\n",
    "utf8",
  );
  return verdict;
}
