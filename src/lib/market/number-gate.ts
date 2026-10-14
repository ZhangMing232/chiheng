/**
 * 这个文件是干什么的：
 * **数字闸门**：AI 或模板写出来的每个数字，都要能在本轮看得见的材料里找到；
 * 找不到就把它换成「（略※）」，不整段拒答。
 *
 * 学 Vibe-Research 的 `orchestrator/src/number_gate.ts`（274 行），砍到赤轨用得上的
 * 内核。它文件头有三句话值得原样搬过来：
 *   1. 一个数字没出处，不该连累整段回答——所以是**逐个替换**，不是整段打回。
 *   2. 比对刻意不用宽松换算：一份几百个价格的工具结果下，随手编的 156.3 除以 100
 *      就能对上某个价格。**同一个放行策略换个场景就得收紧**。
 *   3. 它只核对「这个数在材料里出现过」，不核对「用在了对的地方」——这句局限必须
 *      写在明处，否则读者会以为数字都被验证过了。
 *
 * 你需要知道的（纪律）：
 * - 这是护栏不是判官。拦不住「数字是真的但用错了地方」，也拦不住语义错误。
 * - 防绕过：只有**闭合的、且标了语言或一半以上行像代码**的代码块才豁免。
 *   没闭合的围栏照常核对——不然把编的数字塞进代码块就能绕过去。
 * - 「假设 / 假如」那句里的数字算举例：读者看得到「假设」二字，不是冒充数据。
 *   按**小句**豁免，不按整行——否则同一行里的真数据会被一起放过去。
 * - **规则阈值豁免（T1，2026-10-12 已踩三次）**：「评分高于 2」「近 4 个」「超过 5 家」
 *   这类写法，数字是规则旋钮，材料里本来就不会有出处。比较词 + 无量纲计数（个/只/家/
 *   名/条/笔…）直接豁免；没有计数单位的只信 10 以内的小整数。**带度量单位的阈值仍核对**
 *   （「市盈率低于 20 倍」「涨幅超过 5%」读起来就是数据，可能是编的）——这条界线写在
 *   PRE_MASK 注释里，改之前先想清楚误放行的代价。
 */

/** 替换标记。 */
export const NUMBER_MARK = "（略※）";

/** 数字（含千分位、小数、负号、科学计数法）。 */
const NUM = /-?\d[\d,]*\.?\d*(?:e[+-]?\d+)?/gi;

/** 紧跟在数字后面的单位。换数字时把它一起换掉，免得留下「（略※）亿元」。 */
const UNIT_AFTER = /^\s*(?:%|倍|百分点|pp|万亿|亿|万|元\/股|美元|港元|元|手|股)/;

/**
 * 不是数字主张的写法。剥掉之后才轮到 NUM 去抽——
 * 这些在材料里到处都是，不剥就等于每个都要核对，误伤一片。
 * 用等长空格替换，offset 才能和原文对齐。
 */
