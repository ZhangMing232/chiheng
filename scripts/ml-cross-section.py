#!/usr/bin/env python3
"""
ML 截面对照实验（2026-11-10 预登记，design/quantmind-borrow-list.md P0-1）。

学界标准打法当对照组：价量特征 → GBDT → 每日截面打分取 Top-N，回答「手写规则
之外有没有系统性 alpha」。产出 data/ml-scores.json，由 backtest.ts 的 mlTop 家族
（BT_ML=1）消费，判决走 eval-robust 六切片——不另设判决口径。

预登记口径（一个都不许事后再调）：
- 特征：Alpha158 价量口径（Qlib 标准公式），KBAR 8 组 + 28 组公式 × 窗口
  [5,10,20,60] ≈ 120 维，只用 ≤T 的数据。缺 vwap 类（kline 无成交额字段）。
- 标签：T+8 收盘收益 − 当日全池均值（= 判决要的超额口径，持有 8 日对齐执行骨架）。
- 模型：sklearn HistGradientBoostingRegressor（梯度提升树；LightGBM/XGBoost 在
  本机缺 libomp 装不上，方法论不受库名影响），超参固定：
  max_iter=200, learning_rate=0.05, max_depth=6, early_stopping=False。不调参。
- 滚动训练：每 40 个交易日重训一次；训练窗 = 锚点前 750 个交易日（标签截止
  锚点−8，防泄漏），模型给锚点起 40 天打分。评估窗 = 最近 850 个交易日。
- 输出：每日 top-50 分数（runPass 每天最多买 MAX_POSITIONS=10，第 51 名永远
  轮不上）。

已知口径注记（写进产出 JSON）：无历史 ST 标记，ST 股混在样本里；kline 是腾讯
前复权 + baostock 全史接缝（接缝已对齐基准，见 refresh-kline.ts 注释）。

用法：python3 scripts/ml-cross-section.py
"""
import json
import glob
import sys
import time
from datetime import datetime, timezone, timedelta

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

KLINE_DIR = "data/backtest/kline"
OUT_PATH = "data/ml-scores.json"
WINDOWS = (5, 10, 20, 60)
PANEL_DAYS = 1650      # 750 训练 + 8 标签禁运 + 850 评估 + 60 特征预热
TRAIN_DAYS = 750
EMBARGO = 8            # 标签长度：训练行必须 ≤ 锚点-8
REFIT_EVERY = 40
EVAL_DAYS = 850
TOPK = 50

CST = timezone(timedelta(hours=8))


def load_panels():
    """每只股票一段 DataFrame（date,o,h,l,c,v），只保留最近 PANEL_DAYS 个交易日。"""
    panels = {}
    files = sorted(glob.glob(f"{KLINE_DIR}/*.json"))
    if not files:
        sys.exit(f"没有 K 线缓存：{KLINE_DIR}")
    for f in files:
        try:
            rows = json.load(open(f))
        except Exception:
            continue
        if not isinstance(rows, list) or len(rows) < 130:
            continue
        df = pd.DataFrame(rows)[["date", "o", "h", "l", "c", "v"]].astype(
            {"o": "f4", "h": "f4", "l": "f4", "c": "f4", "v": "f4"}
        )
        panels[f.split("/")[-1].replace(".json", "")] = df.tail(PANEL_DAYS).reset_index(drop=True)
    return panels


def kbar(df):
    o, h, l, c = df["o"], df["h"], df["l"], df["c"]
    hl = (h - l).replace(0, np.nan)
    return pd.DataFrame({
        "KMID": (c - o) / o,
        "KLEN": (h - l) / o,
        "KMID2": (c - o) / hl,
        "KUP": (h - pd.concat([o, c], axis=1).max(axis=1)) / o,
        "KUP2": (h - pd.concat([o, c], axis=1).max(axis=1)) / hl,
        "KLOW": (pd.concat([o, c], axis=1).min(axis=1) - l) / o,
        "KLOW2": (pd.concat([o, c], axis=1).min(axis=1) - l) / hl,
        "KSFT": (2 * c - h - l) / hl,
    })


