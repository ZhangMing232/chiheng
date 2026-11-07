/**
 * 这个文件是干什么的：
 * 钉住「网页表单写盘 → 记账进程读得到」这条闭环，以及授权码绝不外泄。
 *
 * 为什么重要：/settings 的卡片是用户唯一的配置入口，页面说「已配置」而
 * record-journal 读到 null，就是一次静默的假成功（每天都不发、日志还不吭声）。
 * 所以 configured 判据必须和 daily-mail.ts 的 readMailConfig() 逐项对齐。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mailConfigPath,
  mergeInput,
  readRaw,
  statusOf,
  validateInput,
  writeRaw,
  type MailConfigInput,
} from "@/lib/market/mail-config-store";
import { readMailConfig } from "@/lib/market/daily-mail";

// 全假值，不是任何真实密钥
const FAKE_PASS = "fake-auth-code-1234";
const RAW = {
  host: "smtp.qq.com",
  port: 465,
  secure: true,
  auth: { user: "sender@example.com", pass: FAKE_PASS },
  to: ["reader@example.com"],
};

function input(over: Partial<MailConfigInput> = {}): MailConfigInput {
  return {
    host: "smtp.qq.com",
    port: 465,
    secure: true,
    user: "sender@example.com",
    pass: "",
    to: ["reader@example.com"],
    from: "",
    timeoutMs: null,
    ...over,
  };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mail-config-test-"));
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

test("statusOf 只回尾号：完整授权码不进任何返回浏览器的字段", () => {
  const s = statusOf(RAW);
  assert.equal(s.configured, true);
  assert.equal(s.tail, "1234");
  assert.ok(!JSON.stringify(s).includes(FAKE_PASS));
  assert.equal(s.user, "sender@example.com");
  assert.deepEqual(s.to, ["reader@example.com"]);
});

test("configured 判据与 readMailConfig 对齐：缺项 / port 写成字符串都算没配", () => {
  assert.equal(statusOf({ ...RAW, to: [] }).configured, false);
  assert.equal(statusOf({ ...RAW, auth: { user: "u", pass: "" } }).configured, false);
  assert.equal(statusOf({ ...RAW, host: "" }).configured, false);
  // 关键：不能拿默认 465 把坏 port 凑成「已配置」
  assert.equal(statusOf({ ...RAW, port: "465" }).configured, false);
  assert.equal(statusOf({}).configured, false);
});

test("statusOf 没配时仍给表单预填默认值，但不谎报 configured", () => {
  const s = statusOf({});
  assert.equal(s.configured, false);
  assert.equal(s.host, "smtp.qq.com");
  assert.equal(s.port, 465);
  assert.equal(s.secure, true);
  assert.equal(s.tail, null);
});

test("mergeInput：授权码留空沿用旧值，填了新的才覆盖", () => {
  const kept = mergeInput(RAW, input());
  assert.equal(kept.auth.pass, FAKE_PASS);
  const changed = mergeInput(RAW, input({ pass: "new-code-9999" }));
  assert.equal(changed.auth.pass, "new-code-9999");
});

test("mergeInput：disable 明确停用，清空授权码和收件人但保留服务器设置", () => {
  const next = mergeInput(RAW, input({ disable: true }));
  assert.equal(next.auth.pass, "");
  assert.deepEqual(next.to, []);
  assert.equal(next.host, "smtp.qq.com");
  assert.equal(next.port, 465);
  assert.equal(statusOf(next as unknown as Record<string, unknown>).configured, false);
});

test("validateInput：坏输入挡在写盘之前", () => {
  assert.match(validateInput(input({ port: Number.NaN }), true) ?? "", /端口/);
  assert.match(validateInput(input({ port: 99999 }), true) ?? "", /端口/);
  assert.match(validateInput(input({ user: "not-an-email" }), true) ?? "", /发件邮箱/);
  assert.match(validateInput(input({ to: [] }), true) ?? "", /收件人/);
  assert.match(validateInput(input({ to: ["bad"] }), true) ?? "", /收件人/);
  assert.match(validateInput(input(), false) ?? "", /授权码/);
  assert.equal(validateInput(input(), true), null);
  assert.equal(validateInput(input({ disable: true, user: "", to: [] }), false), null, "停用不校验");
});

test("写盘闭环：writeRaw 之后 readMailConfig 读得到，权限 600，不留 tmp", async () => {
  await withTempDir(async (dir) => {
    const next = mergeInput({}, input({ pass: FAKE_PASS }));
    await writeRaw(next);

    const cfg = await readMailConfig();
    assert.ok(cfg, "记账进程用的 readMailConfig 必须读得到网页保存的配置");
    assert.equal(cfg.host, "smtp.qq.com");
    assert.equal(cfg.port, 465);
    assert.equal(cfg.secure, true);
    assert.equal(cfg.to.length, 1);

    const st = await stat(mailConfigPath());
    assert.equal(st.mode & 0o777, 0o600, "含授权码的文件必须 600");
    const names = await readdir(dir);
    assert.deepEqual(names.filter((n) => n.includes(".tmp-")), [], "原子写不能留临时文件");
  });
});

test("写盘闭环：停用后 readMailConfig 回到 null（不会再发信）", async () => {
  await withTempDir(async () => {
    await writeRaw(mergeInput({}, input({ pass: FAKE_PASS })));
    assert.ok(await readMailConfig());
    const raw = await readRaw();
    await writeRaw(mergeInput(raw, input({ disable: true })));
    assert.equal(await readMailConfig(), null);
  });
});

test("readRaw：文件不存在或坏 JSON 都返回空对象，不抛", async () => {
  await withTempDir(async () => {
    assert.deepEqual(await readRaw(), {});
    const { writeFile } = await import("node:fs/promises");
    await writeFile(mailConfigPath(), "{坏JSON");
    assert.deepEqual(await readRaw(), {});
  });
});
