// mscript: edit Metrik Rule Script.yml files in pieces from a shell or from Claude Code.
// Every command reads the file, applies one change, writes it back (a .bak is kept). Markers are the YAML `start` numbers.
import fs from "node:fs";
import path from "node:path";
import { parseScript, serializeScript, markers, entriesAt, markerBetween, newId, validate, cleanText, outroPhases, Entry, Script } from "../shared/script";
import { MOOD_NAMES, MOODS } from "../../glitch/moods";

const HELP = `mscript — Metrik Studio script CLI

  mscript doc                                  this text (give it to an LLM)
  mscript ls <file>                            one line per marker
  mscript get <file> <from> [to]               entries in a marker range as JSON
  mscript grep <file> <regex>                  search all text
  mscript set <file> <marker> <kind> <json|->  create/replace an entry; json from arg or stdin
  mscript rm <file> <marker> [kind|all]        remove entries at a marker
  mscript ins <file> <after>                   new empty marker after <after> (halves the gap); prints its number
  mscript renumber <file>                      re-space all markers by 100
  mscript validate <file>                      hard-requirement checks
  mscript outro <file>                         show the resolved outro phases (defaults filled in)
  mscript moods                                list Glitch's moods
  mscript new <file> [lesson title]            write a fresh script from the standard template

kinds and their json fields:
  line     {"actor":"Dev|Glitch","text":"…","mood":"curious"?,"auto":true?}
  editor   {"text":"…"}
  keys     {"keystrokes":["k:ctrl+a","t:code","m:click"],"speed":1-10?}
  face     {"mood":"malice","delay":2000?,"hold":800?}   delay = wait before the face changes; hold = revert after
  slide    {"actor":"Dev|Glitch","to":"left|right|top|bottom|hide|show","over":600?}
  outro    {"next":"Dictionaries","thanks":["Nicole"],"phases":[{"phase":"next","text":"…","mood":"deception"}]?}
Inline [mood] tags inside any text switch Glitch's face mid-line. Lines ≤ 70 chars. Every text line must be speakable.
"end" defaults to the next marker (or start+100); pass "end" in the json to override.`;

const TEMPLATE = (title: string) => `script:

- type: "editor"
  start: 0
  end: 100
  text: |
    Describe what is open in the VM before recording starts.

- type: "line"
  actor: "Dev"
  start: 100
  end: 200
  text: "Greetings! I'm Dev the Developer!"

- type: "line"
  actor: "Glitch"
  start: 200
  end: 300
  mood: "excited"
  text: "...and I'm Glitch!"

- type: "line"
  actor: "Dev"
  start: 300
  end: 400
  text: |
    Today we are going to talk about ${title}.

- type: "editor"
  start: 400
  end: 500
  text: "Roll Intro"

- type: "line"
  actor: "Dev"
  start: 9000
  end: 9100
  text: |
    Content-specific transition... Don't just watch it... Do it!

- type: "outro"
  start: 9100
  end: 9200
  next: ""
  thanks: []
`;

function load(file: string): Script { const { script, errors } = parseScript(fs.readFileSync(file, "utf8")); if (errors.length) console.error("warnings:", errors.join("; ")); return script; }
function save(file: string, s: Script) { if (fs.existsSync(file)) fs.copyFileSync(file, file + ".bak"); fs.writeFileSync(file, serializeScript(s)); }
const brief = (e: Entry) => e.type === "line" ? `${e.actor}${e.mood ? `[${e.mood}]` : ""}: ${cleanText(e.text).replace(/\n/g, " ").slice(0, 70)}` : e.type === "editor" ? `note: ${e.text.replace(/\n/g, " ").slice(0, 50)}` : e.type === "keys" ? `keys(${e.keystrokes.length})` : e.type === "face" ? `face:${e.mood}` : e.type === "slide" ? `slide:${e.actor}→${e.to}` : `outro(next: ${e.next ?? "-"}; thanks: ${(e.thanks ?? []).join(", ") || "-"})`;
const readJson = (arg: string | undefined) => JSON.parse(!arg || arg === "-" ? fs.readFileSync(0, "utf8") : arg);

