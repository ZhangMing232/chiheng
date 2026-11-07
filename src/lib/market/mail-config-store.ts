/**
 * 这个文件是干什么的：
 * 每日复盘邮件配置的读写 + 脱敏，**路径与格式的唯一来源**。
 * 读：daily-mail.ts（readMailConfig）→ record-journal.ts 收盘封印。
 * 写：mail.functions.ts（/settings 网页表单）。两边必须落到同一个文件。
 *
 * 纪律（照 PushConfig / saveAIProfile 的现成模式）：
 * - **授权码只进不出**：statusOf() 只回尾四位，完整值永不进任何会返回浏览器的对象。
 * - 文件权限 600；写入走 tmp + rename，避免写一半被每分钟新起的记账进程读到。
 * - 授权码留空 = 保留旧值（和「apiKey 留空保留旧 key」一个道理）；停用要显式 disable。
 * - **不顶层 import node 内置**：本文件会被 serverFn 引用、进源码级客户端 graph 守门
 *   （check-client-graph.mjs），fs 相关一律在 handler 里动态 import。
 *   POSIX 路径用字符串拼，不用 node:path（同 quotes.functions.ts 的理由）。
 */

export type MailConfigFile = {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
  to: string[];
  from?: string;
  timeoutMs?: number;
};

/** 返回给浏览器的状态：只有尾号，没有完整授权码。 */
export type MailConfigStatus = {
  configured: boolean;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  to: string[];
  from: string;
  timeoutMs: number | null;
  tail: string | null;
};

export type MailConfigInput = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  /** 留空 = 保留旧授权码 */
  pass: string;
  to: string[];
  from: string;
  timeoutMs: number | null;
  /** 显式停用：清空授权码和收件人，其余字段保留 */
  disable?: boolean;
};

const DEFAULTS = { host: "smtp.qq.com", port: 465, secure: true };
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 和 daily-mail.ts 的 CHIHENG_DATA_DIR 约定一致（测试靠它指到临时目录）。 */
export function mailConfigPath(): string {
  const dir = process.env.CHIHENG_DATA_DIR ?? `${process.cwd()}/data`;
  return `${dir}/mail-config.json`;
}

/** 读原始配置（含授权码，**只在服务端用**）。文件不在/坏 JSON 都返回空对象。 */
export async function readRaw(): Promise<Record<string, unknown>> {
  const fs = await import("node:fs/promises");
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(mailConfigPath(), "utf8"));
    return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 脱敏状态。configured 判据与 daily-mail.ts 的 readMailConfig() 完全一致。 */
export function statusOf(raw: Record<string, unknown>): MailConfigStatus {
  const auth = (raw.auth ?? {}) as Record<string, unknown>;
  const rawHost = str(raw.host);
  const rawPort = num(raw.port);
  const user = str(auth.user) ?? "";
  const pass = str(auth.pass) ?? "";
  const to = Array.isArray(raw.to)
    ? raw.to.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : [];
  // configured 判据与 daily-mail.ts 的 readMailConfig() 逐项对齐：文件里必须真的写了
  // 合法 host/port/user/pass/to，**不拿默认值凑数**——否则页面显示「已配置」而记账
  // 进程读到 null，又是一次静默的假成功。默认值只用于表单预填展示。
  const configured = Boolean(rawHost && rawPort != null && user && pass && to.length > 0);
  const host = rawHost ?? DEFAULTS.host;
  const port = rawPort ?? DEFAULTS.port;
  const secure = typeof raw.secure === "boolean" ? raw.secure : port === 465;
  return {
    configured,
    host,
    port,
    secure,
    user,
    to,
    from: str(raw.from) ?? "",
    timeoutMs: num(raw.timeoutMs),
    tail: pass ? pass.slice(-4) : null,
  };
}

/** 保存前校验。返回错误原因，null = 合法。hasOldPass 决定新授权码留空能不能过。 */
export function validateInput(input: MailConfigInput, hasOldPass: boolean): string | null {
  if (input.disable) return null;
  if (!str(input.host)) return "SMTP 服务器没填";
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) return "端口要是 1~65535 的数字";
  if (!EMAIL.test(input.user.trim())) return "发件邮箱格式不对";
  if (!input.pass.trim() && !hasOldPass) return "SMTP 授权码没填";
  if (input.to.length === 0) return "收件人至少填一个";
  if (input.to.some((t) => !EMAIL.test(t.trim()))) return "收件人邮箱格式不对";
  if (input.from.trim() && !EMAIL.test(input.from.trim())) return "from 邮箱格式不对";
  if (input.timeoutMs != null && (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 1000)) return "超时至少 1000 毫秒";
  return null;
}

/** 合并成要落盘的完整对象：留空授权码沿用旧值；disable 明确停用。 */
export function mergeInput(raw: Record<string, unknown>, input: MailConfigInput): MailConfigFile {
  const prev = statusOf(raw);
  const rawAuth = (raw.auth ?? {}) as Record<string, unknown>;
  const oldPass = str(rawAuth.pass) ?? "";
  const next: MailConfigFile = {
    host: (str(input.host) ?? prev.host),
    port: Number.isInteger(input.port) ? input.port : prev.port,
    secure: typeof input.secure === "boolean" ? input.secure : prev.secure,
    auth: {
      user: input.user.trim() || prev.user,
      pass: input.disable ? "" : input.pass.trim() || oldPass,
    },
    to: input.disable ? [] : input.to.map((t) => t.trim()).filter(Boolean),
  };
  const from = input.from.trim();
  if (from) next.from = from;
  if (input.timeoutMs != null) next.timeoutMs = input.timeoutMs;
  return next;
}

/** 原子写 + 600。写 tmp 再 rename，记账进程每分钟读到的永远是完整文件。 */
export async function writeRaw(next: MailConfigFile): Promise<void> {
  const fs = await import("node:fs/promises");
  const dir = process.env.CHIHENG_DATA_DIR ?? `${process.cwd()}/data`;
  await fs.mkdir(dir, { recursive: true });
  const target = mailConfigPath();
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  try {
    await fs.rename(tmp, target);
    await fs.chmod(target, 0o600);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}
