/**
 * 这个文件是干什么的：
 * 钉住 ai-retry.ts 的熔断规则。这套规则的每一条都是对着一次真实白跑写的，
 * 所以测试要钉的不是「代码怎么写」，而是「这几条不许被优化掉」。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  AI_FAILURE_TTL_MS,
  AI_MAX_SAME_FAILURE,
  canAttempt,
  clearFailure,
  fingerprint,
  recordFailure,
  type AIFailureBook,
} from "@/lib/market/ai-retry";

const NOW = Date.parse("2026-10-10T08:00:00Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

test("fingerprint：同一个 model+prompt 必须稳定，不同的必须换", async () => {
  const a = await fingerprint("deepseek-flash", "回测 20 日动量");
  const b = await fingerprint("deepseek-flash", "回测 20 日动量");
  const c = await fingerprint("deepseek-flash", "回测 20 日动量。"); // 多一个句号
  const d = await fingerprint("deepseek-chat", "回测 20 日动量");
  assert.equal(a, b, "同样的输入必须算出同样的指纹，否则熔断形同虚设");
  assert.notEqual(a, c, "prompt 改一个字就是新调用（Vibe-Trading：changed arguments can always execute）");
  assert.notEqual(a, d, "换模型算新调用，值得再试一次");
});

test("fingerprint：key 不进指纹（否则换了档案就能绕过熔断）", async () => {
  // 指纹函数只接 model 和 prompt，压根没有 key 参数——这本身就是断言。
  const fp = await fingerprint("deepseek-flash", "同一句话");
  assert.equal(fp, await fingerprint("deepseek-flash", "同一句话"));
});

test("一次失败后仍可重试（瞬时失败是允许的）", async () => {
  const book: AIFailureBook = {};
  const fp = await fingerprint("m", "p");
  const after1 = recordFailure(book, fp, "AI 接口 HTTP 429", { now: NOW });
  assert.equal(canAttempt(after1, fp, { now: NOW }).ok, true, "第 1 次失败后还能发，这就是重试机会");
});

test("🔴 同一句话连续失败到上限就拒绝", async () => {
  const fp = await fingerprint("m", "p");
  let book: AIFailureBook = {};
  book = recordFailure(book, fp, "HTTP 401", { now: NOW });
  book = recordFailure(book, fp, "HTTP 401", { now: NOW + 1000 });
  const verdict = canAttempt(book, fp, { now: NOW + 2000 });
  assert.equal(verdict.ok, false, "第 2 次失败起拒绝");
  assert.match(verdict.reason, /连续失败 2 次/);
  assert.match(verdict.reason, /HTTP 401/, "拒绝的原因要带上上次失败详情，否则人看不懂");
  assert.match(verdict.reason, /改了 prompt 或换模型会自动放行/, "要说清怎么绕过");
});

test("失败计数封顶，不无限累加", async () => {
  const fp = await fingerprint("m", "p");
  let book: AIFailureBook = {};
  for (let i = 0; i < 10; i++) book = recordFailure(book, fp, `err${i}`, { now: NOW + i });
  assert.equal(book[fp].count, AI_MAX_SAME_FAILURE, "再失败也不该超过上限，数字继续涨没有信息量");
});

test("🔴 成功即清零", async () => {
  const fp = await fingerprint("m", "p");
  let book: AIFailureBook = {};
  book = recordFailure(book, fp, "HTTP 500", { now: NOW });
  book = recordFailure(book, fp, "HTTP 500", { now: NOW + 1000 });
  assert.equal(canAttempt(book, fp, { now: NOW + 2000 }).ok, false);
  const cleared = clearFailure(book, fp);
  assert.equal(canAttempt(cleared, fp, { now: NOW + 3000 }).ok, true, "成功过一次就说明这通话是通的");
  assert.equal(book[fp].count, 2, "clearFailure 不改入参");
});

test("改了 prompt 就放行（指纹变了 = 新调用）", async () => {
  let book: AIFailureBook = {};
  const fpA = await fingerprint("m", "prompt A");
  book = recordFailure(book, fpA, "HTTP 500", { now: NOW });
  book = recordFailure(book, fpA, "HTTP 500", { now: NOW + 1000 });
  assert.equal(canAttempt(book, fpA, { now: NOW + 2000 }).ok, false);
  const fpB = await fingerprint("m", "prompt B");
  assert.equal(canAttempt(book, fpB, { now: NOW + 2000 }).ok, true, "换了 prompt 就是另一次调用，应该放行");
});

test("🔴 超过 TTL 的失败记录视为没有（不能永久封死）", async () => {
  const fp = await fingerprint("m", "p");
  let book: AIFailureBook = {};
  book = recordFailure(book, fp, "HTTP 401", { now: NOW });
  book = recordFailure(book, fp, "HTTP 401", { now: NOW + 1000 });
  assert.equal(canAttempt(book, fp, { now: NOW + 2000 }).ok, false, "当场确实该拦");
  // TTL 从**最后一次失败**算起，不是从第一次。这一点写死：重试本身会刷新计数，
  // 所以「还在重试」和「已经放弃」的分界必须跟着最后一次尝试走。
  const lastFailure = NOW + 1000;
  assert.equal(
    canAttempt(book, fp, { now: lastFailure + AI_FAILURE_TTL_MS - 1000 }).ok,
    false,
    "TTL 之内仍然算失败",
  );
  assert.equal(
    canAttempt(book, fp, { now: lastFailure + AI_FAILURE_TTL_MS + 1 }).ok,
    true,
    "一天后必须放行：一次网络事故不该永久拉黑一个 prompt",
  );
});

test("TTL 边界：刚好到期仍然算过期", async () => {
  const fp = await fingerprint("m", "p");
  const book = recordFailure({} as AIFailureBook, fp, "err", { now: NOW });
  assert.equal(canAttempt(book, fp, { now: NOW + AI_FAILURE_TTL_MS }).ok, true, "恰好等于 TTL 就是过期");
  assert.equal(canAttempt(book, fp, { now: NOW + AI_FAILURE_TTL_MS - 1000 }).ok, true, "TTL 内还没到上限（只失败 1 次）");
});

test("坏掉的时间戳按过期处理（宁可多发一次）", async () => {
  const fp = await fingerprint("m", "p");
  const book: AIFailureBook = { [fp]: { count: 99, at: "不是时间", reason: "脏数据" } };
  assert.equal(canAttempt(book, fp, { now: NOW }).ok, true, "一条脏数据不该把 prompt 永久封死");
});

test("recordFailure 不改入参", async () => {
  const book: AIFailureBook = {};
  recordFailure(book, await fingerprint("m", "p"), "err", { now: NOW });
  assert.deepEqual(book, {}, "必须返回新账，调用方拿着旧账继续传会串");
});

test("clearFailure 对不存在的指纹是安全的空操作", async () => {
  const book: AIFailureBook = {};
  assert.equal(clearFailure(book, "不存在的指纹"), book);
});

test("reason 截断到 200 字（接口可能返回超长错误页）", async () => {
  const fp = await fingerprint("m", "p");
  const book = recordFailure({} as AIFailureBook, fp, "x".repeat(5000), { now: NOW });
  assert.equal(book[fp].reason.length, 200);
});
