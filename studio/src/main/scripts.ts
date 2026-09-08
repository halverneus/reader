import { ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, saveConfig } from "./config";
import type { ScriptFileInfo } from "../shared/ipc";

/** Walk <scriptsRoot>/<course>/Course/<week>/<lesson>/Script.yml */
export function listScripts(): ScriptFileInfo[] {
  const root = loadConfig().scriptsRoot;
  const out: ScriptFileInfo[] = [];
  if (!fs.existsSync(root)) return out;
  const walk = (dir: string, depth: number, crumbs: string[]) => {
    let ents: fs.Dirent[] = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name === "Script.yml") {
        const st = fs.statSync(p);
        const [course = "", , week = "", lesson = ""] = crumbs; // course / "Course" / week / lesson
        out.push({ path: p, course, week, lesson: lesson || path.basename(dir), mtime: st.mtimeMs });
      } else if (e.isDirectory() && depth < 5 && !e.name.startsWith(".")) walk(p, depth + 1, [...crumbs, e.name]);
    }
  };
  walk(root, 0, []);
  return out.sort((a, b) => a.course.localeCompare(b.course) || a.week.localeCompare(b.week) || a.lesson.localeCompare(b.lesson));
}

const TEMPLATE = `script:

# === STANDARD OPENING ===
# Describe the VM's starting state for the editor, then reset it with keys.

- type: "editor"
  start: 0
  end: 100
  text: |
    Describe what is open in the VM before recording starts.

- type: "line"
  actor: "Dev"
  start: 100
  end: 200
  text: "Greetings! I'm Dev the Developer!"

- type: "line"
  actor: "Glitch"
  start: 200
  end: 300
  mood: "excited"
  text: "...and I'm Glitch!"

- type: "line"
  actor: "Dev"
  start: 300
  end: 400
  text: |
    Today we are going to talk about LESSON_TITLE.

- type: "editor"
  start: 400
  end: 500
  text: "Roll Intro"

# === LESSON BODY ===

- type: "line"
  actor: "Dev"
  start: 500
  end: 600
  text: |
    First line after the intro.

# === STANDARD CLOSING ===

- type: "line"
  actor: "Dev"
  start: 9000
  end: 9100
  text: |
    Content-specific transition... Don't just watch it... Do it!

- type: "outro"
  start: 9100
  end: 9200
  next: ""
  thanks: []
`;

export function registerScriptIpc() {
  ipcMain.handle("scripts:courses", () => {
    const root = loadConfig().scriptsRoot; const out: { course: string; weeks: string[] }[] = [];
    try { for (const c of fs.readdirSync(root, { withFileTypes: true })) { if (!c.isDirectory() || c.name.startsWith(".")) continue; const cd = path.join(root, c.name, "Course"); let weeks: string[] = []; try { weeks = fs.readdirSync(cd, { withFileTypes: true }).filter((w) => w.isDirectory()).map((w) => w.name).sort(); } catch {} out.push({ course: c.name, weeks }); } } catch {}
    return out;
  });
  ipcMain.handle("scripts:create", (_e, { course, week, lesson }: { course: string; week: string; lesson: string }) => {
    const bad = (s: string) => !s || /[\/\\]/.test(s) || s.trim() !== s;
    if (bad(course) || bad(week) || bad(lesson)) throw new Error("Course, week and lesson names must be non-empty and contain no slashes");
    const dir = path.join(loadConfig().scriptsRoot, course, "Course", week, lesson);
    const p = path.join(dir, "Script.yml");
    if (fs.existsSync(p)) throw new Error(`Script already exists: ${p}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, TEMPLATE.replace("LESSON_TITLE", lesson.replace(/^\d+\s*-\s*/, "").toLowerCase()));
    saveConfig({ lastScript: p });
    return p;
  });
  ipcMain.handle("scripts:list", () => listScripts());
  ipcMain.handle("scripts:read", (_e, p: string) => { saveConfig({ lastScript: p }); return fs.readFileSync(p, "utf8"); });
  ipcMain.handle("scripts:write", (_e, p: string, text: string) => {
    if (fs.existsSync(p)) { try { fs.copyFileSync(p, p + ".bak"); } catch {} }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  });
  ipcMain.handle("scripts:rules", () => {
    const p = path.join(loadConfig().scriptsRoot, "Scripting Rules.md");
    try { return fs.readFileSync(p, "utf8"); } catch { return ""; }
  });
}
