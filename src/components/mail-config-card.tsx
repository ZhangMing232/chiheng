/**
 * 这个文件是干什么的：
 * 「每日复盘日报」的配置卡片，出现在 /settings 页顶部和铃铛抽屉「通知设置」里。
 *
 * 2026-11-07 改版：日报不再强绑定邮箱。用户没有 SMTP 授权码，但早就配好了
 * PushPlus 微信推送 —— 默认走微信，不用填任何东西；邮箱变成**可选的第二通道**，
 * 收在折叠里，不占首屏。
 *
 * 纪律：
 * - 授权码只进不出：输入框永远空（placeholder 只显示尾号），保存后立刻清空；
 *   服务端只回尾四位，完整值不进浏览器、不进任何会话。
 * - 保存立即生效：记账进程每分钟直读同一个文件，不用重启服务。
 * - 表单初值来自 loader/query，不在 render 里读系统时钟（#418 纪律）。
 */

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Panel } from "@/components/terminal";
import { useMountedNow } from "@/lib/ui/relative-time";
import { getMailStatus, saveMailConfig, sendTestMail } from "@/lib/market/mail.functions";
import type { MailConfigStatus } from "@/lib/market/mail-config-store";

const INPUT_CLS =
  "min-w-0 w-full rounded border border-line bg-surface px-2.5 py-1.5 text-xs text-fg outline-none placeholder:text-muted focus:border-brand";
const BTN_CLS =
  "shrink-0 rounded border border-line bg-surface px-3 py-1.5 text-xs text-muted transition hover:text-fg disabled:opacity-50";
const PRIMARY_CLS =
  "shrink-0 rounded bg-brand px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-50";

// 不 import daily-digest 的类型：那个文件只活服务端，前端组件连 type-only 边都别搭。
const CHANNEL_CN: Record<string, string> = { wechat: "微信", mail: "邮件" };

function splitTo(raw: string): string[] {
  return raw.split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean);
}

type MailStatusResponse = Awaited<ReturnType<typeof getMailStatus>>;
type CardStatus = MailConfigStatus & { pushConfigured: boolean; lastDelivery: string | null };

export function MailConfigCard({
  initial,
  clientOnly = false,
}: {
  initial: MailStatusResponse | null;
  /** 没有 loader 数据的实例（铃铛抽屉）：SSR/hydration 统一占位，挂载后才读真实状态。
   *  否则两个实例共用 ["mail-status"] 缓存，服务端和客户端读到的初始值不同 → #418。 */
  clientOnly?: boolean;
}) {
  // initialData 来自 route loader：SSR 首屏就有内容，不会先闪一句「读不出来」；
  // 保存后 invalidate 会重新拉，不会被这个初值盖回去。
  const mountedNow = useMountedNow();
  const { data, isError } = useQuery({
    queryKey: ["mail-status"],
    queryFn: () => getMailStatus(),
    initialData: initial ?? undefined,
  });

  if (clientOnly && mountedNow == null) {
    return (
      <Panel title="每日复盘日报" note="每个交易日收盘后一份">
        <p className="px-3.5 py-3 text-sm text-muted">正在读取配置状态…</p>
      </Panel>
    );
  }

  if (!data) {
    return (
      <Panel title="每日复盘日报" note="每个交易日收盘后一份">
        <p className="px-3.5 py-3 text-sm text-muted">
          {isError ? "配置状态读不出来——多半是服务没在跑。" : "正在读取配置状态…"}
        </p>
      </Panel>
    );
  }
  if (!data.allowed) {
    return (
      <Panel title="每日复盘日报" note="仅主人可配">
        <p className="px-3.5 py-3 text-sm text-muted">这项配置只有主人账号能改和发测试日报。</p>
      </Panel>
    );
  }
  // 「发送状态」只认确定性来源：/settings 实例用 loader 下发的值（SSR/hydration 同一个），
  // 抽屉实例挂载后才从 query 取。绝不依赖 useQuery 在 hydration 期间的 refetch ——
  // 那段刚从磁盘读出来的动态值差一拍就会 #418（2026-11-08 实测踩到）。
  const deliveryLine = clientOnly
    ? (mountedNow != null && data?.allowed ? data.lastDelivery : null)
    : (initial?.allowed ? initial.lastDelivery : null);
  // 不用 key 强制重挂载：保存后 invalidate 会更新 status，重挂载会把「已保存」提示
  // 和刚清空的表单状态一起冲掉。表单本来就由用户输入主导，不需要服务端回显覆盖。
  return <MailForm status={data} deliveryLine={deliveryLine} />;
}

