/**
 * 钉死 VT 工具矿山 client 的离线口径——venv/script 缺失时状态为什么是、绝不抛；
 * 环境变量覆盖路径生效（CHIHENG_VT_MCP_PY / CHIHENG_VT_MCP_SCRIPT）；
 * probeVtTools 的返回形状是 /ai 页面板写死的那份。
 * 真实 stdio 握手走手动冒烟（依赖 venv，不进单测）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { invokeVtTool, probeVtTools, shutdownVtTools, vtToolsPrerequisite } from "@/lib/market/vt-tools";

function withEnv(key: string, value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const old = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return fn().finally(() => {
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
  });
}

test("vtToolsPrerequisite：默认路径在项目根下可探到文件", () => {
  // 本机 vendor/ 已就位时 ok；不存在时 why 非空——两种都合法，只钉「不抛 + 布尔与 why 一致」。
  const pre = vtToolsPrerequisite();
  assert.equal(typeof pre.ok, "boolean");
  assert.equal(pre.ok, pre.why === null);
});

test("vtToolsPrerequisite：python 路径不存在时给出直说 why", async () => {
  await withEnv("CHIHENG_VT_MCP_PY", "/nonexistent/bin/python", async () => {
    const pre = vtToolsPrerequisite();
    assert.equal(pre.ok, false);
    assert.match(pre.why ?? "", /python 不存在/);
  });
});

test("vtToolsPrerequisite：script 路径不存在时给出直说 why", async () => {
  await withEnv("CHIHENG_VT_MCP_PY", "/bin/echo", async () => {
    await withEnv("CHIHENG_VT_MCP_SCRIPT", "/nonexistent/mcp_server.py", async () => {
      const pre = vtToolsPrerequisite();
      assert.equal(pre.ok, false);
      assert.match(pre.why ?? "", /mcp_server\.py 不存在/);
    });
  });
});

test("probeVtTools：前置不满足时离线、toolCount 0、checkedAt 非空、不抛", async () => {
  await withEnv("CHIHENG_VT_MCP_PY", "/nonexistent/bin/python", async () => {
    shutdownVtTools(); // 清掉缓存，确保真探
    const status = await probeVtTools(true);
    assert.equal(status.online, false);
    assert.equal(status.toolCount, 0);
    assert.deepEqual(status.tools, []);
    assert.ok(status.checkedAt);
    assert.ok(status.error);
  });
});

test("probeVtTools：有缓存时不重复探测（返回同一份 report 对象）", async () => {
  await withEnv("CHIHENG_VT_MCP_PY", "/nonexistent/bin/python", async () => {
    shutdownVtTools();
    const first = await probeVtTools(true);
    const second = await probeVtTools(); // 走缓存
    assert.equal(second, first);
  });
});

test("invokeVtTool：前置不满足时抛错、消息直说", async () => {
  await withEnv("CHIHENG_VT_MCP_PY", "/nonexistent/bin/python", async () => {
    await assert.rejects(() => invokeVtTool("list_skills", {}), /python 不存在/);
  });
});

test("shutdownVtTools：空跑不抛", () => {
  shutdownVtTools();
  assert.ok(true);
});
