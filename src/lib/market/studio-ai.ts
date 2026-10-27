/**
 * 这个文件是干什么的：
 * 自媒体海报的 **AI 设计师管线**（2026-10-23 定案的原则落地：数字和事实走
 * 模板，审美交给 AI）。流向对比图（versus）不再用固定模板，而是：
 *
 *   真实数据（loadFlow）→ 整理成 brief（数据块 + 必须逐字出现的 facts）
 *   → AI 写完整 SVG（只管设计，数字逐字抄 brief）
 *   → 校验器逐字比对 facts（防 AI 手滑）＋ 基础健康检查
 *   → 不过 → 带着问题清单重画一次（最多 2 次）
 *   → resvg 渲染 PNG
 *
 * 为什么这样切：
 * 1. **像素生成模型画数字必错**（扩散原理），所以 AI 只产 SVG 结构、数字由
 *    brief 逐字注入——AI 写的是符号，12.4亿 就是 12.4亿。
 * 2. **风格多变是这条路线的红利**：每次生成 AI 重新设计，不像固定模板永远
 *    一个样。校验器是确定性底线。
 * 3. 校验失败自动重试一次带反馈——AI 的排版纪律（留白率、挤边）靠 prompt
 *    约束 + 重试收敛，不做像素级检查（成本不值）。
 *
 * 你需要知道的：
 * - 调用烧的是 /ai 页配置的接口（callAIWithFallback：DSH 优先、直连兜底），
 *   用量记 ai-usage.json。所以路由层必须做好身份/权限闸。
 * - brief 里塞的是**饱满数据**：TOP8 双边 + 板块 mini + 两市拆分 + 北向——
 *    「每张图内容丰富饱满」是需求方明确要求，prompt 里也写了画幅填充铁律。
 */

import { studioPct } from "./studio-poster.ts";
import { renderSvg } from "./studio-svg.ts";
import type { FlowBook, FlowRow, MarketPart } from "./flow.ts";

// ── brief：真实数据 → 数据块 + 校验 facts ────────────────────────────

export type VersusKind = "stock" | "sector";

export type VersusBrief = {
  /** 喂给设计师模型的完整 prompt（含数据块 + 铁律）。 */
  prompt: string;
  /** 必须逐字出现在 SVG 里的 token（名称/金额/涨跌幅/日期/免责语）。 */
  facts: string[];
  /** 数据日期行（展示和校验都用）。 */
  dateLine: string;
};

/** 万元 → 文案用金额（>=1亿 用亿，否则用万）。和 studioAbsWan 同口径但带单位。 */
export function moneyOf(wan: number): string {
  const abs = Math.abs(wan);
  if (abs >= 10_000) return `${(abs / 10_000).toFixed(1)}亿`;
  return `${Math.round(abs)}万`;
}

function rowLine(rank: number, r: FlowRow, side: "in" | "out"): { line: string; facts: string[] } {
  const money = moneyOf(r.inflow);
  const chg = r.chg != null ? studioPct(r.chg) : null;
  const chgPart = chg ? `\u3000${chg}` : "";
  const line = `${rank}. ${r.name}\u3000${side === "in" ? "净流入" : "净流出"} ${money}${chgPart}`;
  const facts = [r.name, money, ...(chg ? [chg] : [])];
  return { line, facts };
}

function partLine(p: MarketPart): { line: string; facts: string[] } {
  const money = moneyOf(p.main);
  const sign = p.main >= 0 ? "净流入" : "净流出";
  return { line: `${p.name}主力${sign} ${money}`, facts: [money] };
}

