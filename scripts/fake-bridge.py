#!/usr/bin/env python3
"""
这个文件是干什么的：
    QMT 桥接的**假实现**，用来测 Node 侧客户端在各种故障下的行为。
    它**故意不 import xtquant** —— 一旦 import 了，就只能在装了 QMT 的 Windows 上跑，
    而契约测试最需要的就是「在开发机上随时能跑」。

协议规格：scripts/qmt-protocol.md

靠环境变量触发不同的故障场景（这样一条命令就能跑全部，不用改代码）：
    FAKE_MODE=normal          正常应答（默认）
    FAKE_MODE=die_on_start     握手前立刻退出
    FAKE_MODE=fatal           发一条 fatal 然后退出
    FAKE_MODE=hang_queries    收到 query 就不回（测超时）
    FAKE_MODE=no_ready        连上了但不发 ready（测「活着但没握手完」）
    FAKE_MODE=noisy           先喷几行非 JSON（测协议容错）
    FAKE_DUP_FILL=1           同一个 tradedId 推两次（测成交去重）
    FAKE_PENDING_ON_START=1   握手时报告有未对齐的旧委托

另外：
    FAKE_LOG=<路径>           把每一帧都记下来（测试用它断言「到底报出去没有」）
"""
import json
import os
import sys
import time

MODE = os.environ.get("FAKE_MODE", "normal")
LOG = os.environ.get("FAKE_LOG")


def log_event(kind, **fields):
    """测试靠这个文件断言「到底有没有报出去」。协议里 stdout 是干净的，旁路写文件。"""
    if not LOG:
        return
    with open(LOG, "a", encoding="utf-8") as handle:
        handle.write(json.dumps({"kind": kind, **fields}, ensure_ascii=False) + "\n")


