// Self-checks for every external dependency, surfaced in Settings and via `--diagnose`.
import { ipcMain } from "electron";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { loadConfig } from "./config";
import { pollKokoro } from "./tts";
import { findVm } from "./vm";
import { obs, nvencAvailable, SRC } from "./obs";

const sh = (cmd: string, args: string[], ms = 8000) => new Promise<{ ok: boolean; out: string }>((res) => execFile(cmd, args, { timeout: ms }, (err, stdout, stderr) => res({ ok: !err, out: (stdout || stderr || String(err?.message ?? "")).trim().slice(0, 300) })));

export interface Check { id: string; label: string; ok: boolean | null; detail: string; fix?: string }

export async function diagnose(): Promise<Check[]> {
  const cfg = loadConfig(); const out: Check[] = [];
  const add = (id: string, label: string, ok: boolean | null, detail: string, fix?: string) => out.push({ id, label, ok, detail, fix });

  const ff = await sh("ffmpeg", ["-version"]); add("ffmpeg", "ffmpeg", ff.ok, ff.out.split("\n")[0], "Install ffmpeg (brew install ffmpeg) — needed for post");
  const fp = await sh("ffprobe", ["-version"]); add("ffprobe", "ffprobe", fp.ok, fp.out.split("\n")[0]);
  const vp9 = await sh("ffmpeg", ["-hide_banner", "-encoders"]); add("vp9", "libvpx-vp9 encoder (alpha clips)", vp9.ok && /libvpx-vp9/.test(vp9.out + (await sh("ffmpeg", ["-hide_banner", "-h", "encoder=libvpx-vp9"])).out), "", "ffmpeg without libvpx: alpha clips cannot be encoded");
  const dk = await sh("docker", ["info", "--format", "{{.Runtimes}} {{.ServerVersion}}"]); add("docker", "Docker", dk.ok, dk.out, "Docker is needed for Kokoro TTS and matting");
  const gpu = await sh("docker", ["info", "--format", "{{json .Runtimes}}"]); add("docker-gpu", "Docker GPU (nvidia CDI)", dk.ok ? /nvidia|cdi/i.test(gpu.out) || fs.existsSync("/etc/cdi/nvidia.yaml") || fs.existsSync("/var/run/cdi/nvidia.yaml") : null, gpu.ok ? "cdi / nvidia runtime present" : "", "Install nvidia-container-toolkit and generate CDI spec");
  const nv = await sh("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader"]); add("gpu", "NVIDIA GPU", nv.ok, nv.out);
  add("kokoro", "Kokoro TTS", (await pollKokoro()) === "ready", cfg.kokoro.url, "Start the container (Settings → Kokoro) or wait for auto-start");
  const vm = findVm(); add("vm", "VM (libvirt)", !!vm, vm ? `${vm.domain} @ ${vm.uri}` : "no running domain", "Start the GNOME Boxes VM before recording");
  const obsRun = (await sh("sh", ["-c", "pgrep -f com.obsproject.Studio >/dev/null && echo yes || echo no"])).out === "yes";
  add("obs", "OBS running", obsRun, obsRun ? "running" : "not running", "Record tab → Connect launches OBS with the websocket enabled");
  const connected = obsRun ? await obs.connect() : false;
  add("obs-ws", "OBS websocket", obsRun ? connected : null, connected ? `ws://${cfg.obs.host}:${cfg.obs.port}` : obs.message, "Enable Tools → WebSocket Server Settings in OBS");
  if (connected) {
    try {
      const kinds: any = await obs.ws.call("GetSourceFilterKindList");
      add("obs-sr", "OBS Source Record plugin", (kinds.sourceFilterKinds ?? []).includes("source_record_filter"), "", "flatpak install flathub com.obsproject.Studio.Plugin.SourceRecord");
      const inputs: any = await obs.ws.call("GetInputList");
      add("obs-scene", "Metrik scene configured", inputs.inputs.some((i: any) => i.inputName === SRC.cam), inputs.inputs.map((i: any) => i.inputName).join(", "), "Record tab → Setup scene");
    } catch (e: any) { add("obs-sr", "OBS plugin check", null, e.message); }
  }
  add("nvenc", "OBS NVENC (from last OBS log)", nvencAvailable(), nvencAvailable() ? "available" : "not seen in log → x264 fallback", "Update the flatpak nvidia runtime to match the host driver");
  add("cam", "Webcam device", fs.existsSync(cfg.obs.camDevice), cfg.obs.camDevice, "Plug in / start the phone camera app");
  add("scripts", "Courses root", fs.existsSync(cfg.scriptsRoot), cfg.scriptsRoot);
  add("branding", "Branding folder", fs.existsSync(cfg.brandingDir), cfg.brandingDir);
  add("kdenlive", "Kdenlive (flatpak)", (await sh("flatpak", ["info", "org.kde.kdenlive"])).ok, "org.kde.kdenlive");
  add("api", "Anthropic API key", !!(cfg.anthropicApiKey || process.env.ANTHROPIC_API_KEY), cfg.anthropicApiKey ? "from settings" : process.env.ANTHROPIC_API_KEY ? "from environment" : "missing", "Settings → Claude");
  const df = await sh("df", ["-h", "--output=avail", cfg.recordingsRoot]); add("disk", "Free space for recordings", df.ok, df.out.split("\n").pop() ?? "", "Alpha clips are large; keep >20 GB free");
  return out;
}
export function registerDiagnoseIpc() { ipcMain.handle("diagnose", () => diagnose()); }
