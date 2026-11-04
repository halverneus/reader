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
import { deckUrlFor, stageSteps } from "../shared/stage";

export type StepState = "pending" | "prep" | "recording" | "post" | "done" | "failed" | "skipped";
export interface RunStep { path: string; label: string; state: StepState; error?: string; dir?: string; ms?: number }

export interface RunOptions {
  /** Put the VM's desktop in position before each take (deck fullscreen on
   *  slide 1 with focus, Workbench on an empty SQL tab). Off means the VM is
   *  already sitting the way the script's setup note describes. */
  prep: boolean;
  /** Reboot the VM after each lesson and wait for it to come back. */
  reboot: boolean;
  /** Before each take, load THIS lesson's deck in the guest's browser and
   *  empty the Workbench editor. Without it a batch records lesson two's
   *  script against lesson one's slides. */
  stage: boolean;
  /** Run the post pipeline for each take as it finishes. Off just records. */
  post: boolean;
  /** How long to let one lesson run before calling it stuck (ms). */
  perLessonTimeoutMs: number;
  /** Seconds to wait after a reboot when the guest agent is not installed. */
  settleMs: number;
}

export const DEFAULT_OPTIONS: RunOptions = {
  prep: false, reboot: false, stage: true, post: true, perLessonTimeoutMs: 45 * 60_000, settleMs: 90_000,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Check once, before the first lesson, the things that would otherwise fail
 * every lesson identically. Returns the blocking reasons, most important
 * first; empty means go.
 *
 * This checks the SYMPTOM rather than any one cause: is the screen source
 * actually live? It was written the other way round first — a lock-screen
 * probe, on the strength of one evening where capture hung behind a locked
 * session — and that was a misdiagnosis. The same hang happens unlocked when
 * the portal does not recognise the app (see portalAppId in capture.ts). The
 * lock is still reported, because it is worth knowing, but what blocks the run
 * is the source not being live, whatever the reason for that.
 */
export async function preflight(opts: RunOptions): Promise<string[]> {
  const bad: string[] = [];

  const cap: any = await window.studio.invoke("capture:statusNow").catch(() => null);
  if (!cap) bad.push("The capture engine is not answering. Open the Record tab and check the sources.");
  else {
    const desk = (cap.sources ?? []).find((s: any) => s.id === "desktop");
    if (!desk) bad.push("No desktop source at all.");
    else if (desk.status !== "live" && desk.status !== "starting") {
      const why: string[] = [`The screen source is "${desk.status}"${desk.detail ? ` (${desk.detail})` : ""}, so every take would record nothing.`];
      const appId = await window.studio.invoke("host:appId").catch(() => "");
      if (appId && appId !== "metrik-studio")
        why.push(`Studio is running as "${appId}" to the screen-cast portal, not "metrik-studio" — it was started from another app (a terminal, usually), and the portal only returns the saved VM window to the app that picked it. Launch Studio from the application menu.`);
      if (await window.studio.invoke("host:locked").catch(() => null) === true)
        why.push("The desktop session is also locked.");
      why.push("If it persists, pick the VM window again on the Record tab.");
      bad.push(why.join(" "));
    }
  }

  // "live" is not the same as "showing something". A window whose output has
  // gone to sleep streams perfectly valid black frames and nothing complains:
  // that is how two whole lessons came out black on 2026-11-03.
  const dark = await screenLooksBlack();
  if (dark) bad.push("The screen source is live but every frame is black. The host monitor the VM window is on has almost certainly gone to sleep — KWin stops painting a window on a sleeping output, and the stream does not recover when it wakes. Wake the display (kscreen-doctor --dpms on), then restart the capture on the Record tab.");

  if (opts.prep || opts.reboot) {
    const vm: any = await window.studio.invoke("vm:state").catch(() => null);
    if (!vm?.vm) bad.push("No VM found over libvirt, but VM prep or reboot is switched on. If the VM lives in GNOME Boxes, Boxes has to be running.");
  }

  return bad;
}

/** Mean luminance of the engine's own desktop thumbnail, or null when there
 *  is no thumbnail to look at. Cheap: the thumbnails are already being made
 *  for the Record tab. */
export async function screenLuma(): Promise<number | null> {
  const cap: any = await window.studio.invoke("capture:statusNow").catch(() => null);
  const thumb = (cap?.sources ?? []).find((s: any) => s.id === "desktop")?.thumb;
  if (!thumb) return null;
  try {
    const bmp = await createImageBitmap(await (await fetch(thumb)).blob());
    const c = new OffscreenCanvas(48, 27);
    const ctx = c.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0, 48, 27);
    const d = ctx.getImageData(0, 0, 48, 27).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    return sum / (d.length / 4);
  } catch { return null; }
}

/** True only when we are confident the picture is black — an unreadable or
 *  missing thumbnail is not evidence of anything, and must not block a run. */
export async function screenLooksBlack(): Promise<boolean> {
  const a = await screenLuma();
  if (a == null) return false;
  if (a > 0.5) return false;
  await sleep(1200);                       // a slide transition can be dark
  const b = await screenLuma();
  return b != null && b <= 0.5;
}

