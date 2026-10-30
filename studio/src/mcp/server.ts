// metrik-mcp: Metrik Studio's script toolchain, exposed to Claude Code.
//
// Design rules, all of them learned the hard way:
//   1. File-first. Every script tool works with Studio closed, because that is
//      when most script work happens. Studio only adds live state.
//   2. One semantics. These tools call src/shared/script.ts, the same parser
//      and serializer Studio and mscript use. A second implementation in
//      another language is how you get an edit that reports success and
//      changes nothing (2026-10-22, a line-splicing patcher that silently
//      missed six of seven edits).
//   3. No devices. There is no tool here that records, renders, or opens a
//      camera. Not as policy -- those tools simply do not exist, so a
//      confused agent cannot reach them.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  parseScript, serializeScript, markers, entriesAt, markerBetween, newId, wrap70, closeGapBefore,
  cleanText, outroPhases, type Entry, type Script,
} from "../shared/script";
import { checkScript, errorsOf, type Finding } from "../shared/check";
import { readDeck, checkDeck, lessonBundle, slideSections, removeSlide } from "../shared/deck";
import { markerDiff, textHash } from "../shared/diff";
import { replay, SUSPICIOUS } from "../shared/wb";
import { findSessions, retakeDigest } from "../shared/takes";
import { KEY_VOCABULARY } from "../shared/keys";
import { DEFAULTS, deepMerge, userDataDir, type Config } from "../shared/config";
import { MOODS } from "../../glitch/moods";
import { ask, readBridge } from "./bridge-client";
import { serve, type Tool } from "./rpc";

/** Run a command, optionally feeding stdin. execFile has no `input` option --
 *  that is execFileSync -- so this spawns and writes the pipe itself. */
function run(cmd: string, args: string[], input?: string): Promise<{ out: string; code: number }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", (e) => resolve({ out: String(e), code: -1 }));
    p.on("close", (code) => resolve({ out, code: code ?? 0 }));
    if (input != null) p.stdin.end(input); else p.stdin.end();
  });
}

function config(): Config {
  let c: any = {};
  try { c = JSON.parse(fs.readFileSync(path.join(userDataDir(), "config.json"), "utf8")); } catch {}
  return deepMerge(structuredClone(DEFAULTS), c);
}

// ── helpers ──────────────────────────────────────────────────────────────────
const read = (f: string) => fs.readFileSync(f, "utf8");
function load(file: string): Script {
  const { script, errors } = parseScript(read(file));
  if (errors.length) process.stderr.write(`[metrik-mcp] ${file}: ${errors.join("; ")}\n`);
  return script;
}
/** This process loaded its bundle once, at startup, and an MCP server lives
 *  as long as the editor that spawned it -- days. A `script_set` from a build
 *  that predates a new entry kind or a new field re-serializes the WHOLE file
 *  through the serializer it was built with, and anything it does not know
 *  about is gone on save, silently.
 *
 *  That is not a hypothesis. A server running since 23 October stripped every
 *  `face actor: Dev` and the whole `avatar` entry out of a week seven script
 *  on 30 October, and it was only found mid-recording.
 *
 *  So: writes are refused while this process is older than the bundle on
 *  disk. Reads are untouched -- they are still useful, and still honest. */
const BUNDLE = __filename;
const LOADED_AT = (() => { try { return fs.statSync(BUNDLE).mtimeMs; } catch { return 0; } })();
function assertCurrent(): void {
  let now = 0;
  try { now = fs.statSync(BUNDLE).mtimeMs; } catch { return; }
  if (!LOADED_AT || now <= LOADED_AT) return;
  throw new Error(
    "This metrik MCP server is running an older build than the one installed " +
    `(loaded ${new Date(LOADED_AT).toISOString()}, on disk ${new Date(now).toISOString()}). ` +
    "Writing would re-serialize the script through the older code and silently drop anything it " +
    "does not know about. Restart Claude Code to pick up the new server, or edit with the mscript CLI.");
}

function save(file: string, s: Script) {
  assertCurrent();
  if (fs.existsSync(file)) fs.copyFileSync(file, file + ".bak");
  fs.writeFileSync(file, serializeScript(s));
}

