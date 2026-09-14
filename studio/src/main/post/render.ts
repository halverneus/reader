// Render the session's Kdenlive project to an MP4 with Kdenlive's own renderer (melt inside the flatpak), using the
// settings of Jeromy's manual renders: H.264 CRF 23, GOP 15, 3 B-frames, AAC 160 k, 48 kHz stereo.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadConfig } from "../config";
import type { Log } from "./pipeline";

export async function renderVideo(dir: string, session: any, log: Log, progress: (detail: string) => void): Promise<string> {
  const proj: string | undefined = session.meta?.project;
  if (!proj || !fs.existsSync(proj)) throw new Error("No Kdenlive project yet — build it first (5)");
  // test hooks: METRIK_RENDER_DIR writes elsewhere without touching session.json; METRIK_RENDER_FRAMES renders a slice
  const testDir = process.env.METRIK_RENDER_DIR;
  const outDir = testDir || loadConfig().post?.renderDir || path.join(os.homedir(), "Videos");
  // melt runs inside Kdenlive's flatpak, which has its own private /tmp and can't see it on the host
  if (/^\/(tmp|var\/tmp|run)\//.test(path.resolve(outDir) + "/")) throw new Error(`Render folder ${outDir} isn't reachable from Kdenlive's flatpak — pick one under your home folder (Settings → Locations)`);
  fs.mkdirSync(outDir, { recursive: true });
  const name = path.basename(proj, ".kdenlive");
  let out = path.join(outDir, `${name}.mp4`);
  if (fs.existsSync(out)) out = path.join(outDir, `${name} (${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16)}).mp4`);
  const tmp = out.replace(/\.mp4$/, ".rendering.mp4"); // a half-finished render never looks like a finished video
  const range = process.env.METRIK_RENDER_FRAMES ? ["in=0", `out=${Math.max(1, +process.env.METRIK_RENDER_FRAMES) - 1}`] : [];
  const args = ["run", "--command=melt", "org.kde.kdenlive", proj, ...range, "-progress", "-consumer", `avformat:${tmp}`,
    "f=mp4", "vcodec=libx264", "preset=medium", "crf=23", "g=15", "bf=3", "acodec=aac", "ab=160k", "ar=48000", "channels=2", "real_time=-1", "threads=0"];
  log(`[render] ${proj}\n[render] → ${out}\n`);
  const t0 = Date.now();
  await new Promise<void>((resolve, reject) => {
    const p = spawn("flatpak", args);
    let buf = "", tail = "", last = -1;
    p.stderr.on("data", (d) => {
      buf += d; const lines = buf.split(/[\r\n]/); buf = lines.pop() ?? "";
      for (const line of lines) {
        const m = line.match(/percentage:\s*(\d+)/);
        if (m) {
          const pct = +m[1]; if (pct === last) continue; last = pct;
          const mins = (Date.now() - t0) / 60000, left = pct >= 3 ? Math.round((mins * (100 - pct)) / pct) : null;
          progress(`${pct}%${left != null ? ` · about ${left} min left` : ""}`);
          if (pct % 10 === 0) log(`[render] ${pct}%\n`);
        } else if (line.trim() && !/wav data size|QThreadStorage/.test(line)) tail = (tail + line + "\n").slice(-800);
      }
    });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0 && fs.existsSync(tmp) && fs.statSync(tmp).size > 0) return resolve();
      fs.rmSync(tmp, { force: true });
      reject(new Error(`render failed (melt exit ${code}): ${tail.trim().split("\n").slice(-2).join(" ")}`));
    });
  });
  fs.renameSync(tmp, out);
  log(`[render] done: ${out}\n`);
  if (!testDir) { session.meta.render = out; fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify(session, null, 1)); }
  return `${path.basename(out)} · ${Math.max(1, Math.round((Date.now() - t0) / 60000))} min`;
}
