/**
 * 这个文件是干什么的：
 * 把散在五个模块里的判据常量聚成一份「闸门面板」数据——数据审计闸、进化熔断、
 * 因子衰减、挑战者判决、策略闸门。**只读**：改阈值要到各自的 RULE 常量里带理由改，
 * 这里不复制数值（条目是运行时用常量拼的，不会出现「面板写着 30、代码已是 45」
 * 的两份数字），文案（label/note）以这里为唯一出处。
 *
 * 为什么需要它：
 * 这些阈值以前只活在代码常量里，界面上一处都看不到——「连续几轮断电」「衰减
 * 三档各是多少」全凭翻源码。面板让闸门可见；可见才谈得上「灵活调整」。
 * 调整入口：挑战者那组改 data/challenger-rule.json（优化闭环自动调纸面参数、
 * 核心阈值走 /ai 页人工审批），其余四组仍是改各自 RULE 常量。
 *
 * 你需要知道的：
 * 1. **server-only**：五个常量模块的 import 链里有 node:fs，被打进前端会炸。
 *    页面只能经 server function 拿这份数据（quotes.functions.ts 的 getSystemRules）。
 * 2. systemRules() 是纯函数，返回值完全由五个常量决定，可以安全单测。
 * 3. 每个条目给三样：label（判据名）、value（当前值，带单位）、note（超了会怎样/
 *    为什么是这个数）。note 是给人看的判据解释，写在这里一处，页面只渲染。
 */

import { AUDIT_RULE } from "./data-audit.ts";
import { BREAKER_RULE } from "./evolve-breaker.ts";
import { DECAY_RULE } from "./decay.ts";
import { CHALLENGER_RULE, loadChallengerRule, type ChallengerRule } from "./challenger.ts";
import { STRATEGY_GATE } from "./strategy-gate.ts";

export type RuleEntry = {
  /** 组内唯一 id，如 "a1-intraday"。 */
  id: string;
  label: string;
  /** 当前值，已带单位（「30 分钟」「≥ 280 只」）。 */
  value: string;
  /** 判据含义：超了会发生什么 / 为什么是这个数。 */
  note: string;
};

export type RuleGroup = {
  id: string;
  title: string;
  /** 出处文件——让人知道去改哪。 */
  source: string;
  entries: RuleEntry[];
};

/**
 * 五个常量 → 面板数据。加判据 = 往对应组里加一条，不改框架。
 * 挑战者这组支持传入 rule（默认代码默认）：页面走 loadSystemRules() 读数据文件里的
 * 实际生效值，单测传默认值锁口径，两边同一份拼装逻辑。
 */
