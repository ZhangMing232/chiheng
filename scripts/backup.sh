#!/bin/bash
# 这个文件是干什么的：
# 每天 23:30 由 launchd（com.chiheng.backup）调起，给 data/ 打一份全量快照。
# 手动跑也行：bash scripts/backup.sh
#
# 你需要知道的：
# 为什么包一层 bash 而不是让 launchd 直接调 node——2026-11-06 实测，launchd 直接
# 调 /Users/zhangweimin/nodejs/bin/node 的作业每次 fire 都 EX_CONFIG(78) 拒跑
# （plutil lint 通过、手动 node 跑完全正常，原因未深究），而本机 serve/verdict
# 两个 /bin/bash 作业一直正常。照已验证的模式走，别单干。
cd /Volumes/colorful/chiheng || exit 1
exec /Users/zhangweimin/nodejs/bin/node scripts/snapshot-data.mjs
