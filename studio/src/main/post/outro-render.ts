// Render the branded outro from the session log: phase timings come from what Glitch actually said and how long it took.
import { BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config";
import { ffmpeg } from "./exec";
import type { Log } from "./pipeline";

const SLAM = 1.0, OUT = 1.3;

/** Latest outro run in the log → { t0, t1, phases[] } in seconds since record start, or null. */
export function outroSpan(session: any): { t0: number; t1: number; phases: any[]; start: any } | null {
  const t0 = session.meta.startedAt; const rel = (t: number) => (t - t0) / 1000;
  const evs = [...session.events].sort((a: any, b: any) => a.t - b.t);
  const starts = evs.filter((e: any) => e.kind === "outro-start"); if (!starts.length) return null;
  const start = starts[starts.length - 1];
  const after = evs.filter((e: any) => e.t >= start.t);
  const end = after.find((e: any) => e.kind === "outro-end" || e.kind === "session-stop" || e.kind === "rewind" || e.kind === "reset");
  const t1 = end ? rel(end.t) : rel(evs.at(-1)?.t ?? start.t) + OUT;
  const phaseEvs = after.filter((e: any) => e.kind === "outro-phase" && (!end || e.t <= end.t));
  const phases = phaseEvs.map((p: any, i: number) => ({ ...p, start: rel(p.t) - rel(start.t), end: (i + 1 < phaseEvs.length ? rel(phaseEvs[i + 1].t) : t1 - OUT) - rel(start.t) }));
  return { t0: rel(start.t), t1, phases, start };
}

export async function renderOutro(dir: string, session: any, log: Log): Promise<string> {
  const span = outroSpan(session);
  if (!span) { log("[outro] no outro in this session\n"); return "none"; }
  const out = path.join(dir, "outro.webm");
  const total = span.t1 - span.t0;
  const fps = Number(process.env.METRIK_GLITCH_FPS) || 30;
  const frames = Math.ceil(total * fps);
  const cfg = loadConfig();
  const t0abs = session.meta.startedAt + span.t0 * 1000;
  const cues: any[] = [];
  for (const e of session.events) {
    const t = (e.t - t0abs) / 1000; if (t < 0 || t > total) continue;
    if (e.kind === "mood") cues.push({ t, mood: e.mood, hold: e.hold });
    else if (e.kind === "line-start" && e.actor === "Glitch" && e.spoken) { cues.push({ t, talk: true }); if (e.duration) cues.push({ t: t + e.duration / 1000, talk: false }); }
    else if (e.kind === "line-end" && e.actor === "Glitch") cues.push({ t, talk: false });
  }
  cues.sort((a, b) => a.t - b.t);
  const phases = span.phases.map((p: any) => ({ phase: p.phase, title: p.title, subtitle: p.subtitle ?? "", names: p.names ?? [], start: Math.max(SLAM, p.start), end: Math.min(total - OUT, p.end) }));
  log(`[outro] ${total.toFixed(1)} s, ${phases.length} phases, ${frames} frames @ ${fps} fps\n`);

  const win = new BrowserWindow({ show: false, width: 1920, height: 1080, webPreferences: { backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, "../renderer/outro.html"));
  await win.webContents.executeJavaScript(`outro.setup(${JSON.stringify({ phases, total, seed: cfg.glitch.seed, cues })})`, true);
  // sound design first (fast), then frames
  const wavB64: string = await win.webContents.executeJavaScript("outro.audio()");
  const wavPath = path.join(dir, "outro-sfx.wav"); fs.writeFileSync(wavPath, Buffer.from(wavB64, "base64"));
  const tmp = path.join(dir, "_outro-video.webm");
  let ffErr = "";
  const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "-", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", "-row-mt", "1", "-threads", "8", "-speed", "2", "-b:v", "0", "-crf", "20", tmp]);
  ff.stderr.on("data", (d) => { ffErr += d; });
  const done = new Promise<void>((res, rej) => ff.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}: ${ffErr.slice(-300)}`))))); done.catch(() => {});
  try {
    for (let f = 0; f < frames; f++) {
      const dataUrl: string = await win.webContents.executeJavaScript(`outro.step(${fps}, ${f}); outro.frame()`);
      const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
      if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once("drain", r));
      if (f % (fps * 5) === 0) log(`[outro] ${Math.round((f / frames) * 100)}%\n`);
    }
  } finally { ff.stdin.end(); win.destroy(); }
  await done;
  await ffmpeg(["-y", "-i", tmp, "-i", wavPath, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-af", "loudnorm=I=-18:TP=-1.5:LRA=9", "-c:a", "libopus", "-b:a", "160k", "-shortest", out], log);
  fs.rmSync(tmp, { force: true });
  return `${path.basename(out)} (${total.toFixed(1)} s)`;
}
