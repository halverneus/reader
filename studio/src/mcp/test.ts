// Regression tests for the script toolchain. `node dist/cli/metrik-test.js`.
//
// Every case here is something that actually went wrong once. The fragment
// cases are lines Jeromy flagged by hand; the "must pass" ones are lines an
// over-eager rule tried to rewrite, which is the more expensive failure.
import { verbless, runup, checkText, COURSEWORK, errorsOf } from "../shared/check";
import { Editor, replayText, SUSPICIOUS } from "../shared/wb";
import { keyStatus } from "../shared/keys";
import { cameraPlan, parseScript, serializeScript, splitMoodTags, speechChunks, validate, wrap70, rewrap, rewrapEntry, type Entry } from "../shared/script";
import { applyGestures, GESTURES, gestureNames, gestureLength, holdAt, HOME } from "../../glitch/dev-hands-data";
import { markerDiff } from "../shared/diff";
import { crossRepeats } from "../shared/across";
import { MOODS, MOOD_NAMES } from "../../glitch/moods";
import { COLD_OPEN_FIRST_WORD, COLD_OPEN_AT, FPS, firstSpeechStart, lastSpeechEnd, openerTrim, voiceSpans, type Span } from "../shared/timeline";

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

group("repetition across lessons");
{
  const lesson = (lines: string[]) => ({
    script: parseScript(`script:
- type: "editor"
  start: 100
  end: 200
  text: "Roll Intro"
` + lines.map((t, i) => `- type: "line"
  actor: "Dev"
  start: ${(i + 2) * 100}
  end: ${(i + 3) * 100}
  text: ${JSON.stringify(t)}
`).join("")).script,
  });
  const demo = "Let's take all of this onto a real server and see what it does.";
  const a = { name: "06", ...lesson([demo, "The archive has two rows in it today."]) };
  const b = { name: "07", ...lesson([demo, "A derived table needs a name of its own."]) };
  const c = { name: "08", ...lesson(["Nothing at all in common with the others here."]) };

  const r = crossRepeats([a, b, c]);
  ok(r.length === 1, "the shared demo opener is the only thing reported", `got ${r.length}`);
  ok(r[0].kind === "exact", "an identical sentence is reported as exact");
  ok(r[0].at.map((x) => x.lesson).join() === "06,07", "and it names both lessons");
  ok(crossRepeats([a]).length === 0, "one lesson on its own can repeat nothing");
  // the same sentence twice INSIDE one lesson is checkScript's job, not this one
  ok(crossRepeats([{ name: "06", ...lesson([demo, demo]) }]).length === 0,
     "a repeat within a single lesson is not a cross-lesson formula");
  // a catchphrase is meant to recur
  const d1 = { name: "06", ...lesson(["Don't just watch it... Do it, and do it today!"]) };
  const d2 = { name: "07", ...lesson(["Don't just watch it... Do it, and do it today!"]) };
  ok(crossRepeats([d1, d2]).length === 0, "a catchphrase is exempt");
}

group("a diff reports field changes, not only text");
{
  const one = (mood: string) => `script:
- type: "editor"
  start: 100
  end: 200
  text: "Roll Intro"
- type: "line"
  actor: "Glitch"
  start: 200
  end: 300
  auto: true
  mood: ${JSON.stringify(mood)}
  text: "Two rows came back."
`;
  const d = markerDiff(parseScript(one("thinking")).script, parseScript(one("neutral")).script);
  ok(d.changed.join() === "200", "a mood-only change is a change");
}

