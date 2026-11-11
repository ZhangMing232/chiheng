#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
赤轨「市场可预测性」评测基座 —— 只立尺子，不发明策略。

为什么要有这个文件：
  赤轨此前所有实验的判定单位是「个股净超额」（扣掉市场收益之后剩下的东西）。
  一把天然把「市场能不能预测」判死的尺子 —— 任何正确预测大盘的信号，
  收益都会被算成 beta 减掉。所以「无 alpha」不等于「市场不可预测」。
  本脚本改以【市场本身】为预测目标，把口径、样本外切分、显著性检验先固定下来。

严格口径（写死，不许绕过）：
  1. 市场定义：全池日 K 横截面等权平均日收益（赤轨自己的市场，不是沪深300）。
  2. 预测目标 fwd_N[d] = d 日收盘后、未来 N 个交易日的市场累计收益。
  3. 特征只允许用 <= d 收盘时拿得到的数据；rolling 一律不含未来。
  4. 时间切分：前 60% 探索段 / 后 40% 样本外段。绝不随机打乱。
  5. 市场是单条强自相关序列，普通 t 会虚高 -> 用 block bootstrap（块长 >= N）。
  6. 异常收益 |r| > 35% 视作复权跳变/坏数据剔除；当日有效股票 < 200 只则该日作废。
  7. 结论全部由本轮数据算出，脚本不写死结论文字。

