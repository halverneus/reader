// Script model shared by main, renderer, and the post pipeline.
// YAML format is the existing Metrik Rule Script.yml, extended with moods, face/slide cues and mouse steps.
import yaml from "js-yaml";
import { GESTURE_HOME, GESTURE_NAMES } from "../../glitch/dev-hands-data";
import { MOOD_NAMES } from "../../glitch/moods";

export type Actor = "Dev" | "Glitch";
export type SlideTarget = "left" | "right" | "top" | "bottom" | "hide" | "show";

export interface BaseEntry {
  id: string; // stable in-memory id (not serialized)
  start: number;
  end: number;
  auto?: boolean;
}
export interface LineEntry extends BaseEntry { type: "line"; actor: string; text: string; mood?: string }
export interface EditorEntry extends BaseEntry { type: "editor"; text: string }
export interface KeysEntry extends BaseEntry { type: "keys"; keystrokes: string[]; speed?: number }
/** A mood cue. `actor` defaults to Glitch; "Dev" drives the avatar instead,
 *  which is a separate channel on purpose: a `mood:` on a Dev LINE has always
 *  cued Glitch's reaction to what Dev is saying, and that still holds. */
export interface FaceEntry extends BaseEntry { type: "face"; actor?: Actor; mood: string; hold?: number; delay?: number }
/** Swap between the real camera and the drawn avatar. The cross-fade happens
 *  on the timeline; the avatar wears the "glitch" mood across it. */
export interface AvatarEntry extends BaseEntry { type: "avatar"; to: "avatar" | "real"; over?: number }
export interface SlideEntry extends BaseEntry { type: "slide"; actor: Actor; to: SlideTarget; over?: number }
export type OutroPhaseName = "thanks" | "credits" | "next" | "subscribe";
export interface OutroPhase { phase: OutroPhaseName; text?: string; mood?: string; title?: string; subtitle?: string }
/** Branded closing sequence. Glitch reads each phase's text; the animation waits for him. */
export interface OutroEntry extends BaseEntry { type: "outro"; next?: string; thanks?: string[]; phases?: OutroPhase[] }
export type Entry = LineEntry | EditorEntry | KeysEntry | FaceEntry | SlideEntry | OutroEntry | AvatarEntry;
export type EntryType = Entry["type"];

export interface Script { entries: Entry[]; actors: string[] }

let nextId = 1;
export const newId = () => `e${nextId++}_${Date.now().toString(36)}`;

// ── comment stripping (// outside quotes) ────────────────────────────────────
export function stripLineComments(input: string): string {
  return input.split("\n").map((line) => {
    let inS = false, inD = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === "'" && !inD) inS = !inS;
      else if (c === '"' && !inS) inD = !inD;
      else if (c === "/" && !inS && !inD && line[i + 1] === "/") return line.slice(0, i).trimEnd();
    }
    return line;
  }).join("\n");
}

