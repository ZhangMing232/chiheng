/**
 * 这个文件是干什么的：
 * 钉住 D6 行业分类的解析与合并规矩。
 *
 * 重点钉两件事：
 * 1. 北交所不能被拼成深市 id（东财市场号 0 同时代表深市和北交所）
 * 2. 一只票命中多个板块时不静默取第一个，要留证
 * 3. 分类文件缺/坏要说清，不能当「零行业」放过去
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIndustryIndex, checkIndustryIndex, emSymbol, finestIndustry, industryOf, parseBoardMembers, parseIndustryBoards } from "@/lib/market/industry";

const boardRows = (rows: unknown[]) => ({ data: { diff: rows } });

test("东财市场号转内部 id：北交所按代码前缀认，不混进深市", () => {
  assert.equal(emSymbol("600519", 1), "sh600519");
  assert.equal(emSymbol("000001", 0), "sz000001");
  assert.equal(emSymbol("301041", 0), "sz301041");
  // 东财给北交所的市场号也是 0，按 market 硬套会造出 sz920821
  assert.equal(emSymbol("920821", 0), "bj920821");
  assert.equal(emSymbol("430047", 0), "bj430047");
  assert.equal(emSymbol("6005199", 1), null, "不是六位就认不出来");
  assert.equal(emSymbol("600519", 9), null, "市场号不认得就别猜");
});

test("板块清单解析：坏行记 gap，不丢整份", () => {
  const { boards, gaps } = parseIndustryBoards(
    boardRows([
      { f12: "BK1340", f14: "印制电路板" },
      { f12: "BK1295", f14: "" },
      { f12: "X", f14: "没有 BK 前缀" },
    ]),
  );
  assert.deepEqual(boards, [{ code: "BK1340", name: "印制电路板" }]);
  assert.equal(gaps.length, 2);
});

test("板块清单整份不对时给一条 gap，而不是返回空列表装作没事", () => {
  const { boards, gaps } = parseIndustryBoards({ data: null });
  assert.equal(boards.length, 0);
  assert.equal(gaps.length, 1);
  assert.match(gaps[0]!.reason, /不是认得的结构/);
});

test("成分股解析：认不出的代码跳过并说明，不静默丢", () => {
  const r = parseBoardMembers(
    boardRows([
      { f12: "688655", f13: 1 },
      { f12: "301041", f13: 0 },
      { f12: "abc", f13: 0 },
    ]),
    { code: "BK1340", name: "印制电路板" },
  );
  assert.deepEqual(r.members, ["sh688655", "sz301041"]);
  assert.match(r.gap ?? "", /1 只代码认不出/);
});

test("多归属取最细那层：成员集合是子集的更细", () => {
  // 东财把一/二/三级都塞在同一份里，一只票同时属于「元件」和「印制电路板」
  const index = buildIndustryIndex(
    [
      { code: "BK1", name: "元件", members: ["sh600000", "sh600001"] },
      { code: "BK2", name: "印制电路板", members: ["sh600000"] },
    ],
    "2026-10-13",
  );
  assert.equal(index.bySymbol["sh600000"]?.length, 2, "全部归属都记下来");
  assert.deepEqual(industryOf(index, "sh600000"), { code: "BK2", name: "印制电路板" });
  // 只在粗板块里的那只，就归粗的
  assert.deepEqual(industryOf(index, "sh600001"), { code: "BK1", name: "元件" });
});

test("成员集合相同按层级标记剪掉粗的：主归属航海装备Ⅲ，不再算含糊", () => {
  // 实测东财会给同一批票挂两个层级标签（白酒Ⅲ 和 白酒Ⅱ 就是同一批）。
  // 两个板块成员完全一样 → 按层级标记剪掉粗的那个，这才叫判明白了
  const index = buildIndustryIndex(
    [
      { code: "BK1", name: "航海装备Ⅱ", members: ["sh600150", "sh600072"] },
      { code: "BK2", name: "航海装备Ⅲ", members: ["sh600150", "sh600072"] },
    ],
    "2026-10-13",
  );
  assert.deepEqual(industryOf(index, "sh600150"), { code: "BK2", name: "航海装备Ⅲ" });
  assert.equal(index.ambiguous.length, 0);
});

test("同层级时成员少的更细：印制电路板 优先于 元件", () => {
  const index = buildIndustryIndex(
    [
      { code: "BK0459", name: "元件", members: ["sh1", "sh2", "sh3"] },
      { code: "BK1340", name: "印制电路板", members: ["sh1", "sh2"] },
    ],
    "2026-10-13",
  );
  assert.deepEqual(industryOf(index, "sh1"), { code: "BK1340", name: "印制电路板" });
  // sh3 只在粗板块里，就归粗的
  assert.deepEqual(industryOf(index, "sh3"), { code: "BK0459", name: "元件" });
});

test("不在同一条链上的多归属剪不掉，如实都返回并记进 ambiguous", () => {
  const index = buildIndustryIndex(
    [
      { code: "BK1", name: "元件", members: ["sh600000", "sh600001"] },
      { code: "BK2", name: "白酒Ⅱ", members: ["sh600000", "sh600002"] },
    ],
    "2026-10-13",
  );
  assert.deepEqual(finestIndustry(index, "sh600000").map((b) => b.name).sort(), ["元件", "白酒Ⅱ"]);
  // 排序后层级更细的在前（白酒Ⅱ 带层级标记，元件没有）
  assert.deepEqual(index.ambiguous, [{ id: "sh600000", boards: ["白酒Ⅱ(BK2)", "元件(BK1)"] }]);
});

test("查不到的行业返回 null，由调用方说明", () => {
  const index = buildIndustryIndex([{ code: "BK1", name: "白酒Ⅱ", members: ["sh600519"] }], "2026-10-13");
  assert.deepEqual(industryOf(index, "sh600519"), { code: "BK1", name: "白酒Ⅱ" });
  assert.equal(industryOf(index, "sz000001"), null);
  assert.equal(index.symbols, 1);
});

test("分类索引校验：缺板块或缺映射都要出声", () => {
  const good = buildIndustryIndex([{ code: "BK1", name: "白酒Ⅱ", members: ["sh600519"] }], "2026-10-13");
  assert.equal(checkIndustryIndex(good).ok, true);
  assert.equal(checkIndustryIndex(null).ok, false);
  assert.equal(checkIndustryIndex({ ...good, boards: [] }).ok, false);
  assert.equal(checkIndustryIndex({ ...good, bySymbol: {} }).ok, false);
  assert.equal(checkIndustryIndex({ ...good, updatedAt: "" }).ok, false);
});
