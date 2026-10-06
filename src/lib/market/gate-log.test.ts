/**
 * 这个文件是干什么的：
 * 钉住风控闸门和闸门日志的行为。
 *
 * 为什么要单独一个文件：
 * 这两条规则以前**从来没有真正执行过**——`liveGate` 全项目唯一调用点是
 * `src/routes/positions.tsx:200`，只决定渲染哪句文案；`record-journal` 从不 import 它。
 * 所以「连亏就停手」在模拟盘上从来没拦过任何一笔。这种「看起来有、其实没有」的东西，
 * 光靠读代码发现不了，只能靠测试钉死。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hardGate, softGate, liveGate } from "@/lib/market/journal-book";
import { DEFAULT_RULES } from "@/lib/market/rules";
import { appendGateLog, readGateLogs, hardBlocksOn } from "@/lib/market/gate-log";

/** 造一笔已结算的交易。ret 是小数（0.05 = +5%）。 */
function closed(ret: number, date: string) {
  return { date, ret };
}

test("硬闸：连亏到门槛就停止开仓", () => {
  // 门槛按这套策略自己的亏损日比例反推。这里全是亏 days，
  // 亏损日比例 = 1，natural = log(0.05)/log(1) = -0（除零走 0），
  // 所以用规则里的 maxLosingStreak 兜底。
  const trades = [closed(-0.05, "2026-09-01"), closed(-0.04, "2026-09-02"), closed(-0.06, "2026-09-03")];
  const gate = hardGate(trades, { maxLosingStreak: 3, maxDrawdownPct: 0 });
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /连续亏损 3 个交易日/);
});

test("硬闸：样本够、没连亏、近期均值正常就放行", () => {
  const trades = [closed(0.05, "2026-09-01"), closed(-0.02, "2026-09-02"), closed(0.03, "2026-09-03")];
  assert.equal(hardGate(trades, { maxLosingStreak: 3, maxDrawdownPct: 8 }).ok, true);
});

test("硬闸：最近 20 笔均值超过阈值就停（这条不看 indexExit，数据永远够判）", () => {
  // 全是亏的近期样本，但只按 ret 算，不涉及任何指数对照价
  const trades = Array.from({ length: 20 }, (_, i) => closed(-0.1, `2026-09-${String(i + 1).padStart(2, "0")}`));
  const gate = hardGate(trades, { maxLosingStreak: 99, maxDrawdownPct: 8 });
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /最近 20 笔/);
});

test("硬闸：没有已结样本时一律放行——没数据不是亏钱的证据", () => {
  assert.equal(hardGate([], DEFAULT_RULES).ok, true);
});

test("提示闸：样本不够时 ok=false，但这是「还差多少」不是「不能开仓」", () => {
  const gate = softGate(2, [], DEFAULT_RULES);
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /交易日记录 2\/60/);
});

test("提示闸：indexExit 没记上时闭环数恒为 0，但不该拦住开仓", () => {
  // 11 笔已结、但每笔的 indexRet 都是 null（现状就是这样）
  const closedRows = Array.from({ length: 11 }, (_, i) => ({ ret: 0.01, indexRet: null, date: `2026-09-${i + 1}` }));
  const gate = softGate(60, closedRows, DEFAULT_RULES);
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /闭环 0\/20/);
});

test("liveGate 保持原样：它是给页面显示文案用的，判定不再被拆开", () => {
  // 页面还在用 liveGate 决定显示哪句话（A1 拆出了 hard/soft，但没动 liveGate 本身）。
  // 这个测试的作用是提醒：以后改 liveGate 时别以为它会拦开仓——它不会。
  const result = liveGate(2, [], [], DEFAULT_RULES);
  assert.equal(result.ok, false);
  assert.match(result.reason, /交易日记录 2\/60/);
});

// ── 闸门日志的真实读写 ────────────────────────────────────────
// 上面几条测的是「判据算得对不对」，这几条测的是「拦下之后有没有真的留痕」。
// 留痕这一环最容易静默失败：路径写错、目录不存在、JSON 写坏了——
// 都不会报错，只会让你事后发现「风控到底拦没拦过」根本查不出来。

function withTempDataDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "chiheng-gate-"));
  const prev = process.env.CHIHENG_DATA_DIR;
  process.env.CHIHENG_DATA_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.CHIHENG_DATA_DIR;
    else process.env.CHIHENG_DATA_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("闸门日志：拦下来之后真的写进磁盘，而且能读回来", () => {
  withTempDataDir((dir) => {
    assert.deepEqual(readGateLogs(), [], "一开始应该是空的");

    appendGateLog({
      at: 1_700_000_000_000,
      tradingDate: "2026-10-08",
      style: "rebound",
      gate: "hard",
      reason: "已连续亏损 3 个交易日，停止新开仓",
      candidates: [{ id: "sh600000", name: "测试票", buy: 12.34, score: 42 }],
    });

    const raw = readFileSync(join(dir, "gate-blocks.jsonl"), "utf8");
    assert.equal(raw.trim().split("\n").length, 1, "应该是一行一条 JSONL");

    const logs = readGateLogs();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].gate, "hard");
    assert.equal(logs[0].tradingDate, "2026-10-08");
    // 关键：candidates 不能丢。不记它的话事后不知道风控拦的是一批什么样的票
    assert.equal(logs[0].candidates.length, 1);
    assert.equal(logs[0].candidates[0].id, "sh600000");
  });
});

test("闸门日志：多天多条互不干扰，硬闸能按日期查出来", () => {
  withTempDataDir(() => {
    appendGateLog({ at: 1, tradingDate: "2026-10-08", style: "rebound", gate: "hard", reason: "a", candidates: [] });
    appendGateLog({ at: 2, tradingDate: "2026-10-09", style: "breakout", gate: "hard", reason: "b", candidates: [] });
    appendGateLog({ at: 3, tradingDate: "2026-10-09", style: "rebound", gate: "soft", reason: "c", candidates: [] });

    assert.equal(readGateLogs().length, 3);
    assert.equal(hardBlocksOn("2026-10-08").length, 1);
    // soft 不算「风控真的拦过」——它本来就不拦
    assert.equal(hardBlocksOn("2026-10-09").length, 1);
  });
});

test("闸门日志：写到一半崩了留下的坏行被跳过，不会把整份日志废掉", () => {
  withTempDataDir((dir) => {
    appendGateLog({ at: 1, tradingDate: "2026-10-08", style: "rebound", gate: "hard", reason: "好的一条", candidates: [] });
    // 模拟崩溃：追加半行 JSON，没有换行结尾
    appendFileSync(join(dir, "gate-blocks.jsonl"), '{"at":2,"tradingDate":"2026-10-0', "utf8");

    const logs = readGateLogs();
    assert.equal(logs.length, 1, "坏行要跳过，好的那行要还在");
    assert.equal(logs[0].reason, "好的一条");
  });
});
