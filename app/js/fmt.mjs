// Number and text formatting shared by every view.
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function usd(x, { compact = true, digits } = {}) {
  if (x == null || !Number.isFinite(x)) return "—";
  const a = Math.abs(x);
  if (compact && a >= 1e9) return `$${(x / 1e9).toFixed(2)}B`;
  if (compact && a >= 1e6) return `$${(x / 1e6).toFixed(2)}M`;
  if (compact && a >= 1e4) return `$${(x / 1e3).toFixed(1)}K`;
  return `$${x.toLocaleString("en-US", { maximumFractionDigits: digits ?? (a < 10 ? 2 : 0), minimumFractionDigits: digits ?? 0 })}`;
}

export function price(x, ref) {
  if (x == null || !Number.isFinite(x)) return "—";
  const r = Math.abs(ref ?? x);
  const d = r >= 10_000 ? 1 : r >= 100 ? 2 : r >= 1 ? 4 : r >= 0.01 ? 5 : 7;
  return x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function qty(x) {
  if (x == null || !Number.isFinite(x)) return "—";
  const a = Math.abs(x);
  const d = a >= 1000 ? 0 : a >= 1 ? 3 : 5;
  return x.toLocaleString("en-US", { maximumFractionDigits: d });
}

export const pct = (x, d = 1) => (x == null || !Number.isFinite(x) ? "—" : `${(x * 100).toFixed(d)}%`);
export const int = (x) => (x == null ? "—" : Number(x).toLocaleString("en-US"));
export const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");

export function ago(ms) {
  if (!ms) return "—";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const baseOf = (symbol) => (symbol || "").split("/")[0];
