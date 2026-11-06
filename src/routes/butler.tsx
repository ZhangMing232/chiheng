/**
 * 这个文件是干什么的：
 * 「大管家」页 —— 常驻 AI 助手。问它行情/账本/策略/因子/回测/自选，它每次回答前
 * 先读一遍项目当前状态（指数/涨跌分布/账本/挑战者），再基于状态回答。
 *
 * 你需要知道的：
 * - 纯问答，不写账本、不改判决、不下单。DSH 不可用时返回错误提示（不假装答）。
 * - 上下文里没有的信息，大管家会如实说「不知道」，不编数字。
 * - 2026-11-06 按 AI 区新效果图重排：Copilot 式布局 + 右侧「它读什么」真实状态栏。
 *   右栏所有数字来自账本/闸门/行情，没有一根虚构的柱子；快速提问全部接 askButler
 *   真实能力，效果图里的「深度思考/联网搜索」开关是假功能，没画。
 */

import { useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { GlowPanel, MiniBars } from "@/components/ai-kit";
import { askButler, getChallengers, getIndices, getRecorder, getServerJournal, getStrategyGates } from "@/lib/market/quotes.functions";
import { ACTIVE_STYLES, STYLES } from "@/lib/market/strategies";
import { Bot, Send, ChartLine, Wallet, FlaskConical, Database } from "lucide-react";
import type { IndexQuote } from "@/lib/market/types";

type Msg = { role: "user" | "butler"; text: string };

const WELCOME = "我是赤轨大管家。问我行情、账本、策略、因子、回测、自选——我会先读一遍项目当前状态再回答。";

/** 快速提问：全部是 askButler 真实答得了的问题（它读得到这些数据）。 */
const QUICK_QUESTIONS = [
  "现在大盘怎么样？",
  "我的持仓有哪些风险？",
  "现在有哪些策略在跑、哪些被停了？",
  "因子挖掘最近有什么进展？",
  "回测最近跑出什么结论？",
];

const SUGGESTIONS = [
  { icon: ChartLine, q: "帮我分析一下当前市场的主要机会与风险" },
  { icon: Wallet, q: "我的持仓风险如何？有哪些优化建议？" },
  { icon: FlaskConical, q: "我应该关注哪些因子或板块的最新变化？" },
];

export const Route = createFileRoute("/butler")({
  loader: async () => {
    const [journal, gates, indices, recorder, chal] = await Promise.all([
      getServerJournal().catch(() => ({ days: [], personal: false, why: null })),
      getStrategyGates().catch(() => ({ gates: {} as Record<string, { state: string; reason: string; since: string }> })),
      getIndices().catch(() => [] as IndexQuote[]),
      getRecorder().catch(() => ({ at: null as number | null, ok: true })),
      getChallengers().catch(() => ({ list: [] as { id: string; status: string; name?: string }[], champions: {} })),
    ]);
    const trades = journal.days.flatMap((d) => d.trades);
    const open = trades.filter((t) => t.exit == null).length;
    // 账本按上海日记账（day.date），今天的成交按日期对；近 7 天柱 = 逐日数笔数
    const shanghai = (offsetDays: number): string => {
      const dt = new Date(Date.now() + 8 * 3600_000 + offsetDays * 86_400_000);
      return dt.toISOString().slice(0, 10);
    };
    const today = journal.days.find((day) => day.date === shanghai(0))?.trades.length ?? 0;
    const bars: number[] = [];
    for (let i = 6; i >= 0; i--) {
      bars.push(journal.days.find((day) => day.date === shanghai(-i))?.trades.length ?? 0);
    }
    return {
      open,
      today,
      bars,
      gates: gates.gates,
      indices,
      recorder,
      runningChallengers: chal.list.filter((c) => c.status === "running").length,
      judgedChallengers: chal.list.filter((c) => c.status !== "running").length,
    };
  },
  component: ButlerPage,
});

function ButlerPage() {
  const d = Route.useLoaderData();
  const [messages, setMessages] = useState<Msg[]>([{ role: "butler", text: WELCOME }]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  async function send(q?: string) {
    const text = (q ?? input).trim();
    if (!text || busy) return;
    setMessages((m) => [...m, { role: "user", text }]);
    setInput("");
    setBusy(true);
    try {
      const res = await askButler({ data: { q: text } });
      setMessages((m) => [...m, { role: "butler", text: res.ok ? res.answer : `（出错：${res.error}）` }]);
    } catch (e) {
      setMessages((m) => [...m, { role: "butler", text: `（调用失败：${e instanceof Error ? e.message : String(e)}）` }]);
    } finally {
      setBusy(false);
      requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }));
    }
  }

  const styleRows = STYLES.map((s) => {
    const gate = d.gates[s.id];
    const active = (ACTIVE_STYLES as string[]).includes(s.id);
    const state = !active ? "已下线" : gate?.state === "disabled" ? "已停用" : gate ? "假释中" : "在跑";
    return { name: s.name, state, reason: gate?.reason };
  });

  return (
    <Frame wide aside="AI · 大管家">
      {/* 页头 */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex size-11 items-center justify-center rounded-xl border border-ai-line bg-ai-soft text-ai">
          <Bot size={24} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-xl font-medium tracking-wide text-fg">大管家</h1>
          <p className="text-xs text-muted">你的量化投资 AI 助手：连接数据、策略与市场，先读状态再回答。</p>
        </div>
        <span className="text-xs text-muted">专注于量化投资的 AI Copilot</span>
      </div>

      <div className="mt-3 grid items-start gap-3 xl:grid-cols-[1fr_300px]">
        {/* 对话主列 */}
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex h-[64vh] flex-col overflow-hidden rounded-lg border border-line bg-surface">
            <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
              {messages.length <= 1 ? (
                <GlowPanel className="px-6 py-8">
                  <div className="flex items-center gap-4">
                    <span className="flex size-16 shrink-0 items-center justify-center rounded-full border border-ai-line bg-ai-soft text-ai">
                      <Bot size={34} />
                    </span>
                    <div>
                      <p className="font-display text-lg font-medium text-fg">你好，我是大管家</p>
                      <p className="mt-1 text-xs leading-relaxed text-muted">
                        我可以基于你的持仓、策略和市场数据回答问题——先读一遍项目当前状态，再开口。不编数字，读不到的就明说。
                      </p>
                    </div>
                  </div>
                  <div className="mt-5 grid gap-2 sm:grid-cols-3">
                    {SUGGESTIONS.map((s) => (
                      <button
                        key={s.q}
                        type="button"
                        onClick={() => void send(s.q)}
                        className="group rounded-lg border border-line bg-surface p-3 text-left transition hover:border-ai-line"
                      >
                        <s.icon size={16} className="text-ai" />
                        <p className="mt-1.5 text-xs leading-relaxed text-fg">{s.q}</p>
                        <span className="mt-1 inline-block text-[11px] text-muted transition group-hover:translate-x-0.5 group-hover:text-ai">→</span>
                      </button>
                    ))}
                  </div>
                </GlowPanel>
              ) : null}
              {messages.map((m, i) => (
                <div key={i} className={m.role === "user" ? "text-right" : "text-left"}>
                  <div
                    className={
                      "inline-block max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-left text-[13px] leading-relaxed " +
                      (m.role === "user" ? "border border-ai-line bg-ai-soft text-fg" : "border border-line text-fg")
                    }
                  >
                    {m.text}
                  </div>
                </div>
              ))}
              {busy ? <div className="text-left text-[12px] text-muted">大管家正在读状态、思考…</div> : null}
              <div ref={bottomRef} />
            </div>
            <div className="border-t border-line px-4 py-2.5">
              <div className="flex gap-2">
                <input
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  placeholder="向大管家提问… 比如：现在大盘怎么样？/ 我的持仓有哪些风险？"
                  className="min-w-0 flex-1 rounded-lg border border-line bg-transparent px-3 py-2 text-[13px] text-fg placeholder:text-muted focus:border-ai-line focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={busy || !input.trim()}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg bg-ai px-4 py-2 text-[13px] font-medium text-[#08252b] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Send size={14} /> 发送
                </button>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-muted">快速提问：</span>
                {QUICK_QUESTIONS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => void send(q)}
                    disabled={busy}
                    className="rounded-full border border-line px-2.5 py-0.5 text-[11px] text-muted transition hover:border-ai-line hover:text-ai disabled:opacity-40"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* 右栏：它读什么（全部真实数据） */}
        <div className="flex min-w-0 flex-col gap-3">
          <section className="rounded-lg border border-line bg-surface px-3.5 py-3">
            <h2 className="flex items-center gap-1.5 text-sm font-medium text-fg">
              <Database size={14} className="text-ai" /> 当前上下文
            </h2>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted">每次回答前自动读一遍，答完即弃、不写任何数据：</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {["指数行情", "涨跌分布", "账本持仓", "策略闸门", "挑战者池", "因子队列"].map((c) => (
                <span key={c} className="rounded-full border border-line px-2 py-0.5 text-[11px] text-muted">
                  {c}
                </span>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-muted tabular-nums">
              上次记账 {d.recorder.at ? `${Math.round((Date.now() - d.recorder.at) / 60_000)} 分钟前` : "还没跑"} · 行情{" "}
              {d.indices.find((i) => i.time)?.time ?? "还没拉到"}
            </p>
          </section>

          <section className="rounded-lg border border-line bg-surface px-3.5 py-3">
            <h2 className="text-sm font-medium text-fg">已读取项目状态</h2>
            <div className="mt-2 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg border border-line px-1 py-2">
                <div className="text-[10px] text-muted">持仓</div>
                <div className="text-xl font-semibold tabular-nums text-ai">{d.open}<span className="text-[10px] font-normal text-muted"> 只</span></div>
                <MiniBars values={d.bars} className="mx-auto mt-1" />
              </div>
              <div className="rounded-lg border border-line px-1 py-2">
                <div className="text-[10px] text-muted">在跟策略</div>
                <div className="text-xl font-semibold tabular-nums text-ai">
                  {d.runningChallengers + (ACTIVE_STYLES as string[]).filter((s) => d.gates[s]?.state !== "disabled").length}
                  <span className="text-[10px] font-normal text-muted"> 套</span>
                </div>
                <div className="mt-1 text-[10px] text-muted">挑战者 {d.runningChallengers}</div>
              </div>
              <div className="rounded-lg border border-line px-1 py-2">
                <div className="text-[10px] text-muted">今日成交</div>
                <div className="text-xl font-semibold tabular-nums text-ai">{d.today}<span className="text-[10px] font-normal text-muted"> 笔</span></div>
                <div className="mt-1 text-[10px] text-muted">{d.open > 0 ? `在拿 ${d.open} 只` : "—"}</div>
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-line bg-surface px-3.5 py-3">
            <h2 className="text-sm font-medium text-fg">策略状态</h2>
            <ul className="mt-1.5 space-y-1 text-xs">
              {styleRows.map((r) => (
                <li key={r.name} className="flex items-center justify-between gap-2" title={r.reason ?? undefined}>
                  <span className="min-w-0 truncate text-fg">{r.name}</span>
                  <span
                    className={
                      "shrink-0 rounded px-1.5 py-0.5 text-[10px] " +
                      (r.state === "在跑"
                        ? "bg-up-soft text-up"
                        : r.state === "已停用"
                          ? "bg-warn-soft text-warn"
                          : "bg-surface-2 text-muted")
                    }
                  >
                    {r.state}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-[11px] text-muted">挑战者已判决 {d.judgedChallengers} 个 · 在跑 {d.runningChallengers} 个</p>
          </section>

          <section className="rounded-lg border border-line bg-surface px-3.5 py-3">
            <h2 className="text-sm font-medium text-fg">数据来源</h2>
            <ul className="mt-1.5 space-y-1 text-xs text-muted">
              <li className="flex justify-between gap-2"><span className="text-fg">腾讯行情</span><span>主源 · 免费</span></li>
              <li className="flex justify-between gap-2"><span>新浪行情</span><span>备源</span></li>
              <li className="flex justify-between gap-2"><span>东财</span><span>港美 · 财报</span></li>
              <li className="flex justify-between gap-2"><span>baostock</span><span>日线（回测）</span></li>
            </ul>
            <p className="mt-1.5 text-[11px] text-muted">全部免费公开接口，零鉴权；不接付费数据商。</p>
          </section>
        </div>
      </div>
    </Frame>
  );
}
