// Unattended runner: record and post a whole week without anybody in the room.
//
// This is only possible for an "avatar episode" — one where Devatar is on from
// the first marker, so every line is machine-read and the take records the
// screen alone. The production engine already self-drives those: once
// `st.avatar` is true, every marker auto-advances regardless of its `auto`
// flag. So a lesson is really just: load, record, advance once, wait for the
// end, stop, post.
//
// What the runner adds is everything around that — refusing lessons that need
// a human, putting the VM's desktop into position before the take, rebooting
// between lessons so the "Activate Windows" watermark never appears, and
// carrying on to the next lesson when one fails instead of stopping the night.

import { loadScriptFile } from "./script-io";
import { getState, toast } from "./store";
import { production } from "./production";

export type StepState = "pending" | "prep" | "recording" | "post" | "done" | "failed" | "skipped";
export interface RunStep { path: string; label: string; state: StepState; error?: string; dir?: string; ms?: number }

export interface RunOptions {
  /** Put the VM's desktop in position before each take (deck fullscreen on
   *  slide 1 with focus, Workbench on an empty SQL tab). Off means the VM is
   *  already sitting the way the script's setup note describes. */
  prep: boolean;
  /** Reboot the VM after each lesson and wait for it to come back. */
  reboot: boolean;
  /** Run the post pipeline for each take as it finishes. Off just records. */
  post: boolean;
  /** How long to let one lesson run before calling it stuck (ms). */
  perLessonTimeoutMs: number;
  /** Seconds to wait after a reboot when the guest agent is not installed. */
  settleMs: number;
}

export const DEFAULT_OPTIONS: RunOptions = {
  prep: false, reboot: false, post: true, perLessonTimeoutMs: 45 * 60_000, settleMs: 90_000,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const label = (p: string) => p.split("/").slice(-2, -1)[0] ?? p;

let cancelled = false;
export function cancelRun() { cancelled = true; }
export function runCancelled() { return cancelled; }

/** Keystrokes that put the VM desktop back where a take expects it. Deliberately
 *  conservative: alt+tab cycles rather than assuming a window order, and every
 *  step is one the scripts already use, so nothing here is a new dependency.
 *
 *  This cannot verify what it did — there is no way to read the guest's screen
 *  from here — so it is off by default and the run log says when it ran. */
const PREP_STEPS: string[] = [
  "k:escape",           // drop any menu or dialog that is open
  "w:400",
  "combo:alt+tab",      // to the other window
  "w:1200",
  "combo:alt+tab",      // and back, so focus is somewhere known
  "w:1200",
  "k:f11",              // the browser is frontmost: make sure it is fullscreen
  "w:1500",
  "m:move 960,540",
  "m:click",            // give the deck keyboard focus, or k:right goes nowhere
  "w:400",
  "k:home",             // decks jump to slide 1 on Home
  "w:800",
];

async function prepVm(): Promise<void> {
  await window.studio.invoke("keys:run", { entryId: `runner-prep-${Date.now()}`, steps: PREP_STEPS, speed: 6, dryRun: !production.st.sendKeys });
}

/** Run one lesson end to end. Throws with a human-readable reason. */
async function runOne(path: string, opts: RunOptions, set: (p: Partial<RunStep>) => void): Promise<void> {
  await loadScriptFile(path);
  if (getState().scriptPath !== path) throw new Error("could not open the script");

  const errs = getState().errors;
  if (errs.length) throw new Error(`${errs.length} parse issue(s) — fix them before recording`);
  if (!production.selfDriving)
    throw new Error("not an avatar episode: this one needs Dev on camera, so it cannot run unattended");

  production.reset();

  if (opts.prep) { set({ state: "prep" }); await prepVm(); }

  set({ state: "recording" });
  await production.startRecording();
  if (!production.st.recording) throw new Error("recording did not start");

  // Wait for the script to run off its last marker. The outro is part of the
  // final marker's waits, so by the time this fires the credits have played.
  const finished = new Promise<void>((resolve, reject) => {
    const off = production.onEnd(() => { off(); clearTimeout(timer); resolve(); });
    const timer = setTimeout(() => { off(); reject(new Error(`still running after ${Math.round(opts.perLessonTimeoutMs / 60000)} min — stopped it`)); }, opts.perLessonTimeoutMs);
  });
  production.advance();            // marker -1 → the first marker; it self-drives from there
  try { await finished; } finally { await production.stopRecording(); }

  if (cancelled) throw new Error("cancelled");

  if (opts.post) {
    set({ state: "post" });
    const dir = await window.studio.invoke("session:current").then((m: any) => m?.dir).catch(() => null);
    // session:current is null once stopped, so fall back to the newest session
    const target = dir ?? (await window.studio.invoke("post:sessions").catch(() => []))[0]?.dir;
    if (!target) throw new Error("recorded, but the session folder could not be found for post");
    set({ dir: target });
    await window.studio.invoke("post:run", target, "all");
  }
}

/**
 * Record (and optionally post) each lesson in turn.
 * `onProgress` is called whenever any step changes, with the whole list.
 */
export async function runBatch(paths: string[], opts: RunOptions, onProgress: (steps: RunStep[]) => void): Promise<RunStep[]> {
  cancelled = false;
  const steps: RunStep[] = paths.map((p) => ({ path: p, label: label(p), state: "pending" }));
  const emit = () => onProgress([...steps]);
  emit();

  for (let i = 0; i < steps.length; i++) {
    if (cancelled) { steps[i].state = "skipped"; steps[i].error = "cancelled"; emit(); continue; }
    const t0 = Date.now();
    const set = (p: Partial<RunStep>) => { Object.assign(steps[i], p); emit(); };
    try {
      await runOne(steps[i].path, opts, set);
      set({ state: "done", ms: Date.now() - t0 });
    } catch (e: any) {
      // One bad lesson must not cost the whole night. Record why and carry on.
      set({ state: "failed", error: e?.message ?? String(e), ms: Date.now() - t0 });
      try { if (production.st.recording) await production.stopRecording(); } catch {}
    }

    const last = i === steps.length - 1;
    if (opts.reboot && !last && !cancelled) {
      const r = await window.studio.invoke("vm:power", "reboot").catch((e: any) => ({ ok: false, out: e.message }));
      if (r?.ok) {
        await sleep(8000); // let it actually go down before we start asking if it is up
        const ready = await window.studio.invoke("vm:waitReady", { settleMs: opts.settleMs }).catch(() => ({ ready: false, how: "wait failed" }));
        toast(`VM rebooted: ${ready.how}`, ready.ready ? "info" : "error");
      } else toast(`VM reboot failed: ${r?.out ?? "unknown"} — carrying on anyway`, "error");
    }
  }

  const bad = steps.filter((s) => s.state === "failed").length;
  toast(bad ? `Run finished with ${bad} failure(s)` : `Run finished: ${steps.length} lesson(s)`, bad ? "error" : "ok", true);
  return steps;
}