输出：data/backtest/research/market-forecast-base.{txt,json}
"""
import json, glob, os, math
import numpy as np
import pandas as pd

KLINE_DIR = "data/backtest/kline"
OUT_DIR = "data/backtest/research"
MIN_STOCKS_PER_DAY = 200
MAX_ABS_RET = 0.35
OOS_FRAC = 0.40
HORIZONS = (1, 5, 20)
COST_PER_REBALANCE = 0.001       # ETF 来回 0.1%，保守
N_BOOT = 2000
SEED = 20261111

DATE_KEY = "date"

# 逐股明细按日期聚合的桶
buckets = {}


def add(d, key, val):
    b = buckets.setdefault(d, {})
    b.setdefault(key, []).append(val)


def load_all():
    paths = sorted(glob.glob(os.path.join(KLINE_DIR, "*.json")))
    used = 0
    for p in paths:
        try:
            rows = json.load(open(p))
        except Exception:
            continue
        if not isinstance(rows, list) or len(rows) < 2:
            continue
        try:
            dt = [x[DATE_KEY] for x in rows]
            c = np.array([x["c"] for x in rows], float)
            h = np.array([x["h"] for x in rows], float)
            l = np.array([x["l"] for x in rows], float)
            v = np.array([x.get("v", 0) for x in rows], float)
        except Exception:
            continue
        if dt != sorted(dt):                     # 日期字典序 = 时间序
            order = np.argsort(dt)
            dt = [dt[i] for i in order]
            c, h, l, v = c[order], h[order], l[order], v[order]
        n = len(c)
        if not np.all(np.isfinite(c)) or np.any(c <= 0):
            continue
        prev = np.concatenate(([np.nan], c[:-1]))
        r = c / prev - 1
        ok = np.isfinite(r) & (np.abs(r) <= MAX_ABS_RET)
        # 只用无前视的 rolling：截至当日（含）的极值
        s = pd.Series(c)
        hi60 = s.rolling(60, min_periods=60).max().to_numpy()
        lo250 = s.rolling(250, min_periods=250).min().to_numpy()
        nh60 = np.isfinite(hi60) & (c >= hi60 - 1e-12)
        nl250 = np.isfinite(lo250) & (c <= lo250 + 1e-12)
        with np.errstate(divide="ignore", invalid="ignore"):
            amp = (h - l) / prev
            vchg = np.log(v / np.concatenate(([np.nan], v[:-1])))
        for i in range(1, n):
            if not ok[i]:
                continue
            d = dt[i]
            add(d, "r", r[i])
            add(d, "up", 1.0 if r[i] > 0 else 0.0)
            if np.isfinite(amp[i]) and amp[i] > 0:
                add(d, "amp", amp[i])
            if np.isfinite(vchg[i]) and abs(vchg[i]) < 5:
                add(d, "vchg", vchg[i])
            add(d, "nh60", 1.0 if nh60[i] else 0.0)
            add(d, "nl250", 1.0 if nl250[i] else 0.0)
        used += 1
    return used


def build_market():
    rows = []
    for d in sorted(buckets.keys()):
        b = buckets[d]
        rr = np.asarray(b.get("r", []), float)
        if len(rr) < MIN_STOCKS_PER_DAY:
            continue
        def avg(k, default=np.nan):
            a = np.asarray(b.get(k, []), float)
            return float(np.mean(a)) if len(a) else default
        rows.append(dict(
            date=d, n=len(rr), mret=float(np.mean(rr)),
            breadth=avg("up"), amp=avg("amp"), vchg=avg("vchg"),
            nh60=avg("nh60"), nl250=avg("nl250"),
        ))
    df = pd.DataFrame(rows).reset_index(drop=True)
    return df


def add_features(df):
    m = df["mret"]
    for w in (5, 20, 60):
        df[f"mom{w}"] = (1.0 + m).rolling(w, min_periods=w).apply(np.prod, raw=True) - 1.0
    df["breadth5"] = df["breadth"].rolling(5, min_periods=5).mean()
    df["vol20"] = m.rolling(20, min_periods=20).std(ddof=1)
    df["vchg5"] = df["vchg"].rolling(5, min_periods=5).mean()
    df["amp5"] = df["amp"].rolling(5, min_periods=5).mean()
    df["nh60_5"] = df["nh60"].rolling(5, min_periods=5).mean()
    df["nl250_5"] = df["nl250"].rolling(5, min_periods=5).mean()
    return df


def add_targets(df):
    m = df["mret"].to_numpy()
    n = len(df)
    for N in HORIZONS:
        fwd = np.full(n, np.nan)
        for i in range(n - N):
            fwd[i] = float(np.prod(1.0 + m[i + 1:i + 1 + N]) - 1.0)
        df[f"fwd{N}"] = fwd
    return df


FEATURES = [
    "mom5", "mom20", "mom60", "breadth", "breadth5",
    "vol20", "vchg5", "amp5", "nh60", "nh60_5", "nl250", "nl250_5",
]


def spearman(a, b):
    m = np.isfinite(a) & np.isfinite(b)
    if m.sum() < 30:
        return np.nan
    x = pd.Series(a[m]).rank().to_numpy()
    y = pd.Series(b[m]).rank().to_numpy()
    x = x - x.mean(); y = y - y.mean()
    den = math.sqrt(float(x @ x) * float(y @ y))
    return float(x @ y / den) if den > 0 else np.nan


def _rank_centered(a):
    r = pd.Series(a).rank().to_numpy()
    return r - r.mean()


def block_boot_p(x, y, block, seed):
    """H0: 特征与未来收益无关。按连续块重采样 y，保持自相关结构。"""
    m = np.isfinite(x) & np.isfinite(y)
    xx, yy = x[m], y[m]
    n = len(yy)
    if n < 30:
        return np.nan, np.nan
    rx = _rank_centered(xx)
    rx2 = float(rx @ rx)
    obs = spearman(xx, yy)
    if not np.isfinite(obs) or rx2 <= 0:
        return np.nan, np.nan
    rng = np.random.default_rng(seed)
    nb = math.ceil(n / block)
    null = np.empty(N_BOOT)
    for b in range(N_BOOT):
        starts = rng.integers(0, max(1, n - block), size=nb)
        idx = np.concatenate([np.arange(s, min(s + block, n)) for s in starts])[:n]
        if len(idx) < n:
            idx = np.concatenate([idx, rng.integers(0, n, size=n - len(idx))])
        ry = _rank_centered(yy[idx])
        ry2 = float(ry @ ry)
        null[b] = float(rx @ ry / math.sqrt(rx2 * ry2)) if ry2 > 0 else np.nan
    null = null[np.isfinite(null)]
    if len(null) < 100:
        return obs, np.nan
    p = float((np.abs(null) >= abs(obs)).mean())
    return obs, p


def quintile_means(x, y):
    m = np.isfinite(x) & np.isfinite(y)
    xx, yy = x[m], y[m]
    if len(xx) < 100:
        return []
    q = pd.qcut(pd.Series(xx), 5, labels=False, duplicates="drop")
    return [float(np.mean(yy[q.to_numpy() == k])) for k in range(5)]


def timing_nav(explore, oos, feat, N):
    """
    择时净值。两条硬约束，防止把样本外偷看当成预测力：
      1. 方向（高特征=看多 还是 看空）只由【探索段】IC 符号决定；
      2. 60/40 分位阈值用 expanding + shift(1)，第 d 天只看得到 d-1 及以前。
    每 N 日调仓一次，中间沿用上次仓位，换仓扣成本。
    """
    ic_in = spearman(explore[feat].to_numpy(), explore[f"fwd{N}"].to_numpy())
    if not np.isfinite(ic_in) or abs(ic_in) < 0.05:
        return None
    sign = 1.0 if ic_in > 0 else -1.0
    warm = pd.concat([explore[[feat]].tail(600), oos[[feat]]], ignore_index=True)
    hi = warm[feat].expanding(min_periods=250).quantile(0.60).shift(1).to_numpy()[-len(oos):]
    lo = warm[feat].expanding(min_periods=250).quantile(0.40).shift(1).to_numpy()[-len(oos):]
    x = oos[feat].to_numpy()
    raw = np.where(x > hi, 1.0, np.where(x < lo, 0.0, np.nan))
    raw = np.where(np.isnan(raw), np.nan, 1.0 - raw if sign < 0 else raw)
    pos = np.zeros(len(oos)); cur = 0.0
    for i in range(0, len(oos), N):
        if np.isfinite(raw[i]):
            cur = float(raw[i])
        pos[i:i + N] = cur
    m = oos["mret"].to_numpy()
    nav_s = nav_b = 1.0; rebalances = 0; prev = 0.0
    for i in range(0, len(oos) - N, N):
        step = float(np.prod(1.0 + m[i + 1:i + 1 + N]) - 1.0)
        nav_s *= (1.0 + pos[i] * step)
        nav_b *= (1.0 + step)
        if pos[i] != prev:
            nav_s *= (1.0 - COST_PER_REBALANCE)
            rebalances += 1
        prev = pos[i]
    return dict(nav=nav_s, buyhold=nav_b, rebalances=rebalances,
                direction="高特征看多" if sign > 0 else "高特征看空",
                ic_in=ic_in)


def main():
    used = load_all()
    df = build_market()
    df = add_features(df)
    df = add_targets(df)
    # 至少需要 250 根历史才有 nl250 等特征
    df = df.iloc[250:].reset_index(drop=True)
    cut = int(len(df) * (1 - OOS_FRAC))
    lines = []
    lines.append("=== 赤轨 市场可预测性 · 评测基座（只立尺子，不发明策略） ===")
    lines.append(f"参与构造个股      : {used}")
    lines.append(f"有效交易日        : {len(df)}  {df['date'].iloc[0]} ~ {df['date'].iloc[-1]}")
    lines.append(f"市场定义          : 全池横截面等权平均日收益（非沪深300）")
    lines.append(f"日均覆盖股票      : {df['n'].mean():.0f} 只")
    lines.append(f"买持累计净值      : {float(np.prod(1+df['mret'].to_numpy())):.3f}")
    lines.append(f"时间切分          : 探索段 {df['date'].iloc[0]} ~ {df['date'].iloc[cut-1]} ({cut} 日) | 样本外 {df['date'].iloc[cut]} ~ {df['date'].iloc[-1]} ({len(df)-cut} 日)")
    lines.append(f"显著性            : block bootstrap {N_BOOT} 次，块长 = max(40, 2N)，保持自相关结构")
    lines.append("未来收益>0 占比   : " + " / ".join(
        f"N={N} {np.nanmean(df[f'fwd{N}'].to_numpy() > 0):.3f}" for N in HORIZONS)
        + "  <- 方向胜率的天然基线，低于此值等于没预测")
    lines.append(f"成本              : 择时每次调仓 {COST_PER_REBALANCE*100:.2f}%")
    lines.append("")
    result = {"meta": {"stocks": used, "days": len(df), "from": df["date"].iloc[0],
                       "to": df["date"].iloc[-1], "cut": cut, "boot": N_BOOT}, "cells": []}

    for N in HORIZONS:
        y = df[f"fwd{N}"].to_numpy()
        y_in, y_out = y[:cut], y[cut:]
        lines.append(f"--- 预测未来 {N} 个交易日收益 ---")
        lines.append(f"{'特征':<12}{'全样本IC':>10}{'探索IC':>10}{'样本外IC':>11}{'boot p':>9}{'方向胜率':>10}{'分层Q1..Q5(%)':>34}")
        for f in FEATURES:
            x = df[f].to_numpy()
            ic_all = spearman(x, y)
            ic_in = spearman(x[:cut], y_in)
            ic_out = spearman(x[cut:], y_out)
            _, p = block_boot_p(x, y, max(40, 2 * N), SEED + N * 100 + FEATURES.index(f))
            ok = np.isfinite(x) & np.isfinite(y)
            direction = float(np.mean(np.sign(x[ok]) == np.sign(y[ok]))) if ok.sum() > 30 else np.nan
            q = quintile_means(x, y)
            qs = "/".join(f"{v*100:+.2f}" for v in q) if q else "-"
            same_oos = (np.isfinite(ic_in) and np.isfinite(ic_out) and
                        np.sign(ic_in) == np.sign(ic_out))
            flag = "  <样本外同号>" if same_oos and abs(ic_out) >= 0.05 else ""
            lines.append(f"{f:<12}{ic_all:>+10.3f}{ic_in:>+10.3f}{ic_out:>+11.3f}{p:>9.3f}{direction:>10.3f}{qs:>34}{flag}")
            result["cells"].append(dict(N=N, feat=f, ic_all=ic_all, ic_in=ic_in,
                                        ic_out=ic_out, p=p, direction=direction,
                                        quintiles=q, same_oos=bool(same_oos)))
        # 只给样本外同号且 |IC|>=0.05 的特征算择时净值
        cands = [c for c in result["cells"] if c["N"] == N and c["same_oos"] and
                 np.isfinite(c["ic_out"]) and abs(c["ic_out"]) >= 0.05]
        if cands:
            lines.append("  择时净值(样本外段；方向由探索段IC定号，阈值 expanding+shift(1) 无前视):")
            exp = df.iloc[:cut].reset_index(drop=True)
            oos = df.iloc[cut:].reset_index(drop=True)
            for c in cands:
                nv = timing_nav(exp, oos, c["feat"], N)
                if nv:
                    lines.append(f"    {c['feat']:<12} {nv['direction']:<10} 策略 {nv['nav']:.3f} / 买持 {nv['buyhold']:.3f} / 调仓 {nv['rebalances']} 次")
                    c["oos_nav"] = nv
        else:
            lines.append("  择时净值: 无特征达到「样本外同号 且 |IC|>=0.05」，不计算（避免挑挑拣拣）")
        lines.append("")

    lines.append("读法：IC 是特征与未来收益的秩相关；样本外不同号 = 探索段的规律没延续 = 不可用于预测。")
    lines.append("      boot p 已按块重采样处理自相关，未经此步的 t 值一律不可信。")
    lines.append("      本文件只报基线水平，不判定「能不能预测」，判定口径需拍板后另跑。")
    txt = "\n".join(lines)
    os.makedirs(OUT_DIR, exist_ok=True)
    open(os.path.join(OUT_DIR, "market-forecast-base.txt"), "w").write(txt + "\n")
    json.dump(result, open(os.path.join(OUT_DIR, "market-forecast-base.json"), "w"),
              ensure_ascii=False, indent=1, default=float)
    print(txt)


if __name__ == "__main__":
    main()
