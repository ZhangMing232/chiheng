/**
 * 这个文件是干什么的：
 * 钉住 providers 入口的错误日志口径——messageOf 必须把 fetch 的 cause 挖出来。
 *
 * 为什么要有它：腾讯源白天间歇失败时，日志原来只有「fetch failed」四个字，
 * 分不清是 WAF 掐断（ECONNRESET）、超时（ETIMEDOUT）还是 DNS，排障全靠现抓。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { messageOf } from "@/lib/market/providers/index";

test("messageOf：普通错误原样返回", () => {
  assert.equal(messageOf(new Error("status 501")), "status 501");
  assert.equal(messageOf("字符串错误"), "字符串错误");
});

test("messageOf：fetch failed 带 cause 时把原因挖出来", () => {
  const e = new Error("fetch failed", { cause: new Error("read ECONNRESET") });
  (e.cause as Error & { code?: string }).code = "ECONNRESET";
  const msg = messageOf(e);
  assert.match(msg, /fetch failed/);
  assert.match(msg, /ECONNRESET/);
  // 不带 cause 时保持原样，不拼空括号
  assert.equal(messageOf(new Error("fetch failed")), "fetch failed");
});