group("swapping real Dev for the drawn one");
{
  const scr = (...swaps: string[]) => `script:
- type: "editor"
  start: 100
  end: 200
  text: "Roll Intro"
- type: "line"
  actor: "Dev"
  start: 200
  end: 300
  text: "The inner query runs first and hands its answer up."
${swaps.join("\n")}`;
  const sw = (start: number, to: string, extra = "") => `- type: "avatar"
  start: ${start}
  end: ${start + 100}
  to: "${to}"${extra ? "\n" + extra : ""}`;
  const avatar = (t: string) => checkText(t).filter((x) => x.rule === "avatar");

  // the round trip survives a save
  const rt = parseScript(scr(sw(300, "avatar", "  over: 1500"))).script;
  const back = parseScript(serializeScript(rt)).script;
  const e = back.entries.find((x) => x.type === "avatar") as any;
  ok(e && e.to === "avatar" && e.over === 1500, "an avatar swap round-trips through save and load");

  ok(avatar(scr(sw(300, "avatar"), sw(400, "real"))).length === 0, "on then off is clean");
  ok(avatar(scr(sw(300, "avatar"), sw(400, "avatar"))).some((x) => /already on/.test(x.msg)), "switching the avatar on twice is flagged");
  ok(avatar(scr(sw(300, "real"))).some((x) => /never switched in/.test(x.msg)), "returning to camera without a swap is flagged");

  // a hand-written Dev face on the swap marker loses to the renderer
  const clash = scr(sw(300, "avatar")) + `
- type: "face"
  actor: "Dev"
  start: 300
  end: 400
  mood: "curious"`;
  ok(avatar(clash).some((x) => /overwritten/.test(x.msg)), "a Dev face on the swap marker is flagged as overwritten");

  // Dev faces are a separate channel from the moods that cue Glitch
  const two = parseScript(`script:
- type: "face"
  start: 100
  end: 200
  mood: "curious"
- type: "face"
  actor: "Dev"
  start: 100
  end: 200
  mood: "smug"`).script;
  const faces = two.entries.filter((x) => x.type === "face") as any[];
  ok(faces.length === 2 && faces.filter((f) => f.actor === "Dev").length === 1 && faces.filter((f) => !f.actor).length === 1,
     "a Dev face and a Glitch face coexist on one marker");
}

group("a face either flinches or it settles");
{
  const face = (mood: string, hold: number | null) => `script:
- type: "editor"
  start: 100
  end: 200
  text: "Roll Intro"
- type: "line"
  actor: "Dev"
  start: 200
  end: 300
  text: "The inner query runs first and hands its answer up."
- type: "face"
  start: 200
  end: 300
  mood: "${mood}"
  delay: 2000
${hold === null ? "" : `  hold: ${hold}\n`}`;
  const held = (mood: string, hold: number | null) => checkText(face(mood, hold)).filter((x) => x.rule === "face-hold");

  ok(held("curious", 2500).length === 1, "a hold on a settled face is flagged");
  ok(held("thinking", 2500).length === 1, "thinking is a listening expression, not a flinch");
  ok(held("curious", null).length === 0, "no hold, nothing to say");
  ok(held("malice", 900).length === 0, "the mask slipping is meant to snap back");
  ok(held("surprise", 900).length === 0, "a jolt is meant to snap back");
  ok(held("curious", 2500)[0].severity === "advice", "it is advice: a deliberate hold is still allowed");
}

