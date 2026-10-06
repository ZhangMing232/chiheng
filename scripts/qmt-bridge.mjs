/**
 * 这个文件是干什么的：
 * QMT 桥接的 Node 侧客户端。说 stdio JSON 行协议（规格在 qmt-protocol.md）。
 * 它是**唯一**碰 Python 子进程的地方，策略代码只调这里的 request() / on()。
 *
 * 这个文件存在的理由是「故障要能被看见」：
 * 1. Python 一死，stdin 立刻 EOF —— 这是操作系统告诉你的事实，不是推测。
 *    自动化交易里「以为桥还活着其实已经死了」会直接变成重复下单或漏掉止损。
 * 2. 任何没被响应的请求都要能超时 —— Python 卡住时它不会死，
 *    也不会 EOF，只是不回话。那种情况只能靠超时。
 * 3. 事件和响应分开 —— 成交回报不对应任何请求，混在一起就分不清
 *    「等不到响应」和「收到事件」。
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

/** 请求等不到回应就放弃。Python 卡住时它不死也不说话，只能靠这个。 */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * 桥发回来的错误。用 code 而不是只给一句 message，是为了让上层能程序化判断
 * 「这条能不能重试」——TIMEOUT 和 BRIDGE_DIED 的处理方式完全不同。
 */
export class BridgeError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function createBridge(options) {
  const {
    pythonPath = "python3",
    scriptPath,
    init,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    spawnFn = spawn,
    /**
     * 传给子进程的环境变量。真桥一般不用设（QMT 的路径在 init 里给了），
     * 但假桥靠 FAKE_MODE 控制故障场景，没有这个就永远是 normal 模式——
     * 契约测试会全部变成「测了等于没测」。这个参数是给测试用的，但也可能
     * 将来要传 PYTHONPATH 之类。
     */
    env,
  } = options;

  const emitter = new EventEmitter();
  let child = null;
  let buffer = "";
  let nextId = 1;
  let alive = false;
  /**
   * 这个进程是否已经报过 fatal 了。
   *
   * 为什么不直接用 `if (!alive) return` 当守卫：**alive 只在收到 ready 之后才为 true。**
   * 桥如果在握手前就死掉（起不来、xtquant 没装、账号错），alive 还是 false，
   * 那个守卫会把 EOF 事件直接吞掉——上层于是以为一切正常，而实际上
   * 「刚启动就断」恰恰是最该立刻停手的情况。这里记的是「有没有报过」，
   * 和「现在是死是活」是两件事。
   */
  let fatalReported = false;
  /** id → { resolve, reject, timer } */
  const pending = new Map();
  /** 已经握手完成、允许下单 */
  let ready = false;

