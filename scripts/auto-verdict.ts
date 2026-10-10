/**
 * 这个文件是干什么的：
 * 自动判决回测的包装器。record-journal 收盘封印后把它 detached 拉起，它：
 *   0. 先过数据审计闸（data-audit.ts）——行情快照/K 线缓存有 block 级问题就
 *      不跑、推微信叫人，带病出数比不出数害人
 *   1. 快照待验队列状态
 *   2. 跑一轮 BT_FACTOR=1 回测（判决产物照常落 data/backtest + 队列更新）
 *   3. 结束后对比状态变化：有过关 / 淘汰就 PushPlus 推给主人（挑战者判决
 *      本来就在推，因子判决以前没人通知——过了 6 关这种大事不能靠人刷页面发现）
 *
 * 用法（一般由 record-journal 触发，也可以手动重跑）：
 *   node --experimental-strip-types --import ./scripts/alias.mjs scripts/auto-verdict.ts
 */

import { spawn } from "node:child_process";
import { readQueue } from "@/lib/market/factor-queue";
import { readPushToken, sendPushPlus } from "@/lib/market/push";
import { runDataAudit } from "@/lib/market/data-audit";

// 数据审计闸（学 risk/data_audit.py 的 FAIL 熔断）：数据不可信就不跑判决——
// 带病出数比不出数害人。block 级不过 → 推送叫人 + 退出（stamp 已落，不重跑）。
const audit = await runDataAudit();
if (!audit.pass) {
  const lines = audit.blocks.map((c) => `${c.id} ${c.label}：${c.detail}`);
  if (await readPushToken()) {
    await sendPushPlus("赤轨数据审计熔断", ["今晚因子判决回测已阻断：", ...lines, "修复后手动重跑 auto-verdict"].join("\n"));
  }
  console.error(`[auto-verdict] 数据审计未过，判决回测阻断：\n${lines.map((l) => `  ${l}`).join("\n")}`);
  process.exit(2);
}
for (const w of audit.warns) console.log(`[auto-verdict] 审计警告 ${w.id} ${w.label}：${w.detail}（不挡跑）`);

const before = new Map((await readQueue()).entries.map((e) => [e.id, e.status]));
console.log(`[auto-verdict] 回测开始，队列 ${before.size} 条`);

await new Promise<void>((resolve) => {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--import", "./scripts/alias.mjs", "scripts/backtest.ts"],
    { env: { ...process.env, BT_FACTOR: "1" }, stdio: "inherit" },
  );
  // 兜底：回测卡住不能挂一夜（虽然不阻塞记账，但会占着 stamp 让当天不重跑）。
  const killer = setTimeout(() => {
    console.error("[auto-verdict] 回测超 30 分钟未结束，强杀（stamp 已落，明天再验）");
    child.kill("SIGKILL");
  }, 30 * 60_000);
  child.on("exit", (code) => {
    clearTimeout(killer);
    console.log(`[auto-verdict] 回测退出码 ${code}`);
    resolve();
  });
});

const after = (await readQueue()).entries;
const changedTo = (status: string) => after.filter((e) => e.status === status && before.get(e.id) !== status);
const passed = changedTo("passed");
const tombstoned = changedTo("tombstone");

if (passed.length > 0 || tombstoned.length > 0) {
  if (!(await readPushToken())) {
    // token 空着时 sendPushPlus 会静默跳过——这里大声说一次，不然主人以为推了其实没推。
    console.log("[auto-verdict] 有过关/淘汰，但 push-config.json 没填 token，推送跳过（去 /选股页 设置里填）");
  }
  const lines = [
    ...passed.map((e) => `✅ 过 6 关：${e.name}（${e.id}）——进入实盘候选`),
    ...tombstoned.map((e) => `❌ 淘汰：${e.name}（${e.id}）`),
  ];
  await sendPushPlus("赤轨因子判决", lines.join("\n"));
  console.log(`[auto-verdict] 已推送 ${lines.length} 条判决`);
} else {
  console.log(`[auto-verdict] 无过关/淘汰，不打扰`);
}
