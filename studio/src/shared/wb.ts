// A model of the MySQL Workbench SQL editor, good enough to say what will be in
// the buffer when the Run button is clicked.
//
// Why: the standing rule is that no result grid may come from reasoning. Once
// scripts started EDITING the statement on screen rather than retyping it, the
// SQL that reaches the server depends on cursor positions and counted
// backspaces, so the buffer stopped being obvious too. This replays the
// keystrokes; `wb_run` then puts the result through a real server.
//
// Ported from wb_sim.py (2026-10-19..22), which caught three real bugs in its
// first minute: a join_up() that dropped a close paren, a k:shift+home that
// only reached the indent, and the stray auto-close paren below.
import { parseScript, type Script } from "./script";
import { keyStatus } from "./keys";

export class UnknownKeyError extends Error {
  constructor(public key: string) { super(`unmodelled keystroke "k:${key}"`); }
}

export class Editor {
  lines: string[] = [""];
  r = 0;
  c = 0;
  /** anchor of the active selection, or null */
  sel: [number, number] | null = null;
  /** auto-close ")" characters waiting just right of the cursor */
  pending = 0;
  /** consecutive home presses: the first stops at the indent, the second at column 0 */
  homeCount = 0;

  text(): string { return this.lines.join("\n"); }

  private clearSel() {
    if (!this.sel) return;
    let [ar, ac] = this.sel;
    let [br, bc] = [this.r, this.c];
    if (ar > br || (ar === br && ac > bc)) { [ar, ac, br, bc] = [br, bc, ar, ac]; }
    const head = this.lines[ar].slice(0, ac);
    const tail = this.lines[br].slice(bc);
    this.lines.splice(ar, br - ar + 1, head + tail);
    this.r = ar; this.c = ac; this.sel = null; this.pending = 0;
  }

  type(s: string) {
    this.homeCount = 0;
    for (const ch of s) {
      if (this.sel) this.clearSel();
      // typing the matching ")" overtypes the one Workbench inserted
      if (ch === ")" && this.pending > 0 && this.lines[this.r][this.c] === ")") {
        this.c++; this.pending--; continue;
      }
      const ln = this.lines[this.r];
      this.lines[this.r] = ln.slice(0, this.c) + ch + ln.slice(this.c);
      this.c++;
      if (ch === "(") {
        // Workbench inserts the closing paren after the cursor and cannot be told not to
        const l2 = this.lines[this.r];
        this.lines[this.r] = l2.slice(0, this.c) + ")" + l2.slice(this.c);
        this.pending++;
      }
    }
  }

  key(k: string) {
    if (keyStatus(k) === "unknown") throw new UnknownKeyError(k);
    if (k !== "home" && !k.endsWith("home")) this.homeCount = 0;

    if (k === "enter") {
      if (this.sel) this.clearSel();
      const ln = this.lines[this.r];
      const indent = ln.length - ln.trimStart().length;
      const head = ln.slice(0, this.c);
      const tail = ln.slice(this.c);
      this.lines[this.r] = head;
      this.lines.splice(this.r + 1, 0, " ".repeat(indent) + tail);
      this.r++; this.c = indent;
      // a pending auto-close stops being pending and becomes an ordinary
      // character riding along after the cursor
      this.pending = 0;
      return;
    }
    if (k === "backspace") {
      if (this.sel) { this.clearSel(); return; }
      if (this.c > 0) {
        const ln = this.lines[this.r];
        this.lines[this.r] = ln.slice(0, this.c - 1) + ln.slice(this.c);
        this.c--;
      } else if (this.r > 0) {
        const prev = this.lines[this.r - 1];
        this.c = prev.length;
        this.lines[this.r - 1] = prev + this.lines[this.r];
        this.lines.splice(this.r, 1);
        this.r--;
      }
      this.pending = Math.max(0, this.pending - 1);
      return;
    }
    if (k === "delete") {
      if (this.sel) { this.clearSel(); return; }
      const ln = this.lines[this.r];
      if (this.c < ln.length) this.lines[this.r] = ln.slice(0, this.c) + ln.slice(this.c + 1);
      else if (this.r + 1 < this.lines.length) { this.lines[this.r] += this.lines[this.r + 1]; this.lines.splice(this.r + 1, 1); }
      this.pending = Math.max(0, this.pending - 1);
      return;
    }
    if (k === "escape" || k === "tab" || k === "alt+tab" || k.startsWith("f")) {
      // escape dismisses autocomplete and changes nothing in the buffer
      return;
    }
    if (k.startsWith("ctrl+")) { this.ctrl(k); return; }

    const shift = k.startsWith("shift+");
    const base = shift ? k.slice(6) : k;
    if (shift && !this.sel) this.sel = [this.r, this.c];
    if (!shift) this.sel = null;

    switch (base) {
      case "home": {
        this.homeCount++;
        const ln = this.lines[this.r];
        const indent = ln.length - ln.trimStart().length;
        this.c = this.homeCount > 1 || this.c === indent ? 0 : indent;
        break;
      }
      case "end": this.c = this.lines[this.r].length; break;
      case "up": this.r = Math.max(0, this.r - 1); this.c = Math.min(this.c, this.lines[this.r].length); break;
      case "down": this.r = Math.min(this.lines.length - 1, this.r + 1); this.c = Math.min(this.c, this.lines[this.r].length); break;
      case "left": this.c = Math.max(0, this.c - 1); break;
      case "right": this.c = Math.min(this.lines[this.r].length, this.c + 1); break;
      default: throw new UnknownKeyError(k);
    }
    this.pending = 0;
  }

