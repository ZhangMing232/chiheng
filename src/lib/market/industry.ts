/**
 * 这个文件是干什么的：
 * 个股 → 行业分类的映射（D6），产业链 SOP 的行业划分标准就落在这儿。
 *
 * **为什么不是申万**：2026-10-13 探过源。申万官网现在只剩指数行情接口
 * （institute-sw/api/index_publish/current/ 能返回点位），分类与成分股接口
 * 全 404——akshare 用的那条 details/ 路径已经下线，所以「用申万做行业划分」
 * 这条路在当前免费源下走不通。改用**东财三级行业**（m:90+t:2，实测 496 个板块，
 * 粒度到「印制电路板」「白酒Ⅱ」这种），成分股可反查，和赤轨现有板块体系同源。
 * 代价要说清：东财分类是东财自己编的，不是业界标准口径，报告里写行业归属时
 * 要带来源，别当申万说。
 *
 * 你需要知道的：
 * - id 一律带前缀（sh600519）。东财给的是六位代码 + 市场号，这里统一转换
 * - **东财市场号 0 不一定是深市**：北交所（4/8 开头）在东财也归 0，直接拼 sz
 *   会造出 sz920821 这种不存在的 id。按代码前缀判，不用市场号硬套
 * - **多归属是常态不是异常**：东财把一/二/三级行业都塞在 t:2 里（一只票同时属于
 *   「元件」和「印制电路板」）。所以 bySymbol 记**全部**归属，取最细的那个走
 *   finestIndustry()——按成员集合的包含关系剪枝（子集更细）。早先取「先到先占」，
 *   抽样 138 只里有 70 只被随机挂到粗粒度的一级行业上，白瞎了三级的粒度
 * - 分类文件缺失/结构非法 → 明确 gap，绝不当「零行业」放过去（对标 Vibe：
 *   标签表缺失直接抛错，不能静默跳过所有温度计）
 */

/** 东财板块（BK 代码）。members 是带前缀的个股 id。 */
export type IndustryBoard = {
  code: string;
  name: string;
  members: string[];
};

export type IndustryIndex = {
  /** 数据落盘时间（YYYY-MM-DD） */
  updatedAt: string;
  source: "eastmoney-l3";
  boards: IndustryBoard[];
  /**
   * 个股 id → **全部**归属板块。多归属是常态（一/二/三级行业都在同一份里），
   * 要最细的那层用 finestIndustry()，别直接取第 0 个。
   */
  bySymbol: Record<string, { code: string; name: string }[]>;
  /** 剪枝后仍有多个归属的（不在同一条链上，没法比粗细），数量见 multiCount */
  ambiguous: { id: string; boards: string[] }[];
  /** 有归属的个股总数 */
  symbols: number;
};

export type IndustryGap = { code?: string; reason: string };

/**
 * 东财六位代码 + 市场号 → 赤轨内部 id。
 * 认不出来的返回 null（宁可丢一条分类，也不要造出一个对不上的 id）。
 */
export function emSymbol(code: string, market: number): string | null {
  if (!/^\d{6}$/.test(code)) return null;
  if (market === 1) return `sh${code}`;
  // 北交所在东财的市场号也是 0（和深市一样），只能按代码段分：
  // 43/83/87/88 开头是老代码段，920 开头是 2024 年后的新代码段。
  if (/^(?:4|8|920)/.test(code)) return `bj${code}`;
  if (market === 0) return `sz${code}`;
  return null;
}

