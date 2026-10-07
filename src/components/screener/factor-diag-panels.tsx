/**
 * 这个文件是干什么的：
 * 因子页的两块研究性诊断——缩量天数归因（翻号到底是「一整段环境变了」还是零散的）
 * 和资金流探路（持有期压测）。
 *
 * 你需要知道的：
 * 1. 这两块的数据**不进 6 关判决**，它们是「为什么没过关」的解释，不是过关证明。
 *    页面必须说清这一点，否则读者会以为这是又一组信号。
 * 2. 翻号段表里那列「同期全池」是这段全市场等权涨跌——它是用来检验「普涨导致
 *    缩量失效」这个猜想的。实测涨跌都有，猜想不成立，所以结论行要如实写「推翻」，
 *    不能因为猜错了就不写。
 * 3. 资金流只有 120 个交易日缓存，G3 两段各 60 天偏短——t=2.24 只能当方向，
 *    不能当过关。这条必须写在块里，不能只在代码注释里。
 */
import { Stat, Table, Tag, tdClass, thClass, pctClass } from "@/components/terminal";
import { signedPct } from "@/lib/market/format";
import type { FlowStressGroup } from "@/lib/market/factors-view";
import type { ShrinkBullDiag, ShrinkFlipDiag } from "@/lib/market/factor-runs-file";

export function ShrinkFlipPanel({ diag, bull }: { diag: ShrinkFlipDiag; bull: ShrinkBullDiag | null }) {
  const longest = diag.segments.reduce(
    (best, s) => (s.days > (best?.days ?? 0) ? s : best),
    null as ShrinkFlipDiag["segments"][number] | null,
  );
  return (
    <div>
      <div className="grid gap-px bg-line sm:grid-cols-3">
        <Stat
          label="缩量天数 × 60日涨幅"
          value={diag.corrAll.toFixed(3)}
          hint="横截面 Spearman 均值。|ρ| 这么低 = 它俩不是一个信号"
          className="bg-surface"
        />
        <Stat
          label="控制 60日涨幅后的独立 t"
          value={diag.neutT.toFixed(2)}
          tone={Math.abs(diag.neutT) >= 2 ? "text-fg" : "text-muted"}
          hint={`独立 spread ${signedPct(diag.neutSpread * 100)}，${diag.neutDays} 天`}
          className="bg-surface"
        />
        <Stat
          label="失效（翻号）段数"
          value={String(diag.segments.length)}
          hint={`共 ${diag.segments.reduce((s, x) => s + x.days, 0)} 个交易日，零散分布`}
          className="bg-surface"
        />
      </div>

      <p className="px-3 py-3 text-xs leading-relaxed text-muted">
        按 5 日滚动平均精确到交易日：缩量信号失效是<strong className="font-normal text-fg">零散的 {diag.segments.length} 段</strong>，
        不是「某段时间整体不行」。最长一段 {longest ? `${longest.from} ~ ${longest.to}（${longest.days} 天）` : "—"}
        {longest ? `，同期全池 ${signedPct(longest.poolRet * 100)}` : ""}——
        是跌的，不是普涨。翻号段里全池有涨有跌，<strong className="font-normal text-fg">「普涨导致缩量失效」这个猜想被推翻了</strong>。
      </p>

      <Table
        className="data-table"
        caption="缩量信号翻号的交易日段，以及每段同期全市场等权涨跌"
      >
        <thead>
          <tr className="border-b border-line">
            <th className={thClass("text-left")}>起</th>
            <th className={thClass("text-left")}>止</th>
            <th className={thClass()}>天数</th>
            <th className={thClass()}>滚动 spread</th>
            <th className={thClass()}>同期全池</th>
          </tr>
        </thead>
        <tbody>
          {diag.segments.map((s) => (
            <tr key={`${s.from}-${s.to}`} className="border-b border-line last:border-b-0">
              <td data-l="起" className={tdClass("text-left")}>
                {s.from}
              </td>
              <td data-l="止" className={tdClass("text-left")}>
                {s.to}
              </td>
              <td data-l="天数" className={tdClass()}>
                {s.days}
              </td>
              <td data-l="滚动 spread" className={tdClass(pctClass(s.rollingSpread * 100))}>
                {signedPct(s.rollingSpread * 100)}
              </td>
              <td data-l="同期全池" className={tdClass(pctClass(s.poolRet * 100))}>
                {signedPct(s.poolRet * 100)}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>

      {bull ? (
        <p className="px-3 py-3 text-xs leading-relaxed text-muted">
          又试过「缩量 + 当日止跌」这个组合：顶档里当日收涨的那半平均超额 {signedPct(bull.bullMean * 100)}，
          不涨的那半 {signedPct(bull.bearMean * 100)}，止跌溢价 {signedPct(bull.premiumMean * 100)}
          （t={bull.premiumT.toFixed(2)}）——<strong className="font-normal text-fg">也没用</strong>。
          合起来看：缩量天数的失效，在量价能算的维度里解释不了。
        </p>
      ) : null}
    </div>
  );
}

export function FlowProbePanel({ groups }: { groups: FlowStressGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <div>
      <Table className="data-table" caption="资金流因子的持有期压测：换持有期看独立 t 稳不稳">
        <thead>
          <tr className="border-b border-line">
            <th className={thClass("text-left")}>因子</th>
            {groups.map((g) => (
              <th key={g.n} className={thClass()}>
                持有 {g.n} 天
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups[0]?.rows.map((row) => (
            <tr key={row.id} className="border-b border-line last:border-b-0">
              <td data-l="因子" className="sticky left-0 bg-surface px-2.5 py-1.5 text-left font-medium">
                {row.name}
              </td>
              {groups.map((g) => {
                const cell = g.rows.find((r) => r.id === row.id);
                if (!cell) {
                  return (
                    <td key={g.n} data-l={`持有 ${g.n} 天`} className={tdClass("text-muted")}>
                      —
                    </td>
                  );
                }
                return (
                  <td key={g.n} data-l={`持有 ${g.n} 天`} className={tdClass()}>
                    <span className="tabular-nums">{cell.t.toFixed(2)}</span>
                    <span className="ml-1 text-xs text-muted">/</span>
                    <span className={`ml-1 tabular-nums ${Math.abs(cell.neutT) >= 2 ? "text-fg" : "text-muted"}`}>
                      {cell.neutT.toFixed(2)}
                    </span>
                    {cell.independent ? (
                      <span className="ml-1">
                        <Tag tone="warn">独立</Tag>
                      </span>
                    ) : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </Table>

      <p className="px-3 py-3 text-xs leading-relaxed text-muted">
        每格是「原始 t / 控制当日涨幅后的独立 t」，标
        <span className="mx-1">独立</span>的是独立 t 过了 2 的。
        <strong className="font-normal text-fg">当日主力净流入占比是当日涨幅的伪装</strong>
        （独立 t 约 0.28，控制涨幅后就没了）——不先做正交化，很容易把它当成资金流信号。
        主力 5 日累计占比确实有 OHLCV 之外的信息，但
        <strong className="font-normal text-fg">只有持有 10 天这一档过 2，换成 5 天或 20 天就衰减</strong>。
      </p>
      <p className="px-3 pb-3 text-xs leading-relaxed text-muted">
        两个前提要说清：资金流历史免费源只给 120 个交易日，所以 G3 两段各只有 60 天，
        <strong className="font-normal text-fg">这个 t 只能当方向，不能当过关</strong>；
        换样本（G4）这次没做，表里那一列是「—」不是 ✗。
      </p>
    </div>
  );
}
