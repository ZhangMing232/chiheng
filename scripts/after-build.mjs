#!/usr/bin/env node
/**
 * 这个文件是干什么的：
 * 构建成功后提醒一句：服务还在跑旧的，要重启才生效。
 *
 * 你需要知道的：
 * 2026-10-05 一天里这件事坑了三回：页面显示的还是旧逻辑，
 * 而两边都没人提示，只能靠人肉对比文件时间。提醒放在最该出现的地方——
 * 刚 build 完、用户正要刷新浏览器的那一刻。
 */
import { statSync } from "node:fs";

try {
  const builtAt = statSync(".output").mtimeMs;
  const mins = Math.round((Date.now() - builtAt) / 1000 / 60);
  console.log("");
  console.log(`构建完成（${mins <= 1 ? "刚刚" : `${mins} 分钟前`}）。`);
  console.log("  · 网页要重启服务才加载新代码：到跑着 npm run serve 的那个窗口按 Ctrl+C，再重新跑一次。");
  console.log("  · 记账脚本直接读 src，现在就已经是新逻辑，不用等。");
  console.log("  · 浏览器记得强刷（Cmd + Shift + R），普通刷新可能拿到缓存。");
} catch {
  console.log("构建完成（读不到 .output 的时间，跳过提示）。");
}
