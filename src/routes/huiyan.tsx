/**
 * 前瞻回验（/huiyan）——**这个页面是赤轨的自证，也是它最容易说谎的地方**。
 *
 * 两件必须分清、绝不混算的事：
 * ① **落档**：每天收盘后按固定规则挑 3 只，写进文件并记下 lockedAt。
 *    落档之后不许改。次日收盘自动结算。这是「当时说了什么」的唯一凭据。
 * ② **口径回算**：拿同一套规则在过去 60 个交易日重跑一遍。
 *    它不是当时发出去的清单，**不能当对外战绩**，所以单独一块、灰色、标题就写明。
 *
 * 结算口径（写死在页面上，不只写在代码里）：
 *   选股 T 日收盘 → 买入 T+1 开盘（最早能成交的价）→ 结算 T+1 收盘。
 *   三个价都是盘后才知道的，不含未来函数。命中率必须跟全市场基准比。
 *
 * 这个页面最该解决的，是「你到底是什么时候买的」——所以每期都把
 * 「选股日 → 买入日(开盘) → 结算日(收盘)」三段时间线摆出来，
 * 每票再给选股价 / 买入价 / 结算价三个实打实的 ¥。
 */

import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Panel, Tag } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { getForecast, type ForecastPeriod, type ForecastOutcome, type ForecastLiveRow } from "@/lib/market/archive.functions";
import { PixelHeader } from "@/components/pixel-header";

export const Route = createFileRoute("/huiyan")({
  loader: async () => await getForecast(),
  component: HuiyanPage,
});

