/**
 * 这个文件是干什么的：
 * 「资金流向」区的「板块」子页（/flow/sectors）——东财三级行业分类（D6）+ 每个板块的月度温度计（D5）。
 * 2026-10-21 从独立 /sectors 先并入 /flow，随后资金流向整页拆成子页面，板块是其中一个
 * 子页（顶部 tab 和其他子页同一组，见 components/flow-sections.tsx 的 FlowSectionTabs；
 * 旧 /sectors 路由保留为重定向，书签不断）。
 *
 * 对标 Vibe-Research 的 Sectors / SectorDetail（它那页还有 GPU 租金这种产业温度计，
 * 赤轨没有，见下面「给不出什么」）。
 *
 * 你需要知道的（纪律）：
 * 1. **这一页不联网**。板块清单和月度序列都来自 `data/backtest/` 的落盘缓存，
 *    所以接口挂了页面照样开；代价是数字不是实时的——**数据日期必须上屏**，
 *    别让人把上个月的月度涨跌当成今天的行情。
 * 2. **温度计是量价与资金维度的读数，不是行业景气度**。它只能说明价格和主力
 *    资金在往哪走，说不出供需。页面上每处方向读数都带这句护栏。
 * 3. **没有上下游**。Vibe 的产业标签表是「算力链 → GPU 租金 / 台系月营收」那种
 *    人工产业认知 + 海外源，赤轨两样都没有。编一张就是编数据，所以本页只给
 *    板块自身的月度数据，不画产业链位置。
 * 4. 缺分类和缺月度是**两件事**，分开报，不合并成一句「行业数据缺失」。
 * 5. 只描述过去，不预测，不给买卖暗示。
 */

import { useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { flowAmount, FlowSectionTabs } from "@/components/flow-sections";
import { Panel, Tag, thClass, tdClass } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { GapList } from "@/components/source-line";
import { getSectorBoards, getSectorDetail } from "@/lib/market/industry.functions";
import { searchBoards, sortBoards, type BoardDetail, type SortKey } from "@/lib/market/sectors-view";
import { signedPct, toneClass } from "@/lib/market/format";
import type { ThermometerDirection } from "@/lib/market/industry-monthly";

export const Route = createFileRoute("/review/flow/sectors")({
  validateSearch: (search: Record<string, unknown>) => ({
    board: typeof search.board === "string" && /^BK\d+$/.test(search.board) ? search.board : "",
  }),
  loaderDeps: ({ search }) => ({ board: search.board }),
  loader: async ({ deps }) => {
    const table = await getSectorBoards().catch(() => null);
    const detail = deps.board ? await getSectorDetail({ data: { code: deps.board } }).catch(() => null) : null;
    return { table, detail };
  },
  component: SectorsPage,
});

const DIRECTION_TAG: Record<ThermometerDirection, { text: string; tone: "brand" | "warn" | "muted" }> = {
  升温: { text: "升温", tone: "brand" },
  降温: { text: "降温", tone: "warn" },
  背离: { text: "背离", tone: "warn" },
  不明: { text: "不明", tone: "muted" },
};

const SORT_LABEL: Record<SortKey, string> = { chg: "月度涨跌", net: "主力净流入", members: "成分股数", name: "名称" };

function SectorsPage() {
  const { table, detail } = Route.useLoaderData();
  const navigate = useNavigate();
  const search = Route.useSearch();
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("chg");
  const [desc, setDesc] = useState(true);

  const rows = useMemo(() => {
    const list = table ? searchBoards(table.rows, q) : [];
    return sortBoards(list, sort, desc);
  }, [table, q, sort, desc]);

  const picked = search.board;

  function pick(code: string) {
    void navigate({ to: "/review/flow/sectors", search: { board: picked === code ? "" : code } });
  }

  if (!table || table.rows.length === 0) {
    return (
      <Frame wide aside="板块">
        <FlowSectionTabs />
        <Panel title="板块" note="没有数据">
          <StateBlock
            kind="empty"
            title="还没有板块数据"
            hint="板块清单来自 scripts/fetch-industry.mjs（东财三级行业，约 11 分钟），月度序列来自 scripts/fetch-industry-monthly.mjs（约 20 分钟）。两个脚本都跑过之后这一页才有内容。"
          />
          {table && table.gaps.length > 0 ? <GapList items={table.gaps} /> : null}
        </Panel>
      </Frame>
    );
  }

  return (
    <Frame wide
      aside="板块"
      ornamentContent={
        // **真实数据**：板块行按主力净流入排，mainNet 单位万元。
        table.rows.length === 0 ? (
          <span className="text-[11px]">今天没有板块资金数据</span>
        ) : table.rows[0]!.mainNet == null ? (
          // 有板块行但没披露主力净额——「没披露」和「0」不是一回事
          <span className="text-[11px]">板块资金口径未披露</span>
        ) : (
          <span className="text-[11px] tabular-nums">
            净流入第一 {table.rows[0]!.name} {flowAmount(table.rows[0]!.mainNet)}
          </span>
        )
      }
    >
      <FlowSectionTabs />
      <Panel
        title="板块"
        note={`${table.rows.length} 个行业板块 · 分类 ${table.indexDate ?? "无"} · 月度 ${table.monthlyDate ?? "无"}`}
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜板块名或 BK 代码"
            className="w-44 rounded border border-line bg-transparent px-2 py-1 text-xs text-fg placeholder:text-muted"
          />
          <div className="flex items-center gap-1">
            {(Object.keys(SORT_LABEL) as SortKey[]).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  if (sort === key) setDesc(!desc);
                  else {
                    setSort(key);
                    setDesc(true);
                  }
                }}
                className={
                  "rounded border px-2 py-1 text-xs transition " +
                  (sort === key ? "border-brand text-fg" : "border-line text-muted hover:text-fg")
                }
              >
                {SORT_LABEL[key]}
                {sort === key ? (desc ? " ↓" : " ↑") : ""}
              </button>
            ))}
          </div>
          <span className="text-[11px] text-muted">
            数字来自落盘缓存，不是实时行情。月度涨跌以上月月末收盘为基准；当月没走完的月份标「进行中」。
            「当月」是最新一个完整月，「温度计」看的是近三个完整月——两者可以相反（鼠标停在方向上看依据）。
          </span>
        </div>

        <table className="data-table w-full">
          <caption className="sr-only">行业板块列表：成分股数、最新完整月的涨跌与主力净流入、温度计方向</caption>
          <thead>
            <tr className="border-b border-line">
              <th className={thClass("text-left")}>板块</th>
              <th className={thClass()}>成分股</th>
              <th className={thClass()}>最新完整月</th>
              <th className={thClass()}>当月涨跌</th>
              <th className={thClass()}>当月主力</th>
              <th className={thClass()}>温度计（近 3 月）</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.code}
                onClick={() => pick(r.code)}
                className={"cursor-pointer border-b border-line/60 transition hover:bg-brand-soft/20 " + (picked === r.code ? "bg-brand-soft/30" : "")}
              >
                <td className={tdClass("text-left")}>
                  <span className="text-fg">{r.name}</span>
                  <span className="ml-1.5 text-[11px] text-muted">{r.code}</span>
                </td>
                <td className={tdClass()}>{r.members}</td>
                <td className={tdClass("whitespace-nowrap text-muted")}>{r.latestMonth ?? "—"}</td>
                <td className={tdClass("text-right " + toneClass(r.chgPct))}>{r.chgPct == null ? "—" : signedPct(r.chgPct)}</td>
                <td className={tdClass("text-right " + toneClass(r.mainNet))}>
                  {r.mainNet == null ? "—" : `${(r.mainNet / 1e8).toFixed(2)} 亿`}
                </td>
                <td className={tdClass()} title={r.basis}>
                  <Tag tone={DIRECTION_TAG[r.direction].tone}>{DIRECTION_TAG[r.direction].text}</Tag>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {table.gaps.length > 0 ? <GapList items={table.gaps} /> : null}
      </Panel>

      {picked && detail ? <BoardDetailPanel detail={detail} /> : null}
      {picked && !detail ? (
        <Panel title="板块详情" note="没读到">
          <StateBlock kind="empty" title="这个板块没有数据" hint="可能月度没抓过，或者板块代码对不上（索引是旧抓的）。" />
        </Panel>
      ) : null}
    </Frame>
  );
}

