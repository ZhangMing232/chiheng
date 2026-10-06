# QMT 桥接协议

Node（策略侧，macOS 开发 / Windows 运行）和 Python（唯一碰 xtquant 的地方）之间
用 **stdin/stdout 传 JSON 行**说话。不走 HTTP、不走 socket。

## 为什么是管道，不是 HTTP

1. **Python 一死，Node 的 stdin 立刻 EOF。** 比任何心跳都可靠——
   心跳是「一段时间没收到就当它死了」，而 EOF 是操作系统告诉你的事实。
   自动化交易里「以为桥还活着其实已经死了」会直接变成重复下单或漏掉止损。
2. HTTP 要处理端口占用、防火墙、超时、重连，每一项都是额外故障模式。
3. 成交回报是 Python 主动推的。HTTP 下要么轮询、要么再开一条反向通道，
   两条路都会引入「消息到了但我以为没到」的问题。

## 一帧一行

每帧是一个 JSON 对象，`\n` 结尾。**不许有换行 inside**（值里的换行必须转义成 `\n`）。
理由：按行切分是最简单也最不容易错的做法，加个 TCP 分包/粘包处理只会增加出错面。

---

## Node → Python（写 stdin）

### 握手（必须是第一条）

```jsonc
{"type":"init","sessionId":"chiheng-1","userdataPath":"D:\\QMT\\userdata_mini",
 "accountId":"<资金账号>","accountType":"STOCK","expectedTotalAsset":1000000}
```

`expectedTotalAsset` 是**模拟盘断言**：Python 连上后查一次资产，对不上就自己退出并
发 fatal。理由见下面「模拟盘/实盘怎么区分」。

### 查询

```jsonc
{"type":"query","id":7,"op":"positions"}
{"type":"query","id":8,"op":"asset"}
{"type":"query","id":9,"op":"orders"}
{"type":"query","id":10,"op":"quotes","codes":["sh600000","sz000001"]}
```

### 报单

```jsonc
{"type":"order","id":11,"code":"sh600000","side":"buy","volume":100,
 "orderType":"limit","price":12.34,
 "signalKey":"2026-10-08:rebound:sh600000:12.34:open",
 "clientOrderId":"<uuid>","strategyName":"chiheng_rebound"}
```

`clientOrderId` 塞进 xtquant 的 `order_remark`（最多 20 字符，用短 uuid）。
**这是崩溃恢复的关键**：报单返回的是数字 order_id，不保证跨进程唯一，
所以重启后要靠 clientOrderId 去券商侧反查这单到底报出去没有。

### 撤单

```jsonc
{"type":"cancel","id":12,"brokerOrderId":123456}
```

---

## Python → Node（写 stdout）

### 握手结果与连接事件

```jsonc
{"type":"ready","connected":true,"accountId":"<id>","asset":{"cash":1000000,"frozenCash":0,"marketValue":0,"totalAsset":1000000}}
{"type":"event","event":"on_connected"}
{"type":"event","event":"on_disconnected","reason":"<xtquant 的错误码>"}
```

### 请求响应（用 `id` 关联）

```jsonc
{"type":"resp","id":7,"ok":true,"data":{"positions":[...]}}
{"type":"resp","id":10,"ok":true,"data":{"quotes":{"sh600000":{"lastPrice":12.50,"lastClose":12.40,"limitUp":13.64,"limitDown":11.16,"volume":1234567,"amount":15400000.0}}}}
{"type":"resp","id":11,"ok":true,"data":{"brokerOrderId":123456,"clientOrderId":"<uuid>"}}
{"type":"resp","id":11,"ok":false,"error":{"code":"ORDER_REJECTED","message":"超出可用资金"}}
```

**quotes 必须同时给 `lastPrice` 和 `lastClose`。** 项目的昨收是
`price / (1 + chg/100)` 算出来的，混用两个源的 price 和 chg 会算出错的昨收，
**静默产生错误下单**。桥接层给 QMT 的 lastClose 就是为了避免这个。

### 异步事件（不对应任何请求）

```jsonc
{"type":"event","event":"on_stock_order","data":{"brokerOrderId":123456,"code":"sh600000","orderStatus":50,"orderVolume":100,"tradedVolume":0}}
{"type":"event","event":"on_stock_trade","data":{"tradedId":8899,"brokerOrderId":123456,"code":"sh600000","tradedPrice":12.34,"tradedVolume":100,"tradedAmount":1234.0}}
{"type":"event","event":"on_order_error","data":{"brokerOrderId":123456,"errorCode":51,"errorMsg":"废单"}}
{"type":"event","event":"on_account_status","data":{"cash":999000,"marketValue":12340}}
```

### 致命错误

```jsonc
{"type":"fatal","message":"xtquant 未安装","traceback":"..."}
```

发完这行 Python 立刻 `sys.exit(1)`。**Node 看到 `fatal` 或 stdin EOF 就知道整个桥死了**，
必须停止开仓。

---

## 三条约定

1. **响应带 `id` 关联请求，事件不带。** 订单和成交回报是异步的，不会对应任何请求。
   混在一起会导致「等不到响应」和「收到事件」分不清。
2. **错误是结构化的**（`error.code` + `error.message`），不是字符串。
   字符串没法程序化判断，只能给人看。
3. **`fatal` 单独一类。** 它不是某次请求失败，是整个桥不可用了。这两件事的处理方式
   完全不同：前者可以重试那一条，后者必须停手。

---

## 模拟盘 / 实盘怎么区分

**`xtquant` 没有 API 能读出当前是模拟盘还是实盘。** 所以：

1. 代码里写死 `const TRADING_MODE = "paper"`（切实盘要改代码 + 重启，故意加摩擦）
2. **启动时查一次 total_asset，和握手的 `expectedTotalAsset` 比。超过 2 倍就退出。**
   这条是真正有效的——它不依赖代码，只依赖账户实际状态。
3. **下单前再查一次 asset**，数量级不符就中止本轮。
4. 模拟盘和实盘**必须用不同的 QMT userdata 目录**，启动时检查路径。

光靠代码里的 `paperOnly: true` 挡不住在 QMT 客户端上手动切到实盘。
