#!/bin/bash
# 每天 15:15 由 launchd（com.chiheng.despair-basket）调起：绝望底仓实验篮子每日刷新。
# 包 bash + 内盘日志是 EX_CONFIG 的教训。
cd /Volumes/colorful/chiheng || exit 1
exec /Users/zhangweimin/nodejs/bin/node --experimental-strip-types --import ./scripts/alias.mjs scripts/despair-basket.ts