function BoardDetailPanel({ detail }: { detail: BoardDetail }) {
  const tag = DIRECTION_TAG[detail.thermo.direction];
  return (
    <Panel
      title={`${detail.name} · ${detail.code}`}
      note={`${detail.members.length} 只成分股 · 月度 ${detail.monthlyDate ?? "无"}`}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2">
        <Tag tone={tag.tone}>温度计 {tag.text}</Tag>
        <span className="text-[11px] text-muted">{detail.thermo.basis}</span>
      </div>
      <p className="px-3.5 py-2 text-[11px] text-muted">
        这是量价与资金维度的读数，不等于行业景气度，也只描述过去。板块自身的数据，不含上下游链条——赤轨没有产业链映射表，不编。
      </p>

      {detail.months.length === 0 ? (
        <StateBlock kind="empty" title="没有月度数据" hint="跑 scripts/fetch-industry-monthly.mjs。" />
      ) : (
        <table className="data-table w-full">
          <caption className="sr-only">{detail.name} 的月度序列：涨跌、主力净流入、换手、交易日数</caption>
          <thead>
            <tr className="border-b border-line">
              <th className={thClass("text-left")}>月份</th>
              <th className={thClass()}>涨跌</th>
              <th className={thClass()}>主力净流入</th>
              <th className={thClass()}>月均换手</th>
              <th className={thClass()}>交易日</th>
            </tr>
          </thead>
          <tbody>
            {detail.months.map((m) => (
              <tr key={m.month} className="border-b border-line/60">
                <td className={tdClass("text-left")}>
                  {m.month}
                  {m.partial ? <span className="ml-1.5 text-[11px] text-muted">进行中</span> : null}
                </td>
                <td className={tdClass("text-right " + toneClass(m.chgPct))}>{m.chgPct == null ? "—" : signedPct(m.chgPct)}</td>
                <td className={tdClass("text-right " + toneClass(m.mainNet))}>
                  {m.mainNet == null ? "—" : `${(m.mainNet / 1e8).toFixed(2)} 亿`}
                </td>
                <td className={tdClass("text-right text-muted")}>
                  {m.avgTurnover == null ? "—" : `${m.avgTurnover.toFixed(2)}%`}
                </td>
                <td className={tdClass("text-right text-muted")}>{m.sessions}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {detail.members.length > 0 ? (
        <div className="border-t border-line px-3.5 py-2">
          <div className="mb-1 text-[11px] text-muted">成分股（内部代码，点「个股查询」可查单只）</div>
          <div className="flex flex-wrap gap-1.5">
            {detail.members.slice(0, 60).map((id) => (
              <span key={id} className="rounded border border-line px-1.5 py-0.5 text-[11px] text-muted">
                {id}
              </span>
            ))}
            {detail.members.length > 60 ? (
              <span className="text-[11px] text-muted">…还有 {detail.members.length - 60} 只</span>
            ) : null}
          </div>
        </div>
      ) : null}

      {detail.gaps.length > 0 ? <GapList items={detail.gaps} /> : null}
    </Panel>
  );
}
