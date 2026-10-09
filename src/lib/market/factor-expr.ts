/**
 * 这个文件是干什么的：
 * 把一个**算数表达式字符串**编译成 (MetricRow) => number | null 的因子取值函数。
 * AI 提新因子时只许写表达式（如 "std20 / amp20"、"abs(d60) * volShrink"），
 * 不许写代码——这个文件就是表达式和代码之间的防火墙。
 *
 * 你需要知道的：
 * 1. **没有 eval / new Function**。用 Shunting-yard 手工解析成 token 再算，
 *    白名单之外的标识符直接编译失败。表达式只是数据，永远不可能是代码。
 * 2. 白名单 = MetricRow 的全部数值字段 + 三个函数 abs/log/sqrt + 四则运算和
 *    括号 + 数字字面量。想加函数或字段，改这个文件的白名单，别放宽解析器。
 * 3. 任何一个操作数是 null（数据不够），或出现 除零 / 负数开方 / 非数，
 *    结果就是 null——和 MetricRow 里「数据不够是 null 不是 0」同一约定。
 *    分档时 null 会被丢弃，不会被当成 0 混进最低档。
 * 4. 纯函数、零依赖，直接单测。
 *
 * 纪律：表达式再花哨，输入仍然只有第 t 天及之前的 OHLCV 指标——无前视铁律
 * 在表达式这一层天然成立，因为 MetricRow 本身就不含未来。
 */

import type { MetricRow } from "./factors.ts";

/** 表达式里允许出现的变量名（= MetricRow 的数值字段，一字对应）。 */
const VARS: (keyof MetricRow)[] = [
  "c",
  "prev",
  "open",
  "low",
  "prevLow",
  "chg",
  "d5",
  "d10",
  "d20",
  "d60",
  "momAccel",
  "rsi14",
  "bias20",
  "std20",
  "std60",
  "amp20",
  "corrVRet",
  "shrinkDays",
  "distHigh20",
  "distLow60",
  "bollB",
  "rangePos20",
  "volRatio",
  "volShrink",
  "amountWan",
  "turnover",
  "floatCap",
  "lowerWick",
  "volCompress",
  "downStreak",
  "springStrength",
  "springAge",
  "springLow",
  "springRangeHigh",
];

/** 表达式里允许出现的函数。键是名字，值是 (x)=>y，定义域外的输入返回 NaN。
 *  查成员必须用 Object.hasOwn——FUNCS["constructor"] 会命中 Object.prototype，
 *  白名单形同虚设（factor-expr 测试里「constructor」用例就是钉这个的）。 */
const FUNCS: Record<string, (x: number) => number> = {
  abs: Math.abs,
  log: (x) => (x > 0 ? Math.log(x) : NaN),
  sqrt: (x) => (x >= 0 ? Math.sqrt(x) : NaN),
};

type Tok =
  | { kind: "num"; v: number }
  | { kind: "var"; name: string }
  | { kind: "func"; name: string }
  | { kind: "op"; op: "+" | "-" | "*" | "/" }
  | { kind: "lparen" }
  | { kind: "rparen" };

/** 逆波兰式里多一种一元负号（解析期生成，词法层不存在）。 */
type RpnTok = Tok | { kind: "op"; op: "u-" };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\t") {
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j += 1;
      const raw = src.slice(i, j);
      const v = Number(raw);
      if (!Number.isFinite(v) || raw.split(".").length > 2) throw new Error(`数字「${raw}」不合法`);
      toks.push({ kind: "num", v });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      const name = src.slice(i, j);
      if ((VARS as string[]).includes(name)) toks.push({ kind: "var", name });
      else if (Object.hasOwn(FUNCS, name)) toks.push({ kind: "func", name });
      else throw new Error(`「${name}」不在白名单里（只许用 MetricRow 字段和 abs/log/sqrt）`);
      i = j;
      continue;
    }
    if (ch === "+" || ch === "-" || ch === "*" || ch === "/") {
      toks.push({ kind: "op", op: ch });
      i += 1;
      continue;
    }
    if (ch === "(") {
      toks.push({ kind: "lparen" });
      i += 1;
      continue;
    }
    if (ch === ")") {
      toks.push({ kind: "rparen" });
      i += 1;
      continue;
    }
    throw new Error(`无法识别的字符「${ch}」`);
  }
  return toks;
}

