/**
 * 个股自身 PE 历史分位的守门测试。
 *
 * 钉住三件事：
 * 1. **无前视**（最重要）：砍掉未来的 PE 数据重算，之前每一天的分位必须逐点相同。
 *    这是 relValPersist 的全部可信度所在——分位窗口一旦扫到未来，
 *    结果不但错，还会显得很漂亮（假阳性）。
 * 2. **分位口径**：中位秩。窗口内最便宜那天 ≈ 0、最贵那天 ≈ 100；
 *    PE 长期打平（全是同一个值）时给 50（中性），不是 100（那会误判成「一直最贵」）。
 * 3. **持续性 streak**：连续低位累加，一断就归零；PE 缺失 / 窗口没攒够当天不可用且 streak 归零。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { computePePercentiles, type PeSeriesEntry } from "@/lib/market/pe-percentile";

/** 生成 n 天连续的真实 ISO 日期（2026-01-01 起）。日期必须字典序=时间序，否则排序会乱。 */
function dates(n: number): string[] {
  const base = Date.UTC(2026, 0, 1);
  return Array.from({ length: n }, (_, i) => new Date(base + i * 86400_000).toISOString().slice(0, 10));
}

/** 生成 n 天连续 PE。 */
function series(n: number, pe: (i: number) => number | null): PeSeriesEntry[] {
  const ds = dates(n);
  return Array.from({ length: n }, (_, i) => ({ date: ds[i], pe: pe(i) }));
}

test("无前视：砍掉未来数据重算，之前每一天的分位逐点相同", () => {
  const full = series(120, (i) => 10 + (i % 17) + (i > 60 ? 3 : 0));
  const opts = { windowDays: 30, cheapThresh: 25, minWindow: 10, minHistory: 10 };
  const withFuture = computePePercentiles(full, opts);
  const truncated = computePePercentiles(full.slice(0, 70), opts);

  assert.ok(truncated.size > 0, "截断后仍应有分位结果");
  for (const [date, v] of truncated) {
    const w = withFuture.get(date);
    assert.ok(w, `完整结果里缺 ${date}`);
    // NaN 用 Object.is 比（NaN !== NaN）
    assert.ok(
      Object.is(w.pct, v.pct),
      `${date} 的 pct 被未来数据改了：完整=${w.pct} 截断=${v.pct}`,
    );
    assert.equal(w.streak, v.streak, `${date} 的 streak 被未来数据改了`);
  }
});

test("分位口径：窗口内最便宜 ≈0、最贵 ≈100；PE 全打平给 50（中性）", () => {
  // 先涨后跌：最后一天是窗口内最便宜的
  const s = series(80, (i) => (i < 40 ? 10 + i : 50 - (i - 40)));
  const m = computePePercentiles(s, { windowDays: 20, cheapThresh: 25, minWindow: 5, minHistory: 5 });
  const last = m.get(s[s.length - 1].date)!;
  assert.ok(last.pct < 5, `窗口内最低 PE 的分位应接近 0，实际 ${last.pct}`);

  // 第 39 天是那段的最高点，窗口内最贵
  const peak = m.get(s[39].date)!;
  assert.ok(peak.pct > 95, `窗口内最高 PE 的分位应接近 100，实际 ${peak.pct}`);

  // PE 全部一样 → 中位秩给 50（中性），不是 100
  const flat = series(40, () => 42);
  const fm = computePePercentiles(flat, { windowDays: 20, cheapThresh: 25, minWindow: 5, minHistory: 5 });
  const flatPct = fm.get(flat[39].date)!.pct;
  assert.ok(Math.abs(flatPct - 50) < 1e-9, `PE 全打平应给 50（中性），实际 ${flatPct}`);
});

test("streak：连续低位累加，转贵就归零；窗口没攒够/PE 缺失当天不可用且 streak 归零", () => {
  // 前 60 天高位(100)，之后 20 天低位(10) → 低位期间持续处于自身历史便宜区
  const s = series(81, (i) => (i < 60 ? 100 : i < 80 ? 10 : 100));
  const m = computePePercentiles(s, { windowDays: 250, cheapThresh: 25, minWindow: 5, minHistory: 5 });

  assert.equal(m.get(s[60].date)!.streak, 1, "第一个低位日 streak 应为 1");
  assert.ok(
    m.get(s[60].date)!.pct <= 25,
    `低位日分位应 ≤25，实际 ${m.get(s[60].date)!.pct}`,
  );
  assert.equal(m.get(s[79].date)!.streak, 20, "连续 20 个低位日 streak 应为 20");
  assert.equal(m.get(s[80].date)!.streak, 0, "跳回高位当天 streak 必须归零");

  // PE 缺失（null）当天：pct 不可用（NaN，不是 0），streak 归零
  const s2 = series(81, (i) => (i === 60 ? null : i < 60 ? 100 : i < 80 ? 10 : 100));
  const m2 = computePePercentiles(s2, { windowDays: 250, cheapThresh: 25, minWindow: 5, minHistory: 5 });
  const gap = s2[60].date;
  assert.ok(Number.isNaN(m2.get(gap)!.pct), "PE 缺失当天 pct 应为 NaN（不可用），不能是 0");
  assert.equal(m2.get(gap)!.streak, 0, "PE 缺失当天 streak 归零");

  // 窗口没攒够（有效观测 < minWindow）→ 不可用，不是 0
  const s3 = series(81, () => 10);
  const m3 = computePePercentiles(s3, { windowDays: 250, cheapThresh: 25, minWindow: 500, minHistory: 5 });
  assert.ok(Number.isNaN(m3.get(s3[80].date)!.pct), "窗口没攒够时 pct 应为 NaN");
});

test("样本不足 minHistory 时返回空表（不硬算分位）", () => {
  const m = computePePercentiles(series(20, () => 10), { minHistory: 60 });
  assert.equal(m.size, 0, "PE 观测不足 60 条时应直接不给分位");
});
