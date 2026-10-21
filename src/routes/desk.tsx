/**
 * 这个文件是干什么的：
 * 「合成台」。问一句，它只告诉你赤轨哪一页能答，以及哪些要求不做。
 *
 * 你需要知道的：
 * 这一页不拉行情、不跑模型、不下单。数字仍在它指向的那些页里。
 */
import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Panel, Tag } from "@/components/terminal";
import { DESK_TOOLS, planDesk, type DeskPlan } from "@/lib/market/desk-plan";

export const Route = createFileRoute("/desk")({
  component: DeskPage,
});

function DeskPage() {
  const [question, setQuestion] = useState("");
  const [plan, setPlan] = useState<DeskPlan | null>(null);

  return (
    <Frame>
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
        <Panel>
          <p className="text-sm leading-6 text-[var(--ink-dim)]">
            投研走已经接上的页面，交易走六套规则和模拟账。提问不会新写策略，也不会发到券商。
          </p>
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            rows={3}
            placeholder="例如：今天资金怎么样，或者这套回测过没过"
            className="mt-3 w-full rounded border border-[var(--line)] bg-transparent p-2 text-sm"
          />
          <button
            type="button"
            className="mt-2 rounded bg-[var(--ink)] px-3 py-1.5 text-sm text-[var(--paper)]"
            onClick={() => setPlan(planDesk(question))}
          >
            拆成运行单
          </button>
        </Panel>
        {plan ? <PlanView plan={plan} /> : null}
        <Panel>
          <p className="mb-2 text-sm">已经接上的</p>
          <ul className="flex flex-col gap-2">
            {DESK_TOOLS.map((tool) => (
              <li key={tool.id} className="text-sm leading-6">
                <Tag>{tool.side === "research" ? "研究" : "交易"}</Tag>{" "}
                <Link to={tool.to} className="underline">
                  {tool.title}
                </Link>
                <span className="text-[var(--ink-dim)]"> · {tool.does}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </Frame>
  );
}

function PlanView({ plan }: { plan: DeskPlan }) {
  return (
    <Panel>
      {plan.screened ? <p className="mb-2 text-sm">这句里有买卖建议，已拦住：{plan.screened}。这里不执行。</p> : null}
      {plan.refusals.map((line) => (
        <p key={line} className="mb-2 text-sm">
          不做：{line}
        </p>
      ))}
      {plan.tools.length === 0 ? (
        <p className="text-sm">现有工具对不上这句话。缺的就写缺，不另编一套答案。</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {plan.tools.map((tool) => (
            <li key={tool.id} className="text-sm">
              <Link to={tool.to} className="underline">
                {tool.title}
              </Link>
              <span className="text-[var(--ink-dim)]"> · {tool.does}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