function MailForm({ status, deliveryLine }: { status: CardStatus; deliveryLine: string | null }) {
  const qc = useQueryClient();
  const [user, setUser] = useState(status.user);
  const [pass, setPass] = useState("");
  const [to, setTo] = useState(status.to.join(", "));
  const [host, setHost] = useState(status.host);
  const [port, setPort] = useState(String(status.port));
  const [secure, setSecure] = useState(status.secure);
  const [from, setFrom] = useState(status.from);
  const [busy, setBusy] = useState<"save" | "test" | "disable" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const channels: string[] = [];
  if (status.pushConfigured) channels.push("微信推送");
  if (status.configured) channels.push("邮件");
  const channelLabel = channels.length > 0 ? channels.join(" + ") : "未配置通道";
  const anyChannel = status.pushConfigured || status.configured;

  const input = () => ({
    host: host.trim() || "smtp.qq.com",
    port: Number(port),
    secure,
    user: user.trim(),
    pass: pass.trim(),
    to: splitTo(to),
    from: from.trim(),
    timeoutMs: null,
  });

  const save = async () => {
    setBusy("save");
    setMessage(null);
    try {
      const res = await saveMailConfig({ data: input() });
      setPass("");
      await qc.invalidateQueries({ queryKey: ["mail-status"] });
      setMessage(res.configured ? `邮箱已保存 · 授权码尾号 ${res.tail ?? ""}`.trim() : "邮箱配置已清空");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy(null);
    }
  };

  const disable = async () => {
    setBusy("disable");
    setMessage(null);
    try {
      await saveMailConfig({ data: { ...input(), disable: true } });
      setPass("");
      await qc.invalidateQueries({ queryKey: ["mail-status"] });
      setMessage("邮箱通道已清除（微信推送不受影响）");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "清除失败");
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    setMessage(null);
    try {
      const res = await sendTestMail();
      if (res.sent) {
        const names = res.channels.map((c) => CHANNEL_CN[c] ?? c).join("+");
        setMessage(`测试日报已发出（${names}），去看看`);
      } else {
        setMessage(`没发出去：${res.reason ?? "未知原因"}`);
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "测试发送失败");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel title="每日复盘日报" note={channelLabel}>
      <div className="flex flex-col gap-3 px-3.5 py-3">
        <p className="text-[12px] leading-relaxed text-muted">
          每个交易日收盘封印后自动发一份：今日诊断、挑战者战况、明日验证。
          {status.pushConfigured
            ? "当前走微信推送（已配好，不需要邮箱、不需要授权码），你什么都不用填。"
            : "当前没有生效通道：可在铃铛抽屉「通知设置」填 PushPlus token，或展开下面填邮箱。"}
        </p>

        <p className={deliveryLine?.includes("失败") ? "text-[12px] text-warn" : "text-[12px] text-muted"}>
          {deliveryLine
            ? `发送状态：${deliveryLine}`
            : "还没发过正式日报：每个交易日收盘封印后自动发第一封，发完这里会显示时间和通道。"}
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void test()} disabled={busy !== null || !anyChannel} className={PRIMARY_CLS}>
            {busy === "test" ? "发送中…" : "发测试日报"}
          </button>
          {message ? <span className="text-[12px] text-fg">{message}</span> : null}
        </div>

        <details className="text-[12px] text-muted">
          <summary className="cursor-pointer select-none">
            {status.configured ? "可选：邮箱通道已配置（点开修改）" : "可选：改用 / 追加邮箱接收（需要 SMTP 授权码）"}
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span>发件邮箱</span>
                <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="you@qq.com" className={INPUT_CLS} />
              </label>
              <label className="flex flex-col gap-1">
                <span>SMTP 授权码（不是登录密码）</span>
                <input
                  type="password"
                  value={pass}
                  onChange={(e) => setPass(e.target.value)}
                  placeholder={status.tail ? `留空 = 不改（当前尾号 ${status.tail}）` : "粘贴授权码"}
                  autoComplete="new-password"
                  className={INPUT_CLS}
                />
              </label>
            </div>
            <label className="flex flex-col gap-1">
              <span>收件人（多个用逗号分隔）</span>
              <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="you@qq.com" className={INPUT_CLS} />
            </label>
            <details className="text-[12px] text-muted">
              <summary className="cursor-pointer select-none">服务器设置（QQ 邮箱一般不用改）</summary>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <span>SMTP 服务器</span>
                  <input value={host} onChange={(e) => setHost(e.target.value)} className={INPUT_CLS} />
                </label>
                <label className="flex flex-col gap-1">
                  <span>端口（465 直连 / 587 STARTTLS）</span>
                  <input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" className={INPUT_CLS} />
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={secure} onChange={(e) => setSecure(e.target.checked)} />
                  <span>TLS 直连（465 勾选；587 不勾）</span>
                </label>
                <label className="flex flex-col gap-1">
                  <span>from（留空默认用发件邮箱）</span>
                  <input value={from} onChange={(e) => setFrom(e.target.value)} className={INPUT_CLS} />
                </label>
              </div>
            </details>
            <p className="leading-relaxed">
              授权码只存服务端，页面不回显完整值。填了就微信 + 邮件都发，不填也照常收。
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => void save()} disabled={busy !== null} className={BTN_CLS}>
                {busy === "save" ? "保存中…" : "保存邮箱配置"}
              </button>
              <button type="button" onClick={() => void disable()} disabled={busy !== null || !status.configured} className={BTN_CLS}>
                {busy === "disable" ? "清除中…" : "清除邮箱配置"}
              </button>
            </div>
          </div>
        </details>
      </div>
    </Panel>
  );
}
