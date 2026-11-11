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

import { spawn, execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = ".output/server/index.mjs";
if (!existsSync(entry)) {
  console.error("还没有本机构建。在项目目录运行：npm install && npm run build:mac");
  process.exit(1);
}

const port = process.env.PORT ?? "8787";
const host = process.env.HOST ?? "0.0.0.0";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PID_FILE = join(ROOT, "data", "serve.pid");

/**
 * 周末和法定假日都休市。信号三件套（生成/审核/跟踪）和 K 线刷新、回测判决
 * 都不该在非交易日跑——2026-11-01（周日）实测 generate/review 照跑、照给主人
 * 推「今日信号」，就是缺了这个闸。
 *
 * ⚠️ 假日表要和 src/lib/market/session.ts 的 HOLIDAYS 保持同步——那边是唯一定义处，
 * 这里复制一份是因为 home-server 是纯 .mjs、不能 import TS。加新一年的假日时两处都改。
 * 必须放在文件靠前的位置：runAlerts() 在启动时就调用，会用到 isMarketOpen。
 */
const MARKET_HOLIDAYS = new Set([
  "2026-01-01", "2026-01-02", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20", "2026-02-23",
  "2026-04-06", "2026-05-01", "2026-05-04", "2026-05-05", "2026-06-19", "2026-09-25",
  "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07",
  "2027-01-01", "2027-02-05", "2027-02-08", "2027-02-09", "2027-02-10", "2027-02-11", "2027-02-12",
  "2027-04-05", "2027-05-03", "2027-05-04", "2027-05-05", "2027-06-09", "2027-09-15",
  "2027-10-01", "2027-10-04", "2027-10-05", "2027-10-06", "2027-10-07",
]);

function isMarketOpen(day) {
  if (MARKET_HOLIDAYS.has(day)) return false;
  // 12:00+08:00 = 04:00 UTC，getUTCDay 得到的就是上海星期几
  const wd = new Date(`${day}T12:00:00+08:00`).getUTCDay();
  return wd !== 0 && wd !== 6; // 0=周日 6=周六
}

/**
 * 只保证「同一台机器上只有一个赤轨 serve」在 8787 上。
 *
 * 以前的问题：旧 serve 没退干净（launchd 重拉、赤轨.app 又拉一次、手动起第二个），
 * 新 serve 一探端口被占就直接退出、留一句「端口被占用」——结果就是 8787 还活着、
 * 但偶尔会多出一个被 vite 自动加一的 8790，看着像「两个端口」。
 * 这里改成：启动先按 pidfile + 端口把**自己的**旧实例（含它没带走的 vite/nitro 子进程）
 * 找出来杀掉，再绑定 8787。只有 8787 被**不认识的进程**占着时才退让并报警，
 * 绝不擅自动别人的端口。
 */
function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function isOurServe(pid) {
  if (!isAlive(pid)) return false;
  try {
    const cmd = execFileSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" });
    return /home-server\.mjs|with-app-env\.mjs|vite|\.output\/server|server\/index\.mjs/.test(cmd);
  } catch { return false; }
}
async function killTree(pid) {
  try { process.kill(pid, "SIGTERM"); } catch { /* 进程已退出，没东西可杀 */ }
  for (let i = 0; i < 50; i++) {
    if (!isAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* 同上，已退出 */ }
}
function parentOf(pid) {
  try { return Number(execFileSync("ps", ["-p", String(pid), "-o", "ppid="], { encoding: "utf8" }).trim()); } catch { return NaN; }
}
async function ensureSoleInstance() {
  mkdirSync(dirname(PID_FILE), { recursive: true });
  // 1) pidfile 指向的旧外层 serve（它本身不监听 8787，lsof 找不到，只能靠 pidfile）
  const pid = (() => { try { return Number(readFileSync(PID_FILE, "utf8").trim()); } catch { return NaN; } })();
  if (Number.isFinite(pid) && pid !== process.pid && isOurServe(pid)) await killTree(pid);
  // 2) 真正占着 8787 的是 vite/nitro 子进程：连它的外层一起清掉，
  //    否则外层（supervisor）会立刻又拉一个起来，端口还是抢不到。
  try {
    const holders = execFileSync("lsof", ["-iTCP:" + port, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n !== process.pid);
    for (const h of holders) {
      if (!isOurServe(h)) continue;
      const ppid = parentOf(h);
      if (Number.isFinite(ppid) && ppid !== process.pid && isOurServe(ppid)) {
        try { process.kill(ppid, "SIGTERM"); } catch { /* 外层已不在 */ } // 让外层自己干净地退出（它会顺带带走子进程）
      }
      try { process.kill(h, "SIGKILL"); } catch { /* 已退出 */ } // 立刻释放 8787，不等外层慢吞吞收尾
    }
    if (holders.length) await new Promise((r) => setTimeout(r, 500));
  } catch { /* lsof 探不到监听者 = 没有要清的 */ }
}

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
  if (!isMarketOpen(day)) return; // 周末/假日休市，告警不跑
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
 * 每日信号：收盘后生成候选 → 竞价后审核 → 页面可见。
 * 同 runAlerts 的模式：60 秒心跳 + 日期去重。
 * 三步独立：K 线刷新 15:10 → 信号生成 15:30 → 竞价审核 9:26（次日竞价）。
 *
 * **去重必须跨重启**：内存里的 ranDay 在服务重启（包括每次 build:mac）就清零，
 * 于是 15:05 之后每重启一次就重扫一遍、重复推一条；审核更糟——重启后重跑会把
 * 收盘价当竞价价写回 reviewed.json。所以除了内存标记，还要拿**已产出的文件**当证据：
 * candidates.json 的 date 是我今天写的、reviewed.json 的 date 是今天，就不再跑。
 */
let signalGenRanDay = "";
let signalReviewRanDay = "";
let klineRefreshRanDay = "";
let strategyVerdictRanDay = "";

/** 读 data/signals 下某个 json 的某个字段；文件不在 / 格式坏一律当「没有」。 */
function readSignalField(file, field) {
  try {
    const raw = readFileSync(join(process.cwd(), "data", "signals", file), "utf8");
    const parsed = JSON.parse(raw);
    const v = parsed?.[field];
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/**
 * 收盘后全量刷新 K 线缓存。15:10 跑（收盘 10 分钟，腾讯日线已落定），
 * 让 15:30 的信号生成读到的是当天收盘，而不是上一次手动跑全池回测那天。
 *
 * 去重只用内存标记 + 幂等：脚本自身会按「最后 K 线早于最新交易日才重抓」，
 * 重启后即使重跑一次，也只是一轮轻量的「读文件比日期」no-op，不会重复拉数据。
 */
function runKlineRefresh() {
  const day = new Date().toLocaleDateString("sv-SE");
  if (klineRefreshRanDay === day) return;
  if (!isMarketOpen(day)) return; // 休市不刷（没有新 K 线）
  const hour = new Date().getHours();
  const min = new Date().getMinutes();
  if (hour < 15 || (hour === 15 && min < 10)) return; // 15:10 后
  klineRefreshRanDay = day;
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--import", "./scripts/alias.mjs", "scripts/refresh-kline.ts"],
    { stdio: "inherit" },
  );
  child.on("exit", (code) => {
    if (code) console.error("K 线刷新失败，信号生成会退回到旧缓存");
  });
}

/**
 * 收盘后刷新全池回测判决（data/strategy-verdicts.json）。15:15 跑（K 线刷新之后），
 * 供策略闸门读：线上 13 天样本测不出慢亏，回测 250 天信噪比才有统计功效。
 * 幂等：跑失败保留上一份判决文件。
 */
function runStrategyVerdict() {
  const day = new Date().toLocaleDateString("sv-SE");
  if (strategyVerdictRanDay === day) return;
  if (!isMarketOpen(day)) return; // 休市不跑回测（数据没变）
  const hour = new Date().getHours();
  const min = new Date().getMinutes();
  if (hour < 15 || (hour === 15 && min < 15)) return; // 15:15 后
  strategyVerdictRanDay = day;
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--import", "./scripts/alias.mjs", "scripts/strategy-verdict.ts"],
    { stdio: "inherit" },
  );
  child.on("exit", (code) => {
    if (code) console.error("回测判决刷新失败，策略闸门沿用上一份 verdict");
  });
}

function runSignalGen() {
  const day = new Date().toLocaleDateString("sv-SE");
  if (signalGenRanDay === day) return;
  if (!isMarketOpen(day)) return; // 休市不生成信号
  const hour = new Date().getHours();
  const min = new Date().getMinutes();
  if (hour < 15 || (hour === 15 && min < 30)) return; // 15:30 后跑，等 15:10 的 K 线刷新完成
  // 跨重启去重：今天已经写过候选文件就别再扫一遍（否则每重启一次多推一条）
  if (readSignalField("candidates.json", "date") === day) {
    signalGenRanDay = day;
    return;
  }
  signalGenRanDay = day;
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--import", "./scripts/alias.mjs", "scripts/generate-signals.ts"],
    { stdio: "inherit" },
  );
  child.on("exit", (code) => {
    if (code) console.error("信号生成失败，明天开盘前再补跑");
  });
}

/**
 * 上一次跑到哪天了 / 是不是正在跑。
 *
 * 去重标记**只在子进程成功退出后**才落，而且另开一个 running 标记挡住重入——
 * 以前是「spawn 之前就落标记」，跑挂了当天也不会再试，静默丢一天的审核。
 */
let signalReviewRunning = false;

function runSignalReview() {
  const day = new Date().toLocaleDateString("sv-SE");
  if (signalReviewRanDay === day || signalReviewRunning) return;
  if (!isMarketOpen(day)) return; // 休市无竞价，不审核
  const now = new Date();
  const hour = now.getHours();
  const min = now.getMinutes();
  // 只在 9:26~11:59 之间跑。
  // 早于 9:26：集合竞价还没出清，腾讯快照的「开盘价」要么是 0 要么是昨开，
  //   写进 reviewed.json 就是脏判决（而且旧标记会挡住当天补跑）。
  // 12 点以后：开盘价虽然不变，但再跑只会重复推送、白耗请求，没有新信息。
  // 旧写法 `if (!(hour === 9 && min >= 26) && hour < 9) return;` 漏了后半段，
  // 实测 9:00 / 9:20 / 10:00 / 15:05 / 19:00 全都会跑，只有 9 点前才跳过。
  if (hour < 9 || (hour === 9 && min < 26) || hour >= 12) return;
  // 跨重启去重：reviewed.json 已经是今天的，说明今天审核过了，重启不再重跑
  if (readSignalField("reviewed.json", "date") === day) {
    signalReviewRanDay = day;
    return;
  }
  signalReviewRunning = true;
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--import", "./scripts/alias.mjs", "scripts/review-auction.ts"],
    { stdio: "inherit" },
  );
  child.on("exit", (code) => {
    signalReviewRunning = false;
    if (code) {
      // 不落标记：下一个心跳（60 秒后）还会再试，直到成功或过了 12 点窗口
      console.error(`竞价审核失败（exit ${code}），60 秒后重试`);
      return;
    }
    signalReviewRanDay = day;
  });
}

// ── 信号跟踪：每天收盘后（15:10）跑，拉昨日信号的次日涨跌
let signalTrackRanDay = "";
function runSignalTrack() {
  const day = new Date().toLocaleDateString("sv-SE");
  if (signalTrackRanDay === day) return;
  if (!isMarketOpen(day)) return; // 休市无次日涨跌，不跟踪
  const hour = new Date().getHours();
  if (hour < 15) return;
  // 跨重启去重：trackedDate 是今天、且信号日不是今天 = 今天已经跟踪过了。
  // 两个条件都要（只看 trackedDate 会把「同日比较」那种脏数据也当成已完成）。
  const tSignal = readSignalField("tracking.json", "signalDate");
  const tTracked = readSignalField("tracking.json", "trackedDate");
  if (tTracked === day && tSignal !== day) {
    signalTrackRanDay = day;
    return;
  }
  signalTrackRanDay = day;
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--import", "./scripts/alias.mjs", "scripts/track-signals.ts"],
    { stdio: "inherit" },
  );
  child.on("exit", (code) => {
    if (code) console.error("信号跟踪失败，明天再补跑");
  });
}

