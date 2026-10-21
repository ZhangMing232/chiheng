/**
 * 这个文件是干什么的：
 * 证据与计算的账本。**每个数字都要能回答「你从哪来、经过什么运算」**。
 *
 * 学 Vibe-Research 的 `validator.ts` / `merge.ts` 那套产物：
 *   - 证据（evidence）：一条原始数据 + 它的出处、口径、时点
 *   - 计算（calculation）：一次运算 + 它的输入引用了哪些证据/计算、输出与状态
 * 两者都有 id，计算之间形成一张 DAG。事后复核任意一个成品数字，能顺着引用走回原始 bar。
 *
 * 你需要知道的（纪律）：
 *
 * 1. **为什么 id 用纯 JS 哈希而不是 node:crypto 的 sha256**：这个文件会被
 *    `routes/research.tsx`（客户端组件）import，浏览器里没有 node:crypto。
 *    Vibe 是纯服务端所以能用 sha256；赤轨要两头跑，就得用零依赖实现。
 *    哈希只用来做「同内容同 id」的去重和引用，**不是安全边界**——别拿它防篡改。
 *
 * 2. **adjustment 必填**。结算用不复权、回测用前复权（quotes.functions.ts:156-159 的老坑），
 *    混用会让两个看起来一样的数其实不是一回事。所以每条证据都要写明自己是哪种口径。
 *
 * 3. **status 有 `insufficient` 这一档**：样本不够时输出 null + 说明，
 *    不许输出一个看着合理的数（对齐 pe-history.ts 的 MIN_POINTS 判据）。
 *
 * 4. 纯函数、零 I/O，直接单测。
 */

/** 复权口径。none = 不复权（结算用），qfq = 前复权（回测用），hfq = 后复权。 */
export type Adjustment = "none" | "qfq" | "hfq";

/** 一条原始数据。 */
export type Evidence = {
  /** 内容哈希，同内容同 id（去重与引用用，不是防篡改） */
  id: string;
  /** 来源。写接口/文件名，不写「内部数据」 */
  source: string;
  symbol: string;
  field: string;
  /** 时点或区间，如 2026-10-09 / 2026-09-20~2026-10-10 */
  period: string;
  unit: string;
  adjustment: Adjustment;
  /** 数据对应的时间（不是取数时间），便于判断新鲜度 */
  asOf: string;
  value: number | string | null;
};

/** 一次运算。inputs_refs 指向它用到的证据/计算，形成 DAG。 */
export type Calculation = {
  id: string;
  /** 函数名。写实现处的函数名，便于反查代码 */
  fn: string;
  /** 直接使用的数值输入（不引用，就是本步骤算的） */
  inputs: Record<string, number | string | null>;
  /** 依赖的上游 id：evidence.id 或 calculation.id */
  inputsRefs: string[];
  output: {
    value: number | string | null;
    unit: string;
    /** ok = 算出来了；insufficient = 输入不够，value 必须是 null */
    status: "ok" | "insufficient";
  };
};

/**
 * FNV-1a 32 位，转 base36。零依赖，浏览器和 node 都能跑。
 * 不用 sha256 的理由见文件头第 1 条。
 */
export function contentHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function norm(v: number | string | null): string {
  if (v == null) return "null";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : `n:${v}`;
  return `s:${v}`;
}

/** 造一条证据。id 由内容决定：同样的出处+口径+值永远是同一条。 */
export function makeEvidence(input: Omit<Evidence, "id">): Evidence {
  // 写不出来处的数据不许进账。允许 null 值（那就是「查不到」），不允许没有来源——
  // 一个没有出处的数字比一个 null 危险得多，null 至少承认自己不知道。
  if (!input.source.trim()) throw new Error("证据必须写 source（接口或文件名）");
  if (!input.unit.trim()) throw new Error(`证据 ${input.symbol}.${input.field} 没写 unit`);
  const key = [input.source, input.symbol, input.field, input.period, input.unit, input.adjustment, input.asOf, norm(input.value)].join("|");
  return { ...input, id: `ev-${contentHash(key)}` };
}

export type CalcInput = Omit<Calculation, "id">;

/** 造一条计算记录。id 同样由内容决定。 */
export function makeCalculation(input: CalcInput): Calculation {
  const key = [input.fn, JSON.stringify(input.inputs), [...input.inputsRefs].sort().join(","), norm(input.output.value), input.output.unit, input.output.status].join("|");
  return { ...input, id: `calc-${contentHash(key)}` };
}

export type ChainCheck = {
  /** 悬空引用：inputsRefs 里指不到的 id。空 = 干净 */
  dangling: string[];
  /** 重复 id（同内容重复出现，可能是两次记录同一件事，也可能是漏改） */
  duplicated: string[];
};

/**
 * 校验一张 DAG：所有 inputsRefs 都要能在链上找到。
 *
 * 悬空引用为什么必须当错误：它意味着「这个数字声称基于某个证据，但那个证据不在账里」——
 * 比没有引用更糟，因为它伪装成有据可查。Vibe 的 validator 对这类是直接判失败。
 */
export function verifyChain(items: readonly { id: string; inputsRefs?: string[] }[]): ChainCheck {
  const known = new Set(items.map((item) => item.id));
  const dangling: string[] = [];
  const seen = new Map<string, number>();
  for (const item of items) seen.set(item.id, (seen.get(item.id) ?? 0) + 1);
  for (const item of items) {
    for (const ref of item.inputsRefs ?? []) if (!known.has(ref)) dangling.push(`${item.id} -> ${ref}`);
  }
  const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([id, n]) => `${id}×${n}`);
  return { dangling, duplicated };
}

/** linkifyEvidenceText 切出的一段：纯文本，或一个可回查的证据/计算 id。 */
export type EvidenceTextSegment =
  | { kind: "text"; text: string }
  | { kind: "ref"; id: string };

/**
 * 把一段含证据 id 的正文切成「文本 / 引用」交替的段。
 *
 * 学 Vibe-Research 的核心交互：正文里出现的证据编号要能点回去。
 * 只有 knownIds 里确实存在的 id 才成 ref 段——AI 随口编的 id 不许变成可点的链接，
 * 那样反而替它伪造了可查性。未知 id 按普通文本原样保留。
 */
export function linkifyEvidenceText(text: string, knownIds: ReadonlySet<string>): EvidenceTextSegment[] {
  if (knownIds.size === 0) return [{ kind: "text", text }];
  // id 的两种形态：账本哈希（ev-a1b2c3，纯 base36）和 prompt 里的行内 id
  // （ev-identity-收盘价，标签部分含中文）。按「非空白非标点」贪心切，
  // 是否成链接只看 knownIds——AI 随口编的 id 永远不会在集合里。
  const re = /(?:ev|calc)-[^\s,，.。、;；:：?!?（）()\[\]{}<>"'“”‘’—–]+/g;
  const out: EvidenceTextSegment[] = [];
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const id = m[0];
    if (!knownIds.has(id)) continue;
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    out.push({ kind: "ref", id });
    last = m.index + id.length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out.length > 0 ? out : [{ kind: "text", text }];
}

/** 给人看的一行引用路径，复核时用。 */
export function formatChain(calc: Calculation): string {
  const refs = calc.inputsRefs.length > 0 ? calc.inputsRefs.join(", ") : "（无上游）";
  const out = calc.output.value == null ? "—" : String(calc.output.value);
  return `${calc.id} ${calc.fn}(${refs}) = ${out}${calc.output.unit} [${calc.output.status}]`;
}