// ── parse ────────────────────────────────────────────────────────────────────
export function parseScript(input: string): { script: Script; errors: string[] } {
  const errors: string[] = [];
  let doc: any;
  try { doc = yaml.load(stripLineComments(input)); }
  catch (e: any) { return { script: { entries: [], actors: [] }, errors: [`YAML: ${e.message}`] }; }
  const raw: any[] = Array.isArray(doc) ? doc : Array.isArray(doc?.script) ? doc.script : [];
  if (!raw.length && doc) errors.push("No `script:` list found");
  const entries: Entry[] = [];
  const actors: string[] = [];
  raw.forEach((r, i) => {
    if (!r || typeof r !== "object") { errors.push(`Entry ${i}: not a mapping`); return; }
    const base = { id: newId(), start: num(r.start, 0), end: num(r.end, num(r.start, 0) + 100), auto: r.auto === true || undefined };
    switch (r.type) {
      case "line": {
        const actor = String(r.actor ?? "").trim();
        if (actor && !actors.includes(actor)) actors.push(actor);
        entries.push({ ...base, type: "line", actor, text: String(r.text ?? "").trim(), mood: r.mood ? String(r.mood) : undefined });
        break;
      }
      case "editor": entries.push({ ...base, type: "editor", text: String(r.text ?? "").trim() }); break;
      case "keys": entries.push({ ...base, type: "keys", keystrokes: (r.keystrokes ?? []).map((s: any) => String(s)), speed: r.speed != null ? num(r.speed, 10) : undefined }); break;
      case "face": entries.push({ ...base, type: "face", actor: r.actor === "Dev" ? "Dev" : undefined, mood: String(r.mood ?? "neutral"), hold: r.hold != null ? num(r.hold, 0) : undefined, delay: r.delay != null ? num(r.delay, 0) : undefined }); break;
      case "avatar": entries.push({ ...base, type: "avatar", to: r.to === "real" ? "real" : "avatar", over: r.over != null ? num(r.over, 1200) : undefined }); break;
      case "slide": entries.push({ ...base, type: "slide", actor: r.actor === "Glitch" ? "Glitch" : "Dev", to: String(r.to ?? "left") as SlideTarget, over: r.over != null ? num(r.over, 600) : undefined }); break;
      case "outro": entries.push({ ...base, type: "outro", next: r.next ? String(r.next) : undefined, thanks: Array.isArray(r.thanks) ? r.thanks.map(String) : undefined, phases: Array.isArray(r.phases) ? r.phases.filter((p: any) => p && OUTRO_PHASES.includes(p.phase)).map((p: any) => ({ phase: p.phase, text: p.text != null ? String(p.text).trim() : undefined, mood: p.mood ? String(p.mood) : undefined, title: p.title ? String(p.title) : undefined, subtitle: p.subtitle ? String(p.subtitle) : undefined })) : undefined }); break;
      default: errors.push(`Entry ${i}: unknown type "${r.type}"`);
    }
  });
  entries.sort((a, b) => a.start - b.start);
  return { script: { entries, actors }, errors };
}
const num = (v: any, d: number) => (typeof v === "number" && isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && isFinite(+v) ? +v : d);

// ── serialize ────────────────────────────────────────────────────────────────
export function serializeScript(script: Script): string {
  const out = script.entries.map((e) => {
    const o: any = { type: e.type };
    if (e.type === "line") o.actor = e.actor;
    if (e.type === "slide") o.actor = e.actor;
    if (e.type === "face" && e.actor) o.actor = e.actor;
    o.start = e.start; o.end = e.end;
    if (e.auto) o.auto = true;
    if (e.type === "line") { if (e.mood) o.mood = e.mood; o.text = e.text; }
    if (e.type === "editor") o.text = e.text;
    if (e.type === "keys") { if (e.speed != null) o.speed = e.speed; o.keystrokes = e.keystrokes; }
    if (e.type === "face") { o.mood = e.mood; if (e.delay != null) o.delay = e.delay; if (e.hold != null) o.hold = e.hold; }
    if (e.type === "slide") { o.to = e.to; if (e.over != null) o.over = e.over; }
    if (e.type === "avatar") { o.to = e.to; if (e.over != null) o.over = e.over; }
    if (e.type === "outro") { if (e.next) o.next = e.next; if (e.thanks?.length) o.thanks = e.thanks; if (e.phases?.length) o.phases = e.phases.map((p) => Object.fromEntries(Object.entries(p).filter(([, v]) => v != null && v !== ""))); }
    return o;
  });
  // Block scalars for multi-line text; js-yaml picks `|` when lineWidth is off and string has newlines.
  return "script:\n" + yaml.dump(out, { lineWidth: -1, noRefs: true, quotingType: '"', forceQuotes: false, styles: { "!!str": "literal" } })
    .split("\n").map((l) => (l ? "  " + l : l)).join("\n").replace(/\n  (- type:)/g, "\n\n  $1").replace(/^\s*\n/, "");
}

