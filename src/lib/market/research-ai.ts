/**
 * 这个文件是干什么的：
 * 研判页的 AI 综合——把六阶段摆出来的证据交给 AI，让它写一段「综合观察」，
 * 然后**逐道过闸**：红线 → 数字闸门 → 证据层记账。
 *
 * 你需要知道的（纪律）：
 *
 * 1. **AI 调用是注入的，不是 import 的**。这个文件只接受一个
 *    `(prompt) => Promise<string>`，不 import callAI、不碰网络、不读档案。
 *    好处有两个：测试能注入假 AI（不联网、不烧 token、不依赖 key 通不通）；
 *    页面那边调用失败也只降级这一块，不会把整页拖垮。
 *
 * 2. **三道闸的顺序不能换**。红线先拦（动作建议一律不许出），数字闸门再拦
 *    （材料里没有的数字换成（略※）），最后证据层记账（它引用了哪些证据要留痕）。
 *    先过数字闸门的话，被红线拦掉的句子里的数字也白拦一遍。
 *
 * 3. **AI 没出声是正常状态，不是错误**。超时、报错、返回解析不了，都降级成
 *    `status: "failed"` + 一句人话原因，页面照常显示规则推出来的结论。
 *    **不许假装有 AI 参与**——那是造假。
 *
 * 4. **AI 引用的证据 id 要留痕**。解析出来的 refs 会成为一条 calculation 的
 *    inputsRefs，事后能查「AI 这句话是基于哪几条证据说的」。
 */

import type { StageResult } from "./research.ts";
import { screenAdvice } from "./red-line.ts";
import { screenNumbers } from "./number-gate.ts";
import { makeCalculation, formatChain } from "./evidence.ts";
import { RED_LINE_PROMPT } from "./red-line.ts";
import { VALUATION_SOP } from "./valuation-sop.ts";
import { CATALYST_SOP } from "./catalyst-sop.ts";
import { EARNINGS_SOP } from "./earnings-sop.ts";

/** 调 AI 的那个函数。由调用方提供（页面 loader 里接 callAI + 记账）。 */
export type AiCaller = (prompt: string) => Promise<string>;

export type AiSynthesis = {
  status:
    /** AI 出声了，且过了所有闸 */
    | "ok"
    /** AI 想给投资建议，被红线拦下 */
    | "refused"
    /** 调用失败/超时/解析不了。页面降级，不假装有 AI */
    | "failed"
    /** 没配 AI 或没注入 caller，本轮不调 */
    | "skipped";
  /** 过完闸的文本。null = 这一轮没有可用的话 */
  text: string | null;
  /** 没出声的原因，给人看的一句人话 */
  why: string | null;
  /** 被红线拦下的条数 */
  blocked: number;
  /** 被数字闸门换掉的数字个数 */
  numbersReplaced: number;
  /** AI 引用到的证据 id（它自己声明 + 文本里出现的都算） */
  refs: string[];
  /** 引用链的人话版；null = 没有可用产出 */
  chain: string | null;
  /** 耗时，给页面显示「等了多久」 */
  ms: number;
};

/** 综合观察的字数上限。写进 prompt，超长了说明它没读懂「简洁」两个字。 */
export const AI_SUMMARY_MAX_CHARS = 220;

/** 把所有阶段摆出来的证据摊平，prompt 和数字闸门共用同一份。 */
export function collectEvidence(stages: readonly StageResult[]): { id: string; line: string }[] {
  const out: { id: string; line: string }[] = [];
  for (const stage of stages) {
    for (const e of stage.evidence) out.push({ id: `ev-${stage.id}-${e.label}`, line: `[${stage.title}] ${e.label} = ${e.value}（${e.source}）` });
    for (const d of stage.derived) out.push({ id: d.evidenceId, line: `[${stage.title}] ${d.label} = ${d.value}` });
  }
  return out;
}

/**
 * 组 prompt。
 *
 * 证据逐条带 id 是故意的：AI 要能指名道姓地说「根据 ev-xxx」，事后才查得动。
 * 不给 id 它就只能含糊其辞，读者也无法核对。
 */
