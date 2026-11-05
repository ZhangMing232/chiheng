/**
 * 这个文件是干什么的：
 * 「系统导览」——一页白话讲清赤轨是什么、每天自动发生什么、每个页面看什么。
 *
 * 你需要知道的：
 * - 这一页是给「隔几周回来看的人」的第一个落点：不堆数据，只讲结构和读法。
 * - 所有解释和 glossary.ts 同源（用 <Term> 术语卡），两处不会各说各话。
 * - 口径纪律照旧：铁律、时间线全部来自代码事实，不编「应有尽有」的流程。
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import { Frame } from "@/components/screener/nav";
import { Panel, Tag } from "@/components/terminal";
import { Term } from "@/components/term";

/** 每天的自动节奏（时间来自 scripts/record-journal.ts 的调度注释，不编）。 */
const TIMELINE: { time: string; what: string; note: string }[] = [
  { time: "9:15", what: "集合竞价开始", note: "行情源开始有真实的撮合价。" },
  { time: "9:30", what: "开盘 · 开始记账", note: "现价打到买入价才记一笔，打不到不追；当天买的不卖（T+1）。" },
  { time: "14:40", what: "尾盘买入窗口", note: "次日补涨类策略只在这个窗口买入。" },
  { time: "15:00", what: "收盘 · 结算", note: "到止损/目标/持有到期的仓位按规则结掉；收盘后补记的信号日不进成绩统计。" },
  { time: "15:10", what: "跟单信号跟踪", note: "昨天定稿的信号清单按今天收盘价记一笔战绩。" },
  { time: "盘后", what: "信号初筛定稿", note: "脚本按各策略把全市场过一遍，产出明天可跟的挂单清单。" },
  { time: "夜间", what: "AI 进化一轮", note: "读当天失败归因 → 提因子/提参数变体 → 隔天开始攒样本等判决。" },
];

const RULES: { title: string; body: string }[] = [
  { title: "不给买卖建议", body: "所有页面只给数据、框架和裁决点；报告过红线扫描，命中就替换成占位句。它是研究工具，不是荐股机器人。" },
  { title: "不编数", body: "拿不到的数据写「缺口」，不许补 0 冒充；数字必须有出处，报告里的每个数都能点回证据。" },
  { title: "回测无前视", body: "回测只用当天收盘时已知的信息，次日才成交。回测结论 ≠ 策略能用——从回测到实盘还要过账本验证。" },
];

const PAGES: { to: string; name: string; line: string }[] = [
  { to: "/strategies/screener", name: "策略选股", line: "盘中实时：全市场按各策略打分排序，看「现在有什么候选」。" },
  { to: "/strategies/positions", name: "策略追踪", line: "持仓、当日盈亏、体检、战绩，以及挑战者池和回测结论速览。" },
  { to: "/strategies/signals", name: "跟单信号", line: "盘后定稿的挂单清单 + 竞价复核 + 逐条跟单战绩。" },
  { to: "/strategies/autopsy", name: "失败归因", line: "每笔亏损按机制拆（止损被波动打掉/跳空/到期没走出来），AI 优化的原料。" },
  { to: "/factors", name: "因子实验室", line: "选股规律的挖掘流水线：六关判决、死因档案、批次对比。" },
  { to: "/backtest", name: "回测", line: "历史验证。结论只到「有没有统计上站得住的超额」为止。" },
];