/** Tell a running Studio to re-read a file we just wrote, so the edit lands
 *  on screen instead of waiting for Jeromy to reopen it. Says what actually
 *  happened: "reloaded" is only true when that script was the one open. */
async function pushed(file: string): Promise<string> {
  const r = await ask<{ ok: boolean; applied?: boolean; reason?: string }>("reload", { file });
  if (!r) return "";                                        // Studio is not running
  if (r.applied) return "\n  · Studio reloaded it on screen";
  if (r.ok) return "";                                      // another script is open; nothing to see
  return `\n  · Studio did NOT reload: ${r.reason}`;
}

/**
 * Where a script is being read from. When Studio holds unsaved changes, the
 * file on disk is NOT the script -- it is the script as it was before Jeromy
 * started typing. Reading disk in that state answers a question nobody asked,
 * and writing to it throws his work away on his next save.
 */
interface Source { script: Script; text: string; hash?: string; live: boolean }

async function open(file: string): Promise<Source> {
  const b = await ask<{ ok: boolean; open?: boolean; dirty?: boolean; text?: string; hash?: string; reason?: string }>("buffer", { file });
  if (b?.open && b.dirty) {
    if (!b.ok || typeof b.text !== "string")
      throw new Error(`Studio holds unsaved changes in this file and its buffer could not be read (${b?.reason ?? "no answer"}). Refusing to fall back to the copy on disk, which is stale.`);
    const { script, errors } = parseScript(b.text);
    if (errors.length)
      throw new Error(`Studio's unsaved copy does not parse yet (${errors.join("; ")}). Finish the edit in the window, or save and I will work from the file.`);
    return { script, text: b.text, hash: b.hash, live: true };
  }
  const text = read(file);
  const { script, errors } = parseScript(text);
  if (errors.length) process.stderr.write(`[metrik-mcp] ${file}: ${errors.join("; ")}\n`);
  return { script, text, live: false };
}

/** A banner for anything read out of the window rather than off the disk.
 *  Unlabelled, I would report on text that does not exist in the file. */
const liveNote = (src: Source) => src.live ? "(reading Studio's UNSAVED buffer, not the file on disk)\n" : "";

/**
 * Write a script back where it came from. Into the window when that is where
 * the truth is: compare-and-swap on the hash that was read, so an edit
 * computed against text he has since changed is refused instead of landing on
 * top of it. Otherwise to disk, plus a nudge so the window re-reads it.
 */
async function commit(file: string, src: Source, s: Script): Promise<string> {
  if (!src.live) { save(file, s); return pushed(file); }
  assertCurrent();
  const r = await ask<{ ok: boolean; applied?: boolean; reason?: string }>("apply", { file, text: serializeScript(s), expectHash: src.hash });
  if (r?.applied) return "\n  · applied to Studio's UNSAVED buffer. Ctrl+Z undoes it, Ctrl+S keeps it.";
  throw new Error(`could not apply to Studio's buffer: ${r?.reason ?? "the window did not answer"}. Nothing was written.`);
}


const brief = (e: Entry): string =>
  e.type === "line" ? `${(e as any).actor}${(e as any).mood ? `[${(e as any).mood}]` : ""}: ${cleanText((e as any).text).replace(/\n/g, " ").slice(0, 70)}`
  : e.type === "editor" ? `note: ${(e as any).text.replace(/\n/g, " ").slice(0, 50)}`
  : e.type === "keys" ? `keys(${(e as any).keystrokes.length})`
  : e.type === "face" ? `face${(e as any).actor === "Dev" ? "(Dev)" : ""}:${(e as any).mood}`
  : e.type === "slide" ? `slide:${(e as any).actor}->${(e as any).to}`
  : `outro(next: ${(e as any).next ?? "-"})`;

function fmtFindings(f: Finding[], label: string): string {
  const errs = f.filter((x) => x.severity === "error");
  const adv = f.filter((x) => x.severity === "advice");
  const line = (x: Finding) => `  ${x.severity === "error" ? "x" : "?"} ${x.marker != null ? String(x.marker).padStart(6) : "      "} [${x.rule}] ${x.msg}${x.excerpt ? `\n           "${x.excerpt}"` : ""}`;
  const parts = [`${label}: ${errs.length} error${errs.length === 1 ? "" : "s"}, ${adv.length} advisory`];
  if (errs.length) parts.push("ERRORS (must fix):", ...errs.map(line));
  if (adv.length) parts.push("ADVICE (judgment calls, never auto-fix):", ...adv.map(line));
  if (!f.length) parts.push("  clean");
  return parts.join("\n");
}

