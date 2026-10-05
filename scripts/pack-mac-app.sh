#!/bin/bash
# 这个文件是干什么的：
# 在 Mac 上做出可以双击打开的「赤轨.app」，并尽量复制到桌面。
#
# 你需要知道的：
# 只在执行 npm run app:mac 时用。关掉窗口不会停止记账，也不会下真实委托。日常选股不用改这里。

# 在 Mac 上生成可双击的赤轨.app。窗口关掉，记账进程不停。
set -euo pipefail
if [ "$(uname)" != "Darwin" ]; then
  echo "赤轨.app 要在 Mac 上生成。先装好服务，再在项目目录执行：npm run app:mac"
  exit 1
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/赤轨.app"
MACOS="$APP/Contents/MacOS"
RES="$APP/Contents/Resources"
rm -rf "$APP"
mkdir -p "$MACOS" "$RES"
python3 "$ROOT/scripts/app-icon.py"
ICON="$ROOT/scripts/app-icon.png"
if command -v sips >/dev/null && command -v iconutil >/dev/null; then
  SET="$RES/AppIcon.iconset"
  mkdir -p "$SET"
  for size in 16 32 64 128 256 512; do
    sips -z "$size" "$size" "$ICON" --out "$SET/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    if [ "$double" -le 1024 ]; then
      sips -z "$double" "$double" "$ICON" --out "$SET/icon_${size}x${size}@2x.png" >/dev/null
    fi
  done
  iconutil -c icns "$SET" -o "$RES/AppIcon.icns"
  rm -rf "$SET"
fi
cat > "$MACOS/chiheng" <<EOF
#!/bin/bash
# 从 Finder 双击时没有终端，stdout/stderr 全都丢掉——早先「双击没反应」就是这么来的：
# 脚本起来了、服务没起来、然后悄悄退出，用户什么也没看到。
# 现在全部输出写进 data/app-launch.log，出错再用系统对话框弹一句。

# 项目路径不能只烤死一个：硬盘换了、目录搬了家，双击就找不到代码。
# 顺序是「.app 自己所在的项目目录」→「打包时记下的路径」→「外置硬盘上的默认位置」。
BAKED="$ROOT"
HERE="\$(cd "\$(dirname "\$0")/../../.." 2>/dev/null && pwd || true)"
ROOT=""
for candidate in "\$HERE" "\$BAKED" "/Volumes/colorful/chiheng"; do
  if [ -f "\$candidate/scripts/home-server.mjs" ]; then ROOT="\$candidate"; break; fi
done

mkdir -p "\$BAKED/data" 2>/dev/null
LAUNCH_LOG="\${ROOT:-\$BAKED}/data/app-launch.log"
exec >>"\$LAUNCH_LOG" 2>&1
say() { /usr/bin/osascript -e "display alert \"赤轨\" message \"\$1\"" >/dev/null 2>&1 || true; }

echo ""
echo "==== \$(date '+%Y-%m-%d %H:%M:%S') 双击启动 ===="

if [ -z "\$ROOT" ]; then
  echo "找不到项目目录。试过：\$HERE / \$BAKED / /Volumes/colorful/chiheng"
  say "找不到项目目录，硬盘插上了吗？日志：\$LAUNCH_LOG"
  exit 1
fi
cd "\$ROOT" || { say "进不去项目目录 \$ROOT"; exit 1; }
mkdir -p "\$ROOT/data"

PORT=8787
URL="http://127.0.0.1:\${PORT}"
up() { lsof -nP -iTCP:\$PORT -sTCP:LISTEN >/dev/null 2>&1; }
if ! up; then
  launchctl kickstart -k "gui/\$(id -u)/com.chiheng.serve" >/dev/null 2>&1 || true
fi
if ! up; then
  echo "启动服务（\$ROOT）"
  nohup /usr/bin/env node "\$ROOT/scripts/home-server.mjs" >>"\$ROOT/data/serve.log" 2>&1 &
fi
for _ in \$(seq 1 60); do
  up && break
  sleep 0.25
done
if ! up; then
  echo "等了 15 秒服务还没起来。serve.log 最后 20 行："
  tail -20 "\$ROOT/data/serve.log" 2>/dev/null
  say "服务没起来，页面打不开。详情看 \$LAUNCH_LOG"
  exit 1
fi
echo "服务已就绪：\$URL"
if [ -d "/Applications/Google Chrome.app" ]; then
  open -na "Google Chrome" --args --app="\$URL"
elif [ -d "/Applications/Microsoft Edge.app" ]; then
  open -na "Microsoft Edge" --args --app="\$URL"
else
  open "\$URL"
fi
exit 0
EOF
chmod +x "$MACOS/chiheng"
cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>chiheng</string>
  <key>CFBundleIdentifier</key>
  <string>com.chiheng.app</string>
  <key>CFBundleName</key>
  <string>赤轨</string>
  <key>CFBundleDisplayName</key>
  <string>赤轨</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
EOF
if [ -d "$HOME/Desktop" ]; then
  rm -rf "$HOME/Desktop/赤轨.app"
  cp -R "$APP" "$HOME/Desktop/赤轨.app"
  echo "已放到桌面：赤轨.app"
else
  echo "已生成：$APP"
fi
echo "双击打开窗口。关掉窗口不会停止记账。"