function GuidePage() {
  return (
    <Frame aside="导览" wide>
      <Panel title="赤轨是什么" note="先读这块，剩下的页面都是它的展开">
        <div className="flex flex-col gap-4 px-4 py-4">
          <p className="text-sm leading-relaxed text-muted">
            一台跑在本机的 <Term k="paper">A 股模拟盘</Term> + 个股研究流水线。它按六套选股策略在真实交易日里
            自动记账（每套每天最多 10 只名额），把每一次亏损拆到机制层面，再用统计判决决定哪组参数留下——
            整个循环不需要人守着，你只需要每天扫一眼「它做得怎么样、为什么亏」。
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            {RULES.map((r) => (
              <div key={r.title} className="rounded border border-line bg-surface-2/60 px-3 py-2.5">
                <div className="flex items-center gap-1.5 text-sm font-medium">
                  <ShieldCheck size={14} className="text-brand-text" aria-hidden />
                  {r.title}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-muted">{r.body}</p>
              </div>
            ))}
          </div>
        </div>
      </Panel>

      <Panel title="每天自动发生什么" note="记账进程每分钟跑一次，下面是它的全天节奏">
        <ol className="flex flex-col px-4 py-4">
          {TIMELINE.map((item, i) => (
            <li key={item.time} className="relative flex gap-4 pb-4 last:pb-0">
              {/* 时间轴：节点 + 竖线 */}
              <div className="flex flex-col items-center">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-brand/40 bg-brand-soft text-[10px] font-medium tabular-nums text-brand-text">
                  {i + 1}
                </span>
                {i < TIMELINE.length - 1 ? <span className="w-px flex-1 border-l border-dashed border-line" aria-hidden /> : null}
              </div>
              <div className="min-w-0 pb-1">
                <div className="flex flex-wrap items-baseline gap-x-2.5">
                  <span className="text-xs tabular-nums text-muted">{item.time}</span>
                  <span className="text-sm font-medium">{item.what}</span>
                </div>
                <p className="mt-0.5 text-xs leading-relaxed text-muted">{item.note}</p>
              </div>
            </li>
          ))}
        </ol>
      </Panel>

      <Panel title="页面地图：什么时候看哪块" note="侧栏七组按职能分区；这里列的是每天真的会用到的">
        <div className="grid gap-2 px-4 py-4 sm:grid-cols-2">
          {PAGES.map((p) => (
            <Link
              key={p.to}
              to={p.to}
              className="group rounded border border-line bg-surface-2/60 px-3 py-2.5 transition hover:border-brand/40 hover:bg-surface-2"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{p.name}</span>
                <span className="text-xs text-muted transition group-hover:text-brand-text">去看 →</span>
              </div>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">{p.line}</p>
            </Link>
          ))}
        </div>
      </Panel>

      <Panel title="数字怎么读" note="三句话，比任何图表都省时间">
        <div className="grid gap-2 px-4 py-4 text-xs leading-relaxed text-muted sm:grid-cols-3">
          <div className="rounded border border-line bg-surface-2/60 px-3 py-2.5">
            <div className="mb-1 font-medium text-fg">胜率要配着盈亏比看</div>
            <Term k="winRate">胜率</Term>低不一定是差策略，<Term k="plRatio">盈亏比</Term>高就补得回来；两个拆开看都会骗人。
          </div>
          <div className="rounded border border-line bg-surface-2/60 px-3 py-2.5">
            <div className="mb-1 font-medium text-fg">|t| &lt; 2 当没测出来</div>
            <Term k="welchT">Welch t</Term> 是「差异是不是运气」的裁判线，不过线的超额一律当巧合。
          </div>
          <div className="rounded border border-line bg-surface-2/60 px-3 py-2.5">
            <div className="mb-1 font-medium text-fg">先问样本多少</div>
            <Term k="sample">样本</Term>不够的统计全是噪声——这是判决门槛设那么高的原因。
          </div>
        </div>
      </Panel>

      <Panel title="想再深一层" note="仓库里的文档按主题各管一摊">
        <div className="flex flex-col gap-1.5 px-4 py-4 text-xs text-muted">
          <p>
            <Tag tone="brand">PROJECT.md</Tag> 系统总览与铁律 · <Tag tone="brand">DECISIONS.md</Tag> 判决规则与拍板记录 ·{" "}
            <Tag tone="brand">REMAINING.md</Tag> 进度总表 · <Tag tone="brand">DATA-ACCESS.md</Tag> 数据源口径与踩坑
          </p>
          <p className="text-[11px]">术语卡在任何页面悬停/点按虚线词都能看到；解释唯一出处是 glossary.ts，改一处全站生效。</p>
        </div>
      </Panel>
    </Frame>
  );
}

export const Route = createFileRoute("/guide")({
  component: GuidePage,
});