function listScripts(): { path: string; course: string; week: string; lesson: string; mtime: number }[] {
  const root = config().scriptsRoot;
  const out: any[] = [];
  const walk = (dir: string, depth: number, crumbs: string[]) => {
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name === "Script.yml") {
        const [course = "", , week = "", lesson = ""] = crumbs;
        out.push({ path: p, course, week, lesson: lesson || path.basename(dir), mtime: fs.statSync(p).mtimeMs });
      } else if (e.isDirectory() && depth < 5 && !e.name.startsWith(".")) walk(p, depth + 1, [...crumbs, e.name]);
    }
  };
  walk(root, 0, []);
  return out.sort((a, b) => a.course.localeCompare(b.course) || a.week.localeCompare(b.week) || a.lesson.localeCompare(b.lesson));
}

const S = (props: Record<string, any>, required?: string[]) => ({ type: "object" as const, properties: props, required });
const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", description });
const bool = (description: string) => ({ type: "boolean", description });

// ── tools ────────────────────────────────────────────────────────────────────
const tools: Tool[] = [];

tools.push({
  name: "script_list",
  description: "Every Script.yml under the configured courses root, with course/week/lesson and modified time. Marks the one Metrik Studio currently has open, and whether it has unsaved changes.",
  inputSchema: S({ filter: str("optional substring to match against the path") }),
  async run({ filter }) {
    const st = await ask<{ openScript?: string; dirty?: boolean }>("status");
    const rows = listScripts().filter((r) => !filter || r.path.toLowerCase().includes(String(filter).toLowerCase()));
    if (!rows.length) return "no scripts found";
    return rows.map((r) => {
      const open = st?.openScript && path.resolve(st.openScript) === path.resolve(r.path);
      const tag = open ? (st?.dirty ? "  <- OPEN IN STUDIO, UNSAVED CHANGES" : "  <- open in Studio") : "";
      return `${r.course} / ${r.week} / ${r.lesson}\n    ${r.path}${tag}`;
    }).join("\n");
  },
});

tools.push({
  name: "script_outline",
  description: "One line per marker: the marker number and a summary of every entry on it. The fastest way to see a script's shape.",
  inputSchema: S({ file: str("path to Script.yml") }, ["file"]),
  async run({ file }) {
    const src = await open(file); const s = src.script;
    return liveNote(src) + markers(s).map((m) => `${String(m).padStart(6)}  ${entriesAt(s, m).map(brief).join("  |  ")}`).join("\n");
  },
});

tools.push({
  name: "script_get",
  description: "Entries in a marker range, as JSON. Use before editing so the edit is placed against what is actually there.",
  inputSchema: S({ file: str("path to Script.yml"), from: int("first marker"), to: int("last marker (defaults to `from`)") }, ["file", "from"]),
  async run({ file, from, to }) {
    const src = await open(file); const s = src.script;
    const a = Number(from), b = to != null ? Number(to) : Number(from);
    return liveNote(src) + JSON.stringify(s.entries.filter((e) => e.start >= a && e.start <= b).map(({ id, ...e }) => e), null, 1);
  },
});

tools.push({
  name: "script_grep",
  description: "Search every text and keystroke in a script (or every script under the courses root) for a regex. Case-insensitive unless you ask otherwise, which matters for anything hunting capitals.",
  inputSchema: S({ pattern: str("JavaScript regex"), file: str("one Script.yml; omit to search them all"), matchCase: bool("respect capitals (default false)") }, ["pattern"]),
  run({ pattern, file, matchCase }) {
    const re = new RegExp(pattern, matchCase ? "" : "i");
    const files = file ? [file] : listScripts().map((r) => r.path);
    const out: string[] = [];
    for (const f of files) {
      let s: Script;
      try { s = load(f); } catch { continue; }
      for (const e of s.entries) {
        const hay = (e as any).text ?? (e as any).keystrokes?.join("\n") ?? "";
        if (re.test(hay)) out.push(`${files.length > 1 ? f.replace(config().scriptsRoot + "/", "") + "  " : ""}${e.start}: ${brief(e)}`);
      }
    }
    return out.length ? out.join("\n") : "no matches";
  },
});

