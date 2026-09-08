// Offline matting: cam.mkv → dev-alpha.webm (VP9 with alpha, mic audio kept) using RVM in a GPU Docker container.
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { run, ffmpeg } from "./exec";
import type { Log } from "./pipeline";

const IMAGE = "metrik-matte";

function dockerDir(): string {
  // packaged: resources/docker/matte ; dev: studio/docker/matte
  const cands = [path.join(process.resourcesPath ?? "", "docker/matte"), path.join(app.getAppPath(), "docker/matte"), path.join(__dirname, "../../docker/matte"), path.join(__dirname, "../../../docker/matte")];
  return cands.find((p) => fs.existsSync(path.join(p, "Dockerfile")))!;
}

export async function ensureImage(log: Log) {
  const have = await run("docker", ["image", "inspect", IMAGE], log, { quiet: true }).then(() => true).catch(() => false);
  if (have) return;
  log(`[matte] building ${IMAGE} (one-time, downloads PyTorch + RVM weights, several minutes)\n`);
  await run("docker", ["build", "-t", IMAGE, dockerDir()], log);
}

export async function matteCam(dir: string, session: any, log: Log): Promise<string> {
  const cam = session.meta?.files?.cam && fs.existsSync(session.meta.files.cam) ? session.meta.files.cam : findCam(dir);
  if (!cam) throw new Error("No cam recording (cam*.mkv) in the session folder");
  const out = path.join(dir, "dev-alpha.webm");
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs > fs.statSync(cam).mtimeMs) return "exists";
  await ensureImage(log);
  const fgr = path.join(dir, "_fgr.mp4"), pha = path.join(dir, "_pha.mp4");
  const variant = process.env.METRIK_MATTE_VARIANT || "resnet50";
  await run("docker", ["run", "--rm", "--gpus", "all", "-v", `${dir}:/work`, IMAGE, `/work/${path.basename(cam)}`, "/work/_fgr.mp4", "/work/_pha.mp4", "--variant", variant, "--downsample", "0.25"], log);
  // Merge color + alpha → VP9 alpha WebM; keep the cam's audio (mic) for alignment/reference.
  log("[matte] encoding dev-alpha.webm (libvpx-vp9 yuva420p)\n");
  await ffmpeg(["-y", "-i", fgr, "-i", pha, "-i", cam, "-filter_complex", "[0:v][1:v]alphamerge,format=yuva420p[v]", "-map", "[v]", "-map", "2:a:0?", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", "-row-mt", "1", "-threads", "8", "-speed", "2", "-b:v", "0", "-crf", "22", "-c:a", "libopus", "-b:a", "128k", out], log);
  fs.rmSync(fgr, { force: true }); fs.rmSync(pha, { force: true });
  return path.basename(out);
}

export function findCam(dir: string): string | undefined {
  return fs.readdirSync(dir).filter((f) => /^cam.*\.(mkv|mp4|mov)$/i.test(f)).map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}
export function findDesktop(dir: string): string | undefined {
  return fs.readdirSync(dir).filter((f) => /^desktop.*\.(mkv|mp4|mov)$/i.test(f)).map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}
