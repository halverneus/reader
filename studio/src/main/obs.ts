// OBS is the capture engine. This module owns the websocket connection, scene setup, previews, meters,
// the frozen-camera watchdog, and recording start/stop. Everything else in the app talks to `obs`.
import { ipcMain } from "electron";
import OBSWebSocket, { EventSubscription } from "obs-websocket-js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadConfig } from "./config";
import { broadcast } from "./index";
import { kokoroState } from "./tts";
import { findVm } from "./vm";

export const SCENE = "Metrik";
export const SRC = { desktop: "Metrik Desktop", cam: "Metrik Cam", mic: "Metrik Mic" };
const SR_FILTER = "Metrik Source Record";
const OBS_CFG = path.join(os.homedir(), ".var/app/com.obsproject.Studio/config/obs-studio");

export interface SourceInfo { name: string; kind: "video" | "audio"; thumb?: string; level?: number; peak?: number; frozen?: boolean; detail?: string }

class Obs {
  ws = new OBSWebSocket();
  connected = false; recording = false; message = "";
  private sources = new Map<string, SourceInfo>();
  private meters = new Map<string, { level: number; peak: number; at: number }>();
  private lastThumb = new Map<string, { sig: string; since: number }>();
  private frozenSince = new Map<string, number>();
  private pollTimer?: NodeJS.Timeout; private statusTimer?: NodeJS.Timeout;
  private recordDir: string | null = null;
  private recStartResolve: ((p: string) => void) | null = null; private recStopResolve: ((p: string) => void) | null = null;
  onFreeze?: (name: string) => void;

  constructor() {
    this.ws.on("ConnectionClosed", () => { this.connected = false; this.message = "OBS connection closed"; this.pushStatus(); });
    this.ws.on("InputVolumeMeters", (d: any) => {
      for (const i of d.inputs ?? []) {
        const lv: number[][] = i.inputLevelsMul ?? [];
        if (!lv.length) continue;
        const mag = Math.max(...lv.map((c) => c[0] ?? 0)), peak = Math.max(...lv.map((c) => c[1] ?? 0));
        const prev = this.meters.get(i.inputName); const now = Date.now();
        const heldPeak = prev && now - prev.at < 800 ? Math.max(prev.peak * .96, peak) : peak;
        this.meters.set(i.inputName, { level: Math.min(1, Math.pow(mag, .4)), peak: Math.min(1, Math.pow(heldPeak, .4)), at: now });
      }
    });
    this.ws.on("RecordStateChanged", (d: any) => {
      if (d.outputState === "OBS_WEBSOCKET_OUTPUT_STARTED") { this.recording = true; this.recStartResolve?.(d.outputPath ?? ""); this.recStartResolve = null; }
      if (d.outputState === "OBS_WEBSOCKET_OUTPUT_STOPPED") { this.recording = false; this.recStopResolve?.(d.outputPath ?? ""); this.recStopResolve = null; }
      this.pushStatus();
    });
  }

  // ── connection ─────────────────────────────────────────────────────────────
  async connect(): Promise<boolean> {
    if (this.connected) return true;
    const { host, port, password } = loadConfig().obs;
    try {
      await this.ws.connect(`ws://${host}:${port}`, password || undefined, { eventSubscriptions: EventSubscription.All | EventSubscription.InputVolumeMeters, rpcVersion: 1 });
      this.connected = true; this.message = "";
      const st: any = await this.ws.call("GetRecordStatus"); this.recording = !!st.outputActive;
      this.startPolling();
    } catch (e: any) {
      this.connected = false;
      this.message = obsRunning() ? `OBS websocket refused (${e.message}). Enable Tools → WebSocket Server Settings, port ${port}.` : "OBS is not running.";
    }
    this.pushStatus();
    return this.connected;
  }

  /** Make sure the websocket server is enabled in OBS's config (only safe while OBS is closed), then launch OBS. */
  async launchObs(): Promise<void> {
    if (obsRunning()) return;
    const cfgFile = path.join(OBS_CFG, "plugin_config/obs-websocket/config.json");
    try {
      const j = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
      if (!j.server_enabled) { j.server_enabled = true; j.first_load = false; fs.writeFileSync(cfgFile, JSON.stringify(j, null, 2)); }
      if (j.server_password && !loadConfig().obs.password) loadConfig().obs.password = j.server_password;
    } catch {}
    const child = spawn("flatpak", ["run", "com.obsproject.Studio", "--minimize-to-tray"], { detached: true, stdio: "ignore" }); child.unref();
    this.message = "Launching OBS…"; this.pushStatus();
  }

