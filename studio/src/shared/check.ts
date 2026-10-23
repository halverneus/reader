// One checker for a Script.yml, replacing five that had grown up separately:
// mscript's validate(), spice.py's voice lint, script_builder.lint() in the
// generators, a throwaway fragment detector, and an awk one-liner for the deck
// invariant. Three languages, inconsistent severity, and no single answer to
// "is this script ready".
//
// Severity is the important part, and it is the lesson of 2026-10-20. A rule
// about intent that FAILS a build gets silenced by editing the text, and twice
// that month the text edited was Jeromy's own. So:
//
//   error  - a hard requirement. The recording breaks, or a house rule that has
//            no judgment in it (70 chars, unknown mood, em dash, a class
//            reference a public viewer cannot resolve).
//   advice - a judgment call for a human. Printed, never fatal, never acted on
//            automatically.
import { parseScript, validate as hardValidate, cleanText, markers, entriesAt, type Script, type Entry } from "./script";
import { auditKeystrokes } from "./keys";

export type Severity = "error" | "advice";
export interface Finding {
  severity: Severity;
  rule: string;
  marker?: number;
  actor?: string;
  msg: string;
  excerpt?: string;
}

// ── coursework cross-over ────────────────────────────────────────────────────
// Jeromy, 2026-10-20, correcting a word-list version of this rule: "It wasn't
// meant to be a ban on the word 'lesson', it was just being used to reference
// course material that I didn't want crossed over into the videos (as the
// videos are intended to stand alone)." So two tiers, not one list.
//
// Hard: things that only exist for an enrolled student, where there is no
// public substitute to improvise at the microphone.
export const COURSEWORK = new RegExp(
  "\\b(?:" +
  "assignments?|graders?|homework|syllabus|gradebooks?|midterms?|quiz|quizzes" +
  "|semesters?|campus|classmates?|instructors?|professors?|enrolled" +
  "|due\\s+dates?|office\\s+hours" +
  "|this\\s+(?:course|class|term|quarter|semester)" +
  "|(?:your|the)\\s+assignment" +
  "|(?:next|last|this)\\s+weeks?" +
  "|week\\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\\d+)" +
  "|lessons?\\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|\\d+)" +
  "|CS\\s?\\d{3}" +
  ")\\b", "i");

