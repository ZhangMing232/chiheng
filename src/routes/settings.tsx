/**
 * 这个文件是干什么的：
 * 「设置与状态」页——回答三个问题：系统现在什么状态、配置现在是什么值、哪些数据旧了怎么补。
 *
 * 对标 Vibe-Research 的设置收拢（它的配置散在多处，这页把它们收到一处）。
 * 例外（2026-11-07）：**每日复盘日报在这页有配置卡片**。日报默认走已配好的
 * 微信推送（不需要邮箱授权码），邮箱只是可选的第二通道；让人打开 data/ 手改
 * JSON 不是产品该有的样子——表单 POST 到服务端写盘，授权码只进不出、只回尾号。
 * 其余配置仍是只读展示（改选股规则在策略页、改 AI 档案在 /ai、推送在铃铛里）。
 * 摆一堆跳转链接看着整齐，实际什么也没回答。
 *
 * 你需要知道的：
 * 1. **「必需项没有」和「过期」分开说**。前者是真问题（页面开不了、记账不发生），
 *    后者只是该重抓。原因不同，混成一句「数据有问题」会让人查错方向。
 * 2. 每份数据都写清它是干什么用的、要不要紧；手动重抓命令收在「给开发者」
 *    折叠里，不摆在普通用户眼前（2026-11-07 用户视角走查）。
 * 3. 除邮件配置外，配置值只读，每项标「在哪儿改」，别让人以为在这儿改了能存。
 * 4. 这一页不给买卖建议——它把现状摆出来。前瞻判断统一走首页与题材页，
 *    并逐条标注证据等级，不冒充确定结论。
 */

import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Panel, Stat, Tag, thClass, tdClass } from "@/components/terminal";
import { GapList } from "@/components/source-line";
import { MailConfigCard } from "@/components/mail-config-card";
import { getSettings } from "@/lib/market/settings.functions";
import { getMailStatus } from "@/lib/market/mail.functions";
import { sourceLabel } from "@/lib/market/data-status";
import { snapshotAgeSince } from "@/lib/market/format";
import type { Universe } from "@/lib/market/types";
import { PixelHeader } from "@/components/pixel-header";
import { PushConfig } from "@/components/push-config";

export const Route = createFileRoute("/settings")({
  loader: async () => {
    // 邮件配置状态一起在 loader 里取：SSR 首屏直接出表单，不闪「读不出来」，
    // 也和 loader 数据一起序列化（hydration 两边一致，不触发 #418）。
    const [settings, mail] = await Promise.all([
      getSettings().catch(() => null),
      getMailStatus().catch(() => null),
    ]);
    // serverNow 随数据序列化：「上次记账多久前」在 SSR 与 hydration 用同一时刻，
    // 既不会因时刻差触发 #418，也不会再把时间戳误当成差值。
    return settings ? { ...settings, mail, serverNow: Date.now() } : null;
  },
  component: SettingsPage,
});

