/**
 * 前瞻回验（/huiyan）——**这个页面是赤轨的自证，也是它最容易说谎的地方**。
 *
 * 两件必须分清、绝不混算的事：
 * ① **落档**：每天收盘后按固定规则挑 3 只，写进文件并记下 lockedAt。
 *    落档之后不许改。次日收盘自动结算。这是「当时说了什么」的唯一凭据。
 * ② **口径回算**：拿同一套规则在过去 60 个交易日重跑一遍。
 *    它不是当时发出去的清单，**不能当对外战绩**，所以单独一块、灰色、标题就写明。
 *
 * 两条口径写死在页面上，不只写在代码里：
 * - 结算用 T+1 开盘买入（最早能成交的价），T+1 收盘算涨跌。不含未来函数。
 * - 命中率必须跟全市场基准比。「追买成立 80%」听着不错，但全市场任何一只票
 *   当天最高价高于开盘价的概率是 94%，所以 80% 其实是**显著跑输**。
 */

import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Panel, Tag } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { getForecast, type ForecastPeriod } from "@/lib/market/archive.functions";

export const Route = createFileRoute("/huiyan")({
  loader: async () => await getForecast(),
  component: HuiyanPage,
});

const pct = (v: number | null | undefined, d = 1) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`);
const rate = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : "—");

/** UTC ISO → 北京时间 yyyy-mm-dd hh:mm。落档时刻是这一页的信用凭据，必须能看清。 */
function bjTime(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  const s = new Date(d.getTime() + 8 * 3600_000).toISOString();
  return `${s.slice(0, 10)} ${s.slice(11, 16)}`;
}

function HuiyanPage() {
  const { locked, backtest } = Route.useLoaderData();

  const settled = locked.filter((p) => p.summary && p.summary.n > 0);
  const picks = settled.reduce((s, p) => s + (p.summary?.n ?? 0), 0);
  const hits = settled.reduce((s, p) => s + (p.summary?.hits ?? 0), 0);
  const chases = settled.reduce((s, p) => s + (p.summary?.chases ?? 0), 0);
  const lim = settled.reduce((s, p) => s + (p.summary?.limitUps ?? 0), 0);

  const bt = backtest;
  const btPicks = bt?.periods.reduce((s, p) => s + (p.summary?.n ?? 0), 0) ?? 0;
  const btHits = bt?.periods.reduce((s, p) => s + (p.summary?.hits ?? 0), 0) ?? 0;
  const btChases = bt?.periods.reduce((s, p) => s + (p.summary?.chases ?? 0), 0) ?? 0;

  return (
    <Frame
      wide
      aside={
        <span className="num text-xs text-muted">
          落档 {locked.length} 期 · 可结算 {settled.length} 期 · 口径回算 {bt?.periods.length ?? 0} 期
        </span>
      }
    >
      <div className="flex flex-col gap-3">
        <Panel
          title="落档战绩"
          note={<span className="text-[11px]">只算真的当晚落过档的期，口径回算不混进来</span>}
        >
          <div className="grid grid-cols-2 gap-px overflow-hidden border-b border-line bg-line sm:grid-cols-4">
            <Cell label="可结算期数" value={`${settled.length}`} hint={`共落档 ${locked.length} 期`} />
            <Cell
              label="方向命中"
              value={picks ? rate(hits, picks) : "—"}
              hint={`${hits}/${picks} 笔 · 次日收盘涨`}
            />
            <Cell label="追买成立" value={picks ? rate(chases, picks) : "—"} hint={`${chases}/${picks} 笔`} />
            <Cell label="次日涨停" value={picks ? rate(lim, picks) : "—"} hint={`${lim}/${picks} 笔`} />
          </div>
          <div className="px-3 py-2 text-[11px] leading-relaxed text-muted">
            {settled.length === 0 ? (
              <>
                还没有可结算的期。今天（{locked[0]?.date ?? "—"}）刚落了第一版，
                <b className="text-fg">下一个交易日收盘后</b>才会出第一条对照。
                在这之前这一栏空着——空着比填个历史回算的数字诚实。
              </>
            ) : settled.length < 20 ? (
              <>
                只有 {settled.length} 期，样本不足，别拿这几个数当胜率。
                低于 20 期我按纪律只给计数、不给「能力」的评价。
              </>
            ) : null}
          </div>
        </Panel>

        <Panel title="逐期对照" note={<span className="text-[11px]">每期 3 只 · 按规则挑 · 挑完锁档</span>}>
          {locked.length === 0 ? (
            <StateBlock
              kind="empty"
              title="还没落过档"
              hint="收盘封印后跑 scripts/forecast.ts --log 就有。盘中不落档——盘中落档等于事后改口。"
            />
          ) : (
            <div className="flex flex-col divide-y divide-line">
              {locked.map((p) => (
                <PeriodBlock key={p.date} p={p} />
              ))}
            </div>
          )}
          <div className="border-t border-line px-3 py-2 text-[11px] leading-relaxed text-muted">
            结算口径：T 日收盘后挑票 → <b className="text-fg">T+1 开盘买入</b>（最早能成交的价）→ T+1 收盘算涨跌。
            「追买」= 次日开盘买入后盘中最高价仍高于开盘价。两个价都是盘后才知道的，不含未来函数。
          </div>
        </Panel>

        <Panel
          title="口径回算（事后重算，不是当时发的清单）"
          note={<span className="text-[11px]">同一套规则 · 过去 {bt?.periods.length ?? 0} 个交易日重跑</span>}
        >
          {!bt ? (
            <StateBlock kind="empty" title="还没回算" hint="跑 scripts/forecast.ts --backtest。" />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-px overflow-hidden border-b border-line bg-line sm:grid-cols-4">
                <Cell label="样本" value={`${bt.periods.length} 期`} hint={`${btPicks} 笔`} />
                <Cell
                  label="方向命中"
                  value={rate(btHits, btPicks)}
                  hint={`全市场基准 ${bt.baseline?.upRate != null ? `${(bt.baseline.upRate * 100).toFixed(1)}%` : "—"}`}
                  good={bt.baseline?.upRate != null && btHits / Math.max(1, btPicks) > bt.baseline.upRate + 0.02}
                />
                <Cell
                  label="追买成立"
                  value={rate(btChases, btPicks)}
                  hint={`全市场基准 ${bt.baseline?.chaseRate != null ? `${(bt.baseline.chaseRate * 100).toFixed(1)}%` : "—"}`}
                  good={bt.baseline?.chaseRate != null && btChases / Math.max(1, btPicks) > bt.baseline.chaseRate}
                />
                <Cell label="次日涨停" value={rate(bt.periods.reduce((s, p) => s + (p.summary?.limitUps ?? 0), 0), btPicks)} hint="—" />
              </div>
              <div className="border-b border-line bg-surface-2 px-3 py-2 text-[11px] leading-relaxed">
                <b className="text-fg">这一块要连着基准读。</b>「追买成立」这个指标单看很容易骗人：
                全市场随便一只票，当天最高价高于开盘价的概率就有{" "}
                {bt.baseline?.chaseRate != null ? `${(bt.baseline.chaseRate * 100).toFixed(1)}%` : "—"}，
                所以这一套规则跑出 {rate(btChases, btPicks)} 其实是
                <b className="text-down">跑输</b>「随便买一只」。别被 80% 这种数字骗了。
              </div>
              <details className="px-3 py-2">
                <summary className="cursor-pointer text-[11px] text-muted hover:text-fg">
                  展开逐期明细（{bt.periods.length} 期）
                </summary>
                <div className="mt-2 flex flex-col divide-y divide-line">
                  {bt.periods.map((p) => (
                    <PeriodBlock key={`bt-${p.date}`} p={p} compact />
                  ))}
                </div>
              </details>
            </>
          )}
          <div className="border-t border-line px-3 py-2 text-[11px] leading-relaxed text-muted">
            {bt?.note ?? "事后重算，不能当对外战绩。"}
            另外涨停是用日 K 涨幅阈值近似的（主板 9.5% / 双创 19.5% / 北交所 29.5%），
            和真实涨停池会有几只出入，所以期数不等于涨停家数。
          </div>
        </Panel>

        <Panel title="这一页的规矩">
          <div className="flex flex-col gap-1.5 px-3 py-3 text-[11px] leading-relaxed text-muted">
            <div>· 落档之后不改。要改规则，就在新的一天改，历史留着当疤。</div>
            <div>· 盘中不落档。今天没收盘就落，等于不知道结局先写好答案。</div>
            <div>· 口径回算永远单独放、单独标。混进「落档战绩」就是拿事后聪明冒充当时判断。</div>
            <div>· 样本不足 20 期不给胜率评价，只给计数。</div>
          </div>
        </Panel>
      </div>
    </Frame>
  );
}

function Cell({ label, value, hint, good }: { label: string; value: string; hint?: string; good?: boolean }) {
  return (
    <div className="bg-surface px-3 py-2">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={"num text-lg font-medium " + (good ? "text-up" : "text-fg")}>{value}</div>
      {hint ? <div className="num text-[10px] text-muted">{hint}</div> : null}
    </div>
  );
}

/**
 * 挑中时的依据。两种来源的 volRatio 不是同一个量，**标签必须跟着来源变**，
 * 否则读者会把「封单 3.1 亿」读成「放量 3.1 倍」：
 *   - 落档（locked）：池子里没有成交量，用的是**封单额**（元）当替代排序键 → 显示「封单」
 *   - 回算（backtest）：K 线口径的**当日量 ÷ 前 5 日均量** → 显示「放量 x 倍」
 * 这一行是这一页的信用凭据：读者能拿它回当天盘面核一遍，看当时到底凭什么挑的。
 */
function basisText(source: ForecastPeriod["source"], b: { streak: number; volRatio: number }): string {
  const streak = `${b.streak}板`;
  if (source === "locked") {
    if (!b.volRatio) return streak;
    const yi = b.volRatio / 1e8;
    return `${streak} · 封单${yi >= 1 ? `${yi.toFixed(2)}亿` : `${Math.round(b.volRatio / 1e4)}万`}`;
  }
  return b.volRatio ? `${streak} · 放量${b.volRatio.toFixed(1)}倍` : streak;
}

function PeriodBlock({ p, compact }: { p: ForecastPeriod; compact?: boolean }) {
  const s = p.summary;
  const basisByCode = new Map(p.picks.map((x) => [x.code, x.basis]));
  return (
    <div className="px-3 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="num text-xs">
          <b className="text-fg">{p.date}</b>
          {p.nextDate ? <span className="text-muted"> → {p.nextDate}</span> : <span className="text-muted"> → 待次日收盘</span>}
        </span>
        <span className="flex items-center gap-2 text-[10px] text-muted">
          {p.source === "locked" ? (
            <Tag tone="muted">落档 {bjTime(p.lockedAt)}</Tag>
          ) : (
            <Tag tone="warn">事后重算</Tag>
          )}
          {s ? (
            <span>
              命中 {s.hits}/{s.n} · 追买 {s.chases}/{s.n} · 涨停 {s.limitUps}
            </span>
          ) : (
            <span>未结算</span>
          )}
        </span>
      </div>
      <div className="mt-1 flex flex-col gap-0.5">
        {(p.outcomes ?? p.picks.map((x) => ({ ...x, nextPct: null, nextHighPct: null, nextOpenToClose: null, limitUp: false, hit: false, chase: false }))).map(
          (o) => (
            <div key={o.code} className="flex items-baseline justify-between gap-2 text-[11px]">
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="truncate">{o.name}</span>
                <span className="shrink-0 text-[10px] text-muted">{o.rule}</span>
                {basisByCode.get(o.code) ? (
                  <span className="num shrink-0 text-[10px] text-muted">{basisText(p.source, basisByCode.get(o.code)!)}</span>
                ) : null}
              </span>
              <span className="num shrink-0">
                {o.nextPct == null ? (
                  <span className="text-muted">待回验</span>
                ) : (
                  <>
                    <span className={o.nextPct >= 0 ? "text-up" : "text-down"}>{pct(o.nextPct)}</span>
                    {o.limitUp ? <span className="ml-1 text-[10px] text-up">涨停</span> : null}
                    {!compact ? <span className="ml-1 text-[10px] text-muted">最高 {pct(o.nextHighPct)}</span> : null}
                  </>
                )}
              </span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
