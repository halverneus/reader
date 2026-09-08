import { app } from "electron";
import fs from "node:fs";
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
  voices: Record<string, string>;
  actorModes: Record<string, "read" | "skip" | "hide">;
  anthropicApiKey: string;
  model: string;
  vm: { uri: string; domain: string; width: number; height: number };
  kokoro: { url: string; autoStart: boolean; image: string };
  glitch: { homeY: number; seed: number; scale: number };
  dev: { rect: { x: number; y: number; w: number; h: number }; leftX: number };
}

const home = os.homedir();
export const DEFAULTS: Config = {
  scriptsRoot: path.join(home, "Dev/wwcc/rex/docs/Courses"),
  recordingsRoot: path.join(home, "Videos/Projects/Content"),
  brandingDir: path.join(home, "Videos/Projects/Content/Metrik Rule/Branding"),
  kdenliveTemplate: path.join(home, "Videos/Projects/Csharp/Bare Template.kdenlive"),
  projectsDir: path.join(home, "Videos/Projects"),
  obs: { host: "127.0.0.1", port: 4455, password: "", camDevice: "/dev/video3", micDevice: "" },
  voices: { Glitch: "am_puck", Dev: "bf_alice" },
  actorModes: { Dev: "skip", Glitch: "read" },
  anthropicApiKey: "",
  model: "claude-opus-5",
  vm: { uri: "qemu:///session", domain: "", width: 1920, height: 1080 },
  kokoro: { url: "http://localhost:8880", autoStart: true, image: "ghcr.io/remsky/kokoro-fastapi-gpu:latest" },
  glitch: { homeY: 300, seed: 7, scale: 1 },
  dev: { rect: { x: 1152, y: 648, w: 768, h: 432 }, leftX: 0 },
};

const file = () => path.join(app.getPath("userData"), "config.json");
let cache: Config | null = null;

export function loadConfig(): Config {
  if (cache) return cache;
  let c: any = {};
  try { c = JSON.parse(fs.readFileSync(file(), "utf8")); } catch {}
  // migrate the old reader config's voices if present
  try {
    const old = JSON.parse(fs.readFileSync(path.join(home, ".config/reader/config.json"), "utf8"));
    c.voices = { ...DEFAULTS.voices, ...(old.voice_assignments ?? {}), ...(c.voices ?? {}) };
    if (!c.lastScript && old.last_dir && fs.existsSync(path.join(old.last_dir, "Script.yml"))) c.lastScript = path.join(old.last_dir, "Script.yml");
  } catch {}
  cache = deepMerge(structuredClone(DEFAULTS), c);
  // OBS password: read from the flatpak config if not set
  if (!cache!.obs.password) {
    try { const j = JSON.parse(fs.readFileSync(path.join(home, ".var/app/com.obsproject.Studio/config/obs-studio/plugin_config/obs-websocket/config.json"), "utf8")); cache!.obs.password = j.server_password ?? ""; cache!.obs.port = j.server_port ?? 4455; } catch {}
  }
  return cache!;
}
export function saveConfig(patch: Partial<Config>): Config {
  cache = deepMerge(loadConfig(), patch);
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cache, null, 2));
  return cache;
}
function deepMerge<T>(a: T, b: any): T {
  if (!b || typeof b !== "object" || Array.isArray(b)) return (b ?? a) as T;
  const out: any = { ...(a as any) };
  for (const k of Object.keys(b)) out[k] = typeof out[k] === "object" && out[k] && !Array.isArray(out[k]) ? deepMerge(out[k], b[k]) : b[k];
  return out;
}
