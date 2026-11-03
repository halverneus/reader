// Launch-time autopilot: `metrik-studio --autorun <plan.json>`.
//
// Why a launch flag and not a bridge op: the bridge is deliberately read-only
// (see bridge.ts — "a tool that can start a recording is a tool that can start
// a recording by accident"). Recording the room is not something an outside
// tool should be able to switch on while Studio is sitting there. A command
// line argument is a decision made by whoever started the app, which is the
// same consent as clicking Start, and it leaves no remote surface behind.
//
// HOW IT MUST BE LAUNCHED (this bit is not optional, and it cost an evening):
// the xdg-desktop-portal ScreenCast restore token is tied to the APP ID the
// portal saw when the window was picked, and on this desktop that app id comes
// from the systemd scope the process sits in. Started from the KDE menu that is
// `app-metrik\x2dstudio-NNNN.scope` → "metrik-studio", which owns the saved VM
// window. Started from a terminal it inherits the TERMINAL's scope →
// "org.kde.konsole", the portal recognises nothing, and the screen source sits
// at "restoring the saved window…" forever while the portal waits for a human
// to answer a picker dialog. So an automated launch must say:
//
//   systemd-run --user --scope --unit='app-metrik\x2dstudio-auto.scope' \
//       ~/.local/bin/metrik-studio --autorun /path/plan.json
//
// Plan file:
//   {
//     "lessons": ["/abs/.../Week 07/02 - .../Script.yml", ...],
//     "options": { "post": false, "reboot": false, "prep": false },
//     "log": "/abs/run.log",          // progress, one line per event
//     "quitWhenDone": false
//   }
import { app, ipcMain } from "electron";
import fs from "node:fs";

export interface AutorunPlan {
  lessons?: string[];
  /** Session folders to post (and render) after the lessons, or on their own:
   *  the overnight job. */
  render?: string[];
  options?: Record<string, unknown>;
  log?: string;
  quitWhenDone?: boolean;
  /** How long to wait for the screen source to come up before giving up (ms). */
  waitForScreenMs?: number;
}

let plan: AutorunPlan | null = null;

/** Parse --autorun out of argv. Throws nothing: a bad plan means no autopilot,
 *  because a half-understood instruction to record is worse than none. */
export function loadAutorunPlan(argv = process.argv): AutorunPlan | null {
  const i = argv.indexOf("--autorun");
  if (i < 0) return null;
  const file = argv[i + 1];
  if (!file) { process.stderr.write("--autorun needs a plan file\n"); return null; }
  try {
    const p = JSON.parse(fs.readFileSync(file, "utf8")) as AutorunPlan;
    const list = (v: any, what: string): string[] => {
      if (v == null) return [];
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`"${what}" must be an array of paths`);
      const missing = v.filter((x) => !fs.existsSync(x));
      if (missing.length) throw new Error(`no such ${what}: ${missing.join(", ")}`);
      return v;
    };
    p.lessons = list(p.lessons, "lessons");
    p.render = list(p.render, "render");
    if (!p.lessons.length && !p.render.length) throw new Error('nothing to do: give "lessons", "render", or both');
    plan = p;
    log(`plan: ${p.lessons!.length} lesson(s), ${p.render!.length} to post, options ${JSON.stringify(p.options ?? {})}`);
    return p;
  } catch (e: any) {
    process.stderr.write(`--autorun: ${e.message}\n`);
    return null;
  }
}

export const autorunPlan = () => plan;

function log(line: string) {
  const stamped = `${new Date().toISOString().slice(11, 19)}  ${line}\n`;
  process.stdout.write(`[autorun] ${stamped}`);
  if (plan?.log) { try { fs.appendFileSync(plan.log, stamped); } catch {} }
}

export function registerAutorunIpc() {
  ipcMain.handle("autorun:plan", () => plan);
  ipcMain.handle("autorun:log", (_e, line: string) => log(String(line).slice(0, 2000)));
  ipcMain.handle("autorun:done", (_e, summary: any) => {
    log(`finished: ${JSON.stringify(summary)}`);
    // A little air before quitting: the last stopRecording has to finalise its
    // files, and before-quit waits for that, but a visible pause is kinder to
    // anyone watching than a window that vanishes mid-sentence.
    if (plan?.quitWhenDone) setTimeout(() => app.quit(), 3000);
  });
}