group("the cold open belongs to whoever speaks first");
{
  // Every script through Week 05 opened on Dev, so "the first word" and "Dev's
  // first word" were the same thing. W06L06 opens on Glitch, talking over the
  // top of the lesson while Dev is still silent.
  const landsAt = (word: number) => {
    const t = openerTrim(word, FPS)!;
    // where the first word ends up on the timeline, in seconds
    return (Math.round(FPS * COLD_OPEN_AT) + t.pad + Math.round(FPS * (word - t.src0))) / FPS;
  };
  const near = (a: number, b: number) => Math.abs(a - b) < 1 / FPS;

  ok(openerTrim(undefined, FPS) === null, "a silent opener is left where it is");
  ok(near(landsAt(4.3), COLD_OPEN_FIRST_WORD), "Dev takes a breath first: the wait before him is trimmed off");
  ok(near(landsAt(2.9), COLD_OPEN_FIRST_WORD), "Glitch starts a quarter second after the marker and lands in the same place");
  ok(openerTrim(4.3, FPS)!.pad === 0, "a recording with lead-in to spare needs no padding");

  // a TTS opener can speak almost immediately, where a human cannot. If the
  // source cannot give the lead-in, the opener moves instead of the word.
  const tight = openerTrim(0.4, FPS)!;
  ok(tight.src0 === 0, "there is nothing before the start of the file to trim");
  ok(tight.pad > 0, "the lead-in the recording is short of becomes padding");
  ok(near(landsAt(0.4), COLD_OPEN_FIRST_WORD), "so the first word still clears the thumbnail");

  // mic spans and TTS spans go into one pool and are then indistinguishable
  const mic: Span[] = [[9.0, 10.5]];
  const glitch: Span[] = voiceSpans(3.0, 4200);
  ok(glitch.length === 1 && glitch[0][0] === 3.0, "a gapless line is one span from the moment it was heard");
  ok(firstSpeechStart([...mic, ...glitch], 2.5, 20) === 3.0, "Glitch speaking first makes Glitch the first word");
  ok(firstSpeechStart([...glitch, ...mic], 2.5, 20) === 3.0, "and the pooling order does not decide it");
  ok(lastSpeechEnd([...mic, ...glitch], 2.5, 20) === 10.5, "the last word is Dev's, because he finishes later");

  // a line that opens or closes on a [pause] must not drag the boundaries
  const lead = voiceSpans(3.0, 4200, [[0, 800]]);
  ok(lead.length === 1 && lead[0][0] === 3.8, "a leading pause is silence, not the first word");
  const trail = voiceSpans(3.0, 4200, [[3400, 4200]]);
  ok(trail.length === 1 && trail[0][1] === 6.4, "a trailing pause is silence, not the last word");
  const mid = voiceSpans(3.0, 4200, [[1000, 1500]]);
  ok(mid.length === 2 && mid[0][1] === 4.0 && mid[1][0] === 4.5, "a pause in the middle splits the line in two");
  ok(firstSpeechStart(voiceSpans(3.0, 4200, [[0, 800]]), 0, 20) === 3.8, "and the opener trims to the word, not to the clip");
}

group("the new expressions, and spending them");
{
  for (const m of ["skeptical", "dawning", "unimpressed", "eyeroll", "cringe"])
    ok(MOOD_NAMES.includes(m), `${m} is in the library`);

  // each new face has to be distinguishable from the one it was carved out of,
  // or it is another name for a face Glitch already has
  const e = (m: string) => MOODS[m].expr as any;
  ok(e("skeptical").asym > .9 && (e("skeptical").mouthCurve ?? 0) < 0, "skeptical is one brow up over a flat mouth, not smug's smirk");
  ok((e("skeptical").smirk ?? 0) < (e("smug").smirk ?? 0), "and it is not just smug by another name");
  ok(e("dawning").pupil > 1 && e("surprise").pupil < 1, "dawning dilates where surprise contracts: it lands, it does not jolt");
  ok(e("dawning").reach > e("surprise").reach, "dawning leans in, surprise pulls back");
  ok((e("unimpressed").lookX ?? 0) === 0 && e("bored").lookX > .5, "unimpressed is still looking at you; bored has looked away");
  ok((e("unimpressed").browA ?? 0) === 0 && e("annoyed").browA > 0, "and it carries none of annoyed's irritation");
  ok(e("eyeroll").lookY <= -1, "the eyes actually go up");
  ok(e("cringe").mouthW > 1.2 && e("cringe").mouthCurve < 0, "cringe is a grimace, wide and down");
  ok(e("cringe").asym > .5 && e("cringe").tilt < 0, "half the face shuts and the head pulls away");
  ok(e("cringe").lift > 0 && e("hurt").lift < 0, "cringe braces; hurt droops. One watches, the other was hit");

  const face = (mood: string, hold: number | null) => `script:
- type: "editor"
  start: 100
  end: 200
  text: "Roll Intro"
- type: "line"
  actor: "Dev"
  start: 200
  end: 300
  text: "The inner query runs first and hands its answer up."
- type: "face"
  start: 200
  end: 300
  mood: "${mood}"
  delay: 2000
${hold === null ? "" : `  hold: ${hold}\n`}`;
  const held = (m: string, h: number | null) => checkText(face(m, h)).filter((x) => x.rule === "face-hold");
  ok(held("eyeroll", 900).length === 0, "an eye roll is meant to snap back");
  ok(held("eyeroll", null).length === 1, "and held, it is a stare at the ceiling");
  ok(held("cringe", 900).length === 0, "a wince is meant to snap back too");
  ok(held("cringe", null).length === 1, "and held, it is a face stuck that way");
  ok(held("skeptical", 2500).length === 1, "skeptical settles, so a hold on it is still a twitch");
  ok(held("unimpressed", null).length === 0, "a deadpan with no hold is exactly right");

  // one face doing all the work
  const many = (mood: string, n: number) => `script:
- type: "editor"
  start: 100
  end: 200
  text: "Roll Intro"
${Array.from({ length: n }, (_, i) => `- type: "line"
  actor: "Glitch"
  start: ${(i + 2) * 100}
  end: ${(i + 3) * 100}
  auto: true
  mood: "${i < n - 6 ? mood : MOOD_NAMES[(i % 9) + 2]}"
  text: "The inner query runs first and then hands its answer up."`).join("\n")}`;
  const spread = (t: string) => checkText(t).filter((x) => x.rule === "mood-spread");
  ok(spread(many("thinking", 30)).length === 1, "a script leaning on one face is flagged");
  ok(spread(many("thinking", 30))[0].severity === "advice", "as advice: it is a nudge, not a defect");
  ok(spread(many("thinking", 10)).length === 0, "a short script has too few cues to judge");
}

