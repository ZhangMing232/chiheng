/**
 * 微信推送配置（PushPlus）。2026-11-13 从顶栏铃铛搬到 /settings。
 *
 * 为什么搬：铃铛（AlertBell）和「消息与提醒」页一起下线了，这个组件当时挂在铃铛里，
 * 就成了没有入口的死代码。推送配置属于「设置」，不该藏在提醒抽屉里。
 *
 * 只给主人账号显示——推送只在主人账本上触发，别人配了也收不到。
 * 填新 token 覆盖旧的；留空点保存 = 关闭微信推送（回到只发 Mac 通知）。
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getPushStatus, savePushConfig } from "@/lib/market/quotes.functions";

export function PushConfig() {
  const { data } = useQuery({ queryKey: ["push-status"], queryFn: () => getPushStatus() });
  const [token, setToken] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  if (!data?.allowed) return null;
  const save = async () => {
    try {
      const res = await savePushConfig({ data: { token } });
      setMessage(res.configured ? `已保存，尾号 ${res.tail ?? ""}`.trim() : "已关闭微信推送");
      setToken("");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存失败");
    }
  };
  return (
    <div className="border-t border-line px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="shrink-0 text-xs font-medium text-muted">微信推送（PushPlus）</span>
        <span className="truncate text-xs text-muted">
          {data.configured ? `已配置 · 尾号 ${data.tail}` : "未配置"}
        </span>
      </div>
      <div className="mt-1.5 flex gap-1.5">
        <input
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder={data.configured ? "填新 token 替换，留空保存可关闭" : "粘贴 PushPlus token"}
          className="min-w-0 flex-1 rounded border border-line bg-surface px-2 py-1 text-xs text-fg outline-none placeholder:text-muted focus:border-brand"
        />
        <button
          type="button"
          onClick={() => void save()}
          className="shrink-0 rounded bg-brand px-2.5 py-1 text-xs font-medium text-white transition hover:opacity-90"
        >
          保存
        </button>
      </div>
      {message ? <p className="mt-1 text-xs text-muted">{message}</p> : null}
    </div>
  );
}