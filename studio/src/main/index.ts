import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import path from "node:path";
import fs from "node:fs";
import { loadConfig, saveConfig } from "./config";
import { registerScriptIpc } from "./scripts";
import { registerTtsIpc, pollKokoro, startKokoroContainer, stopKokoroContainer, kokoroState } from "./tts";
import { registerVmIpc } from "./vm";
import { registerSessionIpc, stopSession } from "./session";
import { registerObsIpc, obs } from "./obs";
import { registerAssistIpc } from "./assist";
import { registerPostIpc } from "./post";
import { registerDiagnoseIpc } from "./diagnose";

let win: BrowserWindow | null = null;
let headlessMode = false;
app.commandLine.appendSwitch("ozone-platform-hint", "auto");
app.setName("Metrik Studio");

function createWindow() {
  win = new BrowserWindow({
    width: 1600, height: 1000, minWidth: 1100, minHeight: 700,
    title: "Metrik Studio",
    icon: path.join(__dirname, "../renderer/icon-256.png"),
    backgroundColor: "#12141f",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "../renderer/index.html"));
  win.on("closed", () => (win = null));
  // Dev aid: STUDIO_SHOT=/path.png [STUDIO_TAB=record] captures the window after load and quits.
  if (process.env.STUDIO_SHOT) {
    win.webContents.on("console-message", (_e, level, msg) => { if (level >= 2) process.stderr.write(`[renderer] ${msg}\n`); });
    win.webContents.on("did-finish-load", async () => {
      if (process.env.STUDIO_JS) { await new Promise((r) => setTimeout(r, 1500)); await win!.webContents.executeJavaScript(process.env.STUDIO_JS!).catch((e) => process.stderr.write(`[js] ${e.message}\n`)); }
      if (process.env.STUDIO_TAB) await win!.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent("keydown",{key:"${{ script: 1, record: 2, post: 3, settings: 4 }[process.env.STUDIO_TAB!] ?? 1}",ctrlKey:true}))`).catch(() => {});
      await new Promise((r) => setTimeout(r, 2500));
      const img = await win!.webContents.capturePage();
      fs.writeFileSync(process.env.STUDIO_SHOT!, img.toPNG());
      app.quit();
    });
  }
}

/** Headless modes: `metrik-studio --post <sessionDir> [all|align|matte|glitch|project]` and `--diagnose`. */
async function headless(): Promise<boolean> {
  const argv = process.argv.slice(1);
  headlessMode = argv.includes("--post") || argv.includes("--obs-setup") || argv.includes("--diagnose");
  const pi = argv.indexOf("--post");
  if (pi >= 0) {
    const dir = argv[pi + 1], what = argv[pi + 2] ?? "all";
    const { runPipeline } = await import("./post/pipeline");
    try { await runPipeline(dir, what, (s) => process.stdout.write(s.map((x) => `[${x.state}] ${x.label}${x.detail ? " — " + x.detail : ""}`).join("\n") + "\n"), (l) => process.stdout.write(l)); process.exitCode = 0; }
    catch (e: any) { process.stderr.write(`FAILED: ${e.message}\n`); process.exitCode = 1; }
    app.quit(); return true;
  }
  if (argv.includes("--obs-setup")) {
    const { obs } = await import("./obs");
    try { if (!(await obs.connect())) { await obs.launchObs(); for (let i = 0; i < 90 && !(await obs.connect()); i++) await new Promise((r) => setTimeout(r, 1000)); } const notes = await obs.setup(); process.stdout.write(notes.join("\n") + "\n"); await new Promise((r) => setTimeout(r, 1500)); process.stdout.write(JSON.stringify({ connected: obs.connected, recording: obs.recording, message: obs.message }) + "\n"); }
    catch (e: any) { process.stderr.write(`FAILED: ${e.message}\n`); process.exitCode = 1; }
    app.quit(); return true;
  }
  if (argv.includes("--diagnose")) {
    const { diagnose } = await import("./diagnose");
    process.stdout.write(JSON.stringify(await diagnose(), null, 2) + "\n");
    app.quit(); return true;
  }
  return false;
}

app.whenReady().then(async () => {
  if (await headless()) return;
  ipcMain.handle("config:get", () => loadConfig());
  ipcMain.handle("config:set", (_e, patch) => saveConfig(patch));
  ipcMain.handle("dialog:openFile", async (_e, opts) => {
    const r = await dialog.showOpenDialog(win!, { properties: ["openFile"], filters: opts?.filters, defaultPath: opts?.defaultPath });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle("dialog:openDir", async (_e, defaultPath) => {
    const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory"], defaultPath });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle("shell:openPath", (_e, p) => shell.openPath(p));
  ipcMain.handle("fs:exists", (_e, p) => fs.existsSync(p));
  ipcMain.handle("outro:preview", () => { const w = new BrowserWindow({ width: 1280, height: 720, title: "Outro preview", backgroundColor: "#04070f", useContentSize: true }); w.setMenuBarVisibility(false); w.loadFile(path.join(__dirname, "../renderer/outro.html"), { query: { preview: "1" } }); w.webContents.on("did-finish-load", () => w.webContents.insertCSS("html,body{width:100%;height:100%}#stage{transform:scale(calc(100vw / 1920));transform-origin:0 0}")); });
  ipcMain.handle("config:get:override", () => process.env.STUDIO_OPEN ?? null);
  registerScriptIpc(); registerTtsIpc(); registerVmIpc(); registerSessionIpc(); registerObsIpc(); registerAssistIpc(); registerPostIpc(); registerDiagnoseIpc();
  createWindow();

  // Background services: Kokoro TTS container + OBS connection attempts
  const cfg = loadConfig();
  if ((await pollKokoro()) !== "ready" && cfg.kokoro.autoStart) startKokoroContainer();
  setInterval(() => { pollKokoro(); }, 3000);
  setInterval(() => { if (!obs.connected) obs.connect(); else obs.pushStatus(); }, 4000);
  obs.connect();

  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (!headlessMode) app.quit(); });
app.on("before-quit", async () => { await stopSession().catch(() => {}); if (loadConfig().kokoro.autoStart) stopKokoroContainer(); });

export const mainWindow = () => win;
export function broadcast(channel: string, payload: any) { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload); }
export { kokoroState };