export function systemRules(rule: ChallengerRule = CHALLENGER_RULE): RuleGroup[] {
  return [
    {
      id: "audit",
      title: "数据审计闸",
      source: "src/lib/market/data-audit.ts · AUDIT_RULE",
      entries: [
        {
          id: "a1-universe",
          label: "行情快照新鲜度",
          value: `盘中 ≤ ${AUDIT_RULE.universeMaxAgeMin.intraday} 分钟 · 盘前 ≤ ${AUDIT_RULE.universeMaxAgeMin.premarket / 60} 小时`,
          note: "block 级：过期 = 当晚判决回测整个不跑，数据不合格不出数。盘前口径放宽是因为夜里本就不更新。",
        },
        {
          id: "a2-kline",
          label: "K 线缓存覆盖",
          value: `≥ ${AUDIT_RULE.minKlineCache} 只`,
          note: "block 级：回测抽样 300 只要留缓冲，缓存不够就没有原料，宁可不跑。",
        },
        {
          id: "a3-cap",
          label: "市值快照新鲜度",
          value: `≤ ${AUDIT_RULE.capMaxAgeDays} 天`,
          note: "warn 级：过期不挡跑，但市值过滤会拿旧快照失真，记账叫人。",
        },
        {
          id: "a4-verdict",
          label: "判决日志新鲜度",
          value: `≤ ${AUDIT_RULE.verdictMaxAgeDays} 天`,
          note: "warn 级：判决过期意味着 AI 的 prompt 在拿旧账做决策。",
        },
        {
          id: "a5-fund",
          label: "财报基本面库新鲜度",
          value: `≤ ${AUDIT_RULE.fundMaxAgeDays} 天`,
          note: "warn 级：财报按季披露，45 天约一个半月。基本面因子已证伪所以不挡跑，但重测前必须先抓数。",
        },
      ],
    },
    {
      id: "breaker",
      title: "进化熔断器",
      source: "src/lib/market/evolve-breaker.ts · BREAKER_RULE",
      entries: [
        {
          id: "b1-trip",
          label: "断电条件",
          value: `连续 ${BREAKER_RULE.maxConsecutiveErrors} 轮「因子层+策略层」都失败`,
          note: "达到即关自动进化 + PushPlus 推送 + 留档。任何一层成功就清零——防的是连续空转烧钱，不是单次犯错。",
        },
      ],
    },
    {
      id: "decay",
      title: "因子衰减",
      source: "src/lib/market/decay.ts · DECAY_RULE",
      entries: [
        {
          id: "d1-thresholds",
          label: "三档阈值（当前值 / 过关基线）",
          value: `健康 ≥ ${DECAY_RULE.tRatio.healthy} · 预警 ≥ ${DECAY_RULE.tRatio.warning} · 衰减 ≥ ${DECAY_RULE.tRatio.decayed}`,
          note: "t 值、spread、换样本 t 三把尺子同一套档位。过关只是入场券，之后每轮拿基线当尺子量。",
        },
        {
          id: "d2-monitoring",
          label: "passed → 观察中",
          value: `预警连续 ${DECAY_RULE.warningsForMonitoring} 轮`,
          note: "到观察中还会跑，但已被点名看紧。",
        },
        {
          id: "d3-decayed",
          label: "观察中 → 已衰减·停跑",
          value: `衰减档连续 ${DECAY_RULE.warningsForDecayed} 轮`,
          note: "停跑 = 不再进回测，和淘汰（tombstone）对口。",
        },
        {
          id: "d4-retired",
          label: "衰减 → 退役",
          value: `critical 连续 ${DECAY_RULE.criticalForRetired} 轮`,
          note: "退役是终态，不再回来。",
        },
      ],
    },
    {
      id: "challenger",
      title: "挑战者判决",
      source: "src/lib/market/challenger.ts · CHALLENGER_RULE",
      entries: [
        {
          id: "c1-window",
          label: "判决样本",
          value: `${rule.minTrades} 笔起判 · 上限 ${rule.maxTrades} 笔`,
          note: "攒不够起判笔数不判决（小样本 t 值是噪音）；跑满上限还分不出胜负 → 停跑不占样本。数值来自 data/challenger-rule.json（缺省回代码默认）。",
        },
        {
          id: "c2-verdicts",
          label: "转正 / 淘汰线",
          value: `转正 t ≥ ${rule.promoteT} 且均值更高 · 淘汰 t ≤ ${rule.rejectT}`,
          note: "挑战者跑的是已平仓样本的 Welch 检验，对线的是冠军参数。核心阈值改动需人工确认。",
        },
      ],
    },
    {
      id: "strategy-gate",
      title: "策略闸门",
      source: "src/lib/market/strategy-gate.ts · STRATEGY_GATE",
      entries: [
        {
          id: "s1-disable",
          label: "停用线",
          value: `最近 ${STRATEGY_GATE.window} 笔 t ≤ ${STRATEGY_GATE.disableT} → 停用`,
          note: "「这套在亏」的判据。攒不够 20 笔不判——一天 10 只也要两个交易周。",
        },
        {
          id: "s2-cooldown",
          label: "冷却与假释",
          value: `冷却 ${STRATEGY_GATE.cooldownDays} 天起 · 再犯翻倍至 ${STRATEGY_GATE.maxCooldownDays} 天上限 · 假赦 t > ${STRATEGY_GATE.restoreT} 转正`,
          note: "停用不是枪毙：假释期每天限 1 只，攒够样本且 t 回正恢复每天 10 只。",
        },
      ],
    },
  ];
}

/**
 * 页面用的活数据：挑战者这组读 data/challenger-rule.json 的实际生效值
 * （优化循环/人工审批可能已改过），不再只显示代码默认。
 * 其他四组仍是常量。读文件失败 → 自动退回代码默认（loadChallengerRule 内建）。
 */
export async function loadSystemRules(): Promise<RuleGroup[]> {
  return systemRules(await loadChallengerRule());
}