def window_features(df):
    """Alpha158 价量口径 28 组 × 窗口。全只用 ≤T 的滚动窗，无未来。"""
    c, h, l, v = df["c"], df["h"], df["l"], df["v"]
    seq = pd.Series(np.arange(len(df), dtype="f4"))
    diff = c.diff()
    ad = diff.abs()
    lr = c / c.shift(1) - 1            # 简单收益
    lrc = np.log(c / c.shift(1))       # 对数收益（CORD 用）
    lrv = np.log(v / v.shift(1)).replace([np.inf, -np.inf], np.nan)
    up, dn = diff.clip(lower=0), (-diff).clip(lower=0)
    v_up = v.where(diff > 0, 0.0)
    v_dn = v.where(diff < 0, 0.0)
    out = {}
    for n in WINDOWS:
        r = lambda s: s.rolling(n)  # noqa: E731
        sd_c = r(c).std(ddof=0)
        sd_s = r(seq).std(ddof=0)
        corr_cs = r(c).corr(seq)
        slope = corr_cs * sd_c / sd_s
        out[f"ROC{n}"] = c / c.shift(n) - 1
        out[f"MA{n}"] = r(c).mean() / c
        out[f"STD{n}"] = sd_c / c
        out[f"BETA{n}"] = slope / c
        out[f"RSQR{n}"] = corr_cs ** 2
        out[f"RESI{n}"] = (c - (r(c).mean() - slope * r(seq).mean() + slope * seq)) / c
        out[f"MAX{n}"] = r(h).max() / c
        out[f"MIN{n}"] = r(l).min() / c
        out[f"QTLU{n}"] = r(c).quantile(0.8) / c
        out[f"QTLD{n}"] = r(c).quantile(0.2) / c
        rng = (r(h).max() - r(l).min()).replace(0, np.nan)
        out[f"RSV{n}"] = (c - r(l).min()) / rng
        out[f"IMAX{n}"] = (r(h).apply(lambda x: x.argmax(), raw=True) + 1) / n
        out[f"IMIN{n}"] = (r(l).apply(lambda x: x.argmin(), raw=True) + 1) / n
        out[f"IMXD{n}"] = out[f"IMAX{n}"] - out[f"IMIN{n}"]
        out[f"CORR{n}"] = r(c).corr(v)
        out[f"CORD{n}"] = r(lrc).corr(lrv)
        out[f"CNTP{n}"] = r(pd.Series((diff > 0).astype("f4"))).mean()
        out[f"CNTN{n}"] = r(pd.Series((diff < 0).astype("f4"))).mean()
        out[f"CNTD{n}"] = out[f"CNTP{n}"] - out[f"CNTN{n}"]
        ad_n = r(ad).sum().replace(0, np.nan)
        out[f"SUMP{n}"] = r(up).sum() / ad_n
        out[f"SUMN{n}"] = r(dn).sum() / ad_n
        out[f"SUMD{n}"] = out[f"SUMP{n}"] - out[f"SUMN{n}"]
        out[f"VMA{n}"] = r(v).mean() / v
        out[f"VSTD{n}"] = r(v).std(ddof=0) / v
        den = (r(v).mean() * r(lr.abs()).mean()).replace(0, np.nan)
        out[f"WVMA{n}"] = r(v * lr.abs()).mean() / den
        vsum = r(v).sum().replace(0, np.nan)
        out[f"VSUMP{n}"] = r(v_up).sum() / vsum
        out[f"VSUMN{n}"] = r(v_dn).sum() / vsum
        out[f"VSUMD{n}"] = out[f"VSUMP{n}"] - out[f"VSUMN{n}"]
    return pd.DataFrame(out)


