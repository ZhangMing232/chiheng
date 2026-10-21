/**
 * 这个文件是干什么的：
 * 构建后的冒烟测试。用无头 Chrome 真实打开页面，抓控制台报错、模拟点击——
 * 专门防「SSR 渲染正常、但客户端 JS 一启动就崩、全站按钮瘫痪」这类问题。
 * 2026-10-16 实际发生过一次（node:path 顶层调用，瘫痪半个月没被测试发现）。
 *
 * 你需要知道的：
 * - 跑之前服务要在 8787 端口起着（launchd 托管的 com.chiheng.serve）。
 * - 退出码 0 = 全过；非 0 = 有项失败，失败明细打到 stdout。
 * - 用法：node scripts/smoke-test.mjs [baseUrl]
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://localhost:8787";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// 2026-10-21 整合后：选股+追踪在 /strategies 下，复盘+信号在 /review 下；
// 末尾三个旧地址是重定向页，留着验证旧书签不断链。
const PAGES = ["/", "/strategies/screener", "/strategies/positions", "/review", "/review/signals", "/review/events", "/flow", "/backtest", "/ai", "/screener", "/positions", "/signals", "/calendar", "/events"];
// 步骤 3 是「从首页点导航链接走 SPA 路由」——只能点侧栏里真实存在的入口；
// 重定向页（/screener 等）和二级子页（/strategies/positions、/review/signals、
// /review/events）不在侧栏里，靠子页面内的 tab 条跳转，整页加载那步（步骤 2）已经覆盖过。
const NAV_PAGES = ["/strategies/screener", "/review", "/flow", "/backtest", "/ai"];

/** 等 fn 返回非 undefined 值，超时抛错 */
async function waitFor(fn, { timeoutMs = 15000, stepMs = 250 } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== null) return value;
    if (Date.now() - start > timeoutMs) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

