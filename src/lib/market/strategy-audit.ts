/**
 * 这个文件是干什么的：
 * 策略审计——学 deepseek-harness-quant（VT）的「审计：让 AI 自查前视、覆盖率、
 * 共线性、过拟合」。把回测运行记录（runs.jsonl）里已经落盘的数据重新过一遍
 * 横切检查，产出一份「这组数字里哪些地方不能信」的清单。
 *
 * 你需要知道的：
 * 1. **审计不重演回测**。它只读那次运行落下来的数字（env + 每套策略的指标和
 *    日度序列），做组合层面的检查：两套策略是不是同一个押注重复收费（共线性）、
 *    回测窗口里有多少票其实没数据（覆盖率）、样本够不够支撑 t 值（样本）、
 *    连亏和回撤有没有超出这套打法的承受能力（回撤）。
 * 2. **前视不在这里查**。前视防线在信号级——每个检测函数只读 rows[0..i] 是
 *    铁律，由单测钉住（如 wyckoff-spring 的截断重算一致性测试）、财报按披露日
 *    point-in-time 取。面板里前视一栏只如实声明这件事 + 核验撮合口径
 *    （fillMode=b 按真实成交、跳空按开盘），不假装能在这里「查出」前视。
 * 3. 过拟合的量化（PBO、参数敏感度）在 challenger-robust.ts，已由挑战者面板展示；
 *    这里只补它没覆盖的组合层面检查，不重复造。
 * 4. 纯函数零 I/O：入参是已经读好的运行记录，输出是发现列表。能自动测。
 */

import type { BacktestEnv, BacktestRun, BacktestStyleStat } from "@/lib/market/backtest-runs";

export type AuditFinding = {
  area: "前视" | "覆盖率" | "共线性" | "样本" | "回撤";
  level: "ok" | "info" | "warn";
  title: string;
  detail: string;
};

const order = { warn: 0, info: 1, ok: 2 };

/** 审计只需要日度的日期和收益，不挑序列元素上的其它字段（BacktestStyleStat 里还有 n）。 */
type DailyPoint = { date: string; ret: number };

/**
 * 两条日度收益的皮尔逊相关系数（按日期对齐，只对两边都有的天算）。
 * 有效对数 < 20 或任一方差为 0 → null（「算不出来」不是 0）。
 */
export function seriesCorrelation(a: DailyPoint[], b: DailyPoint[]): number | null {
  const mapB = new Map(b.map((point) => [point.date, point.ret]));
  const pairs: [number, number][] = [];
  for (const point of a) {
    const other = mapB.get(point.date);
    if (other != null) pairs.push([point.ret, other]);
  }
  if (pairs.length < 20) return null;
  const meanA = pairs.reduce((sum, [x]) => sum + x, 0) / pairs.length;
  const meanB = pairs.reduce((sum, [, y]) => sum + y, 0) / pairs.length;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (const [x, y] of pairs) {
    cov += (x - meanA) * (y - meanB);
    varA += (x - meanA) ** 2;
    varB += (y - meanB) ** 2;
  }
  // 方差为 0（常数序列）没有相关可言。浮点累加会给「数学上的 0」留残差，
  // 用容差判，不用 === 0。
  if (varA < 1e-20 || varB < 1e-20) return null;
  return cov / Math.sqrt(varA * varB);
}

/**
 * 共线性：两套策略的日度收益序列相关。r ≥ 0.8 = 同一个押注重复收费
 * （组合的「分散」是假的）；r ≥ 0.6 先留意。序列凑不够 20 个共同交易日的对
 * 如实跳过，并在 detail 里说明，不硬算。
 */
export function collinearityFindings(
  styles: { key: string; label: string; daily?: DailyPoint[] }[],
  high = 0.8,
  watch = 0.6,
): AuditFinding[] {
  const withDaily = styles.filter((style) => (style.daily?.length ?? 0) > 0);
  const findings: AuditFinding[] = [];
  if (withDaily.length < 2) {
    return [
      {
        area: "共线性",
        level: "info",
        title: "共线性无法评估",
        detail: "少于两套策略带日度序列（老运行记录没有这个字段），算不了策略间相关性。跑一次新回测自动补上。",
      },
    ];
  }
  let skippedPairs = 0;
  for (let i = 0; i < withDaily.length; i += 1) {
    for (let j = i + 1; j < withDaily.length; j += 1) {
      const r = seriesCorrelation(withDaily[i].daily!, withDaily[j].daily!);
      if (r == null) {
        skippedPairs += 1;
        continue;
      }
      const pct = (r * 100).toFixed(0);
      if (r >= high) {
        findings.push({
          area: "共线性",
          level: "warn",
          title: `${withDaily[i].label} ≈ ${withDaily[j].label}`,
          detail: `日度收益相关 r=${pct}%，≥ ${high * 100}%。这两套本质是同一个押注重复收费——组合层面没有分散，风险和收益都该按一套算。`,
        });
      } else if (r >= watch) {
        findings.push({
          area: "共线性",
          level: "info",
          title: `${withDaily[i].label} 与 ${withDaily[j].label} 偏像`,
          detail: `日度收益相关 r=${pct}%，在 ${watch * 100}-${high * 100}% 区间。还没到同一个押注的程度，但加仓时别当两套独立信号算。`,
        });
      }
    }
  }
  if (findings.length === 0) {
    findings.push({
      area: "共线性",
      level: "ok",
      title: "策略间相关正常",
      detail: `所有带日度序列的策略两两相关都在 ${watch * 100}% 以下${skippedPairs > 0 ? `（${skippedPairs} 对共同交易日不足 20 天，已跳过）` : ""}。`,
    });
  }
  return findings.sort((a, b) => order[a.level] - order[b.level]);
}

