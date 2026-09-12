export const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function fmtDuration(ms: number): string {
  if (!ms || ms < 0) return "0s";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

export const fmtTimestamp = (ms: number): string => {
  const d = new Date(ms || Date.now());
  const p = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export const roleOf = (id: string) =>
  id === "plan" ? "plan" : id === "verify" ? "verify" : id.endsWith("-fe") ? "frontend" : "backend";

export function pretty(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
