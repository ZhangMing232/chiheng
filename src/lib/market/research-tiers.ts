/**
 * 这个文件是干什么的：
 * 四档可信度的**唯一定义处**。
 *
 * 为什么单独一个文件：research.ts 要 import 各阶段的 stage 函数（运行时），
 * 而阶段函数又要用到这几档常量——都从 research.ts 取就会形成运行时循环依赖
 * （模块还没求值完就被读，常量是 undefined）。抽出来，两边都从这里 import。
 *
 * 为什么是这四档：学 Vibe-Research 的 inference_tiers，不用「高/中/低」——
 * 那三个词没有主语，读者分不清信的是数据还是某人的判断。
 */

export const RESEARCH_TIERS = ["已披露证实", "有依据的推断", "未核实线索", "被反证"] as const;
export type ResearchTier = (typeof RESEARCH_TIERS)[number];

/** 唯一允许没有依据的一档。 */
export const UNVERIFIED: ResearchTier = "未核实线索";
/** 直接来自披露/行情源，可回溯到具体接口或文件。 */
export const CONFIRMED: ResearchTier = "已披露证实";
/** 由代码按规则推出、但不是原始数据本身（估值判读、温度计读数落这档）。 */
export const INFERRED: ResearchTier = "有依据的推断";
/** 被后来的证据反掉的旧结论。 */
export const REFUTED: ResearchTier = "被反证";
