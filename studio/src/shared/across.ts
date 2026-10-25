// Repetition ACROSS lessons.
//
// checkScript only ever sees one file, so a sentence that opens the demo in
// every lesson of a week is invisible to it. That is exactly the kind of
// thing a viewer notices and the author does not: "Let's take all of this
// onto a real server" opened the demo in five Week 06 lessons, and "And now
// the last one, which is..." introduced the final query in five more.
//
// Advisory by nature. A catchphrase is supposed to repeat ("Don't just watch
// it... Do it!"), so this reports and a human decides.
import { Script, cleanText } from "./script";

export interface Formula {
  /** the strongest shared text, for reading */
  sample: string;
  /** "exact" = the whole sentence matches; "frame" = only the opening does */
  kind: "exact" | "frame";
  at: { lesson: string; marker: number; actor: string; text: string }[];
}

const FRAME_WORDS = 7;
const MIN_WORDS = 7;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const sentences = (t: string) => t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);

/** Catchphrases that are MEANT to recur, so they are never reported. */
export const CATCHPHRASES = [
  "don t just watch it do it",
  "a huge thank you to",
  "subscribe so you do not miss it",
  "thanks for watching",
  "and i am glitch",
];

export function crossRepeats(lessons: { name: string; script: Script }[]): Formula[] {
  const exact = new Map<string, Formula["at"]>();
  const frame = new Map<string, Formula["at"]>();

  for (const { name, script } of lessons) {
    for (const e of script.entries) {
      if (e.type !== "line") continue;
      const actor = (e as any).actor ?? "";
      for (const sent of sentences(cleanText((e as any).text))) {
        const n = norm(sent);
        const w = n.split(" ").filter(Boolean);
        if (w.length < MIN_WORDS) continue;
        if (CATCHPHRASES.some((c) => n.includes(c))) continue;
        const hit = { lesson: name, marker: e.start, actor, text: sent };
        for (const [map, key] of [[exact, n], [frame, w.slice(0, FRAME_WORDS).join(" ")]] as const) {
          if (!map.has(key)) map.set(key, []);
          map.get(key)!.push(hit);
        }
      }
    }
  }

  const out: Formula[] = [];
  const claimed = new Set<string>();
  const collect = (map: Map<string, Formula["at"]>, kind: Formula["kind"]) => {
    for (const [, at] of map) {
      // more than one LESSON, not merely more than one marker
      if (new Set(at.map((x) => x.lesson)).size < 2) continue;
      const id = at.map((x) => `${x.lesson}:${x.marker}`).sort().join("|");
      if (claimed.has(id)) continue;
      claimed.add(id);
      out.push({ sample: at[0].text, kind, at });
    }
  };
  collect(exact, "exact");
  collect(frame, "frame");
  return out.sort((a, b) => b.at.length - a.at.length || (a.kind === "exact" ? -1 : 1));
}
