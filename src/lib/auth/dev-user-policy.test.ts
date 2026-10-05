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

test("本机独立跑：没配 OAuth、没有真数据库 → 可以用 dev 用户", () => {
  // 这就是 2026-10-05 那台 Mac 的情形。不这样判，服务端账本永远读不到。
  assert.equal(
    mayUseDevUser({ authConfigured: false, databaseConfigured: false, hasRealIdentity: false }),
    true,
  );
});

test("有真数据库时一律不行，哪怕没配 OAuth", () => {
  // 安全线：不能让所有人共用一个身份去读写同一个数据库，宁可整个请求失败
  assert.equal(
    mayUseDevUser({ authConfigured: false, databaseConfigured: true, hasRealIdentity: false }),
    false,
  );
  assert.equal(
    mayUseDevUser({ authConfigured: true, databaseConfigured: true, hasRealIdentity: false }),
    false,
  );
});

test("配了 OAuth 就是有真的登录流程，这次没登录该失败", () => {
  assert.equal(
    mayUseDevUser({ authConfigured: true, databaseConfigured: false, hasRealIdentity: false }),
    false,
  );
});

test("请求里已经有身份（沙箱预览）→ 用真身份，不退到 dev", () => {
  assert.equal(
    mayUseDevUser({ authConfigured: false, databaseConfigured: false, hasRealIdentity: true }),
    false,
  );
});
