/**
 * 判决规则外置的测试：CHALLENGER_RULE 从「写死常量」变成「代码默认 ← 数据文件覆盖」。
 * 钉三件事：无文件回默认、写后读回、judgeChallenger 真的按传入规则判（不再写死）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CHALLENGER_RULE, judgeChallenger, loadChallengerRule, saveChallengerRule } from "@/lib/market/challenger";

async function withDataDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "chal-rule-"));
  const prev = process.env.CHIHENG_DATA_DIR;
  process.env.CHIHENG_DATA_DIR = dir;
  try {
    await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.CHIHENG_DATA_DIR;
    else process.env.CHIHENG_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

test("loadChallengerRule：没有数据文件 → 代码默认", async () => {
  await withDataDir(async () => {
    assert.deepEqual(await loadChallengerRule(), CHALLENGER_RULE);
  });
});

test("saveChallengerRule：写后读回，只写认识的数值字段", async () => {
  await withDataDir(async () => {
    const saved = await saveChallengerRule({ minTrades: 20, earlyRejectGap: 0.08 });
    assert.equal(saved.minTrades, 20);
    assert.equal(saved.earlyRejectGap, 0.08);
    // 没传的保持默认
    assert.equal(saved.promoteT, CHALLENGER_RULE.promoteT);
    // 再读一遍确认落盘
    const reloaded = await loadChallengerRule();
    assert.equal(reloaded.minTrades, 20);
    assert.equal(reloaded.earlyRejectGap, 0.08);
  });
});

test("loadChallengerRule：脏数据（非数值 / 数组）退回默认，不半截生效", async () => {
  await withDataDir(async (dir) => {
    await writeFile(join(dir, "challenger-rule.json"), JSON.stringify({ minTrades: "abc", promoteT: null, maxTrades: 50 }), "utf8");
    const rule = await loadChallengerRule();
    assert.equal(rule.minTrades, CHALLENGER_RULE.minTrades, "非数值退回默认");
    assert.equal(rule.promoteT, CHALLENGER_RULE.promoteT, "null 退回默认");
    assert.equal(rule.maxTrades, 50, "合法数值保留");
  });
});

test("judgeChallenger：规则从参数来，不写死——minTrades 改小就提前判", () => {
  // 10 笔样本；挑战者每笔都亏，自己的 t 会很负。
  const champ = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01));
  const chal = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? -0.02 : -0.04));

  // 默认 minTrades=15：10 笔不够，判 none。
  assert.equal(judgeChallenger(champ, chal).action, "none", "默认要 15 笔，10 笔不判");

  // 把规则当参数传进去（minTrades=3）→ 立刻进入判决，不是 none。
  const custom = judgeChallenger(champ, chal, 0, { ...CHALLENGER_RULE, minTrades: 3 });
  assert.notEqual(custom.action, "none", "规则改了就该判——证明没写死");
  assert.equal(custom.action, "reject", "挑战者持续亏、t 很负 → 淘汰");
});
