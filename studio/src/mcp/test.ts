// Regression tests for the script toolchain. `node dist/cli/metrik-test.js`.
//
// Every case here is something that actually went wrong once. The fragment
// cases are lines Jeromy flagged by hand; the "must pass" ones are lines an
// over-eager rule tried to rewrite, which is the more expensive failure.
import { verbless, runup, checkText, COURSEWORK, errorsOf } from "../shared/check";
import { Editor, replayText } from "../shared/wb";
import { keyStatus } from "../shared/keys";
import { parseScript, serializeScript } from "../shared/script";
import { markerDiff } from "../shared/diff";

let pass = 0, fail = 0;
const ok = (cond: boolean, label: string, detail = "") => {
  if (cond) { pass++; return; }
  fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
};
const group = (s: string) => console.log(`\n${s}`);

// ── fragments ────────────────────────────────────────────────────────────────
group("fragments: must flag (all real lines Jeromy objected to)");
for (const t of [
  "Three coffee shops, four baristas, and a table of sales.",
  "Two scalar subqueries, one per column, joined with AND.",
  "One card, eight slips, one trip to the filing cabinet.",
  "Three rows, one per shop, and the scrawl is on this slide too.",
  "Same number of columns, wrong columns, and an empty result that looks like a true answer.",
  "Four patterns, and between them they cover most correlated subqueries you will ever write.",
  "Nine songs, three genres, three songs in each, and play counts that run from seventy five up.",
  "Not Betty, not Jughead, not an error, not a warning.",
  "Register four, in a chain with nine shops.",
]) ok(verbless(t) || runup(t), "flag", t);

group("fragments: must NOT flag (rewrites, and ordinary prose)");
for (const t of [
  "We have three coffee shops, four baristas, and a table of sales.",
  "A sale belongs to a location and a barista together, and neither one identifies anybody.",
  "The server picked a side and wrote it down, and you can change which side it picked.",
  "And now the last one, which is the year twenty thirty eight.",
  "Before you continue on to the next video, try writing a row subquery of your own.",
  "I cannot argue with your logic.",
  "Three reasons. 1. Harbor collides. 2. No index. And 3. numbers sort wrong.",
  "Nobody checks a number that does not change.",
  "Let's take all of this onto a real server.",
  "The Harbor pair lost at the second column.",
  "One character of difference decides the whole comparison.",
]) ok(!(verbless(t) || runup(t)), "pass", t);

group("fragments: questions have their own grammar");
for (const t of [
  "Why not the invoices?",
  "Why those two words?",
  "For each shop, how many sales does that shop have?",
  "Four hundred twenty, two hundred, one hundred fifty, and so on?",
  "How would anybody ever find that?",
]) ok(!(verbless(t) || runup(t)), "pass", t);
// but the same noun stack as a statement is still the thing he objects to
ok(verbless("Four hundred twenty, two hundred, one hundred fifty, and so on."),
   "flag", "the same list as a statement");

// ── coursework, two tiers ────────────────────────────────────────────────────
group("coursework: hard tier must fire");
for (const t of [
  "Your assignment this week is to write three of these.",
  "The grader will run this against your repository.",
  "We covered that back in Week 8.",
  "This is due before the midterm.",
  "In Lesson 5 we will come back to it.",
  "Anyone taking CS235 has seen this table.",
  "Check the syllabus for the exact wording.",
  "Next week we pick this back up.",
]) ok(COURSEWORK.test(t), "hard", t);

group("coursework: must NOT fire (the rule is about references, not words)");
for (const t of [
  "In this lesson, the subquery gives back a single value.",
  "It has a lesson of its own coming up.",
  "You can add an interval of a week to any date.",
  "A class in C# is a blueprint for an object.",
  "Of course the server has an opinion about that.",
  "Nobody checked for a quarter.",
  "The hard lesson here is that silence is not an answer.",
]) ok(!COURSEWORK.test(t), "soft", t);

