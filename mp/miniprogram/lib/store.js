/**
 * 这个文件是干什么的：
 * 本地优先那一层。小程序打开的瞬间先从本地存储把上次的数据画出来，
 * 云端的请求在后面悄悄追。追上了替换，追不上就用本地的，
 * 顶上一条细提示说明「这是上次的数据」。
 *
 * 为什么要这么做：
 * 「打开就能看」比「数据绝对最新」更要紧。刚打开时屏幕上有东西、
 * 数字是对的，用户才愿意等；先给一片空白加一个转圈，用户会以为坏了。
 * 云端只是慢一点，不该让它变成「没有」。
 *
 * 三件事：
 * 1. ensureSeed —— 第一次打开时把 web 版那份账本放进本地，立刻有东西看。
 * 2. sync      —— 云端拉回来就更新本地；云端空就把本地的推上去，不用手动导入。
 * 3. maybeRecord —— 今天没记过就静默记一次，配了定时触发器就是双保险。
 */
const api = require("./api.js");
const seedDays = require("./seed-days.js");

const K_DAYS = "chiheng-mp-days";
const K_META = "chiheng-mp-meta";
const K_CACHE = "chiheng-mp-cache";

function read(key, fallback) {
  try {
    const v = wx.getStorageSync(key);
    return v === "" || v === undefined || v === null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

function write(key, value) {
  try {
    wx.setStorageSync(key, value);
  } catch (e) {
    // 存储满了就满了，别让写入失败把整个流程带崩
  }
}

function byDateDesc(days) {
  return [...days].sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

module.exports = {
  /** 本地账本。页面第一屏用它渲染，保证不空白。 */
  localDays() {
    const days = read(K_DAYS, null);
    return days ? byDateDesc(days) : null;
  },

  saveDays(days) {
    write(K_DAYS, byDateDesc(days));
  },

  /**
   * 和云端对齐。返回 { days, from }，from 是 "cloud" 或 "local"。
   * 云函数没部署、网络断了，都不会抛错——本地那份照样给你。
   */
  async sync() {
    const local = this.localDays();
    const res = await api.readBook();

    if (!res.error && res.days && res.days.length > 0) {
      this.saveDays(res.days);
      return { days: byDateDesc(res.days), from: "cloud" };
    }

    // 云端还没有账 → 把本地那份推上去。第一个用的人不用点任何按钮。
    if (local && local.length > 0) {
      const push = await api.importSeed(local);
      if (!push.error) {
        const again = await api.readBook();
        if (!again.error && again.days && again.days.length > 0) {
          this.saveDays(again.days);
          return { days: byDateDesc(again.days), from: "cloud" };
        }
      }
      return { days: local, from: "local" };
    }

    return { days: null, from: "none", error: res.error };
  },

  /** 第一次打开：把 web 版那份账本放进本地，立刻有东西看。 */
  ensureSeed() {
    if (read(K_DAYS, null)) return false;
    write(K_DAYS, seedDays);
    return true;
  },

  meta() {
    return read(K_META, {});
  },

  setMeta(patch) {
    write(K_META, Object.assign({}, this.meta(), patch));
  },

  /**
   * 今天没记过就记一次。失败了不出声——这是后台同步，不该用弹窗打断用户。
   * 交易日判断交给 record 云函数（它自己认识法定节假日）。
   */
  async maybeRecord() {
    const { isTradingDay, shanghaiDate } = require("./market/session.js");
    const today = shanghaiDate();
    const meta = this.meta();
    if (meta.lastRecordDate === today) return { skipped: "今天已经记过了" };
    if (!isTradingDay(today)) {
      this.setMeta({ lastRecordDate: today });
      return { skipped: "今天不是交易日" };
    }
    const res = await api.runRecord();
    if (res.error) return { error: res.error };
    this.setMeta({ lastRecordDate: today, lastResult: res });
    return res;
  },

  /** 别的页面用：先给上次的缓存，再去云端刷新。返回 { cached, refresh }。 */
  cached(key, fetcher) {
    const cache = read(K_CACHE, {});
    const hit = cache[key] || null;
    return {
      cached: hit,
      refresh: async () => {
        const res = await fetcher();
        const payload = res && res.error ? null : res;
        if (payload) {
          const next = read(K_CACHE, {});
          next[key] = payload;
          next[key + "At"] = Date.now();
          write(K_CACHE, next);
        }
        return res;
      },
    };
  },
};
