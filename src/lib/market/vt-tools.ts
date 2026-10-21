/**
 * 这个文件是干什么的：
 * Vibe-Trading MCP server 的 chiheng 侧 client（「工具矿山」的接入层，design/AI-BRAIN.md 方案 B）。
 *
 * 为什么要有它：Vibe-Trading 自带 74 个只读/研究类 MCP 工具（资金流/龙虎榜/北向/研报检索/
 * 问财/回测分析……，探针记录见 AI-BRAIN.md）。赤轨的 AI 提议层（agent-loop 诊断、
 * 因子层/策略层 prompt 的市场证据）经这里调工具拿证据，提议从「拍脑袋」变「有数据支撑」。
 *
 * 你需要知道的：
 * - 只走 **stdio 子进程**（赤轨 spawn，不常驻端口，原样保留 VT 的默认安全值：
 *   shell 工具默认关、无网络暴露面）。
 * - 资产位置：源码 vendored 在 vendor/vt-mcp/Vibe-Trading（不进 git），venv 在
 *   ~/.chiheng/vt-venv（exFAT 卷不能放 venv）。环境变量覆盖：
 *   CHIHENG_VT_MCP_HOME（venv 根目录）、CHIHENG_VT_MCP_PY（python 直路径）、
 *   CHIHENG_VT_MCP_SCRIPT（mcp_server.py 直路径）。
 * - 进程生命周期：懒 spawn → initialize 握手 → tools/list / tools/call → 闲置回收
 *   （IDLE_KILL_MS）。任何一步失败都返回带 why/error 的离线状态或抛错，**绝不拖垮主流程**
 *   ——所有调用点（agent-loop / strategy-ai）都 try/catch 降级为空证据。
 * - 纪律：这些工具全是只读/研究类（VT 默认 shell 关闭），AI 只拿证据不碰执行；
 *   判决规则写死，本文件不在 prompt 层做任何放行。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** tools/list 里的单个工具（只取展示和调度要用的字段，schema 原样透传）。 */
export type VtTool = { name: string; description: string };

/** probeVtTools() 的返回：/ai 页「VT 工具矿山」面板的形状（调用方已按此写死）。 */
export type VtToolsReport = {
  online: boolean;
  toolCount: number;
  tools: VtTool[];
  /** 最近一次检测完成时刻（ISO）。 */
  checkedAt: string;
  error: string | null;
};

const DEFAULT_HOME = join(homedir(), ".chiheng", "vt-venv");
const DEFAULT_SCRIPT = join(process.cwd(), "vendor", "vt-mcp", "Vibe-Trading", "mcp_server.py");

/** 闲置超过这么久就杀掉子进程（下次调用重新 spawn；省着常驻吃内存）。 */
const IDLE_KILL_MS = 5 * 60 * 1000;
/** 单次工具调用的默认超时（VT 里 iwencai/东财类工具要爬数据，给宽一点）。 */
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
/** 进程起来到 initialize 完成的超时。 */
const INIT_TIMEOUT_MS = 30_000;
/** probeVtTools 的结果缓存：5 分钟内不重复 spawn 探测（/ai 页反复看不该每次都起进程）。 */
const STATUS_CACHE_MS = 5 * 60 * 1000;

function pyPath(): string {
  if (process.env.CHIHENG_VT_MCP_PY) return process.env.CHIHENG_VT_MCP_PY;
  return join(process.env.CHIHENG_VT_MCP_HOME ?? DEFAULT_HOME, "bin", "python");
}
function scriptPath(): string {
  return process.env.CHIHENG_VT_MCP_SCRIPT ?? DEFAULT_SCRIPT;
}

/** 静态体检：python 和脚本在不在。不在就不用 spawn 了，why 直说。 */
export function vtToolsPrerequisite(): { ok: boolean; why: string | null } {
  if (!existsSync(pyPath())) return { ok: false, why: `python 不存在：${pyPath()}（venv 未装？见 design/AI-BRAIN.md）` };
  if (!existsSync(scriptPath())) return { ok: false, why: `mcp_server.py 不存在：${scriptPath()}（vendor 未拉？）` };
  return { ok: true, why: null };
}

// ── stdio JSON-RPC ─────────────────────────────────────────────

type JsonRpcMessage = { jsonrpc: "2.0"; id: number; result?: unknown; error?: { code: number; message: string } };

class VtMcpProcess {
  private child: ChildProcess | null = null;
  private buffer = "";
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private idleTimer: NodeJS.Timeout | null = null;

