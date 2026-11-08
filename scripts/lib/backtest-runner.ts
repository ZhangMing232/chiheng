/**
 * 批量评价脚本共用的回测执行器。
 *
 * 为什么要抽出来（2026-11-08 全量体检发现）：eval-robust / eval-regime /
 * eval-event / diag-offset1 四个脚本各写了一份 spawn，全都有同一个假成功漏洞：
 *   1. 没清旧 dump —— 本轮回测若退出 0 但没写 dump（或被环境覆盖），会读到
 *      上一次残留的文件，当成这轮的结果；
 *   2. 没有 child.on("error") —— spawn 本身失败（ENOENT 等）时 Promise 永远悬着；
 *   3. 不校验 dump 内容 —— trades 为 {} 或策略 key 缺失时静默产出空结果，
 *      违反「拿不到 ≠ 没有」。例如 BT_EVENT 没生效时 eval-event 会用 `?? []`
 *      把「策略没注册」变成「0 笔样本」，报告照常打印「完成」。
 *
 * 这里统一：先删旧 dump → spawn → error/exit 都处理 → 校验 trades 非空、
 * 期望的策略 key 都在、总笔数 > 0（允许单个策略在某切片 0 笔，那是真结果）。
 */
import { spawn } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";

export type DumpTrade = { ret?: number; bench?: number; exitDate?: string; id?: string; date?: string };
export type Dump = { trades: Record<string, DumpTrade[]> };

export type RunOpts = {
  /** 本次回测的 BT_DUMP 路径（会先删除，杜绝旧文件）。 */
  dumpPath: string;
  /** 打印用标签，出错时带上，方便定位是哪个切片。 */
  label: string;
  /** 额外环境变量（BT_SAMPLE / BT_HALF / BT_OFFSET / BT_FILTER 等）。值传 "" 表示删除该变量。 */
  env?: Record<string, string>;
  /** 需要从环境里彻底删掉的变量名（例如关过滤器时要删 BT_AVOID_LHB）。 */
  unsetEnv?: string[];
  /** 期望 dump.trades 里必须存在的策略 key（例如 BT_EVENT 的 5 套事件策略）。 */
  expectKeys?: string[];
  /** 是否允许「所有策略都 0 笔」（默认 false：总笔数为 0 视为回测没跑对）。 */
  allowEmpty?: boolean;
};

export function runBacktestSlice(opts: RunOpts): Promise<Dump> {
  const { dumpPath, label, env = {}, expectKeys = [], allowEmpty = false, unsetEnv = [] } = opts;
  return new Promise((resolve, reject) => {
    // spawn 前先删旧 dump（异步删完再启动，避免和写入竞态）
    void (async () => {
      await unlink(dumpPath).catch(() => {});
      const merged: Record<string, string | undefined> = {
        ...process.env,
        NODE_OPTIONS: "",        // 沙箱注入的 language shim 会卡外网出口
        BT_NO_LOG: "1",          // 批量跑不污染 runs.jsonl
        BT_COSTCOMPARE: "0",     // 省一半时间
        ...env,
        BT_DUMP: dumpPath,       // 放最后，不许调用方覆盖
      };
      for (const k of unsetEnv) delete merged[k];
      const childEnv = merged as Record<string, string>;
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", "--import", "./scripts/alias.mjs", "scripts/backtest.ts"],
        { env: childEnv, stdio: "ignore" },
      );
      let settled = false;
      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        reject(e);
      };
      // spawn 自身失败（命令不存在、权限等）——原来四个脚本都漏了，会让 Promise 永远挂着
      child.on("error", (e) => fail(new Error(label + " 回测进程启动失败：" + e.message)));
      child.on("exit", async (code, signal) => {
        if (settled) return;
        if (code !== 0) {
          fail(new Error(label + " 回测退出码 " + code + (signal ? " signal=" + signal : "")));
          return;
        }
        let dump: Dump;
        try {
          dump = JSON.parse(await readFile(dumpPath, "utf8")) as Dump;
        } catch (e) {
          fail(new Error(label + " dump 读不到或不是合法 JSON（回测可能没写 dump）：" + String(e)));
          return;
        }
        if (!dump || typeof dump.trades !== "object" || dump.trades == null) {
          fail(new Error(label + " dump 缺 trades 字段"));
          return;
        }
        const keys = Object.keys(dump.trades);
        if (keys.length === 0) {
          fail(new Error(label + " dump.trades 是空对象，回测没有产出任何策略"));
          return;
        }
        const missing = expectKeys.filter((k) => !Array.isArray(dump.trades[k]));
        if (missing.length > 0) {
          fail(new Error(label + " dump 缺策略 key：" + missing.join(", ") + "（检查 BT_EVENT 等开关是否生效）"));
          return;
        }
        const total = keys.reduce((s, k) => s + (dump.trades[k]?.length ?? 0), 0);
        if (!allowEmpty && total === 0) {
          fail(new Error(label + " 所有策略共 0 笔成交，视为回测没跑对"));
          return;
        }
        settled = true;
        resolve(dump);
      });
    })();
  });
}
