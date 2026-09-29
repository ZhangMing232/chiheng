#!/bin/bash
# 这个文件是干什么的：
# 给这台 Mac 装上登录后自动打开赤轨：写一份自启配置，登录就跑本机服务，挂了会再拉起来。
#
# 你需要知道的：
# 在项目目录执行 npm run install:mac 时跑；npm run mac:update 的最后一步也会调用它。
# 装好以后，每次登录 Mac，网页和记账会一起起来，地址是 http://127.0.0.1:8787 。
# 日志写在 data/serve.log。这个脚本不碰账本，也不会向券商下真实委托。
# 想停掉、并且以后登录不再自动开，用 npm run mac:stop。日常选股不用改这里。

# 登录后启动赤轨。在项目目录执行：npm run install:mac
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
PLIST="$HOME/Library/LaunchAgents/com.chiheng.serve.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/data"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.chiheng.serve</string>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE}</string>
    <string>${ROOT}/scripts/home-server.mjs</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${ROOT}/data/serve.log</string>
  <key>StandardErrorPath</key>
  <string>${ROOT}/data/serve.log</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)/com.chiheng.serve" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "已安装。打开 http://127.0.0.1:8787"
echo "以后更新：npm run mac:update"
echo "看是否在跑：npm run mac:status"
echo "日志：npm run mac:log"