// ── the wrap button in a slot ───────────────────────────────────────────────
group("re-flowing a cell to 70 columns");
{
  const long = "The inner query runs first, hands its one answer up to the outer query, and the outer query compares every row against it.";
  const lines = (t: string) => t.split("\n");

  ok(lines(rewrap(long)).every((l) => l.length <= 70), "every line comes back inside 70 columns");
  ok(rewrap(long).replace(/\s+/g, " ") === long, "and not one word is lost or reordered");
  ok(lines(rewrap(long)).length === 2, "it fills each line rather than breaking early");

  // the one break in a cell that is HIS, not the wrapper's
  const para = "Run it once and look at the row count.\n\nNow change the operator and run it again.";
  ok(rewrap(para).includes("\n\n"), "a blank line between two thoughts survives the re-flow");
  ok(rewrap(para) === para, "and short paragraphs are left exactly as they were");
  ok(rewrap("a\n\n\n\nb") === "a\n\nb", "a run of blank lines collapses to one break");

  // soft breaks are the wrapper's own and may be moved
  ok(rewrap("The inner query runs\nfirst and then hands\nits answer up.") === "The inner query runs first and then hands its answer up.",
    "single newlines are wrapping, so they re-flow into one line");

  // wrap70 used to emit a leading blank line for a word it could not fit,
  // which the slot button made reachable where the outro builder never did
  const huge = "x".repeat(80);
  ok(wrap70(huge) === huge, "an unbreakable word goes on its own line, with no blank line before it");
  ok(wrap70("ok " + huge) === "ok\n" + huge, "and the words before it still get their own line");

  ok(rewrap("") === "" && rewrap("   ") === "", "empty stays empty");

  // entry-level: identity is the signal that nothing needed doing
  const line = { id: "a", type: "line", actor: "Glitch", start: 100, end: 200, text: long } as Entry;
  const short = { id: "b", type: "line", actor: "Dev", start: 200, end: 300, text: "Run it." } as Entry;
  const keys = { id: "c", type: "keys", start: 300, end: 400, keystrokes: ["t:SELECT * FROM sale WHERE total > 20 AND barista_id = 3 AND shop_id = 1;", "k:enter"] } as Entry;
  ok(rewrapEntry(short) === short, "an entry already inside 70 columns comes back as the same object");
  ok(rewrapEntry(line) !== line && (rewrapEntry(line) as any).text.includes("\n"), "an over-long line is re-flowed");
  ok(rewrapEntry(keys) === keys, "keystrokes are never re-flowed: a line break there is a step, not a wrap");

  const outro = { id: "d", type: "outro", start: 500, end: 600, phases: [{ phase: "thanks", text: long }] } as Entry;
  ok((rewrapEntry(outro) as any).phases[0].text.split("\n").length === 2, "an outro phase spelled out in the script is re-flowed too");
  const bare = { id: "e", type: "outro", start: 500, end: 600 } as Entry;
  ok(rewrapEntry(bare) === bare, "an outro on its defaults is left alone rather than materialised");
}

