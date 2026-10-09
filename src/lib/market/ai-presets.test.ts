/**
 * 这个文件是干什么的：
 * 钉住 AI 服务商预设目录（ai-presets.ts）的结构约定：id 唯一、有 baseUrl 的
 * 预设地址必须是 http(s)、自定义项兜底。预设错了弹窗就带错路，属于低成本高
 * 收益的钉子。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_PRESETS } from "@/lib/market/ai-presets";

test("预设目录：id 唯一、至少一个预设、自定义项存在", () => {
  assert.ok(PROVIDER_PRESETS.length >= 3);
  const ids = PROVIDER_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(PROVIDER_PRESETS.some((p) => p.id === "custom"));
});

test("预设目录：填了 baseUrl 的必须是 http(s) URL；模型列表无重复", () => {
  for (const p of PROVIDER_PRESETS) {
    if (p.baseUrl) assert.match(p.baseUrl, /^https?:\/\//, `${p.id} 的 baseUrl 不合法`);
    assert.equal(new Set(p.models).size, p.models.length, `${p.id} 的模型列表有重复`);
    for (const m of p.models) assert.ok(m.trim().length > 0, `${p.id} 有空模型名`);
  }
});
