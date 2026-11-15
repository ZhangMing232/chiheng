/**
 * 这个文件是干什么的：
 * 东财数据源统一取数包装器（2026-11-15 数据源加固）。
 *
 * 为什么要有它：registry 里 36 个端点有 20 个来自东财（56%），原先各文件各写
 * 各的 fetch——UA、超时、重试、错误处理全不一致，WAF/限流一抖就大面积断粮，
 * 而且页面照常显示旧数据没有任何预警。统一到这一层后：
 *   1. 网络错 / 超时 / 5xx / 429 都退避重试（每次独立 AbortSignal，
 *      复用已 abort 的 signal 会让第二次立即失败——11-15 复检踩过）；
 *   2. 连续失败计数落盘 data/eastmoney-health.json，settings 体检页点亮「东财通道」；
 *   3. 成功把计数清零；
 *   4. 所有东财端点共用一个 referer / UA / 超时口径。
 *
 * 纪律：这是**取数层**，不碰判决、不改数据口径；失败返回 null 由调用方
 * 按既有「读不到不补 0」原则处理。node API 函数内动态 import（浏览器兼容铁律）。
 *
 * 纯函数（重试判定、健康状态机）零 IO，直接单测；见 eastmoney-fetch.test.ts。
 */

const fsApi = () => import("node:fs/promises");
const posixJoin = (...parts: string[]): string => parts.join("/");

function dataDir(): string {
  return process.env.CHIHENG_DATA_DIR ?? posixJoin(process.cwd(), "data");
}

const healthPath = () => posixJoin(dataDir(), "eastmoney-health.json");

/** 默认请求参数。东财对 referer 有检查，统一带上。 */
export const EM_DEFAULT_HEADERS: Record<string, string> = {
  "user-agent": "Mozilla/5.0",
  referer: "https://data.eastmoney.com/",
};

/** 判定一次响应是否需要重试（纯函数，可单测）。 */
export function shouldRetry(status: number): boolean {
  return status >= 500 || status === 429;
}

/** 健康状态：连续失败达到阈值才降级，一次抖动不误报（纯函数，可单测）。 */
export type EmHealth = {
  consecutiveFailures: number;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
};

export const EM_FAILURE_THRESHOLD = 3;

export function healthAfter(prev: EmHealth, ok: boolean, at: string, error: string | null = null): EmHealth {
  if (ok) {
    return { ...prev, consecutiveFailures: 0, lastSuccessAt: at, lastError: null };
  }
  return {
    ...prev,
    consecutiveFailures: prev.consecutiveFailures + 1,
    lastFailureAt: at,
    lastError: error,
  };
}

export function isDegraded(h: EmHealth | null): boolean {
  return (h?.consecutiveFailures ?? 0) >= EM_FAILURE_THRESHOLD;
}

/** 读健康账。文件不存在/损坏 = 干净状态（不编）。 */
export async function readEmHealth(): Promise<EmHealth | null> {
  try {
    const { readFile } = await fsApi();
    const parsed = JSON.parse(await readFile(healthPath(), "utf8")) as Partial<EmHealth>;
    if (typeof parsed.consecutiveFailures === "number") {
      return {
        consecutiveFailures: parsed.consecutiveFailures,
        lastFailureAt: typeof parsed.lastFailureAt === "string" ? parsed.lastFailureAt : null,
        lastSuccessAt: typeof parsed.lastSuccessAt === "string" ? parsed.lastSuccessAt : null,
        lastError: typeof parsed.lastError === "string" ? parsed.lastError : null,
      };
    }
  } catch {
    return null;
  }
  return null;
}

async function writeEmHealth(h: EmHealth): Promise<void> {
  try {
    const { mkdir, writeFile, rename } = await fsApi();
    await mkdir(dataDir(), { recursive: true });
    const tmp = `${healthPath()}.tmp`;
    await writeFile(tmp, JSON.stringify(h, null, 2));
    await rename(tmp, healthPath());
  } catch {
    // 健康账写失败不该把取数本身炸掉。
  }
}

/** 记一次成功/失败（供包装器与 preflight 探源共用）。 */
export async function recordEmOutcome(ok: boolean, error: string | null = null): Promise<void> {
  const prev = (await readEmHealth()) ?? { consecutiveFailures: 0, lastFailureAt: null, lastSuccessAt: null, lastError: null };
  await writeEmHealth(healthAfter(prev, ok, new Date().toISOString(), error));
}

export type EmFetchOptions = {
  /** 覆盖默认 headers（会与默认合并，同名覆盖）。 */
  headers?: Record<string, string>;
  /** 单次超时（毫秒）。 */
  timeoutMs?: number;
  /** 重试次数（默认 1）。 */
  retries?: number;
  /** 退避毫秒（默认 3000）。 */
  backoffMs?: number;
  /** 自定义 fetch（测试注入用；生产走全局 fetch）。 */
  fetchImpl?: typeof fetch;
};

export type EmFetchResult = { ok: true; res: Response } | { ok: false; error: string };

/**
 * 统一取数。返回 `{ ok:true, res }` 或 `{ ok:false, error }`，**不抛异常**——
 * 调用方按既有「读不到返回 missing」处理，不让一个源把整页炸掉。
 */
export async function eastmoneyFetch(url: string, opts: EmFetchOptions = {}): Promise<EmFetchResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const retries = opts.retries ?? 1;
  const backoffMs = opts.backoffMs ?? 3_000;
  const headers = { ...EM_DEFAULT_HEADERS, ...(opts.headers ?? {}) };

  const attempt = () => doFetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  let lastError = "未知错误";
  for (let i = 0; i <= retries; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, backoffMs));
    try {
      const res = await attempt();
      if (res.ok) {
        await recordEmOutcome(true);
        return { ok: true, res };
      }
      lastError = `HTTP ${res.status}`;
      if (!shouldRetry(res.status) || i === retries) break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (i === retries) break;
    }
  }
  await recordEmOutcome(false, lastError);
  return { ok: false, error: lastError };
}