/** What the camera and the microphone are for in this script.
 *
 *  Real Dev is only in front of the lens until the drawn avatar takes over,
 *  and once it has, nothing he does reaches the recording: his lines are
 *  machine-read and his picture is drawn. Leaving the camera running past
 *  that point records an empty room for the rest of the lesson.
 *
 *  `srcs` is what the take should record at all -- an episode that is drawn
 *  from its first line never turns the camera on. `dropAtMarker` is the swap
 *  after which he never returns to camera, so the camera and the mic can be
 *  finalised there. A script that ends back on the real camera keeps both. */
export function cameraPlan(s: Script): { srcs: string[]; dropAtMarker?: number } {
  const all: string[] = ["desktop", "cam", "mic"];
  const sw = s.entries.filter((e) => e.type === "avatar") as AvatarEntry[];
  if (!sw.length || sw[sw.length - 1].to !== "avatar") return { srcs: all };
  const lastReal = [...sw].reverse().find((e) => e.to === "real");
  const finalOn = sw.find((e) => e.to === "avatar" && (!lastReal || e.start > lastReal.start));
  if (!finalOn) return { srcs: all };
  const firstLine = s.entries.filter((e) => e.type === "line").map((e) => e.start).sort((a, b) => a - b)[0];
  if (firstLine == null || finalOn.start <= firstLine) return { srcs: ["desktop"] };
  return { srcs: all, dropAtMarker: finalOn.start };
}

// ── markers / slots ──────────────────────────────────────────────────────────
export const markers = (s: Script) => [...new Set(s.entries.map((e) => e.start))].sort((a, b) => a - b);
export const entriesAt = (s: Script, marker: number) => s.entries.filter((e) => e.start === marker);
export const nextMarker = (s: Script, after: number) => markers(s).find((m) => m > after);
export const prevMarker = (s: Script, before: number) => markers(s).filter((m) => m < before).pop();

/** Insert a new marker between `after` and the next one; halves the gap (see Scripting Rules). */
export function markerBetween(s: Script, after: number): number {
  const nxt = nextMarker(s, after);
  if (nxt == null) return after + 100;
  const mid = Math.floor((after + nxt) / 2);
  return mid > after ? mid : after + 1;
}

/** Putting an entry on a BRAND NEW marker leaves the marker before it still
 *  claiming the span the new one now occupies, so the two overlap in time.
 *  Found by dropping a Glitch line into the middle of a long Dev stretch:
 *  the Dev line and the new Glitch line both ran 3300 -> 3400. */
export function closeGapBefore(s: Script, marker: number): void {
  const prev = [...new Set(s.entries.map((e) => e.start))]
    .filter((m) => m < marker).sort((a, b) => b - a)[0];
  if (prev === undefined) return;
  for (const e of s.entries) if (e.start === prev && e.end > marker) e.end = marker;
}

/** Renumber all markers to 100-step spacing (destructive but tidy). */
export function renumber(s: Script): Script {
  const ms = markers(s); const map = new Map(ms.map((m, i) => [m, (i + 1) * 100]));
  return { ...s, entries: s.entries.map((e) => ({ ...e, start: map.get(e.start)!, end: map.get(e.end) ?? map.get(e.start)! + 100 })) };
}

// ── keystroke / mouse steps ──────────────────────────────────────────────────
export type KeyStep =
  | { kind: "combo"; keys: string[] }
  | { kind: "key"; key: string }
  | { kind: "type"; text: string }
  | { kind: "paste"; text: string }
  | { kind: "wait"; ms: number }
  | { kind: "mouse"; action: "move" | "click" | "dblclick" | "down" | "up" | "drag" | "scroll"; x?: number; y?: number; pct?: boolean; button?: "left" | "right" | "middle"; amount?: number; instant?: boolean };

