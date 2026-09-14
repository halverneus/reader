// A recording session: one folder per take-set with the event log, TTS wavs, the recordings, and post outputs.
import { ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { obs } from "./obs";
import { capture } from "./capture";

export interface SessionMeta {
  dir: string; name: string; scriptPath: string; startedAt: number; stoppedAt?: number; recordStart?: number;
  files: { desktop?: string; cam?: string; mic?: string };
  /** source position for desktop time t is t + offset (seconds) */
  camOffset?: number; micOffset?: number;
  capture?: { backend: "gstreamer" | "obs"; encoder?: string; first?: Record<string, number>; stopError?: string };
}
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
  const cfg = loadConfig();
  const code = course.split(" - ")[0].trim();
  const folder = cfg.courseFolders?.[code] || code; // "CS235" → "MySQL"
  const name = [folder, week, lesson].filter(Boolean).join(" / ");
  const dir = path.join(cfg.recordingsRoot, folder, week, lesson, stamp);
  return { dir, name };
}

function flush() {
  if (!current) return;
  const { meta, events } = current;
  fs.writeFileSync(path.join(meta.dir, "session.json"), JSON.stringify({ meta, events }, null, 1));
}
function pushEvent(ev: any) {
  if (!current) return;
  current.events.push(ev);
  clearTimeout(current.flushTimer); current.flushTimer = setTimeout(flush, 500);
}

export async function startSession(scriptPath: string) {
  if (current) await stopSession();
  const { dir, name } = sessionDirFor(scriptPath);
  fs.mkdirSync(dir, { recursive: true });
  try { fs.copyFileSync(scriptPath, path.join(dir, "Script.yml")); } catch {}
  const meta: SessionMeta = { dir, name, scriptPath, startedAt: Date.now(), files: {} };
  if (loadConfig().capture.backend === "obs") {
    // OBS: the returned timestamp is our t=0 for the desktop file; post aligns the cam by audio
    const rec = await obs.startRecording(dir);
    Object.assign(meta, { recordStart: rec.startedAt, startedAt: rec.startedAt, files: rec.files, capture: { backend: "obs" } });
  } else {
    // one clock for all three files: t=0 is the desktop file's first frame, offsets place cam and mic against it
    const rec = await capture.startRecording(dir);
    Object.assign(meta, { recordStart: rec.startedAt, startedAt: rec.startedAt, files: rec.files, camOffset: rec.camOffset, micOffset: rec.micOffset, capture: { backend: "gstreamer", encoder: capture.encoder, first: rec.first } });
  }
  current = { meta, events: [] };
  flush();
  return { dir, startedAt: meta.startedAt };
}

export async function stopSession() {
  if (!current) return;
  const meta = current.meta;
  if (meta.capture?.backend === "obs") {
    const files = await obs.stopRecording().catch(() => ({} as any));
    meta.files = { ...meta.files, ...files };
  } else {
    const r = await capture.stopRecording().catch((e: Error) => { meta.capture = { ...meta.capture!, stopError: e.message }; return {} as Partial<import("./capture").RecordTiming>; });
    if (r.files) meta.files = { ...meta.files, ...r.files };
    // a camera that came up late only has its first frame time now
    if (r.startedAt) Object.assign(meta, { startedAt: r.startedAt, recordStart: r.startedAt, camOffset: r.camOffset, micOffset: r.micOffset, capture: { ...meta.capture!, first: r.first } });
  }
  meta.stoppedAt = Date.now();
  flush(); current = null;
}

export function registerSessionIpc() {
  ipcMain.handle("session:start", (_e, { scriptPath }) => startSession(scriptPath));
  ipcMain.handle("session:stop", () => stopSession());
  ipcMain.handle("session:event", (_e, ev) => pushEvent(ev));
  ipcMain.handle("session:current", () => currentSession());
  // the Kdenlive generator drops a "camera froze here" guide at each of these
  capture.onFreeze = (src, reason, at) => pushEvent({ kind: "freeze", t: Math.round(at), src, reason });
}
