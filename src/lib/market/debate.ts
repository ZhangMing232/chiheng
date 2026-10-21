/**
 * 这个文件是干什么的：
 * 多空辩论——**同一份证据，正反双方各写一组「裁决点」**，并排给读者看。
 *
 * 和 Vibe-Research 的 `/debate` 的区别要说清：它那边是两个角色自由辩论，
 * 赤轨这边**双方都只许给「什么事实出现会让当前判断站不住」**，不许给买卖建议。
 * 理由很直接：辩论的目的不是让读者知道该买还是该卖（那违反 AI-BOUNDARY），
 * 而是让读者看到**同一批证据能被读出两种完全相反的走向**，从而自己判断该盯什么。
 *
 * 你需要知道的（纪律）：
 * 1. **双方共用同一份证据**。不许给某一方额外的材料——那样辩的不是同一件事。
 * 2. **三道闸双方都要过**：红线 → 数字闸门 → 证据层记账。哪一方越线，那一方
 *    整段不出，并说明原因。不搞「一边合规一边放过」。
 * 3. **两方都失败也要显示**。空着一侧比显示「AI 没接通」更糟——读者会以为
 *    这一侧没有反面意见。
 */

import type { StageResult } from "./research.ts";
import { screenAdvice } from "./red-line.ts";
import { screenNumbers } from "./number-gate.ts";
import { makeCalculation, formatChain } from "./evidence.ts";
import { collectEvidence } from "./research-ai.ts";
import type { AiCaller } from "./research-ai.ts";

export type DebateRole = "bull" | "bear";

export type DebateSide = {
  role: DebateRole;
  label: string;
  status: "ok" | "refused" | "failed" | "skipped";
  text: string | null;
  why: string | null;
  refs: string[];
  chain: string | null;
  blocked: number;
  numbersReplaced: number;
  ms: number;
};

export type DebateResult = {
  sides: DebateSide[];
  /** 双方共用的证据条数 */
  evidenceCount: number;
};

const ROLE_LABEL: Record<DebateRole, string> = { bull: "支持继续跟踪", bear: "需要提高警惕" };

/** 组某一方的 prompt。证据部分两边完全一致，只有任务描述不同。 */
export function buildDebatePrompt(role: DebateRole, stages: readonly StageResult[], symbol: string, name: string): string {
  const evidence = collectEvidence(stages);
  const lines = evidence.map((e) => `- ${e.id}: ${e.line}`).join("\n");
  const task =
    role === "bull"
      ? "只找**支持**这只票值得继续跟踪的证据，写出 2-3 个「看到什么就该重新乐观」的裁决点"
      : "只找**反对**的证据，写出 2-3 个「看到什么就该重新警惕」的裁决点";
  return [
    `你是赤轨的多空辩论选手，这一轮你扮演「${ROLE_LABEL[role]}」一方。标的：${name}（${symbol || "未知"}）。`,
    ``,
    `双方共用的证据（逐条带 id，你不许多拿也不许少拿）：`,
    lines || `（这一轮没有任何证据）`,
    ``,
    `任务：${task}。`,
    ``,
    `要求：`,
    `1. 只根据上面的证据写，每条裁决点后面用括号写明依据的证据 id`,
    `2. 数字只能来自证据，不许自己编`,
    `3. 不许给买卖建议、目标价、止损位、仓位建议——你只负责指出「该盯什么」`,
    `4. 只输出 JSON：{"refs": ["ev-xxx"], "text": "..."}`,
  ].join("\n");
}

/** 跑一轮辩论。两方并行（各是一次 AI 调用，串行要等两倍时间）。 */
export async function runDebate(
  stages: readonly StageResult[],
  symbol: string,
  name: string,
  caller: AiCaller | null,
  knownEvidenceIds?: readonly string[],
): Promise<DebateResult> {
  const evidence = collectEvidence(stages);
  const known = new Set(knownEvidenceIds ?? []);

  const one = async (role: DebateRole): Promise<DebateSide> => {
    const base = { role, label: ROLE_LABEL[role], refs: [] as string[], blocked: 0, numbersReplaced: 0, chain: null as string | null };
    if (!caller) return { ...base, status: "skipped", text: null, why: "没有可用的 AI 调用", ms: 0 };

    const started = Date.now();
    let raw: string;
    try {
      raw = await caller(buildDebatePrompt(role, stages, symbol, name));
    } catch (error) {
      return { ...base, status: "failed", text: null, why: `AI 没接通：${error instanceof Error ? error.message : String(error)}`, ms: Date.now() - started };
    }
    const ms = Date.now() - started;

    let refs: string[] = [];
    let text = raw.trim();
    // 模型有时不守「单个对象」约定、返回 [{refs,text},...] 数组——逐条收编拼接；
    // 不收编的话 first{..last} 切片拼不出合法 JSON，整段原始 JSON 会糊在页面上（2026-10-21 实测）。
    if (text.startsWith("[")) {
      try {
        const arr = JSON.parse(text) as unknown;
        if (Array.isArray(arr)) {
          const texts: string[] = [];
          for (const item of arr) {
            if (typeof item !== "object" || item === null) continue;
            const o = item as { refs?: unknown; text?: unknown };
            if (Array.isArray(o.refs)) refs.push(...o.refs.filter((r): r is string => typeof r === "string"));
            if (typeof o.text === "string" && o.text.trim()) texts.push(o.text.trim());
          }
          if (texts.length > 0) text = texts.join("\n");
        }
      } catch {
        /* 解析不了就整段当正文 */
      }
    } else {
      const s = raw.indexOf("{");
      const e = raw.lastIndexOf("}");
      if (s >= 0 && e > s) {
        try {
          const obj = JSON.parse(raw.slice(s, e + 1)) as { refs?: unknown; text?: unknown };
          if (Array.isArray(obj.refs)) refs = obj.refs.filter((r): r is string => typeof r === "string");
          if (typeof obj.text === "string") text = obj.text;
        } catch {
          /* 解析不了就整段当正文 */
        }
      }
    }
    if (!text) return { ...base, status: "failed", text: null, why: "AI 返回了空内容", ms };

    // 声明了但证据层里没有的 id 剔掉，避免 inputsRefs 悬空
    refs = refs.filter((r) => known.size === 0 || known.has(r));

    const advice = screenAdvice(text);
    if (!advice.ok) {
      return {
        ...base,
        status: "refused",
        text: null,
        why: `这一方命中红线：${advice.hits[0] ?? "疑似给出投资动作"}。`,
        refs,
        ms,
      };
    }

    const screened = screenNumbers(text, evidence.map((x) => x.line));
    const calc = makeCalculation({
      fn: `debate_${role}`,
      inputs: { refs: refs.length },
      inputsRefs: refs,
      output: { value: null, unit: "文本", status: "ok" },
    });
    return {
      ...base,
      status: "ok",
      text: screened.text,
      why: null,
      refs,
      chain: formatChain(calc),
      numbersReplaced: screened.replaced.length,
      ms,
    };
  };

  const sides = await Promise.all([one("bull"), one("bear")]);
  return { sides, evidenceCount: evidence.length };
}
