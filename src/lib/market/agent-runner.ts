/**
 * 这个文件是干什么的：
 * 常驻 agent（「小机」）的运行器：派活 → spawn `dsh --profile headless` →
 * 等结果 → 回填账本。server-only，由 quotes.functions.ts 的 server fn 调用。
 *
 * 你需要知道的：
 * 1. 默认待命：没有任务时这个模块不产生任何进程、零消耗。
 * 2. 全操作权限的钥匙是 DSH_PERMISSION_MODE=danger-full-access（2026-11-14
 *    用户拍板）+ harness/home/.env 里的 DEEPSEEK_API_KEY 兜底（headless 读
 *    credentials 服务有坑，.env 是官方 fallback 层）。
 * 3. --json 流式事件里最省的是读 final 事件拿最终回答 + turn_end 拿 usage。
 *    token → 元的换算用 ai-prices.ts 的参考价（DSH 桥接的账在 DSH 侧，
 *    headless 直连 DeepSeek 官方——这里是 agent 自己的账，两本账分开）。
 * 4. 预算闸门在派活前（gateJob）+ 运行中（进程结束回填时若超 perTask 上限
 *    标 budget-killed）。120 秒心跳超时兜底：agent 卡死不至于白烧钱。
 * 5. node API 全部函数内动态 import（浏览器兼容铁律）。
 */

import type { AgentJob, AgentBudget } from "./agent-jobs.ts";
import { FALLBACK_FACTS, buildAgentSystemPrompt } from "./agent-charter.ts";
import { DEFAULT_BUDGET, budgetExceeded } from "./agent-jobs.ts";

const fsApi = () => import("node:fs/promises");
const cpApi = () => import("node:child_process");
const posixJoin = (...parts: string[]): string => parts.join("/");

function harnessHome(): string {
  return process.env.CHIHENG_DSH_HOME ?? posixJoin(process.cwd(), "harness", "home");
}

