#!/usr/bin/env node
/**
 * 构建后提示 + 必要时温和重启服务。
 *
 * 2026-11-08 全量体检修掉一个会真把站点弄挂的 bug：原先无条件跑
 * `launchctl kickstart -k`（**-k = 强制 SIGTERM 再拉起**）。在受限环境里新进程
 * 起不来，日志里就是一串「Stopping server gracefully / Server closed successfully」，
 * 连续几次 build 后 8787 直接没监听、curl 000。实测**不带 -k** 的 kickstart
 * 能恢复且不会挂。
 *
 * 而且 serve 本来就是常驻进程，home-server.mjs 自己会检测「.output 比进程新」
 * 并提示重载，根本不需要每次构建强杀。所以新逻辑是：
 *   1. 先探活（node 内置 http，不用 curl——spawnSync 拉起的 curl 会被网络策略拦成 000）；
 *   2. 活着 → 不碰服务，只提示强刷；
 *   3. 没响应 → 用不带 -k 的 kickstart 温和拉起，再探一次活，如实报告。
 */

import { statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { get as httpGet } from "node:http";

const PROBE_URL = "http://127.0.0.1:8787/favicon.svg"; // 不探 /：首页慢会误报

function probeAlive() {
  return new Promise((resolve) => {
    const req = httpGet(PROBE_URL, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
  });
}

try {
  const builtAt = statSync(".output").mtimeMs;
  const mins = Math.round((Date.now() - builtAt) / 1000 / 60);
  console.log("");
  console.log(`构建完成（${mins <= 1 ? "刚刚" : `${mins} 分钟前`}）。`);

  const aliveBefore = await probeAlive();
  if (aliveBefore) {
    // 服务在跑就绝不强杀。home-server 自己会按 .output 时间戳提示重载。
    console.log("  · 服务在跑（探活 200），未重启——避免无谓强杀。浏览器强刷即可看到新页面。");
  } else {
    const uid = spawnSync("id", ["-u"], { encoding: "utf8" }).stdout.trim();
    const gui = `gui/${uid}`;
    // ⚠️ 不要加 -k：强制 SIGTERM 后新进程在受限环境里起不来，服务会一直停着。
    for (const job of ["com.chiheng.serve", "com.chiheng.tunnel"]) {
      spawnSync("launchctl", ["kickstart", `${gui}/${job}`], { timeout: 5000 });
    }
    await new Promise((r) => setTimeout(r, 1500)); // 给服务一点起来时间
    const aliveAfter = await probeAlive();
    console.log(
      aliveAfter
        ? "  · 服务原本没响应，已温和拉起，现在探活 200。浏览器强刷即可。"
        : "  · 服务仍无响应，请跑 npm run mac:restart 并探 /favicon.svg 确认。",
    );
  }
  console.log("  · meanwhy.top 也会跟着刷新。");
} catch {
  console.log("构建完成（读不到 .output 的时间，跳过提示）。");
}
