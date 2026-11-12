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
import { SectionTabs, REVIEW_TABS } from "@/components/section-tabs";
import { HeroStat } from "@/components/hero-stat";
import { Activity, Coins, LineChart, Wallet } from "lucide-react";
import { CollapsibleSection } from "@/components/collapsible";
import { StateBlock } from "@/components/state-block";
import { Panel, Stat, pctClass } from "@/components/terminal";
import { signedPct } from "@/lib/market/format";
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
  const shIdx = indices.find((index) => index.name.includes("上证")) ?? null;
  // 今日结论（效果图）：四张卡全部现算。历史对照（较昨日）没有存档口径，
  // 不编——拿不到就是拿不到，副行写口径不写增量。
  const netUp = known > 0 ? up - down : null;
  const hs300Rel = hs300 && shIdx ? hs300.pct - shIdx.pct : null;
  const mainTotal = flow ? flow.market.reduce((s, m) => s + m.main, 0) : null;
  const myRel = avgOpenChg != null && hs300 ? avgOpenChg - hs300.pct : null;
  const relWord = (v: number, goodWhenPositive = true) =>
    (v > 0 ? (goodWhenPositive ? "跑赢 " : "跑输 ") : v < 0 ? (goodWhenPositive ? "跑输 " : "跑赢 ") : "") + Math.abs(v).toFixed(2) + "%";

  return (
    <Frame wide
      status={{
        label: "今日",
        // **真实数据**：breadth 的涨跌家数。拿不到快照就是 null
        //（页头少一个药丸，不拿 0 顶替"不知道"）。
        value: breadth ? `涨 ${breadth.up} 跌 ${breadth.down}` : null,
        tone: breadth ? (breadth.up > breadth.down ? "ok" : "warn") : "neutral",
      }}
      ornamentContent={
        indices && indices.length > 0 ? (
          <span className="text-[11px] tabular-nums">
            {indices[0]!.name} {indices[0]!.pct != null ? `${indices[0]!.pct > 0 ? "+" : ""}${indices[0]!.pct.toFixed(2)}%` : "—"}
          </span>
        ) : (
          <span className="text-[11px]">指数快照暂不可用</span>
        )
      }
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
        tabs={REVIEW_TABS}
      />
      {/* 今日结论（效果图招牌件）：四张卡，数字全现算 */}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <HeroStat
          icon={<Activity size={18} />}
          label="市场广度"
          value={netUp != null ? `${netUp > 0 ? "+" : ""}${netUp}` : "—"}
          valueTone={netUp == null ? undefined : netUp >= 0 ? "up" : "down"}
          tone={netUp == null ? "muted" : netUp >= 0 ? "ok" : "warn"}
          sub={known > 0 ? `涨 ${up} 跌 ${down} · 上涨占比 ${((up / known) * 100).toFixed(1)}%` : "快照暂不可用"}
        />
        <HeroStat
          icon={<LineChart size={18} />}
          label="沪深300 相对表现"
          value={hs300Rel != null ? `${hs300Rel > 0 ? "+" : ""}${hs300Rel.toFixed(2)}%` : "—"}
          valueTone={hs300Rel == null ? undefined : hs300Rel >= 0 ? "up" : "down"}
          tone={hs300Rel == null ? "muted" : hs300Rel >= 0 ? "ok" : "warn"}
          sub={hs300 && shIdx ? `沪深300 ${hs300.pct > 0 ? "+" : ""}${hs300.pct.toFixed(2)}% vs 上证 ${shIdx.pct > 0 ? "+" : ""}${shIdx.pct.toFixed(2)}%` : "对照指数暂缺"}
        />
        <HeroStat
          icon={<Coins size={18} />}
          label="两市资金"
          value={mainTotal != null ? `${mainTotal > 0 ? "+" : ""}${(mainTotal / 1e4).toFixed(1)} 亿` : "—"}
          valueTone={mainTotal == null ? undefined : mainTotal >= 0 ? "up" : "down"}
          tone={mainTotal == null ? "muted" : mainTotal >= 0 ? "ok" : "warn"}
          sub="主力净额（超大单 + 大单），口径见资金面板"
        />
        <HeroStat
          icon={<Wallet size={18} />}
          label="我的持仓相对表现"
          value={myRel != null ? `${myRel > 0 ? "+" : ""}${myRel.toFixed(2)}%` : "—"}
          valueTone={myRel == null ? undefined : myRel >= 0 ? "up" : "down"}
          tone={myRel == null ? "muted" : myRel >= 0 ? "ok" : "warn"}
          sub={
            avgOpenChg != null && hs300
              ? `未平仓均 ${avgOpenChg > 0 ? "+" : ""}${avgOpenChg.toFixed(2)}% · ${relWord(myRel!)}大盘`
              : "未平仓或对照暂缺"
          }
        />
      </div>
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

        {/* 2026-11-11 晚去重：这里原本还有「指数」和「资金」两个 Panel，
            指数四格和首页/资金流向页是同一份行情、资金六格是 /flow 概览
            「大盘资金」的缩小版——同一批数在一页里摆三遍（HeroStat 的
            「两市资金」已经给了全市场主力净额）。复盘页只留结论数字，
            明细交给各自的专页。 */}
        <Link
          to="/flow"
          className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded border border-line bg-surface px-3.5 py-2 text-xs hover:bg-surface-2"
        >
          <span className="text-muted">
            资金：分市场主力净额、北向、行业与个股榜单、两融、期指
          </span>
          <span className="text-brand">去资金流向 →</span>
        </Link>
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
          指数明细在首页与资金流向页，资金分项也在那边，这里不摆第二遍。
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
        <StateBlock kind="empty" title="社融还没抓过" hint={social?.why ?? "社融数据还没生成，抓到后这里会显示曲线和同比。"} />
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
