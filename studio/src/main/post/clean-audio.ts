// Mic clean-up for the edit (the OBS noise filter, ported): low cut for fan rumble → RNNoise for broadband fan/hiss →
// a soft gate that turns what's left down ~24 dB between phrases. mic.flac is never touched; Kdenlive gets
// mic-clean.flac on the timeline and the raw file in the bin.
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { ffmpeg, rmsEnvelope, percentileDb } from "./exec";
import { loadConfig } from "../config";
import type { Log } from "./pipeline";

/** RNNoise model (GregorR/rnnoise-models "somnolent-hogwash", shipped in studio/models/rnnoise). */
export function rnnoiseModel(): string | undefined {
  const rel = "models/rnnoise/sh.rnnn";
  return [path.join(process.resourcesPath ?? "", rel), path.join(app.getAppPath(), rel), path.join(__dirname, "../../", rel), path.join(__dirname, "../../../", rel)].find((p) => fs.existsSync(p));
}

export async function cleanMic(dir: string, session: any, log: Log): Promise<string> {
  if (loadConfig().audio?.denoise === false) return "off (Settings → Capture)";
  const raw: string | undefined = [session.meta?.files?.mic, path.join(dir, "mic.flac")].find((f) => f && fs.existsSync(f));
  if (!raw) return "no mic.flac (nothing to clean)";
  const out = path.join(dir, "mic-clean.flac");
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs > fs.statSync(raw).mtimeMs) return "exists";
  // gate opens 12 dB above this recording's own noise floor (quietest 10% of 100 ms windows)
  const floor = percentileDb(await rmsEnvelope(raw), 0.1);
  const gateDb = Math.min(-30, Math.max(-55, floor + 12));
  const model = rnnoiseModel();
  const chain = [
    "highpass=f=80",
    model ? `arnndn=m='${model.replace(/'/g, "")}'` : "afftdn=nr=20:nf=-60:tn=1",
    `agate=threshold=${Math.pow(10, gateDb / 20).toFixed(5)}:ratio=4:range=0.06:attack=5:release=250`,
    // RNNoise works in 10 ms frames and hands audio back one frame late (measured 10 ms): trim it so lip sync is untouched
    ...(model ? ["atrim=start=0.010", "asetpts=PTS-STARTPTS"] : []),
  ].join(",");
  log(`[clean] noise floor ${floor.toFixed(1)} dB → gate at ${gateDb.toFixed(1)} dB · ${model ? "RNNoise" : "FFT denoise (RNNoise model not found)"}\n`);
  const tmp = path.join(dir, "_mic-clean.flac");
  // 16-bit like the recording (the filters work in float; left alone FLAC would store 32-bit and double the size)
  await ffmpeg(["-y", "-i", raw, "-af", chain, "-c:a", "flac", "-sample_fmt", "s16", tmp], log);
  fs.renameSync(tmp, out);
  return path.basename(out);
}
