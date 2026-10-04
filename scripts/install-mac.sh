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
PLIST="$HOME/Library/LaunchAgents/com.chiheng.serve.plist"
LOG="$HOME/Library/Logs/chiheng-launchd.log"
mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/data" "$HOME/Library/Logs"

# 这份配置要能在**外置硬盘**上也跑得起来，所以有两处和常见的写法不一样：
#
# 1. 不写 WorkingDirectory。macOS 的隐私保护不让 launchd 进可移动磁盘，
#    写了会直接报 "getcwd: ... Operation not permitted"，服务一次都起不来
#    （job 退出码 78）。改由 start-mac.sh 自己 cd 到项目目录。
# 2. ProgramArguments 指向 start-mac.sh 而不是直接跑 node。脚本里会先确认
#    项目文件还在（硬盘插着），再决定要不要拉起，硬盘没插时安静退出。
#
# 日志放本机 ~/Library/Logs 而不是项目里：硬盘没插时 launchd 连日志文件都
# 建不出来，job 会因为这个先失败。serve.log 由 start-mac.sh 自己往 data/ 写。
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.chiheng.serve</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${ROOT}/scripts/start-mac.sh</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>${LOG}</string>
  <key>StandardErrorPath</key>
  <string>${LOG}</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)/com.chiheng.serve" 2>/dev/null || true
# bootout 收回旧进程是异步的：紧接着 bootstrap 同一个服务可能撞上旧进程
# 退出，报 "Bootstrap failed: 5: Input/output error" 并留下没有服务的局面。
# 等一拍再装，失败就重试几次。
sleep 1
installed=0
for attempt in 1 2 3; do
  if launchctl bootstrap "gui/$(id -u)" "$PLIST"; then
    installed=1
    break
  fi
  sleep 2
done
if [ "$installed" != 1 ]; then
  cat >&2 <<MSG
自启安装失败：launchctl bootstrap 三次都没成功。

这通常是因为执行 install-mac.sh 的那个进程本身没有注册登录服务的权限
（比如从别的工具里间接调用的终端会话）。请自己开一个「终端」窗口，执行：

  cd $(printf '%q' "$ROOT") && npm run install:mac

如果还是不行，退一步手动保证服务可用：把「赤轨启动.app」加到
系统设置 → 通用 → 登录项 里，登录时会拉起服务（但没有崩溃自动重启）。
MSG
  exit 1
fi
echo "已安装。打开 http://127.0.0.1:8787"
echo "以后更新：npm run mac:update"
echo "看是否在跑：npm run mac:status"
echo "日志：npm run mac:log"