export function buildResearchPrompt(stages: readonly StageResult[], symbol: string, name: string): string {
  const evidence = collectEvidence(stages);
  const lines = evidence.map((e) => `- ${e.id}: ${e.line}`).join("\n");
  return [
    `你是赤轨的个股研判助理。标的：${name}（${symbol || "未知"}）。`,
    ``,
    `下面是六阶段已经摆出来的证据，每条带 id：`,
    lines || `（这一轮没有任何证据）`,
    ``,
    `要求：`,
    `1. 只根据上面的证据写一段不超过 ${AI_SUMMARY_MAX_CHARS} 字的综合观察`,
    `2. 引用证据时写明它的 id；引用不到的结论不要写`,
    `3. 数字只能来自证据，不许自己编；材料里没有的数就不要提`,
    `4. 不许给买卖建议、目标价、止损位、仓位建议`,
    `5. 只输出 JSON，不要别的内容：{"refs": ["ev-xxx"], "text": "..."}`,
    ``,
    VALUATION_SOP,
    ``,
    CATALYST_SOP,
    ``,
    EARNINGS_SOP,
    ``,
    RED_LINE_PROMPT,
  ].join("\n");
}

/** 从 AI 输出里解析 refs 和正文。解析不了就整体当正文、refs 为空（并说明）。 */
export function parseAiOutput(raw: string): { refs: string[]; text: string; parsed: boolean } {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(trimmed.slice(start, end + 1)) as { refs?: unknown; text?: unknown };
      const refs = Array.isArray(obj.refs) ? obj.refs.filter((r): r is string => typeof r === "string") : [];
      const text = typeof obj.text === "string" ? obj.text : "";
      if (text) return { refs, text, parsed: true };
    } catch {
      /* 解析不了走下面的兜底 */
    }
  }
  return { refs: [], text: trimmed, parsed: false };
}

/**
 * 跑一次 AI 综合。
 *
 * @param caller 调 AI 的函数。null = 这一轮不调（没配档案 / 用户关掉了）
 * @param knownEvidenceIds 这一轮确实存在的证据 id。AI 声明引用了不存在的 id 会被剔掉
 */
export async function runAiSynthesis(
  stages: readonly StageResult[],
  symbol: string,
  name: string,
  caller: AiCaller | null,
  knownEvidenceIds?: readonly string[],
): Promise<AiSynthesis> {
  const base = { blocked: 0, numbersReplaced: 0, refs: [] as string[], chain: null as string | null };
  if (!caller) {
    return { ...base, status: "skipped", text: null, why: "这一轮没有可用的 AI 调用（未配置或已关闭）", ms: 0 };
  }

  const started = Date.now();
  let raw: string;
  try {
    raw = await caller(buildResearchPrompt(stages, symbol, name));
  } catch (error) {
    return {
      ...base,
      status: "failed",
      text: null,
      why: `AI 没接通：${error instanceof Error ? error.message : String(error)}`,
      ms: Date.now() - started,
    };
  }
  const ms = Date.now() - started;

  const parsed = parseAiOutput(raw);
  if (!parsed.text.trim()) {
    return { ...base, status: "failed", text: null, why: "AI 返回了空内容", ms };
  }

  // 声明了但证据层里没有的 id 剔掉——否则 inputsRefs 会出现悬空引用
  const known = new Set(knownEvidenceIds ?? []);
  const refs = parsed.refs.filter((r) => known.size === 0 || known.has(r));

  // 闸一：红线。整段命中就当「拒绝」，不出文本。
  const advice = screenAdvice(parsed.text);
  if (!advice.ok) {
    return {
      ...base,
      status: "refused",
      text: null,
      why: `AI 的回答命中红线：${advice.hits[0] ?? "疑似给出投资动作"}。赤轨不给买卖建议，这一句没有显示。`,
      refs,
      ms,
    };
  }

  // 闸二：数字闸门。材料 = 这一轮所有证据的值。
  const sources = collectEvidence(stages).map((e) => e.line);
  const screened = screenNumbers(parsed.text, sources);
  const numbersReplaced = screened.replaced.length;

  // 闸三：证据层记账。AI 综合本身是一条 calculation，输入是它引用的证据。
  const calc = makeCalculation({
    fn: "aiSynthesis",
    inputs: { model: "injected", refs: refs.length, chars: screened.text.length },
    inputsRefs: refs,
    output: { value: null, unit: "文本", status: "ok" },
  });

  const note = !parsed.parsed ? "（AI 没按要求的 JSON 回，已按纯文本处理，引用关系不可查）" : "";
  return {
    blocked: 0,
    numbersReplaced,
    refs,
    chain: formatChain(calc),
    status: "ok",
    text: screened.text + note,
    why: null,
    ms,
  };
}