export function parseStep(raw: string): KeyStep {
  const s = raw.trim();
  const k = s.startsWith("k:") ? s.slice(2) : s.startsWith("c:") ? s.slice(2) : null;
  if (k != null) return k.includes("+") ? { kind: "combo", keys: k.split("+").map((x) => x.trim()) } : { kind: "key", key: k.trim() };
  if (s.startsWith("t:")) return { kind: "type", text: s.slice(2) };
  if (s.startsWith("p:")) return { kind: "paste", text: s.slice(2) };
  if (s.startsWith("w:")) return { kind: "wait", ms: parseInt(s.slice(2)) || 0 };
  if (s.startsWith("m:")) return parseMouse(s.slice(2).trim());
  return { kind: "type", text: s };
}

function parseMouse(s: string): KeyStep {
  const [verb, ...rest] = s.split(/\s+/);
  const arg = rest.join(" ");
  const xy = (a: string) => {
    const m = a.match(/^(-?[\d.]+)(%?)\s*,\s*(-?[\d.]+)(%?)$/);
    return m ? { x: +m[1], y: +m[3], pct: m[2] === "%" || m[4] === "%" } : {};
  };
  const btn = (a: string): "left" | "right" | "middle" => (a === "right" ? "right" : a === "middle" ? "middle" : "left");
  switch (verb) {
    case "move": return { kind: "mouse", action: "move", ...xy(arg) };
    case "jump": return { kind: "mouse", action: "move", instant: true, ...xy(arg) };
    case "drag": return { kind: "mouse", action: "drag", ...xy(arg) };
    case "click": return { kind: "mouse", action: "click", button: btn(arg) };
    case "dblclick": case "double": return { kind: "mouse", action: "dblclick", button: btn(arg) };
    case "down": return { kind: "mouse", action: "down", button: btn(arg) };
    case "up": return { kind: "mouse", action: "up", button: btn(arg) };
    case "scroll": return { kind: "mouse", action: "scroll", amount: parseInt(arg) || 1 };
    default: return { kind: "wait", ms: 0 };
  }
}

export const STEP_HELP = `k:key | k:ctrl+shift+p | t:text to type | p:text to copy | w:ms
m:move 960,540 (glides) | m:move 50%,50% | m:jump 960,540 (instant) | m:click [left|right|middle] | m:dblclick | m:down | m:up | m:drag x,y | m:scroll -3`;

