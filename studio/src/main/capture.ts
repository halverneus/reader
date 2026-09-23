// The capture engine: a long-lived system-python GStreamer child (recorder/metrik_recorder.py) that records the VM
// window, the camera and the mic on one clock and streams previews + meters back. Replaces OBS, which stays
// selectable in Settings (capture.backend) until the GStreamer path has proven itself.
import { app, ipcMain } from "electron";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { loadConfig, saveConfig } from "./config";
import { broadcast } from "./index";
import { kokoroState } from "./tts";
import { findVm } from "./vm";

// system python on purpose: GStreamer's GObject-introspection bindings live there, not in brew's python
const PYTHON = "/usr/bin/python3";
const LABELS: Record<string, string> = { desktop: "VM window", cam: "Camera", mic: "Microphone" };

export function recorderScript(): string {
  const cands = [path.join(process.resourcesPath ?? "", "recorder/metrik_recorder.py"), path.join(app.getAppPath(), "recorder/metrik_recorder.py"), path.join(__dirname, "../../recorder/metrik_recorder.py")];
  return cands.find((p) => fs.existsSync(p)) ?? cands[cands.length - 1];
}

export interface RecordTiming { startedAt: number; camOffset: number; micOffset: number; first: Record<string, number>; files: { desktop?: string; cam?: string; mic?: string } }
interface Waiter { ev: string; cmd: string; resolve: (m: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

function engineConfig() {
  const c = loadConfig().capture;
  return {
    desktop: { mode: c.desktopMode, target: c.desktopTarget, restoreToken: c.restoreToken, width: c.width, height: c.height, fps: c.fps, kbps: c.desktopKbps },
    cam: { device: c.camDevice, width: c.camWidth, height: c.camHeight, fps: c.camFps, kbps: c.camKbps },
    mic: { device: c.micDevice },
  };
}

class Capture {
  private proc: ChildProcess | null = null;
  running = false; recording = false; stopping = false; message = ""; encoder = "";
  private sources: Record<string, { status: string; detail: string }> = {};
  private thumbs: Record<string, string> = {};
  private meters: Record<string, { level: number; peak: number; at: number; clipAt: number }> = {};
  private frozenAt: Record<string, number> = {};
  private waiters: Waiter[] = [];
  private statusTimer?: NodeJS.Timeout;
  private quitting = false; private crashes = 0;
  onFreeze?: (src: string, reason: string, at: number) => void;
  /** A take stopped capturing without being asked to (engine stopped, crashed, or the screen/mic pipeline failed). */
  onLost?: (why: string) => void;
  private stopRequested = false;

  start() {
    if (this.proc || this.quitting) return;
    if (!fs.existsSync(PYTHON)) { this.message = `${PYTHON} not found — the capture engine needs the system python`; this.pushStatus(); return; }
    const child = spawn(PYTHON, ["-u", recorderScript()], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = child;
    readline.createInterface({ input: child.stdout! }).on("line", (l) => this.onLine(l));
    readline.createInterface({ input: child.stderr! }).on("line", (l) => process.stderr.write(`[recorder] ${l}\n`));
    child.on("error", (e) => { this.message = `capture engine failed to start: ${e.message}`; });
    child.on("exit", (code, sig) => {
      if (this.proc === child) this.proc = null;
      if ((this.recording || this.stopping) && !this.stopRequested) this.onLost?.(`the capture engine exited (${sig ?? code})`);
      this.running = false; this.recording = false; this.stopping = false;
      this.fail(`capture engine exited (${sig ?? code})`);
      if (!this.quitting && this.crashes++ < 5) setTimeout(() => this.start(), 2000);
      this.pushStatus();
    });
    this.send({ cmd: "open", cfg: engineConfig() });
    clearInterval(this.statusTimer); this.statusTimer = setInterval(() => this.pushStatus(), 150);
  }

  private send(m: object) { this.proc?.stdin?.write(JSON.stringify(m) + "\n"); }
  private fail(msg: string) { this.message = msg; for (const w of this.waiters.splice(0)) { clearTimeout(w.timer); w.reject(new Error(msg)); } }
  private wait(ev: string, cmd: string, ms: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const w: Waiter = { ev, cmd, resolve, reject, timer: setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); reject(new Error(`capture engine: no "${ev}" after ${ms / 1000} s`)); }, ms) };
      this.waiters.push(w);
    });
  }
  private settle(m: any, ok: boolean) {
    for (const w of this.waiters.filter((x) => (ok ? x.ev === m.ev : !!m.cmd && x.cmd === m.cmd))) {
      clearTimeout(w.timer); this.waiters.splice(this.waiters.indexOf(w), 1);
      ok ? w.resolve(m) : w.reject(new Error(m.msg));
    }
  }

  private onLine(line: string) {
    let m: any;
    try { m = JSON.parse(line); } catch { process.stdout.write(`[recorder] ${line}\n`); return; }
    switch (m.ev) {
      case "hello": this.running = true; this.encoder = m.encoder; this.message = ""; setTimeout(() => { if (this.running) this.crashes = 0; }, 30000); break;
      case "state":
        // the camera recovers on its own (black frames, then a new source); the screen and the mic do not
        if (m.recording && !this.stopRequested) for (const id of ["desktop", "mic"]) {
          const now = m.sources?.[id], was = this.sources[id];
          if (now?.status === "error" && was?.status !== "error") this.onLost?.(`${LABELS[id]}: ${now.detail || "failed"}`);
        }
        this.sources = m.sources ?? {}; this.recording = m.recording; this.stopping = m.stopping; this.encoder = m.encoder; break;
      case "thumb": this.thumbs[m.src] = `data:image/jpeg;base64,${m.jpg}`; break;
      case "level": {
        const mag = Math.max(0, ...(m.rms ?? [])), pk = Math.max(0, ...(m.peak ?? []));
        const prev = this.meters[m.src]; const now = Date.now();
        const peak = Math.pow(pk, 0.4);
        this.meters[m.src] = { level: Math.min(1, Math.pow(mag, 0.4)), peak: Math.min(1, prev && now - prev.at < 800 ? Math.max(prev.peak * 0.96, peak) : peak), at: now, clipAt: pk >= 0.99 ? now : prev?.clipAt ?? 0 };
        break;
      }
      case "frozen": this.frozenAt[m.src] = Date.now(); this.onFreeze?.(m.src, m.reason, m.at ?? Date.now()); break;
      case "token": saveConfig({ capture: { restoreToken: m.token } } as any); break;
      case "error": this.message = m.msg; process.stderr.write(`[recorder] ${m.msg}\n`); this.settle(m, false); return;
      case "log": process.stdout.write(`[recorder] ${m.msg}\n`); break;
      case "stopped": if (!this.stopRequested) this.onLost?.("the capture engine stopped recording by itself"); break;
    }
    this.settle(m, true);
  }

  // ── public API ─────────────────────────────────────────────────────────────
  async startRecording(dir: string): Promise<RecordTiming> {
    if (!this.proc) this.start();
    if (!this.running) await this.wait("hello", "", 8000);
    this.stopRequested = false;
    const got = this.wait("recording", "record", 15000);
    this.send({ cmd: "record", dir });
    return got;
  }
  async stopRecording(): Promise<Partial<RecordTiming>> {
    if (!this.proc || !(this.recording || this.stopping)) return {};
    this.stopRequested = true;
    const got = this.wait("stopped", "stop", 25000);
    this.send({ cmd: "stop" });
    return got;
  }
  pick() { if (!this.proc) this.start(); this.send({ cmd: "pick" }); }
  resetCamera() { this.send({ cmd: "resetCam" }); }
  reconfigure() { if (this.proc) this.send({ cmd: "config", cfg: engineConfig() }); else this.start(); }
  restart() {
    if (this.recording) throw new Error("stop recording first");
    this.crashes = 0; this.quitting = false;
    const p = this.proc;
    if (!p) return this.start();
    p.once("exit", () => setTimeout(() => this.start(), 300));
    this.send({ cmd: "quit" });
  }
  /** Finishes any recording (files are finalised by the engine) and stops the engine. */
  quit(permanent = true): Promise<void> {
    this.quitting = true; clearInterval(this.statusTimer);
    const p = this.proc;
    const done = () => { if (!permanent) this.quitting = false; };
    if (!p) { done(); return Promise.resolve(); }
    return new Promise((res) => {
      const t = setTimeout(() => { p.kill("SIGKILL"); done(); res(); }, 15000);
      p.once("exit", () => { clearTimeout(t); done(); res(); });
      this.send({ cmd: "quit" });
    });
  }

  status() {
    const cfg = loadConfig().capture; const now = Date.now();
    const sources = ["desktop", "cam", "mic"].map((id) => {
      const s = this.sources[id] ?? { status: "off", detail: id === "desktop" && cfg.desktopMode === "portal" ? "pick the VM window" : "" };
      if (id === "mic") {
        const m = this.meters[id]; const stale = !m || now - m.at > 1500;
        return { id, name: LABELS[id], kind: "audio" as const, level: stale ? 0 : m.level, peak: stale ? 0 : m.peak, clip: !!m && now - m.clipAt < 1500, status: s.status, detail: s.detail };
      }
      return { id, name: LABELS[id], kind: "video" as const, thumb: s.status === "live" || s.status === "starting" ? this.thumbs[id] : undefined, frozen: now - (this.frozenAt[id] ?? 0) < 3000, status: s.status, detail: s.detail };
    });
    const desk = this.sources.desktop?.status;
    return { backend: "gstreamer", connected: this.running, recording: this.recording || this.stopping, message: this.message, encoder: this.encoder, sources, needsPick: cfg.desktopMode === "portal" && desk !== "live" && desk !== "starting" && desk !== "waiting", kokoro: kokoroState, vm: vmName() };
  }
  pushStatus() { broadcast("capture:status", this.status()); }
}

