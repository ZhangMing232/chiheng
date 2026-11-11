#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
未覆盖流派日线回测（诚实口径，对齐赤轨双闸）

测三个赤轨压根没跑过的、日线可验证的流派：
  1. 海龟（Turtle）：Donchian 20 日突破入场 + 10 日跌破出场 + 2*ATR 止损
  2. 威科夫（Wyckoff spring）：支撑假跌破后收回 = 震仓/吸筹，反转入场
  3. 蜡烛图反转（锤头 / 看涨吞没 / 启明星）：下行趋势末端反转形态

结算口径（和赤轨一致，见 long-term memory）：
  - 信号在 T 日收盘判定（用 T 及之前数据，无前视）
  - T+1 挂 T 日收盘价限价买入：若 T+1 最低价 <= T 收盘 → 以 T 收盘成交；
    若 T+1 跳空高开（最低价 > T 收盘）→ 买不到，记 null，不计入样本（不为 0）
  - A 股 T+1：最早卖出日为 T+2
  - 出场价：止损按当日最低触及价，止盈按当日最高触及价，通道/到期按收盘价
  - 样本不足 / 拿不到的数据：跳过，不填 0、不裁剪

双闸（赤轨统一尺子，eval-robust.ts）：
  gate1: 聚类 t 统计 |t| >= 2（按个股聚类，避免截面相关假显著）
  gate2: 前后半段（按出场日期）同向
  gate3: 平均超额（对市值等权代理指数）为正

