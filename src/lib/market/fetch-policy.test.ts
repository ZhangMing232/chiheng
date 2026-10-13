/**
 * 这个文件是干什么的：
 * 钉住取数纪律这张表本身——它是单一来源，表里写错了所有脚本跟着错。
 *
 * 重点钉：
 * 1. 东财限速真的登记了，且不是 0（0 等于没限速，跑起来会被封）
 * 2. TTL 量级对得上业务节奏（行情分钟级、财报月级），别被统一成一个数
 * 3. isFresh 判过期：过了 TTL 就是过期，没有「差不多还能用」这一档
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CACHE_TTL, isFresh, rateLimitOf, ttlOf } from "@/lib/market/fetch-policy";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

test("东财限速已登记且不是 0", () => {
  const em = rateLimitOf("eastmoney");
  assert.ok(em.minGapMs >= 1000, `东财间隔 ${em.minGapMs}ms，太短会被风控`);
  assert.match(em.why, /实测/, "要写清这个数是怎么来的");
});

test("没登记的源返回 0 而不是报错", () => {
  assert.equal(rateLimitOf("baostock").minGapMs, 0);
});

test("每条 TTL 都写了理由", () => {
  for (const policy of Object.values(CACHE_TTL)) {
    assert.ok(policy.why.length > 10, `${policy.key} 没写理由`);
    assert.ok(policy.ttlMs > 0, `${policy.key} 的 TTL 不能是 0`);
  }
});

test("TTL 量级跟着业务节奏走，不是一个数管所有", () => {
  assert.ok(ttlOf("universe") <= 30 * MIN, "行情快照是分钟级");
  assert.ok(ttlOf("consensus") >= DAY, "一致预期是天级");
  assert.ok(ttlOf("fundamentals") >= 30 * DAY, "财报是月级");
});

test("isFresh：过了 TTL 就是过期，没有差不多这一档", () => {
  const now = 1_000_000_000;
  const ttl = ttlOf("universe");
  assert.equal(isFresh(now - ttl + 1, "universe", now), true, "差一毫秒没过期就是没过期");
  assert.equal(isFresh(now - ttl, "universe", now), false, "刚好到点就算过期");
  assert.equal(isFresh(0, "universe", now), false, "没抓过不算新鲜");
  assert.equal(isFresh(NaN, "universe", now), false);
});