function main(argv: string[]) {
  const [cmd, file, ...rest] = argv;
  if (!cmd || cmd === "doc" || cmd === "help" || cmd === "-h" || cmd === "--help") { console.log(HELP); return; }
  if (cmd === "moods") { for (const [k, m] of Object.entries(MOODS)) console.log(`${k.padEnd(10)} ${m.label.padEnd(10)} ${m.group.padEnd(9)} ${m.quote}`); return; }
  if (!file) throw new Error("file required");
  if (cmd === "new") { if (fs.existsSync(file)) throw new Error("exists: " + file); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, TEMPLATE(rest.join(" ") || "the lesson")); console.log("wrote " + file); return; }
  const s = load(file);
  switch (cmd) {
    case "ls": for (const m of markers(s)) console.log(`${String(m).padStart(6)}  ${entriesAt(s, m).map(brief).join("  |  ")}`); break;
    case "get": { const a = +rest[0], b = rest[1] != null ? +rest[1] : a; console.log(JSON.stringify(s.entries.filter((e) => e.start >= a && e.start <= b).map(({ id, ...e }) => e), null, 1)); break; }
    case "grep": { const re = new RegExp(rest[0], "i"); for (const e of s.entries) if (re.test((e as any).text ?? (e as any).keystrokes?.join("\n") ?? "")) console.log(`${e.start}: ${brief(e)}`); break; }
    case "set": {
      const marker = +rest[0], kind = rest[1], d = readJson(rest[2]);
      if (!Number.isFinite(marker) || !kind) throw new Error("usage: set <file> <marker> <kind> <json|->");
      const existing = entriesAt(s, marker);
      const end = d.end ?? existing[0]?.end ?? (markers(s).find((m) => m > marker) ?? marker + 100);
      const base = { id: newId(), start: marker, end, auto: d.auto || undefined };
      let e: Entry;
      if (kind === "line") e = { ...base, type: "line", actor: d.actor === "Glitch" ? "Glitch" : "Dev", text: String(d.text ?? "").trim(), mood: d.mood || undefined };
      else if (kind === "editor") e = { ...base, type: "editor", text: String(d.text ?? "").trim() };
      else if (kind === "keys") e = { ...base, type: "keys", keystrokes: d.keystrokes ?? [], speed: d.speed };
      else if (kind === "face") e = { ...base, type: "face", mood: d.mood ?? "neutral", hold: d.hold, delay: d.delay };
      else if (kind === "slide") e = { ...base, type: "slide", actor: d.actor === "Glitch" ? "Glitch" : "Dev", to: d.to ?? "left", over: d.over };
      else if (kind === "outro") e = { ...base, type: "outro", next: d.next || undefined, thanks: d.thanks ?? undefined, phases: d.phases ?? undefined };
      else throw new Error("unknown kind " + kind);
      const i = s.entries.findIndex((x) => x.start === marker && x.type === kind && (kind !== "line" || (x as any).actor === (e as any).actor));
      if (i >= 0) s.entries[i] = e; else s.entries.push(e);
      s.entries.sort((a, b) => a.start - b.start); save(file, s); console.log(`ok ${marker} ${brief(e)}`); break;
    }
    case "rm": { const marker = +rest[0], kind = rest[1] ?? "all"; const n = s.entries.length; s.entries = s.entries.filter((e) => !(e.start === marker && (kind === "all" || e.type === kind))); save(file, s); console.log(`removed ${n - s.entries.length}`); break; }
    case "ins": { const m = markerBetween(s, +rest[0]); console.log(m); break; }
    case "renumber": { const ms = markers(s), map = new Map(ms.map((m, i) => [m, (i + 1) * 100])); s.entries = s.entries.map((e) => ({ ...e, start: map.get(e.start)!, end: map.get(e.end) ?? map.get(e.start)! + 100 })); save(file, s); console.log(`renumbered ${ms.length} markers`); break; }
    case "validate": { const v = validate(s); if (!v.length) console.log("clean"); else { for (const x of v) console.log("- " + x.msg); process.exitCode = 1; } break; }
    case "outro": { const o = s.entries.find((e) => e.type === "outro"); if (!o || o.type !== "outro") { console.log("no outro entry"); break; } for (const p of outroPhases(o)) console.log(`${p.phase.padEnd(9)} [${p.mood}] ${p.title}${p.subtitle ? " · " + p.subtitle : ""}${p.names.length ? " · " + p.names.join(", ") : ""}\n          ${p.text.replace(/\n/g, "\n          ")}`); break; }
    default: throw new Error("unknown command " + cmd + "\n" + HELP);
  }
}
try { main(process.argv.slice(2)); } catch (e: any) { console.error("error: " + e.message); process.exitCode = 2; }
void MOOD_NAMES;
