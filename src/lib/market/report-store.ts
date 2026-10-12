/**
 * 这个文件是干什么的：
 * 研判报告的落盘与列表。**AI 说过什么、依据是什么，要能事后查**。
 *
 * 学 Vibe-Research 的产物形态：一份 markdown（人读）+ 一份索引行（机器读），
 * 宪法口径、四档可信度、证据 id 全部写进文件本身——不依赖外部说明。
 *
 * 你需要知道的（纪律）：
 * 1. **报告里要能分出「AI 说的」和「规则推的」**。混在一起，读者就无法判断该信谁。
 * 2. **缺口必须原样进报告**。被删掉的缺口等于伪造「都查到了」。
 * 3. 索引是 JSONL 追加，不覆盖。改历史报告 = 再造一份新的，旧的留着。
 * 4. `data/` 不在 git 里，所以读不到就是没有，页面要照实说。
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResearchReport } from "./research.ts";
import type { AiSynthesis } from "./research-ai.ts";
import { RESEARCH_TIERS } from "./research.ts";
import { contentHash } from "./evidence.ts";

/** 报告目录。data 不在 git，换机器必然读不到——这是预期不是错误。 */
export function reportDir(root = process.cwd()): string {
  return join(root, "data", "reports");
}

export type ReportIndexRow = {
  id: string;
  symbol: string;
  name: string;
  at: string;
  /** AI 综合的状态。skipped/failed 的报告只有规则结论 */
  aiStatus: AiSynthesis["status"] | "none";
  /** 全报告缺口条数 */
  gaps: number;
  /** 被红线拦下的条数（>0 说明这轮有人越线） */
  blocked: number;
  /** 被数字闸门换掉的数字个数 */
  numbersReplaced: number;
};

function slug(text: string): string {
  return text.replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 40);
}

/**
 * 报告 id：标的 + 时间（精确到秒）+ 短随机后缀。
 *
 * 随机后缀是必须的：同一只票在同一秒内研判两次（用户连点两次「存报告」）会撞 id，
 * 撞了就是后一份覆盖前一份——历史报告丢了，而索引里看起来只有一条。
 */
export function reportId(report: ResearchReport, at: Date): string {
  const stamp = at.toISOString().replace(/[:.]/g, "").slice(0, 18); // 2026-10-12T075123
  const salt = contentHash(`${report.symbol}${at.getTime()}${Math.random()}`).slice(0, 4);
  return `${report.symbol || "unknown"}-${stamp}-${salt}`;
}

const TIER_NOTE = [
  "本报告只给数据、分析框架、情景概率和裁决点，**不给买卖建议**（AI-BOUNDARY.md §0-3）。",
  `四档可信度：${RESEARCH_TIERS.join(" / ")}。除「未核实线索」外，其余三档都由代码从真实数据算出。`,
].join("\n");

