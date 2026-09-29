/**
 * 这个文件是干什么的：
 * 给页面用的一个服务器函数：外部连接的令牌现在能不能用。
 *
 * 你需要知道的：
 * 日常选股不用改这里。
 */

import { createServerFn } from "@tanstack/react-start";

export type ConnectorReadiness = { ready: boolean };

export const getConnectorReadiness = createServerFn({ method: "POST" }).handler(
  async (): Promise<ConnectorReadiness> => {
    const { isConnectorTokenReady } = await import("./client.server.ts");
    return { ready: isConnectorTokenReady() };
  },
);
