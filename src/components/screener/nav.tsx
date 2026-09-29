import { Link, useRouterState } from "@tanstack/react-router";

const LINKS = [
  { to: "/", label: "选股" },
  { to: "/news", label: "消息" },
  { to: "/flow", label: "资金" },
] as const;

export function TopNav() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  return (
    <nav className="mt-2 flex gap-4">
      {LINKS.map((link) => (
        <Link
          key={link.to}
          to={link.to}
          className={"text-sm " + (path === link.to ? "text-[#5ad7ff]" : "text-muted")}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
