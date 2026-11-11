#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
缠论（缠中说禅）机械化日线回测 —— 标准机械版，诚实 T+1 口径。

明确边界：缠论高度依赖"笔/线段/中枢"画法，不同人不同画法。本脚本按最标准的
机械规则实现一个【可复现的机械版】，不是"缠论的全部"。规则如下（可审计）：

  1. 包含处理：相邻 K 线互相包含则合并（上升取高高、下降取低低）
  2. 分型：合并K线上，中间柱高/低均高于两侧=顶分型；均低于两侧=底分型
  3. 笔：顶底分型交替相连，两分型中心间隔 >=4 根合并K线
  4. 中枢：连续 3 笔的价格区间重叠 -> [ZD=max(低), ZG=min(高)]，ZD<ZG 有效
  5. 第三类买点：中枢后向上离开(某笔高>ZG)，回抽笔的低仍 >ZG -> 回抽低=三买
  6. 第一类买点(背驰)：向下笔创新低，但 MACD-DIF 高于前一低点 -> 底背驰=一买
  7. 买点在其分型被"下一根合并K线"确认后才成立（无前视）；信号次日开盘成交
  8. A股 T+1：买入当日不可平；涨停开盘买不到=作废；扣双边成本 0.15%
  9. 出场：跌破买点低 3% 止损 / 10 日低点跌破 / 最长 30 日