  /** 惰性单例：进程死了或没有就重新 spawn + initialize 握手。 */
  async ensure(): Promise<void> {
    if (this.child && this.child.exitCode === null) return;
    this.kill();
    this.child = spawn(pyPath(), [scriptPath()], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr!.on("data", () => void 0); // stderr 是 VT 的日志，不进协议流
    this.child.on("exit", () => this.failAll(new Error("VT MCP 进程退出")));
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "chiheng", version: "1.0" },
    }, INIT_TIMEOUT_MS);
    await this.notify("notifications/initialized", {});
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) return;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue; // VT 的杂散日志行，跳过
      }
      if (typeof msg.id !== "number") continue;
      const slot = this.pending.get(msg.id);
      if (!slot) continue;
      clearTimeout(slot.timer);
      this.pending.delete(msg.id);
      if (msg.error) slot.reject(new Error(`MCP ${msg.error.code}: ${msg.error.message}`));
      else slot.resolve(msg.result);
    }
  }

  private failAll(error: Error): void {
    for (const slot of this.pending.values()) {
      clearTimeout(slot.timer);
      slot.reject(error);
    }
    this.pending.clear();
  }

  private notify(method: string, params: unknown): void {
    this.child!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  request(method: string, params: unknown, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<unknown> {
    const child = this.child;
    if (!child || child.exitCode !== null) return Promise.reject(new Error("VT MCP 进程未启动"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.kill(), IDLE_KILL_MS);
  }

  kill(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.child) {
      this.child.kill("SIGKILL");
      this.child = null;
    }
    this.buffer = "";
    this.failAll(new Error("VT MCP 进程已回收"));
  }
}

const processRef: { current: VtMcpProcess | null } = { current: null };
function proc(): VtMcpProcess {
  if (!processRef.current) processRef.current = new VtMcpProcess();
  return processRef.current;
}

// ── 对外接口 ──────────────────────────────────────────────────

/** /ai 页状态面板用：在线 + 工具数 + 清单，带 5 分钟缓存。 */
export async function probeVtTools(force = false): Promise<VtToolsReport> {
  const now = Date.now();
  if (!force && now - statusCache.at < STATUS_CACHE_MS) return statusCache.report;
  const pre = vtToolsPrerequisite();
  const report: VtToolsReport = pre.ok
    ? await probeLive()
    : { online: false, toolCount: 0, tools: [], checkedAt: new Date().toISOString(), error: pre.why };
  statusCache.at = now;
  statusCache.report = report;
  return report;
}

const statusCache: { at: number; report: VtToolsReport } = { at: -Infinity, report: { online: false, toolCount: 0, tools: [], checkedAt: "", error: null } };

async function probeLive(): Promise<VtToolsReport> {
  try {
    const p = proc();
    await p.ensure();
    const result = (await p.request("tools/list", {}, INIT_TIMEOUT_MS)) as { tools?: { name?: unknown; description?: unknown }[] };
    p.touch();
    const tools = (result.tools ?? [])
      .filter((t): t is { name: string; description?: unknown } => typeof t?.name === "string")
      .map((t) => ({ name: t.name, description: typeof t.description === "string" ? t.description : "" }));
    return { online: true, toolCount: tools.length, tools, checkedAt: new Date().toISOString(), error: null };
  } catch (error) {
    // 探活失败把进程杀掉，下次重来（可能是 venv 坏了或 VT 升级了协议）。
    try {
      proc().kill();
    } catch {
      /* 杀不掉就算了 */
    }
    return { online: false, toolCount: 0, tools: [], checkedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 调一个工具。返回**原始文本**（调用方 evidenceOf 自己解析 JSON，解析口径归它管）；
 * 参数原样透传（schema 由 VT 侧校验）。超时/离线都抛——调用方（agent-loop /
 * strategy-ai）自己 try/catch 降级，这里不做重试。
 */
export async function invokeVtTool(name: string, args: Record<string, unknown>, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<string> {
  const pre = vtToolsPrerequisite();
  if (!pre.ok) throw new Error(pre.why ?? "VT MCP 未就绪");
  const p = proc();
  await p.ensure();
  const result = (await p.request("tools/call", { name, arguments: args }, timeoutMs)) as { content?: { type?: string; text?: string }[]; isError?: boolean };
  p.touch();
  const text = (result.content ?? [])
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
  if (result.isError) throw new Error(`VT 工具 ${name} 报错：${text.slice(0, 200)}`);
  return text;
}

/** 测试和关服用：清缓存 + 立刻杀掉子进程。 */
export function shutdownVtTools(): void {
  statusCache.at = -Infinity;
  statusCache.report = { online: false, toolCount: 0, tools: [], checkedAt: "", error: null };
  try {
    processRef.current?.kill();
  } catch {
    /* 忽略 */
  }
  processRef.current = null;
}