// ── 通达信盘后包：15:12 补最近 3 个自然日的全市场 OHLC 截面。
// 一个请求拿全市场，比逐只刷腾讯 K 线轻得多。当天包 404 是正常（收盘后数小时才发布），
// --back 2 保证至少能补到 T-1；脚本对已落盘日期自带幂等，重跑不会重复写。
// 形态台账读这些截面补最近日期，避免 kline 缓存「攒够 800 根就再也不更新」的滞后。
let tdxDailyRanDay = "";
function runTdxDaily() {
  const day = new Date().toLocaleDateString("sv-SE");
  if (tdxDailyRanDay === day) return;
  if (!isMarketOpen(day)) return;
  const hour = new Date().getHours();
  const min = new Date().getMinutes();
  if (hour < 15 || (hour === 15 && min < 12)) return;
  tdxDailyRanDay = day;
  const child = spawn("python3", ["scripts/fetch-tdx-package.py", "--back", "2"], { stdio: "inherit" });
  child.on("exit", (code) => {
    if (code) console.error("通达信盘后包没补成，形态台账会退回旧缓存（覆盖度会如实写进产出）");
  });
}

// ── 市场快照：收盘后 15:12 采三池 + 广度，按日落盘，首页只读这份（零外部请求）。
// 2026-11-11 体检：原来首页 loader 直接调 getSignals，3 个东财池串行 ×1300ms
// 把 GET / 拖到 4.386620s。采集挪到心跳后，页面读 data/signals/limit-pools-today.json。
// 同时按日归档 data/history/{limit-pools,theme-components}/，为「预测市场」攒历史样本。
// 跨重启去重：当日归档若已是 sealed=true 就跳过；盘中采的 sealed=false 收盘后重采覆盖。
let marketSnapshotRanDay = "";
function runMarketSnapshot() {
  const day = new Date().toLocaleDateString("sv-SE");
  if (marketSnapshotRanDay === day) return;
  if (!isMarketOpen(day)) return;
  const hour = new Date().getHours();
  const min = new Date().getMinutes();
  if (hour < 15 || (hour === 15 && min < 12)) return;
  try {
    const archive = join(ROOT, "data", "history", "limit-pools", `${day}.json`);
    if (existsSync(archive)) {
      const prev = JSON.parse(readFileSync(archive, "utf8"));
      if (prev?.sealed === true) {
        marketSnapshotRanDay = day;
        return;
      }
    }
  } catch {
    // 归档读不懂就正常重采，不静默跳过
  }
  marketSnapshotRanDay = day;
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--import", "./scripts/alias.mjs", "scripts/capture-market-snapshot.ts"],
    { stdio: "inherit" },
  );
  child.on("exit", (code) => {
    if (code) {
      console.error("市场快照没采成，首页会标「今天还没采集」，不拿旧值冒充");
      return;
    }
    // 快照落盘之后顺着算下游两份数据（都只读本地文件，不联网）：
    //   cycle-history → 情绪周期序列（/cycle）
    //   brief-build   → 题材前瞻简报（/brief）
    // 串行跑，因为后两个都依赖刚写的 limit-pools-today.json。
    runAfterSnapshot();
  });
}

