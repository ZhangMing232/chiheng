/**
 * 这个文件是干什么的：
 * 防止有人在浏览器里误用只能在服务器跑的连接器代码。
 *
 * 你需要知道的：
 * 日常选股不用改这里。
 */

export function assertAppDataServerOnly(
  context = "app-data/client.server",
): void {
  if (typeof window !== "undefined") {
    throw new Error(
      `@/lib/${context} is server-only. Call connector tools from a createServerFn handler (dynamic import of @/lib/app-data/client.server), never from a React component, useEffect, or browser fetch. Types and login helpers are client-safe via @/lib/app-data.`,
    );
  }
}

assertAppDataServerOnly("app-data/client.server");
