// Putting the guest VM into the state a lesson's script expects, between takes.
//
// A back-to-back run records lesson two's script against lesson one's slides
// unless something loads the right deck first, so this is what makes a batch a
// batch rather than a sequence of takes that happen to share an evening.
//
// Pure on purpose: the steps are a list of keystrokes in the vocabulary from
// keys.ts, handed to the same `keys:run` the scripts use, so they are testable
// without a VM and reviewable without running anything.

/** The guest URL of a lesson's deck, derived from the script's own path.
 *  `/…/Week 07/03 - Prepared Statements/Script.yml` with the default template
 *  gives `file:///Z:/Material/Week%2007/03%20-%20Prepared%20Statements/Slides.html#1`. */
export function deckUrlFor(scriptPath: string, template: string): string {
  const parts = scriptPath.split("/");
  const lesson = parts[parts.length - 2] ?? "", week = parts[parts.length - 3] ?? "";
  return template.replace("{week}", encodeURIComponent(week)).replace("{lesson}", encodeURIComponent(lesson));
}

/** Load this lesson's deck, fullscreen, on slide 1 with keyboard focus, and
 *  leave Workbench with an empty SQL tab.
 *
 *  Every step was run against the VM on 2026-11-03 before it was written down.
 *  Three things are worth knowing:
 *   - NO F11. The browser is already fullscreen and stays fullscreen across a
 *     navigation; pressing F11 would turn fullscreen off and put the Windows
 *     taskbar in the shot.
 *   - ctrl+L reaches Vivaldi's address bar even with its UI hidden.
 *   - The editor is emptied with ctrl+a and delete rather than opening a new
 *     tab: one tab for the whole week, and no shortcut nobody has verified.
 *
 *  It assumes the DECK has focus when it starts. That is what the end of every
 *  lesson leaves behind — the last keystroke of a script is k:right on the
 *  deck — and what the human setup produces. */
/** NOTE ON THE NOTATION: a step that parseStep does not recognise is TYPED,
 *  not rejected. The first version of this list said "combo:alt+tab" — there
 *  is no such prefix — and the whole sequence went into the Workbench editor
 *  as text while the recorder filmed it. `k:` with a plus is a combo. The test
 *  group "staging the guest between lessons" now parses every step. */
export function stageSteps(url: string): string[] {
  return [
    "k:escape",                     // drop autocomplete or a stray dialog
    "w:400",
    "k:alt+tab",                // → Workbench
    "w:1500",
    "m:move 350,310", "m:click",    // the SQL editor itself, measured
    "w:400",
    "k:ctrl+a", "k:delete",     // leave the tab empty for the next lesson
    "w:400",
    "k:alt+tab",                // → back to the deck
    "w:1500",
    "k:ctrl+l",                 // the address bar, UI hidden or not
    "w:800",
    `t:${url}`,
    "w:400",
    "k:enter",
    "w:4000",                       // let the deck load and settle
    "m:move 960,540", "m:click",    // keyboard focus, or k:right goes nowhere
    "w:400",
    "k:home",                       // slide 1 even if the hash did not take
    "w:800",
  ];
}
