// Slides.html, read well enough to check it against the script.
//
// Two things go wrong and neither had a check before 2026-10-22:
//   1. The deck invariant: slides + held reveals == k:right + 1.
//   2. The SETUP HEADER PROSE. The first editor entry tells the operator "14
//      slides, so this script fires exactly 14 k:right presses" and "ONE
//      Workbench visit, at slide 13". Both went stale when a slide was dropped
//      and nothing was looking at them, because they are sentences rather than
//      structure.
import fs from "node:fs";
import path from "node:path";
import { parseScript, type Script } from "./script";
import type { Finding } from "./check";

export interface DeckInfo { slides: number; holds: number; kickers: string[]; path: string }

const HOLD_RE = /\bdata-hold\b|class="[^"]*\bhold\b[^"]*"/gi;

export function readDeck(file: string): DeckInfo | null {
  let html: string;
  try { html = fs.readFileSync(file, "utf8"); } catch { return null; }
  const secs = slideSections(html);
  return {
    path: file,
    slides: secs.length,
    holds: (html.match(HOLD_RE) ?? []).length,
    // one entry per slide, aligned to its 1-based number: the title slide has
    // no kicker, so a flat match of every kicker in the file is off by one
    kickers: secs.map((s) => {
      const m = /class="kicker[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(s.text);
      const k = m ? m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
      if (k) return k;
      const h = /<h1[^>]*>([\s\S]*?)<\/h1>|<div class="quote">([\s\S]*?)<\/div>/i.exec(s.text);
      return h ? (h[1] ?? h[2] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 50) : "";
    }),
  };
}

/** Section boundaries, so a slide can be removed without splicing line numbers. */
export function slideSections(html: string): { index: number; start: number; end: number; text: string }[] {
  const out: { index: number; start: number; end: number; text: string }[] = [];
  const re = /<section\b[^>]*class="[^"]*\bslide\b[^"]*"[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const close = html.indexOf("</section>", m.index);
    if (close < 0) break;
    const end = close + "</section>".length;
    out.push({ index: out.length + 1, start: m.index, end, text: html.slice(m.index, end) });
    re.lastIndex = end;
  }
  return out;
}

/** Remove slide `n` (1-based) and return the new HTML. */
export function removeSlide(html: string, n: number): string {
  const secs = slideSections(html);
  const s = secs[n - 1];
  if (!s) throw new Error(`no slide ${n} (deck has ${secs.length})`);
  let a = s.start, b = s.end;
  // take the whitespace/newline the section sat on with it
  while (a > 0 && (html[a - 1] === " " || html[a - 1] === "\t")) a--;
  if (a > 0 && html[a - 1] === "\n") a--;
  return html.slice(0, a) + html.slice(b);
}

const rights = (s: Script) => s.entries.filter((e) => e.type === "keys")
  .reduce((n, e) => n + ((e as any).keystrokes as string[]).filter((k) => k === "k:right").length, 0);

/**
 * Check the numbers written in the setup header against reality. The header is
 * the first editor entry; it is read by a human before recording, so a wrong
 * number there is a wrong recording.
 */
export function checkSetupHeader(s: Script, deck: DeckInfo): Finding[] {
  const out: Finding[] = [];
  const header = s.entries.find((e) => e.type === "editor");
  if (!header) return out;
  const text = (header as any).text as string;
  const marker = header.start;
  const r = rights(s);

  const mSlides = /(\d+)\s+slides/i.exec(text);
  if (mSlides && +mSlides[1] !== deck.slides)
    out.push({ severity: "error", rule: "setup-header", marker, msg: `header says "${mSlides[1]} slides" but Slides.html has ${deck.slides}` });

  const mRights = /fires\s+(?:exactly\s+)?(\d+)\s*\n?\s*k:right/i.exec(text.replace(/\s+/g, " "));
  if (mRights && +mRights[1] !== r)
    out.push({ severity: "error", rule: "setup-header", marker, msg: `header says "${mRights[1]} k:right presses" but the script fires ${r}` });

  const mHold = /(\d+|ONE|NO)\s+held\s+reveals?/i.exec(text);
  if (mHold) {
    const n = /^\d+$/.test(mHold[1]) ? +mHold[1] : mHold[1].toUpperCase() === "ONE" ? 1 : 0;
    if (n !== deck.holds)
      out.push({ severity: "error", rule: "setup-header", marker, msg: `header says "${mHold[1]} held reveal" but the deck has ${deck.holds}` });
  }

  // "ONE Workbench visit, at slide 13." — the number must be a real slide, and
  // the slide it names should be the one the demo runs on.
  const mVisit = /Workbench visit,? at slide\s+(\d+)/i.exec(text);
  if (mVisit) {
    const n = +mVisit[1];
    if (n > deck.slides)
      out.push({ severity: "error", rule: "setup-header", marker, msg: `header points at slide ${n}, but the deck only has ${deck.slides}` });
    else {
      const kicker = deck.kickers[n - 1] ?? "";
      if (kicker && !/server|workbench|demo/i.test(kicker))
        out.push({ severity: "advice", rule: "setup-header", marker, msg: `header says the Workbench visit is at slide ${n}, whose kicker reads "${kicker}"` });
    }
  }
  return out;
}

export interface LessonBundle {
  dir: string; lesson: string; week: string; course: string;
  script?: string; slides?: string; content?: string; summary?: string; seed?: string; youtube?: string;
}

/** Every asset of one lesson, found once instead of guessed at five call sites. */
export function lessonBundle(dir: string): LessonBundle {
  const at = (n: string) => { const p = path.join(dir, n); return fs.existsSync(p) ? p : undefined; };
  const parts = dir.split(path.sep);
  return {
    dir,
    lesson: parts[parts.length - 1] ?? "",
    week: parts[parts.length - 2] ?? "",
    course: parts[parts.length - 4] ?? "",
    script: at("Script.yml"), slides: at("Slides.html"), content: at("Content.html"),
    summary: at("Content-Summary.md"), seed: at("seed.sql"), youtube: at("YouTube.md"),
  };
}

/** Full deck check for a lesson folder. */
export function checkDeck(dir: string): { info: DeckInfo | null; findings: Finding[] } {
  const b = lessonBundle(dir);
  if (!b.slides || !b.script) return { info: null, findings: [{ severity: "advice", rule: "deck", msg: "no Slides.html or Script.yml in this folder" }] };
  const info = readDeck(b.slides)!;
  const s = parseScript(fs.readFileSync(b.script, "utf8")).script;
  const r = rights(s);
  const findings: Finding[] = [];
  if (info.slides + info.holds !== r + 1)
    findings.push({ severity: "error", rule: "deck", msg: `slides + held reveals (${info.slides} + ${info.holds} = ${info.slides + info.holds}) must equal k:right + 1 (${r} + 1 = ${r + 1})` });
  findings.push(...checkSetupHeader(s, info));
  return { info, findings };
}
