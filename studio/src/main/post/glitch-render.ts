// Render Glitch deterministically from the session's cue log into glitch.webm (VP9 + alpha), 1920x1080.
// An offscreen BrowserWindow steps the same driver the live view used, one frame at a time.
import { BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config";
import type { Log } from "./pipeline";

export async function renderGlitch(dir: string, session: any, log: Log): Promise<string> {
  const out = path.join(dir, "glitch.webm");
  const t0: number = session.meta.startedAt;
  const tEnd: number = session.meta.stoppedAt ?? (session.events.at(-1)?.t ?? t0);
  const durationS = Math.max(1, (tEnd - t0) / 1000 + 1);
  const fps = Number(process.env.METRIK_GLITCH_FPS) || 30;
  const total = Math.ceil(durationS * fps);
  const cfg = loadConfig();
  // Cue list in seconds from record start
  type Cue = { t: number; mood?: string; hold?: number; talk?: boolean; slide?: string; over?: number; y?: number };
  const cues: Cue[] = [];
  for (const e of session.events) {
    const t = (e.t - t0) / 1000;
    if (e.kind === "mood") cues.push({ t, mood: e.mood, hold: e.hold });
    else if (e.kind === "slide" && e.actor === "Glitch") cues.push({ t, slide: e.to, over: e.over });
    else if (e.kind === "line-start" && e.actor === "Glitch" && e.spoken) { cues.push({ t, talk: true }); if (e.duration) cues.push({ t: t + e.duration / 1000, talk: false }); }
    else if (e.kind === "line-end" && e.actor === "Glitch") cues.push({ t, talk: false });
    else if (e.kind === "reset") cues.push({ t, mood: "neutral", slide: "show", y: cfg.glitch.homeY });
  }
  cues.sort((a, b) => a.t - b.t);
  log(`[glitch] ${total} frames @ ${fps} fps, ${cues.length} cues\n`);

  const win = new BrowserWindow({ show: false, width: 1920, height: 1080, webPreferences: { backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, "../renderer/glitch.html"), { query: { manual: "1", seed: String(cfg.glitch.seed), y: String(cfg.glitch.homeY), size: String(cfg.glitch.size ?? 1) } });

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
        const js = [c.mood ? `glitch.mood(${JSON.stringify(c.mood)}, ${c.hold ?? 0});` : "", c.talk != null ? `glitch.talk(${c.talk});` : "", c.slide ? `glitch.slide(${JSON.stringify(c.slide)}, ${c.over ?? 600});` : "", c.y != null ? `glitch.slide(${c.y}, 300);` : ""].join("");
        if (js) await win.webContents.executeJavaScript(js);
      }
      const dataUrl: string = await win.webContents.executeJavaScript(`glitch.step(${fps}, ${f}); glitch.frame()`);
      const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
      if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once("drain", r));
      if (f % (fps * 10) === 0) log(`[glitch] ${Math.round((f / total) * 100)}%\n`);
    }
  } finally { ff.stdin.end(); win.destroy(); }
  await done;
  return `${path.basename(out)} (${total} frames)`;
}
