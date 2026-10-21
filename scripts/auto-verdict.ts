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

// 跑一轮回测子进程，返回退出码（kill 兜底算作失败码 124）。
function runBacktestOnce(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--import", "./scripts/alias.mjs", "scripts/backtest.ts"],
      { env: { ...process.env, BT_FACTOR: "1" }, stdio: "inherit" },
    );
    // 兜底：回测卡住不能挂一夜（虽然不阻塞记账，但会占着 stamp 让当天不重跑）。
    const killer = setTimeout(() => {
      console.error("[auto-verdict] 回测超 30 分钟未结束，强杀");
      child.kill("SIGKILL");
    }, 30 * 60_000);
    child.on("exit", (code) => {
      clearTimeout(killer);
      resolve(code ?? 1);
    });
  });
}

// 行情接口（腾讯 K 线）会间歇性 TLS 断连/超时——网络一抖当晚判决就静默缺席，
// stamp 已落、记账脚本不会再拉起。这里自愈：失败等 90s 重跑，最多 3 次；
// 三次都败才认栽，并且推一条失败通知（沉默缺席比判不出来更害人）。
const MAX_ATTEMPTS = 3;
let exitCode = 1;
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  exitCode = await runBacktestOnce();
  console.log(`[auto-verdict] 回测退出码 ${exitCode}（第 ${attempt}/${MAX_ATTEMPTS} 次）`);
  if (exitCode === 0) break;
  if (attempt < MAX_ATTEMPTS) {
    console.log("[auto-verdict] 90s 后重试…");
    await new Promise((r) => setTimeout(r, 90_000));
  }
}

if (exitCode !== 0) {
  const msg = `今晚因子判决回测失败（退出码 ${exitCode}，已重试 ${MAX_ATTEMPTS} 次），多半是行情接口网络抖动。队列里待验因子顺延到明天；急的话手动重跑 auto-verdict。`;
  if (await readPushToken()) await sendPushPlus("赤轨因子判决失败", msg);
  console.error(`[auto-verdict] ${msg}`);
  process.exit(1);
}

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
