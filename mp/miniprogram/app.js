/**
 * 这个文件是干什么的：
 * 进小程序第一件事：连上云开发环境，并把明暗偏好读出来。
 *
 * 你需要知道的：
 * 云开发环境 ID 在 config.js 里改。没填之前这里会提示，页面照样能打开，
 * 只是拉不到数据——先看到界面，再补环境，比一起卡住好排查。
 */
const { ENV_ID } = require("./config.js");

App({
  globalData: {
    theme: "dark",
    envReady: false,
  },

  onLaunch() {
    // 明暗：跟系统走，也允许用户自己在「显示」里切（存本地）
    const saved = wx.getStorageSync("theme");
    const sys = wx.getSystemInfoSync().theme || "light";
    this.globalData.theme = saved || sys;

    if (!wx.cloud) {
      console.error("没有 wx.cloud——基础库太旧，或者不是云开发项目");
      return;
    }
    wx.cloud.init({ env: ENV_ID, traceUser: true });
    this.globalData.envReady = ENV_ID && !ENV_ID.includes("在这里填");
  },
});
