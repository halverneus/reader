// A recording session: one folder per take-set with the event log, TTS wavs, OBS recordings, and post outputs.
import { ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { obs } from "./obs";

export interface SessionMeta { dir: string; name: string; scriptPath: string; startedAt: number; stoppedAt?: number; recordStart?: number; files: { desktop?: string; cam?: string } }
let current: { meta: SessionMeta; events: any[]; flushTimer?: NodeJS.Timeout } | null = null;
export const currentSession = () => current?.meta ?? null;

/** Session dir: <recordingsRoot>/<Course short>/<Week>/<Lesson>/<timestamp>/ derived from the script path. */
function sessionDirFor(scriptPath: string): { dir: string; name: string } {
  const parts = scriptPath.split(path.sep);
  const i = parts.indexOf("Course");
  const course = i > 0 ? parts[i - 1] : "Misc";
  const week = i > 0 ? parts[i + 1] ?? "" : "";
  const lesson = i > 0 ? parts[i + 2] ?? "" : path.basename(path.dirname(scriptPath));
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
  const name = [course.split(" - ")[0], week, lesson].filter(Boolean).join(" / ");
  const dir = path.join(loadConfig().recordingsRoot, course.split(" - ")[0].trim(), week, lesson, stamp);
  return { dir, name };
}

function flush() {
  if (!current) return;
  const { meta, events } = current;
  fs.writeFileSync(path.join(meta.dir, "session.json"), JSON.stringify({ meta, events }, null, 1));
}

export async function startSession(scriptPath: string) {
  if (current) await stopSession();
  const { dir, name } = sessionDirFor(scriptPath);
  fs.mkdirSync(dir, { recursive: true });
  try { fs.copyFileSync(scriptPath, path.join(dir, "Script.yml")); } catch {}
  const meta: SessionMeta = { dir, name, scriptPath, startedAt: Date.now(), files: {} };
  current = { meta, events: [] };
  // start OBS recording; the returned timestamp is our t=0 for the desktop file
  const rec = await obs.startRecording(dir);
  meta.recordStart = rec.startedAt; meta.files = rec.files;
  meta.startedAt = rec.startedAt;
  flush();
  return { dir, startedAt: meta.startedAt };
}

export async function stopSession() {
  if (!current) return;
  const meta = current.meta;
  const files = await obs.stopRecording().catch(() => ({} as any));
  meta.stoppedAt = Date.now();
  meta.files = { ...meta.files, ...files };
  flush(); current = null;
}

export function registerSessionIpc() {
  ipcMain.handle("session:start", (_e, { scriptPath }) => startSession(scriptPath));
  ipcMain.handle("session:stop", () => stopSession());
  ipcMain.handle("session:event", (_e, ev) => {
    if (!current) return;
    current.events.push(ev);
    clearTimeout(current.flushTimer); current.flushTimer = setTimeout(flush, 500);
  });
  ipcMain.handle("session:current", () => currentSession());
}
