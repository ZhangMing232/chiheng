/** data-audit 的测试。纯函数吃构造的事实；IO 走 CHIHENG_DATA_DIR 临时目录。 */
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { AUDIT_RULE, auditFromFacts, runDataAudit, type AuditFacts } from "./data-audit.ts";

const good: AuditFacts = {
  universeAgeMin: 5,
  premarket: false,
  klineCount: 300,
  capAgeDays: 1,
  verdictAgeDays: 0,
  fundAgeDays: 1,
};

test("全绿 → 放行，blocks/warns 都空", () => {
  const v = auditFromFacts(good);
  assert.equal(v.pass, true);
  assert.equal(v.blocks.length, 0);
  assert.equal(v.warns.length, 0);
  assert.equal(v.checks.length, 5);
});

test("快照不存在 = block：行情根本没进来，当晚判决不许跑", () => {
  const v = auditFromFacts({ ...good, universeAgeMin: null });
  assert.equal(v.pass, false);
  assert.deepEqual(v.blocks.map((c) => c.id), ["A1"]);
});

test("快照超龄 = block；盘前口径放宽", () => {
  const hot = auditFromFacts({ ...good, universeAgeMin: 40 });
  assert.equal(hot.pass, false);
  const pre = auditFromFacts({ ...good, premarket: true, universeAgeMin: 40 });
  assert.equal(pre.pass, true); // 40 分钟在盘前 14 小时口径内
});

test("K 线缓存不足 = block；warn 不挡跑但记账", () => {
  const v = auditFromFacts({ ...good, klineCount: AUDIT_RULE.minKlineCache - 1, capAgeDays: 30 });
  assert.equal(v.pass, false);
  assert.deepEqual(v.blocks.map((c) => c.id), ["A2"]);
  assert.deepEqual(v.warns.map((c) => c.id), ["A3"]);
});

test("判决日志缺失只是 warn——不挡当晚跑，但 AI 没账可读要记下来", () => {
  const v = auditFromFacts({ ...good, verdictAgeDays: null });
  assert.equal(v.pass, true);
  assert.deepEqual(v.warns.map((c) => c.id), ["A4"]);
});

test("财报库缺失/超龄是 warn：基本面已证伪不挡跑，但数据腐烂要记账", () => {
  const missing = auditFromFacts({ ...good, fundAgeDays: null });
  assert.equal(missing.pass, true);
  assert.deepEqual(missing.warns.map((c) => c.id), ["A5"]);
  const stale = auditFromFacts({ ...good, fundAgeDays: AUDIT_RULE.fundMaxAgeDays + 1 });
  assert.equal(stale.pass, true);
  assert.deepEqual(stale.warns.map((c) => c.id), ["A5"]);
});

test("runDataAudit：留档只追加，两次运行两条", async () => {
  const dir = await mkdtemp(join(tmpdir(), "audit-"));
  process.env.CHIHENG_DATA_DIR = dir;
  try {
    // 构造一个「全缺」的目录：所有事实都是 null → 必 block。
    await mkdir(join(dir, "backtest"), { recursive: true });
    await runDataAudit();
    const v = await runDataAudit();
    assert.equal(v.pass, false);
    const { readFile } = await import("node:fs/promises");
    const lines = (await readFile(join(dir, "backtest", "data-audit.jsonl"), "utf8")).split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
  } finally {
    delete process.env.CHIHENG_DATA_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

// 兜底：事实字段改动时这里会提醒同步测试。
const _shape = auditFromFacts(good);
void _shape;