/** 快照之后的下游计算。失败只在日志里说，不阻塞别的定时任务。 */
function runAfterSnapshot() {
  // 顺序有讲究：
  //   cycle-history / brief-build 是老链路（情绪周期、题材简报）
  //   closes-index 把日线压成按日收盘价快照（/interval 区间统计读它）
  //   rs-build 出趋势中军榜（/rs）
  //   forecast 落档今天要盯的 3 只（/huiyan，自带「没封印就不落」的闸）
  // 前一步失败只记日志、接着跑下一步——一块数据坏了不该拖死后面四块。
  const steps = [
    "scripts/cycle-history.ts",
    "scripts/brief-build.ts",
    "scripts/closes-index.ts",
    "scripts/rs-build.ts",
    "scripts/forecast.ts",
  ];
  const next = (i) => {
    if (i >= steps.length) return;
    const c = spawn(process.execPath, ["--experimental-strip-types", "--import", "./scripts/alias.mjs", steps[i]], {
      stdio: "inherit",
    });
    c.on("exit", (code) => {
      if (code) console.error(`${steps[i]} 没跑成（退出码 ${code}），对应页面会保持上一份数据`);
      next(i + 1);
    });
  };
  next(0);
}

// ── 早盘决策推送：9:26 竞价审核落盘之后推 ──
// 为什么不是 8:30：8:30 只有昨收预判（candidates），没竞价判决；9:26 review-auction
// 跑完 reviewed.json 才有「可执行/观望」的实盘判决。推的是「可执行」，不是预判。
let decisionPushedDay = "";
function runDecisionPush() {
  const day = new Date().toLocaleDateString("sv-SE");
  if (decisionPushedDay === day) return;
  if (!isMarketOpen(day)) return;
  const hour = new Date().getHours();
  const min = new Date().getMinutes();
  // 和 runSignalReview 同一个窗口：9:26 之后（竞价出清）且 12 点前。
  if (hour < 9 || (hour === 9 && min < 26) || hour >= 12) return;
  // 等竞价审核落盘：reviewed.json 还是昨天的，说明审核没跑完，这时推就是推昨收预判。
  if (readSignalField("reviewed.json", "date") !== day) return;
  decisionPushedDay = day;
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--import", "./scripts/alias.mjs", "scripts/push-decision.ts", "--push"],
    { stdio: "inherit" },
  );
  child.on("exit", (code) => {
    if (code) console.error("早盘决策推送失败，手动跑 push-decision.ts --push 补");
  });
}

