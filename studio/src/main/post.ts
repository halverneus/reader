// Post pipeline entry points (align → matte → glitch render → kdenlive). Implemented in ./post/*.
import { ipcMain, shell, Notification } from "electron";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, saveConfig } from "./config";
import { broadcast } from "./index";
import { runPipeline } from "./post/pipeline";
import { pickThumbnail, projectUnedited } from "./post/kdenlive";
import { currentSession } from "./session";

export interface SessionRow { dir: string; name: string; started: string; takes: number; hasDesktop: boolean; hasCam: boolean; hasMatte: boolean; hasGlitch: boolean; hasOutro: boolean; hasProject: boolean; hasRender: boolean }

/** Desktop notification for long runs (you have probably walked away). */
function notify(title: string, body: string) {
  try { if (Notification.isSupported()) new Notification({ title, body }).show(); } catch {}
}
async function runAndNotify(dir: string, what: string) {
  try {
    await runPipeline(dir, what, (steps) => broadcast("post:step", steps), (line) => broadcast("post:log", line));
    if (what === "all" || what === "render") {
      let video = ""; try { video = JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8")).meta.render ?? ""; } catch {}
      const rendered = what === "render" || loadConfig().post?.autoRender;
      notify("Metrik Studio — post finished", rendered && video ? `Video ready: ${path.basename(video)}` : "Kdenlive project built");
    }
  } catch (e: any) {
    if (what === "all" || what === "render") notify("Metrik Studio — post failed", e.message);
    throw e;
  }
}

export function listSessions(): SessionRow[] {
  const root = loadConfig().recordingsRoot; const out: SessionRow[] = [];
  const walk = (dir: string, depth: number) => {
    let ents: fs.Dirent[] = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (ents.some((e) => e.name === "session.json")) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8"));
        const takes = new Set(j.events.map((e: any) => e.take)).size || 1;
        const has = (re: RegExp) => ents.some((e) => re.test(e.name));
        out.push({ dir, name: j.meta.name ?? path.basename(dir), started: new Date(j.meta.startedAt).toLocaleString(), takes, hasDesktop: has(/^desktop.*\.(mkv|mp4)$/), hasCam: has(/^cam.*\.(mkv|mp4)$/), hasMatte: has(/^dev-alpha\.webm$/), hasGlitch: has(/^glitch\.webm$/), hasOutro: has(/^outro\.webm$/), hasProject: has(/\.kdenlive$/) || (!!j.meta.project && fs.existsSync(j.meta.project)), hasRender: !!j.meta.render && fs.existsSync(j.meta.render) });
      } catch {}
      return;
    }
    if (depth < 6) for (const e of ents) if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
  };
  walk(root, 0);
  return out.sort((a, b) => b.dir.localeCompare(a.dir));
}

/** Branding thumbnails and the one this session will use. */
export function thumbnailsFor(dir: string) {
  const cfg = loadConfig(); const B = cfg.brandingDir;
  const files = fs.existsSync(B) ? fs.readdirSync(B).filter((f) => /thumbnail/i.test(f) && /\.png$/i.test(f)).sort() : [];
  let session: any = { meta: {} };
  try { session = JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8")); } catch {}
  return { dir: B, files, selected: pickThumbnail(session, cfg) ?? null };
}
/** Remember the choice on the session and as the course default for future sessions. */
export function setThumbnail(dir: string, file: string) {
  const f = path.join(dir, "session.json");
  const session = JSON.parse(fs.readFileSync(f, "utf8"));
  session.meta.thumbnail = file;
  fs.writeFileSync(f, JSON.stringify(session, null, 1));
  const course = (session.meta.name ?? "").split(" / ")[0]?.trim();
  if (course) saveConfig({ courseThumbnails: { [course]: file } } as any);
}

/** Only real session folders under the recordings root, and never the one being recorded. */
function checkedSession(dir: string): any {
  const root = path.resolve(loadConfig().recordingsRoot), d = path.resolve(dir);
  if (!d.startsWith(root + path.sep) || !fs.existsSync(path.join(d, "session.json"))) throw new Error(`Not a recording session: ${dir}`);
  if (currentSession()?.dir && path.resolve(currentSession()!.dir) === d) throw new Error("That session is still recording — stop it first");
  return JSON.parse(fs.readFileSync(path.join(d, "session.json"), "utf8"));
}
function dirBytes(d: string): number {
  let n = 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); n += e.isDirectory() ? dirBytes(p) : e.isFile() ? fs.statSync(p).size : 0; }
  return n;
}
export function sessionInfo(dir: string) {
  const session = checkedSession(dir);
  const project = session.meta.project && fs.existsSync(session.meta.project) ? session.meta.project as string : null;
  return { sizeGB: dirBytes(dir) / 1e9, project, projectEdited: project ? !projectUnedited(project, session) : false };
}
/** Start over: the session folder (and optionally its Kdenlive project) goes to the Trash, so it can be restored. */
export async function deleteSession(dir: string, withProject: boolean): Promise<string[]> {
  const session = checkedSession(dir);
  const trashed: string[] = [];
  const project = session.meta.project;
  if (withProject && project && fs.existsSync(project)) { await shell.trashItem(project); trashed.push(project); }
  await shell.trashItem(dir); trashed.push(dir);
  // tidy the now-empty lesson / week / course folders above it
  const root = path.resolve(loadConfig().recordingsRoot);
  for (let p = path.dirname(path.resolve(dir)); p.startsWith(root + path.sep); p = path.dirname(p)) {
    try { if (fs.readdirSync(p).length) break; fs.rmdirSync(p); } catch { break; }
  }
  return trashed;
}

export function registerPostIpc() {
  ipcMain.handle("post:sessionInfo", (_e, dir: string) => sessionInfo(dir));
  ipcMain.handle("post:deleteSession", (_e, dir: string, withProject: boolean) => deleteSession(dir, !!withProject));
  ipcMain.handle("post:thumbnails", (_e, dir: string) => thumbnailsFor(dir));
  ipcMain.handle("post:setThumbnail", (_e, dir: string, file: string) => setThumbnail(dir, file));
  ipcMain.handle("post:sessions", () => listSessions());
  ipcMain.handle("post:run", (_e, dir: string, what: string) => runAndNotify(dir, what));
}
