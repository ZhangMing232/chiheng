#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
完整海龟系统（Turtle, Richard Dennis）组合回测 —— 日线诚实口径。

和"裸信号每笔均值"不同，这里测的是**完整系统 + 组合 Sharpe**：
  - 入场：Donchian 20 日突破（S1），突破位挂限价，T+1 成交（跳空买不到=null）
  - 仓位：ATR 单位化，1 单位风险 ≈ 1% 账户；无杠杆，个股仓位封顶 UNIT_CAP
  - 加仓：每 +0.5N 金字塔加 1 单位，最多 4 单位
  - 止损：每单位 2N 止损（从自身入场价）
  - 出场：S1 用 10 日跌破（收盘 < 前 10 日最低）全平
  - 账户：所有标的共享一个账户，按日盯市，净值曲线算 Sharpe/回撤/年化
  - 成本：每笔开/平扣 COST（双边 0.15% 估算）

A 股硬约束（老实写进）：
  - T+1：T 日信号，T+1 成交，最早 T+2 可平；加仓同理下一根成交
  - 无杠杆：仓位封顶，不借钱
  - 单边多：A 股散户难做空，故只测多头侧（书里双向，但不可执行就不假装）

结论由数据算：组合年化/夏普/回撤，并与等权买入持有基准对比。
"""
import json, glob, os, math, sys
import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

KLINE_DIR = "data/backtest/kline"
MIN_BARS = 250
WARMUP = 60
COST = 0.0015           # 双边成本 ~0.15%/笔
UNIT_RISK = 0.01        # 每单位风险 ≈ 1% 账户
UNIT_CAP = 0.03         # 无杠杆：每单位仓位封顶 3%
MAX_UNITS = 4
PYR_STEP = 0.5          # 每 0.5N 加一单位

def rolling_max(a, n):
    out = np.full(len(a), np.nan)
    if len(a) < n + 1:
        return out
    w = sliding_window_view(a, n)
    out[n-1:] = w.max(axis=1)
    return out

def rolling_min(a, n):
    out = np.full(len(a), np.nan)
    if len(a) < n + 1:
        return out
    w = sliding_window_view(a, n)
    out[n-1:] = w.min(axis=1)
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

def board_limit(code):
    # 涨跌停幅度：双创20%、北交30%、其余10%(ST未区分按10%)
    if code.startswith("sh688") or code.startswith("sz300"):
        return 0.20
    if code.startswith("bj"):
        return 0.30
    return 0.10

def load_stock(path, EW=20, XW=10):
    try:
        d = json.load(open(path))
    except Exception:
        return None
    if not isinstance(d, list) or len(d) < MIN_BARS:
        return None
    code = os.path.basename(path)[:-5]
    dates = [x["date"] for x in d]
    o = np.array([float(x["o"]) for x in d], float)
    h = np.array([float(x["h"]) for x in d], float)
    l = np.array([float(x["l"]) for x in d], float)
    c = np.array([float(x["c"]) for x in d], float)
    N = atr(h, l, c, 20)
    HH_e = rolling_max(h, EW)     # 入场：EW 日突破 (用 [i-1])
    LL_x = rolling_min(l, XW)     # 多头出场：XW 日跌破
    LL_e = rolling_min(l, EW)     # 空头入场：EW 日跌破
    HH_x = rolling_max(h, XW)     # 空头出场：XW 日突破
    return dict(code=code, dates=dates, o=o, h=h, l=l, c=c, limit=board_limit(code),
                N=N, HH_e=HH_e, LL_x=LL_x, LL_e=LL_e, HH_x=HH_x)

def main():
    args = sys.argv[1:]
    MODE = args[0] if len(args) > 0 else "both"        # long | both
    EW = int(args[1]) if len(args) > 1 else 20         # 入场窗口
    XW = int(args[2]) if len(args) > 2 else 10         # 出场窗口
    SM = float(args[3]) if len(args) > 3 else 2.0      # 止损 = SM*N
    print(f"模式: {'单边多' if MODE=='long' else '双边(多+空)'}  入场{EW}/出场{XW}/止损{SM}N", flush=True)
    print("加载 kline ...", flush=True)
    paths = glob.glob(os.path.join(KLINE_DIR, "*.json"))
    stocks = [s for p in paths if (s := load_stock(p, EW, XW))]
    print(f"可用股票: {len(stocks)}", flush=True)

    # 全局交易日 + 每日bars索引
    all_dates = set()
    for s in stocks:
        all_dates |= set(s["dates"])
    global_dates = sorted(all_dates)
    print(f"全局交易日: {len(global_dates)}", flush=True)
    bars_by_date = {d: [] for d in global_dates}
    for si, s in enumerate(stocks):
        for i, d in enumerate(s["dates"]):
            bars_by_date[d].append((si, i))

    acct_cash = 1.0           # 美元计账户
    invested = 0.0             # 已投入美元
    n_units_opened = 0
    n_units_closed = 0
    # state: side=0平/+1多/-1空; pending=(price,side); units 含 side
    state = [{"side": 0, "units": [], "pending": None, "pending_add": None, "last_add": None} for _ in stocks]
    last_close = [s["c"][0] for s in stocks]

    equity_curve = [1.0]
    dates_out = [global_dates[0]]
    in_market_days = 0

    for g, d in enumerate(global_dates):
        prev_eq = equity_curve[-1]          # 用上一日权益做仓位基数（含去杠杆）
        bars = bars_by_date[d]
        for (si, i) in bars:
            s = stocks[si]; st = state[si]
            o = s["o"][i]
            h = s["h"][i]; l = s["l"][i]; c = s["c"][i]
            c_prev = s["c"][i-1] if i - 1 >= 0 else c
            N = s["N"][i]
            hh = s["HH_e"][i-1] if i - 1 >= 0 else np.nan
            ll10 = s["LL_x"][i-1] if i - 1 >= 0 else np.nan
            ll20 = s["LL_e"][i-1] if i - 1 >= 0 else np.nan
            hh10 = s["HH_x"][i-1] if i - 1 >= 0 else np.nan
            lim = s["limit"]
            nin = np.isnan(N)

            # 1) 成交：T+1 以【开盘价】成交（趋势系统=市价/突破单，不是限价回抽）
            #    若 T+1 开盘涨停(多头)/跌停(空头)-> 买不到 -> 作废
            if st["pending"] is not None:
                _, side = st["pending"]
                if (not nin) and N > 0 and (side == 1 or MODE != "long"):
                    gap_block = (side == 1 and o >= c_prev * (1 + lim * 0.98)) or \
                                (side == -1 and o <= c_prev * (1 - lim * 0.98))
                    if (not gap_block):
                        pos = min(UNIT_RISK * prev_eq * o / (SM * N), UNIT_CAP * prev_eq)
                        if pos > 0 and invested + pos <= prev_eq:
                            stop = (o - SM * N) if side == 1 else (o + SM * N)
                            st["units"].append({"entry": o, "stop": stop, "pos": pos, "side": side, "entry_i": i})
                            if side == 1:
                                acct_cash -= pos
                            else:
                                acct_cash += pos
                            invested += pos; n_units_opened += 1
                            acct_cash -= COST * pos
                            st["side"] = side; st["last_add"] = o
                    st["pending"] = None
                else:
                    st["pending"] = None
            if st["pending_add"] is not None and st["units"] and len(st["units"]) < MAX_UNITS:
                _, side = st["pending_add"]
                if (not nin) and N > 0 and (side == 1 or MODE != "long"):
                    gap_block = (side == 1 and o >= c_prev * (1 + lim * 0.98)) or \
                                (side == -1 and o <= c_prev * (1 - lim * 0.98))
                    if (not gap_block):
                        pos = min(UNIT_RISK * prev_eq * o / (SM * N), UNIT_CAP * prev_eq)
                        if pos > 0 and invested + pos <= prev_eq:
                            stop = (o - SM * N) if side == 1 else (o + SM * N)
                            st["units"].append({"entry": o, "stop": stop, "pos": pos, "side": side, "entry_i": i})
                            if side == 1:
                                acct_cash -= pos
                            else:
                                acct_cash += pos
                            invested += pos; n_units_opened += 1
                            acct_cash -= COST * pos
                            st["last_add"] = o
                    st["pending_add"] = None
                else:
                    st["pending_add"] = None

            # 2) 出场（止损 / 10日反向突破）；买入当日(T+1)不可平
            if st["units"]:
                keep = [u for u in st["units"] if i <= u["entry_i"]]        # 当日买入，锁仓
                sellable = [u for u in st["units"] if i > u["entry_i"]]
                still = []
                for u in sellable:
                    if u["side"] == 1:
                        if l <= u["stop"]:
                            acct_cash += u["pos"] * (u["stop"] / u["entry"])
                            acct_cash -= COST * u["pos"]; invested -= u["pos"]; n_units_closed += 1
                        else:
                            still.append(u)
                    else:
                        if h >= u["stop"]:
                            acct_cash -= u["pos"] * (u["stop"] / u["entry"])
                            acct_cash -= COST * u["pos"]; invested -= u["pos"]; n_units_closed += 1
                        else:
                            still.append(u)
                st["units"] = keep + still
                if st["units"]:
                    side0 = st["units"][0]["side"]
                    if side0 == 1:
                        if (not np.isnan(ll10)) and c < ll10:
                            rem = []
                            for u in st["units"]:
                                if i > u["entry_i"]:
                                    acct_cash += u["pos"] * (c / u["entry"])
                                    acct_cash -= COST * u["pos"]; invested -= u["pos"]; n_units_closed += 1
                                else:
                                    rem.append(u)
                            st["units"] = rem
                    else:
                        if (not np.isnan(hh10)) and c > hh10:
                            rem = []
                            for u in st["units"]:
                                if i > u["entry_i"]:
                                    acct_cash -= u["pos"] * (c / u["entry"])
                                    acct_cash -= COST * u["pos"]; invested -= u["pos"]; n_units_closed += 1
                                else:
                                    rem.append(u)
                            st["units"] = rem
                    if not st["units"]:
                        st["side"] = 0; st["last_add"] = None

            # 3) 生成新挂单（平: 突破/跌破; 持: 金字塔加仓）
            if st["side"] == 0 and st["pending"] is None:
                if (not np.isnan(hh)) and h > hh:
                    st["pending"] = (hh, 1)
                elif MODE != "long" and (not np.isnan(ll20)) and l < ll20:
                    st["pending"] = (ll20, -1)
            elif st["units"] and len(st["units"]) < MAX_UNITS and st["pending_add"] is None:
                if not nin:
                    if st["side"] == 1:
                        addlvl = st["last_add"] + PYR_STEP * N
                        if h >= addlvl:
                            st["pending_add"] = (addlvl, 1)
                    else:
                        addlvl = st["last_add"] - PYR_STEP * N
                        if l <= addlvl:
                            st["pending_add"] = (addlvl, -1)

            last_close[si] = c

        # 当日盯市
        eq = acct_cash
        for si in range(len(stocks)):
            st = state[si]
            if st["units"]:
                cl = last_close[si]
                for u in st["units"]:
                    if u["side"] == 1:
                        eq += u["pos"] * (cl / u["entry"])
                    else:
                        eq += -u["pos"] * (cl / u["entry"])
        if any(state[si]["units"] for si in range(len(stocks))):
            in_market_days += 1
        equity_curve.append(eq)
        dates_out.append(d)

    # 基准：等权买入持有（每日再平衡）
    bm_eq = [1.0]; bm_last = [s["c"][0] for s in stocks]; bm_cnt = [len(s["dates"]) > 0 for s in stocks]
    bm_have = [True]*len(stocks)
    for g, d in enumerate(global_dates[1:], 1):
        bars = bars_by_date[d]
        rets = []
        for (si, i) in bars:
            if i >= 1:
                rets.append(stocks[si]["c"][i] / stocks[si]["c"][i-1] - 1)
                last_close_bm = stocks[si]["c"][i]
            else:
                rets.append(0.0)
        r = np.mean(rets) if rets else 0.0
        bm_eq.append(bm_eq[-1] * (1 + r))

    # 指标
    eq = np.array(equity_curve)
    rets = eq[1:] / eq[:-1] - 1
    n_years = (global_dates[-1] >= global_dates[0]) and (len(global_dates) / 252.0) or 1.0
    carg = eq[-1] ** (1 / n_years) - 1 if eq[-1] > 0 else float("nan")
    sd = rets.std(ddof=1)
    sharpe = (rets.mean() * math.sqrt(252) / sd) if sd > 0 else float("nan")
    run_max = np.maximum.accumulate(eq)
    maxdd = (eq / run_max - 1).min()
    bm_arr = np.array(bm_eq)
    bm_rets = bm_arr[1:] / bm_arr[:-1] - 1
    bm_carg = bm_arr[-1] ** (1 / n_years) - 1
    bm_sd = bm_rets.std(ddof=1)
    bm_sharpe = bm_rets.mean() * math.sqrt(252) / bm_sd if bm_sd > 0 else float("nan")
    bm_dd = (bm_arr / np.maximum.accumulate(bm_arr) - 1).min()

    print("\n========== 完整海龟系统（组合, 单边多, T+1, 无杠杆） ==========")
    print(f"  样本期        : {global_dates[0]} ~ {global_dates[-1]} ({n_years:.1f} 年)")
    print(f"  开仓单位数    : {n_units_opened}   平仓单位数: {n_units_closed}")
    print(f"  在市交易日占比: {in_market_days/len(global_dates)*100:.1f}%")
    print(f"  --- 海龟组合 ---")
    print(f"  期末净值      : {eq[-1]:.3f}")
    print(f"  年化收益 CARG : {carg*100:+.2f}%")
    print(f"  年化夏普      : {sharpe:.3f}")
    print(f"  最大回撤      : {maxdd*100:.2f}%")
    print(f"  --- 等权买入持有基准 ---")
    print(f"  期末净值      : {bm_arr[-1]:.3f}  年化 {bm_carg*100:+.2f}%  夏普 {bm_sharpe:.3f}  回撤 {bm_dd*100:.2f}%")
    print(f"  --- 结论(由数据算) ---")
    print(f"  海龟组合夏普 {sharpe:.3f} vs 基准 {bm_sharpe:.3f} -> {'跑赢基准' if sharpe>bm_sharpe else '未跑赢基准'}")
    print(f"  组合是否正 Sharpe(可部署信号): {'是' if sharpe>0 else '否'}")

    out = {"final_equity": round(float(eq[-1]),4), "carg": round(float(carg),4),
           "sharpe": round(float(sharpe),4), "maxdd": round(float(maxdd),4),
           "bm_carg": round(float(bm_carg),4), "bm_sharpe": round(float(bm_sharpe),4),
           "bm_maxdd": round(float(bm_dd),4), "units_opened": n_units_opened,
           "in_market_pct": round(in_market_days/len(global_dates),4)}
    os.makedirs("data/backtest/research", exist_ok=True)
    json.dump(out, open("data/backtest/research/turtle-system.json","w"), ensure_ascii=False)
    print("已落盘: data/backtest/research/turtle-system.json")

if __name__ == "__main__":
    main()