/** Wait for the screen source to come up after a cold start: the portal
 *  restore takes a moment, and an autorun arrives before it has happened. */
export async function waitForScreen(timeoutMs = 45_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const cap: any = await window.studio.invoke("capture:statusNow").catch(() => null);
    const desk = (cap?.sources ?? []).find((s: any) => s.id === "desktop");
    if (desk?.status === "live") return true;
    if (Date.now() > deadline) return false;
    await sleep(1000);
  }
}

const label = (p: string) => p.split("/").slice(-2, -1)[0] ?? p;

let cancelled = false;
let active = false;
const watchers = new Set<(steps: RunStep[], running: boolean) => void>();
/** Follow a run from anywhere — the Run tab uses this so an autorun shows up
 *  in the UI exactly like one started by hand. */
export function watchRun(f: (steps: RunStep[], running: boolean) => void) { watchers.add(f); return () => { watchers.delete(f); }; }
export function runActive() { return active; }
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
  "k:alt+tab",      // to the other window
  "w:1200",
  "k:alt+tab",      // and back, so focus is somewhere known
  "w:1200",
  "k:f11",              // the browser is frontmost: make sure it is fullscreen
  "w:1500",
  "m:move 960,540",
  "m:click",            // give the deck keyboard focus, or k:right goes nowhere
  "w:400",
  "k:home",             // decks jump to slide 1 on Home
  "w:800",
];

