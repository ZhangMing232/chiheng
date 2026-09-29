import { useEffect, useState } from "react";
import { exitAfterSessions } from "@/lib/market/session";
import { EARLY_HOLD, resolveHold, type StrategyId } from "@/lib/market/model";
import type { SessionInfo } from "@/lib/market/types";
import { usePlan } from "@/lib/plan";

const field = "h-11 w-full rounded-md border border-line bg-bg px-3 text-sm";

export function HoldNote({ days, compact = false }: { days: number | null; compact?: boolean }) {
  const min = days == null ? EARLY_HOLD.min : days;
  const max = days == null ? EARLY_HOLD.max : days;
  const from = exitAfterSessions(min);
  const to = exitAfterSessions(max);
  if (compact) {
    return (
      <p className="text-xs text-muted">
        预计持股 {min === max ? `${min}` : `${min}–${max}`} 个交易日 · 约 {from}
        {from === to ? "" : ` 至 ${to}`}
      </p>
    );
  }
  return (
    <p className="text-sm">
      <span className="font-medium">预计持股 {min === max ? `${min}` : `${min}–${max}`} 个交易日</span>
      <span className="text-muted">
        ，约 {from}
        {from === to ? "" : ` 至 ${to}`}。从买入的下一个交易日数起，已跳过周末和 2026 年交易所休市。
      </span>
    </p>
  );
}

export function Stance({ phase, strategy }: { phase: SessionInfo; strategy: StrategyId }) {
  const savedAt = usePlan((state) => state.savedAt);
  const holdDays = usePlan((state) => state.holdDays);
  const exitRule = usePlan((state) => state.exitRule);
  const maxLoss = usePlan((state) => state.maxLoss);
  const save = usePlan((state) => state.save);
  const clear = usePlan((state) => state.clear);
  const saved = savedAt != null && exitRule.trim().length >= 4 && maxLoss > 0;
  const days = strategy === "early" ? null : resolveHold(strategy, holdDays);
  const [hold, setHold] = useState("20");
  const [exitText, setExitText] = useState("");
  const [loss, setLoss] = useState("8");
  const [note, setNote] = useState("");
  const windowText =
    phase.entry === "open"
      ? "现在是早盘买入时段（9:25–9:30）。"
      : phase.entry === "close"
        ? "现在是尾盘买入时段（14:40 以后）。"
        : "现在不是买入时段。";

  useEffect(() => {
    void usePlan.persist.rehydrate();
  }, []);

  function commit() {
    const customDays = Number(hold);
    const stop = Number(loss);
    if (strategy === "custom" && (!Number.isFinite(customDays) || customDays < 1)) {
      setNote("自定义要自己写持股天数，至少 1 个交易日。");
      return;
    }
    if (exitText.trim().length < 4) {
      setNote("写清什么情况下卖掉，至少几个字。");
      return;
    }
    if (!Number.isFinite(stop) || stop <= 0 || stop > 30) {
      setNote("最大亏损填 1 到 30 之间的百分数。");
      return;
    }
    save(strategy === "custom" ? Math.round(customDays) : (days ?? 0), exitText.trim(), stop);
    setNote("");
  }

  return (
    <section className="max-w-3xl rounded-lg border border-line bg-surface px-4 py-3 text-sm">
      <p className="font-medium">当前建议：空仓。</p>
      <p className="mt-2 text-pretty text-muted">
        买入只看两个时段：早盘 9:25–9:30，尾盘 14:40 以后到收盘。其他时间不要买。{windowText}
        只跟踪启动前期这一套，持股 5 到 10 个交易日。记满 60 个交易日之前，默认空仓。
      </p>
      <div className="mt-3">
        <HoldNote days={days} />
      </div>
      {saved ? (
        <div className="mt-3">
          <p>
            纪律：{exitRule}；亏损达到 {maxLoss}% 卖掉。
          </p>
          <button type="button" className="mt-3 h-11 rounded-md border border-line px-3" onClick={() => clear()}>
            清掉纪律
          </button>
        </div>
      ) : (
        <div className="mt-3 grid gap-3">
          <p className="text-pretty text-muted">卖出条件和止损要自己写。没写完，就保持空仓。</p>
          {strategy === "custom" ? (
            <label className="block">
              <span className="mb-1 block text-xs text-muted">自定义的预计持股（交易日）</span>
              <input className={field} inputMode="numeric" value={hold} onChange={(event) => setHold(event.target.value)} />
            </label>
          ) : null}
          <label className="block">
            <span className="mb-1 block text-xs text-muted">什么情况下卖</span>
            <input
              className={field}
              value={exitText}
              placeholder="例如：持有满这套策略的天数，或涨到买价的 15% 以上"
              onChange={(event) => setExitText(event.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted">亏损达到多少必须卖（%）</span>
            <input className={field} inputMode="decimal" value={loss} onChange={(event) => setLoss(event.target.value)} />
          </label>
          {note ? <p>{note}</p> : null}
          <button type="button" className="h-11 rounded-md bg-fg px-4 text-bg" onClick={commit}>
            只记下纪律，不买
          </button>
        </div>
      )}
    </section>
  );
}