/** 板块清单（clist m:90+t:2）→ 板块元信息。坏行记 gap 不丢整份。 */
export function parseIndustryBoards(payload: unknown): { boards: { code: string; name: string }[]; gaps: IndustryGap[] } {
  const boards: { code: string; name: string }[] = [];
  const gaps: IndustryGap[] = [];
  const rows = boardRows(payload);
  if (!rows) {
    gaps.push({ reason: "板块清单返回体不是认得的结构" });
    return { boards, gaps };
  }
  for (const row of rows) {
    const code = typeof row?.f12 === "string" ? row.f12 : "";
    const name = typeof row?.f14 === "string" ? row.f14 : "";
    if (!/^BK\d+$/.test(code) || name.trim() === "") {
      gaps.push({ code: code || "无代码", reason: "板块代码或名称缺失" });
      continue;
    }
    boards.push({ code, name: name.trim() });
  }
  if (boards.length === 0 && gaps.length === 0) gaps.push({ reason: "板块清单是空的" });
  return { boards, gaps };
}

/** 板块成分股（clist fs=b:BKxxxx）→ 带前缀 id 列表。 */
export function parseBoardMembers(payload: unknown, board: { code: string; name: string }): { members: string[]; gap: string | null } {
  const rows = boardRows(payload);
  if (!rows) return { members: [], gap: `${board.name}(${board.code}) 成分股返回体不是认得的结构` };
  const members: string[] = [];
  let bad = 0;
  for (const row of rows) {
    const code = typeof row?.f12 === "string" ? row.f12 : "";
    const market = typeof row?.f13 === "number" ? row.f13 : NaN;
    const id = emSymbol(code, market);
    if (!id) {
      bad += 1;
      continue;
    }
    members.push(id);
  }
  if (members.length === 0) return { members: [], gap: `${board.name}(${board.code}) 没解析出任何成分股` };
  return { members, gap: bad > 0 ? `${board.name}(${board.code}) 有 ${bad} 只代码认不出，已跳过` : null };
}

/** 板块集合 → 索引。每只票的全部归属都记下来。 */
export function buildIndustryIndex(boards: IndustryBoard[], updatedAt: string): IndustryIndex {
  const bySymbol: Record<string, { code: string; name: string }[]> = {};
  for (const board of boards) {
    for (const id of board.members) {
      const list = bySymbol[id] ?? [];
      if (!list.some((item) => item.code === board.code)) list.push({ code: board.code, name: board.name });
      bySymbol[id] = list;
    }
  }
  // 剪枝后仍没法判断粗细的（不在同一条链上）才进 ambiguous
  const sets = memberSetsOf({ boards } as IndustryIndex);
  const ambiguous: { id: string; boards: string[] }[] = [];
  for (const [id, list] of Object.entries(bySymbol)) {
    const finest = pickFinest(list, sets);
    if (finest.length > 1) ambiguous.push({ id, boards: finest.map((b) => `${b.name}(${b.code})`) });
  }
  return {
    updatedAt,
    source: "eastmoney-l3",
    boards,
    bySymbol,
    ambiguous: ambiguous.sort((a, b) => a.id.localeCompare(b.id)),
    symbols: Object.keys(bySymbol).length,
  };
}

/** 板块 → 成员集合。finestIndustry 要用，传入可复用（全量建一次）。 */
export function memberSetsOf(index: Pick<IndustryIndex, "boards">): Map<string, Set<string>> {
  const sets = new Map<string, Set<string>>();
  for (const board of index.boards) sets.set(board.code, new Set(board.members));
  return sets;
}

/**
 * 取最细的那层归属：**成员集合是另一个候选子集的，说明它更细，把更粗的剪掉**。
 * 剪完还有多个 = 不在同一条链上（比如同时归到两个并列板块），如实都返回。
 * sets 不传就现建（一次性调用的场景）。
 */
export function finestIndustry(
  index: IndustryIndex,
  id: string,
  sets: Map<string, Set<string>> = memberSetsOf(index),
): { code: string; name: string }[] {
  const list = index.bySymbol[id];
  if (!list || list.length === 0) return [];
  return pickFinest(list, sets);
}

