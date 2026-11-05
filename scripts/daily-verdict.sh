#!/bin/bash
# 这个文件是干什么的：
# 每日全池回测判决刷新（scripts/strategy-verdict.ts 的包装）。
#
# 为什么要有这个壳（而不是直接把命令写进 plist）：
# 1. **launchd 进不了外置卷**——macOS 对可移动磁盘的隐私保护会让 launchd 起的进程
#    getcwd 报 "Operation not permitted"。start-mac.sh 早就踩过这坑：它用
#    `ROOT="$(cd "$(dirname "$0")/.." && pwd)"` 从**脚本自己的绝对路径**解析项目根，
#    绕开 getcwd。这里照抄同一套写法。
# 2. **node 路径要固定**：沙箱里那个 node 在 WorkBuddy 目录下（版本号带在路径里，
#    升级就变）。项目自己用的是 /Users/zhangweimin/nodejs/bin/node（v22.23.3，稳定）。
# 3. 日志落在项目内的 data/verdict.log，不写到 ~/Library/Logs（盘不在也能看）。
#
# 跑法（手动也行）：bash scripts/daily-verdict.sh
# 定时：见 ~/Library/LaunchAgents/com.chiheng.verdict.plist（每天 16:10）。
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

# NODE_OPTIONS= 是为了甩掉沙箱注入的 language shim（沙箱里 node 会被注入语言 shim，
# 卡死腾讯出口；用户终端没这问题，代码没为沙箱改一行）。
NODE_OPTIONS= "$NODE" --experimental-strip-types --import ./scripts/alias.mjs scripts/strategy-verdict.ts >> "$LOG" 2>&1
CODE=$?
# 注意用 ${CODE} 而不是 $CODE：后面紧跟全角括号时，bash 会把多字节字符当成变量名的一部分
# （报 "CODE：unbound variable"）。这个坑踩过。
echo "$(date '+%m-%d %H:%M') 判决刷新结束（退出码 ${CODE}）" >> "$LOG"
exit $CODE
