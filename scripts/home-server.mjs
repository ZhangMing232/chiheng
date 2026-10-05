/**
 * 这个文件是干什么的：
 * Mac 上把赤轨跑起来的进程：打开本机网页，并按时启动纸面记账。
 *
 * 你需要知道的：
 * 登录这台 Mac 之后，由安装好的自启项拉起来；双击赤轨.app 时如果服务没开，也会再拉一次。
 * 启动时立刻记一次账，之后大约每分钟再记一次，直到你把服务停掉。
 * 网页默认在本机 8787 端口。同一局域网可以用这台电脑的 IP 加端口打开。
 * 还没构建过会直接退出，并提示先执行 npm install && npm run build:mac。
 * 记账只把纸面买卖写进 data/books，不会向券商下真实委托。日常选股不用改这里。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const entry = ".output/server/index.mjs";
if (!existsSync(entry)) {
  console.error("还没有本机构建。在项目目录运行：npm install && npm run build:mac");
  process.exit(1);
}

const port = process.env.PORT ?? "8787";
const host = process.env.HOST ?? "0.0.0.0";

let recording = false;
function record() {
  // 上一次记账还没跑完就跳过这一分钟，避免两个进程读到同一份旧账、
  // 各自把同一只股票再记一遍（读-改-写竞争）。
  if (recording) return;
  recording = true;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--import", "./scripts/alias.mjs", "scripts/record-journal.ts"], {
    stdio: "inherit",
  });
  child.on("exit", (code) => {
    recording = false;
    if (code) console.error(`record-journal exited ${code}`);
  });
}

record();
const timer = setInterval(record, 60_000);

/**
 * 拉起真正的网页服务，并在它意外退出时再拉一次。
 *
 * 为什么要这层：服务进程会因为各种意料之外的原因没掉——有人（或某个清理动作）
 * 给它发了停止信号、node 自己崩了、固件更新后进程被收走。没有这层，一次意外
 * 之后 8787 就一直空着，盘中的记账也跟着停，而没人会知道。
 * 外层只要还活着，就把它重新拉起来；跑稳超过一分钟就把失败计数清零，
 * 免得一次偶发退出让退避时间越滚越长。
 */
let stopping = false;
let failures = 0;

function clock() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
}

function spawnServer() {
  const startedAt = Date.now();
  const child = spawn(process.execPath, [entry], {
    stdio: "inherit",
    env: { ...process.env, PORT: port, HOST: host, NITRO_PORT: port, NITRO_HOST: host },
  });
  child.on("exit", (code, signal) => {
    if (stopping) return;
    // 「起来不到一分钟就死」和「跑了一阵才掉」要分开看：
    // 前者是它根本起不来（端口被占、构建坏了、node 读不到文件），再拉一万次也一样，
    // 而且日志会被刷满、旁边还留着一个进程假装在守着——实测就是 8787 一直空着、
    // 页面打不开，却有个进程每隔一分钟说「重新拉起」。
    // 所以连续三次起不来就放弃，把原因说清楚，让人去处理，而不是装死。
    if (Date.now() - startedAt < 60_000) {
      failures += 1;
      if (failures >= 3) {
        console.error(
          `${clock()} 服务连续 ${failures} 次没起来就退出（最后一次：${code != null ? `退出码 ${code}` : `信号 ${signal ?? "未知"}`}）。` +
            `上面几行是原因。修好之前 8787 是空的，别当成还在跑。`,
        );
        clearInterval(timer);
        process.exit(1);
      }
    } else {
      failures = 0;
    }
    const wait = Math.min(60, 5 * Math.max(1, failures));
    const why = code != null ? `退出码 ${code}` : `信号 ${signal ?? "未知"}`;
    console.log(`${clock()} 服务进程没了（${why}），${wait} 秒后重新拉起`);
    setTimeout(spawnServer, wait * 1000);
  });
  return child;
}

let server = spawnServer();

let shuttingDown = false;
function shutdown() {
  // 收到停止信号就把自己也带走。早先这里只 kill 子进程、自己不退出，
  // 于是留下一个「以为自己在守着、其实端口已经空了」的进程——
  // 2026-10-05 下午 8787 打不开、日志却在刷「重新拉起」，就是这么来的。
  if (shuttingDown) {
    server.kill("SIGKILL");
    process.exit(1);
  }
  shuttingDown = true;
  stopping = true;
  clearInterval(timer);
  // 子进程会自己打印 "Stopping server gracefully" 并等 5 秒；
  // 到点还没走就强杀。它先退出的话我们跟着退出，不留残骸。
  const hard = setTimeout(() => {
    server.kill("SIGKILL");
    process.exit(0);
  }, 6000);
  server.once("exit", () => {
    clearTimeout(hard);
    process.exit(0);
  });
  server.kill("SIGTERM");
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);

console.log(`赤轨在本机 ${host}:${port} 上提供访问。同一局域网用这台电脑的 IP 加端口打开。`);
