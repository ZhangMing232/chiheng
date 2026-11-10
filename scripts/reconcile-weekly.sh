#!/bin/bash
# 每周一 18:30 由 launchd（com.chiheng.reconcile）调起：周对账推送（判决 vs 实际）。
cd /Volumes/colorful/chiheng || exit 1
exec /Users/zhangweimin/nodejs/bin/node --experimental-strip-types --import ./scripts/alias.mjs scripts/reconcile-weekly.ts
