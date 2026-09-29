import { useEffect, useState, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";

const LINKS = [
  { to: "/", label: "选股" },
  { to: "/news", label: "消息" },
  { to: "/flow", label: "资金" },
] as const;

const TYPE_SIZES = [
  { id: "14", label: "小" },
  { id: "16", label: "标准" },
  { id: "18", label: "大" },
  { id: "20", label: "超大" },
] as const;

function useTypeSize() {
  const [size, setSize] = useState("16");
  useEffect(() => {
    const saved = localStorage.getItem("chiheng-type");
    if (TYPE_SIZES.some((item) => item.id === saved)) setSize(saved!);
  }, []);
  useEffect(() => {
    document.documentElement.style.fontSize = `${size}px`;
    localStorage.setItem("chiheng-type", size);
  }, [size]);
  return [size, setSize] as const;
}

export function TypeSize() {
  const [size, setSize] = useTypeSize();
  return (
    <div className="flex rounded-full bg-surface-2 p-0.5" aria-label="字号">
      {TYPE_SIZES.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => setSize(item.id)}
          className={"rounded-full px-2 py-1 text-xs " + (size === item.id ? "bg-surface text-fg" : "text-muted")}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

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
          <div className="flex min-h-14 flex-wrap items-center justify-between gap-2 py-2">
            <div className="flex min-w-0 items-center gap-3">
              <Link to="/" className="shrink-0 text-base font-semibold tracking-tight">
                赤衡
              </Link>
              <TopNav />
            </div>
            {aside ? <div className="flex shrink-0 items-center gap-2">{aside}<TypeSize /></div> : <TypeSize />}
          </div>
          {extra}
        </div>
      </header>
      <main className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-4 md:px-6">{children}</main>
    </div>
  );
}