// ── 题材轮动：收盘后 15:15 算（快照 15:12 之后）——从 K 线算题材动量+轮动方向，自算零外部源──
let rotationRanDay = "";
function runThemeRotation() {
  const day = new Date().toLocaleDateString("sv-SE");
  if (rotationRanDay === day) return;
  if (!isMarketOpen(day)) return;
  const hour = new Date().getHours();
  const min = new Date().getMinutes();
  if (hour < 15 || (hour === 15 && min < 15)) return;
  rotationRanDay = day;
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--import", "./scripts/alias.mjs", "scripts/theme-rotation.ts"],
    { stdio: "inherit" },
  );
  child.on("exit", (code) => {
    if (code) console.error("题材轮动没算成，手动跑 theme-rotation.ts 补");
  });
}

// ── 市场情报：收盘后 15:30 采（新闻解读→题材→个股传导，转发弈盘 hotspot 公开接口）──
let marketIntelRanDay = "";
function runMarketIntel() {
  const day = new Date().toLocaleDateString("sv-SE");
  if (marketIntelRanDay === day) return;
  if (!isMarketOpen(day)) return;
  const hour = new Date().getHours();
  const min = new Date().getMinutes();
  if (hour < 15 || (hour === 15 && min < 30)) return;
  marketIntelRanDay = day;
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--import", "./scripts/alias.mjs", "scripts/fetch-market-intel.ts"],
    { stdio: "inherit" },
  );
  child.on("exit", (code) => {
    if (code) console.error("市场情报没采成，手动跑 fetch-market-intel.ts 补");
  });
}

