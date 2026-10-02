#!/bin/bash
# 这个文件是干什么的：
# 把赤轨的服务拉起来。给「登录项」用的，不经过 launchd。
#
# 你需要知道的：
# launchd 因为 macOS 对可移动磁盘的隐私保护，进不了外置卷（getcwd 会报
# Operation not permitted），所以放在 colorful 上时改由登录项调用这个脚本。
# 已经在跑就什么都不做，不会重复拉起第二个进程占端口。
# 日志写在 data/serve.log。这个脚本不碰账本，也不会向券商下真实委托。

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="/Users/zhangweimin/nodejs/bin/node"
PORT="${PORT:-8787}"

if [ ! -f "$ROOT/scripts/home-server.mjs" ]; then
  echo "$(date '+%H:%M') 找不到 $ROOT/scripts/home-server.mjs，可能是硬盘没插上" >> "$ROOT/data/serve.log" 2>&1
  exit 1
fi

if lsof -iTCP:"$PORT" -sTCP:LISTEN -P -n >/dev/null 2>&1; then
  exit 0
fi

mkdir -p "$ROOT/data"
cd "$ROOT" || exit 1
exec "$NODE" scripts/home-server.mjs >>"$ROOT/data/serve.log" 2>&1
