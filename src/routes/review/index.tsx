/**
 * 这个文件是干什么的：
 * 「每日复盘」页。收盘后（或盘中）一页看完今天市场怎么样了：涨跌家数、
 * 指数、资金、快讯要点，再带上自己账本里今天的建仓和持仓表现。
 *
 * 你需要知道的：
 * 1. **这里全是规则拼装，不假装 AI**。每个数字都有出处（行情快照、资金接口、
 *    快讯流、自己的账本），学 Vibe-Research 的 daily-review 页的信息结构，
 *    但赤轨没有接入复盘大模型——写不出「AI 综合点评」，就只摆事实。
 * 2. 数据全部复用现有 server fn（getUniverse/getIndices/getFlow/getNews/
 *    getServerJournal），loader 里并发拉，拉不到的那块降级为空态带原因，
 *    不编造。
 * 3. 涨跌家数按 chg 的符号数（涨 > 0.001、跌 < -0.001，其余算平盘）；
 *    涨停跌停用 model.ts 的 limitTag（贴到板块涨跌停幅才算，留了 0.15 个点的缝）。
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { SectionTabs } from "@/components/section-tabs";
import { CollapsibleSection } from "@/components/collapsible";
import { StateBlock } from "@/components/state-block";
import { Panel, Stat, pctClass } from "@/components/terminal";
import { signedPct, fmtWan } from "@/lib/market/format";
import { readMarket } from "@/lib/market/flow";
import { journalTradeIds, marketBreadth, slimUniverse } from "@/lib/market/slim-universe";
import { shanghaiDate } from "@/lib/market/session";
import { getFlow, getIndices, getNews, getServerJournal, getUniverse } from "@/lib/market/quotes.functions";
import { getLpr, getMacro, getPmi, getSocialFinancing } from "@/lib/market/macro.functions";
import { TENOR_LABELS, pmiZone, twelveMonthChange } from "@/lib/market/macro";
import type { NewsItem, NewsTone } from "@/lib/market/news";

export const Route = createFileRoute("/review/")({
  loader: async () => {
    const [universe, indices, flow, news, journal, macro, pmi, lpr, social] = await Promise.all([
      getUniverse({ data: { refresh: false } }).catch(() => null),
      getIndices().catch(() => []),
      getFlow().catch(() => null),
      getNews().catch(() => [] as NewsItem[]),
      getServerJournal().catch(() => ({ days: [], personal: false, why: "读账本失败" })),
      getMacro().catch(() => null),
      getPmi().catch(() => null),
      getLpr().catch(() => null),
      getSocialFinancing().catch(() => null),
    ]);
    // 涨跌家数/涨跌停在全量快照上算完再下发；快照本身只留持仓相关的几只。
    // （全量 ~5300 只进 SSR HTML 有 1.2MB，手机端解析会卡死。）
    const breadth = marketBreadth(universe?.quotes ?? []);
    return {
      universe: slimUniverse(universe, journalTradeIds(journal)),
      breadth,
      indices, flow, news, journal, macro, pmi, lpr, social, date: shanghaiDate(),
    };
  },
  component: Review,
});

const TONE_TEXT: Record<NewsTone, { label: string; className: string }> = {
  good: { label: "利好", className: "text-up" },
  bad: { label: "利空", className: "text-down" },
  flat: { label: "未表态", className: "text-muted" },
};

function Review() {
  const { universe, breadth, indices, flow, news, journal, macro, pmi, lpr, social, date } = Route.useLoaderData();

  // 涨跌家数和涨跌停统计在 loader 里扫全量快照算好了（快照本身只带持仓相关的几只，
  // 见 slim-universe.ts）。快照不完整（partial/stale）时下面标明。
  const quotes = universe?.quotes ?? [];
  const { up, down, flat, limitUp, limitDown } = breadth;
  const known = up + down + flat;

  const tones = { good: 0, bad: 0, flat: 0 };
  for (const item of news) tones[item.tone] += 1;
  const headlines = news.slice(0, 8);

  // 账本：最新一天的建仓 + 所有未平仓的今日表现。拿不到就空态带原因。
  const days = journal.days;
  const latestDay = days[0] ?? null;
  const openTrades = days.flatMap((day) => day.trades.filter((trade) => trade.exit == null));
  const liveById = new Map(quotes.map((quote) => [quote.id, quote]));
  const openWithChg = openTrades
    .map((trade) => ({ trade, chg: liveById.get(trade.id)?.chg ?? null }))
    .filter((row): row is { trade: (typeof openTrades)[number]; chg: number } => row.chg != null);
  const avgOpenChg =
    openWithChg.length === 0
      ? null
      : openWithChg.reduce((sum, row) => sum + row.chg, 0) / openWithChg.length;

  const hs300 = indices.find((index) => index.name.includes("沪深300")) ?? null;
  const marketLines = flow ? readMarket(flow.market) : [];

  return (
    <Frame
      aside={
        <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted">
          <span className="text-fg">每日复盘</span>
          <span className="tabular-nums">{date}</span>
          {universe ? (
            <span>
              快照 {new Date(universe.asOf).toLocaleTimeString("zh-CN", { hour12: false })}
              {universe.stale ? " · 已过期" : ""}
              {universe.partial ? " · 不完整" : ""}
            </span>
          ) : (
            <span>行情快照拉不到</span>
          )}
        </div>
      }
    >
      {/* 2026-10-21 整合：复盘和信号同属「复盘」区（/review 下两个子页面），
          顶部给二级 tab，和信号子页是同一组。 */}
      <SectionTabs
        ariaLabel="复盘"
        tabs={[
          { to: "/review/", label: "每日复盘" },
          { to: "/review/signals", label: "信号" },
        ]}
      />
      <div className="flex flex-col gap-3">
        {/* 第一屏：今天市场偏多头还是偏空头。红涨绿跌，家数比点位更诚实（指数会被权重股绑架）。 */}
        <Panel
          title="涨跌家数"
          note={known > 0 ? <span>全市场 {quotes.length} 只里有行情的 {known} 只</span> : undefined}
          bodyClassName="grid grid-cols-2 gap-px bg-line sm:grid-cols-4"
        >
          <Stat label="上涨" value={known === 0 ? "—" : String(up)} className="bg-surface text-up" />
          <Stat label="下跌" value={known === 0 ? "—" : String(down)} className="bg-surface text-down" />
          <Stat label="涨停" value={String(limitUp)} className="bg-surface" hint="贴到板块涨跌停幅" />
          <Stat label="跌停" value={String(limitDown)} className="bg-surface" />
        </Panel>
        {known > 0 ? (
          <div className="flex h-2 overflow-hidden rounded bg-surface-2" aria-label="涨跌分布条">
            <span className="bg-up" style={{ width: `${(up / known) * 100}%` }} />
            <span className="bg-line" style={{ width: `${(flat / known) * 100}%` }} />
            <span className="bg-down" style={{ width: `${(down / known) * 100}%` }} />
          </div>
        ) : null}

        {indices.length > 0 ? (
          <Panel title="指数" bodyClassName="grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
            {indices.map((index) => (
              <Stat
                key={index.id}
                label={index.name}
                value={signedPct(index.pct)}
                tone={pctClass(index.pct)}
                className="bg-surface"
              />
            ))}
          </Panel>
        ) : (
          <Panel title="指数">
            <StateBlock kind="empty" title="指数暂时拉不到" hint="刷新重试；不复盘指数也要看家数。" />
          </Panel>
        )}

        {flow ? (
          <Panel
            title="资金"
            note={
              <span>
                主力净额 · {new Date(flow.asOf).toLocaleTimeString("zh-CN", { hour12: false })}
              </span>
            }
            bodyClassName="grid grid-cols-2 gap-px bg-line"
          >
            {flow.market.map((part) => (
              <Stat
                key={part.name}
                label={`${part.name}主力`}
                value={fmtWan(part.main)}
                tone={part.main > 0 ? "text-up" : part.main < 0 ? "text-down" : undefined}
                className="bg-surface"
                hint={`超大 ${fmtWan(part.super)} · 大单 ${fmtWan(part.big)}`}
              />
            ))}
          </Panel>
        ) : (
          <Panel title="资金">
            <StateBlock kind="empty" title="资金数据暂时拉不到" hint="东财资金接口超时或限流，刷新重试。" />
          </Panel>
        )}
        {/* 宏观是月频慢数据，和每日复盘节奏不同——默认折起来，要看出处再点开。
            2026-10-16 页面整理：慢数据不和每日数据混在同一屏。 */}
        <CollapsibleSection
          storageKey="ch-collapse-review-macro"
          defaultOpen={false}
          headerClassName="bg-surface-2"
          header={
            <>
              <h2 className="text-sm font-medium">宏观水温（月频慢数据）</h2>
              <p className="text-xs text-muted">国债收益率 · PMI · LPR · 社融 —— 不天天变，点开看</p>
            </>
          }
        >
          <div className="flex flex-col gap-3 px-3.5 py-3">
            <MacroPanel macro={macro} pmi={pmi} lpr={lpr} social={social} />
          </div>
        </CollapsibleSection>

        {marketLines.length > 0 ? (
          <ul className="flex flex-col gap-1 rounded border border-line bg-surface px-3.5 py-2 text-xs leading-relaxed text-muted">
            {marketLines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}

        <Panel
          title="快讯要点"
          note={<span>今天 {news.length} 条 · 利好 {tones.good} · 利空 {tones.bad}</span>}
        >
          {headlines.length === 0 ? (
            <StateBlock kind="empty" title="今天还没有快讯" hint="盘中大约一分钟更新一次。" />
          ) : (
            <ul>
              {headlines.map((item) => (
                <li key={item.id} className="border-b border-line px-3.5 py-2 last:border-0">
                  <div className="flex items-baseline justify-between gap-3 text-xs text-muted">
                    <span className={TONE_TEXT[item.tone].className}>{TONE_TEXT[item.tone].label}</span>
                    <span className="tabular-nums">{item.time.slice(5, 16)}</span>
                  </div>
                  <p className="mt-0.5 text-sm">{item.title}</p>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="我的账本今天"
          note={latestDay ? <span>最新建仓日 {latestDay.date}</span> : undefined}
        >
          {journal.days.length === 0 ? (
            <StateBlock
              kind="empty"
              title="今天没有建仓记录"
              hint={journal.why ?? "策略打到买入价才记一笔；有持仓时这里会带上它们今天的表现。"}
            />
          ) : (
            <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
              <Stat
                label="最新一天建仓"
                value={latestDay ? `${latestDay.trades.length} 笔` : "—"}
                className="bg-surface"
                hint={latestDay?.signalTime}
              />
              <Stat label="当前在拿" value={`${openTrades.length} 只`} className="bg-surface" />
              <Stat
                label="持仓今日均值"
                value={avgOpenChg == null ? "—" : signedPct(avgOpenChg)}
                tone={pctClass(avgOpenChg)}
                className="bg-surface"
                hint={openWithChg.length > 0 ? `${openWithChg.length} 只取到行情` : "拿不到现价"}
              />
              <Stat
                label="沪深300 今日"
                value={hs300 ? signedPct(hs300.pct) : "—"}
                tone={hs300 ? pctClass(hs300.pct) : undefined}
                className="bg-surface"
                hint="持仓均值跑赢它才算真赚"
              />
            </div>
          )}
          {journal.days.length > 0 ? (
            <p className="border-t border-line px-3 py-2 text-xs leading-relaxed text-muted">
              明细在 <Link to="/strategies/positions" className="text-brand hover:underline">策略追踪</Link>。
              这里只做日内对照，不改任何账。
            </p>
          ) : null}
        </Panel>

        <p className="px-1 text-xs leading-relaxed text-muted">
          这一页是规则拼装的盘面事实：家数来自行情快照、资金来自东财、快讯按标题用词分态度。
          赤轨没有接入复盘大模型，写不出「AI 综合点评」——摆出事实，判断留给你。
        </p>
      </div>
    </Frame>
  );
}


/**
 * 宏观水温：中债国债收益率曲线。
 *
 * **只摆事实不下判断**——10 年国债往下走通常被读成"钱变便宜"，但那是对未来的
 * 预期，不是已经发生的事。这里给数字和截至日期，判断留给读的人。
 *
 * 口径三条（都写在页面上）：
 * 1. 单位是 %，1.6516 = 1.6516%
 * 2. **数据截至哪天不一定是今天**——中债不公布债券市场交易日历，也不给总条数，
 *    所以「某天没数据」分不清是节假日还是接口坏了，只报截至日期
 * 3. 拿不到就显示「没拿到」，不显示全 0（0% 会被读成「收益率 0」）
 */
function MacroPanel({
  macro,
  pmi,
  lpr,
  social,
}: {
  macro: Awaited<ReturnType<typeof getMacro>> | null;
  pmi: Awaited<ReturnType<typeof getPmi>> | null;
  lpr: Awaited<ReturnType<typeof getLpr>> | null;
  social: Awaited<ReturnType<typeof getSocialFinancing>> | null;
}) {
  if (!macro) {
    return (
      <Panel title="宏观水温（10 年国债）" note="没拉到">
        <StateBlock kind="empty" title="中债没拉到" hint="中央结算公司接口没响应，刷新重试。" />
      </Panel>
    );
  }
  if (!macro.snapshot) {
    return (
      <Panel title="宏观水温（10 年国债）" note={macro.why ?? "没数据"}>
        <StateBlock kind="empty" title="没取到收益率曲线" hint={macro.why ?? "中债返回了空"} />
      </Panel>
    );
  }
  const s = macro.snapshot;
  const order = ["3m", "6m", "1y", "3y", "5y", "7y", "10y", "30y"];
  return (
    <>
    <Panel title="宏观水温（中债国债收益率）" note={`数据截至 ${s.date} · 官方源`}>
      <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
        <Stat
          label="10 年国债"
          value={s.tenors["10y"] == null ? "—" : `${s.tenors["10y"]}%`}
          hint="市场的水温"
          className="bg-surface"
        />
        <Stat
          label="10y − 1y"
          value={s.slope10y1y == null ? "—" : `${s.slope10y1y > 0 ? "+" : ""}${s.slope10y1y} pp`}
          hint="曲线陡不陡"
          className="bg-surface"
        />
        <Stat
          label="30y − 10y"
          value={s.slope30y10y == null ? "—" : `${s.slope30y10y > 0 ? "+" : ""}${s.slope30y10y} pp`}
          hint="超长端溢价"
          className="bg-surface"
        />
        <Stat label="覆盖交易日" value={s.days} hint={`近 ${macro.points.length} 天有数据`} className="bg-surface" />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3.5 py-2 text-xs text-muted">
        {order.map((k) => (
          <span key={k}>
            {TENOR_LABELS[k]} {s.tenors[k] == null ? "—" : `${s.tenors[k]}%`}
          </span>
        ))}
      </div>
      <p className="px-3.5 pb-2 text-[11px] text-muted">
        只摆数字不下判断——收益率往下走常被读成「钱变便宜」，那是对未来的预期，不是已经发生的事。
        中债不公布债券市场交易日历，所以数据截至日不一定是今天（节假日正常）。
      </p>
    </Panel>
    <SocialFinancingPanel social={social} />
    <PmiPanel pmi={pmi} />
    <LprPanel lpr={lpr} />
    </>
  );
}

/** PMI（月频，国家统计局）。50 是荣枯线。 */
function PmiPanel({ pmi }: { pmi: Awaited<ReturnType<typeof getPmi>> | null }) {
  if (!pmi?.pmi) {
    return (
      <Panel title="制造业 PMI" note={pmi?.why ?? "没拉到"}>
        <StateBlock kind="empty" title="PMI 没拿到" hint={pmi?.why ?? "统计局没响应，刷新重试。"} />
      </Panel>
    );
  }
  const p = pmi.pmi;
  const zone = pmiZone(p.manufacturing);
  const zoneText = zone === "expansion" ? "扩张区间" : zone === "contraction" ? "收缩区间" : "刚好在荣枯线";
  return (
    <Panel title="制造业 PMI（国家统计局）" note={`${p.month ?? "月份未知"} · 月频`}>
      <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
        <Stat
          label="制造业 PMI"
          value={p.manufacturing ?? "—"}
          hint={zoneText}
          tone={(p.manufacturing ?? 50) >= 50 ? "text-up" : "text-down"}
          className="bg-surface"
        />
        <Stat label="非制造业" value={p.nonManufacturing ?? "—"} hint="商务活动指数" className="bg-surface" />
        <Stat label="综合产出" value={p.composite ?? "—"} hint="PMI 产出指数" className="bg-surface" />
        <Stat
          label="大 / 中 / 小"
          value={`${p.large ?? "—"} / ${p.medium ?? "—"} / ${p.small ?? "—"}`}
          hint="分企业规模"
          className="bg-surface"
        />
      </div>
      <p className="px-3.5 pb-2 text-[11px] text-muted">
        50 是荣枯线，制造业 PMI 在它上方叫扩张、下方叫收缩。**月频数据，月末发布**，
        比财报早一个季度反映景气。分档字段（大小企业）统计局改过措辞，认不出就显示「—」。
      </p>
    </Panel>
  );
}

/** LPR（月频，东财）。2019-08 改革后每月 20 日报价。 */
function LprPanel({ lpr }: { lpr: Awaited<ReturnType<typeof getLpr>> | null }) {
  if (!lpr?.lpr) {
    return (
      <Panel title="LPR 贷款市场报价利率" note={lpr?.why ?? "没拉到"}>
        <StateBlock kind="empty" title="LPR 没拿到" hint={lpr?.why ?? "东财没响应，刷新重试。"} />
      </Panel>
    );
  }
  const p = lpr.lpr;
  return (
    <Panel title="LPR 贷款市场报价利率" note={`${p.date} 报价 · 月频`}>
      <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
        <Stat label="1 年期 LPR" value={p.lpr1y == null ? "—" : `${p.lpr1y}%`} hint="短期贷款基准" className="bg-surface" />
        <Stat label="5 年期以上" value={p.lpr5y == null ? "—" : `${p.lpr5y}%`} hint="长期贷款基准" className="bg-surface" />
        <Stat label="历史条数" value={lpr.history.length} hint="2019-08 改革后" className="bg-surface" />
        <Stat
          label="5y − 1y"
          value={p.lpr5y == null || p.lpr1y == null ? "—" : `${(p.lpr5y - p.lpr1y).toFixed(2)} pp`}
          hint="期限利差"
          className="bg-surface"
        />
      </div>
      <p className="px-3.5 pb-2 text-[11px] text-muted">
        月频，2019-08 改革后每月 20 日报价。**直接相关的是银行和地产**——降息先压银行息差、
        再影响地产融资成本。历史上还有旧贷款基准利率（1991-2015），那些不是 LPR，已经剔掉。
      </p>
    </Panel>
  );
}


/** 社会融资规模（人民银行，月频，领先指标）。 */
function SocialFinancingPanel({ social }: { social: Awaited<ReturnType<typeof getSocialFinancing>> | null }) {
  if (!social?.file) {
    return (
      <Panel title="社会融资规模（社融）" note="没数据">
        <StateBlock kind="empty" title="社融还没抓过" hint={social?.why ?? "跑一次 python3 scripts/fetch-social-financing.py"} />
      </Panel>
    );
  }
  const rows = social.file.rows;
  const last = rows[rows.length - 1]!;
  const sum12 = twelveMonthChange(rows, "afreTotal");
  const loan12 = twelveMonthChange(rows, "rmbLoans");
  const fmt = (v: number | null): string => (v == null ? "—" : `${v.toLocaleString("zh-CN")} 亿`);
  return (
    <Panel
      title="社会融资规模（人民银行 · 领先指标）"
      note={`${last.month} · ${rows.length} 个月 · 抓于 ${social.file.fetchedAt.slice(0, 10)}`}
    >
      <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
        <Stat
          label="当月社融增量"
          value={fmt(last.afreTotal)}
          hint={`${last.month}`}
          tone={(last.afreTotal ?? 0) >= 0 ? "text-up" : "text-down"}
          className="bg-surface"
        />
        <Stat
          label="近 12 个月累计"
          value={fmt(sum12)}
          hint="社融增量滚动合计"
          tone={(sum12 ?? 0) >= 0 ? "text-up" : "text-down"}
          className="bg-surface"
        />
        <Stat label="当月人民币贷款" value={fmt(last.rmbLoans)} hint="社融的主要构成" className="bg-surface" />
        <Stat label="近 12 月贷款" value={fmt(loan12)} hint="贷款滚动合计" className="bg-surface" />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3.5 py-2 text-xs text-muted">
        <span>当月构成：</span>
        <span>政府债 {fmt(last.governmentBonds)}</span>
        <span>企业债 {fmt(last.corporateBonds)}</span>
        <span>未贴现银票 {fmt(last.bankersAcceptance)}</span>
        <span>股票融资 {fmt(last.equityFinancing)}</span>
      </div>
      <p className="px-3.5 pb-2 text-[11px] text-muted">
        社融是<strong>增量</strong>（当月新投放的规模），单月数字噪声大，所以更该看 12 个月累计。
        单位亿元人民币，按源原样没做换算。<strong>月频，次月中旬发布</strong>——
        它比 PMI 更前瞻，也比财报早一个季度。数据由脚本从人民银行官网抓（零依赖手写
        xlsx 解析），页面只读落盘文件。
      </p>
    </Panel>
  );
}
