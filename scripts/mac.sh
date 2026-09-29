#!/bin/bash
# Mac 上管理赤轨。在项目目录执行 npm run mac:status / mac:update 等。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LABEL="com.chiheng.serve"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
DOMAIN="gui/$(id -u)"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "缺少 $1。$2"
    exit 1
  fi
}

running() {
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1
}

status() {
  echo "目录    $ROOT"
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "版本    $(git log -1 --oneline)"
    echo "分支    $(git status -sb | head -1)"
  else
    echo "版本    这不是 git 仓库。请用 git clone 重新拿一份。"
  fi
  if running; then
    echo "服务    在跑（登录后会自己启动，挂了会再拉起来）"
  else
    echo "服务    没在跑。执行 npm run mac:start"
  fi
  if curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:8787/"; then
    echo "页面    http://127.0.0.1:8787  能打开"
  else
    echo "页面    http://127.0.0.1:8787  打不开"
  fi
  echo "日志    $ROOT/data/serve.log"
  echo "账本    $ROOT/data/books   （不要删，不进 Git）"
}

update() {
  need git "先运行 xcode-select --install"
  need node "先安装 Node.js 22，打开 https://nodejs.org"
  need npm "Node 装好后自带 npm"
  echo "1/4  拉取 GitHub 上的 main"
  if ! git pull --ff-only; then
    echo "拉不下来。在这个目录执行 git status，把整段输出发回来。不要改代码文件。"
    exit 1
  fi
  echo "2/4  安装依赖"
  npm install
  echo "3/4  构建"
  npm run build:mac
  echo "4/4  安装登录自启"
  bash "$ROOT/scripts/install-mac.sh"
  echo "完成。浏览器打开 http://127.0.0.1:8787"
}

stop() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  echo "已停止。账本还在 data/books，没有删。"
}

start() {
  if [[ ! -f "$PLIST" ]]; then
    bash "$ROOT/scripts/install-mac.sh"
    return
  fi
  if running; then
    echo "已经在跑。页面 http://127.0.0.1:8787"
    return
  fi
  launchctl bootstrap "$DOMAIN" "$PLIST"
  echo "已启动。页面 http://127.0.0.1:8787"
}

restart() {
  stop
  start
}

log() {
  mkdir -p "$ROOT/data"
  touch "$ROOT/data/serve.log"
  tail -n 80 "$ROOT/data/serve.log"
}

help() {
  cat <<'EOF'
在项目目录里用这些命令：

  npm run mac:status    看版本、服务开没开、页面能不能开
  npm run mac:update    从 GitHub 拉最新代码，构建，并重新安装
  npm run mac:log       看最近日志
  npm run mac:restart   只重启，不重新构建
  npm run mac:stop      停止，登录后也不会再启动，直到 start
  npm run mac:start     再启动

第一次在这台 Mac 上：

  git clone https://github.com/ZhangMing232/chiheng.git
  cd chiheng
  npm run mac:update
EOF
}

case "${1:-help}" in
  status) status ;;
  update) update ;;
  log) log ;;
  stop) stop ;;
  start) start ;;
  restart) restart ;;
  help | -h | --help) help ;;
  *)
    echo "不认识的命令: $1"
    help
    exit 1
    ;;
esac
