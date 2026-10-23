/**
 * 这个文件是干什么的：
 * 「提醒」收件箱页（对标 Vibe-Research 的 Inbox，只做消息列表那一块）。
 *
 * 它的 Inbox 有两块：定时任务管理 + 消息列表。赤轨的定时任务只有一个
 * （收盘后核对自选旧预警，写死在记账进程里），没有管理需求，所以这块不做——
 * 本页聚焦消息：哪些预警应验了、哪些天没跑成。
 *
 * 你需要知道的（照它 notify.ts 的纪律，原样说给用户）：
 * - **只在服务运行时更新**：电脑关机、服务没开就不会有新提醒；
 *   当天再打开时，过了时刻还没跑的任务会补跑一次。
 * - **门判定取不到时不跑**：行情拉不到的那天，收件箱里会有一条「没跑成」的说明，
 *   而不是一条看着正常实际是猜的告警。
 * - data/alerts.json 不在 git 里，换机器就是空箱。
 */

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Frame } from "@/components/screener/nav";
import { Panel, Tag, thClass, tdClass } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { getAlerts } from "@/lib/market/alerts.functions";
import { ALERT_INBOX_LIMIT } from "@/lib/market/alerts";
import type { Alert } from "@/lib/market/alerts";

export const Route = createFileRoute("/inbox")({
  loader: () => getAlerts(),
  component: InboxPage,
});

/** 已读水位：只记「读到过的最新一条 id」，比它旧的都算已读（和它 inbox 的未读计数同思路）。 */
const READ_KEY = "chiheng-alert-read-at";

function readMark(): string {
  try {
    return localStorage.getItem(READ_KEY) ?? "";
  } catch {
    return "";
  }
}

function markRead(id: string) {
  try {
    localStorage.setItem(READ_KEY, id);
  } catch {
    // 隐私模式下 localStorage 会抛，读不到就不记，不影响看列表
  }
}

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso.slice(0, 10);
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return iso.slice(0, 10);
}

const KIND_TAG: Record<Alert["kind"], { text: string; tone: "brand" | "warn" | "muted" }> = {
  triggered: { text: "预警应验", tone: "brand" },
  failed: { text: "当天没跑成", tone: "warn" },
};

function InboxPage() {
  const rows = Route.useLoaderData();
  const [mark, setMark] = useState(readMark);
  useEffect(() => {
    setMark(readMark());
  }, [rows]);

  const unread = rows.filter((r) => r.at > mark && r.id !== mark).length;

  return (
    <Frame
      aside="提醒"
      status={{
        label: "未读",
        // **真实数据**：unread 是本页已有的算法（比 readMark 水位新）。
        value: rows.length > 0 ? `${unread} 条` : null,
        tone: unread > 0 ? "brand" : "neutral",
      }}
    >
      <Panel
        title="收件箱"
        note={`${rows.length} 条${unread > 0 ? ` · ${unread} 条未读` : ""}${rows.length >= ALERT_INBOX_LIMIT ? ` · 已满 ${ALERT_INBOX_LIMIT} 条，最旧的被砍` : ""}`}
      >
        <div className="flex items-center gap-2 border-b border-line px-3.5 py-2">
          <button
            type="button"
            onClick={() => {
              markRead(rows[0]?.id ?? "");
              setMark(rows[0]?.id ?? "");
            }}
            className="rounded border border-line px-2.5 py-1 text-xs text-muted transition hover:text-fg disabled:opacity-40"
            disabled={rows.length === 0}
          >
            全部标为已读
          </button>
          <span className="text-[11px] text-muted">
            只在服务运行时更新：电脑关机、服务没开就不会有新提醒；行情拉不到的那天会收到「没跑成」说明，不会收到猜的告警。
          </span>
        </div>

        {rows.length === 0 ? (
          <StateBlock
            kind="empty"
            title="收件箱还是空的"
            hint="把股票加进自选（自选与持仓页）并跑过一次个股研判，收盘后记账进程会自动核对上次的预警——应验了就进来。数据在 data/alerts.json，不在 git 里。"
          />
        ) : (
          <table className="data-table w-full">
            <caption className="sr-only">收件箱：自选股的旧预警应验提醒与当天没跑成的说明</caption>
            <thead>
              <tr className="border-b border-line">
                <th className={thClass()}>类型</th>
                <th className={thClass("text-left")}>标题</th>
                <th className={thClass("text-left")}>详情</th>
                <th className={thClass()}>时间</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const tag = KIND_TAG[r.kind];
                const isUnread = r.at > mark && r.id !== mark;
                return (
                  <tr key={r.id} className={"border-b border-line/60 " + (isUnread ? "bg-brand-soft/30" : "")}>
                    <td className={tdClass()}>
                      <Tag tone={tag.tone}>{tag.text}</Tag>
                    </td>
                    <td className={tdClass("text-left")}>
                      <span className={isUnread ? "font-medium text-fg" : "text-muted"}>{r.title}</span>
                    </td>
                    <td className={tdClass("text-left max-w-[40ch]")}>{r.detail}</td>
                    <td className={tdClass("whitespace-nowrap")} title={r.at}>
                      {relTime(r.at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>
    </Frame>
  );
}