/** 覆盖率：抽了多少票、实际拿到日线的多少。缺口大 = 结论建立在幸存票上。 */
export function coverageFinding(env: BacktestEnv): AuditFinding {
  const { sample, covered, days } = env;
  const coverPct = sample > 0 ? covered / sample : 0;
  if (covered < sample) {
    return {
      area: "覆盖率",
      level: "warn",
      title: "回测覆盖率有缺口",
      detail: `抽了 ${sample} 只，只拿到 ${covered} 只日线（${(coverPct * 100).toFixed(0)}%）。没数据的那部分票如果是系统性地「小票/差票」，回测数字会偏乐观——先补数据再信结论。`,
    };
  }
  if (days < 120) {
    return {
      area: "覆盖率",
      level: "info",
      title: "回测窗口偏短",
      detail: `区间只有 ${days} 个交易日，不足半年。t 值按年化的直觉不成立，别把短期行情当策略能力。`,
    };
  }
  return {
    area: "覆盖率",
    level: "ok",
    title: "覆盖率完整",
    detail: `抽样 ${sample} 只全部拿到日线，区间 ${days} 个交易日。`,
  };
}

/**
 * 样本量：|t| ≥ 2 但笔数太少，t 值照样不稳（渐近统计在小样本下就是脆）。
 * 经验线 100 笔：低于它，t 值只当参考，不当证据。
 */
export function sampleSizeFindings(styles: Pick<BacktestStyleStat, "label" | "trades" | "tStat">[], minTrades = 100): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const style of styles) {
    if (style.trades >= minTrades) continue;
    const signif = Math.abs(style.tStat) >= 2;
    findings.push({
      area: "样本",
      level: signif ? "info" : "warn",
      title: `${style.label} 样本 ${style.trades} 笔`,
      detail: signif
        ? `低于 ${minTrades} 笔的经验线。t=${style.tStat.toFixed(2)} 看着过了线，但小样本的 t 值对分布假设敏感，只当参考。`
        : `${style.trades} 笔撑不起统计结论——这套目前是「没测出来」，不是「不行」，也不是「行」。`,
    });
  }
  if (findings.length === 0) {
    findings.push({ area: "样本", level: "ok", title: "样本量充足", detail: `每套策略都 ≥ ${minTrades} 笔，t 值有统计意义。` });
  }
  return findings.sort((a, b) => order[a.level] - order[b.level]);
}

/** 回撤：连亏天数和最大回撤有没有超出「这套打法本来就扛不住」的范围。阈值是规则，可调。 */
export function drawdownFindings(
  styles: Pick<BacktestStyleStat, "label" | "worstStreak" | "drawdown">[],
  maxStreak = 10,
  maxDrawdown = 0.5,
): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const style of styles) {
    if (style.worstStreak >= maxStreak) {
      findings.push({
        area: "回撤",
        level: "warn",
        title: `${style.label} 连亏 ${style.worstStreak} 天`,
        detail: `超过 ${maxStreak} 天。回测里的连亏是纸面的，实盘拿着是真实的——先问自己能不能扛住这段再谈超额。`,
      });
    }
    if (style.drawdown >= maxDrawdown) {
      findings.push({
        area: "回撤",
        level: "warn",
        title: `${style.label} 回撤 ${(style.drawdown * 100).toFixed(0)}%`,
        detail: `按日算的回撤超过 ${maxDrawdown * 100}%。单笔等权的回测数字体会不到这种深度，它专门惩罚实盘执行。`,
      });
    }
  }
  if (findings.length === 0) {
    findings.push({
      area: "回撤",
      level: "ok",
      title: "回撤在承受范围内",
      detail: `所有策略连亏 < ${maxStreak} 天、回撤 < ${maxDrawdown * 100}%。`,
    });
  }
  return findings.sort((a, b) => order[a.level] - order[b.level]);
}

/** 前视：本面板不重演信号，只声明防线在哪 + 核验撮合口径不是「乐观假设」。 */
export function lookaheadFinding(env: BacktestEnv): AuditFinding {
  if (env.fillMode !== "b") {
    return {
      area: "前视",
      level: "warn",
      title: "撮合口径不是真实成交",
      detail: `fillMode="${env.fillMode}"。b=按真实成交（跳空按开盘）是防前视的口径；别的口径如果按「挂单价必成」撮合，等于假设你总能成交在理想价——这是最常见的隐性前视。`,
    };
  }
  return {
    area: "前视",
    level: "ok",
    title: "前视防线在位",
    detail: "信号级无前视由单测钉住（每个检测函数只读 rows[0..i]，截断重算一致性进 CI）；财报按披露日 point-in-time 取。本面板不重演信号，这里只核验撮合口径：fillMode=b 按真实成交、跳空按开盘，换手率闸 " +
      (env.turnoverGate ? "生效" : "未生效") +
      "。",
  };
}

/** 对一次运行做全套审计，严重度排序（warn > info > ok）。 */
export function auditRun(run: Pick<BacktestRun, "env" | "styles">): AuditFinding[] {
  return [
    lookaheadFinding(run.env),
    coverageFinding(run.env),
    ...collinearityFindings(run.styles),
    ...sampleSizeFindings(run.styles),
    ...drawdownFindings(run.styles),
  ].sort((a, b) => order[a.level] - order[b.level]);
}