tools.push({
  name: "script_edit_text",
  description:
    "Replace a substring inside ONE entry's text, leaving everything else alone. `old` must appear exactly once in that entry or nothing is written. Line entries are re-wrapped to 70 characters; editor entries keep their line structure. This is the right tool for a wording change -- it cannot disturb markers, keystrokes or neighbouring entries. When Studio has the file open with unsaved changes, the edit is read from and applied to that buffer instead of the file, so his in-progress work is neither ignored nor overwritten; he then undoes or saves it.",
  inputSchema: S({
    file: str("path to Script.yml"), marker: int("the entry's start marker"),
    old: str("exact text to replace"), new: str("replacement (empty string deletes)"),
    actor: str("Dev or Glitch, when the marker holds both"),
  }, ["file", "marker", "old", "new"]),
  async run({ file, marker, old, new: rep, actor }) {
    const src = await open(file); const s = src.script;
    const cands = entriesAt(s, Number(marker)).filter((e) => (e as any).text != null && (!actor || (e as any).actor === actor));
    if (!cands.length) throw new Error(`no text entry at marker ${marker}${actor ? ` for ${actor}` : ""}`);
    // Stored text is hard-wrapped at 70, so a phrase that happens to straddle a
    // wrap point would never match literally. For prose, match on the unwrapped
    // form and re-wrap afterwards; editor entries keep their line structure, so
    // they match literally.
    const flat = (t: string) => t.replace(/\s+/g, " ").trim();
    const needle = flat(old);
    const hits = cands.filter((e) => (e.type === "line" ? flat((e as any).text).includes(needle) : ((e as any).text as string).includes(old)));
    if (!hits.length) {
      const have = cands.map((e) => `${(e as any).actor ?? e.type}: ${flat((e as any).text).slice(0, 160)}`).join("\n  ");
      throw new Error(`"${needle.slice(0, 60)}" not found at marker ${marker}. What is there:\n  ${have}`);
    }
    if (hits.length > 1) throw new Error(`"${needle.slice(0, 40)}" appears in ${hits.length} entries at marker ${marker}; pass actor`);
    const e = hits[0] as any;
    if (e.type === "line") {
      const hay = flat(e.text);
      const n = hay.split(needle).length - 1;
      if (n > 1) throw new Error(`"${needle.slice(0, 40)}" appears ${n} times in that entry; make it unique`);
      e.text = wrap70(hay.replace(needle, flat(rep)));
    } else {
      const n = (e.text as string).split(old).length - 1;
      if (n > 1) throw new Error(`"${String(old).slice(0, 40)}" appears ${n} times in that entry; make it unique`);
      e.text = (e.text as string).replace(old, rep);
    }
    const push = await commit(file, src, s);
    const errs = errorsOf(checkScript(s)).filter((x) => x.marker === Number(marker));
    return `ok ${marker} ${brief(e)}` + (errs.length ? `\nWARNING, this entry now has errors:\n${errs.map((x) => "  x " + x.msg).join("\n")}` : "") + push;
  },
});