// Soft: words that usually mean something innocent. A lesson is a video, a
// class is a C# class, a course is "of course", a quarter is twenty five cents
// or a MySQL INTERVAL unit.
export const COURSE_CTX = /\b(?:lessons?|classe?s?|course|weeks?|students?|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i;

export const BRITISH = /\b(colour|favourite|behaviour|organise|recognise|licence|catalogue|modelling|grey|artefact|emphasise|neighbour|analyse|centre|apologise|realise|programme)\b/i;

// ── voice ────────────────────────────────────────────────────────────────────
const TELLS: [RegExp, string][] = [
  [/\bworth saying out loud\b/i, "AI tell"],
  [/\bsay (?:it|that) out loud\b/i, "AI tell"],
  [/\bthe shape of\b|\bthat is the shape\b/i, 'AI tell: "shape"'],
  [/\brule of thumb\b/i, "banned: origins of the phrase"],
  [/\bgenuinely worth\b/i, "AI tell"],
  [/\bvery good eye\b/i, "AI tell"],
  [/\bthat is the part that catches\b/i, "AI tell"],
  [/\bwhich is exactly what you want\b/i, "AI tell"],
  [/\bhere(?:'s| is) the thing\b/i, "AI tell"],
  [/\bbyte for byte\b/i, "AI tell"],
  [/\bthe whole point\b/i, "AI tell"],
  [/\bmessage to the next human\b/i, "AI tell"],
  [/\bworth photographing\b/i, "AI tell"],
  [/\b(?:my|the) honest answer\b/i, "AI tell"],
  [/\bexactly that\b/i, "AI tell"],
  [/\blet(?:'s| us) talk about\b/i, "AI tell"],
  [/\bdeep dive\b|\bdive in\b|\bdelve\b/i, "AI tell"],
  [/\bat the end of the day\b/i, "cliche"],
  [/\bit(?:'s| is) worth noting\b/i, "AI tell"],
  [/\bthat said\b|\bcrucially\b|\bfundamentally\b/i, "AI tell"],
  [/\bleverage\b|\bseamless\b|\brobust\b/i, "AI tell"],
  [/\bin a nutshell\b|\bbuckle up\b/i, "cliche"],
  [/\bthe key insight\b|\bhere(?:'s| is) the kicker\b/i, "AI tell"],
  [/\bI(?:'ll| will) be honest\b/i, "AI tell"],
  [/\bto be fair\b/i, "AI tell"],
  [/\bthat(?:'s| is) the beauty of\b/i, "AI tell"],
  [/\bthink of it as\b/i, "AI tell"],
  [/\bgame changer\b|\ba powerful tool\b/i, "cliche"],
  [/\bnot just\b.{0,40}\bbut\b/i, "AI antithesis"],
  [/\bEvery system I have ever looked at\b/i, "already used: retire this line"],
  [/error (?:one thousand|twelve hundred|one hundred)/i, 'say error codes as shorthand: "error ten sixty four"'],
];

const AGREE = /^(exactly|correct|precisely|you got it|that is right|that(?:'s| is) exactly|yes,|right,)/i;
const FIXED = /I'm Dev the Developer|Greetings|Don't just watch it|Do it!|And I am Glitch|Roll Intro|Subscribe/i;
const INTERJ = /^(oh+|ah+|wait|yes|no|hmm+|aha|right|huh|well|okay|ouch|hey|uh,? ?huh|nice|exactly|correct|agreed|true)$/i;
const IMPER = /^(?:(?:now|then|next|so|first|finally|again|instead|also|ok|okay|right|well|and|but)\b,?\s+)*(count|use|take|look|watch|read|write|hold|add|run|try|draw|keep|notice|go|come|stop|start|think|remember|forget|pick|put|let|leave|give|tell|ask|check|compare|subtract|open|close|press|type|swap|change|note|see|listen|wait|stay|do|don't|never|always|break|reverse|name|sort|finish|say|choose|show|follow|mind|forgive|imagine|assume|consider|avoid|prefer|enjoy|picture|meet|welcome|hang)\b/i;

// Finite verbs. A short list tuned for one rule is not reusable: wiring the
// fragment rules to spice.py's narrow TENSED produced 122 hits on eight clean
// scripts before this list replaced it.
const FINITE = new Set(`is are was were am be been being has have had do does did
can could will would should shall may might must ought let lets
get gets got goes go went give gives gave keep keeps kept run runs ran
come comes came mean means meant show shows showed appear appears sit sits
make makes made take takes took hold holds held need needs want wants
use uses clear clears beat beats match matches count counts return returns
live lives point points look looks read reads write writes wrote
tell tells told know knows knew think thinks thought say says said
see sees saw find finds found fall falls fell rise rises rose drop drops
stay stays cost costs happen happens differ differs apply applies
hide hides lose loses lost win wins won pass passes fail fails work works
help helps move moves turn turns start starts stop stops exist exists
carry carries bring brings leave leaves left remain remains belong belongs
survive survives arrive arrives add adds ask asks answer answers
break breaks broke build builds built call calls change changes
check checks choose chooses chose compare compares put puts send sends
set sets sort sorts split splits swap swaps try tries wait waits
watch watches wrap wraps accept accepts become becomes begin begins
collapse collapses contain contains decide decides depend depends
describe describes expect expects feel feels fire fires fit fits
follow follows hand hands hear hears heard hit hits land lands
learn learns like likes list lists load loads lock locks name names
notice notices open opens owe owes own owns pick picks play plays
produce produces reach reaches refuse refuses remember remembers
replace replaces report reports require requires rest rests save saves
scan scans seem seems sell sells sold serve serves share shares
skip skips sound sounds speak speaks spend spends spent stand stands
store stores suggest suggests support supports throw throws threw
touch touches treat treats understand understands understood
wonder wonders worry worries type types delete deletes insert inserts
select selects update updates join joins group groups filter filters
sum sums order orders average averages congratulate congratulates
mention mentions receive receives surprise surprises walk walks
settle settles settled catch catches caught equal equals
agree agrees disagree disagrees identify identifies argue argues argued
claim claims admit admits`.split(/\s+/));

// "nothing", "something", "during", "morning" all end in -ing
const NOTVERB = new Set(`nothing something anything everything morning during string
thing things spring ceiling meaning warning opening sibling indeed hundred
thousand red bed fed led shed wed need speed breed seed deed greed`.split(/\s+/));

const isVerb = (w: string) => {
  const b = w.replace(/^[^A-Za-z']+|[^A-Za-z']+$/g, "").toLowerCase();
  if (!b) return false;
  if (FINITE.has(b)) return true;
  return /^[a-z]{3,}(ed|ing)$/.test(b) && !NOTVERB.has(b);
};
const firstVerbAt = (words: string[]) => { for (let i = 0; i < words.length; i++) if (isVerb(words[i])) return i; return -1; };

/** A whole sentence with no finite verb anywhere, at any length. */
export function verbless(sentence: string): boolean {
  const core = sentence.replace(/^[\s"']+|[\s.!?"']+$/g, "");
  const words = core.split(/\s+/).filter(Boolean);
  if (words.length <= 3 || IMPER.test(core) || INTERJ.test(core) || FIXED.test(core)) return false;
  return firstVerbAt(words) < 0;
}

/**
 * A long verbless noun stack rescued by a clause at the end. Jeromy, 2026-10-22:
 * "a lot of sentences start off sounding like a fragment, then, after a comma,
 * puts out just enough to make it a technical sentence, even though the
 * majority of it reads like a fragment."
 */
export function runup(sentence: string): boolean {
  const core = sentence.replace(/^[\s"']+|[\s.!?"']+$/g, "");
  const words = core.split(/\s+/).filter(Boolean);
  const v = firstVerbAt(words);
  if (v < 0 || IMPER.test(core)) return false;
  if (!(v >= 6 && v * 2 >= words.length)) return false;
  const segs = core.split(",").filter((s) => s.trim());
  if (segs.length < 2) return false;
  // a relative clause hangs off the noun stack, it does not rescue it:
  // "And now the last one, which is the year twenty thirty eight." reads fine
  if (/^\s*(which|who|whom|whose|that)\b/i.test(segs[segs.length - 1])) return false;
  // an imperative tail is an instruction, not a rescue
  if (IMPER.test(segs[segs.length - 1].trim())) return false;
  const tailStart = segs.slice(0, -1).join(" ").split(/\s+/).filter(Boolean).length;
  return v >= tailStart;
}

/** "1. Harbor collides. 2. No index." is one sentence with list markers. */
const sentences = (t: string) => t.split(/(?<=[.!?])(?<!\b\d\.)\s+/).map((s) => s.trim()).filter(Boolean);

// ── the checker ──────────────────────────────────────────────────────────────
export interface CheckOptions { deck?: { slides: number; holds: number } }

/** Capitalised words a Glitch line may keep. ID is deliberate and has a
 *  pronunciation of its own; the rest are acronyms read as words anyway. */
// NULL is deliberately absent: the house style is "null" lowercase in a
// spoken line, so a capitalised one is a real hit.
export const CAPS_OK = new Set(["ID", "IDS", "SQL", "OK", "AI", "CPU", "GPU", "API", "CSV", "JSON", "URL", "PDF", "HTML", "UTC"]);

export function checkScript(s: Script, opts: CheckOptions = {}): Finding[] {
  const f: Finding[] = [];
  const err = (rule: string, msg: string, e?: Entry, excerpt?: string) =>
    f.push({ severity: "error", rule, msg, marker: e?.start, actor: (e as any)?.actor, excerpt });
  const adv = (rule: string, msg: string, e?: Entry, excerpt?: string) =>
    f.push({ severity: "advice", rule, msg, marker: e?.start, actor: (e as any)?.actor, excerpt });

  // hard requirements already encoded in the model
  const byId = new Map(s.entries.map((e) => [e.id, e]));
  for (const v of hardValidate(s)) err("hard", v.msg, byId.get(v.entryId));

  // ── per-entry text rules
  const openers = new Map<string, number[]>();
  const agrees: number[] = [];
  for (const e of s.entries) {
    const raw = (e as any).text as string | undefined;
    if (raw == null) continue;
    const t = e.type === "line" ? cleanText(raw) : raw;
    const isLine = e.type === "line";

    for (const m of [...t.matchAll(new RegExp(COURSEWORK, "gi"))])
      err("coursework", `coursework reference "${m[0].trim()}" — the videos stand alone`, e);
    if (isLine) for (const m of [...t.matchAll(new RegExp(COURSE_CTX, "gi"))])
      adv("course-context", `check context: "${m[0].trim()}"`, e);

    const br = BRITISH.exec(t);
    if (br) err("spelling", `British spelling "${br[0]}" (American English everywhere)`, e);
    if (t.includes("—")) err("em-dash", "em dash — house style bans them", e);

    if (!isLine) continue;

    for (const [re, label] of TELLS) { const m = re.exec(t); if (m) adv("voice", `${label}: "${m[0]}"`, e); }
    if (AGREE.test(t)) agrees.push(e.start);
    const key = t.split(/\s+/).slice(0, 3).join(" ").toLowerCase();
    if (!openers.has(key)) openers.set(key, []);
    openers.get(key)!.push(e.start);

    for (const sent of sentences(t)) {
      if (verbless(sent)) adv("fragment", "no verb in this sentence", e, sent.slice(0, 64));
      else if (runup(sent)) adv("fragment", "verbless run-up, rescued by the last clause", e, sent.slice(0, 64));
    }
  }

  for (const [k, at] of openers) if (at.length > 1 && k.split(" ").length >= 3)
    adv("repetition", `repeated opener "${k}" at ${at.join(", ")}`);
  if (agrees.length > 2)
    adv("conflict", `${agrees.length} flat agreements (budget 2) at ${agrees.join(", ")} — Dev agreeing with everything is the conflict problem`);

  // ── marker discipline
  for (const m of markers(s)) {
    const at = entriesAt(s, m);
    const keys = at.filter((e) => e.type === "keys");
    if (keys.length > 1) err("marker", `${keys.length} keys entries on one marker (at most one)`, at[0]);
    const hasDev = at.some((e) => e.type === "line" && (e as any).actor === "Dev");
    for (const e of at) {
      if (hasDev && e.auto) err("marker", "auto entry on a Dev marker", e);
      if (e.type === "line" && (e as any).actor === "Dev" && e.auto) err("marker", "Dev line must not be auto", e);
      if (e.type === "line" && (e as any).actor === "Glitch" && !e.auto) err("marker", "Glitch line must be auto", e);
      if (e.type === "editor" && /Roll Intro/.test((e as any).text) && e.auto) err("marker", "Roll Intro must never be auto", e);
    }
  }

  // ── ALL-CAPS in a spoken Glitch line.
  //
  // Kokoro reads a run of capitals letter by letter, so "NOT IN" comes out as
  // "en oh tee eye en". Jeromy has been fixing these by hand one script at a
  // time; the house style is the keyword quoted and lowercase, which reads
  // correctly AND tells the listener it is a keyword. "ID" is the standing
  // exception: it is DELIBERATELY uppercase and has its own pronunciation.
  for (const e of s.entries) {
    if (e.type !== "line" || (e as any).actor !== "Glitch") continue;
    const text = cleanText((e as any).text);
    const caps = [...new Set((text.match(/\b[A-Z]{2,}\b/g) ?? []).filter((w) => !CAPS_OK.has(w)))];
    if (caps.length)
      err("caps", `Glitch says ${caps.map((c) => `"${c}"`).join(", ")} in capitals; the voice spells those out. Write them quoted and lowercase, as ${caps.map((c) => `"${c.toLowerCase()}"`).join(", ")}`, e);
  }

  // ── Roll Intro. Seven of eight Week 06 scripts shipped without one because
  // the only rule on the subject checked its `auto` flag, which can only fire
  // on a script that already has the entry (2026-10-20).
  const intros = s.entries.filter((e) => e.type === "editor" && /Roll Intro/.test((e as any).text));
  const firstRight = s.entries.filter((e) => e.type === "keys" && (e as any).keystrokes.includes("k:right")).map((e) => e.start).sort((a, b) => a - b)[0];
  if (!intros.length) err("roll-intro", "no Roll Intro entry — every script has exactly one, between the cold open and the first k:right");
  else if (intros.length > 1) err("roll-intro", `${intros.length} Roll Intro entries`, intros[1]);
  else if (firstRight != null && intros[0].start > firstRight) err("roll-intro", `Roll Intro at ${intros[0].start} comes after the first k:right at ${firstRight}`, intros[0]);

  // ── keystrokes
  for (const e of s.entries) {
    if (e.type !== "keys") continue;
    for (const a of auditKeystrokes((e as any).keystrokes)) {
      if (a.status === "unknown")
        err("keys", `unmodelled keystroke "k:${a.key}"${a.replacement ? ` — use k:${a.replacement}` : ""}. ${a.note}`, e);
      else if (a.status === "modelled")
        adv("keys", `"k:${a.key}" is modelled but unverified on the real editor`, e);
    }
  }

  // ── focus: k:right only on the deck, typing only in Workbench
  let focus: "deck" | "wb" = "deck";
  for (const e of [...s.entries].filter((x) => x.type === "keys").sort((a, b) => a.start - b.start)) {
    for (const tok of (e as any).keystrokes as string[]) {
      if (tok === "k:alt+tab") focus = focus === "deck" ? "wb" : "deck";
      else if (tok === "k:right" && focus !== "deck") err("focus", "k:right while Workbench has focus", e);
      else if ((tok.startsWith("t:") || tok.startsWith("m:move 1800")) && focus !== "wb") err("focus", "typing or Run while the deck has focus", e);
    }
  }

  // ── deck invariant
  if (opts.deck) {
    const rights = s.entries.filter((e) => e.type === "keys").reduce((n, e) => n + (e as any).keystrokes.filter((k: string) => k === "k:right").length, 0);
    const want = rights + 1;
    const got = opts.deck.slides + opts.deck.holds;
    if (got !== want)
      err("deck", `slides + held reveals (${opts.deck.slides} + ${opts.deck.holds} = ${got}) must equal k:right + 1 (${rights} + 1 = ${want})`);
  }

  return f;
}

export const checkText = (text: string, opts: CheckOptions = {}) => checkScript(parseScript(text).script, opts);
export const errorsOf = (f: Finding[]) => f.filter((x) => x.severity === "error");
