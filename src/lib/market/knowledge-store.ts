/**
 * 这个文件是干什么的：
 * 知识档案的落盘（对标 Vibe-Research 的 knowledge/companies/）。
 *
 * 你需要知道的：
 * - **一只票一份快照**（data/knowledge/<userId>/<symbol>.json），新的覆盖旧的——
 *   档案是「当前认知」不是流水账。被覆盖的结论通过 manifest 的裁决记录留痕。
 * - **每人一份**：开放注册后，A 研判茅台的结论不能被 B 的研判覆盖，B 也看不到
 *   A 的知识快照。旧的全局 `data/knowledge/<symbol>.json` 只复制给 dev-user
 *   （留原文件不动），新用户没有档案。
 * - 写入原子化（临时名带 pid+随机数），同 watchlist.ts 的理由。
 * - data/ 不在 git，换机器档案不跟过来。
 * - 用户 id 白名单与 book-file.ts 的 safeUserId 同规则；这里不 import 那个文件，
 *   是为了不让 node:fs 链路有进客户端 bundle 的机会（同 notes-store.ts 的理由）。
 */

import type { KnowledgeFile } from "./knowledge.ts";

/**
 * ⚠️ 浏览器兼容（2026-10-25，同类坑第三次）：
 * 顶层 import node: 内置模块会被 vite 转成空壳桩顶层解构，模块一求值就抛
 * 「Module externalized」→ hydration 跑不了 → 整站按钮失灵（页面能看、点不动）。
 * 本文件经 research.tsx 路由文件静态引用（routeTree 静态引全部路由），
 * node API 必须函数内动态 import；路径拼接用 posixJoin 替代 node:path。
 * 文件头原话「不让 node:fs 链路有进客户端 bundle 的机会」——顶层 import 它
 * 就是在给这个机会，惰性化才是说到做到。
 */
const fsApi = () => import("node:fs/promises");
const cryptoApi = () => import("node:crypto");
/** POSIX 风格拼路径。不用 node:path——顶层 import 它同样会在客户端崩（见文件头）。 */
const posixJoin = (...parts: string[]): string => parts.join("/");

/** 未开登录时的本机主人，和 book-file.ts 的 OWNER_ID 同值（不 import，见文件头）。 */
const LEGACY_OWNER_ID = "dev-user";

/** 用户 id 只允许字母、数字、下划线和减号（与 book-file.ts safeUserId 同规则）。 */
function safeUserId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error("无效的用户");
  return id;
}

/** 标的编号只许字母数字（带市场前缀的 sh600519 / hk00700 这类），挡住 ../。 */
function safeSymbol(symbol: string): string {
  if (!/^[A-Za-z0-9]{1,20}$/.test(symbol)) throw new Error(`无效的标的编号：${symbol}`);
  return symbol;
}

/** 某人的档案目录。 */
function dir(userId: string, root: string): string {
  return posixJoin(root, "data", "knowledge", safeUserId(userId));
}

/** 注册开放前的旧全局档案目录。只用于一次性复制给主人。 */
function legacyDir(root: string): string {
  return posixJoin(root, "data", "knowledge");
}

function pathFor(symbol: string, userId: string, root: string): string {
  return posixJoin(dir(userId, root), `${safeSymbol(symbol)}.json`);
}

/**
 * 旧全局档案 → 主人（dev-user）的一次性迁移：把 data/knowledge/ 顶层
 * 的 *.json 复制进 data/knowledge/dev-user/。只复制不搬走——旧文件留着
 * 无副作用，复制失败下次再试。只迁给主人：新注册用户从空档案开始。
 */
async function migrateLegacy(userId: string, root: string): Promise<void> {
  if (userId !== LEGACY_OWNER_ID) return;
  const { copyFile, mkdir, readdir } = await fsApi();
  let names: string[];
  try {
    names = await readdir(legacyDir(root));
  } catch {
    return;
  }
  const files = names.filter((n) => n.endsWith(".json"));
  if (files.length === 0) return;
  try {
    await mkdir(dir(userId, root), { recursive: true });
    for (const name of files) {
      const target = posixJoin(dir(userId, root), name);
      try {
        await copyFile(posixJoin(legacyDir(root), name), target);
      } catch {
        /* 单个失败不阻塞其他 */
      }
    }
  } catch {
    /* 下次再试 */
  }
}

/** 读某人一只票的档案。没有返回 null。 */
export async function loadKnowledge(symbol: string, userId: string, root = process.cwd()): Promise<KnowledgeFile | null> {
  const sym = safeSymbol(symbol);
  const id = safeUserId(userId);
  const { readFile } = await fsApi();
  try {
    const parsed = JSON.parse(await readFile(pathFor(sym, id, root), "utf-8")) as KnowledgeFile;
    if (!parsed || typeof parsed.symbol !== "string" || !Array.isArray(parsed.points)) return null;
    return parsed;
  } catch {
    await migrateLegacy(id, root);
    try {
      const parsed = JSON.parse(await readFile(pathFor(sym, id, root), "utf-8")) as KnowledgeFile;
      if (!parsed || typeof parsed.symbol !== "string" || !Array.isArray(parsed.points)) return null;
      return parsed;
    } catch {
      return null;
    }
  }
}

/** 覆盖写某人一只票的档案。 */
export async function saveKnowledge(file: KnowledgeFile, userId: string, root = process.cwd()): Promise<string> {
  const { mkdir, rename, writeFile } = await fsApi();
  const { randomInt } = await cryptoApi();
  const id = safeUserId(userId);
  const target = pathFor(file.symbol, id, root);
  await mkdir(dir(id, root), { recursive: true });
  const tmp = posixJoin(dir(id, root), `.knowledge.${process.pid}.${randomInt(1e9).toString(36)}.tmp`);
  await writeFile(tmp, JSON.stringify(file, null, 1), "utf-8");
  await rename(tmp, target);
  return target;
}