// ── 龙虎榜/游资：收盘后 17:00 抓（东财龙虎榜 ~17:00 更新）——按天落盘 data/risk/hotmoney/。
// 页面 getHotMoney 是现拉缓存的，这里是补历史归档（回测用）。去重看当日文件是否已落。
let hotmoneyRanDay = "";
function runHotmoneyFetch() {
  const day = new Date().toLocaleDateString("sv-SE");
  if (hotmoneyRanDay === day) return;
  if (!isMarketOpen(day)) return;
  const hour = new Date().getHours();
  if (hour < 17) return;
  const f = join(ROOT, "data", "risk", "hotmoney", `${day}.json`);
  if (existsSync(f)) { hotmoneyRanDay = day; return; }
  hotmoneyRanDay = day;
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--import", "./scripts/alias.mjs", "scripts/fetch-hotmoney-history.ts"],
    { stdio: "inherit" },
  );
  child.on("exit", (code) => {
    if (code) console.error("龙虎榜归档没抓成，手动跑 fetch-hotmoney-history.ts 补");
  });
}

// ── 席位档案：收盘后 18:10 建（东财龙虎榜 17:00 才更新，比它再晚一小时）──
// 2026-11-11 新页 /youzi/seats 的数据靠这一步。之前 seats-build.ts 写好了却没人调度，
// 页面一直空着——脚本"存在"不等于"在跑"，这次把它挂进每日链路。
// record-hotmoney 是幂等的（当天文件已存在就不覆盖），先跑它兜住 17:00 那次没抓成的日子，
// 再跑 seats-build 聚合。去重看 data/history/seats/latest.json 的 sourceLast。
let seatsRanDay = "";
function runSeatsArchive() {
  const day = new Date().toLocaleDateString("sv-SE");
  if (seatsRanDay === day) return;
  if (!isMarketOpen(day)) return;
  const hour = new Date().getHours();
  if (hour < 18) return;
  // 注意不能用 readSignalField：它固定读 data/signals/，席位档案在 data/history/seats/。
  let lastBuilt = null;
  try {
    lastBuilt = JSON.parse(readFileSync(join(ROOT, "data", "history", "seats", "latest.json"), "utf8")).sourceLast ?? null;
  } catch {
    lastBuilt = null; // 还没建过，正常
  }
  if (lastBuilt === day) { seatsRanDay = day; return; }
  seatsRanDay = day;
  const steps = ["scripts/record-hotmoney.ts", "scripts/seats-build.ts"];
  const next = (i) => {
    if (i >= steps.length) return;
    const c = spawn(process.execPath, ["--experimental-strip-types", "--import", "./scripts/alias.mjs", steps[i]], {
      stdio: "inherit",
    });
    c.on("exit", (code) => {
      if (code) console.error(`${steps[i]} 没跑成（退出码 ${code}），席位档案保持上一份`);
      next(i + 1);
    });
  };
  next(0);
}

