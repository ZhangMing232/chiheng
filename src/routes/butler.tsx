/**
 * 这个文件是干什么的：
 * 「大管家」页 —— 常驻 AI 助手。问它行情/账本/策略/因子/回测/自选，它每次回答前
 * 先读一遍项目当前状态（指数/涨跌分布/账本/挑战者），再基于状态回答。
 *
 * 你需要知道的：
 * - 纯问答，不写账本、不改判决、不下单。DSH 不可用时返回错误提示（不假装答）。
 * - 上下文里没有的信息，大管家会如实说「不知道」，不编数字。
 */

import { useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Panel } from "@/components/terminal";
import { askButler } from "@/lib/market/quotes.functions";

type Msg = { role: "user" | "butler"; text: string };

const WELCOME = "我是赤轨大管家。问我行情、账本、策略、因子、回测、自选——我会先读一遍项目当前状态再回答。";

export const Route = createFileRoute("/butler")({
  component: ButlerPage,
});

function ButlerPage() {
  const [messages, setMessages] = useState<Msg[]>([{ role: "butler", text: WELCOME }]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  async function send() {
    const q = input.trim();
    if (!q || busy) return;
    setMessages((m) => [...m, { role: "user", text: q }]);
    setInput("");
    setBusy(true);
    try {
      const res = await askButler({ data: { q } });
      setMessages((m) => [...m, { role: "butler", text: res.ok ? res.answer : `（出错：${res.error}）` }]);
    } catch (e) {
      setMessages((m) => [...m, { role: "butler", text: `（调用失败：${e instanceof Error ? e.message : String(e)}）` }]);
    } finally {
      setBusy(false);
      requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }));
    }
  }

  return (
    <Frame wide aside="大管家">
      <Panel title="大管家" note="常驻 AI 助手 · 每次回答前先读一遍项目当前状态">
        <div className="flex h-[68vh] flex-col">
          <div className="flex-1 space-y-3 overflow-y-auto px-3.5 py-3">
            {messages.map((m, i) => (
              <div key={i} className={m.role === "user" ? "text-right" : "text-left"}>
                <div
                  className={
                    "inline-block max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-left text-[13px] leading-relaxed " +
                    (m.role === "user" ? "border border-brand/40 text-fg" : "border border-line text-fg")
                  }
                >
                  {m.text}
                </div>
              </div>
            ))}
            {busy ? <div className="text-left text-[12px] text-muted">大管家正在读状态、思考…</div> : null}
            <div ref={bottomRef} />
          </div>
          <div className="flex gap-2 border-t border-line px-3.5 py-2.5">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder="问点什么，比如：现在大盘怎么样？/ 我的持仓有多少笔？/ 有哪些挑战者在跑？"
              className="flex-1 rounded border border-line bg-transparent px-3 py-2 text-[13px] text-fg placeholder:text-muted"
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={busy || !input.trim()}
              className="rounded border border-line px-4 py-2 text-[13px] text-fg disabled:opacity-40"
            >
              发送
            </button>
          </div>
        </div>
      </Panel>
    </Frame>
  );
}
