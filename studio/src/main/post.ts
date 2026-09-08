// Post pipeline entry points (align → matte → glitch render → kdenlive). Implemented in ./post/*.
import { ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { broadcast } from "./index";
import { runPipeline } from "./post/pipeline";

export interface SessionRow { dir: string; name: string; started: string; takes: number; hasDesktop: boolean; hasCam: boolean; hasMatte: boolean; hasGlitch: boolean; hasOutro: boolean; hasProject: boolean }

export function listSessions(): SessionRow[] {
  const root = loadConfig().recordingsRoot; const out: SessionRow[] = [];
  const walk = (dir: string, depth: number) => {
    let ents: fs.Dirent[] = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (ents.some((e) => e.name === "session.json")) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8"));
        const takes = new Set(j.events.map((e: any) => e.take)).size || 1;
        const has = (re: RegExp) => ents.some((e) => re.test(e.name));
        out.push({ dir, name: j.meta.name ?? path.basename(dir), started: new Date(j.meta.startedAt).toLocaleString(), takes, hasDesktop: has(/^desktop.*\.(mkv|mp4)$/), hasCam: has(/^cam.*\.(mkv|mp4)$/), hasMatte: has(/^dev-alpha\.webm$/), hasGlitch: has(/^glitch\.webm$/), hasOutro: has(/^outro\.webm$/), hasProject: has(/\.kdenlive$/) });
      } catch {}
      return;
    }
    if (depth < 6) for (const e of ents) if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
  };
  walk(root, 0);
  return out.sort((a, b) => b.dir.localeCompare(a.dir));
}

export function registerPostIpc() {
  ipcMain.handle("post:sessions", () => listSessions());
  ipcMain.handle("post:run", (_e, dir: string, what: string) => runPipeline(dir, what, (steps) => broadcast("post:step", steps), (line) => broadcast("post:log", line)));
}
