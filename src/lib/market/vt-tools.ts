/**
 * 这个文件是干什么的：
 * Vibe-Trading MCP 工具矿山的赤轨侧 client（design/AI-BRAIN.md 方案 B）。
 * VT 的 mcp_server.py 暴露 74 个只读/研究类工具（A 股资金流、全市场筛选、
 * 研报检索、回测分析……），这里用 stdio 子进程的方式随用随起——不常驻端口、
 * 不引新 npm 依赖（MCP stdio 就是换行分隔的 JSON-RPC，直接手写）。
 *
 * 你需要知道的（纪律）：
 * 1. **只读工具面**：VT 侧 shell 工具默认就不注册（我们从不传
 *    --enable-shell-tools），74 个工具全是研究类。这层仍然只许「读」，
 *    产出喂给 AI 的 prompt 当证据，AI 的执行边界不变。
 * 2. **随用随起**：每次调用 spawn 一个 python 子进程，握手 → 调用 → 杀掉。
 *    进程活在一次调用的几十秒内，不占内存不常驻。状态检查带 5 分钟内存缓存，
 *    页面反复导航不会反复 spawn。
 * 3. venv 不能挪到外置卷 /Volumes/colorful（venv 里的符号链接在 exFAT 上会坏），
 *    所以默认路径指向本机工作区副本，可用 CHIHENG_VT_MCP_HOME 环境变量覆盖；
 *    部署到别的机器时设这个变量即可。
 * 4. 纯函数（消息组包/解析）不碰子进程，直接单测。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

// ── 纯函数：MCP stdio 消息组包/解析 ────────────────────────────

/** JSON-RPC 请求组包（MCP stdio = 单行 JSON + \n）。 */
export function frameMsg(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

/** 初始化握手请求（协议版本用 mcp<1.30 系都认的 2025-03-26）。 */
export function buildInitialize(id: number): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "chiheng-vt-tools", version: "0.1.0" },
    },
  };
}

/** initialized 通知（握手后发，不发的话 server 不响应 tools/list）。 */
export function buildInitializedNotification(): Record<string, unknown> {
  return { jsonrpc: "2.0", method: "notifications/initialized" };
}

export function buildListTools(id: number): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method: "tools/list", params: {} };
}

