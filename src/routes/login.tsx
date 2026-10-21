/**
 * 这个文件是干什么的：
 * 注册 / 登录页——赤轨会员体系的门口（design/MEMBERSHIP.md）。
 *
 * 你需要知道的：
 * 1. 邮箱 + 密码一条路，走本应用自己的 Better Auth（/api/auth/*），
 *    不依赖 Grok OAuth broker（那是模板的中介，赤轨独立部署用不上）。
 * 2. 注册即 free 档；pro 档位目前由老板人工授予（scripts/grant-plan.ts），
 *    支付渠道拍板后接回调自动开（design/MEMBERSHIP.md §三）。
 * 3. 登录成功回首页；已登录再进来直接显示当前档位和退出按钮。
 * 4. 页面风格跟随 settings.tsx 的 Frame/Panel 约定，不另起炉灶。
 */

import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Panel } from "@/components/terminal";
import { authClient, signOut } from "@/lib/auth/client";
import { planLabel } from "@/lib/auth/plan";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const { user, isPending } = useCurrentUserState();
  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 会话还在解析就什么都别渲染，防止已登录用户闪一下表单。
  if (isPending) return null;

  if (user) {
    return (
      <Frame aside="账号">
        <Panel title="当前账号" note={planLabel(user.plan)}>
          <div className="space-y-3 px-3.5 py-3 text-sm">
            <p>
              <span className="text-muted">账号：</span>
              {user.primaryEmail ?? user.displayName ?? user.id}
            </p>
            <button
              type="button"
              disabled={busy}
              className="cursor-pointer rounded-md border border-neutral-300 px-4 py-1.5 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
              onClick={async () => {
                setBusy(true);
                try {
                  // signOut() 是 client.ts 的完整封装（清 bearer token + 跳首页），
                  // 比裸调 authClient.signOut() 干净——后者会留下 token 导致"退而不掉"。
                  await signOut("/");
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "正在退出…" : "退出登录"}
            </button>
          </div>
        </Panel>
      </Frame>
    );
  }

  const submit = async () => {
    setError(null);
    if (!email.includes("@")) return setError("邮箱格式不对");
    if (password.length < 8) return setError("密码至少 8 位");
    if (mode === "signUp" && name.trim().length === 0) return setError("起个名字");
    setBusy(true);
    try {
      if (mode === "signUp") {
        const { error: upErr } = await authClient.signUp.email({
          name: name.trim(),
          email: email.trim(),
          password,
        });
        if (upErr) return setError(upErr.message ?? "注册失败");
      } else {
        const { error: inErr } = await authClient.signIn.email({ email: email.trim(), password });
        if (inErr) return setError(inErr.message ?? "登录失败");
      }
      navigate({ to: "/" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame aside="账号">
      <Panel title={mode === "signIn" ? "登录赤轨" : "注册赤轨"} note="邮箱 + 密码">
        <form
          className="mx-auto flex w-full max-w-sm flex-col gap-3 px-3.5 py-4 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {mode === "signUp" && (
            <label className="flex flex-col gap-1">
              <span className="text-muted">名字</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="rounded-md border border-neutral-300 bg-transparent px-3 py-2 dark:border-neutral-700"
                autoComplete="nickname"
              />
            </label>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-muted">邮箱</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="rounded-md border border-neutral-300 bg-transparent px-3 py-2 dark:border-neutral-700"
              autoComplete="email"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted">密码（至少 8 位）</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="rounded-md border border-neutral-300 bg-transparent px-3 py-2 dark:border-neutral-700"
              autoComplete={mode === "signIn" ? "current-password" : "new-password"}
            />
          </label>
          {error && <p className="text-xs text-red-500">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="cursor-pointer rounded-md bg-neutral-900 px-4 py-2 text-neutral-100 hover:opacity-90 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
          >
            {busy ? "请稍候…" : mode === "signIn" ? "登录" : "注册并登录"}
          </button>
          <button
            type="button"
            className="cursor-pointer text-xs text-muted underline-offset-2 hover:underline"
            onClick={() => {
              setMode(mode === "signIn" ? "signUp" : "signIn");
              setError(null);
            }}
          >
            {mode === "signIn" ? "没有账号？注册一个（免费版）" : "已有账号？去登录"}
          </button>
        </form>
      </Panel>
    </Frame>
  );
}