  private ctrl(k: string) {
    const shift = k.includes("shift+");
    const base = k.replace("ctrl+", "").replace("shift+", "");
    if (base === "a") {
      this.sel = [0, 0];
      this.r = this.lines.length - 1; this.c = this.lines[this.r].length;
      return;
    }
    if (shift && !this.sel) this.sel = [this.r, this.c];
    if (!shift) this.sel = null;
    switch (base) {
      case "home": this.r = 0; this.c = 0; break;
      case "end": this.r = this.lines.length - 1; this.c = this.lines[this.r].length; break;
      case "up": this.r = Math.max(0, this.r - 1); this.c = Math.min(this.c, this.lines[this.r].length); break;
      case "down": this.r = Math.min(this.lines.length - 1, this.r + 1); this.c = Math.min(this.c, this.lines[this.r].length); break;
      case "right": {
        const ln = this.lines[this.r];
        const m = /\w+|\S/.exec(ln.slice(this.c));
        this.c = m ? this.c + m.index + m[0].length : ln.length;
        break;
      }
      case "left": {
        const ln = this.lines[this.r].slice(0, this.c);
        const ms = [...ln.matchAll(/\w+|\S/g)];
        this.c = ms.length ? ms[ms.length - 1].index! : 0;
        break;
      }
      default: throw new UnknownKeyError(k);
    }
    this.pending = 0;
  }
}

/** Keystroke lists in marker order, which is what the recorder fires. */
export function chunksFromScript(s: Script): string[][] {
  return s.entries.filter((e) => e.type === "keys").map((e) => (e as any).keystrokes as string[]);
}

export interface RunBuffer { run: number; marker: number; sql: string }

/**
 * Replay every keys entry and capture the buffer at each Run (a mouse click on
 * the Run button, which is how the scripts fire a statement).
 */
export function replay(s: Script): { runs: RunBuffer[]; unknown: { marker: number; key: string }[] } {
  const ed = new Editor();
  const runs: RunBuffer[] = [];
  const unknown: { marker: number; key: string }[] = [];
  for (const e of s.entries) {
    if (e.type !== "keys") continue;
    const marker = e.start;
    for (const tok of (e as any).keystrokes as string[]) {
      const t = tok.trim();
      if (t.startsWith("t:")) ed.type(t.slice(2));
      else if (t.startsWith("p:")) ed.type(t.slice(2));
      else if (t.startsWith("w:")) continue;
      else if (t.startsWith("m:")) {
        // the Run button lives at 1800,85; a click is what fires the statement
        if (t.startsWith("m:click")) runs.push({ run: runs.length + 1, marker, sql: ed.text().trim() });
        continue;
      } else if (t.startsWith("k:") || t.startsWith("c:")) {
        const key = t.slice(2).trim();
        try { ed.key(key); }
        catch (err) {
          if (err instanceof UnknownKeyError) { unknown.push({ marker, key }); }
          else throw err;
        }
      }
    }
  }
  return { runs: runs.filter((r) => r.sql), unknown };
}

export function replayText(text: string) {
  return replay(parseScript(text).script);
}

/** Endings that mean a counted edit went wrong.
 *
 *  The `;` clause deliberately does NOT cross a newline. A Run may hold more
 *  than one statement -- W06L08 sets the session time zone and then selects,
 *  which is the whole demonstration -- and `;\s*\S` flagged every one of
 *  those as a botched edit. Junk after a semicolon ON THE SAME LINE is still
 *  the backspace-count mistake this is here to catch (2026-10-28). */
export const SUSPICIOUS = /(\);\)|\)\s;|\)\)\s*$|;[^\S\n]*\S)/;