tools.push({
  name: "script_set",
  description: "Create or replace a whole entry at a marker. Kinds: line, editor, keys, face, slide, avatar, outro. Prefer script_edit_text for a wording change.",
  inputSchema: S({
    file: str("path to Script.yml"), marker: int("start marker"),
    kind: str("line | editor | keys | face | slide | outro"),
    data: { type: "object", description: 'fields for the kind, e.g. {"actor":"Dev","text":"..."} or {"keystrokes":["k:escape"]}' },
  }, ["file", "marker", "kind", "data"]),
  async run({ file, marker, kind, data }) {
    const src = await open(file); const s = src.script;
    const m = Number(marker);
    const d = data ?? {};
    const existing = entriesAt(s, m);
    const end = d.end ?? existing[0]?.end ?? (markers(s).find((x) => x > m) ?? m + 100);
    const base = { id: newId(), start: m, end, auto: d.auto || undefined };
    let e: Entry;
    if (kind === "line") e = { ...base, type: "line", actor: d.actor === "Glitch" ? "Glitch" : "Dev", text: wrap70(String(d.text ?? "").trim()), mood: d.mood || undefined };
    else if (kind === "editor") e = { ...base, type: "editor", text: String(d.text ?? "").trim() };
    else if (kind === "keys") e = { ...base, type: "keys", keystrokes: d.keystrokes ?? [], speed: d.speed };
    else if (kind === "face") e = { ...base, type: "face", actor: d.actor === "Dev" ? "Dev" : undefined, mood: d.mood ?? "neutral", hold: d.hold, delay: d.delay };
    else if (kind === "slide") e = { ...base, type: "slide", actor: d.actor === "Glitch" ? "Glitch" : "Dev", to: d.to ?? "left", over: d.over };
    else if (kind === "avatar") e = { ...base, type: "avatar", to: d.to === "real" ? "real" : "avatar", over: d.over };
    else if (kind === "outro") e = { ...base, type: "outro", next: d.next || undefined, thanks: d.thanks ?? undefined, phases: d.phases ?? undefined };
    else throw new Error("unknown kind " + kind);
    // a marker can carry one face per character: setting Dev's must not
    // overwrite Glitch's
    const i = s.entries.findIndex((x) => x.start === m && x.type === kind
      && (kind !== "line" || (x as any).actor === (e as any).actor)
      && (kind !== "face" || ((x as any).actor ?? null) === ((e as any).actor ?? null)));
    if (i >= 0) s.entries[i] = e; else s.entries.push(e);
    if (!existing.length) closeGapBefore(s, m);
    s.entries.sort((a, b) => a.start - b.start);
    return `ok ${m} ${brief(e)}` + (await commit(file, src, s));
  },
});

tools.push({
  name: "script_insert_marker",
  description: "Reserve a new marker after an existing one, halving the gap so nothing downstream has to be renumbered. Returns the new marker number.",
  inputSchema: S({ file: str("path to Script.yml"), after: int("the marker to insert after") }, ["file", "after"]),
  async run({ file, after }) { return String(markerBetween((await open(file)).script, Number(after))); },
});

tools.push({
  name: "script_remove",
  description: "Remove entries at a marker, by kind or all of them.",
  inputSchema: S({ file: str("path to Script.yml"), marker: int("start marker"), kind: str("one kind, or omit for all") }, ["file", "marker"]),
  async run({ file, marker, kind }) {
    const src = await open(file); const s = src.script;
    const before = s.entries.length;
    s.entries = s.entries.filter((e) => !(e.start === Number(marker) && (!kind || e.type === kind)));
    return `removed ${before - s.entries.length}` + (await commit(file, src, s));
  },
});

tools.push({
  name: "script_diff",
  description:
    "Semantic diff of a script against an earlier version, by marker rather than by line. Metrik Studio reformats on save, so a plain text diff of a file Jeromy has edited is unreadable noise; this compares parsed entries and shows only what actually changed. Defaults to comparing against the .bak written by the last tool write.",
  inputSchema: S({ file: str("path to Script.yml"), against: str("path to compare against (default: <file>.bak)") }, ["file"]),
  run({ file, against }) {
    const other = against || file + ".bak";
    if (!fs.existsSync(other)) return `nothing to compare against (${other} does not exist)`;
    const d = markerDiff(load(other), load(file));
    const out = d.details.map((x) => {
      if (x.kind !== "~") return `${x.kind} ${x.marker} ${brief(x.entry)}`;
      // Report the FIELDS too, not just the text. A script_set replaces a
      // whole entry, so passing no mood silently drops the one that was
      // there; rendering only .text showed an identical was/now and hid it.
      const flat = (e: Entry) => (((e as any).text ?? (e as any).keystrokes?.join(" ") ?? "") as string).replace(/\s+/g, " ");
      const rest = (e: Entry) => { const { id, start, end, text, keystrokes, ...r } = e as any; return JSON.stringify(r); };
      const out = [`~ ${x.marker} ${(x.entry as any).actor ?? x.entry.type}`];
      if (flat(x.was!) !== flat(x.entry)) out.push(`    was: ${flat(x.was!)}`, `    now: ${flat(x.entry)}`);
      if (rest(x.was!) !== rest(x.entry)) out.push(`    was: ${rest(x.was!)}`, `    now: ${rest(x.entry)}`);
      return out.join("\n");
    });
    return out.length ? out.join("\n") : "no semantic changes";
  },
});

