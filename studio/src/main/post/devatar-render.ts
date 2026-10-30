// Render avatar Dev deterministically from the session's cue log into
// devatar.webm (VP9 + alpha), 1920x1080 — the same offscreen-stepping trick
// glitch-render.ts uses, so the two characters are produced the same way.
//
// Three things drive him, and only one of them is authored:
//   * mood   — `face` entries with actor: Dev
//   * talk   — Dev's own mic, so the mouth follows the voice that is actually
//              in the mix rather than a guess at reading speed
//   * gaze   — he turns toward Glitch whenever Glitch is speaking, which is
//              the behaviour you want often enough that authoring it per line
//              would just be noise
import { BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config";
import type { Log } from "./pipeline";
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

  type Cue = { t: number; mood?: string; hold?: number; talk?: boolean; toGlitch?: boolean };
  const cues: Cue[] = [];
  for (const e of session.events) {
    const t = (e.t - t0) / 1000;
    if (e.kind === "mood" && e.actor === "Dev") cues.push({ t, mood: e.mood, hold: e.hold });
    // the handover wears the glitch mood: it is something being done TO him
    else if (e.kind === "avatar") cues.push({ t, mood: "glitch" });
    else if (e.kind === "line-start" && e.actor === "Glitch") cues.push({ t, toGlitch: true });
    else if (e.kind === "line-end" && e.actor === "Glitch") cues.push({ t, toGlitch: false });
    else if (e.kind === "reset") cues.push({ t, mood: "neutral", toGlitch: false, talk: false });
  }
  // the mouth, from the mic rather than from the script
  const micRaw: string | undefined = [session.meta.files?.mic, path.join(dir, "mic.flac")].find((f: string) => f && fs.existsSync(f));
  if (micRaw) {
    const spans = await micSpeech(micRaw, session.meta.micOffset ?? 0);
    for (const [a, b] of spans) { cues.push({ t: a, talk: true }); cues.push({ t: b, talk: false }); }
    log(`[devatar] ${spans.length} speech spans from the mic\n`);
  } else log("[devatar] no mic track — the mouth will stay closed\n");
  cues.sort((a, b) => a.t - b.t);
  log(`[devatar] ${total} frames @ ${fps} fps, ${cues.length} cues\n`);

  const av = cfg.dev?.avatar ?? { x: 982, y: 352, scale: 0.9 };
  const win = new BrowserWindow({ show: false, width: 1920, height: 1080, webPreferences: { backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, "../renderer/devatar.html"), {
    query: { manual: "1", seed: String(cfg.glitch.seed), x: String(av.x), y: String(av.y), scale: String(av.scale) },
  });

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
