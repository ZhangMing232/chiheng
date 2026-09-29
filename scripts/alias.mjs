/**
 * 这个文件是干什么的：
 * 让别的脚本可以用 @/ 这种简写，去找到 src 目录里的代码。
 *
 * 你需要知道的：
 * 日常选股不用改这里。
 */

import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const url = new URL(`../src/${specifier.slice(2)}.ts`, import.meta.url);
      return nextResolve(url.href, context);
    }
    return nextResolve(specifier, context);
  },
});