// ── 监管异动雷达：收盘后 15:15 算（快照 15:12 落盘之后）——从 K 线算 3 日偏离值，
// 纯计算零外部源。去重看 data/history/regulatory/<date>.json 是否已落。
let regulatoryRanDay = "";
function runRegulatoryRadar() {
  const day = new Date().toLocaleDateString("sv-SE");
  if (regulatoryRanDay === day) return;
  if (!isMarketOpen(day)) return;
  const hour = new Date().getHours();
  const min = new Date().getMinutes();
  if (hour < 15 || (hour === 15 && min < 15)) return;
  const archive = join(ROOT, "data", "history", "regulatory", `${day}.json`);
  if (existsSync(archive)) { regulatoryRanDay = day; return; }
  regulatoryRanDay = day;
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--import", "./scripts/alias.mjs", "scripts/regulatory-radar.ts"],
    { stdio: "inherit" },
  );
  child.on("exit", (code) => {
    if (code) console.error("监管异动雷达没算成，手动跑 regulatory-radar.ts 补");
  });
}

// ── 涨停原因：收盘后 15:20 采（快照 15:12 落盘之后、形态台账 15:35 之前）──
// 数据源：yipanai.com 的公开接口（转发韭研公社/开盘啦），免登录。
// 采 85 只 ×250ms ≈ 25s，串行不急。
let limitUpReasonRanDay = "";
function runLimitUpReason() {
  const day = new Date().toLocaleDateString("sv-SE");
  if (limitUpReasonRanDay === day) return;
  if (!isMarketOpen(day)) return;
  const hour = new Date().getHours();
  const min = new Date().getMinutes();
  if (hour < 15 || (hour === 15 && min < 20)) return;
  limitUpReasonRanDay = day;
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--import", "./scripts/alias.mjs", "scripts/fetch-limit-up-reason.ts"],
    { stdio: "inherit" },
  );
  child.on("exit", (code) => {
    if (code) console.error("涨停原因没采成，梯队不显示概念标签（不编原因）");
  });
}

// ── 短线形态台账：每天收盘后（15:35）跑，攒形态证据，不给买卖建议
// 放在信号生成（15:30）之后：它读的是 K 线缓存，不与候选生成抢文件。
// 跨重启去重看 summary.json 的 generatedFor，跟其它每日任务同一套规矩。
let shortFormsRanDay = "";
function runShortFormsScan() {
  const day = new Date().toLocaleDateString("sv-SE");
  if (shortFormsRanDay === day) return;
  if (!isMarketOpen(day)) return; // 休市没有新 K 线
  const hour = new Date().getHours();
  const min = new Date().getMinutes();
  if (hour < 15 || (hour === 15 && min < 35)) return;
  if (readSignalField("forms/summary.json", "generatedFor") === day) {
    shortFormsRanDay = day;
    return;
  }
  shortFormsRanDay = day;
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--import", "./scripts/alias.mjs", "scripts/scan-short-forms.ts"],
    { stdio: "inherit" },
  );
  child.on("exit", (code) => {
    if (code) console.error("形态台账扫描失败，明天收盘后补跑");
  });
}

// ── 早盘自检（9:20，borrow-list B1）：9:26 买入单推送前把管道体检一遍推微信。
// 「为什么不推」类问题的根治是透明不是猜——缺件点名，每天必响，静默只留给服务没开。
// 跨重启去重看 data/signals/preflight.json 的 date，跟其它每日任务同一套规矩。
let preflightRanDay = "";
function runPreflight() {
  const day = new Date().toLocaleDateString("sv-SE");
  if (preflightRanDay === day) return;
  if (!isMarketOpen(day)) return;
  const hour = new Date().getHours();
  const min = new Date().getMinutes();
  if (hour < 9 || (hour === 9 && min < 20) || hour >= 12) return;
  if (readSignalField("preflight.json", "date") === day) {
    preflightRanDay = day;
    return;
  }
  preflightRanDay = day;
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--import", "./scripts/alias.mjs", "scripts/preflight.ts", "--push"],
    { stdio: "inherit" },
  );
  child.on("exit", (code) => {
    if (code) console.error(`早盘自检失败（exit ${code}），手动跑 preflight.ts --push 补`);
  });
}

