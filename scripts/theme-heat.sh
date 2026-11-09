#!/bin/bash
# 每天 15:10 由 launchd（com.chiheng.theme-heat）调起：题材热度榜推送。
cd /Volumes/colorful/chiheng || exit 1
exec /Users/zhangweimin/nodejs/bin/node --experimental-strip-types --import ./scripts/alias.mjs scripts/theme-heat.ts