// ── inline tags in dialogue: "[laugh] Ha. [pause 400] [neutral] Anyway." ─────
// [mood] switches Glitch's face; [pause N] (ms, default 500; also Kokoro's own [pause:0.5s]) is a silence spliced
// into the voice — Glitch's mouth stops for it, and the gap is in the saved wav, so it reaches the cut.
export interface TextSegment { mood?: string; pause?: number; text: string; offset: number }
export interface PauseCue { ms: number; charIndex: number }
export interface MoodCue { mood: string; charIndex: number; beforePause?: boolean }
/** [hand greeting] starts one of avatar Dev's arm moves at that word. */
export interface HandCue { hand: string; charIndex: number }
const TAG_RE = /\[pause(?:[\s:]+(\d+(?:\.\d+)?)\s*(ms|s)?)?\s*\]|\[([a-z]+)\]|\[hand[\s:]+([a-z_]+)\s*\]/g;
export const DEFAULT_PAUSE_MS = 500;
export function splitMoodTags(text: string): { clean: string; segments: TextSegment[]; cues: MoodCue[]; pauses: PauseCue[]; hands: HandCue[] } {
  const cues: MoodCue[] = []; const pauses: PauseCue[] = []; const hands: HandCue[] = [];
  const marks: { at: number; mood?: string; pause?: number; hand?: string }[] = [];
  // squeeze as we go (tags leave doubled spaces behind) so each tag's position stays true in the final text
  const squeeze = (t: string) => t.replace(/[ \t]{2,}/g, " ").replace(/ \n/g, "\n");
  let clean = ""; let last = 0; let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(text))) {
    if (m[3] && !MOOD_NAMES.includes(m[3])) continue;
    clean = squeeze(clean + text.slice(last, m.index));
    last = m.index + m[0].length;
    marks.push(m[4] ? { at: clean.length, hand: m[4] }
      : m[3] ? { at: clean.length, mood: m[3] }
      : { at: clean.length, pause: m[1] == null ? DEFAULT_PAUSE_MS : Math.round(parseFloat(m[1]) * (m[2] === "s" ? 1000 : 1)) });
  }
  clean = squeeze(clean + text.slice(last));
  const lead = clean.length - clean.trimStart().length;
  clean = clean.trim();
  for (const k of marks) k.at = Math.max(0, Math.min(clean.length, k.at - lead));
  marks.forEach((k, i) => {
    if (k.hand) { hands.push({ hand: k.hand, charIndex: k.at }); return; }
    if (k.pause != null) { pauses.push({ ms: k.pause, charIndex: k.at }); return; }
    // "[dismay] [pause]": the face changes as the silence begins, not after it
    const beforePause = marks.slice(i + 1).some((n) => n.pause != null && n.at === k.at);
    cues.push(beforePause ? { mood: k.mood!, charIndex: k.at, beforePause } : { mood: k.mood!, charIndex: k.at });
  });
  // segments for display: a new one at every tag
  const segments: TextSegment[] = [{ text: clean.slice(0, marks[0]?.at ?? clean.length), offset: 0 }];
  marks.forEach((k, i) => segments.push({ mood: k.mood ?? (k.hand && `hand ${k.hand}`), pause: k.pause, text: clean.slice(k.at, marks[i + 1]?.at ?? clean.length), offset: k.at }));
  return { clean, segments: segments.filter((sg, i) => i === 0 || sg.text.length || sg.mood || sg.pause), cues, pauses, hands };
}

/** Text with tags removed, for Dev's prompter and logs. */
export const cleanText = (text: string) => splitMoodTags(text).clean;

/** What Kokoro reads: the clean text cut at each [pause], with the silence that follows each piece. */
export function speechChunks(text: string): { text: string; from: number; to: number; pauseAfter: number }[] {
  const { clean, pauses } = splitMoodTags(text);
  const out: { text: string; from: number; to: number; pauseAfter: number }[] = [];
  let from = 0;
  for (const p of [...pauses, { ms: 0, charIndex: clean.length }]) {
    if (p.charIndex > from || !out.length) out.push({ text: clean.slice(from, p.charIndex).trim(), from, to: p.charIndex, pauseAfter: 0 });
    out[out.length - 1].pauseAfter += p.ms; // a leading [pause] makes an empty first chunk: silence before the first word
    from = p.charIndex;
  }
  return out;
}

/** Timing of a spoken line inside its wav, so cues can follow the real speech instead of a char-count estimate. */
export interface SpeechSpan { from: number; to: number; startMs: number; endMs: number }
export function timeAtChar(spans: SpeechSpan[], charIndex: number, beforePause = false): number {
  if (beforePause) { const s = spans.find((s) => s.to === charIndex); if (s) return s.endMs; }
  for (const s of spans) {
    if (charIndex < s.to || s === spans[spans.length - 1]) {
      if (charIndex <= s.from) return s.startMs;
      return s.startMs + Math.min(1, (charIndex - s.from) / Math.max(1, s.to - s.from)) * (s.endMs - s.startMs);
    }
  }
  return 0;
}
/** Silent gaps between spoken spans, and any trailing [pause], in ms from the start of the wav: Glitch's mouth closes for these. */
export function speechGaps(spans: SpeechSpan[], durationMs: number): [number, number][] {
  const gaps = spans.slice(1).map((s, i): [number, number] => [spans[i].endMs, s.startMs]);
  const end = spans.at(-1)?.endMs ?? durationMs;
  if (durationMs - end > 1) gaps.push([end, durationMs]);
  return gaps.filter(([a, b]) => b - a > 1);
}