runKlineRefresh();
runTdxDaily();
runMarketSnapshot();
runLimitUpReason();
runRegulatoryRadar();
runHotmoneyFetch();
runSeatsArchive();
runMarketIntel();
runThemeRotation();
runDecisionPush();
runStrategyVerdict();
runSignalGen();
runSignalReview();
runSignalTrack();
runShortFormsScan();
runPreflight();
const klineRefreshTimer = setInterval(runKlineRefresh, 60_000);
const tdxDailyTimer = setInterval(runTdxDaily, 60_000);
const marketSnapshotTimer = setInterval(runMarketSnapshot, 60_000);
const limitUpReasonTimer = setInterval(runLimitUpReason, 60_000);
const regulatoryTimer = setInterval(runRegulatoryRadar, 60_000);
const hotmoneyTimer = setInterval(runHotmoneyFetch, 60_000);
const marketIntelTimer = setInterval(runMarketIntel, 60_000);
const rotationTimer = setInterval(runThemeRotation, 60_000);
const decisionPushTimer = setInterval(runDecisionPush, 60_000);
const strategyVerdictTimer = setInterval(runStrategyVerdict, 60_000);
const signalGenTimer = setInterval(runSignalGen, 60_000);
const signalReviewTimer = setInterval(runSignalReview, 60_000);
const signalTrackTimer = setInterval(runSignalTrack, 60_000);
const shortFormsTimer = setInterval(runShortFormsScan, 60_000);
const preflightTimer = setInterval(runPreflight, 60_000);

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

/**
 * DeepSeek HARNESS 运行时（AI 大脑层，可选）。
 * 只在 harness/node_modules/@deepseek-ai/dsh 已安装时启动；没装就跳过并提示，不影响主服务。
 * DSH 起在 3080（CHIHENG_DSH_PORT 可覆盖），赤轨的 AI 闭环通过 CHIHENG_DSH_URL 走它（DSH 优先、直连兜底）。
 */
const DSH_BIN = join("harness", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const DSH_HOME = join(process.cwd(), "harness", "home");
const dshPort = process.env.CHIHENG_DSH_PORT ?? "3080";
const DSH_URL = `http://127.0.0.1:${dshPort}`;

let dsh = null;
let dshFailures = 0;

function spawnDSH() {
  if (!existsSync(DSH_BIN)) {
    console.log(`[DSH] 未安装（在 harness/ 跑 npm install 后会自动拉起 AI 大脑）。现在跳过，赤轨回退直连。`);
    return;
  }
  const startedAt = Date.now();
  const child = spawn(process.execPath, [DSH_BIN, "web", "--port", dshPort, "--no-open"], {
    stdio: "inherit",
    env: { ...process.env, DSH_HOME },
  });
  dsh = child;
  child.on("exit", (code, signal) => {
    if (stopping) return;
    if (Date.now() - startedAt < 60_000) {
      dshFailures += 1;
      if (dshFailures >= 3) {
        console.error(`[DSH] 连续 ${dshFailures} 次起不来（${code != null ? `退出码 ${code}` : `信号 ${signal ?? "未知"}`}）。上面几行是原因。AI 大脑没起，赤轨回退直连。`);
        return;
      }
    } else {
      dshFailures = 0;
    }
    const wait = Math.min(60, 5 * Math.max(1, dshFailures));
    console.log(`[DSH] 进程没了，${wait} 秒后重拉`);
    setTimeout(spawnDSH, wait * 1000);
  });
}

function clock() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
}

/**
 * 该起 dev 还是构建产物。
 *
 * 自动判断的规则只有一条：**src 比 .output 新就走 dev**。
 * 这样用户永远只打 `npm run serve`：改完代码刷新就能看到，不用记着 build；
 * build 过了就自动回到正式产物，也不用记着切。`--dev` / `--prod` 可以强制。
 *
 * 为什么不再"只提示不切换"：原来只打印一句「页面跑的是旧逻辑」，但人照样会忘，
 * 然后看着旧页面排查半天——2026-10-14 就这么白排查了三次。
 */