def out(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def read_in():
    for line in sys.stdin:
        text = line.strip()
        if text:
            yield json.loads(text)


def main():
    if MODE == "die_on_start":
        # 连握手都不等就死。Node 侧应该看到 EOF / exit，并且永远不认为可以下单。
        log_event("exit", code=1, note="die_on_start")
        sys.exit(1)

    if MODE == "noisy":
        # Python 偶尔会把 traceprint 打到 stdout。Node 侧必须容错，
        # 不能因为一行不是 JSON 就丢掉后面所有消息。
        sys.stdout.write("Traceback (most recent call last):\n")
        sys.stdout.write("  File \"xtquant.py\", line 1, in <module>\n")
        sys.stdout.flush()

    asset = {
        "cash": 1000000.0,
        "frozenCash": 0.0,
        "marketValue": 0.0,
        "totalAsset": float(os.environ.get("FAKE_TOTAL_ASSET", "1000000")),
    }

    for frame in read_in():
        kind = frame.get("type")

        if kind == "init":
            log_event("init", **frame)
            if MODE == "fatal":
                out({"type": "fatal", "message": "xtquant 未安装", "traceback": "ModuleNotFoundError: xtquant"})
                log_event("exit", code=1, note="fatal")
                sys.exit(1)
            if MODE == "no_ready":
                # 连上了但不发 ready。Node 侧 isAlive=true 但 canTrade() 必须是 false。
                out({"type": "event", "event": "on_connected"})
                continue
            pending = os.environ.get("FAKE_PENDING_ON_START") == "1"
            out(
                {
                    "type": "ready",
                    "connected": True,
                    "accountId": frame.get("accountId"),
                    "asset": asset,
                    # 告诉 Node「重启前有一单报出去了但状态不明」——
                    # 这是崩溃恢复场景的关键输入
                    "unreconciled": (
                        [{"brokerOrderId": 8888, "code": "sh600000", "volume": 100, "price": 12.34}]
                        if pending
                        else []
                    ),
                }
            )
            out({"type": "event", "event": "on_connected"})

        elif kind == "query":
            log_event("query", op=frame.get("op"), id=frame.get("id"))
            if MODE == "hang_queries":
                # 不回。Python 不会死也不会 EOF —— 只能靠超时。
                continue
            op = frame.get("op")
            if op == "asset":
                out({"type": "resp", "id": frame["id"], "ok": True, "data": asset})
            elif op == "positions":
                out(
                    {
                        "type": "resp",
                        "id": frame["id"],
                        "ok": True,
                        "data": {
                            "positions": [
                                {
                                    "code": "sh600000",
                                    "volume": 300,
                                    "canUseVolume": 300,
                                    "avgPrice": 12.0,
                                    "marketValue": 3600.0,
                                }
                            ]
                        },
                    }
                )
            elif op == "orders":
                out(
                    {
                        "type": "resp",
                        "id": frame["id"],
                        "ok": True,
                        "data": {
                            "orders": [
                                {
                                    "brokerOrderId": 8888,
                                    "code": "sh600000",
                                    "orderStatus": 50,
                                    "orderVolume": 100,
                                    "tradedVolume": 0,
                                }
                            ]
                        },
                    }
                )
            elif op == "quotes":
                codes = frame.get("codes") or []
                out(
                    {
                        "type": "resp",
                        "id": frame["id"],
                        "ok": True,
                        "data": {
                            "quotes": {
                                code: {
                                    "lastPrice": 12.5,
                                    "lastClose": 12.4,
                                    "limitUp": 13.64,
                                    "limitDown": 11.16,
                                    "volume": 1234567,
                                    "amount": 15400000.0,
                                }
                                for code in codes
                            }
                        },
                    }
                )
            else:
                out(
                    {
                        "type": "resp",
                        "id": frame["id"],
                        "ok": False,
                        "error": {"code": "BAD_OP", "message": f"不认识的 op：{op}"},
                    }
                )

        elif kind == "order":
            log_event("order", **{k: v for k, v in frame.items() if k != "type"})
            out(
                {
                    "type": "resp",
                    "id": frame.get("id"),
                    "ok": True,
                    "data": {
                        "brokerOrderId": 9001,
                        "clientOrderId": frame.get("clientOrderId"),
                    },
                }
            )
            out(
                {
                    "type": "event",
                    "event": "on_stock_order",
                    "data": {
                        "brokerOrderId": 9001,
                        "code": frame.get("code"),
                        "orderStatus": 50,
                        "orderVolume": frame.get("volume"),
                        "tradedVolume": 0,
                    },
                }
            )
            trade_id = 8899
            out(
                {
                    "type": "event",
                    "event": "on_stock_trade",
                    "data": {
                        "tradedId": trade_id,
                        "brokerOrderId": 9001,
                        "code": frame.get("code"),
                        "tradedPrice": frame.get("price") or 12.34,
                        "tradedVolume": frame.get("volume"),
                        "tradedAmount": (frame.get("price") or 12.34) * (frame.get("volume") or 100),
                    },
                }
            )
            if os.environ.get("FAKE_DUP_FILL") == "1":
                # 断线重连时 xtquant 会把同一条成交回报再推一遍。
                # Node 侧必须靠 tradedId 去重。
                out(
                    {
                        "type": "event",
                        "event": "on_stock_trade",
                        "data": {
                            "tradedId": trade_id,
                            "brokerOrderId": 9001,
                            "code": frame.get("code"),
                            "tradedPrice": frame.get("price") or 12.34,
                            "tradedVolume": frame.get("volume"),
                            "tradedAmount": (frame.get("price") or 12.34) * (frame.get("volume") or 100),
                        },
                    }
                )
        elif kind == "cancel":
            log_event("cancel", brokerOrderId=frame.get("brokerOrderId"))
            out({"type": "resp", "id": frame.get("id"), "ok": True, "data": {"canceled": True}})
        else:
            out(
                {
                    "type": "resp",
                    "id": frame.get("id"),
                    "ok": False,
                    "error": {"code": "BAD_TYPE", "message": f"不认识的 type：{kind}"},
                }
            )


if __name__ == "__main__":
    try:
        main()
    except (BrokenPipeError, KeyboardInterrupt):
        # Node 先走了，正常。
        sys.exit(0)
