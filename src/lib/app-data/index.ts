/**
 * 这个文件是干什么的：
 * 连接器相关功能的对外入口，把类型、登录判断和错误分类从这里再导出。
 *
 * 你需要知道的：
 * 日常选股不用改这里。
 */

export {
  CONNECTOR_TOKEN_HEADER,
  ConnectorType,
  GoogleCalendarTools,
  GoogleDriveTools,
} from "./types.ts";
export type {
  CallToolOptions,
  CallToolResult,
  ConnectorTypeName,
  ToolArgs,
} from "./types.ts";
export {
  isConnectorPending,
  isLoginRequired,
  redirectToLoginIfRequired,
} from "./login.ts";
export { classifyCallToolError } from "./errors.ts";
export type { CallToolErrorKind, CallToolErrorState } from "./errors.ts";
export { useRefetchWhenConnectorReady } from "./use-connector-readiness.ts";
export type { ConnectorWaitStatus } from "./use-connector-readiness.ts";