tools.push({
  name: "script_check",
  description:
    "Every rule in one pass: hard requirements (70 chars, moods, marker discipline, Roll Intro, focus, unmodelled keystrokes, coursework references, British spellings, em dashes) plus advisory voice checks (sentence fragments, verbless run-ups, AI tells, repeated openers, flat agreements). ERRORS must be fixed. ADVICE is a judgment call for a human and must never be auto-applied to Jeromy's own wording.",
  inputSchema: S({ file: str("path to Script.yml; its Slides.html is used for the deck invariant if present"), errorsOnly: bool("hide the advisory tier") }, ["file"]),
  async run({ file, errorsOnly }) {
    const src = await open(file); const s = src.script;
    const deckFile = path.join(path.dirname(file), "Slides.html");
    const info = fs.existsSync(deckFile) ? readDeck(deckFile) : null;
    let f = checkScript(s, info ? { deck: { slides: info.slides, holds: info.holds } } : {});
    if (info) f = f.concat(checkDeck(path.dirname(file)).findings.filter((x) => x.rule === "setup-header"));
    if (errorsOnly) f = errorsOf(f);
    return liveNote(src) + fmtFindings(f, path.basename(path.dirname(file)));
  },
});

tools.push({
  name: "deck_check",
  description: "Slides.html against its script: the deck invariant (slides + held reveals == k:right + 1) and the numbers written in the setup header prose, which go stale silently when a slide is added or dropped.",
  inputSchema: S({ dir: str("lesson folder") }, ["dir"]),
  run({ dir }) {
    const { info, findings } = checkDeck(dir);
    const head = info ? `${info.slides} slides, ${info.holds} held reveal(s)\n` + info.kickers.map((k, i) => `  ${String(i + 1).padStart(3)} ${k}`).join("\n") + "\n" : "";
    return head + fmtFindings(findings, path.basename(dir));
  },
});

tools.push({
  name: "deck_remove_slide",
  description: "Remove one <section class=\"slide\"> from a deck by its 1-based position, then re-check the invariant. Parsed, not spliced by line number.",
  inputSchema: S({ dir: str("lesson folder"), slide: int("1-based slide number"), confirm: bool("must be true") }, ["dir", "slide", "confirm"]),
  run({ dir, slide, confirm }) {
    if (!confirm) throw new Error("pass confirm: true -- this edits the deck");
    const b = lessonBundle(dir);
    if (!b.slides) throw new Error("no Slides.html here");
    const html = read(b.slides);
    const secs = slideSections(html);
    const target = secs[Number(slide) - 1];
    if (!target) throw new Error(`no slide ${slide} (deck has ${secs.length})`);
    fs.copyFileSync(b.slides, b.slides + ".bak");
    assertCurrent();
    fs.writeFileSync(b.slides, removeSlide(html, Number(slide)));
    const after = checkDeck(dir);
    return `removed slide ${slide}: ${target.text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 80)}\n` + fmtFindings(after.findings, path.basename(dir));
  },
});

tools.push({
  name: "wb_preview",
  description:
    "Replay the script's keystrokes through a model of the MySQL Workbench editor and show the buffer at every Run. Use this whenever a demo EDITS the statement on screen instead of retyping it, because then the SQL that reaches the server depends on cursor positions and counted backspaces.",
  inputSchema: S({ file: str("path to Script.yml") }, ["file"]),
  async run({ file }) {
    const src = await open(file);
    const { runs, unknown } = replay(src.script);
    const out: string[] = [];
    if (unknown.length) out.push("UNMODELLED KEYSTROKES (the buffer below is incomplete):", ...unknown.map((u) => `  marker ${u.marker}: k:${u.key}`), "");
    for (const r of runs) {
      out.push(`----- Run ${r.run} (marker ${r.marker}) -----`, r.sql);
      if (SUSPICIOUS.test(r.sql)) out.push("  ^^ SUSPICIOUS ending: a counted edit probably went wrong");
    }
    return liveNote(src) + (out.join("\n") || "no Run steps in this script");
  },
});

