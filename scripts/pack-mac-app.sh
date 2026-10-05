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
# 只在桌面留一份。早先项目里也放一份、桌面再拷一份，两份内容一样，
# 久了就分不清哪份在用（而且项目目录搬过家，旧的那份路径还烤死在里头）。
# 桌面那份是唯一入口；桌面不存在就退回项目目录，至少还能手动跑。
DESKTOP="$HOME/Desktop"
if [ -d "$DESKTOP" ]; then APP="$DESKTOP/赤轨.app"; else APP="$ROOT/赤轨.app"; fi
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
# 从 Finder 双击没有终端，stdout/stderr 全进黑洞，出错时用户只看到「点了没反应」。
# 所以这里把过程写进 data/app-launch.log，出错用系统对话框弹一句。
#
# 启动逻辑只有一份，在 scripts/start-mac.sh（node 路径写死在那个脚本里）。
# 早先这里自己又抄了一份、用 /usr/bin/env node 找 node——Finder 的 PATH 里没有 node，
# 必然报「env: node: No such file or directory」，这个 app 就从来没通过。
# 现在只做三件事：找到项目目录、调 start-mac.sh、开浏览器。

BAKED="$ROOT"
HERE="\$(cd "\$(dirname "\$0")/../../.." 2>/dev/null && pwd || true)"
ROOT=""
for candidate in "\$HERE" "\$BAKED" "/Volumes/colorful/chiheng"; do
  if [ -f "\$candidate/scripts/start-mac.sh" ]; then ROOT="\$candidate"; break; fi
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

PORT=8787
URL="http://127.0.0.1:\${PORT}"
nohup /bin/bash "\$ROOT/scripts/start-mac.sh" >/dev/null 2>&1 &
# 用 curl 探测，不用 lsof：lsof 在 Finder 启动的环境里没有权限，
# 会被当成「服务没起来」（serve.log 里明明已经 Listening 了）。
for _ in \$(seq 1 60); do
  curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:\${PORT}/" && break
  sleep 0.25
done
if ! curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:\${PORT}/"; then
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
echo "已生成：$APP"
echo "双击打开窗口。关掉窗口不会停止记账。"
