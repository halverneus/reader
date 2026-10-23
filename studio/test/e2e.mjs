// End-to-end: an MCP write must appear in a RUNNING Studio.
//
// Launches a throwaway Studio (its own --user-data-dir, its own bridge file,
// OBS backend and Kokoro autostart off so nothing touches a camera, a GPU or
// docker), opens a scratch script in it, edits that script through the MCP
// server over real stdio JSON-RPC, and then asks the bridge what the window
// is actually showing.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const STUDIO = path.resolve(new URL("..", import.meta.url).pathname);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "studio-e2e-"));
const ud = path.join(tmp, "userdata");
const lesson = path.join(tmp, "Courses/Test Course/Course/Week 01/01 - Probe");
fs.mkdirSync(ud, { recursive: true });
fs.mkdirSync(lesson, { recursive: true });

const script = path.join(lesson, "Script.yml");
fs.writeFileSync(script, `script:

- type: "editor"
  start: 100
  end: 200
  text: "Roll Intro"

- type: "line"
  actor: "Dev"
  start: 200
  end: 300
  text: "The original wording lives here."

- type: "line"
  actor: "Glitch"
  start: 300
  end: 400
  auto: true
  text: "And this is the line that will not be touched."
`);

fs.writeFileSync(path.join(ud, "config.json"), JSON.stringify({
  scriptsRoot: path.join(tmp, "Courses"),
  capture: { backend: "obs" },          // no gstreamer, no camera
  kokoro: { autoStart: false },         // no docker
}, null, 1));

const bridgeFile = path.join(tmp, "bridge.json");
const env = { ...process.env, STUDIO_BRIDGE_FILE: bridgeFile, STUDIO_OPEN: script };

let pass = 0, fail = 0;
const ok = (c, label, detail = "") => { if (c) { pass++; console.log(`  ok    ${label}`); } else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// E2E_APP=~/.local/bin/metrik-studio runs the INSTALLED AppImage instead of
// the dev bundle, which is the thing Jeromy actually launches.
const [bin, baseArgs] = process.env.E2E_APP ? [process.env.E2E_APP, []] : ["npx", ["electron", "dist/main/index.js"]];
console.log(`launching a throwaway Studio (${bin}) …`);
const app = spawn(bin, [...baseArgs, `--user-data-dir=${ud}`], { cwd: STUDIO, env, stdio: ["ignore", "pipe", "pipe"] });
let appLog = "";
app.stdout.on("data", (d) => (appLog += d));
app.stderr.on("data", (d) => (appLog += d));

const bridge = () => { try { return JSON.parse(fs.readFileSync(bridgeFile, "utf8")); } catch { return null; } };
async function askBridge(op, params = {}) {
  const b = bridge(); if (!b) return null;
  const res = await fetch(`http://127.0.0.1:${b.port}/${op}`, {
    method: "POST", headers: { "content-type": "application/json", "x-studio-token": b.token }, body: JSON.stringify(params),
  }).catch(() => null);
  return res?.ok ? res.json() : null;
}

// ── MCP over real stdio ──────────────────────────────────────────────────────
const mcp = spawn("node", ["dist/cli/metrik-mcp.js"], { cwd: STUDIO, env, stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
const waiting = new Map();
mcp.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg); waiting.delete(msg.id);
  }
});
let rpcId = 0;
const rpc = (method, params) => new Promise((res) => {
  const id = ++rpcId;
  waiting.set(id, res);
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const call = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args });
  return r.result?.content?.[0]?.text ?? JSON.stringify(r.error ?? r);
};

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });

  // wait for the window to come up and report the script it opened
  let st = null;
  for (let i = 0; i < 120 && !(st?.openScript); i++) { await sleep(500); st = await askBridge("status"); }
  ok(!!st, "the bridge answered", appLog.slice(-400));
  ok(st?.openScript === script, "Studio reports the scratch script as open", String(st?.openScript));
  ok(st?.dirty === false, "and it is not dirty");
  const hash0 = st?.hash;
  ok(!!hash0, "it reports a content hash");

  const statusText = await call("studio_status", {});
  ok(/in sync with disk/.test(statusText), "studio_status says Studio is in sync with disk", statusText);

  // ── the actual question ────────────────────────────────────────────────────
  const edited = await call("script_edit_text", {
    file: script, marker: 200, old: "The original wording lives here.",
    new: "This sentence was written by the MCP while the window was open.",
  });
  ok(/Studio reloaded it on screen/.test(edited), "the write reports that Studio reloaded it", edited);

  await sleep(900);
  const st2 = await askBridge("status");
  ok(st2?.hash !== hash0, "the window's content hash changed", `${hash0} -> ${st2?.hash}`);
  ok(st2?.dirty === false, "and the window is still clean, so nothing will clobber the edit");
  const statusText2 = await call("studio_status", {});
  ok(/in sync with disk/.test(statusText2), "studio_status still says in sync after the edit", statusText2);

  // ── a different script must NOT disturb the window ─────────────────────────
  const other = path.join(tmp, "Courses/Test Course/Course/Week 01/02 - Elsewhere");
  fs.mkdirSync(other, { recursive: true });
  const otherScript = path.join(other, "Script.yml");
  fs.copyFileSync(script, otherScript);
  const hashBefore = (await askBridge("status"))?.hash;
  const otherEdit = await call("script_edit_text", { file: otherScript, marker: 300, old: "not be touched", new: "stay where it is" });
  ok(!/Studio reloaded/.test(otherEdit), "editing a different lesson does not claim a reload", otherEdit);
  await sleep(700);
  ok((await askBridge("status"))?.hash === hashBefore, "and the open script on screen is untouched");

  // ── the honest no-op ───────────────────────────────────────────────────────
  // A reload of something Studio does not have open must report applied:false
  // rather than ok:true. Reporting it as a success is what once taught an
  // agent to believe the screen had been updated when it had not been.
  const refused = await askBridge("reload", { file: "/nope/Script.yml" });
  ok(refused?.applied === false, "a reload of a script that is not open is reported as not applied", JSON.stringify(refused));

  ok(/e2e notice/.test((await askBridge("notify", { text: "e2e notice" })) ? "e2e notice" : ""), "notify is accepted");

  // ── stdin closing must not eat a reply ─────────────────────────────────────
  // Found 2026-10-23 by probing the server from a shell pipe: the transport
  // exited on stdin close and the in-flight studio_status answer vanished.
  // A real client keeps stdin open, so nothing would have caught this until
  // a tool call happened to be slow at the wrong moment.
  {
    const one = spawn("node", ["dist/cli/metrik-mcp.js"], { cwd: STUDIO, env, stdio: ["pipe", "pipe", "ignore"] });
    let seen = "";
    one.stdout.on("data", (d) => (seen += d));
    one.stdin.end(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "p", version: "0" } } }) + "\n" +
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "studio_status", arguments: {} } }) + "\n");
    await new Promise((r) => one.on("close", r));
    ok(/"id":2/.test(seen), "a reply still in flight survives stdin closing", seen.slice(0, 200));
  }
} finally {
  mcp.kill();
  app.kill("SIGTERM");
  await sleep(1500);
  try { app.kill("SIGKILL"); } catch {}
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log("\n--- studio log tail ---\n" + appLog.slice(-1500));
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}