async function main() {
  const port = 9300 + Math.floor(Math.random() * 500);
  const profile = mkdtempSync(join(tmpdir(), "chiheng-smoke-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      "--disable-gpu",
      // **必须绕代理**：本机 shell 里有 HTTP_PROXY（ agent 环境注入的），Chrome 会
      // 继承它，于是访问 localhost:8787 全被送去代理、拿到假 502——smoke 就永远
      // 「等待超时」。2026-10-16 实测踩到（curl 那边一直用 --noproxy，Chrome 忘了）。
      "--no-proxy-server",
      "--no-first-run",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  const failures = [];
  const pass = (name) => console.log(`  PASS  ${name}`);
  const fail = (name, why) => {
    failures.push(name);
    console.log(`  FAIL  ${name} —— ${why}`);
  };

  try {
    // 等调试端口起来（Chrome 冷启动可能要十几秒）
    const targets = await waitFor(
      async () => {
        try {
          const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
          return list.find((t) => t.type === "page") ?? null;
        } catch {
          return null;
        }
      },
      { timeoutMs: 45000, stepMs: 500 },
    );

    const ws = new WebSocket(targets.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = rej;
    });

    let msgId = 0;
    const pending = new Map();
    const consoleErrors = [];
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      } else if (msg.method === "Runtime.exceptionThrown") {
        consoleErrors.push(msg.params.exceptionDetails?.exception?.description ?? "未知异常");
      } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
        consoleErrors.push(msg.params.args?.map((a) => a.value ?? a.description ?? "").join(" ") ?? "console.error");
      }
    };
    const send = (method, params = {}) =>
      new Promise((res) => {
        const id = ++msgId;
        pending.set(id, res);
        ws.send(JSON.stringify({ id, method, params }));
      });
    const evalJs = async (expression) => {
      const reply = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (reply.result?.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails).slice(0, 300));
      return reply.result?.result?.value;
    };

    await send("Runtime.enable");
    await send("Page.enable");
    console.log("  ..  Chrome 已连接，开始逐页检查");

    // 1) 首页：JS 启动无异常 + 页面菜单按钮可点击展开
    consoleErrors.length = 0;
    const navReply = await send("Page.navigate", { url: BASE + "/" });
    console.log("  ..  导航请求已发出", JSON.stringify(navReply.result ?? navReply.error ?? {}).slice(0, 120));
    // 不等 load 事件（外部资源可能挂住），等关键按钮渲染出来即可
    await waitFor(async () => {
      const ready = await evalJs(
        `document.readyState !== "loading" && document.querySelector('button[aria-label="页面菜单"]') ? "ok" : undefined`,
      );
      return ready;
    });

    // hydration 需要一点时间（等按钮挂上事件处理器）
    await waitFor(async () => {
      const expanded = await evalJs(`(async () => {
        const btn = document.querySelector('button[aria-label="页面菜单"]');
        if (!btn) return undefined;
        btn.click();
        await new Promise((r) => setTimeout(r, 300));
        const menu = [...document.querySelectorAll("a")].some((a) => a.textContent.includes("复盘"));
        btn.click();
        return menu ? "ok" : undefined;
      })()`);
      return expanded;
    }).then(
      () => pass("首页：页面菜单按钮点击可展开"),
      (e) => fail("首页：页面菜单按钮点击可展开", String(e.message ?? e)),
    );

    if (consoleErrors.length > 0) fail("首页：控制台无报错", consoleErrors[0].split("\n")[0]);
    else pass("首页：控制台无报错");

    // 2) 逐页扫一遍：HTTP 200 + 客户端无异常
    for (const path of PAGES.slice(1)) {
      consoleErrors.length = 0;
      await send("Page.navigate", { url: BASE + path });
      await waitFor(async () => {
        const ready = await evalJs(`document.readyState !== "loading" ? "ok" : undefined`);
        return ready;
      }, { timeoutMs: 20000 });
      // 给 hydration 两秒
      await new Promise((r) => setTimeout(r, 2000));
      if (consoleErrors.length > 0) fail(`${path}：客户端无异常`, consoleErrors[0].split("\n")[0]);
      else pass(`${path}：客户端无异常`);
    }

    // 3) 客户端导航扫一遍：整页加载抓不到「loader 在浏览器里跑崩」类问题
    // （2026-10-17 /backtest 实例：loader 直接调 node 函数，SSR 正常、一点导航就整页报错）。
    // 做法：从首页逐个点击导航链接走 SPA 路由，抓控制台异常。只扫侧栏真实存在的入口。
    for (const path of NAV_PAGES) {
      consoleErrors.length = 0;
      await send("Page.navigate", { url: BASE + "/" });
      await waitFor(async () => {
        const ready = await evalJs(`document.readyState !== "loading" ? "ok" : undefined`);
        return ready;
      }, { timeoutMs: 20000 });
      // 移动端布局导航在「页面菜单」里，先展开（链接不在 DOM 就点不到）
      await evalJs(`document.querySelector('button[aria-label="页面菜单"]')?.click()`);
      await new Promise((r) => setTimeout(r, 400));
      const clicked = await evalJs(
        `(()=>{const a=[...document.querySelectorAll("a[href]")].find(x=>x.getAttribute("href")?.startsWith("${path}"));if(!a)return "missing";a.click();return "ok"})()`,
      );
      if (clicked !== "ok") {
        fail(`${path}：客户端导航`, "导航里找不到链接（菜单没展开？）");
        continue;
      }
      await new Promise((r) => setTimeout(r, 2500));
      if (consoleErrors.length > 0) fail(`${path}：客户端导航无异常`, consoleErrors[0].split("\n")[0]);
      else pass(`${path}：客户端导航无异常`);
    }

    ws.close();
  } catch (error) {
    failures.push("smoke-runner");
    console.log(`  FAIL  smoke-runner —— ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    chrome.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 1500));
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  }

  console.log(failures.length === 0 ? "\n冒烟测试全过" : `\n${failures.length} 项失败`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main();
