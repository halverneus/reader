// A loopback bridge so an outside tool can ask Studio what it is doing.
//
// The one question worth answering is "is this script open, and does it have
// unsaved changes" -- that is the difference between an agent editing a script
// and an agent clobbering one. Everything else here is convenience.
//
// Deliberately NOT exposed: recording, the post pipeline, the camera, OBS, the
// VM. This bridge can report on them and nothing more. A tool that can start a
// render is a tool that can start a second render on top of the one already
// going, and the GPU does not survive that politely.
//
// Bound to 127.0.0.1 with a random token written next to the config, readable
// only by this user. No port is opened until Studio runs, and the file is
// removed when it exits.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { app, ipcMain, BrowserWindow } from "electron";
import { broadcast } from "./index";
import { currentSession } from "./session";

interface State {
  openScript?: string;
  dirty?: boolean;
  hash?: string;
  post?: { step: string; index: number; total: number; state: string };
}
const state: State = {};
let server: http.Server | null = null;
let token = "";

export const setOpenScript = (file: string | undefined, dirty: boolean, hash?: string) => { state.openScript = file; state.dirty = dirty; state.hash = hash; };
export const setPost = (p: State["post"]) => { state.post = p; };

// STUDIO_BRIDGE_FILE lets an instance started with its own --user-data-dir be
// addressed without clobbering the real one. The end-to-end test uses it; it
// has no effect on a normal launch.
const file = () => process.env.STUDIO_BRIDGE_FILE || path.join(app.getPath("userData"), "bridge.json");

/** `/home/jstreets` is a symlink to `/var/home/jstreets` on this machine, so
 *  two spellings of the same script compare unequal under path.resolve alone
 *  and an edit silently reports "a different script is open". */
function samePath(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  return real(a) === real(b);
}

// ── asking the window a question ─────────────────────────────────────────────
// The renderer owns the buffer, so reading or changing unsaved work is a round
// trip rather than a read of main's cached state. Kept request/response rather
// than mirroring the text into main on every keystroke: a mirror is a second
// copy of the truth, and this file exists because of what second copies do.
let reqId = 0;
const pending = new Map<number, (v: any) => void>();

export function registerBridgeIpc() {
  ipcMain.handle("bridge:reply", (_e, id: number, payload: any) => {
    const r = pending.get(id);
    if (r) { pending.delete(id); r(payload); }
  });
}

function askRenderer<T>(op: string, params: any = {}, ms = 3000): Promise<T | null> {
  const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
  if (!w) return Promise.resolve(null);
  const id = ++reqId;
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve(null); }, ms);
    pending.set(id, (v) => { clearTimeout(timer); resolve(v); });
    w.webContents.send("bridge:request", { id, op, params });
  });
}

function status() {
  const s = currentSession();
  return {
    pid: process.pid,
    startedAt: Math.round(Date.now() - process.uptime() * 1000),
    openScript: state.openScript ?? null,
    dirty: !!state.dirty,
    hash: state.hash ?? null,
    recording: !!s,
    recordingSince: s?.startedAt ?? null,
    recordingScript: s?.scriptPath ?? null,
    post: state.post ?? null,
  };
}

const OPS: Record<string, (p: any) => any> = {
  status: () => status(),
  // `applied` is the honest answer to "will Jeromy see this". A reload of a
  // script Studio does not have open is a no-op, and reporting it as a
  // success taught an agent to believe the screen had been updated when it
  // had not been.
  reload: ({ file: f }: { file: string }) => {
    if (!f) return { ok: false, applied: false, reason: "no file given" };
    if (!samePath(state.openScript, f)) return { ok: true, applied: false, reason: "Studio has a different script open" };
    if (state.dirty) return { ok: false, applied: false, reason: "that script has unsaved changes in Studio" };
    // broadcast the renderer's OWN spelling of the path, not the caller's: it
    // compares by string, and /home/jstreets and /var/home/jstreets are the
    // same file by two names
    broadcast("bridge:reload", state.openScript);
    return { ok: true, applied: true };
  },

  /** The text in the window right now, saved or not. This is the whole point
   *  of the bridge for unsaved work: without it, "dirty" is a wall rather
   *  than a fact, and the only way past it is to make Jeromy save. */
  buffer: async ({ file: f }: { file?: string }) => {
    // `open` and `dirty` are reported even when the read FAILS. A caller that
    // cannot see a buffer it knows is dirty must refuse to fall back to the
    // file on disk, or it writes over unsaved work.
    const here = !f || samePath(state.openScript, f);
    const meta = { open: !!state.openScript && here, dirty: !!state.dirty };
    if (!state.openScript) return { ok: false, ...meta, reason: "Studio has no script open" };
    if (!here) return { ok: false, ...meta, reason: "Studio has a different script open" };
    const r = await askRenderer<{ path: string; text: string; hash: string; dirty: boolean }>("buffer");
    if (!r) return { ok: false, ...meta, reason: "the window did not answer" };
    return { ok: true, ...meta, ...r };
  },

  /** Replace the text in the window, compare-and-swap. `expectHash` is the
   *  hash the caller read; if the buffer moved on since, nothing happens and
   *  the caller reads again. Leaves the result DIRTY on purpose: it is an
   *  unsaved edit on top of Jeromy's unsaved edits, one Ctrl+Z undoes it and
   *  he decides whether it gets saved. */
  apply: async ({ file: f, text, expectHash }: { file: string; text: string; expectHash?: string }) => {
    if (typeof text !== "string") return { ok: false, applied: false, reason: "no text given" };
    if (!samePath(state.openScript, f)) return { ok: false, applied: false, reason: "Studio has a different script open" };
    const r = await askRenderer<{ applied: boolean; reason?: string }>("apply", { text, expectHash });
    if (!r) return { ok: false, applied: false, reason: "the window did not answer" };
    return { ok: r.applied, ...r };
  },

  notify: ({ text }: { text: string }) => { broadcast("bridge:notify", String(text ?? "").slice(0, 300)); return { ok: true }; },
};

export function startBridge() {
  if (server) return;
  token = crypto.randomBytes(16).toString("hex");
  server = http.createServer((req, res) => {
    const reply = (code: number, body: any) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.headers["x-studio-token"] !== token) return reply(403, { error: "bad token" });
    const op = (req.url ?? "/").replace(/^\//, "").split("?")[0];
    const fn = OPS[op];
    if (!fn) return reply(404, { error: `unknown op "${op}"` });
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => {
      let params: any = {};
      try { params = body ? JSON.parse(body) : {}; } catch {}
      Promise.resolve()
        .then(() => fn(params))
        .then((out) => reply(200, out))
        .catch((e: any) => reply(500, { error: String(e?.message ?? e) }));
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const port = (server!.address() as any).port;
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({ port, token, pid: process.pid, startedAt: Date.now() }, null, 1), { mode: 0o600 });
    process.stdout.write(`[bridge] 127.0.0.1:${port}\n`);
  });
}

export function stopBridge() {
  try { fs.unlinkSync(file()); } catch {}
  server?.close();
  server = null;
}