统计：每笔均值、聚类 t(按个股)、六切片、扣成本净超额、双闸。
结论全部由数据算，脚本不写死结论。
"""
import json, glob, os, math, sys
import numpy as np

KLINE_DIR = "data/backtest/kline"
MIN_BARS = 250
COST = 0.0015

def ema(a, n):
    out = np.empty(len(a)); out[0] = a[0]; k = 2.0/(n+1)
    for i in range(1, len(a)):
        out[i] = a[i]*k + out[i-1]*(1-k)
    return out

def macd_dif(c):
    return ema(c, 12) - ema(c, 26)

def board_limit(code):
    if code.startswith("sh688") or code.startswith("sz300"): return 0.20
    if code.startswith("bj"): return 0.30
    return 0.10

def load(path):
    try:
        d = json.load(open(path))
    except Exception:
        return None
    if not isinstance(d, list) or len(d) < MIN_BARS:
        return None
    code = os.path.basename(path)[:-5]
    dates = [x["date"] for x in d]
    o = np.array([x["o"] for x in d], float)
    h = np.array([x["h"] for x in d], float)
    l = np.array([x["l"] for x in d], float)
    c = np.array([x["c"] for x in d], float)
    return dict(code=code, dates=dates, o=o, h=h, l=l, c=c, limit=board_limit(code))

def merge_bars(h, l):
    """包含处理，返回 [h, l, s(起始原索引), e(结束原索引)]"""
    m = []
    for k in range(len(h)):
        hi, lo = h[k], l[k]
        if len(m) < 2:
            m.append([hi, lo, k, k]); continue
        last = m[-1]; prev = m[-2]
        up = last[0] > prev[0]
        if (hi >= last[0] and lo <= last[1]) or (hi <= last[0] and lo >= last[1]):
            if up:
                nh = max(last[0], hi); nl = max(last[1], lo)
            else:
                nh = min(last[0], hi); nl = min(last[1], lo)
            m[-1] = [nh, nl, last[2], k]
        else:
            m.append([hi, lo, k, k])
    return m

def fractals(m):
    """返回 [(type, j, confirm_orig_idx)]
    confirm 取 m[j+2] 起始前一根(即 m[j+1] 确认闭合处)，杜绝右邻合并K线继续并入的前视"""
    fr = []
    for j in range(1, len(m)-2):
        a, b, cc = m[j-1], m[j], m[j+1]
        confirm = m[j+2][2] - 1
        if b[0] > a[0] and b[0] > cc[0] and b[1] > a[1] and b[1] > cc[1]:
            fr.append(("top", j, confirm))
        elif b[1] < a[1] and b[1] < cc[1] and b[0] < a[0] and b[0] < cc[0]:
            fr.append(("bot", j, confirm))
    return fr

def build_bis(fr, m):
    # 合并同型分型，保留更极端
    col = []
    for f in fr:
        if col and col[-1][0] == f[0]:
            if f[0] == "top":
                if m[f[1]][0] > m[col[-1][1]][0]: col[-1] = f
            else:
                if m[f[1]][1] < m[col[-1][1]][1]: col[-1] = f
        else:
            col.append(f)
    bis = []
    i = 0
    while i < len(col)-1:
        f, nf = col[i], col[i+1]
        if nf[1] - f[1] >= 4:
            d = 1 if f[0] == "bot" else -1
            hi = max(m[f[1]][0], m[nf[1]][0])
            lo = min(m[f[1]][1], m[nf[1]][1])
            bis.append({"dir": d, "hi": hi, "lo": lo, "s": m[f[1]][2], "e": m[nf[1]][3], "confirm": nf[2]})
            i += 1
        else:
            i += 1
    return bis

def pivots(bis):
    pv = []
    for k in range(len(bis)-2):
        b1, b2, b3 = bis[k], bis[k+1], bis[k+2]
        ZG = min(b1["hi"], b2["hi"], b3["hi"])
        ZD = max(b1["lo"], b2["lo"], b3["lo"])
        if ZG > ZD:
            pv.append({"ZD": ZD, "ZG": ZG, "e_bi": k+2})
    return pv

def signals(bis, pv, dif):
    out = []
    # 第三类买点
    for p in pv:
        ZG = p["ZG"]
        for q in range(p["e_bi"]+1, len(bis)-1):
            bu = bis[q]
            if bu["dir"] == 1 and bu["hi"] > ZG:
                d = bis[q+1]
                if d["dir"] == -1 and d["lo"] > ZG:
                    out.append({"kind": "3rd", "low": d["lo"], "confirm": d["confirm"], "ref": ZG})
                break
    # 第一类买点（底背驰）
    lastdown = None
    for b in bis:
        if b["dir"] == -1:
            if lastdown is not None and b["lo"] < lastdown["lo"] and dif[b["e"]] > dif[lastdown["e"]]:
                out.append({"kind": "1st", "low": b["lo"], "confirm": b["confirm"], "ref": b["lo"]})
            lastdown = b
    # 去重（同 confirm 取一次）
    seen = set(); uniq = []
    for s in out:
        key = (s["kind"], s["confirm"])
        if key not in seen:
            seen.add(key); uniq.append(s)
    uniq.sort(key=lambda x: x["confirm"])
    return uniq

def backtest(s):
    o, h, l, c = s["o"], s["h"], s["l"], s["c"]
    dates = s["dates"]; lim = s["limit"]
    dif = macd_dif(c)
    m = merge_bars(h, l)
    fr = fractals(m)
    bis = build_bis(fr, m)
    if len(bis) < 3:
        return []
    pv = pivots(bis)
    sig = signals(bis, pv, dif)
    trades = []
    for x in sig:
        conf = x["confirm"]
        ei = conf + 1                     # 次日开盘买入
        if ei >= len(c):
            continue
        entry = o[ei]
        cprev = c[conf] if conf >= 0 else c[ei]
        if (not np.isfinite(entry)) or entry <= 0:
            continue
        if entry >= cprev * (1 + lim * 0.98):   # 涨停开盘买不到
            continue
        stop = x["low"] * (1 - 0.03)
        if stop >= entry:                  # 买点低已高于开盘，止损设 3% 下方
            stop = entry * 0.97
        exit_price = None; ex = None
        for j in range(ei+1, min(ei+31, len(c))):   # T+1: 最早 ei+1
            if l[j] <= stop:
                exit_price = stop; ex = j; break
            # 10 日低点跌破
            if j >= 10:
                ll10 = l[j-10:j].min()
                if c[j] < ll10:
                    exit_price = c[j]; ex = j; break
        if exit_price is None:
            ex = min(ei+30, len(c)-1); exit_price = c[ex]
        ret = exit_price/entry - 1
        trades.append((s["code"], dates[ei], dates[ex], ret, x["kind"]))
    return trades

def build_market(stocks):
    by = {}
    for s in stocks:
        c = s["c"]; dt = s["dates"]
        for i in range(1, len(c)):
            if c[i-1] > 0:
                by.setdefault(dt[i], []).append(c[i]/c[i-1]-1)
    return {d: float(np.mean(v)) for d, v in by.items()}

def clustered_t(rets_by_code):
    means = [np.mean(v) for v in rets_by_code.values() if v]
    if len(means) < 2: return float("nan"), len(means)
    m = np.mean(means); sd = np.std(means, ddof=1)
    if sd == 0: return float("nan"), len(means)
    return m/(sd/math.sqrt(len(means))), len(means)

def six_slices(tr):
    t2 = sorted(tr, key=lambda x: x[2]); n = len(t2); k = n//6; out=[]
    for i in range(6):
        seg = t2[i*k:(i+1)*k] if i < 5 else t2[i*k:]
        if seg: out.append(np.mean([x[3] for x in seg]))
    return out

def main():
    n_sample = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    paths = sorted(glob.glob(os.path.join(KLINE_DIR, "*.json")))
    if n_sample > 0:
        paths = paths[:n_sample]
    stocks = [s for p in paths if (s := load(p))]
    print(f"股票数: {len(stocks)}", flush=True)
    mkt = build_market(stocks)
    # 市场累计净值（按全局日期），用于算每笔持有期市场收益
    all_dates = sorted(mkt.keys())
    cum = 1.0; cum_mkt = {}
    for d in all_dates:
        cum *= (1 + mkt[d]); cum_mkt[d] = cum
    allt = []
    for s in stocks:
        allt += backtest(s)
    if not allt:
        print("0 笔信号"); return
    rets = np.array([t[3] for t in allt])
    ex = np.array([(cum_mkt.get(t[2], 1.0) / cum_mkt.get(t[1], 1.0) - 1) for t in allt])
    rets_net = rets - COST
    excess_net = rets_net - ex
    by = {}
    for t in allt:
        by.setdefault(t[0], []).append(t[3])
    tclu, ncode = clustered_t(by)
    slices = six_slices(allt)
    half = len(allt)//2
    first = np.mean([t[3] for t in allt[:half]]); second = np.mean([t[3] for t in allt[half:]])
    same_dir = (first > 0) == (second > 0)
    print(f"\n=== 缠论机械版（三买+一买底背驰） ===")
    print(f"  样本笔数   : {len(allt)}   覆盖个股 {ncode}")
    print(f"  每笔均值   : {rets.mean()*100:+.3f}%  (中位 {np.median(rets)*100:+.3f}%)")
    print(f"  扣成本均值 : {rets_net.mean()*100:+.3f}%")
    print(f"  净超额均值 : {excess_net.mean()*100:+.3f}%")
    print(f"  聚类 t     : {tclu:+.3f}")
    print(f"  前后半段   : 前 {first*100:+.3f}% / 后 {second*100:+.3f}%  同向={same_dir}")
    print(f"  六切片(%)  : " + " / ".join(f"{s*100:+.2f}" for s in slices))
    gate = (abs(tclu) >= 2) and same_dir and (rets_net.mean() > 0) and (excess_net.mean() > 0)
    print(f"  双闸(净): |t|>=2 & 前后同向 & 净均值>0 & 净超额>0 -> {'PASS' if gate else 'FAIL'}")

    # 按买点类型拆
    ex_map = {id(t): e for t, e in zip(allt, ex)}
    for kind, label in [("3rd", "第三类买点(突破回抽)"), ("1st", "第一类买点(底背驰)")]:
        sub = [t for t in allt if t[4] == kind]
        if not sub:
            continue
        r = np.array([t[3] for t in sub])
        e = np.array([ex_map[id(t)] for t in sub])
        bc = {}
        for t in sub:
            bc.setdefault(t[0], []).append(t[3])
        tk, nk = clustered_t(bc)
        slices_k = six_slices(sub)
        print(f"  --- {label} ---")
        print(f"    笔数 {len(sub)} | 毛均值 {r.mean()*100:+.3f}% | 净 {(r.mean()-COST)*100:+.3f}% | 净超额 {((r.mean()-COST)-e.mean())*100:+.3f}% | 聚类t {tk:+.2f}")
        print(f"    六切片(%) : " + " / ".join(f"{s*100:+.2f}" for s in slices_k))
    os.makedirs("data/backtest/research", exist_ok=True)
    json.dump([{"code":t[0],"entry":t[1],"exit":t[2],"ret":round(t[3],6)} for t in allt],
              open("data/backtest/research/chanlun-trades.json","w"), ensure_ascii=False)

if __name__ == "__main__":
    main()