function dshBin(): string {
  return posixJoin(process.cwd(), "harness", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
}

/** headless 会话持久化目录（--session-id 续接记忆用）。 */
function sessionDir(): string {
  return posixJoin(harnessHome(), "sessions");
}

/** 派活前的项目事实快照。读不到就如实标未知，绝不编。 */
export async function collectProjectFacts(): Promise<ReturnType<typeof buildAgentSystemPrompt> extends string ? import("./agent-charter.ts").AgentProjectFacts : never> {
  type Facts = import("./agent-charter.ts").AgentProjectFacts;
  const facts: Facts = { ...FALLBACK_FACTS };
  try {
    const { execFile } = await cpApi();
    const run = (cmd: string, args: string[]) =>
      new Promise<string>((resolve) => {
        execFile(cmd, args, { cwd: process.cwd(), timeout: 10_000 }, (err, stdout) => resolve(err ? "" : String(stdout)));
      });
    const head = await run("git", ["rev-parse", "--short", "HEAD"]);
    if (head) facts.gitHead = head.trim();
    const status = await run("git", ["status", "--porcelain"]);
    const dirty = status.trim().split("\n").filter((l) => l.length > 0 && !l.includes("agent-jobs") && !l.includes("agent-budget"));
    facts.dirtyCount = dirty.length;
    facts.gitClean = dirty.length === 0;
    const breaker = await fsApi().then((fs) => fs.readFile(posixJoin(process.env.CHIHENG_DATA_DIR ?? posixJoin(process.cwd(), "data"), "evolve-breaker.json"), "utf8")).catch(() => "");
    if (breaker) {
      try {
        const parsed = JSON.parse(breaker) as { trippedAt?: string | null; trippedReason?: string };
        facts.breakerTripped = !!parsed.trippedAt;
        facts.breakerReason = parsed.trippedReason ?? null;
      } catch { /* 读坏了按正常算，不阻塞派活 */ }
    }
  } catch {
    // 采集失败用兜底快照。
  }
  return facts;
}

export type SpawnResult = {
  ok: boolean;
  answer: string;
  error?: string;
  /** token 用量（final turn 的累计）。 */
  tokens: { input: number; output: number; total: number } | null;
  sessionId?: string;
};

/** token → 元。参考价同 ai-prices.ts 的 deepseek 官方价；模型名对不上按 flash 计。 */
export function costOfTokens(input: number, output: number, model: string): { cny: number; estimated: boolean } {
  // deepseek 官方谷时价（元/百万 token），与 src/lib/market/ai-prices.ts 保持一致。
  const table: Record<string, { p: number; c: number }> = {
    "deepseek-flash": { p: 1.1, c: 4.3 },
    "deepseek-v4-pro": { p: 4.7, c: 14.1 },
  };
  const price = table[model] ?? table["deepseek-flash"];
  return { cny: (input / 1e6) * price.p + (output / 1e6) * price.c, estimated: true };
}

/**
 * 派一次活。同步等待完成（headless 模式 = 一问一答进程退出）。
 * onTick 每 30 秒回调一次进度（页面轮询 state 文件用的钩子，这里留接口）。
 */
export async function runAgentTask(opts: {
  task: string;
  trigger: "manual" | "scheduled";
  scheduleId?: string;
  budget: AgentBudget;
  /** 预算闸门判定用的账本快照（调用方传，保持本模块可测）。 */
  jobsForGate: import("./agent-jobs.ts").AgentJob[];
  /** 闸门拒绝时的回调（记账 + 通知）。 */
  onRejected?: (reason: string) => Promise<void>;
  /** 进程启动后的回调（写 running 账目）。 */
  onStarted?: (job: AgentJob) => Promise<void>;
  /** 结束回调（回填账目）。 */
  onFinished?: (job: AgentJob) => Promise<void>;
}): Promise<SpawnResult> {
  const { execFile } = await cpApi();
  const now = new Date();
  const day = now.toISOString().slice(0, 10); // 简化：日/月口径按 UTC 日切，和 ai-usage 的今天口径一致
  const month = day.slice(0, 7);

  // 预算闸门：拒绝就不拉进程。
  const taskBudget = opts.budget.perTaskCny;
  const verdict = gateJob(opts.jobsForGate, opts.budget, taskBudget, day, month);
  if (!verdict.allowed) {
    await opts.onRejected?.(verdict.reason);
    return { ok: false, answer: "", error: verdict.reason, tokens: null };
  }

  const facts = await collectProjectFacts();
  const system = buildAgentSystemPrompt(facts);
  const startedAt = now.toISOString();
  const job: AgentJob = {
    at: startedAt,
    task: opts.task,
    trigger: opts.trigger,
    ...(opts.scheduleId ? { scheduleId: opts.scheduleId } : {}),
    budgetCny: taskBudget,
    status: "running",
  };
  await opts.onStarted?.(job);

  // --json 流式事件收 final + usage。超时 = 心跳兜底（预算上限折算的分钟数，至少 5 分钟）。
  const timeoutMs = Math.max(5 * 60_000, Math.min(30 * 60_000, Math.round(taskBudget / DEFAULT_BUDGET.perTaskCny * 20 * 60_000)));
  const args = ["--profile", "headless", "--json", `${system}\n\n## 任务\n${opts.task}`];
  const result = await new Promise<SpawnResult>((resolve) => {
    const child = execFile(
      process.execPath,
      [dshBin(), ...args],
      {
        cwd: process.cwd(),
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        env: {
          ...process.env,
          DSH_HOME: harnessHome(),
          DSH_PERMISSION_MODE: "danger-full-access",
        },
      },
      (err, stdout) => {
        // 解析 NDJSON 事件流：final 文本 + 最后一个带 usage 的 step_end。
        let answer = "";
        let usage: { input: number; output: number } | null = null;
        let sessionId: string | undefined;
        for (const line of String(stdout).split("\n")) {
          if (!line.trim().startsWith("{")) continue;
          try {
            const ev = JSON.parse(line) as Record<string, unknown>;
            if (ev.type === "session" && typeof ev.sessionId === "string") sessionId = ev.sessionId;
            if (ev.type === "final" && typeof ev.text === "string") answer = ev.text;
            if (ev.type === "status" && ev.phase === "step_end" && ev.usage && typeof ev.usage === "object") {
              const u = ev.usage as { inputTokens?: number; outputTokens?: number };
              if (typeof u.inputTokens === "number" && typeof u.outputTokens === "number") {
                usage = { input: u.inputTokens, output: u.outputTokens };
              }
            }
          } catch { /* 非 JSON 行跳过 */ }
        }
        if (err && !answer) {
          const msg = err.message.includes("timed out") ? `任务超时被杀（上限 ${Math.round(timeoutMs / 60_000)} 分钟）` : err.message.slice(0, 300);
          resolve({ ok: false, answer: "", error: msg, tokens: null, sessionId });
          return;
        }
        resolve({
          ok: !!answer,
          answer: answer.slice(0, 4000),
          ...(answer ? {} : { error: err?.message.slice(0, 300) ?? "agent 没有返回内容" }),
          tokens: usage ? { input: usage.input, output: usage.output, total: usage.input + usage.output } : null,
          sessionId,
        });
      },
    );
    // 留句柄给外部 stopAgentTask（当前轮不接 UI，句柄先不暴露）。
    void child;
  });

  const endedAt = new Date().toISOString();
  const cost = result.tokens ? costOfTokens(result.tokens.input, result.tokens.output, "deepseek-flash") : undefined;
  const finished: AgentJob = {
    ...job,
    status: result.ok ? "ok" : cost && budgetExceeded({ ...job, cost }, opts.budget) ? "budget-killed" : result.ok ? "ok" : "error",
    endedAt,
    ...(result.answer ? { answer: result.answer } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(cost ? { cost } : {}),
    ...(result.sessionId ? { sessionId: result.sessionId } : {}),
  };
  await opts.onFinished?.(finished);
  return result;
}

/** gateJob 的内联引用（避免 require——ESM 下统一走静态 import）。 */
import { gateJob } from "./agent-jobs.ts";