/** 二元优先级；一元负号用 "u-"，优先级最高。 */
const PREC: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2, "u-": 3 };

/** Shunting-yard → 逆波兰式。同时检查：函数后面必须紧跟括号、括号配对、空表达式。 */
function toRpn(toks: Tok[]): RpnTok[] {
  const out: RpnTok[] = [];
  const ops: RpnTok[] = [];
  let expectOperand = true; // 出现在「期望操作数」位置的正负号是一元符号，不是二元运算
  for (const tok of toks) {
    if (tok.kind === "num" || tok.kind === "var") {
      out.push(tok);
      expectOperand = false;
    } else if (tok.kind === "func") {
      ops.push(tok);
      expectOperand = true; // 函数后面必须跟 (，lparen 分支会处理
    } else if (tok.kind === "op") {
      if (expectOperand) {
        // 一元符号位
        if (tok.op === "-") ops.push({ kind: "op", op: "u-" });
        else if (tok.op === "+") continue;
        else throw new Error("「*」「/」不能当一元符号用");
        continue;
      }
      let last = ops[ops.length - 1];
      while (last && last.kind === "op" && PREC[last.op] >= PREC[tok.op]) {
        out.push(ops.pop() as Tok);
        last = ops[ops.length - 1];
      }
      ops.push(tok);
      expectOperand = true;
    } else if (tok.kind === "lparen") {
      ops.push(tok);
      expectOperand = true;
    } else {
      // rparen：弹到配对的 lparen
      let found = false;
      while (ops.length > 0) {
        const top = ops.pop() as Tok;
        if (top.kind === "lparen") {
          found = true;
          break;
        }
        out.push(top);
      }
      if (!found) throw new Error("括号不配对：多了右括号");
      // 配对成功后 op 栈顶若是 func（如 abs(...) 整体作为操作数），弹出应用
      const maybeFunc = ops[ops.length - 1];
      if (maybeFunc?.kind === "func") out.push(ops.pop() as Tok);
      expectOperand = false;
    }
  }
  if (expectOperand) throw new Error("表达式结尾不完整（可能少了一个操作数）");
  while (ops.length > 0) {
    const top = ops.pop() as Tok;
    if (top.kind === "lparen") throw new Error("括号不配对：多了左括号");
    if (top.kind === "func") throw new Error("函数后面缺括号");
    out.push(top);
  }
  if (out.length === 0) throw new Error("表达式是空的");
  return out;
}

/**
 * 编译表达式。失败抛 Error（消息给人看），成功返回求值函数。
 * 求值：任何 null 操作数 / 除零 / 越定义域 / 非数 → 返回 null。
 */
export function compileFactorExpr(src: string): (m: MetricRow) => number | null {
  const rpn = toRpn(tokenize(src));
  return (m: MetricRow): number | null => {
    const stack: number[] = [];
    for (const tok of rpn) {
      if (tok.kind === "num") stack.push(tok.v);
      else if (tok.kind === "var") {
        const v = m[tok.name as keyof MetricRow];
        if (v == null || typeof v !== "number") return null; // 数据不够 → null，不硬算
        stack.push(v);
      } else if (tok.kind === "func") {
        const x = stack.pop();
        if (x === undefined) return null;
        stack.push(FUNCS[tok.name](x));
      } else if (tok.kind === "op" && tok.op === "u-") {
        const a = stack.pop();
        if (a === undefined) return null;
        stack.push(-a);
      } else if (tok.kind === "op") {
        const b = stack.pop();
        const a = stack.pop();
        if (a === undefined || b === undefined) return null;
        stack.push(tok.op === "+" ? a + b : tok.op === "-" ? a - b : tok.op === "*" ? a * b : a / b);
      } else {
        return null; // lparen / rparen 不可能出现在逆波兰式里，防御
      }
    }
    const v = stack.pop();
    if (v === undefined || !Number.isFinite(v)) return null;
    return v;
  };
}

/** 编译 + 试算一行全零指标，提前抓出「语法对但全 null」的废表达式。 */
export function validateFactorExpr(src: string): { ok: true; get: (m: MetricRow) => number | null } | { ok: false; error: string } {
  try {
    const get = compileFactorExpr(src);
    return { ok: true, get };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