/** 组一份「资金流向对比」brief。kind=stock 是个股榜，sector 是板块榜。 */
export function buildVersusBrief(book: FlowBook, kind: VersusKind, opts?: { direction?: string }): VersusBrief {
  const direction = opts?.direction?.trim();
  const dateLine = new Date().toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long",
    timeZone: "Asia/Shanghai",
  });
  const mainRows = kind === "stock" ? book.stocksIn : book.sectorsIn;
  const sideRows = kind === "stock" ? book.stocksOut : book.sectorsOut;
  const label = kind === "stock" ? "个股" : "板块";
  const top = 8;

  const facts: string[] = [];
  const lines: string[] = [];
  const push = (r: { line: string; facts: string[] }) => {
    lines.push(r.line);
    facts.push(...r.facts);
  };

  lines.push(`【${label}主力净流入 TOP${top}（画左半，红色系）】`);
  mainRows.slice(0, top).forEach((r, i) => push(rowLine(i + 1, r, "in")));
  lines.push(`【${label}主力净流出 TOP${top}（画右半，绿色系）】`);
  sideRows.slice(0, top).forEach((r, i) => push(rowLine(i + 1, r, "out")));

  // 板块 mini 横条（个股图也带：多一层信息，图更饱满）
  if (kind === "stock" && book.sectorsIn.length > 0) {
    lines.push("【板块资金补充（底部横条区）】");
    book.sectorsIn.slice(0, 3).forEach((r) => push({ line: `板块流入 ${r.name} ${moneyOf(r.inflow)}${r.leader ? `（领涨 ${r.leader}）` : ""}`, facts: [r.name, moneyOf(r.inflow)] }));
    book.sectorsOut.slice(0, 3).forEach((r) => push({ line: `板块流出 ${r.name} ${moneyOf(r.inflow)}${r.leader ? `（领跌 ${r.leader}）` : ""}`, facts: [r.name, moneyOf(r.inflow)] }));
  }
  // 两市拆分
  if (book.market.length > 0) {
    lines.push("【沪深两市资金拆分】");
    book.market.forEach((p) => push(partLine(p)));
  }
  // 北向（只有成交额，净流入已不公布——如实写）
  if (book.north.length > 0) {
    lines.push("【北向资金】");
    book.north.forEach((n) => push({ line: `${n.name}成交 ${moneyOf(n.amount)}（净流入已不公布）`, facts: [moneyOf(n.amount)] }));
  }

  const dataBlock = [`【今日日期】${dateLine}`, ...lines].join("\n");
  const disclaimer = "数据不构成投资建议";
  // 日期校验只钉死「M月D日」核心——星期几是装饰，AI 写成「10月23日 星期五」
  // 或换个位置都会被整行校验误杀（真踩过：连续两轮只差个星期几，整图被毙）。
  const dateCore = /(\d{1,2}月\d{1,2}日)/.exec(dateLine)?.[1] ?? dateLine;
  facts.push(dateCore, disclaimer);

  // 委托人的设计要求（和 AI 设计师沟通累积下来的方向）——放进 prompt 但**不进
  // facts**：这是审美约束不是事实，不做逐字校验（硬校验只会误杀）。
  const directionBlock = direction ? [`【委托人的设计要求（必须尊重，除非和数据冲突）】`, direction].join("\n") : "";

  const prompt = [
    "你是一位顶尖财经自媒体视觉设计师。请设计一张竖版对比海报的 SVG 代码。",
    "",
    `主题：A股今日${label}主力资金流向对比（左流入右流出，一场钱的方向博弈画在一张图上）。`,
    "",
    dataBlock,
    "",
    directionBlock,
    "铁律（违反任何一条都是失败）：",
    "1. 上面数据块里的名称、金额、涨跌幅、日期必须逐字使用，一个数字都不许改、不许编、不许四舍五入、不许换算单位。",
    "2. 只输出 SVG 代码本身，不要任何解释、markdown 代码块标记或前后文字。",
    "3. 涨/流入用中国红系，跌/流出用中国绿系，中性信息用低饱和灰。",
    '4. 所有文字 font-family="sans-serif"。',
    "5. 只使用 SVG 标准元素（rect/circle/text/path/line/linearGradient/radialGradient/filter 基础模糊），不要用脚本、不要外链图片/字体。",
    "6. 内容饱满铁律：有效内容必须纵向占满画幅 88% 以上，禁止出现「下半幅大片留白」「内容挤在上 1/3」——图要丰富、有层次、有呼吸节奏。",
    "7. 要有设计感，且默认走**科技风**（这是赤轨的品牌调性，不是可选项）：",
    "   a. 背景：深色底 + 微网格/细点阵/低透明几何纹理（透明度压到 3%-8%，不能抢数据）；",
    "   b. 结构：中央分割光带或中轴刻线、区块间发光分割线、面板四角加 HUD 角括号（┌ ┐ └ ┘ 式细线）；",
    "   c. 数据装饰：排名条末端加光点/脉冲点，重点数值（第一名、两市合计）给发光或描边强调，分区标题前加状态指示灯（小圆点）；",
    "   d. 层次：标题区/对比区/补充区/落款区节奏分明，对比布局拒绝平庸的表格感；",
    "   e. 克制：装饰只能衬数据，任何元素不得降低数字的可读性；装饰总量宁多勿少，但单层透明度要低。",
    "8. 品牌露出铁律（这图是「赤轨」做的，必须让人看见）：画面角落必须有一个醒目的品牌徽章——图形标 + 「赤轨」字标（可做成印章/徽章/水印样式，但不能小到看不清），底部另起一行小字「数据不构成投资建议 · 赤轨」。",
  ].join("\n");

  return { prompt, facts, dateLine };
}

