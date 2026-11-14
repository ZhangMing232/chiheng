/**
 * 这个文件是干什么的：
 * 小机——常驻 agent（headless dsh）的桌宠浮层。旁观者形态：fixed 挂在应用根节点，
 * 不进任何面板、不占版面；AI 派活时它醒来播报，空闲时趴着睡觉，出事敲警报。
 *
 * 你需要知道的：
 * 1. 不编状态：五档全部来自 getAgentState 的真实账本（agent-jobs.json），
 *    没数据 = 睡觉。60 秒轮询一次（任务通常几分钟，60s 够跟）。
 * 2. 话少：只在换状态时更新气泡；睡觉时悬停才开口。
 * 3. 能关：右上角 × 隐藏本会话（localStorage chiheng-pet-off）；
 *    但 error 态压过隐藏——出事必须喊到人。
 * 4. 纯 SVG 零图片；配色全用主题变量（dark/light/摸鱼模式自动跟随）。
 * 5. 主人未登录时 getAgentState 回 allowed:false → 组件直接不渲染（访客看不到）。
 */

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, Link } from "@tanstack/react-router";
import { getAgentState } from "@/lib/market/quotes.functions";

type PetState = "sleep" | "calling" | "done" | "error" | "off";

type AgentStatePayload = {
  state: PetState;
  detail: string | null;
  runningTask: string | null;
  lastCost: number | null;
  jobsToday: number;
};

const HIDE_KEY = "chiheng-pet-off";
/** running 超过这个分钟数由服务端标 error；这里只管显示。 */
const POLL_MS = 60_000;

export function AgentPet() {
  const loc = useLocation();
  const [hidden, setHidden] = useState(true); // SSR 首帧不渲染，mount 后读 localStorage
  const [hover, setHover] = useState(false);
  const [lastState, setLastState] = useState<PetState | null>(null);

  useEffect(() => {
    try {
      setHidden(localStorage.getItem(HIDE_KEY) === "1");
    } catch {
      // localStorage 读不了（隐私模式）就默认显示
      setHidden(false);
    }
  }, []);

  const q = useQuery({
    queryKey: ["agent-pet-state"],
    queryFn: async (): Promise<AgentStatePayload | null> => {
      const res = await getAgentState();
      return res.allowed ? res.state : null;
    },
    refetchInterval: POLL_MS,
    staleTime: 30_000,
  });

  const st = q.data;

  // 换状态时清一次 hover——状态变了旧气泡就不该挂着
  useEffect(() => {
    if (st?.state && st.state !== lastState) {
      setLastState(st.state);
      setHover(false);
    }
  }, [st?.state, lastState]);

  if (!st) return null; // 访客 / 数据没到：整个不渲染

  const hide = hidden && st.state !== "error";
  if (hide) return null;

  const dismiss = () => {
    setHidden(true);
    try {
      localStorage.setItem(HIDE_KEY, "1");
    } catch { /* 隐私模式存不了就算了 */ }
  };

  // 气泡可见性：error/off 常驻；calling/done 悬停或 10 秒内新状态才显示；sleep 只悬停
  const bubbleVisible =
    st.state === "error" ||
    st.state === "off" ||
    (st.state !== "sleep" && (hover || Date.now() - (q.dataUpdatedAt ?? 0) < 10_000)) ||
    (st.state === "sleep" && hover);

  const goTo = st.state === "error" || st.state === "calling" || st.state === "done" ? "/ai/agent" : "/ai";

  return (
    <div
      className="fixed bottom-5 right-6 z-50 flex flex-col items-end gap-2"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {bubbleVisible && st.detail ? (
        <div className="relative max-w-[260px] rounded border border-line bg-surface px-3 py-2 shadow-pop">
          <p className="text-xs leading-relaxed text-muted">
          {st.state === "error" || st.state === "off" ? <span className="font-medium text-muted">{st.detail}</span> : st.detail}
          </p>
          <Link
            to={goTo}
            className="mt-1 inline-block text-[12px] text-brand-text underline decoration-dashed underline-offset-2"
          >
            {st.state === "error" ? "去处理 →" : "去岗位页 →"}
          </Link>
          {st.state !== "error" ? (
            <button
              type="button"
              aria-label="收起气泡"
              onClick={dismiss}
              className="absolute -top-2 -left-2 flex size-5 items-center justify-center rounded-full border border-line bg-surface text-[10px] text-muted hover:text-fg"
            >
              ×
            </button>
          ) : null}
        </div>
      ) : null}
      <button
        type="button"
        aria-label={`小机：${st.state === "sleep" ? "待命中" : st.state === "calling" ? "任务进行中" : st.state === "done" ? "刚完成任务" : st.state === "off" ? "已停用" : "异常"}`}
        onClick={() => setHover((h) => !h)}
        className="drop-shadow-[0_4px_0_rgba(0,0,0,0.4)] transition-transform hover:scale-105 active:scale-95"
      >
        <PetSvg state={st.state} />
      </button>
      {/* 屏幕阅读器的一句话状态（视觉隐藏） */}
      <span className="sr-only">
        {st.state === "sleep"
          ? `小机待命中。今日任务 ${st.jobsToday} 个。`
          : (st.detail ?? "")}
      </span>
      {/* loc 引用保留：将来按页面微调站位用（避免 lint 报未使用） */}
      <span className="hidden">{loc.pathname}</span>
    </div>
  );
}

