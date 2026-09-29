import type { Quote } from "./types.ts";
import type { StyleId } from "./strategies.ts";

export type Prefs = {
  style: StyleId;
  board: "all" | "main" | "cyb" | "kcb";
  price: "all" | "low" | "mid" | "high";
  cap: "all" | "small" | "mid" | "large";
};

export const DEFAULT_PREFS: Prefs = { style: "early", board: "all", price: "all", cap: "all" };

const STYLES: StyleId[] = ["early", "trend", "breakout", "value"];

export function parsePrefs(data: unknown): Prefs | null {
  if (typeof data !== "object" || data === null) return null;
  const raw = data as Record<string, unknown>;
  const next = { ...DEFAULT_PREFS };
  if (raw.style == null) next.style = "early";
  else if (STYLES.includes(raw.style as StyleId)) next.style = raw.style as StyleId;
  else return null;
  if (raw.board === "all" || raw.board === "main" || raw.board === "cyb" || raw.board === "kcb") next.board = raw.board;
  else if (raw.board != null) return null;
  if (raw.price === "all" || raw.price === "low" || raw.price === "mid" || raw.price === "high") next.price = raw.price;
  else if (raw.price != null) return null;
  if (raw.cap === "all" || raw.cap === "small" || raw.cap === "mid" || raw.cap === "large") next.cap = raw.cap;
  else if (raw.cap != null) return null;
  return next;
}
export function matchPrefs(quote: Quote, prefs: Prefs): boolean {
  if (prefs.board === "main" && quote.board !== "sh" && quote.board !== "sz") return false;
  if (prefs.board === "cyb" && quote.board !== "cyb") return false;
  if (prefs.board === "kcb" && quote.board !== "kcb") return false;
  if (prefs.price === "low" && !(quote.price < 10)) return false;
  if (prefs.price === "mid" && !(quote.price >= 10 && quote.price <= 30)) return false;
  if (prefs.price === "high" && !(quote.price > 30)) return false;
  if (prefs.cap === "small" && !(quote.cap < 100)) return false;
  if (prefs.cap === "mid" && !(quote.cap >= 100 && quote.cap <= 500)) return false;
  if (prefs.cap === "large" && !(quote.cap > 500)) return false;
  return true;
}
