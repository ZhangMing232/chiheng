export function toneClass(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n === 0) return "text-muted";
  return n > 0 ? "text-up" : "text-down";
}

export function signedPct(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const body = Math.abs(n).toFixed(digits);
  if (n > 0) return `+${body}%`;
  if (n < 0) return `-${body}%`;
  return `${body}%`;
}

export function fmtPrice(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  return n.toFixed(2);
}

export function fmtCap(yi: number): string {
  if (!Number.isFinite(yi) || yi <= 0) return "—";
  if (yi >= 10000) return `${(yi / 10000).toFixed(2)}万亿`;
  if (yi >= 100) return `${Math.round(yi)}亿`;
  return `${yi.toFixed(1)}亿`;
}

export function fmtWan(wan: number, hideZero = false): string {
  if (!Number.isFinite(wan) || (hideZero && wan === 0)) return "—";
  const sign = wan < 0 ? "-" : "";
  const abs = Math.abs(wan);
  if (abs >= 10000) return `${sign}${(abs / 10000).toFixed(2)}亿`;
  if (abs >= 100) return `${sign}${Math.round(abs)}万`;
  return `${sign}${abs.toFixed(1)}万`;
}

export function fmtPlain(n: number | null | undefined, digits = 2, hideZero = false): string {
  if (n == null || !Number.isFinite(n) || (hideZero && n === 0)) return "—";
  return n.toFixed(digits);
}

export function fmtMultiple(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || Math.abs(n) > 5000) return "—";
  return n.toFixed(n >= 100 ? 0 : 1);
}
