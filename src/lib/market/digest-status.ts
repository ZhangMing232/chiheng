/**
 * 这个文件是干什么的：
 * 每日复盘日报的**发送状态落盘**。收盘触发（record-journal）写，网页（mail.functions）
 * 读，让用户在设置页 / 铃铛抽屉就能看到「上次发没发出去、走的哪个通道、失败原因」，
 * 不用翻 data/serve.log。
 *
 * 为什么单开一个文件：2026-11-08 之前日报改成微信推送后，所有验证都是手动点
 * 「发测试日报」，收盘那条真实路径周末没跑过；而发没发成功页面上看不见，
 * 万一第一个交易日没收到，用户分不清是「没到收盘」「没配通道」还是「推送失败」。
 *
 * 纪律：
 * - 只记事实：真成功才写 sent，全失败写 failed，一个通道都没配**不写**（保持「还没发过」）。
 * - 绝不把 PushPlus token / 邮箱授权码写进状态文件；失败原因只放给用户看的人话。
 * - 不顶层 import node 内置（会被 serverFn 引用、进源码级客户端 graph 守门），
 *   fs 一律在 handler 里动态 import，POSIX 路径用字符串拼。
 */

// 刻意不 import daily-digest 的类型：那个文件只活服务端，连 type-only 边都别搭，
// 免得源码级客户端 graph 守门多一条路径。两个通道的字面量在这里重复一次，测试钉住。
type DigestChannel = "mail" | "wechat";

export type DigestDelivery = {
  /** 状态写入时刻（ISO）。前端只展示服务端格式化好的字符串，不自己解析（#418） */
  at: string;
  date: string;
  status: "sent" | "failed";
  channels: DigestChannel[];
  reason?: string;
};

const STATUS_FILE = ".daily-digest-last.json";

export function digestStatusPath(): string {
  const dir = process.env.CHIHENG_DATA_DIR ?? `${process.cwd()}/data`;
  return `${dir}/${STATUS_FILE}`;
}

/** 原子写：tmp + rename，免得每分钟的记账进程和网页读到写一半的文件。 */
export async function writeDigestStatus(delivery: DigestDelivery): Promise<void> {
  const fs = await import("node:fs/promises");
  const dir = process.env.CHIHENG_DATA_DIR ?? `${process.cwd()}/data`;
  await fs.mkdir(dir, { recursive: true });
  const target = digestStatusPath();
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await fs.writeFile(tmp, `${JSON.stringify(delivery, null, 2)}\n`, { mode: 0o600 });
  try {
    await fs.rename(tmp, target);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 读状态。文件不存在 / 坏 JSON / 字段不对都返回 null，不抛、不编数据。 */
export async function readDigestStatus(): Promise<DigestDelivery | null> {
  const fs = await import("node:fs/promises");
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(digestStatusPath(), "utf8"));
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const d = parsed as Record<string, unknown>;
    if (typeof d.at !== "string" || typeof d.date !== "string") return null;
    if (d.status !== "sent" && d.status !== "failed") return null;
    const channels = Array.isArray(d.channels)
      ? d.channels.filter((c): c is DigestChannel => c === "mail" || c === "wechat")
      : [];
    const delivery: DigestDelivery = { at: d.at, date: d.date, status: d.status, channels };
    // 没有失败原因就别带这个键：写进去什么、读回来就该是什么（deepEqual 才对得上）
    if (typeof d.reason === "string") delivery.reason = d.reason;
    return delivery;
  } catch {
    return null;
  }
}

const CHANNEL_CN: Record<DigestChannel, string> = { wechat: "微信", mail: "邮件" };

/**
 * 给网页看的一行状态。**时间在服务端格式化**：组件只显示字符串，不在浏览器里
 * 重新解析 ISO（否则服务端/客户端时区或时刻不同就是又一次 #418）。
 */
export function describeDelivery(d: DigestDelivery | null): string | null {
  if (!d) return null;
  const when = new Date(d.at).toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  if (d.status === "sent") {
    const names = d.channels.map((c) => CHANNEL_CN[c] ?? c).join("+");
    return `上次发送 ${when} · ${names || "未知通道"} · 成功`;
  }
  return `上次发送失败 ${when}${d.reason ? ` · ${d.reason}` : ""}`;
}
