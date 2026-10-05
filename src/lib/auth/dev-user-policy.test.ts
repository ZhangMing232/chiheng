/**
 * 这个文件是干什么的：
 * 守住「什么时候可以用共享 dev 用户」这条判据。
 *
 * 你需要知道的：
 * 判据错一边是「账本永远读不到、页面假装账本是空的」（2026-10-05 下午），
 * 错另一边是「对着真数据库让所有人共用一个身份」。两个方向都不能错。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mayUseDevUser } from "@/lib/auth/dev-user-policy";

test("本机独立跑：请求没身份、没有真数据库 → 可以用 dev 用户", () => {
  // 这就是 2026-10-05 那台 Mac 的情形。不这样判，服务端账本永远读不到。
  assert.equal(mayUseDevUser({ databaseConfigured: false, hasRealIdentity: false }), true);
});

test("有真数据库时一律不行", () => {
  // 安全线：不能让所有人共用一个身份去读写同一个数据库，宁可整个请求失败
  assert.equal(mayUseDevUser({ databaseConfigured: true, hasRealIdentity: false }), false);
});

test("判据里不能有「OAuth 配没配」——占位凭据让它恒为 true", () => {
  // authConfigured = Boolean(grokClientId && grokClientSecret)，
  // 而没 .env 时这两个值退到 PREVIEW_CLIENT_ID = "grok_preview"（非空）→ 恒为 true。
  // 第一版把它当判据，结果单测全绿、真机上账本还是空的。
  // 这条测试是钉住「别再把 authConfigured 加回来」。
  assert.equal(mayUseDevUser({ databaseConfigured: false, hasRealIdentity: false }), true);
});

test("请求里已经有身份（沙箱预览）→ 用真身份，不退到 dev", () => {
  assert.equal(mayUseDevUser({ databaseConfigured: false, hasRealIdentity: true }), false);
});