// ── 校验器：逐字比对 + 健康检查（纯函数，零 I/O 可单测）───────────────

export type PosterValidation = { ok: boolean; missing: string[]; issues: string[] };

export function validatePosterSVG(svg: string, facts: readonly string[]): PosterValidation {
  const missing: string[] = [];
  const issues: string[] = [];
  if (!svg.includes("<svg") || !svg.includes("</svg>")) issues.push("不是完整 SVG");
  for (const bad of ["NaN", "undefined", "null"]) {
    if (svg.includes(bad)) issues.push(`含非法占位「${bad}」`);
  }
  // 免责声明在 facts 里（最后一条），单独查一遍让报错信息更明确
  const disclaimer = facts[facts.length - 1];
  if (disclaimer && !svg.includes(disclaimer)) missing.push(disclaimer);
  // 品牌露出是硬需求（「别人怎么知道是赤轨做的」）：赤轨字标必须出现。
  // 免责声明里虽含「赤轨」，但这里单独查，防止以后改免责语文案时把品牌校验一起丢掉。
  if (!svg.includes("赤轨")) issues.push("缺品牌标识「赤轨」");
  for (const fact of facts.slice(0, -1)) {
    if (!svg.includes(fact)) missing.push(fact);
  }
  return { ok: issues.length === 0 && missing.length === 0, missing, issues };
}

// ── 设计 + 渲染编排（server-only：调 AI + resvg）─────────────────────

const DESIGN_TIMEOUT_MS = 280_000;

async function designPosterSVG(brief: VersusBrief, format: "vertical" | "square", feedback?: string): Promise<string> {
  const { callAIWithFallback } = await import("./factor-queue.ts");
  const size = format === "vertical" ? "1080×1920（抖音 9:16 竖版）" : "1200×1200（方形）";
  const retryNote = feedback
    ? [
        "",
        "上一版被校验器驳回，问题如下，这版必须全部修掉：",
        feedback,
        "特别提醒：被列出的缺失名称/数字必须原样出现；版面问题按条修。",
      ].join("\n")
    : "";
  const text = await callAIWithFallback(
    [
      brief.prompt,
      "",
      `画幅：${size}，width/height/viewBox 按此设置。`,
      "输出前自查一遍：每个数字都能在数据块里找到出处。",
      retryNote,
    ].join("\n"),
    {
      layer: "studio",
      trigger: "manual",
      system: "你是顶尖财经自媒体视觉设计师，只输出 SVG 代码，不输出任何解释。",
      timeoutMs: DESIGN_TIMEOUT_MS,
    },
  );
  const m = text.match(/<svg[\s\S]*<\/svg>/);
  if (!m) throw new Error("AI 返回里没有 SVG 代码");
  return m[0];
}

