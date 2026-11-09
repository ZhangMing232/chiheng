#!/bin/bash
# 每周一 18:00 由 launchd（com.chiheng.despair-watch）调起：绝望底仓观察池周复核。
# 包一层 bash 是 2026-11-06 的教训（launchd 直调 node 会 EX_CONFIG），日志落内盘。
cd /Volumes/colorful/chiheng || exit 1
exec /Users/zhangweimin/nodejs/bin/node --experimental-strip-types --import ./scripts/alias.mjs scripts/despair-watch.ts
