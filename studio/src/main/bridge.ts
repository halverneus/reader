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
import { app } from "electron";
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
    const open = state.openScript && path.resolve(state.openScript) === path.resolve(f);
    if (!open) return { ok: true, applied: false, reason: "Studio has a different script open" };
    if (state.dirty) return { ok: false, applied: false, reason: "that script has unsaved changes in Studio" };
    broadcast("bridge:reload", f);
    return { ok: true, applied: true };
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
      try { reply(200, fn(params)); } catch (e: any) { reply(500, { error: String(e?.message ?? e) }); }
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