  // ── scene setup (idempotent) ───────────────────────────────────────────────
  async setup(): Promise<string[]> {
    const notes: string[] = [];
    if (!(await this.connect())) throw new Error(this.message);
    const cfg = loadConfig();
    const inputs: any = await this.ws.call("GetInputList");
    const have = (n: string) => inputs.inputs.some((i: any) => i.inputName === n);
    const scenes: any = await this.ws.call("GetSceneList");
    if (!scenes.scenes.some((s: any) => s.sceneName === SCENE)) await this.ws.call("CreateScene", { sceneName: SCENE });
    const items: any = await this.ws.call("GetSceneItemList", { sceneName: SCENE });
    const inScene = (n: string) => items.sceneItems.find((i: any) => i.sourceName === n);

    // Desktop: reuse an existing pipewire capture if one exists (its portal token survives), else create one
    if (!have(SRC.desktop)) {
      const existing = inputs.inputs.find((i: any) => i.inputKind === "pipewire-screen-capture-source");
      if (existing) { if (!inScene(existing.inputName)) await this.ws.call("CreateSceneItem", { sceneName: SCENE, sourceName: existing.inputName }); notes.push(`Desktop: reusing "${existing.inputName}"`); }
      else { await this.ws.call("CreateInput", { sceneName: SCENE, inputName: SRC.desktop, inputKind: "pipewire-screen-capture-source", inputSettings: {} }); notes.push("Desktop: created (pick the VM window in the portal dialog)"); }
    } else if (!inScene(SRC.desktop)) await this.ws.call("CreateSceneItem", { sceneName: SCENE, sourceName: SRC.desktop });

    // Cam: v4l2 with auto-reset, kept ACTIVE but off-canvas so it never shows in the desktop recording
    if (!have(SRC.cam)) await this.ws.call("CreateInput", { sceneName: SCENE, inputName: SRC.cam, inputKind: "v4l2_input", inputSettings: { device_id: cfg.obs.camDevice, auto_reset: true, timeout_frames: 5 } });
    else await this.ws.call("SetInputSettings", { inputName: SRC.cam, inputSettings: { device_id: cfg.obs.camDevice, auto_reset: true, timeout_frames: 5 }, overlay: true });
    let camItem = inScene(SRC.cam);
    if (!camItem) { const r: any = await this.ws.call("CreateSceneItem", { sceneName: SCENE, sourceName: SRC.cam }); camItem = { sceneItemId: r.sceneItemId }; }
    await this.ws.call("SetSceneItemTransform", { sceneName: SCENE, sceneItemId: camItem.sceneItemId, sceneItemTransform: { positionX: -4000, positionY: -4000 } });
    await this.ws.call("SetSceneItemIndex", { sceneName: SCENE, sceneItemId: camItem.sceneItemId, sceneItemIndex: 0 });

    // Mic
    if (!have(SRC.mic)) await this.ws.call("CreateInput", { sceneName: SCENE, inputName: SRC.mic, inputKind: "pulse_input_capture", inputSettings: cfg.obs.micDevice ? { device_id: cfg.obs.micDevice } : {} });
    else if (!inScene(SRC.mic)) await this.ws.call("CreateSceneItem", { sceneName: SCENE, sourceName: SRC.mic });

    // Source Record filter on the cam → separate cam file per session
    const filters: any = await this.ws.call("GetSourceFilterList", { sourceName: SRC.cam });
    const kinds: any = await this.ws.call("GetSourceFilterKindList").catch(() => ({ sourceFilterKinds: [] }));
    const hasSR = (kinds.sourceFilterKinds ?? []).includes("source_record_filter") || filters.filters.some((f: any) => f.filterKind === "source_record_filter");
    if (!hasSR) notes.push("Source Record plugin missing → cam will not be recorded separately. Install: flatpak install flathub com.obsproject.Studio.Plugin.SourceRecord");
    else {
      const enc = nvencAvailable() ? "nvenc" : "x264";
      const settings = { record_mode: 3, path: this.recordDir ?? cfg.recordingsRoot, filename_formatting: "cam", rec_format: "mkv", encoder: enc, audio_track: 1, different_audio: false, remove_after_record: false };
      if (!filters.filters.some((f: any) => f.filterName === SR_FILTER)) await this.ws.call("CreateSourceFilter", { sourceName: SRC.cam, filterName: SR_FILTER, filterKind: "source_record_filter", filterSettings: settings });
      else await this.ws.call("SetSourceFilterSettings", { sourceName: SRC.cam, filterName: SR_FILTER, filterSettings: settings });
      await this.ws.call("SetSourceFilterIndex", { sourceName: SRC.cam, filterName: SR_FILTER, filterIndex: 0 }).catch(() => {});
      notes.push(`Cam file via Source Record (${enc})`);
    }

    // Main recording profile: mkv, NVENC when available, desktop-only scene
    const enc = nvencAvailable() ? "obs_nvenc_h264_tex" : "obs_x264";
    for (const [cat, name, value] of [["Output", "Mode", "Advanced"], ["AdvOut", "RecType", "Standard"], ["AdvOut", "RecFormat2", "mkv"], ["AdvOut", "RecEncoder", enc], ["AdvOut", "RecTracks", "1"], ["Output", "FilenameFormatting", "desktop"], ["Video", "FPSType", "0"], ["Video", "FPSCommon", "60"]])
      await this.ws.call("SetProfileParameter", { parameterCategory: cat, parameterName: name, parameterValue: value }).catch(() => {});
    notes.push(`Desktop file via OBS record (${enc})`);
    await this.ws.call("SetCurrentProgramScene", { sceneName: SCENE });
    this.message = notes.join(" · "); this.pushStatus();
    return notes;
  }

