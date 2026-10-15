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
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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
 * 收盘后自选告警（A4 编排层）。
 *
 * 对标 Vibe-Research 的 notify.ts：到点跑任务 → 结果进收件箱。它的三条纪律照搬：
 *   1. 只在本程序运行时生效（服务没起就不会跑，界面上要原样说明）
 *   2. 门判定取不到时不跑（行情拉不到，run-alerts.ts 里留说明不产告警）
 *   3. 一天一次 + 24 小时去重（按本地日期记 ranDay，告警 id 带日期）
 *
 * 为什么挂在记账循环旁边：两个都是「服务活着才跑」的本机定时任务，
 * 复用同一个 60 秒心跳最省事，不必再装一个定时器。
 */
let alertRanDay = "";
function runAlerts() {
  const day = new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD 本地日期
  if (alertRanDay === day) return; // 一天一次
  const hour = new Date().getHours();
  if (hour < 15) return; // 没到收盘后不跑（告警是收盘核对）
  alertRanDay = day;
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--import", "./scripts/alias.mjs", "scripts/run-alerts.ts"],
    { stdio: "inherit" },
  );
  child.on("exit", (code) => {
    if (code) console.error(`run-alerts exited ${code}（今天的自选告警没跑成，收件箱里会有说明）`);
  });
}
runAlerts();
const alertTimer = setInterval(runAlerts, 60_000);

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
  // dev 模式起 vite dev（改 src 秒级热更新，不用 build）；默认起构建产物 .output。
  const dev = process.argv.includes("--dev");
  const child = dev
    ? spawn(process.execPath, [join("scripts", "with-app-env.mjs"), "vite", "dev", "--host", host, "--port", port], {
        stdio: "inherit",
        env: { ...process.env },
      })
    : spawn(process.execPath, [entry], {
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

/**
 * 起服务之前先探端口。2026-10-14 连着栽了两次：19:00 那个 serve 还在跑，
 * 又开一个 `npm run serve`，子进程因端口被占立刻退出，而日志只写「退出码 0」——
 * 看不出是端口冲突，白排查。探一下，被占就说清楚，并且**不再重试**
 * （重试没意义：占着端口的那个不退，重试一百次也起不来）。
 */
async function portFree(port) {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: Number(port) });
    socket.setTimeout(1500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(false); // 连上了 = 有人占着
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(true)); // 没人听 = 空着
  });
}

let server = null;


async function main() {
  const free = await portFree(port);
  if (!free) {
    console.log(
      `${clock()} 端口 ${port} 已经被占用了——多半是另一个 serve 已经在跑。` +
        `先把它停掉（在它的窗口按 Ctrl-C），或者直接用浏览器开 http://127.0.0.1:${port} 看看是不是已经能开。` +
        `不重试：占着端口的进程不退，重试多少次都一样。`,
    );
    // 记账和告警是另一套（直接读 src，不走 .output），所以这里退出不影响它们
    process.exit(0);
  }
  server = spawnServer();
}

main();

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
  clearInterval(alertTimer);
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

/**
 * 检查源码是不是比构建产物新。
 *
 * 「改了 src 忘了 build」这件事 2026-10-05 坑了三回：页面显示的还是旧逻辑，
 * 而两边都没人提这件事，只能靠人肉对比文件时间。这里把它变成启动时的一条明确提醒。
 *
 * 注意方向：src 比 .output 新 = 该 rebuild 了；反过来（构建更新）不用管。
 */
function newestMtime(dir) {
  let newest = 0;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let info;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) newest = Math.max(newest, newestMtime(full));
    else newest = Math.max(newest, info.mtimeMs);
  }
  return newest;
}

function warnIfStaleBuild() {
  try {
    const builtAt = statSync(".output").mtimeMs;
    const srcAt = newestMtime("src");
    if (srcAt > builtAt) {
      const mins = Math.round((srcAt - builtAt) / 60000);
      console.warn(
        `[build] src 里的代码比 .output 新 ${mins} 分钟——页面跑的是旧逻辑。` +
          `改完服务端代码要跑 npm run build:mac 才会更新；` +
          `（记账脚本直接读 src，不受影响。）`,
      );
    }
  } catch {
    // 读不到就当没事，别因为这个检查把服务卡住
  }
}

/**
 * 检查自己是不是在服务一份「比自己老」的构建。
 *
 * 这个失败模式比「逻辑旧了」严重得多：Nitro 把静态资源清单**编译进产物**
 * （`public_assets_data_*`），进程启动时读进内存。构建换了新产物之后，
 * 磁盘上的文件名带了新哈希，而内存里还是旧的，于是 /assets/ 下**每一个**
 * 都 404——页面照常渲染出内容，但一点样式都没有，看着像 CSS 坏了。
 * （2026-10-05 实测：public/ 根下的 favicon、logo 正常，只有 /assets/ 全挂。）
 *
 * 所以拿 .output 的时间跟进程启动时间比：产物比进程新，就是在服务旧清单，
 * 明确告诉人重启。
 */
function warnIfSelfIsStale() {
  try {
    const builtAt = statSync(".output").mtimeMs;
    const startedAt = Date.now() - Math.round(process.uptime() * 1000);
    if (builtAt > startedAt) {
      const mins = Math.round((builtAt - startedAt) / 60000);
      console.warn(
        `[build] 现在这份 .output 是 ${mins} 分钟前构建的，晚于本进程启动时间——` +
          `静态资源清单是启动时读进内存的，所以 /assets/ 下的文件会全部 404，` +
          `页面会渲染出内容但没有任何样式。` +
          `请停掉本进程重新跑一次 npm run serve。`,
      );
    }
  } catch {
    // 同上，读不到就当没事
  }
}

if (!process.argv.includes("--dev")) warnIfStaleBuild();
warnIfSelfIsStale();
if (process.argv.includes("--dev")) {
  console.log(
    `${clock()} dev 模式：改完 src 网页会自动热更新，不用 npm run build:mac。` +
      `记账和告警照跑（它们直接读 src）。正式部署前才需要 build。`,
  );
}
console.log(`赤轨在本机 ${host}:${port} 上提供访问。同一局域网用这台电脑的 IP 加端口打开。`);
