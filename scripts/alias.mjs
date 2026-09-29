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
