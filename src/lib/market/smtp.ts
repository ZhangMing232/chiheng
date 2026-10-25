/**
 * 这个文件是干什么的：
 * 最小 SMTP 客户端。给每日复盘邮件用（daily-mail.ts 调它）。
 *
 * 为什么不用 nodemailer：项目现在零邮件依赖，而 SMTP 本身够简单——
 * EHLO / AUTH LOGIN / MAIL FROM / RCPT TO / DATA 五步，QQ 邮箱和 163
 * 都支持。自己写一百多行能测的代码，比引一个几十万的包好排查。
 *
 * 分两层，为了可测：
 *   - smtpSession(stream, ...)：**纯协议**，在一个已连好的 duplex 上跑完整
 *     会话。测试用内存 duplex 直接覆盖全部命令序列和错误路径，不需要真服务
 *     器、不需要 TLS、不需要 openssl 起 fake server。
 *   - sendMail(cfg, ...)：传输层。建连接（465 TLS 直连 / 587 STARTTLS 升级），
 *     调 smtpSession。
 *
 * 支持两种连接（覆盖国内主流）：
 *   - secure=true：465 端口，TLS 直连（QQ/163 默认这个）
 *   - secure=false：587 端口，明文连上去再 STARTTLS 升级
 *
 * 失败语义：任何一步不对都 reject，错误信息带上「卡在哪一步」——
 * 邮件发不出去最常见的原因（授权码错/端口不通/被拒收）都要能一眼
 * 看出来，不能只抛一个 "send failed"。
 */

import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { connect as netConnect, type Socket } from "node:net";
import type { Duplex } from "node:stream";

export type SmtpConfig = {
  host: string;
  /** 465（TLS 直连）或 587（STARTTLS） */
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
  /** 超时毫秒，默认 15000。整个会话一个总超时。 */
  timeoutMs?: number;
};

export type MailMessage = {
  from: string;
  to: string[];
  subject: string;
  /** 纯文本正文。至少给一个正文。 */
  text: string;
  /** HTML 正文（可选）。给了就发 multipart/alternative。 */
  html?: string;
};

/** 给一个 promise 加超时。超时的错误带上「卡在哪一步」，不然邮件发不出去时只看到 send failed。 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`SMTP 超时：${label}（${ms}ms 没响应）`)), ms);
    }),
  ]);
}

function cmd(socket: Duplex, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(`${line}\r\n`, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * 读一条（可能多行的）SMTP 响应。
 *
 * 用流的 async iterator 而不是 on("data") 一次性读——后者踩过一个坑：
 * Node **没有** auto-pause，off("data") 之后流还在 flowing，下一块数据
 * 会直接 emit 到虚空被丢弃（实测：第二步之后永远等不到响应，超时）。
 * 迭代器的 pause/resume 它自己管，没有这个雷。
 * 多行响应的续行是 "250-xxx"，最后一行 "250 xxx"。
 */
async function readResponse(it: AsyncIterator<Buffer>): Promise<{ code: number; lines: string[] }> {
  const { value, done } = await it.next();
  if (done || !value) throw new Error("连接被服务器关闭");
  const text = value.toString("utf8");
  const lines = text.split("\r\n").filter((l) => l.length > 0);
  const code = Number.parseInt(lines[0]?.slice(0, 3) ?? "", 10);
  return { code, lines };
}

/** SMTP 的 DATA 段要求 CRLF 行尾，正文里的裸 \n 要规范化，不然严格服务器会当数据损坏。 */
function crlf(s: string): string {
  return s.replace(/\r?\n/g, "\r\n");
}

/** 拼邮件体：text-only 或 multipart/alternative（有 html 时）。subject 按 RFC 2047 base64 编码（中文主题必须）。 */
function buildMessageBody(message: MailMessage): string {
  const subjectLine = `Subject: =?UTF-8?B?${Buffer.from(message.subject, "utf8").toString("base64")}?=`;
  const text = crlf(message.text);
  if (!message.html) {
    return [
      `From: 赤轨 <${message.from}>`,
      `To: ${message.to.join(", ")}`,
      subjectLine,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      text,
    ].join("\r\n");
  }
  return [
    `From: 赤轨 <${message.from}>`,
    `To: ${message.to.join(", ")}`,
    subjectLine,
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="chiheng-boundary"',
    "",
    "--chiheng-boundary",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    text,
    "--chiheng-boundary",
    "Content-Type: text/html; charset=UTF-8",
    "",
    crlf(message.html),
    "--chiheng-boundary--",
  ].join("\r\n");
}

/**
 * 纯协议层：在已连好的 duplex 上跑完整 SMTP 会话（EHLO → AUTH → 投递 → QUIT）。
 * 导出是为了测试——内存 duplex 就能覆盖全部命令序列和错误路径。
 */