const pct = (v: number | null | undefined, d = 2) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`);
const money = (v: number | null | undefined) => (v == null ? "—" : v.toFixed(2));
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
        <PixelHeader
          label="FORWARD_TEST"
          meta={`落档 ${locked.length} 期 · 可结算 ${settled.length} 期 · 口径回算 ${bt?.periods.length ?? 0} 期`}
        />

        {/* 最近一期三票对照：选股 → 今开 → 现价，一眼看出哪笔真成交了 */}
        {locked[0] ? (
          <div className="px-mod4 border border-line bg-surface px-4 py-3">
            <div className="px-num mb-2 text-[12px] tracking-widest text-brand">LAST_CALL · {locked[0].date}</div>
            <div className="flex flex-col gap-1.5">
              {locked[0].picks.map((k) => {
                const lr = (locked[0].live?.rows ?? []).find((x) => x.code === k.code);
                const noBuy = lr?.buyFilled === false;
                return (
                  <div key={k.code} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-dashed border-line py-1.5 last:border-0">
                    <span className={"w-24 shrink-0 truncate text-[13px] font-medium " + (noBuy ? "text-muted line-through" : "")}>{k.name}</span>
                    <span className="px-num text-[12px] text-muted">选股 {k.basis.close}</span>
                    <span className="px-num text-[12px] text-muted">→ 今开 {lr?.buyPrice ?? "—"}</span>
                    <span className={"px-num text-[12px] " + (lr?.pctFromBuy != null && lr.pctFromBuy >= 0 ? "text-up" : "text-down")}>
                      → 现 {(lr?.last ?? "—")}{lr?.pctFromBuy != null ? ` (${(lr.pctFromBuy * 100).toFixed(2)}%)` : ""}
                    </span>
                    <span className={"px-st ml-auto " + (noBuy ? "no" : lr?.buyPrice != null ? "ok" : "wait")}>
                      {noBuy ? "一字板·买不进" : lr?.buyPrice != null ? "已成交" : "待开盘"}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        <Panel
          title="落档战绩"
          note={<span className="text-[11px]">只算真的当晚落过档的期，口径回算不混进来</span>}
        >
          <div className="grid grid-cols-2 gap-px overflow-hidden border-b border-line bg-line sm:grid-cols-4">
            <Cell label="可结算期数" value={`${settled.length}`} hint={`共落档 ${locked.length} 期`} />
            <Cell
              label="方向命中"
              value={picks ? rate(hits, picks) : "—"}
              hint={`${hits}/${picks} 笔 · T日收盘→T+1收盘涨`}
            />
            <Cell label="追买成立" value={picks ? rate(chases, picks) : "—"} hint={`${chases}/${picks} 笔`} />
            <Cell label="次日涨停" value={picks ? rate(lim, picks) : "—"} hint={`${lim}/${picks} 笔`} />
          </div>
          {(() => {
            const unfilled = settled.reduce((n, p) => n + (p.summary?.unfilled ?? 0), 0);
            const stuck = settled.reduce((n, p) => n + (p.summary?.stuck ?? 0), 0);
            if (unfilled === 0 && stuck === 0) return null;
            return (
              <div className="border-b border-line bg-surface-2 px-3 py-2 text-[11px] leading-relaxed">
                <b className="text-warn">成交不了的不算进胜率：</b>
                {unfilled > 0 ? <>一字涨停买不进 {unfilled} 笔（没买到就没有这笔）。</> : null}
                {stuck > 0 ? <>一字跌停卖不出 {stuck} 笔（买到了但砸在手里，不计入已完成盈亏）。</> : null}
              </div>
            );
          })()}
          <div className="px-3 py-2 text-[11px] leading-relaxed text-muted">
            {settled.length === 0 ? (
              <>
                还没有可结算的期。最新一期（{locked[0]?.date ?? "—"}）挑完锁档后，
                <b className="text-fg">下一个交易日收盘</b>才会出第一条对照。在这之前这一栏空着——空着比填个历史回算的数字诚实。
                <div className="mt-1">
                  但「买入」这件事今天已经发生了：下面「逐期对照」里能看到{" "}
                  <b className="text-fg">今日开盘的实际买入价</b>和盘中浮动。
                </div>
              </>
            ) : settled.length < 20 ? (
              <>
                只有 {settled.length} 期，样本不足，别拿这几个数当胜率。
                低于 20 期我按纪律只给计数、不给「能力」的评价。
              </>
            ) : null}
          </div>
        </Panel>

        <Panel
          title="逐期对照"
          note={<span className="text-[11px]">每期 3 只 · 按规则挑 · 挑完锁档</span>}
        >
          <div className="border-b border-line bg-surface-2 px-3 py-2 text-[11px] leading-relaxed text-muted">
            结算时间线（写死，不含未来函数）：<b className="text-fg">选股 T 日收盘</b> →{" "}
            <b className="text-fg">买入 T+1 开盘</b>（最早能成交的价）→ <b className="text-fg">结算 T+1 收盘</b>。
            每期下面都把这三天摆出来，你一眼就能看到「我是哪天、什么价买的」。
          </div>
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
              {(() => {
                const un = bt.periods.reduce((n, x) => n + (x.summary?.unfilled ?? 0), 0);
                const st = bt.periods.reduce((n, x) => n + (x.summary?.stuck ?? 0), 0);
                if (un === 0 && st === 0) return null;
                const raw = btPicks + un;
                return (
                  <div className="border-b border-line bg-surface-2 px-3 py-2 text-[11px] leading-relaxed">
                    <b className="text-warn">先扣掉成交不了的：</b>
                    {raw} 笔里 <b className="text-fg">{un}</b> 笔是一字涨停买不进（
                    {((un / raw) * 100).toFixed(1)}%），已从样本剔除
                    {st > 0 ? <>；另有 {st} 笔一字跌停卖不出</> : null}。
                    买不到的恰好是最强的那批——这套规则的真实成绩只会更弱，不会更好。
                  </div>
                );
              })()}
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
  const settled = Boolean(s && s.n > 0);
  const live = settled ? undefined : p.live;
  const basisByCode = new Map(p.picks.map((x) => [x.code, x.basis]));
  const liveByCode = new Map((live?.rows ?? []).map((x) => [x.code, x]));
  // 已结算：用 outcomes 渲染；未结算：用 picks 渲染（只拿得到选股时的收盘价）
  const rows: {
    code: string;
    name: string;
    rule: string;
    basis?: { streak: number; volRatio: number; close: number };
    o?: ForecastOutcome;
    lr?: ForecastLiveRow;
  }[] = settled
    ? (p.outcomes ?? []).map((o) => ({
        code: o.code,
        name: o.name,
        rule: o.rule,
        basis: basisByCode.get(o.code),
        o,
      }))
    : p.picks.map((x) => ({ code: x.code, name: x.name, rule: x.rule, basis: x.basis, lr: liveByCode.get(x.code) }));

  /**
   * 买入日的时间线。三种状态必须分清，不能糊成一个「待定」：
   *   ① 已结算 → 写买入日 + 结算完
   *   ② 买入日已开盘（live 有买入价）→ 写「今天开盘买」，并标截至几点
   *   ③ 还没开盘 / 数据没到 → 待定
   */
  const boughtAny = (live?.rows ?? []).some((r) => r.buyPrice != null);

  return (
    <div className="px-3 py-2">
      {/* 三段时间线：一眼看到买入发生在哪天 */}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="num text-xs">
          <b className="text-fg">{p.date}</b>
          <span className="text-muted"> 收盘挑</span>
          <span className="text-muted"> → </span>
          <b className="text-fg">{p.nextDate ?? "待定"}</b>
          <span className="text-muted"> 开盘买 / 收盘结</span>
        </span>
        <span className="flex items-center gap-2 text-[10px] text-muted">
          {p.source === "locked" ? (
            <Tag tone="muted">落档 {bjTime(p.lockedAt)}</Tag>
          ) : (
            <Tag tone="warn">事后重算</Tag>
          )}
          {settled ? (
            <span>
              命中 {s!.hits}/{s!.n} · 追买 {s!.chases}/{s!.n} · 涨停 {s!.limitUps}
            </span>
          ) : boughtAny ? (
            <span className="text-up">
              今日已开盘买入 · 盘中截至 {bjTime(live?.asOf).slice(11)}
            </span>
          ) : (
            <Tag tone="muted">待 T+1 收盘结算</Tag>
          )}
        </span>
      </div>

      <div className="mt-1.5 flex flex-col gap-1.5">
        {rows.map((r) => (
          <PickRow
            key={r.code}
            code={r.code}
            name={r.name}
            rule={r.rule}
            basisText={r.basis ? basisText(p.source, r.basis) : ""}
            o={r.o}
            lr={r.lr}
            pickPrice={r.basis?.close ?? null}
            compact={compact}
          />
        ))}
      </div>
    </div>
  );
}

function PickRow({
  code: _code,
  name,
  rule,
  basisText,
  o,
  lr,
  pickPrice,
  compact,
}: {
  code: string;
  name: string;
  rule: string;
  basisText: string;
  o?: ForecastOutcome;
  lr?: ForecastLiveRow;
  pickPrice: number | null;
  compact?: boolean;
}) {
  const settled = Boolean(o);
  const trade = o?.tradePct ?? null;
  // 一字涨停买不进 / 一字跌停卖不出：这种情况不算「有这一笔」，价格一律打折看
  const buyFail = settled ? o?.buyFilled === false : lr?.buyFilled === false;
  const sellFail = settled ? o?.sellFilled === false : false;
  const tradeable = !buyFail && !sellFail;
  // 今日已开盘＝真实的买入价已经发生，只是还没到收盘结算。这一格不许显示「待结算」。
  const bought = !settled && lr?.buyPrice != null && !buyFail;
  const livePct = bought ? (lr?.pctFromBuy ?? null) : null;
  const shown = tradeable ? (settled ? trade : livePct) : null;
  const fillNote = settled ? (o?.fillNote ?? null) : (lr?.fillNote ?? null);
  const failLabel = buyFail ? "买不进" : sellFail ? "卖不出" : null;
  return (
    <div className="rounded border border-line bg-surface px-2 py-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-[12px] font-medium">{name}</span>
          <span className="shrink-0 text-[10px] text-muted">{rule}</span>
          {basisText ? <span className="num shrink-0 text-[10px] text-muted">{basisText}</span> : null}
        </span>
        {/* 已结算＝真实交易盈亏；已开盘未收盘＝相对开盘买入价的浮动；都没有才叫待结算 */}
        <span
          className={
            "num shrink-0 text-[12px] font-medium " +
            (shown == null ? "text-muted" : shown >= 0 ? "text-up" : "text-down")
          }
        >
          {failLabel ?? (settled ? pct(trade) : bought ? pct(livePct) : "待结算")}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 num text-[11px] text-muted">
        <span>
          选股 <b className="text-fg">{money(settled ? o!.pickPrice : pickPrice)}</b>
        </span>
        <span className="text-muted">→</span>
        <span>
          买入{" "}
          <b className={buyFail ? "text-muted line-through" : "text-fg"}>
            {money(settled ? (o?.buyPrice ?? null) : (lr?.buyPrice ?? null))}
          </b>
          {settled && !compact && !buyFail ? <span className="ml-0.5 text-[10px]">T+1开</span> : null}
          {bought ? <span className="ml-0.5 text-[10px] text-up">今开</span> : null}
          {buyFail ? <span className="ml-0.5 text-[10px] text-warn">一字板·排不进</span> : null}
        </span>
        <span className="text-muted">→</span>
        <span>
          {settled ? "结算" : "现价"}{" "}
          <b className="text-fg">{money(settled ? (o?.sellPrice ?? null) : (lr?.last ?? null))}</b>
          {settled && !compact ? <span className="ml-0.5 text-[10px]">T+1收</span> : null}
          {bought && lr?.high != null ? (
            <span className="ml-1 text-[10px]">
              高 {money(lr.high)} / 低 {money(lr.low)}
            </span>
          ) : null}
        </span>
        {o?.limitUp ? <Tag tone="up">涨停</Tag> : null}
        {o?.chase ? <Tag tone="muted">追买成立</Tag> : null}
        {bought && lr?.last != null && lr.high != null && lr.buyPrice != null && lr.high > lr.buyPrice ? (
          <Tag tone="muted">盘中摸高</Tag>
        ) : null}
        {sellFail ? <Tag tone="warn">一字跌停·卖不出</Tag> : null}
      </div>
      {fillNote ? <div className="mt-0.5 text-[10px] leading-snug text-muted">{fillNote}</div> : null}
    </div>
  );
}