const PRE_MASK: RegExp[] = [
  // 证据 / 计算 id 先剥掉：`ev-1xq7j8z` 里的数字是哈希，不是数据点。
  // 不剥会把 AI 的引用啃成「ev（略※）xq7j8z」，读者反而点不回原始证据。
  /\b(?:ev|calc)-[0-9a-z]{4,}\b/g,
  /\[资料:[^\]\n]*\]/g,
  /^\s*\d+[.、)）]\s/gm, // 行首序号
  /(?<![\d.:])(?:[01]?\d|2[0-3]):[0-5]\d(?![\d:])/g, // 钟点（35:65 这类配比仍要核对）
  /(?<![\d.\-/])(?:0?[1-9]|1[0-2])[-/](?:0?[1-9]|[12]\d|3[01])(?![\d.\-/])(?!\s*(?:%|倍|元|亿|万|百分点))/g,
  /(?<![\d.])(?:0?[1-9]|1[0-2])\s*月\s*(?:0?[1-9]|[12]\d|3[01])\s*[日号]?/g,
  /(?<![\d.-])(?:19|20)\d{2}-(?:0?[1-9]|1[0-2])-(?:0?[1-9]|[12]\d|3[01])(?![\d.-])/g, // 完整日期
  /(?:近|过去|最近|未来|前|后)\s*\d+\s*(?:个\s*)?(?:日|天|周|星期|月|年|小时|分钟|秒)/g, // 时间窗口
  /[(（]\s*\d{1,3}(?:\s*[,，、]\s*\d{1,3}){1,5}\s*[)）]/g, // 参数组 (12,26,9)
  // 规则阈值（T1）：比较词/序数词 + 数字 + 无量纲计数（个/只/家/名/条/笔…）是旋钮不是数据——
  // 「评分高于 2」「近 4 个」「超过 5 家」这类写法，数字是规则参数，材料里不会有出处。
  // 红线：**带度量单位的阈值仍核对**（%、倍、元、亿、万股…读起来就是数据），
  // 所以豁免列表里不放这些单位，后面还要用负向前瞻挡住「3 个股」这类组合。
  // 计数单位里含**日/天/周/月/年**（2026-10-14 加）：「连续 2 天」「至少 3 个月」
  // 这类是规则旋钮——连亏天数的门槛就写在 rules.ts 里，材料里本来不会有出处。
  // 加之前先确认不会误伤：「持有 8 天」没有比较词，压根不进这条模式；
  // 「涨了 3 天」有"近/超过"之类才算阈值。加了之后「近 3 天」这类仍由上面的
  // 时间窗口模式豁免，两条不冲突。
  /(?:高于|低于|超过|不少于|不低于|不超过|少于|多于|至少|最少|至多|最多|满|连续|排名|近|过去|最近|未来|前|后)\s*\d+(?:\.\d+)?\s*(?:个|只|家|名|条|笔|次|项|档|位|强|日|天|周|月|年)(?![\d.%倍元亿万股])/g,
  // 阈值没有计数单位的形态（「评分高于 2」）：只豁免 10 以内的小整数。
  // 大整数不带单位多半是省略了（「市盈率高于 20」），仍按数据核对。
  /(?:高于|低于|超过|不少于|不低于|不超过|少于|多于|至少|最少|至多|最多)\s*(?:[1-9]|10)(?![\d.])(?!\s*(?:%|倍|百分点|pp|元|亿|万|手|股|个|只|家|名|条|笔|次|项|档|位|强|年|月|日|天|周|小时|分钟|秒))/g,
];

/** 举例的标记。 */
const HYPOTHETICAL = /假设|假如|假定|打个比方/;

/** 按小句切。千分位的逗号不切。 */
const CLAUSE = /(?<=[。！？!?；;，])|(?<=,)(?!\d)/;

const CODE_LANG = /^(?:python|py|javascript|js|typescript|ts|tsx|jsx|bash|sh|shell|sql|json|text|plain)$/i;

function looksLikeCode(rows: readonly string[]): boolean {
  const nonEmpty = rows.filter((l) => l.trim()).length;
  const codeish = rows.filter((l) =>
    /^\s*(?:import|from|def|class|const|let|var|return|for|while|if|elif|else|print|function|select)\b|^\s*[#;{}]|=>/.test(l.trim()),
  ).length;
  return nonEmpty > 0 && codeish * 2 >= nonEmpty;
}

/** 找出所有「闭合且像代码」的代码块行号。没闭合的围栏不豁免。 */
function codeBlockLines(rows: readonly string[]): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < rows.length; i += 1) {
    const open = /^\s*```\s*([\w+#.-]*)\s*$/.exec(rows[i]!);
    if (!open) continue;
    let j = i + 1;
    while (j < rows.length && !/^\s*```\s*$/.test(rows[j]!)) j += 1;
    if (j >= rows.length) break; // 没闭合：后面全按正文核对
    const body = rows.slice(i + 1, j).filter((l) => l.trim());
    const lang = open[1] ?? "";
    if ((lang && CODE_LANG.test(lang)) || (!lang && looksLikeCode(body))) {
      for (let k = i; k <= j; k += 1) out.add(k);
    }
    i = j;
  }
  return out;
}

