// The authoritative keystroke vocabulary for `keys` entries.
//
// Why this file exists (2026-10-22): a script shipped with `k:ctrl+shift+up` in
// it and nothing noticed until the Workbench simulator crashed on an unknown
// key AFTER the lesson had been recorded. A key the simulator cannot model is a
// key whose on-screen effect nobody has verified, so it must be rejected when
// it is written, not discovered later.
//
// `status` is the honest part:
//   "verified"  - observed on the real target application
//   "modelled"  - the simulator implements it, nobody has confirmed the app agrees
//   "unknown"   - not in the vocabulary at all; writing it is an error

export type KeyStatus = "verified" | "modelled" | "unknown";

export interface KeyFact { key: string; status: KeyStatus; note: string }

/** Plain keys and combos the simulator understands. */
export const KEY_VOCABULARY: KeyFact[] = [
  { key: "escape", status: "verified", note: "Dismisses autocomplete. Required before every k:enter." },
  { key: "enter", status: "verified", note: "Newline. Carries the previous line's indent, and converts a pending auto-close ')' into a literal character." },
  { key: "tab", status: "modelled", note: "Inserts spaces to the next stop. Avoid: autocomplete steals it in Workbench." },
  { key: "backspace", status: "verified", note: "Deletes left, or the selection." },
  { key: "delete", status: "verified", note: "Deletes right, or the selection. Used to clear stray auto-close parens." },
  { key: "home", status: "verified", note: "TWO presses to reach column zero: the first stops at the first non-space character." },
  { key: "end", status: "verified", note: "End of the current line." },
  { key: "up", status: "verified", note: "Up one line, column clamped to that line's length." },
  { key: "down", status: "verified", note: "Down one line, column clamped." },
  { key: "left", status: "verified", note: "One character left." },
  { key: "right", status: "verified", note: "One character right. On the DECK this advances a slide; never send it while Workbench has focus." },
  { key: "shift+home", status: "verified", note: "Select to the indent, then to column zero on a second press." },
  { key: "shift+end", status: "modelled", note: "Select to end of line." },
  { key: "shift+up", status: "modelled", note: "Extend the selection up one line (SCI_LINEUPEXTEND). Prefer this over ctrl+shift+up." },
  { key: "shift+down", status: "modelled", note: "Extend the selection down one line." },
  { key: "shift+left", status: "modelled", note: "Extend one character left." },
  { key: "shift+right", status: "modelled", note: "Extend one character right." },
  { key: "ctrl+a", status: "verified", note: "Select all." },
  { key: "ctrl+home", status: "modelled", note: "Top of the buffer." },
  { key: "ctrl+end", status: "verified", note: "End of the buffer." },
  { key: "ctrl+left", status: "modelled", note: "Previous word." },
  { key: "ctrl+right", status: "modelled", note: "Next word." },
  { key: "ctrl+shift+up", status: "verified", note: "Extends the selection up ONE line per press. Workbench overrides Scintilla's default here (Scintilla's own Ctrl+Shift+Up is PARAUPEXTEND, extend to the previous blank-line paragraph, which would have selected to the top of the whole statement on the first press). Confirmed 2026-10-22 from the W06 L03 recording: three presses at marker 8800, correct statement, recorded in one take with no retake. shift+up is still the clearer thing to write." },
  { key: "ctrl+shift+down", status: "modelled", note: "Assumed to mirror ctrl+shift+up (one line per press), but never used in a recorded script. Prefer shift+down." },
  { key: "alt+tab", status: "verified", note: "Swap between the deck and the other window. Flips which one has focus." },
  { key: "super", status: "verified", note: "Opens the Windows Start menu over whatever is on screen; typing then searches it and enter launches the best match. Focus leaves the deck and does not come back without an alt+tab. Observed in the recording VM 2026-10-28, opening the MySQL command line client." },
  { key: "ctrl+shift+l", status: "verified", note: "Terminal.ClearBuffer in Windows Terminal, bound by hand in its settings.json. Clears the screen AND the scrollback so each statement's output is framed the same way. Not a default binding: if settings.json is ever reset this key does nothing and the demo merely scrolls. Observed in the recording VM 2026-10-28." },
  { key: "f7", status: "verified", note: "Navigation, per the recording rules." },
  { key: "f11", status: "verified", note: "Browser fullscreen for the deck." },
];

const BY_KEY = new Map(KEY_VOCABULARY.map((k) => [k.key, k]));

export const keyStatus = (key: string): KeyStatus => BY_KEY.get(key)?.status ?? "unknown";
export const keyNote = (key: string): string => BY_KEY.get(key)?.note ?? "not in the vocabulary";

/** A suggested replacement for a key that should not be used. */
export const KEY_REPLACEMENT: Record<string, string> = {
  "ctrl+shift+up": "shift+up",
  "ctrl+shift+down": "shift+down",
};

/** Every `k:` token in a keystroke list, with its standing. */
export function auditKeystrokes(keystrokes: string[]): { key: string; status: KeyStatus; note: string; replacement?: string }[] {
  const out: { key: string; status: KeyStatus; note: string; replacement?: string }[] = [];
  for (const raw of keystrokes) {
    const s = raw.trim();
    if (!s.startsWith("k:") && !s.startsWith("c:")) continue;
    const key = s.slice(2).trim();
    if (out.some((o) => o.key === key)) continue;
    out.push({ key, status: keyStatus(key), note: keyNote(key), replacement: KEY_REPLACEMENT[key] });
  }
  return out;
}
