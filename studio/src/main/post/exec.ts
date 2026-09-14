import { spawn } from "node:child_process";
import type { Log } from "./pipeline";

export function run(cmd: string, args: string[], log: Log, opts: { quiet?: boolean; input?: Buffer } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!opts.quiet) log(`$ ${cmd} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}\n`);
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; if (!opts.quiet) log(String(d)); });
    p.stderr.on("data", (d) => { err += d; if (!opts.quiet) log(String(d)); });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-400)}`))));
    if (opts.input) p.stdin.end(opts.input); else p.stdin.end();
  });
}
export const ffmpeg = (args: string[], log: Log) => run("ffmpeg", ["-hide_banner", "-loglevel", "warning", "-stats", ...args], log);
export async function ffprobeJson(file: string): Promise<any> {
  const out = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=index,codec_type,codec_name,width,height,r_frame_rate,duration,nb_frames", "-of", "json", file], () => {}, { quiet: true });
  return JSON.parse(out);
}
export async function durationOf(file: string): Promise<number> { const j = await ffprobeJson(file); return parseFloat(j.format?.duration ?? "0"); }
/** 100 ms RMS levels of an audio file as [seconds, dBFS] (silence → −120). */
export function rmsEnvelope(file: string): Promise<[number, number][]> {
  return new Promise((resolve) => {
    const p = spawn("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", "aresample=48000,asetnsamples=n=4800,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level", "-f", "null", "-"]);
    let err = ""; p.stderr.on("data", (d) => (err += d)); p.on("error", () => resolve([]));
    p.on("close", () => {
      const frames: [number, number][] = []; let t = 0;
      for (const line of err.split("\n")) {
        const pt = line.match(/pts_time:(-?[\d.]+)/); if (pt) t = +pt[1];
        const lv = line.match(/RMS_level=(-?[\d.]+|-inf)/); if (lv) frames.push([t, lv[1] === "-inf" ? -120 : +lv[1]]);
      }
      resolve(frames);
    });
  });
}
/** Level (dBFS) below which the quietest `p` of 100 ms windows fall — the recording's noise floor at p = 0.1. */
export const percentileDb = (frames: [number, number][], p: number) => { const s = frames.map(([, v]) => v).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length * p)] : -60; };
