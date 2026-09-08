// Find the offset between the cam file and the desktop file by cross-correlating their mic audio envelopes.
// Both files carry the same mic (OBS track 1), so this is exact to ~10 ms. Result saved in session.json as meta.camOffset.
import fs from "node:fs";
import path from "node:path";
import { run } from "./exec";
import { findCam, findDesktop } from "./matte";
import type { Log } from "./pipeline";

const RATE = 1000; // envelope samples per second

async function envelope(file: string, seconds: number): Promise<Float32Array> {
  // 8 kHz mono PCM → RMS per 1 ms
  const pcm = await run("ffmpeg", ["-v", "error", "-i", file, "-t", String(seconds), "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"], () => {}, { quiet: true }).catch(() => "");
  const buf = Buffer.from(pcm, "binary");
  const n = Math.floor(buf.length / 2), per = 8000 / RATE, out = new Float32Array(Math.floor(n / per));
  for (let i = 0; i < out.length; i++) { let s = 0; for (let k = 0; k < per; k++) { const v = buf.readInt16LE((i * per + k) * 2) / 32768; s += v * v; } out[i] = Math.sqrt(s / per); }
  // normalise + remove DC so correlation is meaningful
  let mean = 0; for (const v of out) mean += v; mean /= out.length || 1;
  for (let i = 0; i < out.length; i++) out[i] -= mean;
  return out;
}

export async function alignCam(dir: string, session: any, log: Log): Promise<string> {
  const cam = findCam(dir), desk = findDesktop(dir);
  if (!cam || !desk) { log("[align] need both cam*.mkv and desktop*.mkv; skipping (offset = 0)\n"); return "skipped"; }
  const a = await envelope(desk, 120), b = await envelope(cam, 120);
  if (a.length < RATE * 5 || b.length < RATE * 5) { log("[align] not enough audio to correlate; offset = 0\n"); return "no audio"; }
  const maxLag = RATE * 10; let best = 0, bestLag = 0;
  const n = Math.min(a.length, b.length);
  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    let s = 0, c = 0;
    for (let i = Math.max(0, -lag); i < n && i + lag < n; i += 2) { s += a[i + lag] * b[i]; c++; }
    if (c > RATE && s / c > best) { best = s / c; bestLag = lag; }
  }
  // positive lag: cam audio at time t matches desktop at t+lag → cam starts `lag` ms EARLIER than desktop
  const offset = bestLag / RATE;
  log(`[align] cam offset vs desktop: ${offset.toFixed(3)} s (score ${best.toExponential(2)})\n`);
  session.meta.camOffset = offset;
  fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify(session, null, 1));
  return `${offset.toFixed(3)} s`;
}
