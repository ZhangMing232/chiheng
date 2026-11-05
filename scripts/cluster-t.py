#!/usr/bin/env python3
"""按 exitDate 聚类的稳健 t 检验（补 2026-10-28 REPORT-2-cluster.md 没留脚本的缺口）。

为什么必须聚类：同一天平仓的票共享当天市场 beta，不是独立观测。逐笔 t 会把
17 个交易日的 161 笔当成 161 个独立样本，t 能虚高 5~7 倍（10-28 已量到）。

口径（与 2026-10-28 聚类复核报告一致）：
  e_i = (ret_i - bench_i) * 100      单位 pp，bench 是同持有期抽样池等权
  点估计 = 逐笔等权 mean(e)         与线上等额下注一致
  逐笔 t  = mean / (sd(e)/sqrt(N))
  聚类 t  = mean / sqrt(V)，
            V = G/(G-1) * (N-1)/(N-K) * Σ_g (Σ_{i∈g} (e_i - mean))² / N²
            G = exitDate 天数，K = 1（只有常数项）

用法：
  python3 scripts/cluster-t.py data/backtest/2026-10-28/dump-s2400.json
  python3 scripts/cluster-t.py <dump> --cut 2026-09-29 --strategy bk4
"""
import argparse
import json
import math
import sys
from collections import defaultdict


def load(path):
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    trades = d.get("trades", d)
    if not isinstance(trades, dict):
        raise SystemExit("dump 里没找到 trades 字典")
    return trades


def stat(rows, cut=None):
    if cut:
        rows = [t for t in rows if t.get("exitDate", "") >= cut]
    if len(rows) < 2:
        return None
    e = [(t["ret"] - t["bench"]) * 100 for t in rows]  # pp
    n = len(e)
    mean = sum(e) / n

    # 逐笔（假设独立）
    var = sum((x - mean) ** 2 for x in e) / (n - 1)
    t_iid = mean / math.sqrt(var / n) if var > 0 else float("nan")

    # 按平仓日聚类
    groups = defaultdict(list)
    for t, x in zip(rows, e):
        groups[t.get("exitDate", "?")].append(x - mean)
    g = len(groups)
    if g < 2:
        return (n, g, mean, sum(1 for x in e if x > 0) / n * 100, t_iid, float("nan"))
    meat = sum(sum(v) ** 2 for v in groups.values())
    # K=1 → (N-1)/(N-K) = 1，写出来是提醒别漏了小样本修正那一项
    small = (n - 1) / (n - 1)
    v_clu = (g / (g - 1)) * small * meat / (n * n)
    t_clu = mean / math.sqrt(v_clu) if v_clu > 0 else float("nan")

    win = sum(1 for t in rows if t["ret"] > 0) / n * 100
    return (n, g, mean, win, t_iid, t_clu)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dump")
    ap.add_argument("--cut", default=None, help="只取 exitDate >= 该日期")
    ap.add_argument("--strategy", default=None, help="只算某个策略")
    args = ap.parse_args()

    trades = load(args.dump)
    keys = [args.strategy] if args.strategy else list(trades)
    label = f"（exitDate >= {args.cut}）" if args.cut else "（全窗口）"
    print(f"{args.dump} {label}")
    print(f"{'策略':<12} {'笔数':>6} {'天数':>5} {'超额pp':>9} {'胜率':>6} {'逐笔t':>8} {'聚类t':>8}  判定")
    for k in keys:
        if k not in trades:
            print(f"  {k}: dump 里没有这个策略")
            continue
        s = stat(trades[k], args.cut)
        if not s:
            print(f"{k:<12} {'样本不足':>6}")
            continue
        n, g, mean, win, ti, tc = s
        verdict = "显著正" if tc >= 2 else "显著负" if tc <= -2 else "和0分不开"
        print(f"{k:<12} {n:>6} {g:>5} {mean:>+9.2f} {win:>5.0f}% {ti:>+8.2f} {tc:>+8.2f}  {verdict}")


if __name__ == "__main__":
    main()