async function stageGuest(scriptPath: string): Promise<string> {
  const template = getState().config?.vm?.deckUrl ?? "";
  if (!template) return "no deck URL configured — skipped";
  const url = deckUrlFor(scriptPath, template);
  await window.studio.invoke("keys:run", { entryId: `runner-stage-${Date.now()}`, steps: stageSteps(url), speed: 9, dryRun: !production.st.sendKeys });
  return url;
}

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

  if (opts.stage || opts.prep) {
    set({ state: "prep" });
    await window.studio.invoke("vm:nudge").catch(() => {});   // wake the display first
    if (opts.prep) await prepVm();
    if (opts.stage) await stageGuest(path);
  }

  // Per lesson, not just once per batch: the display can fall asleep in the
  // gap between takes, and a black lesson looks exactly like a good one until
  // somebody opens the file.
  if (await screenLooksBlack()) throw new Error("the screen source is black — the monitor the VM window is on is asleep, so this would record nothing");

  set({ state: "recording" });
  await production.startRecording();
  if (!production.st.recording) throw new Error("recording did not start");

  // Wait for the script to run off its last marker. The outro is part of the
  // final marker's waits, so by the time this fires the credits have played.
  const finished = new Promise<void>((resolve, reject) => {
    const off = production.onEnd((reason) => {
      off(); clearTimeout(timer);
      // A lost source (the screen pipeline died, the engine exited) means the
      // rest of this take is being filmed by nobody. Twenty more minutes of
      // reading to an empty room helps no one: fail now, move to the next.
      reason === "lost" ? reject(new Error("the capture was lost mid-take")) : resolve();
    });
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
  // Before anything is checked, let alone recorded: wake the monitors and hold
  // them awake for the whole batch, gaps included.
  await window.studio.invoke("host:keepAwake", true).catch(() => {});
  try {
    return await runBatchInner(paths, opts, onProgress);
  } finally { await window.studio.invoke("host:keepAwake", false).catch(() => {}); }
}

async function runBatchInner(paths: string[], opts: RunOptions, onProgress: (steps: RunStep[]) => void): Promise<RunStep[]> {
  const blocked = await preflight(opts);
  if (blocked.length) { toast(blocked[0], "error", true); throw new Error(blocked.join(" ")); }
  const steps: RunStep[] = paths.map((p) => ({ path: p, label: label(p), state: "pending" }));
  const emit = () => { const copy = [...steps]; onProgress(copy); for (const w of watchers) try { w(copy, active); } catch {} };
  active = true;
  emit();

  // The guest blanks its display after a few idle minutes and he cannot turn
  // that off, so a take that starts against a black screen records a black
  // screen. Nudge it the whole way through: during post, during a reboot wait,
  // and during the quiet stretches of a take where nobody types for minutes.
  const awake = setInterval(() => { window.studio.invoke("vm:nudge").catch(() => {}); }, 45_000);
  // Once, before the first take: the Boxes window has to be fullscreen or its
  // header bar is in every frame.
  const fs = await window.studio.invoke("vm:fullscreen").catch(() => null);
  if (fs && !fs.ok) toast(`Could not fullscreen the VM window (${fs.detail}) — check the first take's framing`, "error");
  try {
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
  } finally { clearInterval(awake); active = false; const copy = [...steps]; for (const w of watchers) try { w(copy, false); } catch {} }
}

/**
 * Post every one of these sessions, one after another, and keep going past a
 * failure. This is the overnight job: eight lessons, each one matting the
 * camera, rendering Glitch, building the Kdenlive project and encoding the
 * video, which is hours of GPU time nobody should have to babysit.
 *
 * `all` only encodes a video when Settings → render video is on; when it is
 * off this asks for the render explicitly, because a batch called "render
 * them all" that quietly produced project files and no videos would be a
 * cruel thing to discover in the morning.
 */
export async function renderBatch(dirs: string[], onProgress: (steps: RunStep[]) => void): Promise<RunStep[]> {
  cancelled = false;
  // Nothing here captures the screen, so a sleeping monitor cannot ruin the
  // footage — but Glitch and the avatar are rendered by stepping offscreen
  // BrowserWindows, and a renderer on a sleeping display is exactly the kind
  // of thing Chromium throttles. Hours of work, unattended, for the price of
  // one call: hold it awake.
  await window.studio.invoke("host:keepAwake", true).catch(() => {});
  try {
    return await renderBatchInner(dirs, onProgress);
  } finally { await window.studio.invoke("host:keepAwake", false).catch(() => {}); }
}

async function renderBatchInner(dirs: string[], onProgress: (steps: RunStep[]) => void): Promise<RunStep[]> {
  const autoRender = !!getState().config?.post?.autoRender;
  const steps: RunStep[] = dirs.map((d) => ({ path: d, label: d.split("/").slice(-2).join(" / "), state: "pending", dir: d }));
  const emit = () => { const copy = [...steps]; onProgress(copy); for (const w of watchers) try { w(copy, active); } catch {} };
  active = true;
  emit();
  const awake = setInterval(() => { window.studio.invoke("vm:nudge").catch(() => {}); }, 45_000);
  try {
    for (let i = 0; i < steps.length; i++) {
      if (cancelled) { steps[i].state = "skipped"; steps[i].error = "cancelled"; emit(); continue; }
      const t0 = Date.now();
      steps[i].state = "post"; emit();
      try {
        await window.studio.invoke("post:run", steps[i].path, "all");
        if (!autoRender) await window.studio.invoke("post:run", steps[i].path, "render");
        steps[i].state = "done"; steps[i].ms = Date.now() - t0; emit();
      } catch (e: any) {
        steps[i].state = "failed"; steps[i].error = e?.message ?? String(e); steps[i].ms = Date.now() - t0; emit();
      }
    }
  } finally { clearInterval(awake); active = false; emit(); }
  const bad = steps.filter((s) => s.state === "failed").length;
  toast(bad ? `Post finished with ${bad} failure(s)` : `Post finished: ${steps.length} session(s)`, bad ? "error" : "ok", true);
  return steps;
}

/**
 * The unattended entry point: a plan handed in on the command line (see
 * main/autorun.ts) rather than a human on the Run tab. Everything it does is
 * written to the plan's log as it happens, because by definition nobody is
 * watching the window.
 */
export async function startAutorun(plan: { lessons?: string[]; render?: string[]; options?: Partial<RunOptions>; waitForScreenMs?: number }): Promise<void> {
  const say = (line: string) => { window.studio.invoke("autorun:log", line).catch(() => {}); };
  const opts: RunOptions = { ...DEFAULT_OPTIONS, ...(plan.options ?? {}) };

  // A render-only plan touches no devices: no VM, no portal, no waiting for a
  // screen that nothing is going to film.
  if (!plan.lessons?.length && plan.render?.length) {
    say(`render-only autorun: ${plan.render.length} session(s)`);
    const done = await renderBatch(plan.render, (s) => say(s.map((x) => `${x.label}:${x.state}${x.error ? ` (${x.error})` : ""}`).join("  ")));
    await window.studio.invoke("autorun:done", done.map((s) => ({ session: s.label, state: s.state, error: s.error, ms: s.ms })));
    return;
  }

  const lessons = plan.lessons ?? [];
  say(`autorun starting: ${lessons.map(label).join(", ")}`);
  say(`options: ${JSON.stringify({ post: opts.post, reboot: opts.reboot, prep: opts.prep })}`);

  // Wake the guest before anything looks at it, then let the portal restore.
  await window.studio.invoke("vm:nudge").catch(() => {});
  const live = await waitForScreen(plan.waitForScreenMs ?? 45_000);
  say(live ? "screen source is live" : "screen source never went live — preflight will explain");

  try {
    const steps = await runBatch(lessons, opts, (s) => {
      const line = s.map((x) => `${x.label}:${x.state}${x.error ? ` (${x.error})` : ""}`).join("  ");
      say(line);
    });
    const summary: any[] = steps.map((s) => ({ lesson: s.label, state: s.state, error: s.error, dir: s.dir, ms: s.ms }));
    if (plan.render?.length) {
      say(`post: ${plan.render.length} session(s)`);
      const done = await renderBatch(plan.render, (s) => say(s.map((x) => `${x.label}:${x.state}${x.error ? ` (${x.error})` : ""}`).join("  ")));
      summary.push(...done.map((s) => ({ session: s.label, state: s.state, error: s.error, ms: s.ms })));
    }
    await window.studio.invoke("autorun:done", summary);
  } catch (e: any) {
    say(`autorun could not start: ${e?.message ?? e}`);
    await window.studio.invoke("autorun:done", { error: String(e?.message ?? e) });
  }
}
