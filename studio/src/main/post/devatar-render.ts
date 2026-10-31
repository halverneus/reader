// Render avatar Dev deterministically from the session's cue log into
// devatar.webm (VP9 + alpha), 1920x1080 — the same offscreen-stepping trick
// glitch-render.ts uses, so the two characters are produced the same way.
//
// Three things drive him, and only one of them is authored:
//   * mood   — `face` entries with actor: Dev
//   * talk   — his own cloned voice. Every Dev line is machine-read once the
//              avatar is up, and the wav's length and its internal silences
//              are logged, so the mouth follows the audio that is actually in
//              the mix. An older session where Dev read on camera instead
//              falls back to the mic.
//   * gaze   — he turns toward Glitch whenever Glitch is speaking, which is
//              the behaviour you want often enough that authoring it per line
//              would just be noise
//   * hands  — `[hand greeting]` / `[hand signoff]` inside a Dev line, logged
//              at the word it sat on
import { BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config";
import { installUserGestures } from "../../shared/gestures";
import { GESTURES } from "../../../glitch/dev-hands-data";
import type { Log } from "./pipeline";
import { talkCues } from "../../shared/script";
import { micSpeech } from "./kdenlive";

/** True when the script ever swaps to the avatar; otherwise the step is free. */
export function usesAvatar(session: any): boolean {
  return session.events?.some((e: any) => e.kind === "avatar") ?? false;
}

export async function renderDevatar(dir: string, session: any, log: Log): Promise<string> {
  if (!usesAvatar(session)) return "no avatar cues — skipped";
  const out = path.join(dir, "devatar.webm");
  const t0: number = session.meta.startedAt;
  const tEnd: number = session.meta.stoppedAt ?? (session.events.at(-1)?.t ?? t0);
  const durationS = Math.max(1, (tEnd - t0) / 1000 + 1);
  const fps = Number(process.env.METRIK_GLITCH_FPS) || 30;
  const total = Math.ceil(durationS * fps);
  const cfg = loadConfig();

  type Cue = { t: number; mood?: string; hold?: number; talk?: boolean; toGlitch?: boolean; gesture?: string | null };
  const cues: Cue[] = [];
  const glitchLines = new Set<string>(session.events.filter((e: any) => e.kind === "line-start" && e.actor === "Glitch").map((e: any) => e.entryId));
  for (const e of session.events) {
    const t = (e.t - t0) / 1000;
    if (e.kind === "mood" && e.actor === "Dev") cues.push({ t, mood: e.mood, hold: e.hold });
    else if (e.kind === "gesture" && e.actor === "Dev") cues.push({ t, gesture: e.name });
    // The handover wears the glitch mood: it is something being done TO him.
    // It has to last the whole dissolve, or it is over before he is visible.
    else if (e.kind === "avatar") cues.push({ t, mood: "glitch", hold: e.burst ?? (e.over ?? 1200) + 1100 });
    else if (e.kind === "line-start" && e.actor === "Glitch") cues.push({ t, toGlitch: true });
    // `line-end` carried no actor until 2026-10-31, so the gaze could never be
    // turned back off and he stared at Glitch for whole lessons. Older takes
    // are repaired here by matching the line it ends.
    else if (e.kind === "line-end" && (e.actor === "Glitch" || (!e.actor && glitchLines.has(e.entryId)))) cues.push({ t, toGlitch: false });
    else if (e.kind === "reset") cues.push({ t, mood: "neutral", toGlitch: false, talk: false, gesture: null });
  }
  // the mouth. Machine-read Dev lines carry their own duration and their
  // internal silences, which beats measuring a microphone that may not have
  // been running at all.
  const spoken = session.events.filter((e: any) => e.kind === "line-start" && e.actor === "Dev" && e.spoken);
  if (spoken.length) {
    for (const e of spoken) for (const c of talkCues((e.t - t0) / 1000, e)) cues.push({ t: c.t, talk: c.talk });
    log(`[devatar] ${spoken.length} spoken Dev lines drive the mouth\n`);
  } else {
    const micRaw: string | undefined = [session.meta.files?.mic, path.join(dir, "mic.flac")].find((f: string) => f && fs.existsSync(f));
    if (micRaw) {
      const spans = await micSpeech(micRaw, session.meta.micOffset ?? 0);
      for (const [a, b] of spans) { cues.push({ t: a, talk: true }); cues.push({ t: b, talk: false }); }
      log(`[devatar] ${spans.length} speech spans from the mic\n`);
    } else log("[devatar] no spoken Dev lines and no mic track — the mouth will stay closed\n");
  }
  cues.sort((a, b) => a.t - b.t);
  log(`[devatar] ${total} frames @ ${fps} fps, ${cues.length} cues\n`);

  const av = cfg.dev?.avatar ?? { x: 965, y: 357, scale: 1.363 };
  const win = new BrowserWindow({ show: false, width: 1920, height: 1080, webPreferences: { backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, "../renderer/devatar.html"), {
    query: { manual: "1", seed: String(cfg.glitch.seed), x: String(av.x), y: String(av.y), scale: String(av.scale) },
  });

  // his own gestures, which the page does not have: it was built with the
  // shipped table and knows nothing about gestures.json
  installUserGestures();
  await win.webContents.executeJavaScript(`devatar.setGestures(${JSON.stringify(GESTURES)})`);

  let ffErr = "";
  const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "-", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", "-row-mt", "1", "-threads", "8", "-speed", "3", "-b:v", "0", "-crf", "24", out]);
  ff.stderr.on("data", (d) => { ffErr += d; log(String(d)); });
  const done = new Promise<void>((res, rej) => ff.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}: ${ffErr.slice(-300)}`)))));
  done.catch(() => {});
  let ci = 0;
  try {
    for (let f = 0; f < total; f++) {
      const t = f / fps;
      while (ci < cues.length && cues[ci].t <= t) {
        const c = cues[ci++];
        const js = [
          c.mood ? `devatar.mood(${JSON.stringify(c.mood)}, ${c.hold ?? 0});` : "",
          c.talk != null ? `devatar.talk(${c.talk});` : "",
          c.toGlitch != null ? `devatar.toGlitch(${c.toGlitch});` : "",
          c.gesture !== undefined ? `devatar.gesture(${c.gesture ? JSON.stringify(c.gesture) : "null"});` : "",
        ].join("");
        if (js) await win.webContents.executeJavaScript(js);
      }
      const dataUrl: string = await win.webContents.executeJavaScript(`devatar.step(${fps}, ${f}); devatar.frame()`);
      const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
      if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once("drain", r));
      if (f % (fps * 10) === 0) log(`[devatar] ${Math.round((f / total) * 100)}%\n`);
    }
  } finally { ff.stdin.end(); win.destroy(); }
  await done;
  return `${path.basename(out)} (${total} frames)`;
}
