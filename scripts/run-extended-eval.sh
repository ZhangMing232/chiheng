#!/bin/bash
# 自动串联：等 K 线回填到 800 根 → 跑扩展窗口(750)评价 → 报告
# 用法：bash scripts/run-extended-eval.sh   （建议后台跑）
set -u
cd /Volumes/colorful/chiheng

THRESH=2640          # A 股代码(2689 总量 - 40 北交所)全回填的近似目标
MAX_WAIT=10800       # 回填最多等 3 小时
SLEEP=60

echo "[$(date)] 等待 K 线回填到 >=${THRESH} 只(>=800根) ..."
waited=0
while true; do
  cnt=$(python3 -c "import json,glob;fs=glob.glob('data/backtest/kline/*.json');print(sum(1 for f in fs if len(json.load(open(f)))>=800))" 2>/dev/null || echo 0)
  echo "[$(date)] 当前 >=800: $cnt / 2689"
  if [ "$cnt" -ge "$THRESH" ]; then echo "[$(date)] 回填达标，开始评价"; break; fi
  if [ "$waited" -ge "$MAX_WAIT" ]; then echo "[$(date)] 超时仍未达标，仍继续跑评价（覆盖率可能偏低）"; break; fi
  sleep "$SLEEP"; waited=$((waited+SLEEP))
done

# 保险：再次确认旧 250 窗口基线已备份（不要被新跑覆盖）
if [ -f data/backtest/robust/2026-11-08/report.json ] && [ ! -f data/backtest/robust/baseline-250window-2026-11-08.json ]; then
  cp data/backtest/robust/2026-11-08/report.json data/backtest/robust/baseline-250window-2026-11-08.json
  echo "[$(date)] 已备份旧 250 窗口基线"
fi

echo "[$(date)] 启动扩展窗口评价 WINDOW=750 + valueAvoid + 龙虎榜回避 ..."
NODE_OPTIONS= BT_SAMPLE=2646 BT_WINDOW=750 BT_VALUE_AVOID=1 BT_AVOID_LHB=1 \
  node --experimental-strip-types --import ./scripts/alias.mjs scripts/eval-robust.ts
ec=$?
echo "=== 评价进程退出码: $ec ==="
echo "[$(date)] 报告：data/backtest/robust/2026-11-08/report.json"
echo "[$(date)] 旧基线对照：data/backtest/robust/baseline-250window-2026-11-08.json"
