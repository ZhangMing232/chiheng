/**
 * 这个文件是干什么的：
 * 钉住 providers 入口的错误日志口径——messageOf 必须把 fetch 的 cause 挖出来。
 *
 * 为什么要有它：腾讯源白天间歇失败时，日志原来只有「fetch failed」四个字，
 * 分不清是 WAF 掐断（ECONNRESET）、超时（ETIMEDOUT）还是 DNS，排障全靠现抓。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { messageOf, readMarketDegraded } from "@/lib/market/providers/index";

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

test("readMarketDegraded：无文件 / 坏 JSON / 超 24h 都返回 null，新鲜状态原样返回", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "chiheng-degraded-"));
  const old = process.env.CHIHENG_DATA_DIR;
  process.env.CHIHENG_DATA_DIR = dir;
  t.after(async () => {
    if (old === undefined) delete process.env.CHIHENG_DATA_DIR;
    else process.env.CHIHENG_DATA_DIR = old;
    await rm(dir, { recursive: true, force: true });
  });

  // 无文件 → null（宁可不归因）
  assert.equal(await readMarketDegraded(), null);

  // 坏 JSON → null
  await writeFile(join(dir, "market-degraded.json"), "{not json");
  assert.equal(await readMarketDegraded(), null);

  // 字段类型不对 → null
  await writeFile(join(dir, "market-degraded.json"), JSON.stringify({ at: 123, source: "sina" }));
  assert.equal(await readMarketDegraded(), null);

  // 超 24h → null（不拿陈旧状态冤枉一轮）
  const staleAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  await writeFile(join(dir, "market-degraded.json"), JSON.stringify({ at: staleAt, source: "sina" }));
  assert.equal(await readMarketDegraded(), null);

  // 新鲜状态 → 原样返回，impact 缺省补默认文案
  const freshAt = new Date().toISOString();
  await writeFile(join(dir, "market-degraded.json"), JSON.stringify({ at: freshAt, source: "sina", impact: "缺近5/20/60日涨幅和量比" }));
  const got = await readMarketDegraded();
  assert.equal(got?.source, "sina");
  assert.equal(got?.impact, "缺近5/20/60日涨幅和量比");
  assert.equal(got?.at, freshAt);

  // impact 缺失 → 补默认影响文案而不是 undefined
  await writeFile(join(dir, "market-degraded.json"), JSON.stringify({ at: freshAt, source: "sina" }));
  const fallback = await readMarketDegraded();
  assert.match(fallback?.impact ?? "", /放量突破|中期反转|涨幅|量比/);
});