// ── the Workbench editor ─────────────────────────────────────────────────────
group("workbench editor");
{
  const e = new Editor();
  e.type("SELECT max(x");
  ok(e.text() === "SELECT max(x)", "auto-close inserts )", JSON.stringify(e.text()));
  e.type(")");
  ok(e.text() === "SELECT max(x)", "typing ) overtypes the pending one", JSON.stringify(e.text()));
}
{
  // after Enter the pending close becomes a literal that rides to the end
  const e = new Editor();
  e.type("WHERE a = (SELECT b");
  e.key("enter");
  e.type("FROM t;");
  ok(e.text().endsWith(";)"), "a pending ) survives Enter and lands at the end", JSON.stringify(e.text()));
}
{
  // two home presses to reach column zero
  const e = new Editor();
  e.type("    indented");
  e.key("home");
  ok(e.c === 4, "first home stops at the indent", `c=${e.c}`);
  e.key("home");
  ok(e.c === 0, "second home reaches column zero", `c=${e.c}`);
}
{
  const e = new Editor();
  e.type("one");
  e.key("enter"); e.type("two");
  e.key("enter"); e.type("three");
  e.key("shift+up"); e.key("shift+up"); e.key("shift+home"); e.key("shift+home");
  e.type("ONE");
  ok(e.text() === "ONE", "shift+up extends one line per press", JSON.stringify(e.text()));
}
ok(keyStatus("ctrl+shift+up") === "verified", "ctrl+shift+up verified from the W06 L03 recording");
ok(keyStatus("nonsense+key") === "unknown", "an unlisted key is unknown");

// ── round trip ───────────────────────────────────────────────────────────────
group("parse/serialize round trip");
{
  const src = `script:

- type: "line"
  actor: "Dev"
  start: 100
  end: 200
  text: "Greetings! I'm Dev the Developer!"

- type: "editor"
  start: 200
  end: 300
  text: "Roll Intro"

- type: "keys"
  start: 300
  end: 400
  keystrokes:
    - k:right
`;
  const a = parseScript(src).script;
  const b = parseScript(serializeScript(a)).script;
  ok(JSON.stringify(a.entries.map(({ id, ...e }) => e)) === JSON.stringify(b.entries.map(({ id, ...e }) => e)), "entries survive a round trip");
}

// ── whole-script checks ──────────────────────────────────────────────────────
group("script checks");
{
  const noIntro = `script:
- type: "line"
  actor: "Dev"
  start: 100
  end: 200
  text: "Greetings! I'm Dev the Developer!"
- type: "keys"
  start: 200
  end: 300
  keystrokes:
    - k:right
`;
  const f = errorsOf(checkText(noIntro));
  ok(f.some((x) => x.rule === "roll-intro"), "a script with no Roll Intro is an error");
}
{
  const badKey = `script:
- type: "editor"
  start: 100
  end: 200
  text: "Roll Intro"
- type: "keys"
  start: 200
  end: 300
  keystrokes:
    - k:alt+tab
    - k:ctrl+shift+left
`;
  ok(errorsOf(checkText(badKey)).some((x) => x.rule === "keys"), "an unmodelled keystroke is an error");
}
{
  const twoKeys = `script:
- type: "editor"
  start: 100
  end: 200
  text: "Roll Intro"
- type: "keys"
  start: 200
  end: 300
  keystrokes: ["k:escape"]
- type: "keys"
  start: 200
  end: 300
  keystrokes: ["k:escape"]
`;
  ok(errorsOf(checkText(twoKeys)).some((x) => x.rule === "marker"), "two keys entries on one marker is an error");
}
{
  const brit = `script:
- type: "editor"
  start: 100
  end: 200
  text: "Roll Intro"
- type: "line"
  actor: "Glitch"
  start: 200
  end: 300
  auto: true
  text: "Yellow is a common colour for a rendering fault."
`;
  ok(errorsOf(checkText(brit)).some((x) => x.rule === "spelling"), "a British spelling is an error");
}
{
  // advice must never be promoted to an error: that is what makes an agent
  // rewrite the user's own sentences
  const advisory = `script:
- type: "editor"
  start: 100
  end: 200
  text: "Roll Intro"
- type: "line"
  actor: "Dev"
  start: 200
  end: 300
  text: "Three coffee shops, four baristas, and a table of sales."
`;
  const f = checkText(advisory);
  ok(f.some((x) => x.rule === "fragment" && x.severity === "advice"), "a fragment is advice");
  ok(!errorsOf(f).some((x) => x.rule === "fragment"), "a fragment is never an error");
}

