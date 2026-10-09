/**
 * 这个文件是干什么的：
 * AI 服务商预设目录——「只填一个 key 就搞定」的那部分。弹窗顶部选服务商，
 * baseUrl / 常用模型 / 计价参考自动预填，用户只贴 API key。预设是纯数据，
 * 不依赖 fs / factor-queue，前端组件直接 import。
 *
 * 你需要知道的：
 * 1. **baseUrl 和模型是连通性事实**，预填为值；**计价是市场信息会变**，只放
 *    priceHint 给弹窗当占位提示，不自动填值——多少钱还是你核对官网后说了算，
 *    系统不替你定价。
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
};

export const PROVIDER_PRESETS: AIPreset[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
    priceHint: { prompt: "deepseek-chat 约 2，reasoner 约 4", completion: "deepseek-chat 约 8，reasoner 约 16" },
  },
  {
    id: "moonshot",
    name: "Moonshot Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    models: ["kimi-k2-0905-preview", "kimi-k2-turbo-preview", "moonshot-v1-8k"],
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-5", "gpt-5-mini", "gpt-4.1-mini"],
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4.6", "glm-4.5-air"],
  },
  {
    id: "siliconflow",
    name: "硅基流动 SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    models: ["deepseek-ai/DeepSeek-V3.2-Exp", "Qwen/Qwen3-32B"],
  },
  {
    id: "ollama",
    name: "Ollama 本地",
    baseUrl: "http://localhost:11434/v1",
    models: [],
    priceHint: { prompt: "本地部署 = 0", completion: "本地部署 = 0" },
  },
  { id: "custom", name: "自定义（手填 baseUrl）", baseUrl: "", models: [] },
];