export async function smtpSession(
  stream: Duplex,
  cfg: Pick<SmtpConfig, "auth" | "timeoutMs">,
  message: MailMessage,
): Promise<void> {
  const timeoutMs = cfg.timeoutMs ?? 15_000;
  const it = stream[Symbol.asyncIterator]();
  const stepOf = async (expected: number[], what: string): Promise<{ code: number; lines: string[] }> => {
    const res = await withTimeout(readResponse(it), timeoutMs, `等 ${what} 响应`);
    if (!expected.includes(res.code)) {
      throw new Error(`${what} 被拒：服务器回 ${res.code}（${res.lines[0] ?? "无内容"}）`);
    }
    return res;
  };

  // ①  greeting：服务器先说话
  await stepOf([220], "连接问候语");

  // ②  EHLO：报上家门（STARTTLS 升级后会由调用方重发一次）
  await cmd(stream, "EHLO chiheng.local");
  await stepOf([250], "EHLO");

  // ③  AUTH LOGIN：先发用户名（base64），再发授权码（base64）
  await cmd(stream, "AUTH LOGIN");
  await stepOf([334], "AUTH LOGIN");
  await cmd(stream, Buffer.from(cfg.auth.user, "utf8").toString("base64"));
  await stepOf([334], "用户名");
  await cmd(stream, Buffer.from(cfg.auth.pass, "utf8").toString("base64"));
  await stepOf([235], "授权码");

  // ④  MAIL FROM / RCPT TO
  await cmd(stream, `MAIL FROM:<${message.from}>`);
  await stepOf([250], "MAIL FROM");
  for (const rcpt of message.to) {
    await cmd(stream, `RCPT TO:<${rcpt}>`);
    await stepOf([250, 551], `RCPT TO ${rcpt}`);
  }

  // ⑤  DATA：354 之后发头 + 正文，单独一行句号结束
  await cmd(stream, "DATA");
  await stepOf([354], "DATA");
  const body = buildMessageBody(message);
  // 点号开头的行要转义（. → ..），否则被当成正文结束（SMTP 的 dumb escaping 规则）
  await cmd(stream, body.replace(/^\./gm, ".."));
  await cmd(stream, ".");
  await stepOf([250], "正文投递");

  // ⑥  QUIT
  await cmd(stream, "QUIT");
  await stepOf([221], "QUIT");
}

/** 传输层：建连接 + （587 时）STARTTLS 升级 + 跑协议。 */
export async function sendMail(cfg: SmtpConfig, message: MailMessage): Promise<void> {
  if (!cfg.auth.user || !cfg.auth.pass) throw new Error("SMTP 配置缺用户名或授权码");
  if (message.to.length === 0) throw new Error("没有收件人");
  const timeoutMs = cfg.timeoutMs ?? 15_000;

  let socket: Socket | TLSSocket;
  if (cfg.secure) {
    socket = tlsConnect({ host: cfg.host, port: cfg.port, servername: cfg.host });
  } else {
    socket = netConnect({ host: cfg.host, port: cfg.port });
  }
  socket.setTimeout(timeoutMs);

  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        socket.once(cfg.secure ? "secureConnect" : "connect", () => resolve());
        socket.once("error", reject);
        socket.once("timeout", () => reject(new Error(`SMTP 超时：连接 ${cfg.host}:${cfg.port}`)));
      }),
      timeoutMs,
      `连接 ${cfg.host}:${cfg.port}`,
    );

    let stream: Duplex = socket;
    if (!cfg.secure) {
      // STARTTLS：明文线路上先协商升级
      await cmd(socket, "STARTTLS");
      const plainIt = socket[Symbol.asyncIterator]();
      const res = await withTimeout(readResponse(plainIt), timeoutMs, "等 STARTTLS 响应");
      if (res.code !== 220) {
        throw new Error(`STARTTLS 被拒：服务器回 ${res.code}（${res.lines[0] ?? "无内容"}）`);
      }
      const upgraded = await withTimeout(
        new Promise<TLSSocket>((resolve, reject) => {
          const tls = tlsConnect({ socket, servername: cfg.host }, () => resolve(tls));
          tls.once("error", reject);
        }),
        timeoutMs,
        "TLS 升级",
      );
      upgraded.setTimeout(timeoutMs);
      stream = upgraded;
      // RFC 3207：升级后必须重新 EHLO
      await cmd(stream, "EHLO chiheng.local");
      const tlsIt = upgraded[Symbol.asyncIterator]();
      const re = await withTimeout(readResponse(tlsIt), timeoutMs, "等升级后 EHLO 响应");
      if (re.code !== 250) {
        throw new Error(`升级后 EHLO 被拒：服务器回 ${re.code}（${re.lines[0] ?? "无内容"}）`);
      }
    }

    await smtpSession(stream, cfg, message);
  } finally {
    socket.destroy();
  }
}
