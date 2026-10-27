/** Plain-text table: columns sized to content, last column not padded. */
export function table(headers: string[], rows: (string | number | null | undefined)[][]): string {
  if (rows.length === 0) return "(none)";
  const cells = [headers, ...rows.map((r) => r.map((c) => (c === null || c === undefined ? "-" : String(c))))];
  const widths = headers.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? "").length)));
  return cells
    .map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] as number))).join("  "))
    .join("\n");
}

/** 125.4 → "2:05"; 3725 → "1:02:05". */
export function clock(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "-";
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export const short = (id: string | null | undefined) => (id ? id.slice(0, 8) : "-");

export function truncate(text: string | null | undefined, max: number): string {
  if (!text) return "-";
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** "2026-10-27T08:54:19.609Z" → "2026-10-27 08:54". */
export const when = (iso: string | null | undefined) => (iso ? iso.replace("T", " ").slice(0, 16) : "-");

export function seconds(fromIso: string | null | undefined, toIso: string | null | undefined): string {
  if (!fromIso || !toIso) return "";
  const d = (Date.parse(toIso) - Date.parse(fromIso)) / 1000;
  return Number.isFinite(d) && d >= 0 ? `${Math.round(d)}s` : "";
}
