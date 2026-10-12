/**
 * 这个文件是干什么的：
 **钉住「文档与代码的一致性」** —— 这是赤轨比 Vibe-Research 强的一环。
 *
 * Vibe 把宪法 sha256 记进 manifest，是**事后**可查。赤轨再加一层：改了 `AI-BOUNDARY.md`
 * 没改 `boundary.ts`（或反之），**`npm test` 当场红**，而不是等出事才发现两处对不上。
 *
 * 这条纪律来自 `AI-BOUNDARY.md` 自己的改动纪律（L49-52）：新增条目必须同时给出
 * 闸门函数位置 + 测试文件。缺一样不合并。所以这里的断言不只是在数数，是在守住那条纪律。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BOUNDARY_PATH,
  BOUNDARY_VERSION,
  IMMUTABLE_LINES,
  PROHIBITIONS,
  boundaryHash,
  countBoundaryRules,
  sha256,
  type Rule,
} from "@/lib/market/boundary";

const ROOT = process.cwd();

async function readBoundary(): Promise<string> {
  return readFile(join(ROOT, BOUNDARY_PATH), "utf8");
}

test("🔴 文档「§0 不可越线」条数 === IMMUTABLE_LINES 条数", async () => {
  const md = await readBoundary();
  const counts = countBoundaryRules(md);
  assert.equal(
    counts.immutable,
    IMMUTABLE_LINES.length,
    `AI-BOUNDARY.md 里 §0 写了 ${counts.immutable} 条，boundary.ts 里只有 ${IMMUTABLE_LINES.length} 条。两边必须同时改。`,
  );
});

test("🔴 文档「禁止清单」条数 === PROHIBITIONS 条数", async () => {
  const md = await readBoundary();
  const counts = countBoundaryRules(md);
  assert.equal(
    counts.prohibitions,
    PROHIBITIONS.length,
    `AI-BOUNDARY.md 里禁止清单写了 ${counts.prohibitions} 条，boundary.ts 里只有 ${PROHIBITIONS.length} 条。两边必须同时改。`,
  );
});

test("🔴 每条规则都给了硬闸门位置（没闸门的条目不许存在）", () => {
  for (const r of [...IMMUTABLE_LINES, ...PROHIBITIONS]) {
    assert.ok(r.gate.length > 0, `${r.id} 没写 gate —— 无闸门的边界等于没边界`);
    assert.ok(r.gate.includes("."), `${r.id} 的 gate 要指到具体文件，不能是空话`);
  }
});

test("id 唯一", () => {
  const ids = [...IMMUTABLE_LINES, ...PROHIBITIONS].map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, `重复 id：${ids.filter((v, i) => ids.indexOf(v) !== i).join(", ")}`);
});

test("§0 三条里必须有「不给投资动作建议」", () => {
  // 这条是 P0-5 刚落的红线，也是做 AI 个股研判的前提
  const ids = IMMUTABLE_LINES.map((r) => r.id);
  assert.ok(ids.includes("no-advice"), "§0 缺 no-advice：做研判页前必须有这条");
});

test("boundaryHash 读得到文档时给出稳定 sha256", async () => {
  const h = await boundaryHash(ROOT);
  assert.ok(h, "读不到 AI-BOUNDARY.md（应在仓库根目录跑测试）");
  assert.equal(h!.length, 16, "与 ai-retry.ts 的 fingerprint 同约定：前 16 位");
  // 同内容必须同 hash
  const again = await boundaryHash(ROOT);
  assert.equal(h, again);
});

test("boundaryHash 读不到时返回 null，不抛错", async () => {
  const h = await boundaryHash("/一个不存在的目录");
  assert.equal(h, null, "留档用的东西不该把主流程带崩");
});

test("sha256 对空串和不同内容给出不同值", () => {
  assert.equal(sha256(""), sha256(""));
  assert.notEqual(sha256("a"), sha256("b"));
});

test("版本号格式", () => {
  assert.match(BOUNDARY_VERSION, /^\d+\.\d+\.\d+$/);
});

test("解析函数：只数编号条目，不被正文干扰", () => {
  const md = [
    "## §0 三条不可越线",
    "1. 第一条",
    "解释文字里出现 1. 也不该被数",
    "2. 第二条",
    "## ❌ 禁止清单",
    "1. 甲",
    "2. 乙",
    "3. 丙",
    "## 别的章节",
    "1. 不该计入",
  ].join("\n");
  const c = countBoundaryRules(md);
  assert.equal(c.immutable, 2);
  assert.equal(c.prohibitions, 3);
});

test("类型契约：Rule 三个字段齐全", () => {
  const r: Rule = { id: "x", title: "y", gate: "z.ts" };
  assert.deepEqual(Object.keys(r).sort(), ["gate", "id", "title"]);
});