  // ── recording ──────────────────────────────────────────────────────────────
  async startRecording(dir: string): Promise<{ startedAt: number; files: { desktop?: string; cam?: string } }> {
    if (!(await this.connect())) throw new Error(this.message || "OBS not connected");
    this.recordDir = dir;
    await this.ws.call("SetRecordDirectory", { recordDirectory: dir }).catch(() => this.ws.call("SetProfileParameter", { parameterCategory: "AdvOut", parameterName: "RecFilePath", parameterValue: dir }));
    await this.ws.call("SetSourceFilterSettings", { sourceName: SRC.cam, filterName: SR_FILTER, filterSettings: { path: dir, filename_formatting: "cam" } }).catch(() => {});
    await this.ws.call("SetCurrentProgramScene", { sceneName: SCENE }).catch(() => {});
    const started = new Promise<string>((res) => (this.recStartResolve = res));
    const t0 = Date.now();
    await this.ws.call("StartRecord");
    const outputPath = await Promise.race([started, new Promise<string>((r) => setTimeout(() => r(""), 4000))]);
    const startedAt = Math.round((t0 + Date.now()) / 2);
    this.recording = true; this.pushStatus();
    return { startedAt, files: { desktop: outputPath || undefined, cam: path.join(dir, "cam.mkv") } };
  }
  async stopRecording(): Promise<{ desktop?: string; cam?: string }> {
    if (!this.connected) return {};
    const stopped = new Promise<string>((res) => (this.recStopResolve = res));
    const r: any = await this.ws.call("StopRecord").catch(() => ({}));
    const p = (await Promise.race([stopped, new Promise<string>((rr) => setTimeout(() => rr(r.outputPath ?? ""), 4000))])) || r.outputPath;
    this.recording = false; this.pushStatus();
    const cam = this.recordDir ? findNewest(this.recordDir, /^cam.*\.mkv$/) : undefined;
    return { desktop: p || undefined, cam };
  }

