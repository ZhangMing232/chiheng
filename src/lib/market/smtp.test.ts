/**
 * smtp.ts 的守门测试。
 *
 * 测法：内存 duplex 对（一对 PassThrough 对接）当「服务器」，
 * 按真实 SMTP 会话顺序回响应，同时把客户端发来的每一行都记下来。
 * 不需要真服务器、不需要 TLS、不需要 openssl——协议逻辑全在
 * smtpSession(stream) 这一层，传输层（sendMail 的建连）不在这测。
 *
 * 钉的东西：
 *   1. 完整会话的命令序列（EHLO → AUTH LOGIN → base64 用户名/授权码 → MAIL →
 *      RCPT → DATA → 点号结束 → QUIT），一步不能少、顺序不能乱
 *   2. 中文主题必须 RFC 2047 base64 编码，不能裸发 UTF-8（裸发出去邮件客户端乱码）
 *   3. 点号开头的行必须转义，否则正文提前结束（SMTP 的 dumb escaping）
 *   4. 有 html 就 multipart/alternative，text/html 两段都要在
 *   5. 错误路径：授权码错（535）→ reject 且错误里带「授权码」；
 *      RCPT 被拒（550）→ reject；没授权码/没收件人 → 不发会话
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { sendMail, smtpSession, type MailMessage, type SmtpConfig } from "@/lib/market/smtp";

const CFG: SmtpConfig = {
  host: "smtp.example.com",
  port: 465,
  secure: true,
  auth: { user: "chiheng@example.com", pass: "授权码abc" },
  timeoutMs: 2000,
};

const MSG: MailMessage = {
  from: "chiheng@example.com",
  to: ["me@example.com"],
  subject: "赤轨日报 2026-10-25",
  text: "第一行\n第二行",
};

/**
 * 内存 duplex 对：一头 write，另一头的可读端直接收到。
 * 不用互相 pipe 的 PassThrough——那个组合会踩 Node 的写状态损坏
 * （RangeError: Invalid array length，writeOrBuffer 里 kBufferedValue 变坏值），
 * 手工转发没这个毛病。
 */
class LoopbackDuplex extends Duplex {
  peer: LoopbackDuplex | null = null;
  _read(): void {}
  _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.peer?.push(chunk);
    cb();
  }
  _final(cb: (err?: Error | null) => void): void {
    this.peer?.push(null);
    cb();
  }
}

function duplexPair(): { a: LoopbackDuplex; b: LoopbackDuplex } {
  const a = new LoopbackDuplex();
  const b = new LoopbackDuplex();
  a.peer = b;
  b.peer = a;
  return { a, b };
}

/**
 * 起一个 fake SMTP 对手方：client 端 duplex 给被测代码用，
 * 收到的命令按行收进 received，按脚本回响应。
 * script: 见到某命令时回什么（默认成功路径）。
 */
function fakePeer(script: { onAuthFail?: boolean; onRcptReject?: boolean; greeting?: number } = {}) {
  const { a: client, b: server } = duplexPair();

  const received: string[] = [];
  let lineBuf = "";
  let inData = false;
  let dataText = "";
  /** AUTH LOGIN 的握手阶段：0 未开始 → 1 已问用户名 → 2 已收用户名（等密码） */
  let authStage = 0;

  server.on("data", (chunk: Buffer) => {
    lineBuf += chunk.toString("utf8");
    if (inData) {
      // DATA 阶段：整段收完（以独占一行的 . 结束）
      if (lineBuf.includes("\r\n.\r\n") || lineBuf.endsWith("\r\n.\r\n")) {
        dataText = lineBuf;
        lineBuf = "";
        inData = false;
        server.write("250 2.0.0 Ok: queued\r\n");
      }
      return;
    }
    const lines = lineBuf.split("\r\n");
    lineBuf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      received.push(line);
      const upper = line.toUpperCase();
      if (upper === "EHLO chiheng.local") {
        authStage = 0;
        server.write("250-smtp.example.com\r\n250-PIPELINING\r\n250 OK\r\n");
      } else if (upper === "AUTH LOGIN") {
        authStage = 1;
        server.write("334 VXNlcm5hbWU6\r\n"); // base64("Username:")
      } else if (authStage === 1) {
        // 客户端发来的 base64 用户名
        authStage = 2;
        server.write("334 UGFzc3dvcmQ6\r\n"); // base64("Password:")
      } else if (authStage === 2) {
        // 客户端发来的 base64 授权码
        authStage = 0;
        server.write(
          script.onAuthFail && line === Buffer.from("badpass").toString("base64")
            ? "535 5.7.8 authentication failed\r\n"
            : "235 2.7.0 authentication successful\r\n",
        );
      } else if (upper === "QUIT") {
        server.write("221 Bye\r\n");
      } else if (upper === "DATA") {
        inData = true;
        server.write("354 End data with <CR><LF>.<CR><LF>\r\n");
      } else if (script.onRcptReject && upper.startsWith("RCPT TO")) {
        server.write("550 5.1.1 no such user\r\n");
      } else {
        // MAIL FROM / RCPT TO / 正文结束的句号，都回 250
        server.write("250 2.0.0 Ok\r\n");
      }
    }
  });

  // greeting：连上先说话
  server.write(`${script.greeting ?? 220} smtp.example.com ESMTP ready\r\n`);
  return { client: client as unknown as Duplex, server, received, dataText: () => dataText };
}

