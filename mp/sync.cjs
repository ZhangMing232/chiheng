/**
 * 这个文件是干什么的：
 * 把编译好的 lib 同步到该去的地方——小程序前端一份，每个云函数各一份。
 *
 * 为什么要各一份：
 * 云函数上传时只上传**自己那个目录**，不能 require 上级目录的东西。
 * 所以每个云函数都得有自己的副本，改完 lib 必须重新同步，不然线上跑的是旧的。
 *
 * 用法：node mp/sync.cjs
 */
const fs = require("fs");
const path = require("path");

const root = __dirname;
const from = path.join(root, "build/market");
if (!fs.existsSync(from)) {
  console.error("还没有 build/，先跑：node_modules/.bin/tsc -p mp/tsconfig.json");
  process.exit(1);
}

function syncTo(dir) {
  const to = path.join(dir, "market");
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
  return to;
}

const targets = [path.join(root, "miniprogram/lib")];
const cfRoot = path.join(root, "cloudfunctions");
if (fs.existsSync(cfRoot)) {
  for (const name of fs.readdirSync(cfRoot)) {
    const dir = path.join(cfRoot, name);
    if (fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, "index.js"))) targets.push(dir);
  }
}

for (const t of targets) {
  const to = syncTo(t);
  const n = fs.readdirSync(to, { recursive: true }).filter((f) => f.endsWith(".js")).length;
  console.log("已同步", n, "个 js →", path.relative(root, to));
}
