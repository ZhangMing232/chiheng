/**
 * 优化闭环的测试：混合审批口径。
 * - tunable 键（earlyRejectGap 等）applyRuleDeltas 直接落盘。
 * - core 键（minTrades 等）只进待确认，不自动生效；人工批准后才写。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CHALLENGER_RULE, loadChallengerRule } from "@/lib/market/challenger";
import {
  applyPendingRuleChange,
  applyRuleDeltas,
  readPendingRuleChanges,
  rejectPendingRuleChange,
} from "@/lib/market/optimize";

async function withDataDir(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "optimize-"));
  const prev = process.env.CHIHENG_DATA_DIR;
  process.env.CHIHENG_DATA_DIR = dir;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.CHIHENG_DATA_DIR;
    else process.env.CHIHENG_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

test("applyRuleDeltas：tunable 自动生效、core 待确认、未知忽略", async () => {
  await withDataDir(async () => {
    const result = await applyRuleDeltas([
      { key: "earlyRejectGap", to: 0.08, why: "止损太紧，提前否决门槛该放宽" },
      { key: "minTrades", to: 20, why: "样本够了，起判线可以抬高" },
      { key: "noSuchKey", to: 1, why: "" },
    ]);
    assert.deepEqual(result.applied, ["earlyRejectGap"]);
    assert.deepEqual(result.queued, ["minTrades"]);
    assert.deepEqual(result.ignored, ["noSuchKey"]);

    const rule = await loadChallengerRule();
    assert.equal(rule.earlyRejectGap, 0.08, "tunable 已自动落盘");
    assert.equal(rule.minTrades, CHALLENGER_RULE.minTrades, "core 不许自动改");

    const pending = await readPendingRuleChanges();
    assert.equal(pending.filter((p) => p.status === "pending").length, 1);
    assert.equal(pending[0].key, "minTrades");
    assert.equal(pending[0].to, 20);
  });
});

test("applyRuleDeltas：同键 pending 去重更新，不叠多条", async () => {
  await withDataDir(async () => {
    await applyRuleDeltas([{ key: "minTrades", to: 20, why: "第一次" }]);
    await applyRuleDeltas([{ key: "minTrades", to: 25, why: "第二次" }]);
    const pending = (await readPendingRuleChanges()).filter((p) => p.status === "pending");
    assert.equal(pending.length, 1, "同键只留一条待确认");
    assert.equal(pending[0].to, 25, "取最新值");
    assert.equal(pending[0].why, "第二次");
  });
});

test("applyPendingRuleChange：人工批准后 core 才真正写入", async () => {
  await withDataDir(async () => {
    await applyRuleDeltas([{ key: "minTrades", to: 18, why: "样本足够" }]);
    const pending = (await readPendingRuleChanges()).filter((p) => p.status === "pending");
    assert.equal((await loadChallengerRule()).minTrades, CHALLENGER_RULE.minTrades, "批准前不动");

    const applied = await applyPendingRuleChange(pending[0].id);
    assert.ok(applied);
    assert.equal((await loadChallengerRule()).minTrades, 18, "批准后写入");
    const after = await readPendingRuleChanges();
    assert.equal(after.find((p) => p.id === pending[0].id)?.status, "applied");
  });
});

test("rejectPendingRuleChange：驳回后规则保持不动", async () => {
  await withDataDir(async () => {
    await applyRuleDeltas([{ key: "promoteT", to: 1.0, why: "想放宽" }]);
    const pending = (await readPendingRuleChanges()).filter((p) => p.status === "pending");
    const rejected = await rejectPendingRuleChange(pending[0].id);
    assert.ok(rejected);
    assert.equal((await loadChallengerRule()).promoteT, CHALLENGER_RULE.promoteT, "驳回不动规则");
    const after = await readPendingRuleChanges();
    assert.equal(after.find((p) => p.id === pending[0].id)?.status, "rejected");
  });
});