function toNum(raw: string): number | null {
  const v = Number(raw.replace(/,/g, ""));
  return Number.isFinite(v) ? v : null;
}

/**
 * 把材料里出现过的数字收成一个集合。
 * 千分位与无千分位都收（1,235.58 和 1235.58 是同一个数）。
 */
function sourceNumbers(sources: readonly string[]): Set<number> {
  const out = new Set<number>();
  for (const text of sources) {
    for (const m of text.matchAll(NUM)) {
      const v = toNum(m[0]);
      if (v != null) out.add(v);
    }
  }
  return out;
}

/** 数字在材料里有没有出处。容差按它写到的那一位：「33 亿」容许 ±0.5。 */
function hasSource(v: number, known: ReadonlySet<number>): boolean {
  if (known.has(v)) return true;
  const decimals = Number.isInteger(v) ? 0 : String(v).split(".")[1]!.length;
  const tol = Math.pow(10, -decimals) / 2;
  for (const k of known) if (Math.abs(k - v) <= tol) return true;
  return false;
}

export type NumberScreenResult = {
  text: string;
  /** 被换掉的数字（原文片段），便于页面上说清「哪几个数没出处」 */
  replaced: string[];
  /** 材料里一个数字都没有 = 无从核对，此时这段的数字全部替换 */
  sourcesEmpty: boolean;
};

/**
 * 筛一行。
 *
 * ⚠️ probe（剥过非主张的版本）和 row **等长**，位置一一对应——所以只用 probe 判断
 * 「这个数字要不要核对」，**输出一律回 row 的原文**。
 * 早期版本直接拼 probe，结果「近 20 日」这种被豁免的窗口长度在输出里变成了空格，
 * 文字被啃出洞。mask 是尺子，不是输出。
 */
function screenLine(row: string, known: ReadonlySet<number>, replaced: string[]): string {
  let probe = row;
  for (const re of PRE_MASK) probe = probe.replace(re, (m) => " ".repeat(m.length));

  let out = "";
  let pos = 0; // row 里已拼回去的位置
  let consumed = 0; // 已扫到的小句末尾
  for (const clause of probe.split(CLAUSE)) {
    const at = probe.indexOf(clause, consumed);
    if (at < 0) continue;
    consumed = at + clause.length;
    if (HYPOTHETICAL.test(clause)) {
      out += row.slice(pos, consumed);
      pos = consumed;
      continue;
    }
    const raw = row.slice(at, consumed); // 输出用原文
    let seg = "";
    let segPos = 0;
    for (const m of clause.matchAll(NUM)) {
      const v = toNum(m[0]);
      if (v == null || hasSource(v, known)) continue;
      const rest = clause.slice(m.index! + m[0].length);
      const unit = UNIT_AFTER.exec(rest);
      const end = m.index! + m[0].length + (unit ? unit[0].length : 0);
      seg += raw.slice(segPos, m.index!) + NUMBER_MARK;
      segPos = end;
      replaced.push(m[0]);
    }
    seg += raw.slice(segPos);
    out += row.slice(pos, at) + seg;
    pos = consumed;
  }
  out += row.slice(pos);
  return out;
}

/**
 * 筛一段待输出文本。
 *
 * @param answer  待筛的话（AI 的回答、模板产出的结论）
 * @param sources 本轮可见的材料：用户消息、召回资料、工具结果、本会话此前内容
 */
export function screenNumbers(answer: string, sources: readonly string[]): NumberScreenResult {
  const known = sourceNumbers(sources);
  const replaced: string[] = [];

  // 材料里一个数字都没有 → 这段的数字全都没有出处。
  // ⚠️ 但仍然要走同一条 screenLine：日期、序号、参数组、时间窗口照样豁免。
  //    以前这里抄近路直接 replace(NUM)，结果「近 20 日」这种窗口长度也被换掉了。
  const rows = answer.split("\n");
  const skipLines = codeBlockLines(rows);
  const text = rows.map((row, i) => (skipLines.has(i) ? row : screenLine(row, known, replaced))).join("\n");
  return { text, replaced, sourcesEmpty: known.size === 0 };
}