def main():
    t0 = time.time()
    panels = load_panels()
    print(f"股票 {len(panels)} 只，开始算特征…", flush=True)

    feat_frames, label_frames = [], []
    for pid, df in panels.items():
        f = pd.concat([kbar(df), window_features(df)], axis=1)
        f["date"] = df["date"]
        f["id"] = pid
        f["fwd8"] = (df["c"].shift(-EMBARGO) / df["c"] - 1).astype("f4")
        feat_frames.append(f)
    panel = pd.concat(feat_frames, ignore_index=True)
    del feat_frames, label_frames
    # 标签去当日全池均值 = 超额口径（判决要的就是超额）
    panel["fwd8"] = panel["fwd8"] - panel.groupby("date")["fwd8"].transform("mean")
    feat_cols = [c for c in panel.columns if c not in ("date", "id", "fwd8")]
    print(f"面板 {len(panel)} 行 × {len(feat_cols)} 维，{time.time() - t0:.0f}s", flush=True)

    dates = sorted(panel["date"].unique())
    eval_start = len(dates) - EVAL_DAYS
    date_pos = {d: i for i, d in enumerate(dates)}
    X_all = panel[feat_cols].to_numpy(dtype="f4")
    y_all = panel["fwd8"].to_numpy(dtype="f4")
    date_idx = panel["date"].map(date_pos).to_numpy()
    ids = panel["id"].to_numpy()
    del panel

    days: dict = {}
    bottom: dict = {}
    fold_ics = []
    for anchor in range(eval_start, len(dates), REFIT_EVERY):
        train_lo, train_hi = anchor - TRAIN_DAYS, anchor - EMBARGO
        tr = (date_idx >= train_lo) & (date_idx < train_hi) & np.isfinite(y_all)
        te_lo, te_hi = anchor, min(anchor + REFIT_EVERY, len(dates))
        if tr.sum() < 10000:
            print(f"锚点 {dates[anchor]} 训练行不足（{tr.sum()}），跳过", flush=True)
            continue
        model = HistGradientBoostingRegressor(
            max_iter=200, learning_rate=0.05, max_depth=6, early_stopping=False
        )
        model.fit(X_all[tr], y_all[tr])
        for di in range(te_lo, te_hi):
            day = dates[di]
            mask = (date_idx == di) & np.isfinite(X_all[:, 0])
            if mask.sum() == 0:
                continue
            scores = model.predict(X_all[mask])
            order = np.argsort(-scores)[:TOPK]
            days[day] = [[str(ids[mask][i]), round(float(scores[i]), 5)] for i in order]
            # bottom-50（2026-11-10 补存）：ML 排除器 A/B（DECISIONS 预登记）要用
            # 「模型最不看好的」名单——Top-50 存法不变，另开一张表。
            rev = np.argsort(scores)[:TOPK]
            bottom[day] = [[str(ids[mask][i]), round(float(scores[i]), 5)] for i in rev]
            # 折内 sanity：当日预测 vs 实现的 rank IC（有标签的行）
            lab = y_all[mask]
            ok = np.isfinite(lab)
            if ok.sum() > 30:
                r_pred = pd.Series(scores[ok]).rank()
                r_lab = pd.Series(lab[ok]).rank()
                fold_ics.append(float(r_pred.corr(r_lab)))
        print(f"锚点 {dates[anchor]}：训 {tr.sum()} 行 → 评 {te_hi - te_lo} 天，均 IC {np.mean(fold_ics[-(te_hi - te_lo):]):+.4f}", flush=True)

    out = {
        "generatedFor": datetime.now(CST).strftime("%Y-%m-%d"),
        "engine": "sklearn HistGradientBoostingRegressor(max_iter=200, lr=0.05, depth=6)（LightGBM/XGBoost 本机缺 libomp，方法论同为 GBDT）",
        "label": "T+8 收盘收益 − 当日全池均值",
        "features": f"Alpha158 价量口径 KBAR8 + 28组×窗{list(WINDOWS)}（缺 vwap 类）",
        "walkForward": f"每 {REFIT_EVERY} 交易日重训，训练窗 {TRAIN_DAYS} 天（标签截止锚点−{EMBARGO}），评估窗 {EVAL_DAYS} 天",
        "caveats": [
            "无历史 ST 标记，ST 股混在样本；kline 为腾讯前复权+baostock 全史接缝（基准已对齐）。",
            "特征只用 ≤T 数据；训练/评估按时间切分，无随机切。",
            "分数只存每日 top-50（runPass 每天最多买 10 只）。",
            "这是对照实验的预测分，不是策略收益；判决走 eval-robust 六切片。",
        ],
        "meanRankIC": round(float(np.mean(fold_ics)), 4) if fold_ics else None,
        "daysScored": len(days),
        "days": days,
        "bottom": bottom,
    }
    with open(OUT_PATH, "w") as fh:
        json.dump(out, fh, ensure_ascii=False)
    print(f"\n完成：{len(days)} 天分数 → {OUT_PATH}，日均 rank IC {out['meanRankIC']}，{time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
