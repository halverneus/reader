import { ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { loadConfig } from "./config";
import { currentSession } from "./session";
import { broadcast } from "./index";

const PREVIEW = "Hello, this is a preview. Testing one two three. How does this voice sound to you?";
export let kokoroState: "down" | "starting" | "ready" = "down";
export let kokoroStartedByUs = false;

// Pronunciation override, e.g. [Raquel](/ɹəkˈɛl/). Kokoro's text normaliser reads the markup aloud, so it is switched
// off for lines that use one (measured: 4.6 s of noise vs 2.5 s spoken correctly). Spell out numbers in those lines.
const PRONOUNCE_RE = /\[[^\]\n]+\]\(\/[^)\n]+\/\)/;

async function synth(text: string, voice: string): Promise<Buffer> {
  const url = loadConfig().kokoro.url.replace(/\/$/, "") + "/v1/audio/speech";
  const body: any = { model: "kokoro", voice, input: text, response_format: "wav" };
  if (PRONOUNCE_RE.test(text)) body.normalization_options = { normalize: false };
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Kokoro ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return Buffer.from(await r.arrayBuffer());
}

export async function pollKokoro() {
  const url = loadConfig().kokoro.url.replace(/\/$/, "") + "/v1/audio/voices";
  try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); kokoroState = r.ok ? "ready" : "starting"; } catch { if (kokoroState === "ready") kokoroState = "down"; }
  return kokoroState;
}

/** Start the Kokoro docker container (same image/flags the Rust reader used). */
export function startKokoroContainer(): Promise<void> {
  const { image } = loadConfig().kokoro;
  kokoroState = "starting"; kokoroStartedByUs = true;
  return new Promise((resolve) => {
    execFile("docker", ["rm", "-f", "kokoro-tts"], () => {
      execFile("docker", ["run", "--gpus", "all", "-p", "8880:8880", "--name", "kokoro-tts", "--rm", "-d", image], (err, _o, stderr) => {
        if (err) { console.error("[kokoro] docker run failed:", stderr); kokoroState = "down"; }
        resolve();
      });
    });
  });
}
export function stopKokoroContainer() { if (!kokoroStartedByUs) return; try { execFile("docker", ["stop", "-t", "2", "kokoro-tts"]); } catch {} }

export function registerTtsIpc() {
  ipcMain.handle("tts:speak", async (_e, { text, voice, name, save }: { text: string; voice: string; name: string; save: boolean }) => {
    const wav = await synth(text, voice);
    let p: string | undefined;
    const s = currentSession();
    if (save && s) { const dir = path.join(s.dir, "voice"); fs.mkdirSync(dir, { recursive: true }); p = path.join(dir, name + ".wav"); fs.writeFileSync(p, wav); }
    return { audio: wav.toString("base64"), path: p };
  });
  ipcMain.handle("tts:preview", async (_e, voice: string) => {
    const wav = await synth(PREVIEW, voice);
    broadcast("tts:play", wav.toString("base64"));
  });
  ipcMain.handle("kokoro:start", () => startKokoroContainer());
  ipcMain.handle("kokoro:status", () => pollKokoro());
}
