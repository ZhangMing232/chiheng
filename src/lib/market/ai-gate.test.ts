/**
 * AI 总开关的底层收口测试（2026-11-16 架构整改）。
 *
 * 核心不变量：**off 时 callAI / callAIWithFallback 不发任何 HTTP、不记任何账**。
 * 这是 union 闸门——不管上层入口有没有检查，底层这一关必须兜住。
 * 今天下午 research/debate 的 GET loader 绕过上层闸烧了 ¥13，就是底层没闸的后果。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "aigate-"));
  const prev = process.env.CHIHENG_DATA_DIR;
  process.env.CHIHENG_DATA_DIR = dir;
  try {
    await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.CHIHENG_DATA_DIR;
    else process.env.CHIHENG_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

test("总开关 off 时 callAI 直接抛错，不发 HTTP", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "agent-master-switch.json"), JSON.stringify({ enabled: false, at: "" }));
    let requests = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      requests++;
      return new Response('{"choices":[{"message":{"content":"x"}}]}', { status: 200 });
    }) as typeof fetch;
    try {
      const { callAI } = await import("./factor-queue.ts");
      await assert.rejects(
        callAI(
          { id: "x", baseUrl: "https://example.test", apiKey: "k", model: "m" } as never,
          "prompt",
        ),
        /总开关/,
      );
      assert.equal(requests, 0, "off 时不该有任何 HTTP 请求");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("总开关 off 时 callAIWithFallback 也直接抛错（即使桥接路也不发）", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "agent-master-switch.json"), JSON.stringify({ enabled: false, at: "" }));
    let requests = 0;
    const originalFetch = globalThis.fetch;
    const prevDsh = process.env.CHIHENG_DSH_URL;
    process.env.CHIHENG_DSH_URL = "http://127.0.0.1:19999";
    globalThis.fetch = (async () => {
      requests++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const { callAIWithFallback } = await import("./factor-queue.ts");
      await assert.rejects(callAIWithFallback("prompt"), /总开关/);
      assert.equal(requests, 0, "off 时连桥接都不该请求");
    } finally {
      globalThis.fetch = originalFetch;
      if (prevDsh === undefined) delete process.env.CHIHENG_DSH_URL;
      else process.env.CHIHENG_DSH_URL = prevDsh;
    }
  });
});

test("总开关 on 时不会被底层闸拦（闸只认明确关闭/损坏）", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "agent-master-switch.json"), JSON.stringify({ enabled: true, at: "" }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        { status: 200 },
      )) as typeof fetch;
    try {
      const { callAI } = await import("./factor-queue.ts");
      const text = await callAI(
        { id: "x", baseUrl: "https://example.test", apiKey: "k", model: "m" } as never,
        "prompt",
      );
      assert.equal(text, "ok");
      // 确认记了账（on 时正常走记账）
      const usageRaw = await readFile(join(dir, "ai-usage.json"), "utf8").catch(() => "{}");
      assert.ok(usageRaw.includes("prompt_tokens") || usageRaw.includes("promptTokens") || usageRaw.includes("totalTokens"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("开闸后关闸：同一进程内每次调用都重读开关（不缓存）", async () => {
  await withTempDir(async (dir) => {
    const p = join(dir, "agent-master-switch.json");
    await writeFile(p, JSON.stringify({ enabled: true, at: "" }));
    const { isAgentOn } = await import("./agent-jobs.ts");
    assert.equal(await isAgentOn(), true);
    await writeFile(p, JSON.stringify({ enabled: false, at: "" }));
    assert.equal(await isAgentOn(), false, "关闸要立刻生效");
    await writeFile(p, JSON.stringify({ enabled: true, at: "" }));
    assert.equal(await isAgentOn(), true, "开闸也要立刻生效");
  });
});

test("总开关 off 时 callDSH（桥接出口）也不发 HTTP——覆盖对话/海报/因子表达式", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "agent-master-switch.json"), JSON.stringify({ enabled: false, at: "" }));
    let requests = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      requests++;
      return new Response('{"ok":true,"text":"x"}', { status: 200 });
    }) as typeof fetch;
    try {
      const { callDSH } = await import("./chiheng-dsh-client.ts");
      await assert.rejects(callDSH("prompt"), /总开关/);
      assert.equal(requests, 0, "off 时桥接也不该有请求");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
