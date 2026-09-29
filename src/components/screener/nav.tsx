import type { ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";

const LINKS = [
  { to: "/", label: "选股" },
  { to: "/news", label: "消息" },
  { to: "/flow", label: "资金" },
] as const;

export function TopNav() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  return (
    <nav className="flex rounded-full bg-surface-2 p-0.5">
      {LINKS.map((link) => (
        <Link
          key={link.to}
          to={link.to}
          className={"rounded-full px-3 py-1 text-sm " + (path === link.to ? "bg-surface text-fg" : "text-muted")}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}

export function Frame({
  aside,
  extra,
  children,
}: {
  aside?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line bg-bg/90 backdrop-blur-md">
        <div className="mx-auto max-w-3xl px-4 md:px-6">
          <div className="flex h-14 items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <Link to="/" className="shrink-0 text-base font-semibold tracking-tight">
                赤衡
              </Link>
              <TopNav />
            </div>
            {aside}
          </div>
          {extra}
        </div>
      </header>
      <main className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-4 md:px-6">{children}</main>
    </div>
  );
}