export function buildCallTool(id: number, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

/** 这一行是不是 JSON-RPC 响应（有 id + result/error）。 */
export function isResponse(line: string): boolean {
  try {
    const m = JSON.parse(line) as { id?: unknown; result?: unknown; error?: unknown };
    return typeof m.id === "number" && ("result" in m || "error" in m);
  } catch {
    return false;
  }
}

/** 从响应行里取 result；error 响应抛错。 */
export function resultOf(line: string): unknown {
  const m = JSON.parse(line) as { id?: number; result?: unknown; error?: { code?: number; message?: string } };
  if (m.error) throw new Error(`MCP error ${m.error.code ?? "?"}：${m.error.message ?? "未知"}`);
  return m.result;
}

// ── stdio 会话（server-only：spawn 子进程） ─────────────────────

export type VTToolInfo = { name: string; description: string };

export type VTToolsStatus = {
  online: boolean;
  toolCount: number;
  tools: VTToolInfo[];
  error: string | null;
  checkedAt: string;
};

/** VT MCP 的家：venv + 解包源码。默认本机工作区副本，可用环境变量覆盖。 */
export function vtMcpHome(): string {
  return (
    process.env.CHIHENG_VT_MCP_HOME ??
    "/Users/zhangweimin/Documents/kimi/tasks/2026-09-30/11-14-40-0dc258a"
  );
}

export function vtMcpCommand(): { python: string; script: string; env: NodeJS.ProcessEnv } {
  const home = vtMcpHome();
  return {
    python: join(home, "vt-venv/bin/python"),
    script: join(home, "Vibe-Trading/mcp_server.py"),
    env: { ...process.env, PYTHONPATH: join(home, "Vibe-Trading") },
  };
}

/** 一次 stdio 会话：spawn → 握手 → 收发 JSON-RPC → 结束杀掉。 */
class VTSession {
  private child: ChildProcess;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (line: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private stderrTail = "";
  private dead = false;

  constructor(timeoutMs: number) {
    const { python, script, env } = vtMcpCommand();
    this.child = spawn(python, [script], { env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr?.on("data", (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-2000);
    });
    this.child.stdout?.on("data", (d: Buffer) => {
      this.buffer += d.toString();
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        this.onLine(line);
      }
    });
    this.child.on("exit", () => {
      this.dead = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`VT MCP 子进程退出（stderr 尾部：${this.stderrTail.slice(-200) || "空"}）`));
      }
      this.pending.clear();
    });
    void timeoutMs;
  }

  private onLine(line: string): void {
    // server 可能反向 ping（server->client request）：回个空 result 再继续。
    try {
      const m = JSON.parse(line) as { id?: number; method?: string };
      if (typeof m.id === "number" && m.method) {
        this.send({ jsonrpc: "2.0", id: m.id, result: {} });
        return;
      }
    } catch {
      // 不是 JSON 的行忽略（server 日志混进来的容错）。
    }
    if (!isResponse(line)) return;
    const id = (JSON.parse(line) as { id: number }).id;
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(line);
  }

  private send(obj: unknown): void {
    this.child.stdin?.write(frameMsg(obj));
  }

  /** 发一个请求等响应，带超时。 */
  request(obj: Record<string, unknown>, timeoutMs: number): Promise<string> {
    if (this.dead) return Promise.reject(new Error("VT MCP 子进程已退出"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`VT MCP 请求超时（${timeoutMs / 1000}s）：${String(obj.method)}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ ...obj, id });
    });
  }

  /** 完整握手：initialize → initialized 通知。 */
  async handshake(timeoutMs: number): Promise<void> {
    await this.request(buildInitialize(this.nextId), timeoutMs);
    this.send(buildInitializedNotification());
  }

  async listTools(timeoutMs: number): Promise<VTToolInfo[]> {
    const line = await this.request(buildListTools(this.nextId), timeoutMs);
    const result = resultOf(line) as { tools?: { name?: string; description?: string }[] };
    return (result.tools ?? []).map((t) => ({ name: t.name ?? "?", description: (t.description ?? "").slice(0, 120) }));
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<string> {
    const line = await this.request(buildCallTool(this.nextId, name, args), timeoutMs);
    const result = resultOf(line) as { content?: { type?: string; text?: string }[] };
    return (result.content ?? []).map((c) => c.text ?? "").join("\n");
  }

  close(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    this.child.kill("SIGKILL");
  }
}

/** 状态检查（5 分钟内存缓存，避免页面导航反复 spawn）。 */
let statusCache: { at: number; status: VTToolsStatus } | null = null;
const STATUS_TTL = 5 * 60_000;

export async function checkVTTools(timeoutMs = 20_000): Promise<VTToolsStatus> {
  if (statusCache && Date.now() - statusCache.at < STATUS_TTL) return statusCache.status;
  const started = Date.now();
  let session: VTSession | null = null;
  try {
    session = new VTSession(timeoutMs);
    await session.handshake(timeoutMs);
    const tools = await session.listTools(timeoutMs);
    const status: VTToolsStatus = {
      online: true,
      toolCount: tools.length,
      tools: tools.slice(0, 200),
      error: null,
      checkedAt: new Date().toISOString(),
    };
    statusCache = { at: started, status };
    return status;
  } catch (error) {
    const status: VTToolsStatus = {
      online: false,
      toolCount: 0,
      tools: [],
      error: error instanceof Error ? error.message : String(error),
      checkedAt: new Date().toISOString(),
    };
    statusCache = { at: started, status };
    return status;
  } finally {
    session?.close();
  }
}

/** 调一个 VT 工具（随用随起一个新会话）。给 AI 喂证据用。 */
export async function callVTTool(name: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<string> {
  const session = new VTSession(timeoutMs);
  try {
    await session.handshake(Math.min(timeoutMs, 20_000));
    return await session.callTool(name, args, timeoutMs);
  } finally {
    session.close();
  }
}
