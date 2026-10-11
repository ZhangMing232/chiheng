/** system-rules 的测试：面板数据必须由五个常量拼出，不许出现第二份数字。 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { AUDIT_RULE } from "./data-audit.ts";
import { BREAKER_RULE } from "./evolve-breaker.ts";
import { DECAY_RULE } from "./decay.ts";
import { CHALLENGER_RULE } from "./challenger.ts";
import { STRATEGY_GATE } from "./strategy-gate.ts";
import { systemRules } from "./system-rules.ts";

test("五组判据都在，组里至少一条，id 全库唯一", () => {
  const groups = systemRules();
  assert.equal(groups.length, 5);
  const ids = groups.flatMap((g) => g.entries.map((e) => e.id));
  assert.equal(new Set(ids).size, ids.length, "条目 id 不许重复");
  for (const g of groups) {
    assert.ok(g.entries.length > 0, `${g.title} 至少一条`);
    assert.ok(g.source.includes(".ts"), `${g.title} 要给出处文件`);
    for (const e of g.entries) {
      assert.ok(e.label && e.value && e.note, `${e.id} 三要素缺一不可`);
    }
  }
});

test("面板数值 = 常量真值（防止哪天手滑写成字面量，和常量脱钩）", () => {
  const groups = systemRules();
  const all = Object.fromEntries(groups.flatMap((g) => g.entries.map((e) => [e.id, e.value])));

  assert.ok(all["a1-universe"].includes(String(AUDIT_RULE.universeMaxAgeMin.intraday)), "A1 盘中分钟数来自常量");
  assert.ok(all["a2-kline"].includes(String(AUDIT_RULE.minKlineCache)), "A2 下限来自常量");
  assert.ok(all["a5-fund"].includes(String(AUDIT_RULE.fundMaxAgeDays)), "A5 上限来自常量");
  assert.ok(all["b1-trip"].includes(String(BREAKER_RULE.maxConsecutiveErrors)), "熔断轮数来自常量");
  assert.ok(all["d1-thresholds"].includes(String(DECAY_RULE.tRatio.healthy)), "衰减阈值来自常量");
  assert.ok(all["c1-window"].includes(String(CHALLENGER_RULE.minTrades)), "挑战者起判笔数来自常量");
  assert.ok(all["s1-disable"].includes(String(STRATEGY_GATE.window)), "策略窗口来自常量");
});

test("加判据只加条目不改框架：组 id 固定", () => {
  const groups = systemRules();
  assert.deepEqual(
    groups.map((g) => g.id),
    ["audit", "breaker", "decay", "challenger", "strategy-gate"],
  );
});
