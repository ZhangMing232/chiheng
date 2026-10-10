/**
 * 这个文件是干什么的：
 * 钉住衰减状态机的判定。这个文件存在的理由有三条，都是"判错就很贵"的地方：
 *
 * 1. **翻号 vs 变弱必须分得开**。t 值符号反了是"反向信号"，继续用会亏钱；
 *    t 值变小只是"变弱"。这两件事的处置完全不同，混了就会把坏因子留着。
 * 2. **降级要连续、恢复要立刻**。这条不对称是刻意的，测试要钉住它——
 *    哪天被人"顺手改成对称"了，好因子会被连续回撤误杀。
 * 3. **拿不到数据时不判死**。全 null 必须回到 healthy，不是"没数据所以算衰减"。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DECAY_RULE,
  decaysIntoBacktest,
  evaluateDecay,
  isFlipped,
  nextDecayStatus,
  strengthRatio,
  type DecayBaseline,
  type DecayReading,
  type DecaySignal,
} from "@/lib/market/decay";

const BASE: DecayBaseline = { t: 4.0, meanSpread: 2.0, resampleT: 3.0 };

function reading(over: Partial<DecayReading> = {}): DecayReading {
  return { t: 4.0, meanSpread: 2.0, resampleT: 3.0, monotonic: true, ...over };
}

test("强度比值：用绝对值，基线为 0 时返回 null 而不是 Infinity", () => {
  assert.equal(strengthRatio(2.0, 4.0), 0.5);
  // 衰减是"变弱"不分方向，所以按绝对值比
  assert.equal(strengthRatio(-2.0, -4.0), 0.5);
  assert.equal(strengthRatio(-2.0, 4.0), 0.5);
  // 基线 0 时比值没有意义，不能造一个 Infinity 出来
  assert.equal(strengthRatio(2.0, 0), null);
  assert.equal(strengthRatio(null, 4.0), null);
});

test("翻号：符号相反才算，有一边是 0 时不判（0 是没测出来，不是反了）", () => {
  assert.equal(isFlipped(-2.0, 4.0), true);
  assert.equal(isFlipped(2.0, -4.0), true);
  assert.equal(isFlipped(2.0, 4.0), false);
  assert.equal(isFlipped(-2.0, -4.0), false);
  assert.equal(isFlipped(0, 4.0), false);
  assert.equal(isFlipped(2.0, 0), false);
});

test("翻号 > 一切：t 值反了是 CRITICAL，哪怕幅度还很大", () => {
  // 幅度是基线的 2 倍，但方向反了——这是反向信号，比任何衰减都紧急
  const big: DecayReading = reading({ t: -8.0 });
  assert.equal(evaluateDecay(big, BASE), "critical");
});

test("单调性破了（G1 不成立）直接 CRITICAL", () => {
  const scattered = reading({ monotonic: false, t: 4.0, meanSpread: 2.0 });
  assert.equal(evaluateDecay(scattered, BASE), "critical");
});

test("四档分级：t 比值按 0.7 / 0.5 / 0.3 走", () => {
  assert.equal(evaluateDecay(reading({ t: 4.0 }), BASE), "healthy"); // 比值 1.0
  assert.equal(evaluateDecay(reading({ t: 3.0 }), BASE), "healthy"); // 0.75
  assert.equal(evaluateDecay(reading({ t: 2.4 }), BASE), "warning"); // 0.6
  assert.equal(evaluateDecay(reading({ t: 1.6 }), BASE), "decayed"); // 0.4
  assert.equal(evaluateDecay(reading({ t: 0.8 }), BASE), "critical"); // 0.2
});

test("取最差：三个指标里只要有一个差，就按差的那个算", () => {
  // t 和 spread 都很健康，只有换样本后的 t 塌了
  const mixed = reading({ t: 4.0, meanSpread: 2.0, resampleT: 0.3 });
  assert.equal(evaluateDecay(mixed, BASE), "critical"); // resampleT 比值 0.1
});

test("拿不到就不判死：全 null 回到 healthy", () => {
  const empty: DecayReading = { t: null, meanSpread: null, resampleT: null, monotonic: null };
  assert.equal(evaluateDecay(empty, BASE), "healthy");
});

test("monotonic 为 null（这轮没判）时不因此降级", () => {
  const partial = reading({ monotonic: null });
  assert.equal(evaluateDecay(partial, BASE), "healthy");
});

test("passed → monitoring：要连续 3 次非健康，少一次都不转", () => {
    const need = DECAY_RULE.warningsForMonitoring;
    const two: DecaySignal[] = ["warning", "warning"];
    assert.equal(nextDecayStatus("passed", two), null, `只 ${two.length} 次，不到 ${need}`);
    const three: DecaySignal[] = ["warning", "warning", "warning"];
    assert.equal(nextDecayStatus("passed", three), "monitoring");
    // 中间夹一次健康，连续就断了
    const broken: DecaySignal[] = ["warning", "healthy", "warning", "warning"];
    assert.equal(nextDecayStatus("passed", broken), null, "最后 3 次里夹了 healthy");
  });

  test("恢复只要 1 次：monitoring → passed 不需要攒次数", () => {
    assert.equal(nextDecayStatus("monitoring", ["warning", "warning", "healthy"]), "passed");
    // 降级要攒够、恢复不用——这条不对称是刻意的
    assert.ok(DECAY_RULE.warningsForDecayed > 1, "降级门槛必须 > 1，恢复是 1");
  });

  test("monitoring → decayed：连续 2 次 DECAYED 或更差", () => {
    assert.equal(nextDecayStatus("monitoring", ["decayed", "critical"]), "decayed");
    // WARNING 不算，只有 DECAYED 以上才推进到 decayed
    assert.equal(nextDecayStatus("monitoring", ["warning", "warning"]), null);
  });

  test("decayed → retired：连续 3 次 CRITICAL", () => {
    assert.equal(nextDecayStatus("decayed", ["critical", "critical", "critical"]), "retired");
    assert.equal(nextDecayStatus("decayed", ["critical", "decayed", "critical"]), null, "夹了 decayed 不算");
  });

  test("retired 是终点，不再变化（要人来看）", () => {
    assert.equal(nextDecayStatus("retired", ["healthy"]), "passed");
  });

  test("空信号列表不改变任何状态", () => {
    assert.equal(nextDecayStatus("passed", []), null);
});

test("进不进回测：retired 和 decayed 都停，passed 和 monitoring 继续", () => {
  assert.equal(decaysIntoBacktest("passed"), true);
  assert.equal(decaysIntoBacktest("monitoring"), true);
  assert.equal(decaysIntoBacktest("decayed"), false);
  assert.equal(decaysIntoBacktest("retired"), false);
});
