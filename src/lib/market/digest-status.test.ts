/**
 * 这个文件是干什么的：
 * 钉住日报「发没发出去」这条状态的读写与展示口径。
 * 关键：一个通道都没配时不写状态（保持「还没发过」），失败要留原因，
 * 而且 token / 授权码绝不能混进状态文件或给网页的那行文字。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeDelivery,
  digestStatusPath,
  readDigestStatus,
  writeDigestStatus,
  type DigestDelivery,
} from "@/lib/market/digest-status";

const SENT: DigestDelivery = {
  at: "2026-11-09T07:08:00.000Z",
  date: "2026-11-09",
  status: "sent",
  channels: ["wechat"],
};

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "digest-status-test-"));
  const prev = process.env.CHIHENG_DATA_DIR;
  process.env.CHIHENG_DATA_DIR = dir;
  try {
    await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.CHIHENG_DATA_DIR;
    else process.env.CHIHENG_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

test("写一次成功状态，读回来字段一致，不留临时文件", async () => {
  await withTempDir(async (dir) => {
    await writeDigestStatus(SENT);
    assert.deepEqual(await readDigestStatus(), SENT);
    const names = await readdir(dir);
    assert.deepEqual(names.filter((n) => n.includes(".tmp-")), []);
    const raw = await readFile(digestStatusPath(), "utf8");
    assert.ok(!raw.includes("token"));
  });
});

test("没发过（文件不存在）/ 坏 JSON / 字段不对，都返回 null 而不是编一个", async () => {
  await withTempDir(async () => {
    assert.equal(await readDigestStatus(), null);
    await writeFile(digestStatusPath(), "{坏JSON");
    assert.equal(await readDigestStatus(), null);
    await writeFile(digestStatusPath(), JSON.stringify({ at: "x", status: "unknown" }));
    assert.equal(await readDigestStatus(), null);
    await writeFile(digestStatusPath(), JSON.stringify([]));
    assert.equal(await readDigestStatus(), null);
  });
});

test("非法通道值被过滤，不把脏数据带进页面", async () => {
  await withTempDir(async () => {
    await writeFile(
      digestStatusPath(),
      JSON.stringify({ ...SENT, channels: ["wechat", "sms", 42, "mail"] }),
    );
    const d = await readDigestStatus();
    assert.deepEqual(d?.channels, ["wechat", "mail"]);
  });
});

test("describeDelivery：成功带通道，失败带原因，没状态返回 null", () => {
  const ok = describeDelivery(SENT);
  assert.match(ok ?? "", /上次发送/);
  assert.match(ok ?? "", /微信/);
  assert.match(ok ?? "", /成功/);
  const bad = describeDelivery({ ...SENT, status: "failed", channels: [], reason: "PushPlus 没收" });
  assert.match(bad ?? "", /上次发送失败/);
  assert.match(bad ?? "", /PushPlus 没收/);
  assert.equal(describeDelivery(null), null);
});

test("给网页的那行字不含 token 或授权码", () => {
  const line = describeDelivery({ ...SENT, reason: "微信：PushPlus 没收（看 pushplus 日志）" }) ?? "";
  assert.ok(!/fake|token=|pass/i.test(line));
});