结论全部由本轮数据算出再打印，脚本不写死任何结论文字。
"""
import json, glob, os, sys, math
import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

KLINE_DIR = "data/backtest/kline"
MIN_BARS = 250
WARMUP = 60
COST = 0.0015          # 双边成本(佣金+印花税+滑点)估算 ~0.15%/笔
MKT_BY_DATE = {}

# ---------- 向量化滚动指标 ----------
def rolling_max(a, n):
    out = np.full(len(a), np.nan)
    if len(a) < n + 1:
        return out
    w = sliding_window_view(a, n)        # w[k]=a[k:k+n], 长度 L-n+1
    out[n-1:] = w.max(axis=1)            # out[i]=max(a[i-n+1:i+1]), i>=n-1
    return out

def rolling_min(a, n):
    out = np.full(len(a), np.nan)
    if len(a) < n + 1:
        return out
    w = sliding_window_view(a, n)
    out[n-1:] = w.min(axis=1)
    return out

def sma(a, n):
    out = np.full(len(a), np.nan)
    if len(a) < n:
        return out
    csum = np.concatenate(([0.0], np.cumsum(a)))
    out[n-1:] = (csum[n:] - csum[:len(a)-n+1]) / n
    return out

def atr(h, l, c, n=20):
    pc = np.zeros(len(c)); pc[1:] = c[:-1]
    tr = np.maximum(np.maximum(h - l, np.abs(h - pc)), np.abs(l - pc))
    out = np.full(len(tr), np.nan)
    if len(tr) < n:
        return out
    csum = np.concatenate(([0.0], np.cumsum(tr)))
    out[n-1:] = (csum[n:] - csum[:len(tr)-n+1]) / n
    return out

# ---------- 加载 ----------
def load_stock(path):
    try:
        d = json.load(open(path))
    except Exception:
        return None
    if not isinstance(d, list) or len(d) < MIN_BARS:
        return None
    dates = [x["date"] for x in d]
    o = np.array([float(x["o"]) for x in d], float)
    h = np.array([float(x["h"]) for x in d], float)
    l = np.array([float(x["l"]) for x in d], float)
    c = np.array([float(x["c"]) for x in d], float)
    v = np.array([float(x.get("v", 0)) for x in d], float)
    return dict(code=os.path.basename(path)[:-5], dates=dates, o=o, h=h, l=l, c=c, v=v)

def build_market(stocks):
    by_date = {}
    for s in stocks:
        c = s["c"]; dates = s["dates"]
        for i in range(1, len(c)):
            if c[i-1] == 0:
                continue
            by_date.setdefault(dates[i], []).append(c[i]/c[i-1] - 1)
    global MKT_BY_DATE
    MKT_BY_DATE = {d: float(np.mean(v)) for d, v in by_date.items()}

# ---------- 信号（全部预计算向量化，循环只做布尔判定） ----------
def turtle_signals(s):
    c, h, l = s["c"], s["h"], s["l"]
    hh = rolling_max(h, 20)      # hh[i]=前20日最高(不含i)
    llx = rolling_min(l, 10)     # 出场: 前10日最低
    a = atr(h, l, c, 20)
    sig = np.zeros(len(c), bool)
    for i in range(WARMUP, len(c)):
        if np.isnan(hh[i-1]) or np.isnan(a[i]):
            continue
        if h[i] > hh[i-1]:
            sig[i] = True
    return dict(type="turtle", sig=sig, hh=hh, llx=llx, a=a)

def wyckoff_signals(s, WIN=40, use_vol=False):
    c, h, l, v = s["c"], s["h"], s["l"], s["v"]
    sup = rolling_min(l, WIN)
    res = rolling_max(h, WIN)
    vavg = sma(v, 20)
    sig = np.zeros(len(c), bool)
    for i in range(WARMUP, len(c)):
        if np.isnan(sup[i-1]) or np.isnan(res[i-1]):
            continue
        broke = l[i] < sup[i-1]
        recovered = c[i] > sup[i-1]
        in_range = c[i] < res[i-1] * 1.02
        # 精髓：跌破是缩量诱空(无真卖盘)，不是放量派发
        light_shake = (not use_vol) or (v[i] <= vavg[i-1] * 1.2)
        if broke and recovered and in_range and light_shake:
            sig[i] = True
    return dict(type="wyckoff", sig=sig, sup=sup, res=res)

def candle_signals(s, fast=20, slow=50, engulf_vol=False):
    o, h, l, c, v = s["o"], s["h"], s["l"], s["c"], s["v"]
    smaF = sma(c, fast)
    smaS = sma(c, slow)
    resF = rolling_max(h, fast)
    sig = np.zeros(len(c), bool)
    for i in range(WARMUP, len(c)):
        if np.isnan(smaF[i]) or np.isnan(smaS[i]):
            continue
        downtrend = c[i] < smaF[i] and c[i] < smaS[i]
        if not downtrend:
            continue
        body = abs(c[i]-o[i]); lower = min(o[i],c[i]) - l[i]; upper = h[i] - max(o[i],c[i])
        hammer = (c[i] > o[i]) and body > 0 and (lower >= 2*body) and (upper <= 0.3*body)
        engulf = False
        if i >= 1:
            # 放量确认：吞没当日量 > 前一日量（教科书要求量能配合）
            vol_ok = (not engulf_vol) or (v[i] > v[i-1])
            engulf = vol_ok and (c[i-1] < o[i-1]) and (c[i] > o[i]) and (o[i] <= c[i-1]) and (c[i] > o[i-1])
        morning = False
        if i >= 2:
            t2 = (c[i-2] < o[i-2]) and (abs(c[i-2]-o[i-2]) > 0.02*c[i-2])
            t1_small = abs(c[i-1]-o[i-1]) < 0.3*abs(c[i-2]-o[i-2])
            morning = t2 and t1_small and (c[i] > o[i]) and (c[i] > (o[i-2]+c[i-2])/2)
        if hammer or engulf or morning:
            sig[i] = True
    return dict(type="candle", sig=sig, res20=resF)

# ---------- 出场模拟 ----------
def simulate(s, meta, horizon_cap, stop_mult):
    c, h, l, o, dates = s["c"], s["h"], s["l"], s["o"], s["dates"]
    trades = []
    sig = meta["sig"]
    typ = meta["type"]
    for T in range(len(c)):
        if not sig[T]:
            continue
        entry_price = c[T]
        if T + 1 >= len(c):
            continue
        if l[T+1] > entry_price:
            continue                      # 跳空高开买不到 -> null
        entry_day = T + 1
        if typ == "turtle":
            stop = entry_price - stop_mult * meta["a"][T]
            target = None
        elif typ == "wyckoff":
            support = meta["sup"][T-1]; resist = meta["res"][T-1]
            stop = min(l[T], support) * (1 - 0.01)
            target = resist
        else:
            lo = max(0, T-2)
            pat_low = l[lo:T+1].min()     # 形态窗口最低价
            stop = pat_low * (1 - 0.01)
            target = meta["res20"][T]
        exit_price = None; exit_idx = None
        for j in range(entry_day + 1, min(entry_day + 1 + horizon_cap, len(c))):
            if stop is not None and l[j] <= stop:
                exit_price = stop; exit_idx = j; break
            if target is not None and h[j] >= target:
                exit_price = target; exit_idx = j; break
            if typ == "turtle":
                llx = meta["llx"][j-1]
                if not np.isnan(llx) and c[j] < llx:
                    exit_price = c[j]; exit_idx = j; break
        if exit_price is None:
            exit_idx = min(entry_day + horizon_cap, len(c)-1)
            exit_price = c[exit_idx]
        ret = exit_price / entry_price - 1
        ret_net = ret - COST
        mkt = 1.0
        for j in range(entry_day, exit_idx+1):
            mkt *= (1 + MKT_BY_DATE.get(dates[j], 0.0))
        trades.append((s["code"], dates[entry_day], dates[exit_idx], ret, mkt - 1, ret_net))
    return trades

# ---------- 统计 ----------
def clustered_t(rets_by_code):
    means = [np.mean(v) for v in rets_by_code.values() if len(v) > 0]
    if len(means) < 2:
        return float("nan"), len(means)
    m = np.mean(means); sd = np.std(means, ddof=1)
    if sd == 0:
        return float("nan"), len(means)
    return m / (sd / math.sqrt(len(means))), len(means)

def six_slices(trades):
    t2 = sorted(trades, key=lambda x: x[2])
    n = len(t2); k = n // 6; slices = []
    for i in range(6):
        seg = t2[i*k:(i+1)*k] if i < 5 else t2[i*k:]
        if seg:
            slices.append(np.mean([x[3] for x in seg]))
    return slices

def evaluate(name, trades):
    if not trades:
        print(f"\n=== {name} ===\n样本 0 笔 -> 无法判定，按拿不到数据如实报告")
        return
    rets = np.array([t[3] for t in trades])
    excess = np.array([t[4] for t in trades])
    rets_net = np.array([t[5] for t in trades])
    excess_net = rets_net - excess   # 净超额 = 净收益 - 市值代理
    by_code = {}
    for t in trades:
        by_code.setdefault(t[0], []).append(t[3])
    t_clu, ncode = clustered_t(by_code)
    sd = rets.std(ddof=1)
    t_naive = rets.mean()/(sd/math.sqrt(len(rets))) if sd > 0 else float("nan")
    slices = six_slices(trades)
    half = len(trades)//2
    first = np.mean([t[3] for t in trades[:half]])
    second = np.mean([t[3] for t in trades[half:]])
    same_dir = (first > 0) == (second > 0) and first != 0 and second != 0
    gate1 = (not math.isnan(t_clu)) and abs(t_clu) >= 2
    gate2 = same_dir
    gate3 = rets.mean() > 0 and excess.mean() > 0
    # 真实可下单口径：扣成本后超额仍正
    gate3_net = rets_net.mean() > 0 and excess_net.mean() > 0
    verdict = "PASS(双闸全过)" if (gate1 and gate2 and gate3) else "FAIL"
    verdict_net = "PASS(扣成本仍过)" if (gate1 and gate2 and gate3_net) else "FAIL(扣成本破)"
    print(f"\n=== {name} ===")
    print(f"  样本笔数      : {len(trades)}")
    print(f"  覆盖个股数    : {ncode}")
    print(f"  平均每笔收益  : {rets.mean()*100:+.3f}%  (中位 {np.median(rets)*100:+.3f}%)")
    print(f"  扣成本后均值  : {rets_net.mean()*100:+.3f}%")
    print(f"  对市值代理超额: {excess.mean()*100:+.3f}%  (净 {excess_net.mean()*100:+.3f}%)")
    print(f"  聚类 t 统计   : {t_clu:+.3f}  (朴素 t {t_naive:+.3f})")
    print(f"  前后半段均值  : 前 {first*100:+.3f}% / 后 {second*100:+.3f}%  同向={same_dir}")
    print(f"  六切片均值(%) : " + " / ".join(f"{s*100:+.2f}" for s in slices))
    print(f"  双闸(毛): g1|t|>=2={gate1}  g2前后同向={gate2}  g3超额正={gate3}  -> {verdict}")
    print(f"  双闸(净): g3净超额正={gate3_net}  -> {verdict_net}")

def robustness(stocks):
    print("\n\n========== 鲁棒性扰动（全池 + 扣成本） ==========")
    grid = {
        "Wyckoff spring": [
            ("WIN=40 无音量(基线)", lambda s: wyckoff_signals(s, 40, False), 20),
            ("WIN=40 +缩量诱空", lambda s: wyckoff_signals(s, 40, True), 20),
            ("WIN=60 +缩量诱空", lambda s: wyckoff_signals(s, 60, True), 20),
        ],
        "Candle 反转": [
            ("SMA20/50 无音量(基线)", lambda s: candle_signals(s, 20, 50, False), 15),
            ("SMA20/50 +吞没放量", lambda s: candle_signals(s, 20, 50, True), 15),
            ("SMA20/100 +吞没放量", lambda s: candle_signals(s, 20, 100, True), 15),
        ],
    }
    for fam, variants in grid.items():
        print(f"\n--- {fam} ---")
        for label, fn, hcap in variants:
            trades = []
            for s in stocks:
                trades += simulate(s, fn(s), hcap, 0.0)
            if not trades:
                print(f"  {label:18s}: 0 笔")
                continue
            excess = np.array([t[4] for t in trades])
            excess_net = np.array([t[5] for t in trades]) - excess
            by_code = {}
            for t in trades:
                by_code.setdefault(t[0], []).append(t[3])
            t_clu, ncode = clustered_t(by_code)
            ok = (abs(t_clu) >= 2) and (excess_net.mean() > 0)
            print(f"  {label:18s}: n={len(trades):>7}  聚类t={t_clu:+.2f}  净超额={excess_net.mean()*100:+.3f}%  {'稳健' if ok else '破'}")

def main():
    print("加载 kline 缓存 ...", flush=True)
    paths = glob.glob(os.path.join(KLINE_DIR, "*.json"))
    stocks = [s for p in paths if (s := load_stock(p))]
    print(f"可用股票: {len(stocks)} (>= {MIN_BARS} 根)", flush=True)
    build_market(stocks)
    print(f"市值代理指数交易日: {len(MKT_BY_DATE)}", flush=True)

    all_trades = {"turtle": [], "wyckoff": [], "candle": []}
    for s in stocks:
        all_trades["turtle"] += simulate(s, turtle_signals(s), 60, 2.0)
        all_trades["wyckoff"] += simulate(s, wyckoff_signals(s), 20, 0.0)
        all_trades["candle"] += simulate(s, candle_signals(s), 15, 0.0)

    evaluate("海龟 Turtle (Donchian20 突破 / 10日跌破 / 2ATR止损)", all_trades["turtle"])
    evaluate("威科夫 Wyckoff spring (支撑假跌破收回)", all_trades["wyckoff"])
    evaluate("蜡烛图反转 (锤头/吞没/启明星, 下行末端)", all_trades["candle"])

    # ---- 加回"精髓"(量价确认) 后重测，直接看贴线信号是否翻正 ----
    print("\n\n########## 加回精髓(量价确认) 对照 ##########")
    wk_vol = []
    for s in stocks:
        wk_vol += simulate(s, wyckoff_signals(s, 40, use_vol=True), 20, 0.0)
    evaluate("威科夫 spring +缩量诱空确认", wk_vol)
    cd_vol = []
    for s in stocks:
        cd_vol += simulate(s, candle_signals(s, 20, 50, engulf_vol=True), 15, 0.0)
    evaluate("蜡烛图反转 +吞没放量确认", cd_vol)

    robustness(stocks)

    out = {k: [{"code":t[0],"entry":t[1],"exit":t[2],"ret":round(t[3],6),"mkt":round(t[4],6)} for t in v] for k,v in all_trades.items()}
    os.makedirs("data/backtest/research", exist_ok=True)
    json.dump(out, open("data/backtest/research/untested-trades.json","w"), ensure_ascii=False)
    print(f"\n原始样本已落盘: data/backtest/research/untested-trades.json")

if __name__ == "__main__":
    main()
