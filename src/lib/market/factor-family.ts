/**
 * 这个文件是干什么的：
 * 因子家族的共线检查。学 deepseek-harness-quant 的 factor_risk.py：
 * 它按词根把 123+ 因子聚成家族，只有「家族代表」能直通决策层——
 * 防止 80 个因子其实是同一个东西被计 80 次。
 *
 * 赤轨的因子少得多（26 个注册 + AI 队列），但同样的问题已经存在：
 * std20/std60/amp20/volCompress 全是「低波」家族同方向，
 * amountWan/floatCap/c 全是「规模」家族同方向。将来 AI 批量提议因子时，
 * 不设这道闸，队列会被一族微调变体灌水。
 *
 * 你需要知道的：
 * 1. 这是**注册表层的近似警告**，不是统计共线。真共线要看因子取值序列的
 *    相关系数，那需要数据，是回测的活。这里回答的问题更便宜也更重要：
 *    「这两个因子是不是同一个概念的不同窗口」——是，就点名。
 * 2. 判据 = 家族相同 **且** 方向相同。方向相反的不算（反转因子和动量因子
 *    可能同源，但一个赚另一个亏，同时活着不是重复计数）。
 * 3. 纯函数，无 fs / fetch，直接单测。
 */

/** 参与家族判定的最小信息。Factor 和队列条目都能满足。 */
export type FamilyMember = {
  id: string;
  name: string;
  direction: 1 | -1;
  /** 没标家族的（AI 队列因子）各自成族，用 id 当族名。 */
  family?: string;
};

export type FamilyClash = {
  /** 家族名。 */
  family: string;
  direction: 1 | -1;
  /** 族内成员，按 id 排序，输出稳定。 */
  members: { id: string; name: string }[];
};

/** 单条的族名。没标家族 = 自成一族（AI 提的 slug 不会和别人撞族）。 */
export function familyOf(member: FamilyMember): string {
  return member.family ?? member.id;
}

/**
 * 族 + 方向都相同的 **2 个及以上** 成员组。返回按族名排序，输出稳定好测试。
 * 同族不同方向的故意不点名——见文件头第 2 条。
 */
export function familyClashes(members: FamilyMember[]): FamilyClash[] {
  const groups = new Map<string, FamilyMember[]>();
  for (const m of members) {
    const key = `${familyOf(m)}|${m.direction}`;
    const list = groups.get(key) ?? [];
    list.push(m);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .filter(([, list]) => list.length >= 2)
    .map(([key, list]) => {
      const [family, dir] = key.split("|");
      return {
        family,
        direction: Number(dir) as 1 | -1,
        members: list
          .map((m) => ({ id: m.id, name: m.name }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      };
    })
    .sort((a, b) => a.family.localeCompare(b.family, "zh-Hans-CN"));
}
