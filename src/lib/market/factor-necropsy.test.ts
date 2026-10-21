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

test("edgeFamilyLines：只挑历史某批五关全过、独挂 g5 的临门一脚家族", async () => {
  const { edgeFamilyLines } = await import("./factor-necropsy.ts");
  const run = (factor: string, gates: Record<string, boolean>, t = 2.9) =>
    ({ factor, name: factor, t, nTested: 37, gates }) as never;
  // 大市值三兄弟式的真 edge 家族：某批只挂 g5
  const near = record({ id: "largecap_vol", name: "大市值高量比", failedGates: ["g5"], expr: "log(floatCap) * volRatio" });
  // 五关全挂的平庸死因子：不算临门一脚
  const dead = record({ id: "weak_mom", name: "弱动量", failedGates: ["g1", "g2", "g3", "g4", "g5"] });
  // 衰减退役（无败关信息）：不参选对错判断，但也绝不进名单
  const decayed = record({ id: "old_decay", name: "老衰减", failedGates: [] });

  const rows = [
    run("largecap_vol", { g1: true, g2: true, g3: true, g4: true, g5: false, g6: true }, 3.05),
    run("largecap_vol", { g1: true, g2: false, g3: false, g4: false, g5: false, g6: true }, 1.2),
    run("weak_mom", { g1: false, g2: false, g3: false, g4: false, g5: false, g6: true }, 0.8),
  ];
  const lines = edgeFamilyLines([near, dead, decayed], rows);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /大市值高量比/);
  assert.match(lines[0]!, /独挂多重检验/);
  assert.match(lines[0]!, /t=3\.05/);
  assert.match(lines[0]!, /N=37/);
  // 全部候选都没五关全过过的批次 → 空名单
  assert.deepEqual(
    edgeFamilyLines([near], [run("largecap_vol", { g1: true, g2: true, g3: true, g4: true, g5: false, g6: false })]),
    [],
  );
  // runs 里根本没这个因子 → 不编数，不进名单
  assert.deepEqual(edgeFamilyLines([near], []), []);
});