/** 渲染成 markdown。证据、缺口、AI 综合全部进文件，不依赖页面。 */
export function renderReport(report: ResearchReport, ai: AiSynthesis | null): string {
  const lines: string[] = [];
  lines.push(`# 个股研判 · ${report.name || report.symbol || "未知标的"}（${report.symbol || "—"}）`);
  lines.push("");
  lines.push(`> ${TIER_NOTE.split("\n").join("\n> ")}`);
  lines.push("");

  if (report.gaps.length > 0) {
    lines.push(`**全报告级缺口**：${report.gaps.join("；")}`);
    lines.push("");
  }

  for (const stage of report.stages) {
    lines.push(`## ${stage.title}`);
    lines.push("");
    lines.push(`**这一阶段回答**：${stage.question}`);
    lines.push("");
    if (stage.evidence.length > 0) {
      lines.push("| 项 | 值 | 来源 | 档位 |");
      lines.push("|---|---|---|---|");
      for (const e of stage.evidence) {
        lines.push(`| ${e.label} | ${e.value} | ${e.source} | ${e.tier} |`);
      }
      lines.push("");
    }
    if (stage.derived.length > 0) {
      lines.push("**算出来的数字（带引用链）**");
      lines.push("");
      for (const d of stage.derived) {
        lines.push(`- ${d.label}：${d.value}（${d.tier}）`);
        lines.push(`  - 引用链：\`${d.chain}\``);
      }
      lines.push("");
    }
    for (const f of stage.findings) lines.push(`- 【${f.tier}】${f.text}`);
    if (stage.findings.length > 0) lines.push("");
    if (stage.gaps.length > 0) {
      lines.push("<details><summary>这一阶段缺数据</summary>");
      lines.push("");
      for (const g of stage.gaps) lines.push(`- ${g}`);
      lines.push("");
      lines.push("</details>");
      lines.push("");
    }
  }

  lines.push("## AI 综合");
  lines.push("");
  if (!ai || ai.status === "skipped") {
    lines.push("本轮没有 AI 参与（未配置或已关闭）。上面全部是规则推出来的。");
  } else if (ai.status === "ok") {
    lines.push(ai.text ?? "");
    lines.push("");
    lines.push(`- 来源：AI（注入调用，${(ai.ms / 1000).toFixed(1)} 秒）`);
    lines.push(`- 引用 ${ai.refs.length} 条证据，被数字闸门换掉 ${ai.numbersReplaced} 个数字`);
    lines.push(`- 引用链：\`${ai.chain ?? "—"}\``);
  } else {
    lines.push(`**本轮 AI 没有产出**：${ai.why ?? "原因未知"}`);
    lines.push("");
    lines.push("上面六个阶段是规则推出来的，与 AI 无关。");
  }
  lines.push("");
  return lines.join("\n");
}

/** 存一份报告。返回落盘路径，供页面显示「存到哪了」。 */
export async function saveReport(
  report: ResearchReport,
  ai: AiSynthesis | null,
  root = process.cwd(),
): Promise<{ id: string; path: string }> {
  const at = new Date();
  const id = reportId(report, at);
  const dir = reportDir(root);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${slug(id)}.md`);
  const md = renderReport(report, ai);
  // 头部补一行生成信息，索引和文件内容才对得上
  await writeFile(file, md.replace(/^# /, `# [${id}] `), "utf-8");

  const row: ReportIndexRow = {
    id,
    symbol: report.symbol,
    name: report.name,
    at: at.toISOString(),
    aiStatus: ai?.status ?? "none",
    gaps: report.stages.reduce((n, s) => n + s.gaps.length, 0) + report.gaps.length,
    blocked: report.blocked,
    numbersReplaced: ai?.numbersReplaced ?? report.numbersReplaced,
  };
  await appendFile(join(dir, "index.jsonl"), `${JSON.stringify(row)}\n`, "utf-8");
  return { id, path: file };
}

/** 读索引。新的在前。文件不在（没存过 / 换了机器）= 空数组，不报错。 */
export async function listReports(root = process.cwd()): Promise<ReportIndexRow[]> {
  try {
    const raw = await readFile(join(reportDir(root), "index.jsonl"), "utf-8");
    const rows = raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line) as ReportIndexRow;
        } catch {
          return null; // 半行（写一半断电）不算一条，静默跳过
        }
      })
      .filter((row): row is ReportIndexRow => row != null);
    return rows.reverse();
  } catch {
    return [];
  }
}

/**
 * 按 id 读一份报告的 markdown 原文。
 *
 * id 带时间戳和后缀，直接拼文件名不可靠（slug 化过），所以在索引里反查。
 * 找不到返回 null——调用方要区分「没有这一份」和「这一份是空的」。
 */
export async function readReport(id: string, root = process.cwd()): Promise<string | null> {
  const rows = await listReports(root);
  const hit = rows.find((row) => row.id === id);
  if (!hit) return null;
  try {
    return await readFile(join(reportDir(root), `${slug(hit.id)}.md`), "utf-8");
  } catch {
    return null;
  }
}