/** 像素小机：四态一张 SVG。shape-rendering crispEdges，17×17 网格放 26 viewBox。 */
function PetSvg({ state }: { state: PetState }) {
  const eye =
    state === "sleep"
      ? "#1e2530" // 闭眼（暗线）
      : state === "calling"
        ? "var(--color-brand-text)"
        : state === "done"
          ? "var(--color-down)"
          : state === "off"
            ? "var(--color-muted)"
            : "var(--color-up)"; // error
  const accent = state === "error" ? "var(--color-up)" : state === "off" ? "var(--color-muted)" : "var(--color-brand-text)";
  const antenna = state === "sleep" ? "opacity-40" : state === "error" ? "pet-blink" : state === "off" ? "opacity-20" : "";
  return (
    <svg width="56" height="56" viewBox="0 0 26 26" aria-hidden="true">
      <g shapeRendering="crispEdges">
        {/* 天线 */}
        <rect x="6" y="4" width="2" height="2" fill={accent} className={antenna} />
        <rect x="18" y="4" width="2" height="2" fill={accent} className={antenna} />
        {/* 头 */}
        <rect x="7" y="6" width="12" height="10" fill="var(--color-surface-2)" stroke="var(--color-line)" />
        {/* 眼 */}
        {state === "sleep" ? (
          <>
            <rect x="9" y="10" width="2" height="1" fill={eye} />
            <rect x="15" y="10" width="2" height="1" fill={eye} />
          </>
        ) : state === "error" ? (
          <>
            <rect x="9" y="8" width="2" height="3" fill={eye} className="pet-blink" />
            <rect x="15" y="8" width="2" height="3" fill={eye} className="pet-blink" />
            <rect x="10" y="13" width="6" height="1" fill={eye} />
          </>
        ) : (
          <>
            <rect x="9" y="9" width="2" height="2" fill={eye} className="pet-blink" />
            <rect x="15" y="9" width="2" height="2" fill={eye} className="pet-blink" />
            <rect x="11" y="13" width="4" height="1" fill={eye} />
          </>
        )}
        {/* 身体 */}
        <rect x="9" y="17" width="2" height="4" fill="var(--color-surface-2)" stroke="var(--color-line)" />
        <rect x="15" y="17" width="2" height="4" fill="var(--color-surface-2)" stroke="var(--color-line)" />
        {/* calling：右手举扳手（lime 色块） */}
        {state === "calling" ? (
          <>
            <rect x="19" y="10" width="4" height="2" fill="var(--color-gold)" className="pet-arm" />
            <rect x="19" y="12" width="1" height="3" fill="var(--color-gold)" className="pet-arm" />
          </>
        ) : null}
        {/* sleep：Zzz */}
        {state === "sleep" ? (
          <text x="20" y="8" fontSize="6" fill="var(--color-muted)" fontFamily="var(--font-mono, monospace)" className="pet-zzz">z</text>
        ) : null}
      </g>
    </svg>
  );
}
