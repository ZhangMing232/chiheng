/**
 * 这个文件是干什么的：
 * /settings 页的「每日复盘邮件」配置卡片。以前要手改 data/mail-config.json，
 * 现在在这张卡里填就行——普通用户只需要填发件邮箱 / 授权码 / 收件人三项，
 * QQ 邮箱的 smtp.qq.com:465 已给默认值，高级项折叠在「服务器设置」里。
 *
 * 纪律：
 * - 授权码只进不出：输入框永远是空的（placeholder 只显示尾号），保存后立刻清空；
 *   服务端也只回尾四位，完整值不进浏览器、不进任何会话。
 * - 保存立即生效：record-journal 每分钟直读同一个文件，不用重启服务。
 * - 表单初值来自 loader/query，不在 render 里读系统时钟（#418 纪律）。
 */

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Panel } from "@/components/terminal";
import { getMailStatus, saveMailConfig, sendTestMail } from "@/lib/market/mail.functions";
import type { MailConfigStatus } from "@/lib/market/mail-config-store";

const INPUT_CLS =
  "min-w-0 w-full rounded border border-line bg-surface px-2.5 py-1.5 text-xs text-fg outline-none placeholder:text-muted focus:border-brand";
const BTN_CLS =
  "shrink-0 rounded border border-line bg-surface px-3 py-1.5 text-xs text-muted transition hover:text-fg disabled:opacity-50";
const PRIMARY_CLS =
  "shrink-0 rounded bg-brand px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-50";

function splitTo(raw: string): string[] {
  return raw.split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean);
}

type MailStatusResponse = Awaited<ReturnType<typeof getMailStatus>>;

export function MailConfigCard({ initial }: { initial: MailStatusResponse | null }) {
  // initialData 来自 route loader：SSR 首屏就有表单，不会先闪一句「读不出来」；
  // 保存后 invalidate 会重新拉，不会被这个初值盖回去。
  const { data } = useQuery({
    queryKey: ["mail-status"],
    queryFn: () => getMailStatus(),
    initialData: initial ?? undefined,
  });

  if (!data) {
    return (
      <Panel title="每日复盘邮件" note="每个交易日收盘后一封">
        <p className="px-3.5 py-3 text-sm text-muted">配置状态读不出来——多半是服务没在跑。</p>
      </Panel>
    );
  }
  if (!data.allowed) {
    return (
      <Panel title="每日复盘邮件" note="仅主人可配">
        <p className="px-3.5 py-3 text-sm text-muted">这项配置只有主人账号能改和发测试邮件。</p>
      </Panel>
    );
  }
  // 不用 key 强制重挂载：保存后 invalidate 会更新 status，重挂载会把「已保存」提示
  // 和刚清空的表单状态一起冲掉。表单本来就由用户输入主导，不需要服务端回显覆盖。
  return <MailForm status={data} />;
}

function MailForm({ status }: { status: MailConfigStatus }) {
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
      setMessage(res.configured ? `已保存 · 授权码尾号 ${res.tail ?? ""}`.trim() : "已停用每日邮件");
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
      setMessage("已停用：授权码和收件人已清空，收盘不再发信");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "停用失败");
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    setMessage(null);
    try {
      const res = await sendTestMail();
      setMessage(res.sent ? "测试邮件已发出，去收件箱看看" : `没发出去：${res.reason ?? "未知原因"}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "测试发送失败");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel
      title="每日复盘邮件"
      note={status.configured ? `已配置 · 授权码尾号 ${status.tail ?? ""}`.trim() : "未配置"}
    >
      <div className="flex flex-col gap-3 px-3.5 py-3">
        <p className="text-[11px] leading-relaxed text-muted">
          每个交易日收盘封印后自动发一封：今日诊断、挑战者战况、明日验证。保存后立即生效，不用重启。
          授权码只存服务端，这个页面不会回显完整值。
        </p>

        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-muted">发件邮箱（QQ 邮箱）</span>
            <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="you@qq.com" className={INPUT_CLS} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-muted">SMTP 授权码（16 位，不是登录密码）</span>
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
          <span className="text-[11px] text-muted">收件人（多个用逗号分隔）</span>
          <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="you@qq.com" className={INPUT_CLS} />
        </label>

        <details className="text-[11px] text-muted">
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

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void save()} disabled={busy !== null} className={PRIMARY_CLS}>
            {busy === "save" ? "保存中…" : "保存"}
          </button>
          <button type="button" onClick={() => void test()} disabled={busy !== null || !status.configured} className={BTN_CLS}>
            {busy === "test" ? "发送中…" : "发测试邮件"}
          </button>
          <button type="button" onClick={() => void disable()} disabled={busy !== null || !status.configured} className={BTN_CLS}>
            {busy === "disable" ? "停用中…" : "停用"}
          </button>
          {message ? <span className="text-[11px] text-fg">{message}</span> : null}
        </div>
      </div>
    </Panel>
  );
}
