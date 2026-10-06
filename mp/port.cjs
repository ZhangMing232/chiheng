/**
 * 这个文件是干什么的：
 * 从 web 版 src/lib/market 重新生成 mp/src/market 的副本。
 *
 * 为什么要脚本化：
 * mp/src/market 里那 17 个文件是**拷贝**，不是引用。手工同步过一次之后，
 * 改了 web 版就很容易忘了两边不一致——而「小程序算出来的数和网页不一样」
 * 是这个项目最不能出的错（口径一旦分叉，实验台的结论就废了）。
 * 所以同步这件事必须能一键重做，而且 verify.cjs 会检查有没有漏。
 *
 * 什么时候跑：
 *   1. 改了 src/lib/market 下的文件之后
 *   2. verify.cjs 报「web 与 mp 副本对不上」的时候
 * 跑完接着执行：node_modules/.bin/tsc -p mp/tsconfig.json && node mp/sync.cjs && node mp/verify.cjs
 *
 * 跑不了的场景：mp 侧有且仅有的一处本地改动是 index-futures.ts 的 replaceAll →
 * split/join（老 iOS 的 JS 引擎没有 replaceAll）。这个改动会在重跑时被覆盖，
 * 所以脚本里显式再改一次。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src/lib/market");
const DST = path.join(__dirname, "src/market");

/** 要搬的文件。顺序无关，目录会自己建。 */
const FILES = [
  "action.ts", "data-status.ts", "flow.ts", "format.ts", "hotmoney.ts",
  "index-futures.ts", "journal-book.ts", "lab.ts", "model.ts", "news.ts",
  "positions.ts", "prefs.ts", "rules.ts", "session.ts", "strategies.ts", "types.ts",
];
const PROVIDERS = ["index.ts", "shared.ts", "sina.ts", "tencent.ts", "eastmoney.ts"];

/**
 * 把 web 版的 import 改写成小程序能解析的形式。只有三类改写：
 *   @/lib/market/providers/X → ./providers/X（providers 目录里是 ../providers/X）
 *   @/lib/market/X           → ./X
 *   @/lib/paper              → ./paper-types（zustand 那个 store 不搬，只搬类型）
 * 外加去掉相对导入的 .ts 后缀。**不碰任何逻辑。**
 */
function rewrite(source, inProvidersDir) {
  // providers/ 里的文件在 mp 侧也是 providers/ 子目录，所以 ../ 才指回 market/ 根
  const up = inProvidersDir ? "../" : "./";
  return source
    .replace(/@\/lib\/market\/providers\//g, up + "providers/")
    .replace(/@\/lib\/market\//g, up)
    .replace(/@\/lib\/paper/g, inProvidersDir ? "../paper-types" : "./paper-types")
    .replace(/(from\s+["']\.[^"']*?)\.ts(["'])/g, "$1$2");
}

/** mp 侧唯一允许的本地改动：小程序跑在别人的 JS 引擎里，不赌它有 ES2021 的方法。 */
function applyLocalPatches(name, source) {
  if (name !== "index-futures.ts") return source;
  return source.replace(
    'return date.replaceAll("-", "");',
    '// 不用 replaceAll：那是 ES2021 的方法，老一点的 iOS JSCore 上没有，\n' +
      "  // 小程序跑在别人的引擎里，别赌。split/join 的语义一样，哪儿都能跑。\n" +
      '  return date.split("-").join("");',
  );
}

function port(from, to, inProvidersDir) {
  const source = fs.readFileSync(from, "utf8");
  const out = applyLocalPatches(path.basename(from), rewrite(source, inProvidersDir));
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, out, "utf8");
  return out;
}

function run() {
  let n = 0;
  for (const f of FILES) {
    port(path.join(SRC, f), path.join(DST, f), false);
    n += 1;
  }
  for (const f of PROVIDERS) {
    port(path.join(SRC, "providers", f), path.join(DST, "providers", f), true);
    n += 1;
  }
  console.log(`已从 web 版重新生成 ${n} 个文件 → ${path.relative(ROOT, DST)}`);
}

if (require.main === module) run();

// 供 verify.cjs 调用：算出「应该是什么」，用来比对现有副本有没有漂移。
// rel 是相对 market/ 的路径，例如 "lab.ts" 或 "providers/sina.ts"。
module.exports = {
  rel: FILES.concat(PROVIDERS.map((f) => `providers/${f}`)),
  expected(rel) {
    return applyLocalPatches(path.basename(rel), rewrite(fs.readFileSync(path.join(SRC, rel), "utf8"), rel.startsWith("providers/")));
  },
};
