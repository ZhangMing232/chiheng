/**
 * 这个文件是干什么的：
 * AI 服务商预设目录——「只填一个 key 就搞定」的那部分。弹窗顶部选服务商，
 * baseUrl / 常用模型 / 计价参考自动预填，用户只贴 API key。预设是纯数据，
 * 不依赖 fs / factor-queue，前端组件直接 import。
 *
 * 你需要知道的：
 * 1. **baseUrl 和模型是连通性事实**，预填为值；**计价是市场信息会变**，预设里只放
 *    priceHint 当占位提示；保存档案时若单价留空，另由 ai-prices.ts 的内置参考价目表
 *    自动填入（可改）——两层分工：预设管「填什么提示」，价目表管「默认值是哪来的」。
 * 2. models 非空时弹窗把它当默认模型 + 下拉候选；空（如自定义、本地 Ollama）
 *    就走「从接口拉模型清单」。
 * 3. 加服务商 = 往数组里加一条，别加分支逻辑。
 */

export type AIPreset = {
  id: string;
  name: string;
  baseUrl: string;
  /** 常用模型（第一项当默认）；空 = 弹窗里手填或拉清单。 */
  models: string[];
  /** 计价参考（元/百万 tokens），只作输入框占位提示，不自动填。 */
  priceHint?: { prompt?: string; completion?: string };
  /** 申请 key 的注意事项（key 在哪申请、常见翻车点），弹窗里显示给户看。 */
  hint?: string;
};

export const PROVIDER_PRESETS: AIPreset[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
    priceHint: { prompt: "deepseek-chat 约 2，reasoner 约 4", completion: "deepseek-chat 约 8，reasoner 约 16" },
    hint: "API key 在 platform.deepseek.com 控制台申请（sk- 开头）；需要账户有余额（充值后按量扣费），Chat 会员的 key 不能调 API。",
  },
  {
    id: "moonshot",
    name: "Moonshot Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    // 官方模型列表（platform.moonshot.cn/docs）：kimi-k2 全系与 moonshot-v1 系列已下线，
    // 调旧名会快速返回「模型不存在」。这是「新建了感觉没用」最常见的第二个原因。
    models: ["kimi-k3", "kimi-k2.7-code-highspeed", "kimi-k2.7-code", "kimi-k2.6"],
    priceHint: { prompt: "k2.6 输入约 6.5，k2.7-code 约 6.5（k3 约 20）", completion: "k2.6/k2.7-code 输出约 27（k3 约 100，高速版约 54）" },
    hint: "API key 在 platform.moonshot.cn 控制台申请（sk- 开头）；Kimi 会员 / Kimi Code 的 key 不能调 API。kimi-k3 需先充值解锁；kimi-k2.7-code 思考模式关不掉（不需要思考就选 kimi-k2.6）。",
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-5", "gpt-5-mini", "gpt-4.1-mini"],
    hint: "API key 在 platform.openai.com 申请；国内网络直接访问不通，需要代理或中转。",
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4.6", "glm-4.5-air"],
    hint: "API key 在 open.bigmodel.cn 控制台申请。",
  },
  {
    id: "siliconflow",
    name: "硅基流动 SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    models: ["deepseek-ai/DeepSeek-V3.2-Exp", "Qwen/Qwen3-32B"],
    hint: "API key 在 cloud.siliconflow.cn 申请；新用户通常送小额体验金。",
  },
  {
    id: "ollama",
    name: "Ollama 本地",
    baseUrl: "http://localhost:11434/v1",
    models: [],
    priceHint: { prompt: "本地部署 = 0", completion: "本地部署 = 0" },
    hint: "先 ollama pull 一个模型（如 qwen2.5:14b）再 ollama serve；本地跑 0 费用但受机器性能限制。",
  },
  { id: "custom", name: "自定义（手填 baseUrl）", baseUrl: "", models: [] },
];