group("a botched keystroke count, and what is not one");
{
  // W06L08 sets the session time zone and then selects in the SAME Run: two
  // statements is the demonstration, not a mistake. `;\s*\S` called both of
  // those runs botched, which is how a real defect two markers away went
  // unnoticed (2026-10-28).
  ok(!SUSPICIOUS.test("SET time_zone = '+00:00';\nSELECT booked_at\nFROM appointments;"),
     "a second statement on the next line is not a botched edit");
  ok(!SUSPICIOUS.test("SELECT a FROM t;"), "one clean statement is not flagged");
  ok(!SUSPICIOUS.test("SELECT a FROM t;\n"), "nor is a trailing newline");

  ok(SUSPICIOUS.test("SELECT a FROM t; x"), "junk after the semicolon on the same line still is");
  ok(SUSPICIOUS.test("SELECT f(a);)"), "so is a paren the backspaces failed to eat");
  ok(SUSPICIOUS.test("SELECT f(a) ;"), "so is a space the cursor left behind the semicolon");
  ok(SUSPICIOUS.test("SELECT f(g(a))"), "so is an auto-closed paren nobody removed");
}

group("what the camera is still for");
{
  const scr = (...extra: string[]) => parseScript(`script:
- type: "line"
  actor: "Dev"
  start: 200
  end: 300
  text: "Greetings."
${extra.join("\n")}`).script;
  const sw = (start: number, to: string) => `- type: "avatar"
  start: ${start}
  end: ${start + 100}
  to: "${to}"`;

  const none = cameraPlan(scr());
  ok(none.srcs.length === 3 && none.dropAtMarker == null, "a script with no swap films everything, start to end");

  const once = cameraPlan(scr(sw(300, "avatar")));
  ok(once.srcs.length === 3, "a script that starts on camera still needs the camera");
  ok(once.dropAtMarker === 300, "and the camera and mic end at the swap");

  const back = cameraPlan(scr(sw(300, "avatar"), sw(500, "real")));
  ok(back.dropAtMarker == null, "a script that returns to camera keeps both to the end");

  const again = cameraPlan(scr(sw(300, "avatar"), sw(500, "real"), sw(700, "avatar")));
  ok(again.dropAtMarker === 700, "with a return and a second swap, the LAST swap is the one that ends them");

  const all = parseScript(`script:
- type: "avatar"
  start: 100
  end: 200
  to: "avatar"
- type: "line"
  actor: "Dev"
  start: 200
  end: 300
  text: "Greetings."
`).script;
  ok(cameraPlan(all).srcs.join() === "desktop", "drawn before the first line: the camera never comes on");
  ok(cameraPlan(all).dropAtMarker == null, "and there is nothing to drop part way");
}

