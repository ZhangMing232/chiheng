/**
 * 这个文件是干什么的：
 * 钉住证据层的三条底线——同内容同 id、悬空引用必须被抓出来、算不出来要标 insufficient。
 *
 * 悬空引用那条最重要：一个数字声称基于某个证据而那个证据不在账里，
 * 比没有引用更糟，因为它伪装成有据可查。
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  contentHash,
  formatChain,
  linkifyEvidenceText,
  makeCalculation,
  makeEvidence,
  verifyChain,
  type Evidence,
} from "@/lib/market/evidence";

function ev(over: Partial<Evidence> = {}): Evidence {
  return makeEvidence({
    source: "baostock 序列 data/fundamentals/pe-600519.json",
    symbol: "600519",
    field: "peTTM",
    period: "2026-10-09",
    unit: "倍",
    adjustment: "none",
    asOf: "2026-10-09",
    value: 19.39,
    ...over,
  });
}

test("同内容同 id：同样的出处口径值永远是同一条证据", () => {
  assert.equal(ev().id, ev().id);
});

test("值变了 id 就变：两条不同的证据不能撞成一个 id", () => {
  assert.notEqual(ev().id, ev({ value: 20.5 }).id);
});

test("复权口径进 id：不复权和前复权不能算同一条（老坑）", () => {
  assert.notEqual(ev({ adjustment: "none" }).id, ev({ adjustment: "qfq" }).id);
});

test("来源字段不能空：写不出来处的数据不许进账", () => {
  assert.throws(() => ev({ source: "" }), /source/);
});

test("悬空引用必须被抓出来：声称基于某个证据而它不在账里 = 伪装成有据可查", () => {
  const good = ev();
  const calc = makeCalculation({
    fn: "percentileRank",
    inputs: { value: 19.39 },
    inputsRefs: [good.id],
    output: { value: 95, unit: "分位", status: "ok" },
  });
  const ok = verifyChain([good, calc]);
  assert.deepEqual(ok.dangling, []);

  const broken = makeCalculation({
    fn: "percentileRank",
    inputs: { value: 19.39 },
    inputsRefs: ["ev-不存在的那条"],
    output: { value: 95, unit: "分位", status: "ok" },
  });
  const bad = verifyChain([good, broken]);
  assert.equal(bad.dangling.length, 1, "引用了一个账里没有的证据");
  assert.match(bad.dangling[0]!, /不存在/);
});

test("算不出来就标 insufficient，value 必须是 null（不许给看着合理的数）", () => {
  const calc = makeCalculation({
    fn: "percentileRank",
    inputs: { points: 12 },
    inputsRefs: [],
    output: { value: null, unit: "分位", status: "insufficient" },
  });
  assert.equal(calc.output.status, "insufficient");
  assert.equal(calc.output.value, null);
  assert.match(formatChain(calc), /insufficient/);
});

test("formatChain 要能顺着引用走回上游", () => {
  const e = ev();
  const calc = makeCalculation({
    fn: "percentileRank",
    inputs: { value: 19.39 },
    inputsRefs: [e.id],
    output: { value: 95, unit: "分位", status: "ok" },
  });
  const line = formatChain(calc);
  assert.match(line, new RegExp(e.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "要列出上游 id");
  assert.match(line, /percentileRank/);
});

test("重复 id 会被指出来（同一内容记两次，多半是漏改）", () => {
  const a = ev();
  const b = ev();
  const dup = verifyChain([a, b]);
  assert.equal(dup.duplicated.length, 1, "完全相同的两条证据记了两次");
});

test("contentHash 稳定且短：同输入同输出，不同输入不同输出", () => {
  assert.equal(contentHash("abc"), contentHash("abc"));
  assert.notEqual(contentHash("abc"), contentHash("abd"));
  assert.ok(contentHash("abc").length <= 8, "id 要短，长了对页面和日志都不友好");
});

/**
 * linkifyEvidenceText：AI 正文里的证据 id 要能切出来回查
 * （学 Vibe-Research 的证据点击交互）。核心纪律：只有账本里真实存在的
 * id 才成引用段——AI 随口编的 id 保持纯文本，不替它伪造可查性。
 */
const ROW_ID = "ev-identity-收盘价";
const HASH_ID = "ev-a1b2c3";

test("linkify：id 在开头/中间/结尾都能切成引用段", () => {
  const known = new Set([HASH_ID]);
  const atStart = linkifyEvidenceText(`${HASH_ID} 是证据。`, known);
  assert.deepEqual(atStart, [
    { kind: "ref", id: HASH_ID },
    { kind: "text", text: " 是证据。" },
  ]);
  const atEnd = linkifyEvidenceText(`依据 ${HASH_ID}`, known);
  assert.deepEqual(atEnd, [
    { kind: "text", text: "依据 " },
    { kind: "ref", id: HASH_ID },
  ]);
  const inMiddle = linkifyEvidenceText(`甲 ${HASH_ID} 乙 ${HASH_ID} 丙`, known);
  assert.deepEqual(inMiddle.filter((s) => s.kind === "ref").map((s) => (s.kind === "ref" ? s.id : "")), [HASH_ID, HASH_ID]);
});

test("linkify：行内 id（含中文标签）也能切", () => {
  const known = new Set([ROW_ID]);
  const segs = linkifyEvidenceText(`PE 处于低位(${ROW_ID})。`, known);
  const ref = segs.find((s) => s.kind === "ref");
  assert.equal(ref?.kind === "ref" ? ref.id : null, ROW_ID);
});

test("linkify：未知 id 不链接——AI 编的 id 不能变成可点的引用", () => {
  const segs = linkifyEvidenceText("结论(ev-不存在的)成立", new Set([HASH_ID]));
  assert.ok(segs.every((s) => s.kind === "text"), "一个引用段都不许有");
  assert.equal(segs.map((s) => (s.kind === "text" ? s.text : "")).join(""), "结论(ev-不存在的)成立");
});

test("linkify：knownIds 为空原样返回（没有账本就不猜）", () => {
  assert.deepEqual(linkifyEvidenceText(`引用 ${HASH_ID}`, new Set()), [
    { kind: "text", text: `引用 ${HASH_ID}` },
  ]);
});

test("linkify：标点紧跟的 id 要能切出来", () => {
  const known = new Set([HASH_ID]);
  for (const tail of ["，", ",", "。", ")", "）", "；"]) {
    const segs = linkifyEvidenceText(`结论 ${HASH_ID}${tail}继续`, known);
    const ref = segs.find((s) => s.kind === "ref");
    assert.equal(ref?.kind === "ref" ? ref.id : null, HASH_ID, `尾巴是 ${tail} 时也要认出 id`);
  }
});
