/**
 * 这个文件是干什么的：
 * 点一下就滑出个股抽屉的股票名。**四个页面共用这一个**。
 *
 * 你需要知道的：
 * 1. **为什么要有这个抽象**：PPT 的核心交互是「点任意股票名 → 右侧滑出抽屉、不离开
 *    当前页」。而现状是四个页面各写各的——选股页有真抽屉、持仓页是整页跳转、
 *    资金页和消息页的股票名是**纯 div，点了什么都不会发生**。
 *    不抽出来的话，新增页面的人根本不知道「股票名应该用这个」，然后又写一个死 div。
 * 2. **渲染成 button 但不带按钮外观**。用 button 是为了键盘和读屏器能聚焦；
 *    视觉上保持原来那个「一行蓝字」的样式，所以调用方可以照原样传 className。
 * 3. **id 拿不到就退化成普通文字**，不渲染一个点了没反应的按钮——那比纯文字更糟，
 *    用户会以为页面卡了。
 */
import { useSymbolUi, type SymbolSource } from "@/lib/ui/symbol-store";

export function StockName({
  id,
  name,
  source,
  className = "",
  title,
}: {
  /** 带市场前缀的股票 id（sh600519）。null 时只渲染文字，不给点击。 */
  id: string | null;
  name: string;
  /** 从哪个页面点开的。抽屉据此决定内容区块的顺序。 */
  source: SymbolSource;
  className?: string;
  title?: string;
}) {
  const open = useSymbolUi((state) => state.open);

  if (!id) {
    return (
      <span className={className} title={title}>
        {name}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => open(id, source)}
      title={title ?? "点开看详情"}
      className={`cursor-pointer text-left hover:text-brand-text hover:underline ${className}`}
    >
      {name}
    </button>
  );
}