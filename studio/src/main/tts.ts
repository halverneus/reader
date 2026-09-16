import { ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { loadConfig } from "./config";
import { currentSession } from "./session";
import { broadcast } from "./index";
import { speechChunks, SpeechSpan } from "../shared/script";

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

/** PCM out of a WAV. Kokoro streams its wavs, so the RIFF/data sizes are 0xFFFFFFFF: take the data to end of file. */
function readWav(buf: Buffer): { rate: number; channels: number; bits: number; pcm: Buffer } {
  let rate = 24000, channels = 1, bits = 16, i = 12;
  while (i + 8 <= buf.length) {
    const id = buf.toString("ascii", i, i + 4), size = buf.readUInt32LE(i + 4);
    if (id === "fmt ") { channels = buf.readUInt16LE(i + 10); rate = buf.readUInt32LE(i + 12); bits = buf.readUInt16LE(i + 22); }
    if (id === "data") { const end = size === 0xffffffff || i + 8 + size > buf.length ? buf.length : i + 8 + size; return { rate, channels, bits, pcm: buf.subarray(i + 8, end) }; }
    i += 8 + size + (size % 2);
  }
  throw new Error("Kokoro returned a wav with no data chunk");
}
function writeWav(pcm: Buffer, rate: number, channels: number, bits: number): Buffer {
  const h = Buffer.alloc(44), block = channels * bits / 8;
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * block, 28); h.writeUInt16LE(block, 32); h.writeUInt16LE(bits, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** A line with its [pause N] tags honoured. Kokoro ignores punctuation pauses ("the... I don't know..." comes out
 *  in one breath), so each piece is synthesised on its own and joined with exact silence. The edge silence Kokoro
 *  pads each piece with is trimmed at the joins, so a [pause 500] is 500 ms, not 500 + ~400. `spans` says where
 *  each piece sits in the wav — the mouth closes between them, live and in the post render. */
export async function synthLine(text: string, voice: string): Promise<{ wav: Buffer; spans: SpeechSpan[]; durationMs: number }> {
  const chunks = speechChunks(text);
  const wavs = await Promise.all(chunks.map((c) => (c.text ? synth(c.text, voice).then(readWav) : null)));
  const fmt = wavs.find((w) => w) ?? { rate: 24000, channels: 1, bits: 16, pcm: Buffer.alloc(0) };
  const block = fmt.channels * fmt.bits / 8, perMs = fmt.rate * block / 1000;
  const bytes = (ms: number) => Math.round(ms * fmt.rate / 1000) * block;
  const QUIET = 300, PAD = bytes(40); // ≈ -40 dBFS; keep a breath of room tone either side of a join
  const quiet = (pcm: Buffer, at: number) => fmt.bits !== 16 || Math.abs(pcm.readInt16LE(at)) < QUIET;
  const parts: Buffer[] = []; const spans: SpeechSpan[] = []; let len = 0;
  chunks.forEach((c, i) => {
    let pcm = wavs[i]?.pcm ?? Buffer.alloc(0);
    if (pcm.length) {
      let a = 0, b = pcm.length - (pcm.length % block);
      if (i > 0 && chunks[i - 1].pauseAfter > 0) { while (a < b && quiet(pcm, a)) a += block; a = Math.max(0, a - PAD); }
      if (c.pauseAfter > 0) { while (b > a && quiet(pcm, b - block)) b -= block; b = Math.min(pcm.length - (pcm.length % block), b + PAD); }
      pcm = pcm.subarray(a, b);
    }
    spans.push({ from: c.from, to: c.to, startMs: len / perMs, endMs: (len + pcm.length) / perMs });
    const gap = Buffer.alloc(bytes(c.pauseAfter));
    parts.push(pcm, gap); len += pcm.length + gap.length;
  });
  return { wav: writeWav(Buffer.concat(parts), fmt.rate, fmt.channels, fmt.bits), spans, durationMs: len / perMs };
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
    const { wav, spans, durationMs } = await synthLine(text, voice);
    let p: string | undefined;
    const s = currentSession();
    if (save && s) { const dir = path.join(s.dir, "voice"); fs.mkdirSync(dir, { recursive: true }); p = path.join(dir, name + ".wav"); fs.writeFileSync(p, wav); }
    return { audio: wav.toString("base64"), path: p, spans, duration: durationMs };
  });
  ipcMain.handle("tts:preview", async (_e, voice: string) => {
    const wav = await synth(PREVIEW, voice);
    broadcast("tts:play", wav.toString("base64"));
  });
  ipcMain.handle("kokoro:start", () => startKokoroContainer());
  ipcMain.handle("kokoro:status", () => pollKokoro());
}
