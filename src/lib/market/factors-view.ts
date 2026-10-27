/**
 * 这个文件是干什么的：
 * 把 factor-runs.jsonl 的原始行做成页面能直接渲染的视图模型——补上因子注册表里的
 * 「预注册理由」，把 G1~G6 的 ✓/✗ 和判据原话配成对，算出「25 个里过了几个」。
 *
 * 你需要知道的：
 * 1. **不含 JSX**——这个文件会被 `node --test` 用 `--experimental-strip-types` 跑，
 *    不转译 JSX（data-status.ts 里记过同一个坑）。渲染的事交给路由和组件。
 * 2. 只 import `./factors` 的注册表（纯函数）拿预注册理由，**绝不 import
 *    scripts/backtest.ts**——它有 node:fs 和文件末尾的 `await main()` 副作用。
 * 3. `pass: null` 表示「这一关没做或没记」，页面必须渲染成「—」，**不许渲染成 ✗**：
 *    资金流探路确实没做 G4 换样本，2026-10-07 之前的批次也确实没落前后两段。
 *    缺的样子就是缺，补成 false 是在撒谎，补成 true 更是在撒谎。
 * 4. 「过了几关」只数 `pass === true` 的，null 不计入分子也不计入分母。
 */

// 用 @/ 别名而不是 ./factors：scripts/alias.mjs 只认 @/ 前缀（会把后面拼成 .ts 路径），
// Vite 侧靠 tsconfigPaths 认同一个别名。写相对路径在 node --test 下会解析不到。
import { FACTORS } from "@/lib/market/factors";
import { familyClashes, type FamilyClash } from "@/lib/market/factor-family";
// 只 import 类型——factor-runs-file 里有 node:fs，前端不能真的把它打进来。
import type { FactorRunRow, FlowProbeDiag, GateKey } from "@/lib/market/factor-runs-file";

export type GateCell = {
  key: GateKey;
  /** true 过 / false 没过 / null 这关没做或旧批次没记 —— 渲染成「—」 */
  pass: boolean | null;
  detail: string;
};

export const GATE_KEYS: GateKey[] = ["g1", "g2", "g3", "g4", "g5", "g6"];

/** 六关各判什么。页面表头和脚注都从这里出，避免文案在两处各写一份。 */
export const GATE_LEGEND: { key: GateKey; label: string; rule: string }[] = [
  {
    key: "g1",
    label: "单调",
    rule: "分档均值随档位单调，且方向符合跑之前写的预注册假设（Spearman 绝对值 ≥ 0.8）",
  },
  { key: "g2", label: "显著", rule: "|t| ≥ 2，不到 2 等于没测出来" },
  { key: "g3", label: "两段", rule: "前后两半段同号且各自 |t| ≥ 0.7；翻号 = 不能用" },
  { key: "g4", label: "换样本", rule: "换一批互不重叠的股票，spread 仍同号且 |t| ≥ 1.5" },
  { key: "g5", label: "多重检验", rule: "Bonferroni：按已测因子总数 N 收紧临界 t，测得越多门槛越高" },
  { key: "g6", label: "可交易", rule: "顶档被真实可交易闸（ST / 低价 / 市值）挡掉的比例 ≤ 50%" },
];

export type FactorRowView = {
  id: string;
  name: string;
  category: string;
  direction: 1 | -1;
  /** 跑之前写下的经济逻辑。查不到就说明这个因子不在当前注册表里。 */
  rationale: string;
  rationaleMissing: boolean;
  bucketMeans: number[];
  spread: number;
  t: number;
  nDays: number;
  gates: GateCell[];
  /** 过了几关（null 不算过，也不算进分母） */
  passed: number;
  total: number;
  allPass: boolean;
};

function gateCell(row: FactorRunRow, key: GateKey): GateCell {
  const passRaw = row.gates?.[key];
  const detailRaw = row.gateDetails?.[key];
  // gates 里压根没有这一关（比如资金流探路没做 G4）→ null，不是 false。
  const pass = passRaw === undefined ? null : passRaw;
  const detail =
    detailRaw ??
    (pass === null ? "这一关这次没做，所以没有判据" : "旧批次没留下判据原话，只有 ✓/✗（重跑一次就会有）");
  return { key, pass, detail };
}

