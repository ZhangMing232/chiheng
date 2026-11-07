/**
 * 当前时刻的水合安全处理。
 *
 * 问题：相对时间（「3 小时前」「X 分钟前」）依赖"现在"。若在组件 render 里直接调
 * Date.now()，服务端渲染时刻 ≠ 客户端 hydration 时刻，文本对不上 → React #418
 * 水合不一致（控制台报错，smoke 测试直接红）。
 *
 * 解法：useMountedNow —— SSR 与首屏 hydration 期间返回 null（完全不读系统时钟），
 * 挂载（useEffect）后才返回真实 Date.now()。这样 SSR 与 hydration 看到的是同一个
 * 稳定值（null），没有时刻差；相对时间只在 hydration 之后才算出，不进入水合比较。
 *
 * 另一种做法是让 loader 下发 serverNow（见 routes/index.tsx），两者都正确：
 * 有现成 loader 对象的页面直接下发 serverNow 更省事；没有 loader 上下文的共享组件
 * （如 DataStatusBadge、StaleBadge）用本 hook。
 */
import { useEffect, useState } from "react";

/** 挂载后才返回真实 Date.now()；SSR 与首屏 hydration 期间返回 null。 */
export function useMountedNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
  }, []);
  return now;
}
