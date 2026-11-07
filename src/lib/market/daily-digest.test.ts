/**
 * 这个文件是干什么的：
 * 钉住「日报分发」的成功口径。用户没邮箱授权码，只配了微信推送 —— 必须证明
 * 这种情况照样算发出去了；反过来，一个通道失败也不能冒充成功、更不能拖垮另一个。
 *
 * 推没推出去是事实，不许猜（push.ts 的教训），所以这里全用可注入的假发送函数。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { deliverDigest, type DigestDeps, type RenderedDigest } from "@/lib/market/daily-digest";
import type { MailConfig } from "@/lib/market/daily-mail";

const FAKE_TOKEN = "fake-push-token-abcdef";
const MAIL: MailConfig = {
  host: "smtp.example.com",
  port: 465,
  secure: true,
  auth: { user: "sender@example.com", pass: "fake-mail-code" },
  to: ["reader@example.com"],
};
const RENDERED: RenderedDigest = {
  subject: "赤轨日报 2026-11-07",
  text: "一、今日诊断\n二、挑战者战况\n三、明日验证",
  html: "<p>日报</p>",
};

function deps(over: Partial<DigestDeps> = {}) {
  const calls = { mail: 0, push: 0, pushArgs: [] as { title: string; content: string }[] };
  const base: DigestDeps = {
    mailCfg: null,
    pushToken: null,
    sendMail: async () => { calls.mail += 1; },
    sendPush: async (title, content) => { calls.push += 1; calls.pushArgs.push({ title, content }); return true; },
    ...over,
  };
  return { base, calls };
}

test("只配微信（没有邮箱授权码）：照样发出去，且不碰邮件", async () => {
  const { base, calls } = deps({ pushToken: FAKE_TOKEN });
  const r = await deliverDigest(RENDERED, base);
  assert.equal(r.status, "sent");
  assert.equal(r.sent, true);
  assert.deepEqual(r.channels, ["wechat"]);
  assert.equal(calls.mail, 0);
  assert.equal(calls.push, 1);
  assert.equal(calls.pushArgs[0]!.title, RENDERED.subject);
  assert.equal(calls.pushArgs[0]!.content, RENDERED.text);
});

test("只配邮件：走邮件，不碰微信", async () => {
  const { base, calls } = deps({ mailCfg: MAIL });
  const r = await deliverDigest(RENDERED, base);
  assert.deepEqual(r.channels, ["mail"]);
  assert.equal(calls.push, 0);
  assert.equal(calls.mail, 1);
});

test("两个都配：同一份内容各发一次", async () => {
  const { base, calls } = deps({ mailCfg: MAIL, pushToken: FAKE_TOKEN });
  const r = await deliverDigest(RENDERED, base);
  assert.equal(r.sent, true);
  assert.deepEqual([...r.channels].sort(), ["mail", "wechat"]);
  assert.equal(calls.mail, 1);
  assert.equal(calls.push, 1);
});

test("一个通道都没配：status=none，不调任何发送，给明确原因让调用方静默跳过", async () => {
  const { base, calls } = deps();
  const r = await deliverDigest(RENDERED, base);
  assert.equal(r.status, "none");
  assert.equal(r.sent, false);
  assert.deepEqual(r.channels, []);
  assert.match(r.reason ?? "", /没配/);
  assert.equal(calls.mail + calls.push, 0);
});

test("邮件失败但微信成功：算发出去，失败原因留痕，不拖垮微信", async () => {
  const { base } = deps({
    mailCfg: MAIL,
    pushToken: FAKE_TOKEN,
    sendMail: async () => { throw new Error("SMTP 超时"); },
  });
  const r = await deliverDigest(RENDERED, base);
  assert.equal(r.status, "sent");
  assert.deepEqual(r.channels, ["wechat"]);
  assert.match(r.reasons.join(""), /SMTP 超时/);
});

test("配了但两个都失败：status=failed，不冒充成功", async () => {
  const { base } = deps({
    mailCfg: MAIL,
    pushToken: FAKE_TOKEN,
    sendMail: async () => { throw new Error("SMTP 拒收"); },
    sendPush: async () => false,
  });
  const r = await deliverDigest(RENDERED, base);
  assert.equal(r.sent, false);
  assert.equal(r.status, "failed");
  assert.deepEqual(r.channels, []);
  assert.match(r.reason ?? "", /SMTP 拒收/);
});

test("token 和授权码都不进返回值（不进日志、不进浏览器）", async () => {
  const { base } = deps({ mailCfg: MAIL, pushToken: FAKE_TOKEN });
  const r = await deliverDigest(RENDERED, base);
  const json = JSON.stringify(r);
  assert.ok(!json.includes(FAKE_TOKEN));
  assert.ok(!json.includes(MAIL.auth.pass));
});