function SettingsPage() {
  const data = Route.useLoaderData();

  if (!data) {
    return (
      <Frame decorHeader={false} wide aside="设置">
        <Panel title="设置与状态" note="没读到">
          <p className="px-3.5 py-3 text-sm text-muted">状态读不出来。多半是服务没在跑——这一页全是本机状态，服务不跑就没有。</p>
        </Panel>
      </Frame>
    );
  }

  const { recorder, universe, files, missing, config, gaps, mail, serverNow } = data;
  const beat = snapshotAgeSince(recorder.at, serverNow);
  const stale = files.filter((f) => f.state === "stale");

  return (
    <Frame decorHeader={false} wide
      aside="设置"
      status={{
        label: "数据源",
        // **真实数据**：files 里各数据源的状态。missing 是缺失的、
        // stale 是过期的——两个都是"不健康"，所以分开报。
        value: files.length > 0 ? `${files.length - stale.length} / ${files.length} 正常` : null,
        // 周末休市导致的「待更新」是常态，不该用告警色制造焦虑；缺必需项才是真问题。
        tone: missing.length > 0 ? "warn" : "ok",
      }}
      ornamentContent={
        missing.length > 0 ? (
          <span className="text-[12px] text-warn">缺 {missing.length} 项数据源</span>
        ) : stale.length > 0 ? (
          <span className="text-[12px] text-muted">{stale.length} 项待更新（不影响看盘）</span>
        ) : (
          <span className="text-[12px]">所有数据源都是新的</span>
        )
      }
    >
      <PixelHeader label="SYS // SETTINGS" meta="设置与系统状态 · 数据源、延迟、任务心跳" />
      {/* 唯一的设置表单，放最上面：来找配置的人第一眼就该看见，不用往下翻 */}
      <MailConfigCard initial={mail} />

      <Panel title="系统状态" note={beat ? `上次记账 ${beat}` : "没有心跳"}>
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

            <Panel title="交易推送" note="PushPlus · 和上面的「日报」是两条通道">
        <div className="px-3.5 py-2 text-[12px] leading-relaxed text-muted">
          上面那块「微信推送」是<b className="text-fg">收盘后一份日报</b>；
          这一块是<b className="text-fg">盘中按时间点的交易提醒</b>——开盘前的买入单、到止损/到期该卖。两条通道共用一个 PushPlus token。
        </div>
        <PushConfig />
        <div className="border-t border-line px-3.5 py-3">
          <div className="px-num mb-1.5 text-[12px] tracking-widest text-brand">PUSH // SCHEDULE</div>
          <div className="flex flex-col gap-1 text-[13px]">
            {[
              ["09:20", "今天开盘买什么（前瞻 3 只）"],
              ["09:26", "中长线买入单 + 短线买入单（含市场在玩什么）"],
              ["15:10", "盘面温度计"],
              ["15:15", "绝望底仓实验篮子"],
              ["周一 18:00", "绝望底仓周报"],
              ["周一 18:30", "周对账"],
              ["事件触发", "到止损 / 到目标 / 到期该卖"],
            ].map(([t, what]) => (
              <div key={t} className="flex items-baseline gap-3 border-b border-dashed border-line py-1 last:border-0">
                <span className="px-num w-24 shrink-0 text-[12px] text-brand">{t}</span>
                <span className="text-muted">{what}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-muted">
            上表是写死在 home-server 里的时间表，页面上改不了——要改时间得改代码。
            这里能改的只有 token；token 存在 data/push-config.json，不进 git。
          </p>
        </div>
      </Panel>

<Panel title="配置现状" note="只读展示，改的地方都标了">
        <div className="overflow-x-auto scroll-slim">
        <table className="data-table w-full min-w-[520px]">
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
                接入 AI
              </td>
            </tr>
            <tr className="border-b border-line/60">
              <td className={tdClass("text-left text-muted")}>微信推送</td>
              <td className={tdClass("text-left")}>预警推送（到卖出价/止损/到期）</td>
              <td className={tdClass("text-left text-muted")}>
                <a href="/flow/" className="underline decoration-line underline-offset-2 hover:text-fg">
                  资金页顶部
                </a>
              </td>
            </tr>
          </tbody>
        </table>
        </div>
        <p className="px-3.5 py-2 text-[12px] text-muted">
          除上面的「每日复盘日报」外，这里都是只读展示；要改值去它右边写的那一页，在这儿改不会存。
        </p>
      </Panel>

      <Panel
        title="系统体检"
        note={<span className="text-[12px]">哪里不正常，一屏看完</span>}
      >
        {/* 分层展示（2026-11-14 第 11 轮）：8 项一路平铺要每次重扫，
            而其中一半是「一周看一次就够」。按 cadence 分组，低频折叠。
            ⚠️ 但 state=bad 的一律强制置顶常驻——「出问题才看」不等于出问题时能藏起来。 */}
        {(() => {
          const health = data.health as (typeof data.health[number] & { cadence?: "daily" | "weekly" | "ondemand" })[];
          const bad = health.filter((h) => h.state === "bad");
          const rest = health.filter((h) => h.state !== "bad");
          const daily = rest.filter((h) => (h.cadence ?? "daily") === "daily");
          const later = rest.filter((h) => (h.cadence ?? "daily") !== "daily");
          const Row = ({ h }: { h: (typeof health)[number] }) => (
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3.5 py-2">
              <span className="w-24 shrink-0 text-[13px] text-fg">{h.label}</span>
              <Tag tone={h.state === "ok" ? "muted" : h.state === "warn" ? "warn" : "down"}>
                {h.state === "ok" ? "正常" : h.state === "warn" ? "注意" : "异常"}
              </Tag>
              <span className="min-w-0 flex-1 text-[12px] leading-relaxed text-muted">{h.detail}</span>
              {h.fix ? <span className="shrink-0 text-[12px] text-brand">{h.fix}</span> : null}
            </div>
          );
          return (
            <>
              {bad.length > 0 ? (
                <div className="border-b border-down/30 bg-down-soft/20">
                  <div className="px-num px-3.5 pt-2 text-[11px] tracking-widest text-down">需要处理 · {bad.length}</div>
                  <div className="divide-y divide-line">{bad.map((h) => <Row key={h.label} h={h} />)}</div>
                </div>
              ) : null}
              {daily.length > 0 ? (
                <div>
                  <div className="px-num border-b border-line px-3.5 pt-2 pb-1 text-[11px] tracking-widest text-muted">每天看 · {daily.length}</div>
                  <div className="divide-y divide-line">{daily.map((h) => <Row key={h.label} h={h} />)}</div>
                </div>
              ) : null}
              {later.length > 0 ? (
                <details className="border-t border-line">
                  <summary className="cursor-pointer select-none px-3.5 py-2 text-[11px] tracking-widest text-muted hover:text-fg">
                    每周看 / 出问题才看 · {later.length} 项（点开）
                  </summary>
                  <div className="divide-y divide-line">{later.map((h) => <Row key={h.label} h={h} />)}</div>
                </details>
              ) : null}
            </>
          );
        })()}
        <p className="border-t border-line/60 px-3.5 py-2 text-[12px] leading-relaxed text-muted">
          这八项是「系统还在不在正常跑」的判据，不是选股建议。
          <span className="text-fg">「异常」会置顶到第一组，立刻处理；「注意」多数是休市或观察期未满，不用动手</span>。
          更细的运维数字在终端跑 <code>node scripts/ops-check.mjs</code>。
        </p>
      </Panel>

      <Panel title="数据新鲜度" note={`${files.length} 份 · 待更新 ${stale.length} · 缺 ${missing.length}`}>
        <div className="overflow-x-auto scroll-slim">
          <table className="data-table w-full min-w-[600px]">
            <caption className="sr-only">本机数据的大小、最后更新时间和用途</caption>
            <thead>
              <tr className="border-b border-line">
                <th className={thClass("text-left")}>数据</th>
                <th className={thClass()}>大小</th>
                <th className={thClass("text-left")}>状态</th>
                <th className={thClass("text-left")}>说明</th>
              </tr>
            </thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.label} className="border-b border-line/60">
                  <td className={tdClass("text-left")}>
                    <span className="text-fg">{f.label}</span>
                    {f.required ? <span className="ml-1.5 text-[12px] text-muted">必需</span> : null}
                  </td>
                  <td className={tdClass("text-right text-muted")}>{f.sizeKb == null ? "—" : `${f.sizeKb} KB`}</td>
                  <td className={tdClass("text-left")}>
                    <Tag tone={f.state === "ok" ? "muted" : f.state === "na" ? "muted" : "warn"}>{f.note}</Tag>
                    {/* 过期时补一句「影响什么」：光说「已过新鲜期」用户会以为系统坏了，
                        或者以为选股受影响。实测行业数据过期 1 个月但完全不进选股链路。 */}
                    {f.state === "stale" && f.impact ? (
                      <div className="mt-0.5 text-[11px] leading-snug text-muted">{f.impact}</div>
                    ) : null}
                  </td>
                  <td className={tdClass("text-left text-muted")}>
                    <span className="text-[12px] leading-snug">{f.refresh}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="px-3.5 py-2 text-[12px] leading-relaxed text-muted">
          「没抓过」和「待更新」不是一回事：前者压根没生成过，后者是生成过但旧了。
          <span className="text-fg">标「待更新」多半是周末休市或后台任务还没轮到，不影响今天看盘</span>；
          必需项都在就行（缺必需项页面会真的开不了）。真要手动重抓，命令收在最下面的「给开发者」里，平时不用管。
        </p>
        <details className="border-t border-line/60 px-3.5 py-2 text-[12px] text-muted">
          <summary className="cursor-pointer select-none">给开发者：手动重抓命令</summary>
          <ul className="mt-2 space-y-1.5">
            {files.filter((f) => f.command).map((f) => (
              <li key={f.label}>
                <span className="text-fg">{f.label}</span>
                <code className="ml-2 break-all">{f.command}</code>
              </li>
            ))}
          </ul>
        </details>
      </Panel>
    </Frame>
  );
}