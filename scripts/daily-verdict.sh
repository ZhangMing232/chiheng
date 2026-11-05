#!/bin/bash
# 这个文件是干什么的：
# **手动**触发一次策略/基因组判决刷新（scripts/strategy-verdict.ts 的包装）。
#
# 每日自动的那条路已经不需要定时器了：record-journal 收盘封印后 detached 拉起
# scripts/auto-verdict.ts，它里面第②步就会跑 strategy-verdict.ts。
# （本来想用 launchd 每天 16:10 跑，但 2026-11-05 实测：这台机器已经**建不了新的
#  launchd job** —— 连能用的 com.chiheng.serve.plist 原样复制一份换个 Label 加载都报
#  "Load failed: 5: Input/output error"。项目笔记里早有「launchd 进不了外置卷」的记录，
#  serve 那个也是靠登录项兜的。所以改走 record-journal，和项目其它每日任务一致。）
#
# 这个壳留着是为了「想立刻刷一次判决」的时候有句现成的话：
#   bash scripts/daily-verdict.sh
# 跑法（手动也行）：bash scripts/daily-verdict.sh
# 定时：见 scripts/auto-verdict.ts（record-journal 每日收盘封印后自动跑）。
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="/Users/zhangweimin/nodejs/bin/node"
LOG="$ROOT/data/verdict.log"

if [ ! -f "$ROOT/scripts/strategy-verdict.ts" ]; then
  echo "$(date '+%m-%d %H:%M') 找不到 $ROOT/scripts/strategy-verdict.ts，可能是硬盘没插上" >> "$LOG" 2>&1
  exit 1
fi

cd "$ROOT" || exit 1
mkdir -p "$ROOT/data"

# 走 auto-verdict.ts（不是直接调 strategy-verdict.ts）：这样能白拿数据审计闸
# （行情快照/K 线缓存有 block 级问题就别出数）和网络抖动的重试机制。
# AUTO_VERDICT_SKIP_FACTOR=1 = 只跑策略/基因组判决，不动因子队列
# （因子判决会改队列状态 = 实盘候选池，不能随手重跑）。
#
# NODE_OPTIONS= 是为了甩掉沙箱注入的 language shim（沙箱里 node 会被注入语言 shim，
# 卡死腾讯出口；用户终端没这问题，代码没为沙箱改一行）。
AUTO_VERDICT_SKIP_FACTOR=1 NODE_OPTIONS= "$NODE" --experimental-strip-types --import ./scripts/alias.mjs scripts/auto-verdict.ts >> "$LOG" 2>&1
CODE=$?
# 注意用 ${CODE} 而不是 $CODE：后面紧跟全角括号时，bash 会把多字节字符当成变量名的一部分
# （报 "CODE：unbound variable"）。这个坑踩过。
echo "$(date '+%m-%d %H:%M') 判决刷新结束（退出码 ${CODE}）" >> "$LOG"
exit $CODE
