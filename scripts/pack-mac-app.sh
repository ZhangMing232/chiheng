#!/bin/bash
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
ROOT="$ROOT"
PORT=8787
URL="http://127.0.0.1:\${PORT}"
cd "\$ROOT"
mkdir -p "\$ROOT/data"
up() { lsof -nP -iTCP:\$PORT -sTCP:LISTEN >/dev/null 2>&1; }
if ! up; then
  launchctl kickstart -k "gui/\$(id -u)/com.chiheng.serve" >/dev/null 2>&1 || true
fi
if ! up; then
  nohup /usr/bin/env node "\$ROOT/scripts/home-server.mjs" >> "\$ROOT/data/serve.log" 2>&1 &
fi
for _ in \$(seq 1 40); do
  up && break
  sleep 0.25
done
if [ -d "/Applications/Google Chrome.app" ]; then
  open -na "Google Chrome" --args --app="\$URL"
elif [ -d "/Applications/Microsoft Edge.app" ]; then
  open -na "Microsoft Edge" --args --app="\$URL"
elif [ -d "/Applications/Arc.app" ]; then
  open -na "Arc" --args --app="\$URL"
else
  open "\$URL"
fi
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