export type AIPosterResult = {
  ok: true;
  png: Uint8Array;
  svg: string;
  attempts: number;
  ms: number;
};

/**
 * 出一张 AI 设计的流向对比海报。校验不过自动带反馈重画一次（最多 2 次），
 * 仍不过就抛错——调用方（页面）回退到模板渲染，不给用户看一张数不对的图。
 */
export async function renderAIVersusPoster(
  book: FlowBook,
  kind: VersusKind,
  format: "vertical" | "square",
  opts?: { direction?: string },
): Promise<AIPosterResult> {
  const brief = buildVersusBrief(book, kind, opts);
  const started = Date.now();
  let lastMissing: string[] = [];
  let lastIssues: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const feedback =
      attempt === 2
        ? [
            ...lastMissing.map((f) => `缺失（必须原样补回）：${f}`),
            ...lastIssues.map((i) => `健康问题：${i}`),
          ].join("\n")
        : undefined;
    const svg = await designPosterSVG(brief, format, feedback);
    const v = validatePosterSVG(svg, brief.facts);
    if (v.ok) {
      const { png } = await renderSvg(svg);
      return { ok: true, png, svg, attempts: attempt, ms: Date.now() - started };
    }
    lastMissing = v.missing;
    lastIssues = v.issues;
  }
  throw new Error(
    "AI 海报两次都没过校验：" +
      [...lastIssues, ...lastMissing.map((f) => `缺 ${f}`)].slice(0, 8).join("；"),
  );
}

// ── 设计沟通：和 AI 设计师对话（server-only：调 AI）───────────────────

export type DesignMessage = { role: "user" | "assistant"; content: string };

/**
 * 委托人和 AI 设计师对话。设计师拿得到真实数据块，所以它的建议落在实际内容上
 * （「电子流入 67.1 亿那行可以做视觉锚点」而不是空谈）；它也被铁律约束不输出 SVG、
 * 不改数字。messages 含完整对话历史（最后一条应是委托人的话）。
 */
export async function chatWithDesigner(book: FlowBook, kind: VersusKind, messages: DesignMessage[]): Promise<string> {
  const brief = buildVersusBrief(book, kind);
  // 数据块给全量（设计师要看着数据给建议），铁律不需要——聊天不产出 SVG。
  const transcript = messages
    .map((m) => `${m.role === "user" ? "委托人" : "设计师"}：${m.content}`)
    .join("\n");
  const text = await callDesignerAI(
    [
      brief.prompt.split("铁律（违反任何一条都是失败）：")[0] ?? brief.prompt,
      "",
      "以上是这张海报的主题和真实数据。现在委托人像跟真人设计师一样跟你讨论设计方向。",
      "对话记录：",
      transcript,
      "",
      "请直接回复委托人：给具体可执行的设计建议（布局/配色/视觉层次/装饰元素），",
      "可以主动提议 2-3 个不同方向让委托人挑。要求：不输出 SVG 代码、不改任何数字、",
      "不寒暄超过一句、200 字以内、像资深设计师说话（有判断、有取舍，不当应声虫）。",
    ].join("\n"),
    { timeoutMs: 120_000 },
  );
  return text.trim().slice(0, 2000);
}

/** 内部：走 callAIWithFallback 的统一入口（DSH 优先、用量记账、profile 切换全继承）。 */
async function callDesignerAI(prompt: string, opts: { timeoutMs: number }): Promise<string> {
  const { callAIWithFallback } = await import("./factor-queue.ts");
  return callAIWithFallback(
    prompt,
    {
      layer: "studio",
      trigger: "manual",
      system: "你是顶尖财经自媒体视觉设计师「赤轨」的设计负责人，只回设计沟通文字，绝不输出 SVG 代码。",
      timeoutMs: opts.timeoutMs,
    },
  );
}
