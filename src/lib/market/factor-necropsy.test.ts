/**
 * 因子死因画像（factor-necropsy.ts）的单测。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { gateLabelCoverage, necropsyLines } from "./factor-necropsy.ts";
import type { TombstoneRecord } from "./factor-tombstones.ts";

function record(partial: Partial<TombstoneRecord>): TombstoneRecord {
  return {
    id: "x",
    name: "某因子",
    category: "动量",
    direction: 1,
    source: "ai",
    diedAt: "2026-10-15T00:00:00.000Z",
    runs: 2,
    failCount: 2,
    note: "连续 2 次未过 6 关，自动淘汰",
    failedGates: ["g1", "g2"],
    rationale: "动量因子应该有正超额。",
    expr: "d20",
    ...partial,
  };
}

test("关名表覆盖 6 关——缺标签会让 AI 拿到 g3 代号而不是「两段」", () => {
  assert.equal(gateLabelCoverage(), true);
});

test("空档案返回空数组（调用方不拼这一段）", () => {
  assert.deepEqual(necropsyLines([]), []);
});

test("聚合头：按死因模式和类别计数，关名用中文标签", () => {
  const lines = necropsyLines([
    record({ failedGates: ["g1", "g2", "g3", "g4", "g5"] }),
    record({ id: "y", failedGates: ["g5", "g4", "g3", "g2", "g1"] }), // 同模式不同顺序 → 归同一桶
    record({ id: "z", category: "量能", failedGates: ["g5"] }),
  ]);
  const header = lines[0]!;
  assert.match(header, /共 3 条/);
  assert.match(header, /「单调\+显著\+两段\+换样本\+多重检验」×2/);
  assert.match(header, /「多重检验」×1/);
  assert.match(header, /动量×2/);
  assert.match(header, /量能×1/);
});

test("败关为空 = 衰减退役，不读成全过；不混进按类别的统计", () => {
  const lines = necropsyLines([record({ failedGates: [] }), record({ id: "y" })]);
  assert.match(lines[0]!, /衰减退役×1/);
  assert.ok(lines.some((line) => line.includes("衰减退役（不是 6 关打死）")));
  // 类别统计只有一条（y），衰减那条不进类别桶
  assert.match(lines[0]!, /按类别：动量×1。/);
});

test("名单按死亡时间倒序、超长的截断，封顶 maxList 条", () => {
  const many = Array.from({ length: 25 }, (_, index) =>
    record({
      id: `r${index}`,
      name: `因子${index}`,
      diedAt: `2026-10-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      rationale: "长".repeat(100),
    }),
  );
  const lines = necropsyLines(many, 20);
  // header + 20 条
  assert.equal(lines.length, 21);
  // 最新（10-25）在最前
  assert.ok(lines[1]!.includes("因子24"));
  // 截断：没有一行超过合理长度
  assert.ok(lines.slice(1).every((line) => line.length < 220));
});

test("含单调死法时给形状警示，全是别的死法时不硬凑", () => {
  assert.match(necropsyLines([record({})])[0]!, /单调也挂/);
  assert.doesNotMatch(
    necropsyLines([record({ failedGates: ["g6"] }), record({ id: "y", failedGates: ["g6"] })])[0]!,
    /单调也挂/,
  );
});
