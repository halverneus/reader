import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DEFAULTS, deepMerge, type Config } from "../shared/config";

export { DEFAULTS, deepMerge } from "../shared/config";
export type { Config } from "../shared/config";

const home = os.homedir();


const file = () => path.join(app.getPath("userData"), "config.json");
let cache: Config | null = null;

export function loadConfig(): Config {
  if (cache) return cache;
  let c: any = {};
  try { c = JSON.parse(fs.readFileSync(file(), "utf8")); } catch {}
  // devices chosen back when OBS did the capturing carry over
  if (c.obs && !c.capture) c.capture = { camDevice: c.obs.camDevice || DEFAULTS.capture.camDevice, micDevice: c.obs.micDevice ?? "" };
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