let vmCache: { at: number; name: string | null } = { at: 0, name: null };
function vmName() { if (Date.now() - vmCache.at > 5000) vmCache = { at: Date.now(), name: findVm()?.domain ?? null }; return vmCache.name; }

/** Cameras (first node of each V4L2 device) and PipeWire/Pulse mic sources, for the Settings pickers. */
export async function listDevices() {
  const V = "/sys/class/video4linux";
  const read = (p: string) => { try { return fs.readFileSync(p, "utf8").trim(); } catch { return ""; } };
  const cams = fs.existsSync(V) ? fs.readdirSync(V).filter((d) => read(`${V}/${d}/index`) === "0").sort().map((d) => ({ id: `/dev/${d}`, label: `${read(`${V}/${d}/name`)} (/dev/${d})` })) : [];
  const out = await new Promise<string>((res) => execFile("pactl", ["list", "sources", "short"], { timeout: 4000 }, (e, so) => res(e ? "" : so)));
  const mics = out.split("\n").map((l) => l.split("\t")[1]).filter((n) => n && !n.endsWith(".monitor")).map((n) => ({ id: n, label: n.replace(/^alsa_input\./, "").replace(/[._-]+/g, " ") }));
  return { cams, mics };
}

/** `metrik_recorder.py --probe`: GStreamer version, missing elements, working encoder, portal version. */
export function probeEngine(): Promise<any> {
  return new Promise((res) => execFile(PYTHON, [recorderScript(), "--probe"], { timeout: 25000 }, (err, so, se) => {
    try { res(JSON.parse(so.trim().split("\n").pop()!)); } catch { res({ error: (se || err?.message || "no output").trim().split("\n").pop()?.slice(0, 300) }); }
  }));
}

export const capture = new Capture();
export function registerCaptureIpc() {
  ipcMain.handle("capture:pick", () => capture.pick());
  ipcMain.handle("capture:resetCamera", () => capture.resetCamera());
  ipcMain.handle("capture:restart", () => capture.restart());
  ipcMain.handle("capture:status", () => capture.pushStatus());
  ipcMain.handle("capture:devices", () => listDevices());
}
