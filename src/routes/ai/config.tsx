/**
 * 这个文件是干什么的：
 * 「AI 管理」区的「接口配置」子页（/ai/config）。多套接口档案并存、启用一套
 * 跑所有闭环（因子层 / 策略层 / 自动进化共用）。
 *
 * 你需要知道的：
 * - 2026-10-21 由 AI 管理整页拆出（原来是本地状态的 PageTabs）。
 * - 选服务商预设后只填 API key 即可；单价留空自动按内置参考价填入。
 * - AI 的产出只许是白名单表达式（因子）或出场参数旋钮（策略），过不了校验
 *   的直接拒；判决永远由预先登记的函数说了算。
 */

import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { getAIStatus } from "@/lib/market/quotes.functions";
import { AISectionTabs, ConfigBlock, Section, type AIStatusPayload } from "@/components/ai-panels";

export const Route = createFileRoute("/ai/config")({
  loader: async () => {
    const ai = await getAIStatus().catch((): AIStatusPayload => ({ allowed: false, configured: false, baseUrl: null, model: null, keyTail: null, autoEvolve: false, activeId: null, profiles: [], fallbackOrder: [] }));
    return { ai };
  },
  component: AIConfigPage,
});

function AIConfigPage() {
  const { ai } = Route.useLoaderData();
  return (
    <Frame wide aside="AI 管理 · 接口配置">
      <AISectionTabs />
      <Section
        id="ai-config"
        title="AI 接口配置"
        hint="多套接口档案并存、启用一套跑所有闭环（因子层 / 策略层 / 自动进化共用）。AI 的产出只许是白名单表达式（因子）或出场参数旋钮（策略），过不了校验的直接拒；判决永远由预先登记的函数说了算。"
      >
        <ConfigBlock ai={ai} />
      </Section>
    </Frame>
  );
}
