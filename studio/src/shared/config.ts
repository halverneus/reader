// Config shape and defaults. Electron-free on purpose: the MCP server reads the
// same file without pulling in `app`, so there is one Config and one set of
// defaults rather than a second copy that drifts (2026-10-22).
import path from "node:path";
import os from "node:os";

export interface Config {
  scriptsRoot: string;
  lastScript?: string;
  recordingsRoot: string;
  brandingDir: string;
  kdenliveTemplate: string;
  projectsDir: string;
  obs: { host: string; port: number; password: string; camDevice: string; micDevice: string };
  capture: {
    backend: "gstreamer" | "obs";
    desktopMode: "portal" | "test" | "node"; desktopTarget: string; restoreToken: string;
    width: number; height: number; fps: number; desktopKbps: number;
    camDevice: string; camWidth: number; camHeight: number; camFps: number; camKbps: number;
    micDevice: string;
    key: { enabled: boolean; color: string; similarity: number; smoothness: number; spill: number };
  };
  /** autoRender: Run everything also renders the project to an MP4 in renderDir */
  post: { autoRender: boolean; renderDir: string };
  /** denoise: build mic-clean.flac in post and edit with it (raw mic.flac is always kept) */
  audio: { denoise: boolean };
  /** course code from the script path (e.g. "CS235") → folder/name used for recordings and projects (e.g. "MySQL") */
  courseFolders: Record<string, string>;
  /** course folder name → branding thumbnail file chosen last for that course */
  courseThumbnails: Record<string, string>;
  voices: Record<string, string>;
  actorModes: Record<string, "read" | "skip" | "hide">;
  anthropicApiKey: string;
  model: string;
  vm: { uri: string; domain: string; width: number; height: number };
  kokoro: { url: string; autoStart: boolean; image: string };
  /** Dev's cloned voice (F5-TTS), served by voice/devvoice.py out of a venv
   *  that has torch. `refWav` + `refText` are the zero-shot reference. */
  devVoice: { url: string; autoStart: boolean; python: string; refWav: string; refText: string; cache: string };
  /** size: Glitch's arm + head relative to the original design (0.75 since 2026-09-13). `scale` is unused. */
  glitch: { homeY: number; seed: number; scale: number; size: number };
  dev: { rect: { x: number; y: number; w: number; h: number }; leftX: number; avatar?: { x: number; y: number; scale: number } };
}

const home = os.homedir();
export const DEFAULTS: Config = {
  scriptsRoot: path.join(home, "Dev/wwcc/rex/docs/Courses"),
  recordingsRoot: path.join(home, "Videos/Projects/Content"),
  brandingDir: path.join(home, "Videos/Projects/Content/Metrik Rule/Branding"),
  kdenliveTemplate: path.join(home, "Videos/Projects/Csharp/Bare Template.kdenlive"),
  projectsDir: path.join(home, "Videos/Projects"),
  obs: { host: "127.0.0.1", port: 4455, password: "", camDevice: "/dev/video3", micDevice: "" },
  capture: {
    backend: "gstreamer",
    desktopMode: "portal", desktopTarget: "", restoreToken: "",
    width: 1920, height: 1080, fps: 60, desktopKbps: 16000,
    camDevice: "/dev/video3", camWidth: 1920, camHeight: 1080, camFps: 30, camKbps: 12000,
    micDevice: "",
    key: { enabled: true, color: "#00ff01", similarity: 0.4, smoothness: 0.08, spill: 0.5 },
  },
  post: { autoRender: false, renderDir: path.join(home, "Videos") },
  audio: { denoise: true },
  courseFolders: { CS235: "MySQL" },
  courseThumbnails: {},
  // Dev's voice went unused for a year because his lines were always read on
  // camera; bf_alice is a British woman, which nobody noticed until the Script
  // view grew a read button for him.
  voices: { Glitch: "am_puck", Dev: "dev-clone" },
  actorModes: { Dev: "skip", Glitch: "read" },
  anthropicApiKey: "",
  model: "claude-opus-5",
  vm: { uri: "qemu:///session", domain: "", width: 1920, height: 1080 },
  kokoro: { url: "http://localhost:8880", autoStart: true, image: "ghcr.io/remsky/kokoro-fastapi-gpu:latest" },
  devVoice: {
    url: "http://127.0.0.1:8899", autoStart: true,
    python: `${process.env.HOME}/.cache/devavatar/venv/bin/python`,
    refWav: `${process.env.HOME}/.cache/devavatar/dataset/wavs/Week-03-01-CRUD-2026-09-27-17-00-m400-t1.wav`,
    refText: "Before we do, there is a piece of vocabulary worth having. Four words that describe almost everything any program ever does to stored data.",
    cache: `${process.env.HOME}/.cache/devavatar/voicecache`,
  },
  glitch: { homeY: 300, seed: 7, scale: 1, size: 0.75 },
  // avatar x/y/scale place the drawn bust where the matted camera puts the
  // real one, so a cross-fade lands head on head. Nudge if the swap drifts.
  dev: { rect: { x: 1152, y: 648, w: 768, h: 432 }, leftX: 0, avatar: { x: 965, y: 357, scale: 1.363 } },
};

export function deepMerge<T>(a: T, b: any): T {
  if (!b || typeof b !== "object" || Array.isArray(b)) return (b ?? a) as T;
  const out: any = { ...(a as any) };
  for (const k of Object.keys(b)) out[k] = typeof out[k] === "object" && out[k] && !Array.isArray(out[k]) ? deepMerge(out[k], b[k]) : b[k];
  return out;
}

/** Electron's userData dir on each platform, without importing electron. */
export function userDataDir(appName = "Metrik Studio"): string {
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library/Application Support", appName);
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(home, "AppData/Roaming"), appName);
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), appName);
}
