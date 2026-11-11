/**
 * 这个文件是干什么的：
 * 「页面在后台就别轮询了」——一个布尔值 + 一个定时器封装。
 *
 * 为什么要有：
 * 顶栏铃铛、选股页、挑战者看板都在按 60s 拉数据。用户切到别的窗口（或者把
 * 标签页扔在后台开一下午），这些请求照发不误，白烧接口配额和电。参考连板网
 * 的做法：所有轮询都挂在 visibilitychange 上，看不见就不发。
 *
 * 用法：
 *   const visible = usePageVisible();
 *   useQuery({ ..., refetchInterval: visible ? 60_000 : false });
 *   // 或者自己起定时器：
 *   useVisibleInterval(pull, 60_000);
 *
 * 注意 SSR：服务端没有 document，初始值给 true，保证首屏照常取一次数据；
 * 挂载后 effect 立刻按真实可见性纠正。不要反过来（初值 false）——那会让
 * 首屏永远不发请求。
 */
import { useEffect, useRef, useState } from "react";

/** 页面当前是否可见。SSR 阶段一律 true，挂载后再按真实值纠正。 */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const read = () => setVisible(document.visibilityState !== "hidden");
    read();
    document.addEventListener("visibilitychange", read);
    return () => document.removeEventListener("visibilitychange", read);
  }, []);
  return visible;
}

/**
 * 只在页面可见时跑的定时器。页面隐藏期间不累积、不补跑——
 * 回到前台时等下一个周期即可，不要立刻补一发（那会在切回来的一瞬间打出一串请求）。
 */
export function useVisibleInterval(fn: () => void, ms: number | null): void {
  const visible = usePageVisible();
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (ms == null || !visible) return;
    const timer = window.setInterval(() => saved.current(), ms);
    return () => window.clearInterval(timer);
  }, [ms, visible]);
}