  function failAll(code, message) {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new BridgeError(code, message));
    }
    pending.clear();
  }

  /** 报一次 fatal。一个进程只报一次——EOF 和 exit 往往会先后都来。 */
  function reportFatal(code, message, extra) {
    if (fatalReported) return;
    fatalReported = true;
    alive = false;
    ready = false;
    failAll(code, message);
    emitter.emit("fatal", { message, ...extra });
  }

  function handleLine(line) {
    const text = line.trim();
    if (!text) return;
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      // Python 打了一行非 JSON 到 stdout（traceback 最常见）。
      // 不能崩——崩了就丢掉后面所有消息。记下来继续。
      emitter.emit("protocolError", new BridgeError("BAD_FRAME", `桥发来非 JSON 的一行：${text.slice(0, 200)}`));
      return;
    }

    if (frame.type === "fatal") {
      reportFatal("FATAL", frame.message || "桥进程致命错误", { traceback: frame.traceback });
      return;
    }

    if (frame.type === "ready") {
      alive = true;
      ready = true;
      emitter.emit("ready", frame);
      return;
    }

    if (frame.type === "resp") {
      const entry = pending.get(frame.id);
      if (!entry) return; // 迟到的响应，进程重启后会这样，丢掉
      clearTimeout(entry.timer);
      pending.delete(frame.id);
      if (frame.ok) entry.resolve(frame.data);
      else entry.reject(new BridgeError(frame.error?.code ?? "UNKNOWN", frame.error?.message ?? "未知错误"));
      return;
    }

    if (frame.type === "event") {
      // 连上了，但可能还没发 ready（模拟盘断言没过、xtquant 还在登录、账号被切了）。
      // 这时算「活着」但**不能交易**——这一档必须存在，否则会在中间态里
      // 误判成一切正常然后下单。
      if (frame.event === "on_connected") alive = true;
      emitter.emit(frame.event, frame.data ?? {});
      // 事件同时也广播一份，方便只想挂一个总的监听器时用
      emitter.emit("anyEvent", frame);
      return;
    }

    emitter.emit("protocolError", new BridgeError("UNKNOWN_TYPE", `收到不认识的帧类型：${frame.type}`));
  }

  function start() {
    // 重启场景（新起一个子进程）要把「已报过 fatal」清掉，否则新进程死了也不会报
    fatalReported = false;
    alive = false;
    ready = false;
    child = spawnFn(pythonPath, [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      // 不传就等于子进程完全继承不到我们这边的变量——假桥的 FAKE_MODE 就传不过去。
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      // 按行切分。最后一段留在 buffer 里等下一批。
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        handleLine(line);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => emitter.emit("stderr", String(chunk)));

    // **alive 的语义是「进程还在」，不是「能用了」。**
    // 进程一起来就是 alive=true；能不能交易是另一件事，由 ready 决定。
    // 这两个必须分开：「活着但还没握手完」是一个真实存在的中间态——
    // Python 起来了、xtquant 还在连、或者客户端手动切了账号。
    // 把它们合成一个判断，就会在这个中间态里误判成「一切正常」然后下单。
    child.on("spawn", () => {
      alive = true;
    });

    // **EOF 是最重要的一条**：Python 死了或管道关了。这里是操作系统告诉我们的，
    // 不是推测。所有在等的请求全部失败，ready 置 false —— 上层据此停止开仓。
    // 注意不设「必须曾经 ready 过」的守卫：启动期就断掉也必须报（见 fatalReported）。
    child.stdout.on("end", () => {
      reportFatal("BRIDGE_DIED", "桥进程没了（stdin EOF）。所有在等的请求都作废，停止开仓。");
    });

    child.on("exit", (code, signal) => {
      reportFatal("BRIDGE_DIED", `桥进程退出（code=${code} signal=${signal}）`, { code, signal });
    });

    child.on("error", (err) => {
      reportFatal("SPAWN_FAILED", `起不来桥进程：${err.message}`);
    });

    // 握手必须是第一条
    child.stdin.write(`${JSON.stringify({ type: "init", ...init })}\n`);
    return api;
  }

  /**
   * 发一帧并等它的响应。query / order / cancel 三种帧都走这里，只是 type 不同。
   * **不要用 request() 硬编码 type:"query" 去发报单**——对面会当成不认识的 op
   * （这个坑契约测试抓到过：报单发出去，对面回「不认识的 op：order」）。
   */
  function send(frameType, payload, timeout) {
    if (!child || !alive) {
      return Promise.reject(new BridgeError("BRIDGE_DIED", "桥不可用，发不了请求"));
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        // 超时要紧盯：Python 卡住时它不死也不 EOF。超时的单**状态不明**，
        // 上层必须当 unknown 处理、去券商查，不能当成失败就重报。
        reject(new BridgeError("TIMEOUT", `请求 ${payload.op ?? frameType} 等了 ${timeout}ms 没回应，状态不明`));
      }, timeout ?? timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ type: frameType, id, ...payload })}\n`);
    });
  }

  function request(op, payload = {}, timeout = timeoutMs) {
    return send("query", { op, ...payload }, timeout);
  }

  /**
   * 报单。**落盘顺序在调用方**：先 appendOrder(status=draft) 再调这里，
   * 拿到 brokerOrderId 之后再 appendOrder(status=pending)。
   * 反过来做的话，崩在中间重启会重复下单——这是整套东西最关键的一个顺序。
   */
  function order(payload, timeout = timeoutMs) {
    if (!alive || !ready) {
      return Promise.reject(new BridgeError("NOT_READY", "桥还没握手完，不许下单"));
    }
    return send("order", payload, timeout);
  }

  function cancel(brokerOrderId, timeout = timeoutMs) {
    return send("cancel", { brokerOrderId }, timeout);
  }

  const api = {
    start,
    request,
    order,
    cancel,
    on: (event, handler) => {
      emitter.on(event, handler);
      return () => emitter.off(event, handler);
    },
    /** 桥是否还活着。false 时一律不许开新仓。 */
    isAlive: () => alive,
    /** 是否握手完成、允许下单。比 isAlive 严：活着但没握手完也不能下单。 */
    canTrade: () => alive && ready,
    /** 测试用：直接塞一帧进去，模拟 Python 那边发来的东西。 */
    _inject: handleLine,
    /** 测试用：模拟 Python 死了。 */
    _kill: () => {
      alive = false;
      ready = false;
      child?.stdout?.emit("end");
    },
    stop() {
      alive = false;
      ready = false;
      failAll("STOPPED", "桥被主动停掉");
      try {
        child?.stdin?.end();
      } catch {
        // 管道已经断了，没什么可做的
      }
      child?.kill();
    },
  };
  return api;
}