// ── replay ───────────────────────────────────────────────────────────────────
group("replay");
{
  const s = `script:
- type: "editor"
  start: 100
  end: 200
  text: "Roll Intro"
- type: "keys"
  start: 200
  end: 300
  keystrokes:
    - k:alt+tab
    - "t:SELECT 1;"
    - m:move 1800,85
    - m:click
`;
  const { runs, unknown } = replayText(s);
  ok(runs.length === 1 && runs[0].sql === "SELECT 1;", "a Run click captures the buffer", JSON.stringify(runs));
  ok(unknown.length === 0, "no unknown keys");
}

// ── ALL-CAPS in a spoken line ───────────────────────────────────────────────
group("caps in Glitch's lines");
{
  const g = (text: string) => `script:
- type: "editor"
  start: 100
  end: 200
  text: "Roll Intro"
- type: "line"
  actor: "Glitch"
  start: 200
  end: 300
  auto: true
  text: ${JSON.stringify(text)}
`;
  const caps = (text: string) => errorsOf(checkText(g(text))).filter((x) => x.rule === "caps");
  ok(caps("IN can stop early and NOT IN cannot.").length === 1, "a bare keyword in capitals is an error");
  ok(caps('That means "in" can stop early and "not in" cannot.').length === 0, "quoted and lowercase is the fix");
  ok(caps("It says the line item's invoice ID equals the outer invoice's ID.").length === 0, "ID stays uppercase: it is deliberate");
  ok(caps("Two is different from NULL, so nothing comes back.").length === 1, "NULL is NOT exempt; the house style is lowercase");
  ok(caps("The optimizer knows the answer.").length === 0, "ordinary prose passes");
  // Dev reads his own lines, so capitals there are emphasis, not a defect
  const devCaps = `script:
- type: "editor"
  start: 100
  end: 200
  text: "Roll Intro"
- type: "line"
  actor: "Dev"
  start: 200
  end: 300
  text: "NOT IN has one correct fix and this is it."
`;
  ok(errorsOf(checkText(devCaps)).filter((x) => x.rule === "caps").length === 0, "Dev may use capitals: he reads his own lines");
}

// ── marker diff (what the live GUI update highlights) ───────────────────────
group("marker diff");
{
  const base = `script:
- type: "editor"
  start: 100
  end: 200
  text: "Roll Intro"
- type: "line"
  actor: "Dev"
  start: 200
  end: 300
  text: "One."
- type: "line"
  actor: "Glitch"
  start: 200
  end: 300
  auto: true
  text: "Two."
- type: "line"
  actor: "Dev"
  start: 300
  end: 400
  text: "Three."
`;
  const a = parseScript(base).script;

  ok(markerDiff(a, parseScript(base).script).touched.length === 0, "a script is identical to itself");

  // reformatting alone must not register: Studio rewraps on save, and a diff
  // that fires on a rewrap is a diff nobody reads
  ok(markerDiff(a, parseScript(serializeScript(a)).script).touched.length === 0, "a save round trip is not a change");

  const edited = parseScript(base.replace('"Three."', '"Three, with more on the end."')).script;
  const d1 = markerDiff(a, edited);
  ok(d1.changed.join() === "300" && !d1.added.length && !d1.removed.length, "an edited line reports only its own marker", JSON.stringify(d1.touched));

  // two lines share marker 200: changing one must not implicate the other
  const oneOfTwo = parseScript(base.replace('"Two."', '"Two, said differently."')).script;
  const d2 = markerDiff(a, oneOfTwo);
  ok(d2.changed.join() === "200" && d2.details.length === 1 && (d2.details[0].entry as any).actor === "Glitch",
     "only the Glitch line at a shared marker is reported", JSON.stringify(d2.details.map((x) => [x.kind, x.marker])));

  const dropped = parseScript(base.replace(/- type: "line"\n  actor: "Dev"\n  start: 300[\s\S]*$/, "")).script;
  const d3 = markerDiff(a, dropped);
  ok(d3.removed.join() === "300" && !d3.changed.length, "a removed entry reports its marker", JSON.stringify(d3));
  ok(markerDiff(dropped, a).added.join() === "300", "and the reverse reports it as added");
}