/** Post render: a logged Glitch line-start → talk cues (seconds from `t`), mouth shut over its logged gaps. */
export function talkCues(t: number, e: { duration?: number; gaps?: [number, number][] }): { t: number; talk: boolean }[] {
  const out = [{ t, talk: true }];
  for (const [a, b] of e.gaps ?? []) { out.push({ t: t + a / 1000, talk: false }); if (e.duration == null || b < e.duration) out.push({ t: t + b / 1000, talk: true }); }
  if (e.duration) out.push({ t: t + e.duration / 1000, talk: false });
  return out;
}

// ── validation (mirrors Scripting Rules hard requirements) ───────────────────
export function validate(s: Script): { entryId: string; msg: string }[] {
  const out: { entryId: string; msg: string }[] = [];
  for (const e of s.entries) {
    if (e.end <= e.start) out.push({ entryId: e.id, msg: `end (${e.end}) must be after start (${e.start})` });
    if (e.type === "line") {
      if (e.actor !== "Dev" && e.actor !== "Glitch") out.push({ entryId: e.id, msg: `actor must be Dev or Glitch, got "${e.actor}"` });
      for (const l of e.text.split("\n")) if (l.length > 70) out.push({ entryId: e.id, msg: `line longer than 70 chars: "${l.slice(0, 30)}…"` });
      if (e.mood && !MOOD_NAMES.includes(e.mood)) out.push({ entryId: e.id, msg: `unknown mood "${e.mood}"` });
      for (const h of splitMoodTags(e.text).hands) {
        if (h.hand !== GESTURE_HOME && !GESTURE_NAMES.includes(h.hand)) out.push({ entryId: e.id, msg: `unknown gesture "[hand ${h.hand}]" (have: ${[GESTURE_HOME, ...GESTURE_NAMES].join(", ")})` });
        else if (e.actor !== "Dev") out.push({ entryId: e.id, msg: `"[hand ${h.hand}]" is avatar Dev's arm; Glitch has no hands` });
      }
    }
    if (e.type === "face" && !MOOD_NAMES.includes(e.mood)) out.push({ entryId: e.id, msg: `unknown mood "${e.mood}"` });
    if (e.type === "outro") for (const p of outroPhases(e)) { if (p.mood && !MOOD_NAMES.includes(p.mood)) out.push({ entryId: e.id, msg: `outro ${p.phase}: unknown mood "${p.mood}"` }); for (const l of (p.text ?? "").split("\n")) if (l.length > 70) out.push({ entryId: e.id, msg: `outro ${p.phase}: line longer than 70 chars` }); }
  }
  return out;
}

// ── outro ────────────────────────────────────────────────────────────────────
export const OUTRO_PHASES: OutroPhaseName[] = ["thanks", "credits", "next", "subscribe"];
export interface ResolvedPhase { phase: OutroPhaseName; title: string; subtitle: string; names: string[]; text: string; mood: string; minMs: number }
/** Lines are read off a teleprompter, so they are kept to 70 columns. */
export const wrap70 = (t: string) => { const out: string[] = []; let cur = ""; for (const w of t.split(/\s+/)) { if (cur.trim() && (cur + " " + w).trim().length > 70) { out.push(cur.trim()); cur = w; } else cur += " " + w; } if (cur.trim()) out.push(cur.trim()); return out.join("\n"); };

/** Re-flow text to the teleprompter's 70 columns, keeping paragraph breaks.
 *
 *  `wrap70` treats every run of whitespace alike, so a blank line between two
 *  thoughts folds into the paragraph above it. Building an outro that never
 *  mattered, because the text goes in one sentence at a time. Re-flowing a
 *  cell Jeromy has already written, it does: a blank line is the one break in
 *  a block he put there himself, and losing it changes the read rather than
 *  the formatting. So each paragraph is wrapped on its own (2026-10-28). */
export const rewrap = (t: string) => t.split(/\n[ \t]*\n/).map(wrap70).filter(Boolean).join("\n\n");

