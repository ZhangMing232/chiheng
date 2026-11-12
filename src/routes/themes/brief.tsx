/**
 * 题材前瞻简报（/brief）——「事实 → 题材 → 个股 + 分数 + 论据」。
 *
 * 这个页面的形状是照着弈盘「市场情报」学的：每条给固定三段，
 * ① 催化原文（不改写，带日期）② 结构性事实（涨停几家、最高几板、密度是全市场几倍）
 * ③ 个股清单，每只票带分数和**四行可复算的论据**。
 *
 * 三条纪律（写在页面上，不只写在代码里）：
 * - 催化原文来自第三方整理，本页不改写、不摘要；没有就写「暂无催化」，不编。
 * - 分数只描述「今日资金在这只票上的相对强度」，不预测次日，不是买入信号。
 * - 论据必须能手工复算：分数 = 涨停基座 + 封单强度 + 位置 + 题材纯正，四项相加。
 */

import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { SectionTabs, THEME_TABS } from "@/components/section-tabs";
import { Panel, Tag } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { getBrief } from "@/lib/market/quotes.functions";

export const Route = createFileRoute("/themes/brief")({
  loader: async () => ({ brief: await getBrief().catch(() => null) }),
  component: BriefPage,
});

const ymd = (d: string) => (/^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d);
const wan = (n: number) => (n >= 1e8 ? `${(n / 1e8).toFixed(2)}亿` : `${(n / 1e4).toFixed(0)}万`);