function pickDev() {
  if (process.argv.includes("--prod")) return false;
  if (process.argv.includes("--dev")) return true;
  try {
    const builtAt = statSync(".output").mtimeMs;
    return newestMtime("src") > builtAt;
  } catch {
    return true; // .output 不在（从没 build 过）→ dev
  }
}

function spawnServer() {
  const startedAt = Date.now();
  // dev 模式起 vite dev（改 src 秒级热更新，不用 build）；否则起构建产物 .output。
  // **默认自动判断**：src 比 .output 新（或 .output 根本不在）就走 dev——不然用户
  // 改完代码忘了 build，跑的是旧逻辑，而这种"旧"看不出来（2026-10-14 连踩几次）。
  // 要强制用哪一个：--dev 或 --prod。
  const dev = pickDev();
  const child = dev
    ? spawn(process.execPath, [join("scripts", "with-app-env.mjs"), "vite", "dev", "--host", host, "--port", port], {
        stdio: "inherit",
        // **PATH 要自己补两段**，否则 launchd 拉不起来（2026-10-15 实测踩了两次）：
        // 1. node_modules/.bin —— 裸名 `vite` 找不到，with-app-env.mjs 报
        //    "spawn vite ENOENT"；npm run 会临时加这段，但 launchd 不会。
        // 2. **node 自己所在的目录** —— launchd 的 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，
        //    用户的 node 在 ~/nodejs/bin，with-app-env.mjs 里的 `env node` 找不到它，
        //    报 "env: node: No such file or directory"（退出码 127）。
        //    这里用 dirname(process.execPath) 推，不硬编码路径（换 node 版本也不会失效）。
        env: {
          ...process.env,
          CHIHENG_DSH_URL: DSH_URL,
          PATH: [
            join(process.cwd(), "node_modules", ".bin"),
            dirname(process.execPath),
            process.env.PATH ?? "",
          ].join(":"),
        },
      })
    : spawn(process.execPath, [entry], {
        stdio: "inherit",
        env: { ...process.env, PORT: port, HOST: host, NITRO_PORT: port, NITRO_HOST: host, CHIHENG_DSH_URL: DSH_URL },
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
  // 先把「自己的」旧实例（含没带走的 vite/nitro 子进程）清掉，保证 8787 上只有我们一个。
  await ensureSoleInstance();
  const free = await portFree(port);
  if (!free) {
    console.log(
      `${clock()} 端口 ${port} 被一个不认识的进程占着，赤轨不敢擅自动它。` +
        `用 \`lsof -i :${port}\` 看看是谁，把它停掉再跑 npm run serve。`,
    );
    // 记账和告警是另一套（直接读 src，不走 .output），所以这里退出不影响它们
    process.exit(0);
  }
  server = spawnServer();
  spawnDSH();
  writeFileSync(PID_FILE, String(process.pid));
}

main();

let shuttingDown = false;
function shutdown() {
  try { unlinkSync(PID_FILE); } catch { /* pid 文件已不在 */ }
  // 收到停止信号就把自己也带走。早先这里只 kill 子进程、自己不退出，
  // 于是留下一个「以为自己在守着、其实端口已经空了」的进程——
  // 2026-10-05 下午 8787 打不开、日志却在刷「重新拉起」，就是这么来的。
  if (shuttingDown) {
    server.kill("SIGKILL");
    if (dsh) dsh.kill("SIGKILL");
    process.exit(1);
  }
  shuttingDown = true;
  stopping = true;
  clearInterval(timer);
  clearInterval(alertTimer);
  clearInterval(klineRefreshTimer);
  clearInterval(tdxDailyTimer);
  clearInterval(strategyVerdictTimer);
  clearInterval(signalGenTimer);
  clearInterval(signalReviewTimer);
  clearInterval(signalTrackTimer);
  clearInterval(shortFormsTimer);
  clearInterval(preflightTimer);
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
  if (dsh) dsh.kill("SIGTERM");
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

if (!pickDev()) warnIfStaleBuild();
warnIfSelfIsStale();
if (pickDev()) {
  console.log(
    `${clock()} dev 模式（src 比构建产物新，自动选的）：改完 src 网页会自动热更新，` +
      `不用 npm run build:mac。记账和告警照跑（它们直接读 src）。` +
      `要跑正式产物就先 npm run build:mac，或者 npm run serve -- --prod。`,
  );
}
console.log(`赤轨在本机 ${host}:${port} 上提供访问。同一局域网用这台电脑的 IP 加端口打开。`);