tools.push({
  name: "wb_run",
  description:
    "Replay the keystrokes, then run each resulting statement against a real MySQL and report exactly what the server returned. The standing rule is that no result grid may come from reasoning. Needs a running MySQL container; it never starts one, so it cannot contend with a render.",
  inputSchema: S({ dir: str("lesson folder (its seed.sql is applied first)"), container: str("name of a running MySQL docker container"), password: str("root password (default pw)") }, ["dir", "container"]),
  async run({ dir, container, password }) {
    const b = lessonBundle(dir);
    if (!b.script) throw new Error("no Script.yml here");
    if (!b.seed) throw new Error("no seed.sql here; every result must come from this lesson's own data");
    const pw = password || "pw";
    const up = await run("docker", ["inspect", "-f", "{{.State.Running}}", container]);
    if (up.out.trim() !== "true")
      throw new Error(`container "${container}" is not running. Start one yourself: docker run -d --rm --name ${container} -e MYSQL_ROOT_PASSWORD=${pw} mysql:9.7.2`);
    const seed = read(b.seed);
    await run("docker", ["exec", "-i", container, "mysql", `-p${pw}`], seed);
    const schema = (seed.split("\n").find((l) => /^use\s/i.test(l.trim())) ?? "").trim().split(/\s+/)[1]?.replace(";", "") ?? "";
    const { runs, unknown } = replay(load(b.script));
    const out: string[] = [];
    if (unknown.length) out.push("UNMODELLED KEYSTROKES, results below are not trustworthy:", ...unknown.map((u) => `  marker ${u.marker}: k:${u.key}`), "");
    for (const r of runs) {
      const res = await run("docker", ["exec", "-i", container, "mysql", `-p${pw}`, "--table"], `USE ${schema};\n${r.sql}\n`);
      const clean = res.out.split("\n").filter((l: string) => l && !/Using a password/.test(l)).join("\n").trim();
      out.push(`===== statement ${r.run} (marker ${r.marker}) =====`, r.sql, clean || "(empty set, no error, no warning)", "");
    }
    return out.join("\n");
  },
});

tools.push({
  name: "keys_vocabulary",
  description:
    "The keystrokes the recorder and the Workbench model agree on, each marked verified / modelled / unknown, with the gotcha for each. Check an unfamiliar key here BEFORE writing it into a script: an unknown key is one whose on-screen effect nobody has confirmed.",
  inputSchema: S({}),
  run() {
    const w = Math.max(...KEY_VOCABULARY.map((k) => k.key.length));
    return KEY_VOCABULARY.map((k) => `${k.key.padEnd(w)}  ${k.status.padEnd(8)}  ${k.note}`).join("\n");
  },
});

tools.push({
  name: "moods",
  description: "Glitch's mood names, with the feeling each one is built around. Only these are valid in a mood field or an inline [tag].",
  inputSchema: S({}),
  run() {
    return Object.entries(MOODS).map(([k, m]: [string, any]) => `${k.padEnd(10)} ${String(m.label).padEnd(10)} ${String(m.group).padEnd(9)} ${m.quote}`).join("\n");
  },
});

tools.push({
  name: "outro_preview",
  description: "The outro as it will actually play, with every default filled in -- the four phases, their moods, and the lines Glitch speaks.",
  inputSchema: S({ file: str("path to Script.yml") }, ["file"]),
  run({ file }) {
    const o = load(file).entries.find((e) => e.type === "outro");
    if (!o) return "no outro entry";
    return outroPhases(o as any).map((p) => `${p.phase.padEnd(9)} [${p.mood}] ${p.title}${p.subtitle ? " - " + p.subtitle : ""}\n          ${p.text.replace(/\n/g, "\n          ")}`).join("\n");
  },
});

tools.push({
  name: "lesson_bundle",
  description: "Every asset path for one lesson folder: script, slides, Canvas page, summary, seed and YouTube metadata, plus which are missing.",
  inputSchema: S({ dir: str("lesson folder") }, ["dir"]),
  run({ dir }) {
    const b = lessonBundle(dir);
    const rows = (["script", "slides", "content", "summary", "seed", "youtube"] as const).map((k) => `  ${k.padEnd(8)} ${(b as any)[k] ?? "(missing)"}`);
    return `${b.course} / ${b.week} / ${b.lesson}\n${rows.join("\n")}`;
  },
});

