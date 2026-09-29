/**
 * 这个文件是干什么的：
 * 读服务器环境变量，并判断现在是工作区预览还是已经发布的网站。
 *
 * 你需要知道的：
 * 日常选股不用改这里。
 */

export function env(key: string): string | undefined {
  const v = process.env[key]?.trim();
  return v || undefined;
}

/**
 * Workspace preview vs deployed app. The deployer writes GROK_PROJECT_ID on
 * every publish; the sandbox preview never has it. Single source of truth for
 * the split — gate audience, gate endpoints and connector-token semantics all
 * key off this predicate.
 */
export function isWorkspacePreview(): boolean {
  return !env("GROK_PROJECT_ID");
}
