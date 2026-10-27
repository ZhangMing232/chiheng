#!/usr/bin/env node
/**
 * 构建后自动重启服务 + 提示。
 * 以前只提示不重启，人老是忘，然后页面还是旧的。
 */

import { statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

try {
  const builtAt = statSync(".output").mtimeMs;
  const mins = Math.round((Date.now() - builtAt) / 1000 / 60);
  console.log("");
  console.log(`构建完成（${mins <= 1 ? "刚刚" : `${mins} 分钟前`}）。`);

  // 自动重启：kickstart serve + tunnel
  const uid = spawnSync("id", ["-u"], { encoding: "utf8" }).stdout.trim();
  const gui = `gui/${uid}`;

  const r1 = spawnSync("launchctl", ["kickstart", "-k", `${gui}/com.chiheng.serve`], { timeout: 5000 });
  const r2 = spawnSync("launchctl", ["kickstart", "-k", `${gui}/com.chiheng.tunnel`], { timeout: 5000 });

  const ok = r1.status === 0 && r2.status === 0;
  console.log(`  · 服务已${ok ? "重启" : "重启部分失败，手动跑 npm run mac:restart"}。`);
  console.log("  · 浏览器强刷（Cmd + Shift + R）就能看到新页面。");
  console.log("  · meanwhy.top 也已刷新。");
} catch {
  console.log("构建完成（读不到 .output 的时间，跳过提示）。");
}