  // ── previews, meters, watchdog ─────────────────────────────────────────────
  private startPolling() {
    clearInterval(this.pollTimer); clearInterval(this.statusTimer);
    this.pollTimer = setInterval(() => this.poll().catch(() => {}), 250);
    this.statusTimer = setInterval(() => this.pushStatus(), 120);
  }
  private async poll() {
    if (!this.connected) return;
    const inputs: any = await this.ws.call("GetInputList");
    // only show what the Metrik scene records; other OBS scenes' sources are just noise here
    const items: any = await this.ws.call("GetSceneItemList", { sceneName: SCENE }).catch(() => ({ sceneItems: [] }));
    const inScene = new Set<string>(items.sceneItems.map((i: any) => i.sourceName));
    const pool = inScene.size ? inputs.inputs.filter((i: any) => inScene.has(i.inputName)) : inputs.inputs;
    const names: string[] = pool.map((i: any) => i.inputName);
    const video = pool.filter((i: any) => ["pipewire-screen-capture-source", "v4l2_input", "browser_source", "window_capture", "xshm_input"].includes(i.inputKind));
    const audio = pool.filter((i: any) => ["pulse_input_capture", "pulse_output_capture", "pipewire-audio-capture-source", "alsa_input_capture"].includes(i.inputKind));
    for (const k of [...this.sources.keys()]) if (!names.includes(k)) this.sources.delete(k);
    for (const v of video) {
      try {
        const shot: any = await this.ws.call("GetSourceScreenshot", { sourceName: v.inputName, imageFormat: "jpg", imageWidth: 256, imageCompressionQuality: 55 });
        const data: string = shot.imageData;
        const sig = data.length + ":" + data.slice(-96);
        const now = Date.now();
        const prev = this.lastThumb.get(v.inputName);
        if (!prev || prev.sig !== sig) { this.lastThumb.set(v.inputName, { sig, since: now }); this.frozenSince.delete(v.inputName); }
        const stuck = v.inputKind === "v4l2_input" && prev && prev.sig === sig && now - prev.since > 2500;
        if (stuck && !this.frozenSince.has(v.inputName)) { this.frozenSince.set(v.inputName, now); this.resetCamera(v.inputName); this.onFreeze?.(v.inputName); }
        this.sources.set(v.inputName, { name: v.inputName, kind: "video", thumb: data, frozen: !!stuck, detail: v.inputKind === "v4l2_input" ? "webcam" : v.inputKind === "pipewire-screen-capture-source" ? "screen (PipeWire)" : v.inputKind });
      } catch { this.sources.set(v.inputName, { name: v.inputName, kind: "video", thumb: undefined, detail: "no frames" }); }
    }
    for (const a of audio) {
      const m = this.meters.get(a.inputName);
      const stale = !m || Date.now() - m.at > 1500;
      this.sources.set(a.inputName, { name: a.inputName, kind: "audio", level: stale ? 0 : m!.level, peak: stale ? 0 : m!.peak, detail: stale ? "silent / inactive" : "live" });
    }
  }
  /** Kick a wedged v4l2 device by toggling its device path. */
  async resetCamera(name: string) {
    try {
      const s: any = await this.ws.call("GetInputSettings", { inputName: name });
      const dev = s.inputSettings?.device_id ?? loadConfig().obs.camDevice;
      await this.ws.call("SetInputSettings", { inputName: name, inputSettings: { device_id: "/dev/null" }, overlay: true });
      await new Promise((r) => setTimeout(r, 400));
      await this.ws.call("SetInputSettings", { inputName: name, inputSettings: { device_id: dev }, overlay: true });
      this.message = `Camera "${name}" froze → reset at ${new Date().toLocaleTimeString()}`;
    } catch {}
  }
  pushStatus() {
    broadcast("obs:status", { connected: this.connected, recording: this.recording, message: this.message, sources: [...this.sources.values()], kokoro: kokoroState, vm: vmName() });
  }
}

let vmCache: { at: number; name: string | null } = { at: 0, name: null };
function vmName() { if (Date.now() - vmCache.at > 5000) { vmCache = { at: Date.now(), name: findVm()?.domain ?? null }; } return vmCache.name; }
function obsRunning(): boolean { try { return fs.readdirSync("/proc").some((p) => { if (!/^\d+$/.test(p)) return false; const a = safeRead(`/proc/${p}/cmdline`).split("\0")[0] ?? ""; return a === "obs" || a.endsWith("/bin/obs"); }); } catch { return false; } }
function safeRead(p: string) { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } }
/** Parse OBS's newest log for the NVENC probe result. */
export function nvencAvailable(): boolean {
  try {
    const dir = path.join(OBS_CFG, "logs"); const f = fs.readdirSync(dir).sort().pop(); if (!f) return false;
    const log = fs.readFileSync(path.join(dir, f), "utf8");
    return /NVENC supported|\[NVENC\] .*supported/i.test(log) && !/NVENC not supported/i.test(log);
  } catch { return false; }
}
function findNewest(dir: string, re: RegExp): string | undefined {
  try { return fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]; } catch { return undefined; }
}

export const obs = new Obs();
export function registerObsIpc() {
  ipcMain.handle("obs:connect", async () => { if (!obsRunning()) await obs.launchObs(); return obs.connect(); });
  ipcMain.handle("obs:setup", () => obs.setup());
  ipcMain.handle("obs:status", () => obs.pushStatus());
  ipcMain.handle("obs:resetCamera", (_e, name) => obs.resetCamera(name ?? SRC.cam));
}