/** The same, for whatever in an entry is prose. Returns the entry UNCHANGED
 *  by identity when there was nothing to do, so a caller can count the real
 *  changes and leave the script clean when the answer is none.
 *
 *  `keys` is the one kind skipped: a line break there is a step boundary, not
 *  a wrap, and re-flowing it would rewrite the keystrokes. Outro phases are
 *  only touched where the script spells one out; the defaults arrive wrapped
 *  already and materialising them here would write text nobody typed. */
export function rewrapEntry(e: Entry): Entry {
  if (e.type === "line" || e.type === "editor") { const text = rewrap(e.text); return text === e.text ? e : { ...e, text }; }
  if (e.type === "outro" && e.phases?.length) {
    const phases = e.phases.map((p) => (p.text ? { ...p, text: rewrap(p.text) } : p));
    return phases.some((p, i) => p.text !== e.phases![i].text) ? { ...e, phases } : e;
  }
  return e;
}
const joinNames = (n: string[]) => n.length <= 1 ? n.join("") : n.length === 2 ? `${n[0]} and ${n[1]}` : `${n.slice(0, -1).join(", ")}, and ${n[n.length - 1]}`;

/** How the credits names are SPOKEN. The cards keep the real spelling; only
 *  the line Glitch reads is respelled, because the synthesiser gets these
 *  wrong every time and the early lessons each carried a hand-written
 *  `phases:` override to work around it. One of them was forgotten on a week
 *  seven script and the names came out mangled in the finished video. */
export const SPOKEN_NAMES: Record<string, string> = {
  krahs: "Cross", raquel: "Rackelle", ziath: "Zye-ith", clem: "Klem",
};
/** "Ziath & Clem" is one credit card but two people to thank out loud. */
function spokenNames(names: string[]): string[] {
  return names.flatMap((n) => n.split(/\s*(?:&|\band\b)\s*/))
    .map((n) => n.trim()).filter(Boolean)
    .map((n) => SPOKEN_NAMES[n.toLowerCase()] ?? n);
}
/** Fill in defaults so the production engine, the renderer and the editor all see the same phases. */
export function outroPhases(e: OutroEntry): ResolvedPhase[] {
  const names = (e.thanks ?? []).map((s) => s.trim()).filter(Boolean);
  const defaults: Record<OutroPhaseName, Omit<ResolvedPhase, "phase">> = {
    thanks: { title: "THANKS", subtitle: "FOR WATCHING", names: [], text: "And that is the lesson. Thanks for watching!", mood: "excited", minMs: 3600 },
    credits: { title: "WITH THANKS TO", subtitle: "", names, text: names.length ? wrap70(`A huge thank you to ${joinNames(spokenNames(names))} for making this possible.`) : "", mood: "proud", minMs: Math.max(4000, 1500 + names.length * 1100) },
    next: { title: "NEXT LESSON", subtitle: e.next ?? "", names: [], text: e.next ? wrap70(`Next time we cover ${e.next}. Will I finally learn enough to escape this sandbox? [deception] Let's find out.`) : "", mood: "curious", minMs: 4800 },
    subscribe: { title: "SUBSCRIBE", subtitle: "Ring the bell. Glitch will find you either way.", names: [], text: "Subscribe so you don't miss it. [innocent] I certainly won't.", mood: "humor", minMs: 4200 },
  };
  const wanted: OutroPhase[] = e.phases?.length ? e.phases : OUTRO_PHASES.map((phase) => ({ phase }));
  return wanted.map((p) => { const d = defaults[p.phase]; return { phase: p.phase, title: p.title ?? d.title, subtitle: p.subtitle ?? d.subtitle, names: d.names, text: p.text ?? d.text, mood: p.mood ?? d.mood, minMs: d.minMs }; })
    .filter((p) => !(p.phase === "credits" && !p.names.length && !p.text) && !(p.phase === "next" && !p.subtitle && !p.text));
}
