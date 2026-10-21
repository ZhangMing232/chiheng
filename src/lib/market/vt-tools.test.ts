/**
 * 这个文件是干什么的：
 * 钉住 vt-tools 的纯函数口径——JSON-RPC 组包、握手消息形状、响应判定。
 * 协议层错一个字段，子进程就挂在那里等超时，这些必须钉死。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCallTool,
  buildInitialize,
  buildInitializedNotification,
  buildListTools,
  frameMsg,
  isResponse,
  resultOf,
} from "@/lib/market/vt-tools";

test("frameMsg：单行 JSON + 换行", () => {
  assert.equal(frameMsg({ a: 1 }), '{"a":1}\n');
  assert.equal(frameMsg({}), '{}\n');
});

test("buildInitialize：协议版本 / clientInfo / jsonrpc 2.0", () => {
  const m = buildInitialize(7);
  assert.equal(m.jsonrpc, "2.0");
  assert.equal(m.id, 7);
  assert.equal(m.method, "initialize");
  const p = m.params as { protocolVersion: string; clientInfo: { name: string } };
  assert.equal(p.protocolVersion, "2025-03-26");
  assert.equal(p.clientInfo.name, "chiheng-vt-tools");
});

test("buildInitializedNotification：无 id 的通知", () => {
  const m = buildInitializedNotification();
  assert.equal(m.method, "notifications/initialized");
  assert.ok(!("id" in m), "通知不许带 id");
});

test("buildListTools / buildCallTool：方法名与参数形状", () => {
  assert.equal(buildListTools(3).method, "tools/list");
  const call = buildCallTool(4, "screen_market", { market: "a", top_n: 3 });
  assert.equal(call.method, "tools/call");
  const p = call.params as { name: string; arguments: Record<string, unknown> };
  assert.equal(p.name, "screen_market");
  assert.deepEqual(p.arguments, { market: "a", top_n: 3 });
});

test("isResponse：有数字 id + result/error 才算响应", () => {
  assert.ok(isResponse('{"jsonrpc":"2.0","id":1,"result":{}}'));
  assert.ok(isResponse('{"jsonrpc":"2.0","id":2,"error":{"code":-32601}}'));
  // 通知（无 id）不是响应
  assert.ok(!isResponse('{"jsonrpc":"2.0","method":"notifications/progress"}'));
  // server->client 请求（有 method）不是响应
  assert.ok(!isResponse('{"jsonrpc":"2.0","id":9,"method":"ping"}'));
  // 坏行不是响应
  assert.ok(!isResponse("not json"));
});

test("resultOf：取 result；error 响应抛错带 message", () => {
  assert.deepEqual(resultOf('{"id":1,"result":{"tools":[]}}'), { tools: [] });
  assert.throws(() => resultOf('{"id":1,"error":{"code":-32602,"message":"bad args"}}'), /bad args/);
});