/**
 * 排粗细：**先按名称里的层级标记（Ⅲ > Ⅱ > Ⅰ > 无），同层级再按成员数少的更细**，
 * 然后把「包含更小候选」的粗板块剪掉。
 *
 * 为什么要排序这一层：全量 496 个板块跑下来，5589 只票里有 2543 只剪完还剩多个——
 * 东财板块之间很少是严格的集合包含（「工程咨询服务Ⅲ」和「建筑装饰」成员交叉但
 * 互不包含）。光靠包含关系剪不掉，主归属就会随机落在粗板块上。排序保证
 * industryOf 取到的是**可解释的最细那一层**，剩下几个照样记进 ambiguous，
 * 不假装已经判明白了。
 */
function pickFinest(list: { code: string; name: string }[], sets: Map<string, Set<string>>): { code: string; name: string }[] {
  if (list.length <= 1) return list;
  const sorted = [...list].sort((a, b) => {
    const byLayer = layerRank(b.name) - layerRank(a.name);
    if (byLayer !== 0) return byLayer;
    return (sets.get(a.code)?.size ?? 0) - (sets.get(b.code)?.size ?? 0);
  });
  return sorted.filter((cand) => {
    const candSet = sets.get(cand.code);
    if (!candSet) return true;
    return !sorted.some((other) => {
      if (other.code === cand.code) return false;
      const otherSet = sets.get(other.code);
      if (!otherSet) return false;
      // ① 成员集合是 cand 的真子集 → cand 更粗，剪掉
      if (otherSet.size < candSet.size) {
        for (const member of otherSet) if (!candSet.has(member)) return false;
        return true;
      }
      // ② 成员集合完全相等 → 按层级标记剪（白酒Ⅲ 和 白酒Ⅱ 实测就是同一批票，
      //    东财挂了两个层级标签）。排序已经把细的排前面，这里把粗的剔掉
      if (otherSet.size === candSet.size) {
        for (const member of otherSet) if (!candSet.has(member)) return false;
        return layerRank(other.name) > layerRank(cand.name);
      }
      return false;
    });
  });
}

/** 板块名的层级标记：Ⅲ > Ⅱ > Ⅰ > 无。东财用它区分同一批票的一/二/三级归属。 */
function layerRank(name: string): number {
  if (name.endsWith("Ⅲ")) return 3;
  if (name.endsWith("Ⅱ")) return 2;
  if (name.endsWith("Ⅰ")) return 1;
  return 0;
}

/** 查一只票的最细行业。查不到返回 null——调用方要自己说「没分类」，不许编。 */
export function industryOf(index: IndustryIndex, id: string): { code: string; name: string } | null {
  return finestIndustry(index, id)[0] ?? null;
}

/** 读索引时用的校验：文件缺失或结构非法要说清，不能当零行业放过去。 */
export function checkIndustryIndex(value: unknown): { ok: true; index: IndustryIndex } | { ok: false; reason: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "行业分类不是对象" };
  const v = value as Partial<IndustryIndex>;
  if (typeof v.updatedAt !== "string" || v.updatedAt === "") return { ok: false, reason: "行业分类缺 updatedAt" };
  if (!Array.isArray(v.boards) || v.boards.length === 0) return { ok: false, reason: "行业分类缺板块列表" };
  if (!v.bySymbol || typeof v.bySymbol !== "object" || Object.keys(v.bySymbol).length === 0)
    return { ok: false, reason: "行业分类缺个股映射" };
  if (!Array.isArray(v.ambiguous)) return { ok: false, reason: "行业分类缺 ambiguous" };
  return { ok: true, index: v as IndustryIndex };
}

type Row = Record<string, unknown>;
type BoardPayload = { data?: { diff?: Row[] | Record<string, Row> } };

function boardRows(payload: unknown): Row[] | null {
  if (!payload || typeof payload !== "object") return null;
  const diff = (payload as BoardPayload).data?.diff;
  if (Array.isArray(diff)) return diff;
  // 东财有时返回 {"0":{...},"1":{...}} 这种对象形式的 diff
  if (diff && typeof diff === "object") return Object.values(diff);
  return null;
}
