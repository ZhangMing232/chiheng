/**
 * 这个文件是干什么的：
 * 从界面触发一轮因子检验回测（scripts/backtest.ts 的 BT_FACTOR 分支），
 * 把命令行的环境变量参数（BT_N/BT_BUCKETS/BT_SAMPLE/BT_OFFSET）变成页面上的
 * 控件——参数化了就不靠记命令，跑完页面自动刷新出新批次。
 *
 * 你需要知道的：
 * 1. **只读判据，只调参数**：因子注册表和 6 关判据在代码里预登记，这个执行器
 *    一个都不许动——界面能调的只有「持有几天 / 分几档 / 抽几只 / 换哪批样本」
 *    这四个采样参数。禁调参过关的纪律管的是阈值，不是采样参数。
 * 2. 进程锁：一次只许跑一个。开发服务器单进程，模块级布尔够用；服务器重启
 *    锁自动释放，不会卡死。
 * 3. 回测自己会落盘：factor-runs.jsonl 追加一批 + 待验队列回写，和命令行跑
 *    一字不差。这里只负责等它跑完、把输出尾部带回去给页面看。
 * 4. spawn 用动态 import——本模块会被前端 import（PARAM_BOUNDS 给参数控件用），
 *    顶层不许出现 node: 内置模块。
 */

/** 界面可调的四采样参数 + 各自的合法范围（越界直接拒，不夹带私货）。 */
export type FactorTestParams = {
  /** 持有天数 BT_N。 */
  n: number;
  /** 分档数 BT_BUCKETS。 */
  buckets: number;
  /** 抽样只数 BT_SAMPLE。 */
  sample: number;
  /** 换样本起点 BT_OFFSET。 */
  offset: number;
};

export const PARAM_BOUNDS = {
  n: { min: 1, max: 60, options: [1, 3, 5, 10, 20] },
  buckets: { min: 3, max: 10, options: [3, 5, 10] },
  sample: { min: 50, max: 800, options: [100, 300, 500] },
  offset: { min: 0, max: 9, options: [0, 1, 2] },
} as const;

/** 校验参数：不在选项里但落在范围内的也放行（范围是硬边界，选项只是快捷档）。 */
export function sanitizeParams(raw: unknown): FactorTestParams {
  const pick = (key: keyof FactorTestParams): number => {
    const v = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)[key] : undefined;
    return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : NaN;
  };
  const out = { n: pick("n"), buckets: pick("buckets"), sample: pick("sample"), offset: pick("offset") };
  for (const key of Object.keys(PARAM_BOUNDS) as (keyof FactorTestParams)[]) {
    const b = PARAM_BOUNDS[key];
    if (!Number.isFinite(out[key]) || out[key] < b.min || out[key] > b.max) {
      throw new Error(`参数 ${key} 必须在 ${b.min}~${b.max} 之间，收到 ${String((raw as Record<string, unknown>)?.[key])}`);
    }
  }
  return out;
}

export type FactorTestResult = {
  ok: boolean;
  ms: number;
  /** 子进程输出尾部（成功给统计头，失败给报错尾巴），页面原样展示。 */
  tail: string;
};

let running = false;

/** 跑一次 BT_FACTOR 检验。并发调用直接拒——两次同时写 factor-runs.jsonl 会乱。 */
export async function runFactorTest(params: FactorTestParams): Promise<FactorTestResult> {
  if (running) throw new Error("已经有一轮检验在跑，等它跑完再发起");
  running = true;
  const started = Date.now();
  try {
    const { code, stdout, stderr } = await spawnNode(["--experimental-strip-types", "--import", "./scripts/alias.mjs", "scripts/backtest.ts"], {
      BT_FACTOR: "1",
      BT_N: String(params.n),
      BT_BUCKETS: String(params.buckets),
      BT_SAMPLE: String(params.sample),
      BT_OFFSET: String(params.offset),
    });
    const merged = (stdout + "\n" + stderr).trim().split("\n").filter(Boolean);
    // 输出里进度行很多，只带尾部——成功时最后几行是统计摘要，失败时是报错。
    const tail = merged.slice(-12).join("\n");
    return { ok: code === 0, ms: Date.now() - started, tail };
  } finally {
    running = false;
  }
}

/** spawn node 子进程并收完输出。超时 15 分钟：样本 800 只 + 冷缓存的极端情况。 */
async function spawnNode(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("检验回测超时（15 分钟）——样本太大或网络卡住，去日志查"));
    }, 15 * 60 * 1000);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
