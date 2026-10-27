/**
 * 这个文件是干什么的：
 * 「设置与状态」页——回答三个问题：系统现在什么状态、配置现在是什么值、哪些数据旧了怎么补。
 *
 * 对标 Vibe-Research 的设置收拢（它的配置散在多处，这页把它们收到一处）。
 * 但**这一页不做设置表单**：改规则在策略选股页、改 AI 档案在 /ai。这里只读展示。
 * 摆一堆跳转链接看着整齐，实际什么也没回答。
 *
 * 你需要知道的：
 * 1. **「必需项没有」和「过期」分开说**。前者是真问题（页面开不了、记账不发生），
 *    后者只是该重抓。原因不同，混成一句「数据有问题」会让人查错方向。
 * 2. **每份数据都写着怎么补**（真命令，不是「联系管理员」）。
 * 3. 配置值只读，每项标「在哪儿改」，别让人以为在这儿改了能存。
 * 4. 这一页不给买卖建议，也不预测——它只是把现状摆出来。
 */

import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Panel, Stat, Tag, thClass, tdClass } from "@/components/terminal";
import { GapList } from "@/components/source-line";
import { getSettings } from "@/lib/market/settings.functions";
import { sourceLabel } from "@/lib/market/data-status";
import { snapshotAge } from "@/lib/market/format";
import type { Universe } from "@/lib/market/types";

export const Route = createFileRoute("/settings")({
  loader: () => getSettings().catch(() => null),
  component: SettingsPage,
});

function SettingsPage() {
  const data = Route.useLoaderData();

  if (!data) {
    return (
      <Frame wide aside="设置">
        <Panel title="设置与状态" note="没读到">
          <p className="px-3.5 py-3 text-sm text-muted">状态读不出来。多半是服务没在跑——这一页全是本机状态，服务不跑就没有。</p>
        </Panel>
      </Frame>
    );
  }

  const { recorder, universe, files, missing, config, gaps } = data;
  const beat = recorder.at ? snapshotAge(recorder.at) : null;
  const stale = files.filter((f) => f.state === "stale");

  return (
    <Frame wide
      aside="设置"
      status={{
        label: "数据源",
        // **真实数据**：files 里各数据源的状态。missing 是缺失的、
        // stale 是过期的——两个都是"不健康"，所以分开报。
        value: files.length > 0 ? `${files.length - stale.length} / ${files.length} 正常` : null,
        tone: stale.length > 0 || missing.length > 0 ? "warn" : "ok",
      }}
      ornamentContent={
        missing.length > 0 ? (
          <span className="text-[11px] text-warn">缺 {missing.length} 项数据源</span>
        ) : stale.length > 0 ? (
          <span className="text-[11px] text-warn">{stale.length} 项已过期</span>
        ) : (
          <span className="text-[11px]">所有数据源都是新的</span>
        )
      }
    >
      <Panel title="系统状态" note={beat ? `记账心跳 ${beat}` : "没有心跳"}>
        <div className="grid grid-cols-2 gap-3 px-3.5 py-3 sm:grid-cols-4">
          <Stat label="记账进程" value={recorder.ok ? "正常" : "异常"} hint={beat ?? "从没记过账"} />
          <Stat
            label="行情快照"
            value={universe.count > 0 ? `${universe.count} 只` : "没有"}
            hint={universe.ageMin == null ? "读不到" : `${universe.ageMin} 分钟前`}
          />
          <Stat label="数据源" value={universe.source ? sourceLabel(universe.source as Universe["source"]) : "—"} hint={universe.source === "sina" ? "备源（字段有缺）" : "主源"} />
          <Stat label="缺的数据" value={missing.length === 0 ? "不缺" : `${missing.length} 项`} hint={missing.length === 0 ? "都能开" : missing.map((m) => m.label).join("、")} />
        </div>
        {gaps.length > 0 ? <GapList items={gaps} title="现在的问题" /> : null}
      </Panel>

      <Panel title="配置现状" note="只读展示，改的地方都标了">
        <table className="data-table w-full">
          <caption className="sr-only">当前配置值与修改入口</caption>
          <thead>
            <tr className="border-b border-line">
              <th className={thClass("text-left")}>配置</th>
              <th className={thClass("text-left")}>当前值</th>
              <th className={thClass("text-left")}>在哪改</th>
            </tr>
          </thead>
          <tbody>
            {config.map((row) => (
              <tr key={row.label} className="border-b border-line/60">
                <td className={tdClass("text-left text-muted")}>{row.label}</td>
                <td className={tdClass("text-left")}>{row.value}</td>
                <td className={tdClass("text-left text-muted")}>{row.where}</td>
              </tr>
            ))}
            <tr className="border-b border-line/60">
              <td className={tdClass("text-left text-muted")}>AI 接入</td>
              <td className={tdClass("text-left")}>接口配置、进化控制台、Token 用量</td>
              <td className={tdClass("text-left text-muted")}>
                <a href="/ai" className="underline decoration-line underline-offset-2 hover:text-fg">
                  接入 AI
                </a>
              </td>
            </tr>
            <tr className="border-b border-line/60">
              <td className={tdClass("text-left text-muted")}>微信推送</td>
              <td className={tdClass("text-left")}>预警推送（到卖出价/止损/到期）</td>
              <td className={tdClass("text-left text-muted")}>
                <a href="/review/flow/" className="underline decoration-line underline-offset-2 hover:text-fg">
                  资金页顶部
                </a>
              </td>
            </tr>
          </tbody>
        </table>
        <p className="px-3.5 py-2 text-[11px] text-muted">
          这一页只读。要改值去它右边写的那一页改——在这儿改不会存。
        </p>
      </Panel>

      <Panel title="数据新鲜度" note={`${files.length} 份 · 过期 ${stale.length} · 缺 ${missing.length}`}>
        <table className="data-table w-full">
          <caption className="sr-only">本机数据文件的大小、最后更新时间和怎么补</caption>
          <thead>
            <tr className="border-b border-line">
              <th className={thClass("text-left")}>数据</th>
              <th className={thClass()}>大小</th>
              <th className={thClass("text-left")}>状态</th>
              <th className={thClass("text-left")}>怎么补</th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.label} className="border-b border-line/60">
                <td className={tdClass("text-left")}>
                  <span className="text-fg">{f.label}</span>
                  {f.required ? <span className="ml-1.5 text-[11px] text-muted">必需</span> : null}
                </td>
                <td className={tdClass("text-right text-muted")}>{f.sizeKb == null ? "—" : `${f.sizeKb} KB`}</td>
                <td className={tdClass("text-left")}>
                  <Tag tone={f.state === "ok" ? "muted" : f.state === "na" ? "muted" : "warn"}>{f.note}</Tag>
                </td>
                <td className={tdClass("text-left text-muted")}>
                  <code className="text-[11px]">{f.refresh}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="px-3.5 py-2 text-[11px] text-muted">
          「没抓过」和「过期」不是一回事：前者是某份数据压根没跑过脚本，后者是跑过但太旧了。
          必需项没有会真出不来东西（页面开不了、记账不发生），其余的只影响相关页面。
        </p>
      </Panel>
    </Frame>
  );
}