test("完整会话：命令序列、base64 认证、QUIT 收尾", async () => {
  const peer = fakePeer();
  await smtpSession(peer.client, CFG, MSG);
  // AUTH LOGIN 之后紧跟 base64 用户名、base64 授权码
  const userB64 = Buffer.from("chiheng@example.com").toString("base64");
  const passB64 = Buffer.from("授权码abc").toString("base64");
  assert.deepEqual(peer.received, [
    "EHLO chiheng.local",
    "AUTH LOGIN",
    userB64,
    passB64,
    `MAIL FROM:<${MSG.from}>`,
    `RCPT TO:<${MSG.to[0]}>`,
    "DATA",
    // DATA 阶段收的整段（含头和正文）在 dataText 里
    "QUIT",
  ]);
  assert.ok(peer.received.includes(userB64), "用户名必须 base64 发");
  assert.ok(peer.received.includes(passB64), "授权码必须 base64 发");
});

test("中文主题按 RFC 2047 base64 编码，不裸发", async () => {
  const peer = fakePeer();
  await smtpSession(peer.client, CFG, MSG);
  const data = peer.dataText();
  assert.ok(data.includes("Subject: =?UTF-8?B?"), "主题必须 RFC 2047");
  assert.ok(
    data.includes(Buffer.from("赤轨日报 2026-10-25", "utf8").toString("base64")),
    "主题内容必须 base64 后的中文",
  );
  assert.ok(!data.includes("Subject: 赤轨日报"), "不许裸发中文主题（客户端会乱码）");
});

test("点号开头的正文行必须转义（. → ..），不然正文提前结束", async () => {
  const peer = fakePeer();
  await smtpSession(peer.client, CFG, { ...MSG, text: "正常行\n.这行以点开头" });
  const data = peer.dataText();
  assert.ok(data.includes("\r\n..这行以点开头"), "点号开头行要转成两个点");
  // 结尾那个真句号还在（转义不会误伤）
  assert.ok(data.trimEnd().endsWith("."), "正文结束的真句号必须在");
});

test("有 html 就发 multipart/alternative，text 和 html 两段都在", async () => {
  const peer = fakePeer();
  await smtpSession(peer.client, CFG, { ...MSG, html: "<p>HTML 版</p>" });
  const data = peer.dataText();
  assert.ok(data.includes('Content-Type: multipart/alternative; boundary="chiheng-boundary"'));
  assert.ok(data.includes("第一行"), "text 段要在");
  assert.ok(data.includes("<p>HTML 版</p>"), "html 段要在");
  assert.ok(data.includes("Content-Type: text/plain"));
  assert.ok(data.includes("Content-Type: text/html"));
});

test("授权码错：reject，错误里要点名「授权码」和服务器回的行", async () => {
  const peer = fakePeer({ onAuthFail: true });
  // fakePeer 的 onAuthFail 是靠比对 base64("badpass")——这里让授权码就是 badpass
  await assert.rejects(
    () => smtpSession(peer.client, { ...CFG, auth: { user: "u", pass: "badpass" } }, MSG),
    /授权码 被拒.*535/,
  );
});

test("收件人被拒（550）：reject 且点名是哪个收件人", async () => {
  const peer = fakePeer({ onRcptReject: true });
  await assert.rejects(() => smtpSession(peer.client, CFG, MSG), /RCPT TO me@example\.com 被拒.*550/);
});

test("没授权码/没收件人：直接拒，不发起会话", async () => {
  await assert.rejects(() => sendMail({ ...CFG, auth: { user: "u", pass: "" } }, MSG), /缺用户名或授权码/);
  await assert.rejects(() => sendMail(CFG, { ...MSG, to: [] }), /没有收件人/);
});

test("问候语不是 220：reject 且带服务器回的行", async () => {
  const peer = fakePeer({ greeting: 554 });
  await assert.rejects(() => smtpSession(peer.client, CFG, MSG), /连接问候语 被拒.*554/);
});

test("多个收件人：每个都发一条 RCPT TO", async () => {
  const peer = fakePeer();
  await smtpSession(peer.client, CFG, { ...MSG, to: ["a@x.com", "b@y.com"] });
  const rcpts = peer.received.filter((l) => l.startsWith("RCPT TO:"));
  assert.deepEqual(rcpts, ["RCPT TO:<a@x.com>", "RCPT TO:<b@y.com>"]);
});
