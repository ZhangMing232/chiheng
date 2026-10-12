/**
 * 这个文件是干什么的：
 * 钉住 registry 的几条硬约束。
 *
 * 这个表存在的意义是「**让机器和 AI 能查到口径陷阱**」——所以它自己必须先站得住：
 * id 不唯一会让查询静默取错；critical 端点没有 traps 是最危险的（关键数据失败时
 * 没有处置说明，人会本能地拿旧值顶上，而那正是这个表要杜绝的事）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ENDPOINTS, endpointOf, endpointsBySource, criticalOf } from "@/lib/market/registry";

test("每条端点必填字段齐全", () => {
  for (const e of ENDPOINTS) {
    assert.ok(e.id, "缺 id");
    assert.ok(e.title, `${e.id} 缺 title`);
    assert.ok(e.source, `${e.id} 缺 source`);
    assert.ok(e.unit, `${e.id} 缺 unit`);
    assert.ok(e.fetcher, `${e.id} 缺 fetcher（要能反查到实现）`);
    assert.ok(["a", "hk", "us"].includes(e.market), `${e.id} market 非法`);
    assert.ok(
      ["official", "public-web", "licensed"].includes(e.compliance),
      `${e.id} compliance 非法`,
    );
  }
});

test("🔴 id 唯一（重复会让 endpointOf 静默取错一条）", () => {
  const ids = ENDPOINTS.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, `重复 id：${ids.filter((v, i) => ids.indexOf(v) !== i).join(", ")}`);
});

test("🔴 critical 端点必须带 traps（关键数据失败时要有处置说明）", () => {
  for (const e of ENDPOINTS.filter((x) => x.critical)) {
    assert.ok(e.traps.length > 0, `${e.id} 是关键端点但没有 traps`);
  }
});

test("traps 不能是空话——要能回溯到实测出处", () => {
  // 「注意单位」这种没用。要求带具体数字、或带文件/行号、或明确写出两个口径的差异。
  const actionable = /(元|万元|1e4|null|时区|毫秒|\.ts:|\.py|见\b|不同|不含|封顶|挡\b|无备份|——)/;
  for (const e of ENDPOINTS) {
    for (const t of e.traps) {
      assert.match(t, actionable, `${e.id} 的 traps「${t}」太笼统，写清差异或给出处`);
    }
  }
});

test("endpointOf 查得到 / 查不到都明确", () => {
  assert.ok(endpointOf("tencent.universe"));
  assert.equal(endpointOf("不存在的端点"), undefined, "查不到要给 undefined，不要返回一个假端点");
});

test("endpointsBySource 分组后总数不变", () => {
  const grouped = endpointsBySource();
  const total = [...grouped.values()].reduce((n, list) => n + list.length, 0);
  assert.equal(total, ENDPOINTS.length);
});

test("criticalOf('a') 至少覆盖快照与 K 线", () => {
  const ids = criticalOf("a").map((e) => e.id);
  assert.ok(ids.includes("tencent.universe"), "全市场快照必须关键");
  assert.ok(ids.includes("tencent.kline"), "K 线必须关键");
});

test("market 字段：A 股之外，hk/us 只许出现在港美端点（M1/M2 已接入）", () => {
  // 2026-10-12 M1/M2 拍板先美港：market 不再只填 a，但 hk/us 只许是港美行情端点——
  // 防止有人给 A 股端点随手填 hk/us，或加了 market 条目却没接数据源。
  const overseasIds = new Set(["eastmoney.hk", "eastmoney.us"]);
  for (const e of ENDPOINTS) {
    if (e.market === "a") continue;
    assert.ok(overseasIds.has(e.id), `${e.id} 标了 market=${e.market} 但不是已接入的港美端点`);
  }
  assert.ok(ENDPOINTS.some((e) => e.market === "hk"), "港股端点必须存在（M1/M2 已拍板）");
  assert.ok(ENDPOINTS.some((e) => e.market === "us"), "美股端点必须存在（M1/M2 已拍板）");
});