group("avatar Dev's hands");
{
  const line = (actor: string, text: string) => `script:
- type: "line"
  actor: "${actor}"
  start: 100
  end: 200
  text: ${JSON.stringify(text)}
`;
  const t = splitMoodTags("[hand greeting] Greetings. [pause 300] I am Dev the Developer.");
  ok(t.hands.length === 1 && t.hands[0].hand === "greeting", "[hand greeting] is lifted out as a gesture cue");
  ok(!/hand|\[/.test(t.clean), "and it leaves no trace in the spoken text");
  ok(t.hands[0].charIndex === 0, "a leading tag sits on the first character");
  ok(speechChunks("[hand signoff] Do it!")[0].text === "Do it!", "the synthesiser never sees the tag");

  const mid = splitMoodTags("Do not just watch it. [hand signoff] Do it!");
  ok(mid.hands[0].charIndex === mid.clean.indexOf("Do it!"), "a mid-line tag lands on the word it sat on");

  // the mood channel is untouched by the new tag
  const both = splitMoodTags("[humor] Ha. [hand greeting] Hello.");
  ok(both.cues.length === 1 && both.cues[0].mood === "humor", "moods and hands are separate channels");

  ok(validate(parseScript(line("Dev", "[hand greeting] Hello.")).script).length === 0, "a known gesture on a Dev line is clean");
  ok(validate(parseScript(line("Dev", "[hand waggle] Hello.")).script).some((x) => /unknown gesture/.test(x.msg)), "an invented gesture is flagged");
  ok(validate(parseScript(line("Glitch", "[hand greeting] Hello.")).script).some((x) => /no hands/.test(x.msg)), "Glitch cannot gesture");
  ok(validate(parseScript(line("Dev", "[hand home] Hello.")).script).length === 0, "[hand home] is the reserved release and is always valid");
  ok(validate(parseScript(line("Dev", "[hand two] Second.")).script).length === 0, "a counting gesture is valid");

  // a Dev face is the avatar's own; rebuilding the entry used to silently
  // hand it to Glitch, which is a change nobody would see until the render
  const f = parseScript(`script:
- type: "face"
  actor: "Dev"
  start: 100
  end: 200
  mood: "humor"
`).script;
  ok((f.entries[0] as any).actor === "Dev", "a face can belong to Dev");
  ok(/actor: Dev/.test(serializeScript(f)), "and it survives a save");

  ok(gestureNames().includes("greeting") && gestureNames().includes("signoff"), "both of his standing moves are present");

  // what he authors in the Gestures tab is saved beside the config, and only
  // the parts that differ from the shipped table are kept
  {
    const mine = { wave_hi: { label: "a test one", hold: 1, keys: [
      { t: 0, p: { ...HOME } },
      { t: .5, p: { ua: 16, fa: 18, len: 360, rot: 8, scale: 1.9, shape: "palm", vis: 1 } },
      { t: 1.5, p: { ...HOME } }] } };
    applyGestures(mine as any);
    ok(gestureNames().includes("wave_hi"), "one of his own joins the table");
    ok(gestureNames().includes("one"), "and the built-ins are still there");
    ok(validate(parseScript(`script:
- type: "line"
  actor: "Dev"
  start: 100
  end: 200
  text: "[hand wave_hi] Hello."
`).script).length === 0, "so a script can name it");
    const retuned = { one: { ...GESTURES.one, label: "changed" } };
    applyGestures(retuned as any);
    ok(GESTURES.one.label === "changed", "a built-in can be retuned by name");
    ok(!gestureNames().includes("wave_hi"), "and applying a new set replaces the old one rather than piling up");
    applyGestures({});
    ok(GESTURES.one.label !== "changed", "clearing it puts the shipped version back");
  }
  ok(gestureLength("greeting") > 3 && gestureLength("signoff") > 3, "each runs long enough to cover its line");
  ok(gestureLength("nope") === 0, "an unknown gesture has no length, so it never holds the arm up");

  // the counting shapes and the other held states
  ok(holdAt("greeting") === null && holdAt("signoff") === null, "the two timed clips play straight through");
  ok(holdAt("one") != null && holdAt("two") != null, "counting gestures stop and wait instead");
  for (const [name, g] of Object.entries(GESTURES)) {
    const k = g.keys;
    ok(k.length >= 2, `${name} has keyframes`);
    ok(k.every((x, i) => i === 0 || x.t > k[i - 1].t), `${name}'s keyframes move forward in time`);
    ok(k[0].p.vis === 0 && k[k.length - 1].p.vis === 0, `${name} starts and ends off frame`);
    if (g.hold != null) {
      ok(g.hold > 0 && g.hold < k.length - 1, `${name}'s hold is a middle keyframe, with a way back after it`);
      ok(k[g.hold].p.vis > 0, `${name} holds with the hand actually visible`);
    }
    ok(g.label.length > 10, `${name} says what it is for`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
