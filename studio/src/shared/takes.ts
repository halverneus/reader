// Which markers were recorded more than once.
//
// A marker recorded three times is a line that did not work out loud, and that
// is the most direct feedback the writing ever gets. Everything needed is
// already in session.json: the production engine stamps every event with
// { marker, take }, reset() bumps the take, and rewind() bumps it and jumps
// back. Nothing new has to be logged -- it only had to be read.
import fs from "node:fs";
import path from "node:path";

export interface TakeReport {
  dir: string;
  name: string;
  startedAt: number;
  takes: number;
  /** marker -> how many distinct takes have events on it */
  perMarker: Record<number, number>;
  retakes: { marker: number; takes: number }[];
}

export function readTakes(sessionDir: string): TakeReport | null {
  let j: any;
  try { j = JSON.parse(fs.readFileSync(path.join(sessionDir, "session.json"), "utf8")); } catch { return null; }
  const events: any[] = Array.isArray(j.events) ? j.events : [];
  const seen = new Map<number, Set<number>>();
  for (const e of events) {
    if (typeof e?.marker !== "number" || e.marker < 0) continue;
    if (!seen.has(e.marker)) seen.set(e.marker, new Set());
    seen.get(e.marker)!.add(typeof e.take === "number" ? e.take : 1);
  }
  const perMarker: Record<number, number> = {};
  for (const [m, s] of seen) perMarker[m] = s.size;
  return {
    dir: sessionDir,
    name: j.meta?.name ?? path.basename(sessionDir),
    startedAt: j.meta?.startedAt ?? 0,
    takes: new Set(events.map((e) => e.take)).size || 1,
    perMarker,
    retakes: Object.entries(perMarker).map(([m, n]) => ({ marker: +m, takes: n })).filter((r) => r.takes > 1).sort((a, b) => b.takes - a.takes || a.marker - b.marker),
  };
}

/** Every recording session under a root, newest first. */
export function findSessions(root: string, filter?: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (ents.some((e) => e.isFile() && e.name === "session.json")) { out.push(dir); return; }
    if (depth > 5) return;
    for (const e of ents) if (e.isDirectory() && !e.name.startsWith(".")) walk(path.join(dir, e.name), depth + 1);
  };
  walk(root, 0);
  return out
    .filter((d) => !filter || d.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => (fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs));
}

/**
 * Retakes pooled across every session for a lesson, with the script's own text
 * beside each marker, so a run of retakes reads as "this line was hard to say"
 * rather than as a number.
 */
export function retakeDigest(sessionDirs: string[], lineAt?: (marker: number) => string | undefined): string {
  const rows: string[] = [];
  for (const d of sessionDirs) {
    const r = readTakes(d);
    if (!r) continue;
    rows.push(`${r.name}  (${new Date(r.startedAt).toLocaleString()}, ${r.takes} takes)`);
    rows.push(`  ${d}`);
    if (!r.retakes.length) { rows.push("  no marker was recorded twice"); continue; }
    for (const t of r.retakes) {
      const txt = lineAt?.(t.marker);
      rows.push(`  ${String(t.marker).padStart(6)}  x${t.takes}${txt ? `  ${txt.slice(0, 72)}` : ""}`);
    }
  }
  return rows.join("\n") || "no sessions found";
}