// ── Studio (read-only, device-free) ──────────────────────────────────────────
tools.push({
  name: "studio_status",
  description:
    "What Metrik Studio is doing right now: whether it is running, which script is open, whether it has unsaved changes, whether what is on screen matches the file on disk, whether a recording is live, and how far along the post pipeline is. You do not need to check this before editing -- the script tools read and write Studio's unsaved buffer by themselves when it has one.",
  inputSchema: S({}),
  async run() {
    const b = readBridge();
    if (!b) return "Metrik Studio is not running (or its bridge is disabled). All file tools still work.";
    const st = await ask<any>("status");
    if (!st) return `bridge file found (pid ${b.pid}) but Studio did not answer; treat it as running and ask before writing`;
    // Dirty says "Jeromy has typed something". Sync says "the screen shows
    // what is on disk". They are different questions, and only the second
    // one answers "did my edit land in front of him".
    let sync = "";
    if (st.openScript && st.hash) {
      try { sync = textHash(fs.readFileSync(st.openScript, "utf8")) === st.hash ? "   (in sync with disk)" : "   (Studio is showing something other than the file on disk)"; } catch {}
    }
    const rows = [
      `running     pid ${st.pid}, up ${Math.round((Date.now() - st.startedAt) / 1000)}s`,
      `open script ${st.openScript ?? "(none)"}${st.dirty ? "   *** UNSAVED CHANGES ***" : sync}`,
      `recording   ${st.recording ? `YES, since ${new Date(st.recordingSince).toLocaleTimeString()} (${st.recordingScript ?? ""})` : "no"}`,
      `post        ${st.post ? `${st.post.step} (${st.post.index}/${st.post.total}) ${st.post.state}` : "idle"}`,
    ];
    return rows.join("\n");
  },
});

tools.push({
  name: "studio_reload",
  description: "Ask a running Metrik Studio to re-read a script from disk. The write tools do this on their own, so this is only needed after an edit made some other way (a shell command, a generator). Refuses when that script has unsaved changes in Studio, and does nothing when a different script is open.",
  inputSchema: S({ file: str("path to Script.yml") }, ["file"]),
  async run({ file }) {
    const r = await ask<{ ok: boolean; applied?: boolean; reason?: string }>("reload", { file });
    if (!r) return "Studio is not running; nothing to reload";
    if (r.applied) return `Studio reloaded ${path.basename(file)} on screen`;
    return r.ok ? `Nothing to do: ${r.reason}` : `Studio refused: ${r.reason}`;
  },
});

tools.push({
  name: "studio_notify",
  description: "Put a short line in Metrik Studio's UI, so Jeromy can see what changed without reading a diff. Use it after editing a script he has open.",
  inputSchema: S({ text: str("one line, e.g. 'rewrote markers 800 and 1600 (fragments)'") }, ["text"]),
  async run({ text }) {
    const r = await ask("notify", { text });
    return r ? "shown in Studio" : "Studio is not running; nothing shown";
  },
});

tools.push({
  name: "studio_takes",
  description:
    "Which markers were re-recorded, and how often, for a lesson. A marker recorded three times is a line that did not work out loud -- the most direct feedback the writing gets, and far better than diffing saved scripts after the fact. Reads the recording sessions on disk, so it works with Studio closed.",
  inputSchema: S({ lesson: str("substring of the lesson or session path; omit for the most recent session"), all: bool("every session, not just the newest") }),
  run({ lesson, all }) {
    const root = config().recordingsRoot;
    let dirs = findSessions(root, lesson);
    if (!dirs.length) return `no recording sessions found under ${root}${lesson ? ` matching "${lesson}"` : ""}`;
    if (!all) dirs = dirs.slice(0, 1);
    // pair each marker with the line it belongs to, from the script copied
    // into the session folder when recording started
    const digest = dirs.map((d) => {
      let lineAt: ((m: number) => string | undefined) | undefined;
      try {
        const s = parseScript(read(path.join(d, "Script.yml"))).script;
        lineAt = (m) => { const e = entriesAt(s, m).find((x) => x.type === "line"); return e ? brief(e) : undefined; };
      } catch {}
      return retakeDigest([d], lineAt);
    }).join("\n\n");
    return digest;
  },
});

serve("metrik-studio", "0.1.0", tools);