// ── devices the author meant: interruptions and the echo joke ──────────────
group("deliberate devices are not defects");
{
  const head = `script:
- type: "editor"
  start: 100
  end: 200
  text: "Roll Intro"
`;
  const line = (start: number, actor: string, text: string) => `- type: "line"
  actor: ${JSON.stringify(actor)}
  start: ${start}
  end: ${start + 100}${actor === "Glitch" ? "\n  auto: true" : ""}
  text: ${JSON.stringify(text)}
`;
  const rule = (text: string, r: string) => checkText(text).filter((x) => x.rule === r);

  // an interrupted line is cut off on purpose; the ellipsis says so
  ok(rule(head + line(200, "Glitch", "And for the second one the clerk..."), "fragment").length === 0,
     "a line cut off mid-sentence is not a fragment");
  ok(rule(head + line(200, "Glitch", "...and about fifty examples of nothing in particular."), "fragment").length === 0,
     "a line resuming after an interruption is not a fragment");
  ok(rule(head + line(200, "Glitch", "Three coffee shops, four baristas, and a table of sales."), "fragment").length === 1,
     "an ordinary fragment is still caught");

  // Dev says it, Glitch says it straight back: that is the joke
  ok(rule(head + line(200, "Dev", "There are three rows on this slide.") +
          line(300, "Glitch", "There are three rows on that slide."), "repetition").length === 0,
     "the next line echoing the previous speaker is the running joke");
  ok(rule(head + line(200, "Dev", "There are three rows on this slide.") +
          line(300, "Glitch", "The optimizer has made a choice.") +
          line(400, "Dev", "There are three rows on that slide."), "repetition").length === 1,
     "the same opener two lines apart is still repetition");
  ok(rule(head + line(200, "Dev", "There are three rows on this slide.") +
          line(300, "Dev", "There are three rows on that slide."), "repetition").length === 1,
     "one speaker repeating himself back to back is not the joke");
}

group("an entry may not run past the next marker");
{
  const overlap = `script:
- type: "editor"
  start: 100
  end: 200
  text: "Roll Intro"
- type: "line"
  actor: "Dev"
  start: 200
  end: 400
  text: "The outer query asks for a count."
- type: "line"
  actor: "Glitch"
  start: 300
  end: 400
  auto: true
  text: "And the inner one answers it."
`;
  ok(errorsOf(checkText(overlap)).filter((x) => x.rule === "span").length === 1,
     "a Dev line spanning a newly inserted Glitch marker is caught");
  ok(errorsOf(checkText(overlap.replace("  end: 400\n  text: \"The outer", "  end: 300\n  text: \"The outer"))).filter((x) => x.rule === "span").length === 0,
     "ending at the new marker is correct");
}

{
  // closeGapBefore is what keeps the above from ever being written
  const { parseScript: ps, closeGapBefore: cg } = require("../shared/script");
  const sc = ps(`script:
- type: "line"
  actor: "Dev"
  start: 100
  end: 300
  text: "One."
- type: "line"
  actor: "Glitch"
  start: 200
  end: 300
  auto: true
  text: "Two."
`).script;
  cg(sc, 200);
  ok(sc.entries.find((e: any) => e.start === 100).end === 200, "closeGapBefore shortens the marker before");
  ok(sc.entries.find((e: any) => e.start === 200).end === 300, "and leaves the new one alone");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
