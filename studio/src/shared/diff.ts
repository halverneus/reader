// Comparing two versions of a script by MARKER instead of by line.
//
// Studio reformats on save: it rewraps text at 70 characters, normalizes
// quoting and drops `auto: false`. A textual diff of a file Jeromy has
// touched is therefore almost entirely noise, which is why recovering his
// hand edits used to mean normalizing both sides by hand first.
//
// Two callers need the same answer. The MCP's script_diff prints it, and the
// renderer uses it to highlight the markers an outside edit just changed, so
// a live update is visible rather than silent.
import type { Script, Entry } from "./script";

export interface MarkerDiff {
  added: number[];
  removed: number[];
  changed: number[];
  /** every marker touched, sorted: what a reader should look at */
  touched: number[];
  details: { kind: "+" | "-" | "~"; marker: number; entry: Entry; was?: Entry }[];
}

/** Identity of an entry within its marker. Two Glitch lines on one marker are
 *  rare but legal, so the index among same-kind siblings breaks the tie. */
function keyed(s: Script): Map<string, Entry> {
  const seen = new Map<string, number>();
  const out = new Map<string, Entry>();
  for (const e of [...s.entries].sort((a, b) => a.start - b.start)) {
    const base = `${e.start}:${e.type}:${(e as any).actor ?? ""}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.set(n ? `${base}#${n}` : base, e);
  }
  return out;
}

const same = (a: Entry, b: Entry) =>
  JSON.stringify({ ...a, id: 0 }) === JSON.stringify({ ...b, id: 0 });

export function markerDiff(a: Script, b: Script): MarkerDiff {
  const ma = keyed(a), mb = keyed(b);
  const added = new Set<number>(), removed = new Set<number>(), changed = new Set<number>();
  const details: MarkerDiff["details"] = [];
  for (const [k, e] of ma) if (!mb.has(k)) { removed.add(e.start); details.push({ kind: "-", marker: e.start, entry: e }); }
  for (const [k, e] of mb) {
    const was = ma.get(k);
    if (!was) { added.add(e.start); details.push({ kind: "+", marker: e.start, entry: e }); }
    else if (!same(was, e)) { changed.add(e.start); details.push({ kind: "~", marker: e.start, entry: e, was }); }
  }
  const nums = (s: Set<number>) => [...s].sort((x, y) => x - y);
  const touched = nums(new Set([...added, ...removed, ...changed]));
  details.sort((x, y) => x.marker - y.marker);
  return { added: nums(added), removed: nums(removed), changed: nums(changed), touched, details };
}

/** FNV-1a over the raw text. Studio reports this for the script it has open
 *  so an outside tool can tell "Studio's copy is the file on disk" from
 *  "Studio is showing something else", which a dirty flag alone cannot. */
export function textHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}