function BriefPage() {
  const { brief } = Route.useLoaderData();
  if (!brief) {
    return (
      <Frame wide aside={<span className="text-xs text-muted">还没有生成简报</span>}>
        <SectionTabs ariaLabel="题材" tabs={THEME_TABS} />
        <Panel title="题材前瞻简报">
          <StateBlock
            kind="empty"
            title="还没有简报"
            hint="跑一次 scripts/brief-build.ts 生成（读本地概念/行情/涨停池，不联网）。"
          />
        </Panel>
      </Frame>
    );
  }

  return (
    <Frame
      wide
      aside={
        /* 顶栏这行放真实数据，不重复页名（页名在第一行页头里已经有了） */
        <span className="num text-xs text-muted">
          {brief.date} · {brief.themes.length} 个题材 · 全市场涨停 {brief.totalLimitUp} 家
        </span>
      }
    >
      <SectionTabs ariaLabel="题材" tabs={THEME_TABS} />
      {/* 这是个读字页：一行拉到 1300px 会读不动，限宽到 1080 */}
      <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-3">
        <Panel
          title="入选规则与分数口径"
          note={
            <span className="whitespace-nowrap">
              {brief.date}
              {/* 窄屏这串会把「题材前瞻简报」挤成两行，只在 sm 以上显示 */}
              <span className="hidden sm:inline">
                {" "}· 全市场涨停 {brief.totalLimitUp} 家 · 原因原文 {yml(brief.reasonDate)}
              </span>
            </span>
          }
        >
          <div className="flex flex-col gap-2 px-3 py-2 text-[12px] leading-relaxed text-muted">
            <div>
              入选规则：题材涨停家数 ≥5，且「涨停密度 ≥ 全市场 1.8 倍」或「今天有催化原文」。
              密度 = 该题材涨停数 ÷ 成分股数；按密度而不是绝对家数，是为了不让「成分股几千只」的
              宽口径板块靠体量排到前面。
            </div>
            <div className="rounded border border-line bg-surface-2 px-2 py-1.5">
              <b className="text-fg">分数怎么算（{brief.scoring.terms.length} 项相加，可手工复算）</b>
              <ol className="mt-1 list-decimal pl-4">
                {brief.scoring.terms.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ol>
              <div className="mt-1">{brief.scoring.note}</div>
            </div>
          </div>
        </Panel>

        {/* 12 个题材堆下来很长，先给一排锚点能跳；不占地方，只在上一屏以后有用 */}
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-2 text-[12px]">
          <span className="text-muted">跳到</span>
          {brief.themes.map((t, i) => (
            <a
              key={t.name}
              href={`#theme-${i}`}
              className="rounded border border-line px-1.5 py-0.5 text-muted hover:border-brand hover:text-brand-text"
            >
              {t.name}
              <span className="num ml-1 text-[12px]">{t.limitUp}</span>
            </a>
          ))}
        </div>

        {brief.themes.map((t, i) => (
          <Panel
            key={t.name}
            id={`theme-${i}`}
            title={t.name}
            note={
              <span className="flex items-center gap-2">
                <Tag tone={t.lift >= 3 ? "up" : "muted"}>{t.lift.toFixed(1)}× 密度</Tag>
                <span>
                  涨停 {t.limitUp} / 成分 {t.members} · 最高 {t.maxStreak} 板
                </span>
              </span>
            }
          >
            <div className="flex flex-col gap-2 px-3 py-2">
              {/* ① 催化原文 */}
              <div className="rounded border border-line px-2 py-1.5">
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <b className="text-xs">催化</b>
                  <span className="text-[12px] text-muted">
                    {t.catalyst ? ymd(t.catalyst.date) : "无原文"}
                  </span>
                </div>
                {t.catalyst ? (
                  <>
                    <div className="text-[12px] leading-snug">{t.catalyst.title}</div>
                    {t.catalyst.reason && t.catalyst.reason !== t.catalyst.title ? (
                      <div className="mt-1 text-[12px] leading-relaxed text-muted">
                        {t.catalyst.reason.length > 200 ? `${t.catalyst.reason.slice(0, 200)}…` : t.catalyst.reason}
                      </div>
                    ) : null}
                    <div className="mt-1 text-[12px] text-muted">
                      原文来自第三方盘后整理，本页不改写、不摘要。题材名按包含关系匹配，可能对不完全准。
                    </div>
                  </>
                ) : (
                  <div className="text-[12px] leading-relaxed text-muted">
                    今天这个题材没有采到催化原文——不是「没有消息」，是我们没拿到。留空不编。
                  </div>
                )}
              </div>

              {/* ② 结构事实 */}
              <div className="text-[12px] leading-relaxed text-muted">{t.note}</div>

              {/* ③ 个股 + 分数 + 论据 */}
              <div className="mt-0.5 border-b border-line pb-1 text-[12px] text-muted">
                个股 · 按分数降序 · 展开「论据」能看到四项各得多少，加起来就是这个分数
              </div>
              {/* 宽屏两列：不然名称在最左、分数在最右，中间空 900px，没法逐行扫 */}
              <div className="grid sm:grid-cols-2 sm:gap-x-6">
                {t.stocks.map((s, i) => (
                  <div key={`${s.id}-${i}`} className="border-b border-line py-1.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="flex min-w-0 items-baseline gap-1.5">
                        <span className="truncate text-sm font-medium">{s.name}</span>
                        <span className="num text-[12px] text-muted">{s.code}</span>
                        {s.streak > 1 ? <Tag tone="up">{s.streak}板</Tag> : null}
                      </span>
                      <span className="num shrink-0 text-sm font-medium">{s.score.toFixed(1)}</span>
                    </div>
                    <details className="mt-0.5">
                      <summary className="cursor-pointer text-[12px] text-muted hover:text-fg">
                        ▸ 论据（{s.scoreParts.length} 项）
                      </summary>
                      <div className="mt-1 grid gap-x-4 gap-y-0.5 pl-4 text-[12px] text-muted sm:grid-cols-2">
                        {s.scoreParts.map((p) => (
                          <div key={p.label} className="flex justify-between gap-2">
                            <span>{p.label}</span>
                            <span className="num text-right">{p.value}</span>
                          </div>
                        ))}
                        <div className="flex justify-between gap-2 border-t border-line pt-0.5 sm:col-span-2">
                          <span>封单额（原始）</span>
                          <span className="num text-right">{wan(s.sealFund)}</span>
                        </div>
                      </div>
                    </details>
                  </div>
                ))}
              </div>
            </div>
          </Panel>
        ))}

        <Panel title="怎么用这一页">
          <div className="flex flex-col gap-1.5 px-3 py-2 text-[12px] leading-relaxed text-muted">
            <div>· 先看催化是不是新事实（日期就是它的新鲜度），再看结构事实（几家涨停、密度几倍）。</div>
            <div>· 分数高只代表今天资金在这只票上的相对强度，不代表明天还能涨。历史同景见 /cycle。</div>
            <div>· 任何一只票能不能买，仍要走 /decision 的闸门与 /strategies/positions 的持仓检查。</div>
            <div>· 题材名匹配是包含关系，可能出现「光模块」对上「光通信模块」这种，看催化原文自己判断。</div>
          </div>
        </Panel>
      </div>
    </Frame>
  );
}

/** 原因文件的日期是 8 位数字，转成可读格式；空则明说。 */
function yml(d: string): string {
  return d ? ymd(d) : "未采到";
}