/** 按 |t| 降序——最强的排最前，一眼看得见「现在最像样的信号是哪个」。 */
export function factorRows(rows: FactorRunRow[]): FactorRowView[] {
  const out = rows.map((row) => {
    const meta = FACTORS.find((f) => f.id === row.factor);
    const gates = GATE_KEYS.map((key) => gateCell(row, key));
    return {
      id: row.factor,
      name: meta?.name ?? row.name,
      category: meta?.category ?? "—",
      direction: row.direction,
      rationale: meta?.rationale ?? "",
      rationaleMissing: !meta,
      bucketMeans: row.bucketMeans,
      spread: row.meanSpread,
      t: row.t,
      nDays: row.nDays,
      gates,
      passed: gates.filter((g) => g.pass === true).length,
      total: GATE_KEYS.length,
      allPass: gates.every((g) => g.pass === true),
    };
  });
  return out.sort((a, b) => Math.abs(b.t) - Math.abs(a.t));
}

export type BatchSummary = {
  total: number;
  /** 全 6 关都过的个数。现在是 0——这个数字要放大了给人看，不许藏。 */
  passed: number;
  /** |t| 最大的那个（已按 |t| 降序，即第一个） */
  strongest: FactorRowView | null;
  /** 只差一关的：不是过关，但是离得最近的几个 */
  nearMiss: FactorRowView[];
  /**
   * 同族同方向 ≥2 个的组（factor-family.ts）。「25 个因子」可能只有 8 个概念——
   * 这个数字要和 total 放在一起看，不许只报因子个数不报概念个数。
   */
  familyClashes: FamilyClash[];
};

export function batchSummary(rows: FactorRunRow[]): BatchSummary {
  const views = factorRows(rows);
  return {
    total: views.length,
    passed: views.filter((v) => v.allPass).length,
    strongest: views[0] ?? null,
    nearMiss: views.filter((v) => !v.allPass && v.passed === v.total - 1),
    familyClashes: clashesOf(views),
  };
}

/**
 * 这一批因子的家族共线组。注册表里的有 family 标签；跑过但已不在注册表的
 * （旧因子）用 id 自成一族，不点名——档案在 factor-tombstones.ts 里。
 */
function clashesOf(views: FactorRowView[]): FamilyClash[] {
  return familyClashes(
    views.map((v) => {
      const meta = FACTORS.find((f) => f.id === v.id);
      return { id: v.id, name: v.name, direction: v.direction, family: meta?.family };
    }),
  );
}

export type FlowStressRow = {
  id: string;
  name: string;
  spread: number;
  t: number;
  /** 控制当日涨幅之后的独立 t。这是「有没有 OHLCV 之外的信息」的判据。 */
  neutT: number;
  independent: boolean;
};

export type FlowStressGroup = {
  n: number;
  effectiveDays: number;
  cacheHit: number;
  cacheTotal: number;
  rows: FlowStressRow[];
};

/**
 * 资金流探路的持有期压测表（N=5 / 10 / 20 各一组）。
 * 三条凑成一张表才看得出「只在 N=10 过 2，换持有期就衰减」——分开看是看不出来的。
 * 缺哪个持有期就只有哪几个，不补 0。
 */
export function flowStress(records: FlowProbeDiag[]): FlowStressGroup[] {
  return records
    .map((r) => ({
      n: r.n,
      effectiveDays: r.effectiveDays,
      cacheHit: r.cacheHit,
      cacheTotal: r.cacheTotal,
      rows: r.factors.map((f) => ({
        id: f.id,
        name: f.name,
        spread: f.spread,
        t: f.t,
        neutT: f.neutT,
        independent: Math.abs(f.neutT) >= 2,
      })),
    }))
    .sort((a, b) => a.n - b.n);
}
